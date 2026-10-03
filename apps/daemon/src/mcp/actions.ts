import { randomUUID } from 'node:crypto';
import {
  MCP_ACTION_CAPS,
  type GuildId,
  type InstanceSettingKey,
  type Logger,
  type McpActionAuditInput,
  type McpActionDeps,
  type McpCapGroup,
} from '@bananasaurs/core';
import {
  effectRepo,
  guildRepo,
  mcpActionsRepo,
  mcpBulkRepo,
  type GuildScope,
} from '@bananasaurs/storage';

/**
 * The `McpActionDeps` factory (Task 4 Step 2): core's `runMcpAction` pipeline
 * over the new storage — the `mcp_actions` ledger repos and the audit repo.
 *
 * Core owns the ordering and the decisions; every guild handle, the database
 * and the concrete audit vocabulary stay on this side of the ports. The audit
 * action for `send_message` stays `mcp.message.sent` (continuity of the
 * existing trail): the `after` payload keeps `clientId`, `tokenId`,
 * `outcome`, `messageId` and the derived-grant fields, and adds `actionId` —
 * never content.
 */

export interface McpActionPrincipal {
  readonly clientId: string;
  readonly tokenId: string;
}

export interface McpActionEnv {
  readonly scopes: { forGuild(guildId: GuildId): GuildScope };
  readonly logger: Logger;
  readonly now: () => number;
  /**
   * ADR 0119 §4: the live instance settings (the same `get` other settings
   * use). `get` is required, so a port that cannot read a setting live does
   * not type-check here and cannot silently freeze the caps at their
   * defaults; at runtime the daemon hands in the full store. Only an absent
   * store (isolated tests) falls back to `MCP_ACTION_CAPS`.
   */
  readonly instanceSettings?: { get(key: InstanceSettingKey): unknown } | undefined;
}

const MCP_CAP_KEY_FOR_GROUP: Readonly<Record<McpCapGroup, InstanceSettingKey>> = {
  message: 'mcp.cap.message',
  edit: 'mcp.cap.edit',
  member_role: 'mcp.cap.member_role',
  structure: 'mcp.cap.structure',
  pin_react: 'mcp.cap.pin_react',
};

/** The audit action per write kind. Extended as new tools move onto the pipeline. */
const AUDIT_ACTION_FOR_KIND: Readonly<Record<string, string>> = {
  'message.send': 'mcp.message.sent',
};

const auditActionFor = (kind: string): string => AUDIT_ACTION_FOR_KIND[kind] ?? `mcp.${kind}`;

/** The trail keeps yesterday's outcome words: `done` audits as `sent`. */
const auditOutcomeFor = (outcome: McpActionAuditInput['outcome']): string =>
  outcome === 'done' ? 'sent' : outcome === 'dry-run' ? 'dry_run' : 'failed';

export const mcpActionDepsFor = (
  env: McpActionEnv,
  guildId: GuildId,
  principal: McpActionPrincipal,
  auditContext: { readonly grantedByChannelId?: string } = {},
): McpActionDeps => {
  const scope = env.scopes.forGuild(guildId);
  return {
    guildId,
    logger: env.logger,
    now: env.now,
    newActionId: () => randomUUID(),
    // Live on every call: the store's `get` reads the current row (or the
    // registry default), so an owner edit applies to the next action with no
    // restart. Absent store (isolated tests) falls back to the defaults.
    capFor: (capGroup) => {
      const raw = env.instanceSettings?.get(MCP_CAP_KEY_FOR_GROUP[capGroup]);
      return typeof raw === 'number' ? raw : MCP_ACTION_CAPS[capGroup];
    },
    state: {
      read: () => guildRepo.readSafetyState(scope),
    },
    ledger: {
      find: (key) => {
        const row = mcpActionsRepo.findAction(scope, key);
        if (row === undefined) return undefined;
        return {
          actionId: row.actionId,
          argsHash: row.argsHash,
          ...(row.resultMessageId !== undefined ? { resultMessageId: row.resultMessageId } : {}),
          ...(row.resultThreadId !== undefined ? { resultThreadId: row.resultThreadId } : {}),
        };
      },
      claim: (row) => mcpActionsRepo.claimAction(scope, row),
      complete: (actionId, result) =>
        mcpActionsRepo.completeAction(scope, actionId, {
          status: result.status,
          ...(result.resultMessageId !== undefined
            ? { resultMessageId: result.resultMessageId }
            : {}),
          ...(result.resultThreadId !== undefined ? { resultThreadId: result.resultThreadId } : {}),
          ...(result.undo !== undefined ? { undoJson: JSON.stringify(result.undo) } : {}),
          now: result.now,
        }),
      /**
       * The `member_role` cap counts members, not actions (ADR 0118 §8, no
       * migration): the ledger holds one `role.bulk` row per consumed
       * preview — every confirm claims exactly one row and consumes exactly
       * one preview inside its execute — so the count subtracts those rows
       * and adds the consumed previews' member total instead. Every other
       * cap group counts ledger rows unchanged.
       */
      countSince: (capGroup, sinceMs) => {
        if (capGroup !== 'member_role') {
          return mcpActionsRepo.countActionsSince(scope, capGroup, sinceMs);
        }
        // `role.bulk` rows carry no weight of their own: a bulk change counts
        // as the members of its consumed preview, whatever its row's state.
        const singles = mcpActionsRepo.countActionsSince(scope, capGroup, sinceMs, {
          excludeKind: 'role.bulk',
        });
        return singles + mcpBulkRepo.sumConsumedMembers(scope, sinceMs).memberTotal;
      },
      recentSameContent: (argsHash, channelId, sinceMs) =>
        channelId === undefined
          ? false
          : mcpActionsRepo.recentSameContent(scope, argsHash, channelId, sinceMs),
    },
    audit: {
      record: (input) => {
        const grantedBy = auditContext.grantedByChannelId;
        const derived =
          grantedBy !== undefined && grantedBy !== input.targetChannelId
            ? { authorization: 'derived', grantedByChannelId: grantedBy }
            : {};
        effectRepo.recordAudit(scope, {
          at: input.atMs,
          actorType: 'mcp_operator',
          actorId: input.tokenId,
          // `via` is the transport vocabulary (ruling M5-D10): this call
          // arrived over HTTP on the dashboard's own Fastify app.
          via: 'http',
          action: auditActionFor(input.kind),
          subjectType: 'channel',
          subjectId: input.targetChannelId,
          before: undefined,
          // Ids, the credential and the outcome — never content (rule 4).
          after: {
            clientId: principal.clientId,
            tokenId: input.tokenId,
            outcome: auditOutcomeFor(input.outcome),
            ...(input.resultMessageId !== undefined ? { messageId: input.resultMessageId } : {}),
            ...(input.resultThreadId !== undefined ? { threadId: input.resultThreadId } : {}),
            actionId: input.actionId,
            ...derived,
          },
          dryRun: input.dryRun,
        });
      },
    },
  };
};
