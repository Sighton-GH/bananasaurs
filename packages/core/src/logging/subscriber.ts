import type { Snowflake } from '../discord/port.js';
import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';
import type { Subscriber } from '../pipeline/pipeline.js';
import { fingerprintOf } from '../pipeline/fingerprint.js';
import { MESSAGE_DELETE_ATTRIBUTION_DELAY_MS } from './attribution.js';
import { logMessageDeleteDedupeKey } from '../jobs/kinds.js';
import {
  formatGapMarker,
  formatMemberJoin,
  formatMemberLeave,
  formatMessageEdit,
  formatRoleCreate,
  formatRoleDelete,
  formatRoleUpdate,
} from './format.js';

/**
 * The logging module (ADR 0023): message edits and deletes, member
 * joins/leaves, and role create/update/delete. A deletion is not formatted
 * or sent here — it is enqueued as a delayed job, because ADR 0019 fact 3
 * says the audit log has not caught up yet at the moment the dispatch
 * arrives. `attribute-deletion.ts` is the job's body.
 */

export interface LogRoute {
  channelId: Snowflake;
  includeContent: boolean;
  enabled: boolean;
}

export interface LoggingPorts {
  readonly guildId: Snowflake;
  findRoute(eventKind: string): LogRoute | undefined;
  isChannelExcluded(channelId: Snowflake): boolean;
  /** Every distinct channel enabled for at least one event kind (gap markers). */
  listEnabledLogChannels(): readonly Snowflake[];
  /**
   * The claim, namespaced under this module's own `eventKind` so it cannot
   * collide with the pipeline's own gate-2 dedupe row for the bare gateway
   * kind (ADR 0023 decision 4).
   */
  claim(input: { eventKind: string; fingerprint: string }): boolean;
  /** Released when a send throws, so a later delivery of the same event can retry. */
  release(input: { eventKind: string; fingerprint: string }): void;
  sendMessage(channelId: Snowflake, message: { content: string }): Promise<unknown>;
  /** One job per deletion; a no-op if the same messageId is already queued. */
  enqueueDeletionAttribution(input: { dedupeKey: string; payload: string; runAfter: number }): {
    enqueued: boolean;
  };
  readonly logger: Logger;
  now(): number;
}

/** The `log_routes.event_kind` string for each gateway kind this module handles. */
const ROUTE_KIND = {
  messageUpdate: 'message_edit',
  memberAdd: 'member_join',
  memberRemove: 'member_leave',
  roleCreate: 'role_create',
  roleUpdate: 'role_update',
  roleDelete: 'role_delete',
} as const;

/**
 * Every value `log_routes.event_kind` may usefully hold.
 *
 * Derived from `ROUTE_KIND` rather than written out a second time, plus
 * `message_delete`, which is routed here but handled by a delayed job rather
 * than by the switch below (ADR 0019 fact 3).
 *
 * Exported for `bananasaurs log routing set`, which validates against it. A
 * route on an event kind nothing emits is the exact failure WP4's report §5
 * named: the command succeeds, the listing looks configured, and nothing is
 * ever logged — an inert module and a working one look identical.
 */
export const LOG_EVENT_KINDS: readonly string[] = [
  ...Object.values(ROUTE_KIND),
  'message_delete',
].sort();

/**
 * `roleUpdate` carries no pipeline-level fingerprint (`fingerprint.ts` leaves
 * it undeduplicated on purpose — it is "level-triggered" for any future
 * consumer that wants recomputation semantics). This module is not that
 * consumer: it needs an edge-triggered fingerprint of its own so a real
 * rename logs once and a resumed-session replay of the identical dispatch
 * does not log twice. Content-based rather than a version counter, because
 * `RoleEvent` has none.
 */
function fingerprintFor(event: Parameters<Subscriber['handle']>[0]): string | undefined {
  const fp = fingerprintOf(event);
  if (fp !== undefined) return fp;
  if (event.kind === 'roleUpdate') return `${event.roleId}:${event.name}`;
  return undefined;
}

