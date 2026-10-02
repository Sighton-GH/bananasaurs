import { z } from 'zod';
import {
  JOB_KINDS,
  parseSnowflakeId,
  RetryAfterError,
  safeLogFields,
  type Authorized,
  type EffectGateway,
  type GuildId,
  type JobHandler,
  type Logger,
  type SnowflakeId,
} from '@bananasaurs/core';
import type { GuildScope } from '@bananasaurs/storage';
import type { mcpBulkRepo } from '@bananasaurs/storage';

/**
 * The durable `mcp.bulk_role` job (slice 4, Task 4): the confirm half of the
 * preview → confirm handshake, applied resumably.
 *
 * The confirm enqueues one of these per accepted preview with payload
 * `{guildId, previewId, actionId, accountId}`. The handler loads the preview
 * by id (guild-scoped, never by token — the token must not sit in the
 * durable jobs table) and walks its stored `member_ids_json` from the
 * persisted cursor. The previewed set is never re-resolved: members who left
 * or joined since the preview do not move the set; each member is applied
 * through the MCP role gateway with trigger ref
 * `mcp-bulk:<actionId>:<memberId>` and batch id = the action id, into the one
 * `effect_batches` row the confirm opened.
 *
 * Per-member outcomes (applied / already had / refused reason / failed code)
 * accumulate in the persisted cursor, so a rate-capped or restarted run keeps
 * the outcomes of the members before it, and the completion log line carries
 * the whole list — ids only, never member names or the confirm token. A gateway `rate-cap` refusal persists the cursor and throws
 * `RetryAfterError`, so the worker retries after the bucket refills and the
 * run resumes at the refused member; a restart resumes the same way through
 * the stranded-job recovery. Any other refusal is recorded and the walk
 * continues: one member's protected target must not stall the other 99.
 *
 * The witness is minted per run from the confirming account and re-verified
 * live by the gateway on every member: an account that lost `roles.mutate`
 * since the confirm sees its remaining members refused as `unauthorized`
 * rather than applied.
 */

/** The job kind, as the confirm enqueues it and `get_job` shows it. */
export const MCP_BULK_ROLE_KIND = JOB_KINDS.mcpBulkRole;

/** One job per accepted preview: the confirm's action id makes the key unique. */
export const mcpBulkRoleDedupeKey = (actionId: string): string =>
  `${MCP_BULK_ROLE_KIND}:${actionId}`;

export const mcpBulkRolePayload = z.object({
  guildId: z.string().min(1),
  previewId: z.string().min(1),
  actionId: z.string().min(1),
  /** The confirming dashboard account, for the per-run `roles.mutate` witness. */
  accountId: z.string().min(1),
});
export type McpBulkRolePayload = z.infer<typeof mcpBulkRolePayload>;

/**
 * Where the walk got to: the index into the preview's stored member list of
 * the next member to apply, and the outcomes of the members before it. Our
 * own prior write, but still validated on read like every cursor — a row that
 * does not validate restarts from zero rather than trusting garbage into the
 * walk.
 */
const mcpBulkRoleCursor = z.object({
  next: z.number().int().nonnegative(),
  outcomes: z.array(z.string()).max(100).default([]),
});
type McpBulkRoleCursor = z.infer<typeof mcpBulkRoleCursor>;

/** A gateway `rate-cap` retries after a full bucket refill (the per-minute rate). */
export const MCP_BULK_RATE_RETRY_MS = 60_000;

/** Attempts for one bulk job: a 100-member walk through a 20/min bucket needs room to reschedule. */
export const MCP_BULK_MAX_ATTEMPTS = 25;

export interface McpBulkRoleJobPorts {
  readonly scope: GuildScope;
  readonly logger: Logger;
  now(): number;
  /** The MCP role gateway (`mcpGatewayFor`), shared with the interactive role tools. */
  readonly gateway: Pick<EffectGateway, 'applyRoleEffect'>;
  /** Mints this run's `roles.mutate` witness, or `undefined` when the grant is gone. */
  authorizeAccount(accountId: string): Authorized<'roles.mutate'> | undefined;
  /** The preview by id in this guild — the job's only read of the stored set. */
  findPreview(previewId: string): mcpBulkRepo.McpBulkPreviewRow | undefined;
}

const parseCursor = (raw: string | null): McpBulkRoleCursor => {
  if (raw === null) return { next: 0, outcomes: [] };
  try {
    return mcpBulkRoleCursor.parse(JSON.parse(raw) as unknown);
  } catch {
    return { next: 0, outcomes: [] };
  }
};

