import type { AuditLogEntry, Snowflake } from '../discord/port.js';
import type { OutgoingMessage } from '../discord/port.js';
import type { LogMessageDeletePayload } from '../jobs/kinds.js';
import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';
import { toOutgoingMessage } from '../ui/discord/card.js';
import { correlateDeletion } from './attribution.js';
import { renderLogCard } from './cards.js';
import { formatMessageDelete } from './format.js';
import { routeAccepts, routeDedupeKind, type LogRoute, type LogSource } from './routing.js';

/**
 * The delayed job's body (ADR 0123 decision 7): consult the audit log,
 * decide an actor or refuse to guess, record the audit trail once, and post
 * the log line to every matching route, each under its own claim. Runs
 * `MESSAGE_DELETE_ATTRIBUTION_DELAY_MS` after the dispatch.
 */

export interface MessageDeleteAttribution {
  actorId: Snowflake | undefined;
  inferred: boolean;
}

export interface MessageDeleteAttributionPorts {
  readonly guildId: Snowflake;
  /** Enabled routes that include this event kind (ADR 0123). */
  listEnabledRoutesFor(eventKind: string): readonly LogRoute[];
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
  sendMessage(channelId: Snowflake, message: OutgoingMessage): Promise<unknown>;
  readonly logger: Logger;
  now(): number;
}

export async function attributeAndLogDeletion(
  ports: MessageDeleteAttributionPorts,
  payload: LogMessageDeletePayload,
): Promise<void> {
  const source: LogSource = {
    channelId: payload.channelId,
    parentChannelId: payload.parentChannelId,
    // The persisted payload carries no category: the guild-wide exclusion is
    // enforced at enqueue time in the subscriber, so by the time this job
    // runs the source was already allowed.
    categoryId: undefined,
  };
  const routes = ports
    .listEnabledRoutesFor('message_delete')
    .filter((r) => routeAccepts(r, source));
  if (routes.length === 0) return; // config changed since enqueue

  const fingerprint = payload.messageId;
  const pending = routes.filter((r) =>
    ports.claim({ eventKind: routeDedupeKind(r.routeId, 'message_delete'), fingerprint }),
  );
  if (pending.length === 0) return;

  let actorId: Snowflake | undefined;
  try {
    const existing = ports.findExistingAttribution(payload.messageId);
    actorId = existing !== undefined ? existing.actorId : await resolveActor(ports, payload);
    if (existing === undefined) {
      ports.recordAudit({ actorId, inferred: actorId !== undefined, at: ports.now(), payload });
    }
  } catch (err) {
    for (const route of pending) {
      ports.release({
        eventKind: routeDedupeKind(route.routeId, 'message_delete'),
        fingerprint,
      });
    }
    ports.logger.error(
      safeLogFields({
        component: 'logging',
        guildId: ports.guildId,
        eventKind: 'messageDelete',
        messageId: payload.messageId,
        channelId: payload.channelId,
        err,
      }),
      'failed to resolve a deletion attribution; released the claims for a future retry',
    );
    throw err;
  }

  let firstError: Error | undefined;
  for (const route of pending) {
    const dedupeKind = routeDedupeKind(route.routeId, 'message_delete');
    try {
      await ports.sendMessage(
        route.channelId,
        toOutgoingMessage(
          renderLogCard(
            formatMessageDelete(
              route.includeContent ? payload : { ...payload, content: undefined },
              actorId,
              payload.deletedAtMs,
            ),
            ports.guildId,
          ),
        ),
      );
    } catch (err) {
      // The send failing must not blackhole this line forever (ADR 0123
      // decision 6) — but the resolution above is durable and idempotent via
      // `findExistingAttribution`, so releasing here only ever retries the part
      // that still needs it.
      ports.release({ eventKind: dedupeKind, fingerprint });
      ports.logger.error(
        safeLogFields({
          component: 'logging',
          guildId: ports.guildId,
          eventKind: 'messageDelete',
          messageId: payload.messageId,
          channelId: route.channelId,
          routeId: route.routeId,
          err,
        }),
        'failed to post a deletion log line; released the claim for a future retry',
      );
      firstError ??= err instanceof Error ? err : new Error(String(err));
    }
  }
  if (firstError !== undefined) throw firstError;
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
