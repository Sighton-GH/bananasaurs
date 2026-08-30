import type { AuditLogEntry, Snowflake } from '../discord/port.js';
import type { LogMessageDeletePayload } from '../jobs/kinds.js';
import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';
import { correlateDeletion } from './attribution.js';
import { formatMessageDelete } from './format.js';
import type { LogRoute } from './subscriber.js';

/**
 * The delayed job's body (ADR 0022 decision 3): consult the audit log,
 * decide an actor or refuse to guess, record the audit trail, and post the
 * log line. Runs `MESSAGE_DELETE_ATTRIBUTION_DELAY_MS` after the dispatch.
 */

export interface MessageDeleteAttribution {
  actorId: Snowflake | undefined;
  inferred: boolean;
}

export interface MessageDeleteAttributionPorts {
  readonly guildId: Snowflake;
  findRoute(eventKind: string): LogRoute | undefined;
  fetchAuditLog(): Promise<readonly AuditLogEntry[]>;
  claimedCountFor(input: {
    actorUserId: Snowflake;
    authorId: Snowflake;
    channelId: Snowflake;
  }): number;
  incrementClaimedCount(input: {
    actorUserId: Snowflake;
    authorId: Snowflake;
    channelId: Snowflake;
  }): void;
  /**
   * Read before resolving anything (the job's own idempotency): a retry after
   * a failed send must reuse what was already decided, not re-consult the
   * audit log, which could see a different, contradictory answer the second
   * time — decision 3's cursor already advanced on the first, successful
   * resolution, so re-resolving would find its own increment already claimed
   * and wrongly downgrade a correct attribution to "unknown".
   */
  findExistingAttribution(messageId: Snowflake): MessageDeleteAttribution | undefined;
  recordAudit(
    input: MessageDeleteAttribution & { at: number; payload: LogMessageDeletePayload },
  ): void;
  claim(input: { eventKind: string; fingerprint: string }): boolean;
  release(input: { eventKind: string; fingerprint: string }): void;
  sendMessage(channelId: Snowflake, message: { content: string }): Promise<unknown>;
  readonly logger: Logger;
  now(): number;
}

const DEDUPE_KIND = 'log:message_delete';

export async function attributeAndLogDeletion(
  ports: MessageDeleteAttributionPorts,
  payload: LogMessageDeletePayload,
): Promise<void> {
  const route = ports.findRoute('message_delete');
  if (route === undefined || !route.enabled) return; // config changed since enqueue

  const fingerprint = payload.messageId;
  if (!ports.claim({ eventKind: DEDUPE_KIND, fingerprint })) return;

  try {
    const existing = ports.findExistingAttribution(payload.messageId);
    const actorId = existing !== undefined ? existing.actorId : await resolveActor(ports, payload);
    if (existing === undefined) {
      ports.recordAudit({ actorId, inferred: actorId !== undefined, at: ports.now(), payload });
    }

    await ports.sendMessage(route.channelId, {
      content: formatMessageDelete(payload, actorId),
    });
  } catch (err) {
    // The send failing must not blackhole this line forever (ADR 0022 decision
    // 4) — but the resolution above is durable and idempotent via
    // `findExistingAttribution`, so releasing here only ever retries the part
    // that still needs it.
    ports.release({ eventKind: DEDUPE_KIND, fingerprint });
    ports.logger.error(
      safeLogFields({
        component: 'logging',
        guildId: ports.guildId,
        eventKind: 'messageDelete',
        messageId: payload.messageId,
        channelId: route.channelId,
        err,
      }),
      'failed to post a deletion log line; released the claim for a future retry',
    );
    throw err;
  }
}

async function resolveActor(
  ports: MessageDeleteAttributionPorts,
  payload: LogMessageDeletePayload,
): Promise<Snowflake | undefined> {
  // No author means no correlation is possible at all (ADR 0019 fact 1: a
  // MESSAGE_DELETE entry's target is the author, so nothing to match on).
  if (payload.authorId === undefined) return undefined;
  const authorId = payload.authorId;

  const entries = await ports.fetchAuditLog();
  const candidates = entries
    .filter(
      (e): e is AuditLogEntry & { actorUserId: Snowflake } =>
        e.actorUserId !== undefined && e.targetId === authorId && e.channelId === payload.channelId,
    )
    .map((e) => ({
      actorUserId: e.actorUserId,
      liveCount: e.count ?? 1,
      claimedCount: ports.claimedCountFor({
        actorUserId: e.actorUserId,
        authorId,
        channelId: payload.channelId,
      }),
    }));

  const actorUserId = correlateDeletion(candidates);
  if (actorUserId !== undefined) {
    ports.incrementClaimedCount({ actorUserId, authorId, channelId: payload.channelId });
  }
  return actorUserId;
}
