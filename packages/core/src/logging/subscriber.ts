import type { OutgoingMessage, Snowflake } from '../discord/port.js';
import { createHash } from 'node:crypto';
import type { MemberEvent, NativeAutoModAction } from '../discord/events.js';
import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';
import type { Subscriber } from '../pipeline/pipeline.js';
import { fingerprintOf } from '../pipeline/fingerprint.js';
import { toOutgoingMessage } from '../ui/discord/card.js';
import { MESSAGE_DELETE_ATTRIBUTION_DELAY_MS } from './attribution.js';
import { logMessageDeleteDedupeKey } from '../jobs/kinds.js';
import {
  isSourceExcluded,
  routeAccepts,
  routeDedupeKind,
  type LogRoute,
  type LogSource,
} from './routing.js';
import {
  formatGapMarker,
  formatMemberJoin,
  formatMemberLeave,
  formatMessageCreate,
  formatMessageEdit,
  formatRoleCreate,
  formatRoleDelete,
  formatRoleUpdate,
} from './format.js';
import { renderLogCard, type LogCardView } from './cards.js';
import { MEMBER_CHANGE_KINDS, baselineFor, memberChanges } from './member-changes.js';
import { AUDIT_EVENT_KINDS, auditItemsFor } from './audit-items.js';
import type { MemberSnapshotLike } from './member-changes.js';

export type { LogRoute } from './routing.js';

/**
 * The logging module (ADR 0123): message edits and deletes, member
 * joins/leaves, role create/update/delete, live audit-log entries (kicks,
 * bans, timeouts, channel/thread/server changes, invites, emoji, stickers),
 * and bulk deletes (purges). A deletion is not formatted
 * or sent here — it is enqueued as a delayed job, because ADR 0019 fact 3
 * says the audit log has not caught up yet at the moment the dispatch
 * arrives. `attribute-deletion.ts` is the job's body.
 *
 * Each handled gateway event becomes zero or more log items, and each item
 * fans out to every matching enabled route — one post per route, each under
 * its own claim (`log:r<route_id>:<event_kind>`), so one bad route never
 * blocks another.
 */

export interface LoggingPorts {
  readonly guildId: Snowflake;
  /** Enabled routes that include this event kind (ADR 0123). */
  listEnabledRoutesFor(eventKind: string): readonly LogRoute[];
  isChannelExcluded(channelId: Snowflake): boolean;
  /** Every distinct channel enabled for at least one event kind (gap markers). */
  listEnabledLogChannels(): readonly Snowflake[];
  /**
   * The claim, namespaced per route under this module's own `eventKind` so
   * it cannot collide with the pipeline's own gate-2 dedupe row for the bare
   * gateway kind (ADR 0123 decision 6).
   */
  claim(input: { eventKind: string; fingerprint: string }): boolean;
  /** Released when a send throws, so a later delivery of the same event can retry. */
  release(input: { eventKind: string; fingerprint: string }): void;
  sendMessage(channelId: Snowflake, message: OutgoingMessage): Promise<unknown>;
  /**
   * The per-member last-seen record (ADR 0123 decision 8): what the logging
   * module last knew, so a change can be rendered old → new. Hashes only —
   * no image is ever downloaded or stored. Guild scope is bound by the
   * composition root, which closes over its own scope.
   */
  getMemberSnapshot(userId: Snowflake): MemberSnapshotLike | undefined;
  saveMemberSnapshot(snapshot: MemberSnapshotLike): void;
  deleteMemberSnapshot(userId: Snowflake): void;
  /** One job per deletion; a no-op if the same messageId is already queued. */
  enqueueDeletionAttribution(input: { dedupeKey: string; payload: string; runAfter: number }): {
    enqueued: boolean;
  };
  readonly logger: Logger;
  now(): number;
}

/** The event-kind string for each gateway kind this module handles (ADR 0123). */
const ROUTE_KIND = {
  messageUpdate: 'message_edit',
  memberAdd: 'member_join',
  memberRemove: 'member_leave',
  roleCreate: 'role_create',
  roleUpdate: 'role_update',
  roleDelete: 'role_delete',
  // `memberUpdate` is deliberately absent: it fans out to the four
  // MEMBER_CHANGE_KINDS via the snapshot diff in `handle`, not to one kind.
  messageCreate: 'message_create',
  guildCreate: 'guild_available',
  guildDelete: 'guild_unavailable',
  autoModerationAction: 'automod_action',
} as const;