export const mcpBulkRoleHandler = (ports: McpBulkRoleJobPorts): JobHandler<McpBulkRolePayload> => ({
  kind: MCP_BULK_ROLE_KIND,
  payload: mcpBulkRolePayload,
  async run(payload, context) {
    const { scope, logger, gateway } = ports;
    const guildId: GuildId = scope.guildId;
    if (payload.guildId !== guildId) {
      logger.warn(
        safeLogFields({ component: 'jobs', jobKind: MCP_BULK_ROLE_KIND, guildId }),
        'bulk role job for another guild; completing without acting',
      );
      return;
    }
    const preview = ports.findPreview(payload.previewId);
    if (preview === undefined) {
      logger.warn(
        safeLogFields({ component: 'jobs', jobKind: MCP_BULK_ROLE_KIND, guildId }),
        'bulk role job found no preview; completing without acting',
      );
      return;
    }
    // A lost consume race enqueued a job whose preview another confirm owns:
    // completing, not retrying — the winning job applies the set.
    if (preview.jobId !== context.jobId) {
      logger.warn(
        safeLogFields({ component: 'jobs', jobKind: MCP_BULK_ROLE_KIND, guildId }),
        'bulk role job preview consumed by another job; completing without acting',
      );
      return;
    }
    let memberIds: SnowflakeId[];
    let roleId: SnowflakeId;
    try {
      memberIds = preview.memberIds.map((id) => parseSnowflakeId(id));
      roleId = parseSnowflakeId(preview.roleId);
    } catch {
      logger.error(
        safeLogFields({ component: 'jobs', jobKind: MCP_BULK_ROLE_KIND, guildId }),
        'bulk role job preview holds malformed ids; completing without acting',
      );
      return;
    }
    const witness = ports.authorizeAccount(payload.accountId);
    const action = preview.actionKind === 'add' ? 'grant' : 'revoke';
    const resumed = parseCursor(context.cursor);
    let next = Math.min(resumed.next, memberIds.length);
    // Outcomes beyond the resume point would be stale (a cursor that does not
    // match its own index): keep exactly one per member already walked.
    const outcomes: string[] = resumed.outcomes.slice(0, next);
    for (; next < memberIds.length; next += 1) {
      const memberId = memberIds[next];
      if (memberId === undefined) break;
      if (witness === undefined) {
        outcomes.push(`${memberId}:refused:unauthorized`);
        continue;
      }
      // A fetch fault inside the gateway (a member who left since the
      // preview, a role Discord dropped mid-walk) throws rather than
      // returning `failed` — recorded for this member, never the whole walk.
      let result: Awaited<ReturnType<EffectGateway['applyRoleEffect']>>;
      try {
        result = await gateway.applyRoleEffect(witness, {
          userId: memberId,
          roleId,
          action,
          panelId: undefined,
          triggerRef: `mcp-bulk:${payload.actionId}:${memberId}`,
          source: 'mcp',
          batchId: payload.actionId,
          reason: 'mcp bulk_role_change',
        });
      } catch (err) {
        outcomes.push(`${memberId}:failed:${err instanceof Error ? err.name : 'UnknownError'}`);
        continue;
      }
      switch (result.status) {
        case 'applied':
          outcomes.push(`${memberId}:applied`);
          break;
        case 'skipped':
          outcomes.push(`${memberId}:already-had`);
          break;
        case 'refused':
          if (result.reason === 'rate-cap') {
            // Persist the cursor at the refused member and reschedule: the
            // retry resumes here after the bucket refills.
            context.saveCursor(JSON.stringify({ next, outcomes }));
            throw new RetryAfterError(
              `bulk role job rate-capped at member ${String(next)} of ${String(memberIds.length)}`,
              MCP_BULK_RATE_RETRY_MS,
            );
          }
          outcomes.push(`${memberId}:refused:${result.reason}`);
          break;
        case 'failed':
          outcomes.push(`${memberId}:failed:${result.code}`);
          break;
        case 'dry-run':
          // Unreachable: the gateway runs live here, never dry.
          outcomes.push(`${memberId}:failed:dry-run`);
          break;
      }
      context.saveCursor(JSON.stringify({ next: next + 1, outcomes }));
    }
    const applied = outcomes.filter((line) => line.endsWith(':applied')).length;
    logger.info(
      safeLogFields({
        component: 'jobs',
        jobKind: MCP_BULK_ROLE_KIND,
        guildId,
        outcome: 'completed',
        count: applied,
        total: memberIds.length,
      }),
      `bulk role job finished: ${String(applied)}/${String(memberIds.length)} applied (${outcomes.join(', ')})`,
    );
  },
});
