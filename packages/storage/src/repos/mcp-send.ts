import { and, asc, count, desc, eq, gte } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { mcpSendAllowlist, mcpSends } from '../schema.js';

/**
 * The MCP send-message storage (slice M5, Task 1).
 *
 * Two tables: `mcp_send_allowlist`, the channels the owner has allowed the
 * connector to post into, and `mcp_sends`, one row per accepted send and the
 * idempotency ledger (ruling M5-D3). Every function takes a `GuildScope`
 * first and scopes through `scope.only`, like every repository here.
 */

export interface AllowlistedChannel {
  readonly channelId: string;
  readonly scopeKind: 'channel' | 'category';
  readonly addedByAccountId: string;
  readonly addedAt: number;
}

const toAllowlistedChannel = (row: typeof mcpSendAllowlist.$inferSelect): AllowlistedChannel => ({
  channelId: row.channelId,
  scopeKind: row.scopeKind as 'channel' | 'category',
  addedByAccountId: row.addedByAccountId,
  addedAt: row.addedAt,
});

/** Inserts the channel row; an already-allowed channel is a no-op reported as false. */
export const allowChannel = (
  scope: GuildScope,
  input: {
    channelId: string;
    addedByAccountId: string;
    now: number;
    scopeKind?: 'channel' | 'category';
  },
): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .insert(mcpSendAllowlist)
      .values({
        guildId: scope.guildId,
        channelId: input.channelId,
        scopeKind: input.scopeKind ?? 'channel',
        addedByAccountId: input.addedByAccountId,
        addedAt: input.now,
      })
      .onConflictDoNothing({
        target: [mcpSendAllowlist.guildId, mcpSendAllowlist.channelId],
      })
      .run();
    return result.changes === 1;
  });

/** Deletes the channel row; false when it was never allowed. */
export const disallowChannel = (scope: GuildScope, channelId: string): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .delete(mcpSendAllowlist)
      .where(scope.only(mcpSendAllowlist, eq(mcpSendAllowlist.channelId, channelId)))
      .run();
    return result.changes === 1;
  });

export const isScopeAllowed = (
  scope: GuildScope,
  channelId: string,
  scopeKind: 'channel' | 'category',
): boolean =>
  read(
    scope,
    (db) =>
      db
        .select({ channelId: mcpSendAllowlist.channelId })
        .from(mcpSendAllowlist)
        .where(
          scope.only(
            mcpSendAllowlist,
            and(
              eq(mcpSendAllowlist.channelId, channelId),
              eq(mcpSendAllowlist.scopeKind, scopeKind),
            ),
          ),
        )
        .get() !== undefined,
  );

export const isChannelAllowed = (scope: GuildScope, channelId: string): boolean =>
  isScopeAllowed(scope, channelId, 'channel');

export const listAllowedChannels = (scope: GuildScope): readonly AllowlistedChannel[] =>
  read(scope, (db) =>
    db
      .select()
      .from(mcpSendAllowlist)
      .where(scope.only(mcpSendAllowlist))
      .orderBy(asc(mcpSendAllowlist.addedAt), asc(mcpSendAllowlist.channelId))
      .all()
      .map(toAllowlistedChannel),
  );

export type SendOutcome = 'sent' | 'dry_run';

export interface SendRow {
  readonly idempotencyKey: string;
  readonly channelId: string;
  readonly contentHash: string;
  readonly messageId: string | undefined;
  readonly tokenId: string;
  readonly sentAt: number;
  readonly outcome: SendOutcome;
}

const toSendRow = (row: typeof mcpSends.$inferSelect): SendRow => ({
  idempotencyKey: row.idempotencyKey,
  channelId: row.channelId,
  contentHash: row.contentHash,
  messageId: row.messageId ?? undefined,
  tokenId: row.tokenId,
  sentAt: row.sentAt,
  outcome: row.outcome as SendOutcome,
});

/** Ruling M5-D3. How Task 2 tells replay (hash matches) from collision (hash differs). */
export const findSend = (scope: GuildScope, idempotencyKey: string): SendRow | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(mcpSends)
      .where(scope.only(mcpSends, eq(mcpSends.idempotencyKey, idempotencyKey)))
      .get();
    return row === undefined ? undefined : toSendRow(row);
  });

/**
 * The claim (hard rule 6): INSERT OR IGNORE, so two concurrent calls with one
 * key produce one row. `claimed: false` means the key already existed — the
 * caller then reads `findSend` and decides replay or collision.
 */
export const claimSend = (
  scope: GuildScope,
  input: {
    idempotencyKey: string;
    channelId: string;
    contentHash: string;
    tokenId: string;
    now: number;
    outcome: SendOutcome;
  },
): { readonly claimed: boolean } =>
  write(scope, ({ db }) => {
    const result = db
      .insert(mcpSends)
      .values({
        guildId: scope.guildId,
        idempotencyKey: input.idempotencyKey,
        channelId: input.channelId,
        contentHash: input.contentHash,
        messageId: null,
        tokenId: input.tokenId,
        sentAt: input.now,
        outcome: input.outcome,
      })
      .onConflictDoNothing({ target: [mcpSends.guildId, mcpSends.idempotencyKey] })
      .run();
    return { claimed: result.changes === 1 };
  });

/** Fills in the Discord message id once the REST call returned. */
export const recordSentMessageId = (
  scope: GuildScope,
  input: { idempotencyKey: string; messageId: string },
): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .update(mcpSends)
      .set({ messageId: input.messageId })
      .where(scope.only(mcpSends, eq(mcpSends.idempotencyKey, input.idempotencyKey)))
      .run();
    return result.changes === 1;
  });

/**
 * Ruling M5-D4: accepted sends in the rolling window ending at `now`.
 *
 * Counts rows, never an in-memory bucket, so a restart does not hand out more.
 * Both outcomes are stored here only for accepted sends, so both count.
 */
export const countSendsSince = (scope: GuildScope, sinceMs: number): number =>
  read(
    scope,
    (db) =>
      db
        .select({ n: count() })
        .from(mcpSends)
        .where(scope.only(mcpSends, gte(mcpSends.sentAt, sinceMs)))
        .get()?.n ?? 0,
  );

/** For `bananasaurs mcp sends [--since]`, newest first. */
export const listSends = (
  scope: GuildScope,
  input: { sinceMs?: number | undefined; limit?: number | undefined },
): readonly SendRow[] =>
  read(scope, (db) => {
    const base = db
      .select()
      .from(mcpSends)
      .where(
        scope.only(
          mcpSends,
          input.sinceMs === undefined ? undefined : gte(mcpSends.sentAt, input.sinceMs),
        ),
      )
      .orderBy(desc(mcpSends.sentAt), asc(mcpSends.idempotencyKey));
    const rows = input.limit === undefined ? base.all() : base.limit(input.limit).all();
    return rows.map(toSendRow);
  });

/**
 * Ruling M5-D4: two hundred accepted sends per guild per rolling hour
 * (raised from the launch default of 10 per owner decision, see Q1 in
 * docs/superpowers/specs/2026-09-12-mcp-operator-server-design.md).
 */
export const SEND_RATE_LIMIT = 200;
export const SEND_RATE_WINDOW_MS = 60 * 60 * 1000;