/**
 * Every event kind a route may usefully include.
 *
 * Derived from `ROUTE_KIND` rather than written out a second time, plus the
 * four member-change kinds (diffed from the last-seen record in `handle`,
 * not mapped from one gateway kind), `message_delete`, which is routed
 * here but handled by a delayed job rather than by the switch below
 * (ADR 0019 fact 3), the eighteen audit-log kinds (one item per live
 * `auditLogEntry`, via `audit-items.ts`), `message_bulk_delete` (the
 * gateway bulk-delete event), and `member_warn` (posted by the logging
 * side of `/mod warn` through `createLogPoster`, not by this subscriber).
 *
 * Exported for `bananasaurs log routing create`, which validates against it. A
 * route on an event kind nothing emits is the exact failure WP4's report §5
 * named: the command succeeds, the listing looks configured, and nothing is
 * ever logged — an inert module and a working one look identical.
 */
export const LOG_EVENT_KINDS: readonly string[] = [
  ...Object.values(ROUTE_KIND),
  ...MEMBER_CHANGE_KINDS,
  ...AUDIT_EVENT_KINDS,
  'message_delete',
  'message_bulk_delete',
  'member_warn',
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

interface LogItem {
  eventKind: string; // a LOG_EVENT_KINDS value
  fingerprint: string; // replay-stable identity of this item
  source: LogSource | undefined; // undefined for events with no source channel
  view(includeContent: boolean): LogCardView;
}

export type { LogItem };

type HandleEvent = Parameters<Subscriber['handle']>[0];

function logItemsFor(event: HandleEvent): LogItem[] {
  if (event.kind === 'auditLogEntry') {
    // One item per handled audit action, each under the entry's own id so a
    // replayed entry posts nothing new. An entry for an unhandled action
    // yields no items.
    return auditItemsFor(event).map((item) => ({
      eventKind: item.eventKind,
      fingerprint: event.entryId,
      source: undefined,
      view: () => item.view(event.receivedAtMs),
    }));
  }

  if (event.kind === 'messageDeleteBulk') {
    const fingerprint =
      fingerprintOf(event) ?? `${event.kind}:${event.receivedAtMs}:${event.channelId}`;
    const source: LogSource = {
      channelId: event.channelId,
      parentChannelId: event.parentChannelId,
      categoryId: event.categoryId,
    };
    return [
      {
        eventKind: 'message_bulk_delete',
        fingerprint,
        source,
        view: () => ({
          kind: 'message_bulk_delete',
          headline: `${event.messageIds.length} messages were purged in <#${event.channelId}>`,
          at: event.receivedAtMs,
        }),
      },
    ];
  }

  const routeKind = ROUTE_KIND[event.kind as keyof typeof ROUTE_KIND] as string | undefined;
  if (routeKind === undefined) return []; // everything else: not this module's job

  if (event.kind === 'messageCreate') {
    if (event.authorIsBot) return [];
    const source: LogSource = {
      channelId: event.channelId,
      parentChannelId: event.parentChannelId,
      categoryId: event.categoryId,
    };
    const fingerprint =
      fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.messageId ?? 'none'}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source,
        view: (includeContent) =>
          formatMessageCreate(event, includeContent, event.receivedAtMs),
      },
    ];
  }

  if (event.kind === 'messageUpdate') {
    const source: LogSource = {
      channelId: event.channelId,
      parentChannelId: event.parentChannelId,
      categoryId: event.categoryId,
    };
    const fingerprint =
      fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.messageId ?? 'none'}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source,
        view: (includeContent) => formatMessageEdit(event, includeContent, event.receivedAtMs),
      },
    ];
  }

  if (event.kind === 'memberAdd') {
    const fingerprint =
      fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.userId}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source: undefined,
        view: () => formatMemberJoin(event, event.receivedAtMs),
      },
    ];
  }

  if (event.kind === 'memberRemove') {
    const fingerprint =
      fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.userId}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source: undefined,
        view: () => formatMemberLeave(event, event.receivedAtMs),
      },
    ];
  }

  if (event.kind === 'roleCreate') {
    const fingerprint =
      fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.guildId}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source: undefined,
        view: () => formatRoleCreate(event, event.receivedAtMs),
      },
    ];
  }

  if (event.kind === 'roleUpdate') {
    const fingerprint =
      fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.guildId}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source: undefined,
        view: () => formatRoleUpdate(event, event.receivedAtMs),
      },
    ];
  }

  if (event.kind === 'roleDelete') {
    const fingerprint =
      fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.guildId}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source: undefined,
        view: () => formatRoleDelete(event, event.receivedAtMs),
      },
    ];
  }

  if (event.kind === 'guildCreate') {
    const fingerprint =
      fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.guildId}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source: undefined,
        view: () => ({
          kind: 'guild_available',
          headline: 'The server became available to Bananasaurs.',
          at: event.receivedAtMs,
        }),
      },
    ];
  }

  if (event.kind === 'guildDelete') {
    const fingerprint =
      fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.guildId}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source: undefined,
        view: () => ({
          kind: 'guild_unavailable',
          headline: 'The server became unavailable to Bananasaurs.',
          at: event.receivedAtMs,
        }),
      },
    ];
  }

  if (event.kind === 'autoModerationAction') {
    const fingerprint =
      fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.guildId}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source: undefined,
        view: () => ({
          kind: 'automod_action',
          headline: `Discord AutoMod acted on a message by <@${event.userId}>`,
          details: [`Action: ${automodActionLabel(event.actionType)}`, `-# Rule ${event.ruleId}`],
          memberId: event.userId,
          ...(event.messageId !== undefined && event.channelId !== undefined
            ? { message: { channelId: event.channelId, messageId: event.messageId, exists: true } }
            : {}),
          at: event.receivedAtMs,
        }),
      },
    ];
  }

  throw new Error(`unreachable log event kind: ${event.kind}`);
}

