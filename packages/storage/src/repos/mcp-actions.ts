import { and, asc, count, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { mcpActions } from '../schema.js';

/**
 * The `mcp_actions` ledger (ADR 0116 §2): one row per MCP write, and the
 * idempotency record. Every function takes a `GuildScope` first and scopes
 * through `scope.only`, like every repository here.
 */

export type McpCapGroup = 'message' | 'edit' | 'member_role' | 'structure' | 'pin_react';
export type McpActionStatus = 'claimed' | 'done' | 'dry_run' | 'failed';

export interface McpActionRow {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly capGroup: McpCapGroup;
  readonly argsHash: string;
  readonly status: McpActionStatus;
  readonly tokenId: string;
  readonly targetChannelId: string | undefined;
  readonly resultMessageId: string | undefined;
  readonly resultThreadId: string | undefined;
  readonly undoJson: string | undefined;
  readonly undoneByActionId: string | undefined;
  readonly createdAt: number;
  readonly completedAt: number | undefined;
}

const toActionRow = (row: typeof mcpActions.$inferSelect): McpActionRow => ({
  actionId: row.actionId,
  idempotencyKey: row.idempotencyKey,
  kind: row.kind,
  capGroup: row.capGroup as McpCapGroup,
  argsHash: row.argsHash,
  status: row.status as McpActionStatus,
  tokenId: row.tokenId,
  targetChannelId: row.targetChannelId ?? undefined,
  resultMessageId: row.resultMessageId ?? undefined,
  resultThreadId: row.resultThreadId ?? undefined,
  undoJson: row.undoJson ?? undefined,
  undoneByActionId: row.undoneByActionId ?? undefined,
  createdAt: row.createdAt,
  completedAt: row.completedAt ?? undefined,
});

export const findAction = (scope: GuildScope, idempotencyKey: string): McpActionRow | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(mcpActions)
      .where(scope.only(mcpActions, eq(mcpActions.idempotencyKey, idempotencyKey)))
      .get();
    return row === undefined ? undefined : toActionRow(row);
  });

export const findActionById = (scope: GuildScope, actionId: string): McpActionRow | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(mcpActions)
      .where(scope.only(mcpActions, eq(mcpActions.actionId, actionId)))
      .get();
    return row === undefined ? undefined : toActionRow(row);
  });

/**
 * The claim: INSERT OR IGNORE, so two concurrent calls with one key produce
 * one row. `claimed: false` means the key already existed — the caller then
 * reads `findAction` and decides replay or argument mismatch.
 *
 * A dry run never executes, so it is complete at claim time (`completed_at`
 * set); a live claim completes later through `completeAction`.
 */
export const claimAction = (
  scope: GuildScope,
  input: {
    actionId: string;
    idempotencyKey: string;
    kind: string;
    capGroup: McpCapGroup;
    argsHash: string;
    tokenId: string;
    targetChannelId?: string | undefined;
    now: number;
    dryRun: boolean;
  },
): { readonly claimed: boolean } =>
  write(scope, ({ db }) => {
    const result = db
      .insert(mcpActions)
      .values({
        guildId: scope.guildId,
        actionId: input.actionId,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        capGroup: input.capGroup,
        argsHash: input.argsHash,
        status: input.dryRun ? 'dry_run' : 'claimed',
        tokenId: input.tokenId,
        targetChannelId: input.targetChannelId ?? null,
        resultMessageId: null,
        resultThreadId: null,
        undoJson: null,
        undoneByActionId: null,
        createdAt: input.now,
        completedAt: input.dryRun ? input.now : null,
      })
      .onConflictDoNothing({ target: [mcpActions.guildId, mcpActions.idempotencyKey] })
      .run();
    return { claimed: result.changes === 1 };
  });

/**
 * Records the outcome once the single Discord call returned or threw. A throw
 * still completes the row (as `failed`) and keeps the claim, so a retry
 * replays instead of posting twice.
 */
export const completeAction = (
  scope: GuildScope,
  actionId: string,
  result: {
    status: 'done' | 'failed';
    resultMessageId?: string | undefined;
    resultThreadId?: string | undefined;
    undoJson?: string | undefined;
    now: number;
  },
): void =>
  write(scope, ({ db }) => {
    db.update(mcpActions)
      .set({
        status: result.status,
        resultMessageId: result.resultMessageId ?? null,
        resultThreadId: result.resultThreadId ?? null,
        undoJson: result.undoJson ?? null,
        completedAt: result.now,
      })
      .where(scope.only(mcpActions, eq(mcpActions.actionId, actionId)))
      .run();
  });

/**
 * Names the undo action for a reversible action. Only the first undo wins:
 * already undone (or unknown) returns false and changes nothing.
 */
export const markUndone = (
  scope: GuildScope,
  actionId: string,
  undoneByActionId: string,
): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .update(mcpActions)
      .set({ undoneByActionId })
      .where(
        scope.only(
          mcpActions,
          and(eq(mcpActions.actionId, actionId), isNull(mcpActions.undoneByActionId)),
        ),
      )
      .run();
    return result.changes === 1;
  });

/**
 * The rolling-hour cap count (ADR 0116 §6): rows created since `sinceMs` in
 * this cap group. Refusals never reach the ledger and `failed` rows are
 * excluded; `claimed` and `dry_run` rows occupy cap room so a restart does
 * not hand out more.
 */
export const countActionsSince = (
  scope: GuildScope,
  capGroup: McpCapGroup,
  sinceMs: number,
): number =>
  read(
    scope,
    (db) =>
      db
        .select({ n: count() })
        .from(mcpActions)
        .where(
          scope.only(
            mcpActions,
            and(
              eq(mcpActions.capGroup, capGroup),
              gte(mcpActions.createdAt, sinceMs),
              inArray(mcpActions.status, ['claimed', 'done', 'dry_run']),
            ),
          ),
        )
        .get()?.n ?? 0,
  );

/**
 * The identical-content window (ADR 0116 §7, M5-D8 layer B): a row with the
 * same arguments hash posted into the same channel since `sinceMs`.
 */
export const recentSameContent = (
  scope: GuildScope,
  argsHash: string,
  targetChannelId: string,
  sinceMs: number,
): boolean =>
  read(
    scope,
    (db) =>
      db
        .select({ actionId: mcpActions.actionId })
        .from(mcpActions)
        .where(
          scope.only(
            mcpActions,
            and(
              eq(mcpActions.argsHash, argsHash),
              eq(mcpActions.targetChannelId, targetChannelId),
              gte(mcpActions.createdAt, sinceMs),
            ),
          ),
        )
        .get() !== undefined,
  );

/** The newest actions first, for `list_actions`. No content leaves this table. */
export const listActions = (
  scope: GuildScope,
  input: { limit?: number | undefined; beforeCreatedAt?: number | undefined },
): McpActionRow[] =>
  read(scope, (db) => {
    const base = db
      .select()
      .from(mcpActions)
      .where(
        scope.only(
          mcpActions,
          input.beforeCreatedAt === undefined
            ? undefined
            : lt(mcpActions.createdAt, input.beforeCreatedAt),
        ),
      )
      .orderBy(desc(mcpActions.createdAt), asc(mcpActions.actionId));
    const rows = input.limit === undefined ? base.all() : base.limit(input.limit).all();
    return rows.map(toActionRow);
  });