/**
 * `docs/19` §6.7's restated gate, generalised (ADR 0023 decision 5): a gap
 * during which nothing was captured must be a visible marker, never a
 * silent hole. Every distinct enabled channel gets one, independently of the
 * others — one channel's send failing must not stop another's.
 */
async function postGapMarkers(
  ports: LoggingPorts,
  event: { disconnectedAtMs: number; receivedAtMs: number },
): Promise<void> {
  const dedupeKind = 'log:gap_marker';
  for (const channelId of ports.listEnabledLogChannels()) {
    const fingerprint = `${event.disconnectedAtMs}:${channelId}`;
    if (!ports.claim({ eventKind: dedupeKind, fingerprint })) continue;
    try {
      await ports.sendMessage(channelId, {
        content: formatGapMarker(event.disconnectedAtMs, event.receivedAtMs),
      });
    } catch (err) {
      ports.release({ eventKind: dedupeKind, fingerprint });
      ports.logger.error(
        safeLogFields({
          component: 'logging',
          guildId: ports.guildId,
          eventKind: 'connection',
          channelId,
          err,
        }),
        'failed to post a gap marker; released the claim for a future retry',
      );
    }
  }
}

export const createLoggingSubscriber = (ports: LoggingPorts): Subscriber => ({
  name: 'logging',
  async handle(event) {
    // Bulk deletes are not a logging-module event; ignore before the switch below.
    if (event.kind === 'messageDeleteBulk') return;

    if (event.kind === 'connection') {
      if (event.resumed) return; // nothing lost — the session replayed the gap
      await postGapMarkers(ports, event);
      return;
    }

    if (event.kind === 'messageDelete') {
      if (ports.isChannelExcluded(event.channelId)) return;
      const route = ports.findRoute('message_delete');
      if (route === undefined || !route.enabled) return;

      const now = ports.now();
      ports.enqueueDeletionAttribution({
        dedupeKey: logMessageDeleteDedupeKey(event.channelId, event.messageId),
        payload: JSON.stringify({
          channelId: event.channelId,
          messageId: event.messageId,
          authorId: event.authorId,
          // Decided once, here — not re-checked at job time — so content the
          // owner has off is never persisted into the job table even for the
          // delay's duration.
          content: route.includeContent ? event.content : undefined,
          deletedAtMs: event.receivedAtMs,
        }),
        runAfter: now + MESSAGE_DELETE_ATTRIBUTION_DELAY_MS,
      });
      return;
    }

    const routeKind = ROUTE_KIND[event.kind as keyof typeof ROUTE_KIND] as string | undefined;
    if (routeKind === undefined) return; // everything else: not this module's job

    if (event.kind === 'messageUpdate' && ports.isChannelExcluded(event.channelId)) return;

    const route = ports.findRoute(routeKind);
    if (route === undefined || !route.enabled) return;

    const fingerprint = fingerprintFor(event);
    if (fingerprint === undefined) return; // unreachable for the six kinds above

    const dedupeKind = `log:${routeKind}`;
    if (!ports.claim({ eventKind: dedupeKind, fingerprint })) return;

    const content = ((): string => {
      switch (event.kind) {
        case 'messageUpdate':
          return formatMessageEdit(event, route.includeContent);
        case 'memberAdd':
          return formatMemberJoin(event);
        case 'memberRemove':
          return formatMemberLeave(event);
        case 'roleCreate':
          return formatRoleCreate(event);
        case 'roleUpdate':
          return formatRoleUpdate(event);
        case 'roleDelete':
          return formatRoleDelete(event);
        default:
          throw new Error(`unreachable log event kind: ${event.kind}`);
      }
    })();

    try {
      await ports.sendMessage(route.channelId, { content });
    } catch (err) {
      // A transient send failure must not blackhole this line forever — this
      // module has no reconciliation to fall back on (ADR 0023 decision 4).
      ports.release({ eventKind: dedupeKind, fingerprint });
      ports.logger.error(
        safeLogFields({
          component: 'logging',
          guildId: ports.guildId,
          eventKind: event.kind,
          channelId: route.channelId,
          err,
        }),
        'failed to post a log line; released the claim for a future retry',
      );
      throw err;
    }
  },
});