export const createLoggingSubscriber = (ports: LoggingPorts): Subscriber => ({
  name: 'logging',
  async handle(event) {
    if (event.kind === 'connection') {
      if (event.resumed) return; // nothing lost — the session replayed the gap
      await postGapMarkers(ports, event);
      return;
    }

    if (event.kind === 'messageDelete') {
      const source: LogSource = {
        channelId: event.channelId,
        parentChannelId: event.parentChannelId,
        categoryId: event.categoryId,
      };
      if (isSourceExcluded(source, (id) => ports.isChannelExcluded(id))) return;
      const routes = ports
        .listEnabledRoutesFor('message_delete')
        .filter((r) => routeAccepts(r, source));
      if (routes.length === 0) return;

      const now = ports.now();
      ports.enqueueDeletionAttribution({
        dedupeKey: logMessageDeleteDedupeKey(event.channelId, event.messageId),
        payload: JSON.stringify({
          channelId: event.channelId,
          messageId: event.messageId,
          authorId: event.authorId,
          parentChannelId: event.parentChannelId,
          // Decided once, here — not re-checked at job time — so content the
          // owner has off is never persisted into the job table even for the
          // delay's duration.
          content: routes.some((r) => r.includeContent) ? event.content : undefined,
          deletedAtMs: event.receivedAtMs,
        }),
        runAfter: now + MESSAGE_DELETE_ATTRIBUTION_DELAY_MS,
      });
      return;
    }

    if (event.kind === 'memberAdd') {
      const firstError = await postItems(ports, logItemsFor(event), event.kind);
      if (firstError === undefined) {
        // Like the update path below: a failed send must not advance the
        // snapshot — the replay must see the same baseline.
        if (wantsMemberChanges(ports)) {
          const snapshot = snapshotOf(event);
          if (snapshot !== undefined) ports.saveMemberSnapshot(snapshot);
        } else {
          // No route wants member changes, so no record is kept: drop any
          // existing row the next time the member is seen (ADR 0123 decision 8).
          ports.deleteMemberSnapshot(event.userId);
        }
      }
      if (firstError !== undefined) throw firstError;
      return;
    }

    if (event.kind === 'memberUpdate') {
      const baseline = baselineFor(ports.getMemberSnapshot(event.userId), event);
      const items: LogItem[] = memberChanges(baseline, event).map((change) => {
        // `at` is fixed at 0 so a replay hashes identically; the posted view
        // carries the event's own time.
        const fingerprint = `${event.userId}:${change.eventKind}:${baseline.version}:${shortHash(JSON.stringify(change.view(0)))}`;
        return {
          eventKind: change.eventKind,
          fingerprint,
          source: undefined,
          view: () => change.view(event.receivedAtMs),
        };
      });
      const firstError = await postItems(ports, items, event.kind);
      if (firstError === undefined) {
        // The replay must see the same baseline and therefore the same
        // fingerprints (routes that already posted are skipped by their
        // claims), so a failed send leaves the snapshot untouched.
        if (wantsMemberChanges(ports)) {
          const snapshot = snapshotOf(event);
          if (snapshot !== undefined) ports.saveMemberSnapshot(snapshot);
        } else {
          // No route wants member changes, so no record is kept: drop any
          // existing row the next time the member is seen (ADR 0123 decision 8).
          ports.deleteMemberSnapshot(event.userId);
        }
      }
      if (firstError !== undefined) throw firstError;
      return;
    }

    if (event.kind === 'memberRemove') {
      const firstError = await postItems(ports, logItemsFor(event), event.kind);
      // Unconditional: the leave line does not depend on the snapshot, so
      // deletion must not wait for the send — PRIVACY.md promises the record
      // is always deleted when the member leaves.
      ports.deleteMemberSnapshot(event.userId);
      if (firstError !== undefined) throw firstError;
      return;
    }

    const firstError = await postItems(ports, logItemsFor(event), event.kind);
    if (firstError !== undefined) throw firstError;
  },
});

/**
 * Posts one item through the same fan-out the subscriber uses (route
 * matching, per-route claims, no pings). Throws the first send error, if
 * any, after trying every route — the caller decides what that means.
 *
 * The `/mod warn` logging hook posts through this: a warning is the bot's
 * own action, not a gateway event, so there is no dispatch to handle.
 */
export function createLogPoster(ports: LoggingPorts): { post(item: LogItem): Promise<void> } {
  return {
    async post(item: LogItem): Promise<void> {
      const firstError = await postItems(ports, [item], item.eventKind);
      if (firstError !== undefined) throw firstError;
    },
  };
}

/**
 * `docs/19` §6.7's restated gate, generalised (ADR 0123 decision 5): a gap
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
      await ports.sendMessage(
        channelId,
        toOutgoingMessage(
          renderLogCard(
            formatGapMarker(event.disconnectedAtMs, event.receivedAtMs, event.receivedAtMs),
            ports.guildId,
          ),
        ),
      );
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

/**
 * Words for Discord's own AutoMod action on a log card. `NativeAutoModAction`
 * names the wire values (`block`, `alert`, `timeout`, `block_interaction`);
 * anything else Discord adds later renders as `Other`, never a raw code.
 */
const automodActionLabel = (action: NativeAutoModAction): string => {
  switch (action) {
    case 'block':
      return 'Blocked the message';
    case 'alert':
      return 'Sent an alert';
    case 'timeout':
      return 'Timed the member out';
    case 'block_interaction':
      return 'Blocked an interaction';
    default:
      return 'Other';
  }
};

/**
 * Short stable hash for a member-change fingerprint, the same primitive
 * `pipeline/fingerprint.ts` hashes with. The fingerprint must distinguish two
 * different changes from the same baseline version (A→B→A→B posts four lines)
 * while staying replay-stable for the identical event.
 */
const shortHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Data minimisation (ADR 0123 decision 8): the last-seen record is only kept
 * while some enabled route includes a member-change action. No route wants
 * member changes → no record kept.
 */
const wantsMemberChanges = (ports: LoggingPorts): boolean =>
  MEMBER_CHANGE_KINDS.some((kind) => ports.listEnabledRoutesFor(kind).length > 0);

/** The snapshot to store for this dispatch, when the adapter saw the member. */
const snapshotOf = (event: MemberEvent): MemberSnapshotLike | undefined => {
  const profile = event.profile;
  if (profile === undefined) return undefined;
  return {
    userId: event.userId,
    username: profile.username,
    globalName: profile.globalName,
    nickname: profile.nickname,
    avatarHash: profile.avatarHash,
    guildAvatarHash: profile.guildAvatarHash,
    roleIds: [...event.roleIds],
    updatedAtMs: event.receivedAtMs,
  };
};

/**
 * Fans log items out to every matching enabled route — one post per route,
 * each under its own claim, so one bad route never blocks another. Returns
 * the first send error, if any, so the caller can decide whether derived
 * state (the member snapshot) may be advanced.
 */
async function postItems(
  ports: LoggingPorts,
  items: readonly LogItem[],
  gatewayKind: string,
): Promise<Error | undefined> {
  let firstError: Error | undefined;
  for (const item of items) {
    if (isSourceExcluded(item.source, (id) => ports.isChannelExcluded(id))) continue;
    const routes = ports
      .listEnabledRoutesFor(item.eventKind)
      .filter((r) => routeAccepts(r, item.source));
    for (const route of routes) {
      const dedupeKind = routeDedupeKind(route.routeId, item.eventKind);
      if (!ports.claim({ eventKind: dedupeKind, fingerprint: item.fingerprint })) continue;
      try {
        await ports.sendMessage(
          route.channelId,
          toOutgoingMessage(renderLogCard(item.view(route.includeContent), ports.guildId)),
        );
      } catch (err) {
        // A transient send failure must not blackhole this line forever —
        // this module has no reconciliation to fall back on (ADR 0123
        // decision 6) — and must not stop the other routes either.
        ports.release({ eventKind: dedupeKind, fingerprint: item.fingerprint });
        ports.logger.error(
          safeLogFields({
            component: 'logging',
            guildId: ports.guildId,
            eventKind: gatewayKind,
            channelId: route.channelId,
            routeId: route.routeId,
            err,
          }),
          'failed to post a log line; released the claim for a future retry',
        );
        firstError ??= err instanceof Error ? err : new Error(String(err));
      }
    }
  }
  return firstError;
}
