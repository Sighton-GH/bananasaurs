import type { Snowflake } from '../discord/port.js';
import { createHash } from 'node:crypto';
import type { MemberEvent } from '../discord/events.js';
import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';
import type { Subscriber } from '../pipeline/pipeline.js';
import { fingerprintOf } from '../pipeline/fingerprint.js';
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
  formatMessageEdit,
  formatRoleCreate,
  formatRoleDelete,
  formatRoleUpdate,
} from './format.js';
import { MEMBER_CHANGE_KINDS, baselineFor, memberChanges } from './member-changes.js';
import type { MemberSnapshotLike } from './member-changes.js';

export type { LogRoute } from './routing.js';

/**
 * The logging module (ADR 0123): message edits and deletes, member
 * joins/leaves, and role create/update/delete. A deletion is not formatted
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
  sendMessage(
    channelId: Snowflake,
    message: { content: string; allowedMentions: { parse: readonly [] } },
  ): Promise<unknown>;
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
 * not mapped from one gateway kind) and `message_delete`, which is routed
 * here but handled by a delayed job rather than by the switch below
 * (ADR 0019 fact 3).
 *
 * Exported for `bananasaurs log routing create`, which validates against it. A
 * route on an event kind nothing emits is the exact failure WP4's report §5
 * named: the command succeeds, the listing looks configured, and nothing is
 * ever logged — an inert module and a working one look identical.
 */
export const LOG_EVENT_KINDS: readonly string[] = [
  ...Object.values(ROUTE_KIND),
  ...MEMBER_CHANGE_KINDS,
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

interface LogItem {
  eventKind: string; // a LOG_EVENT_KINDS value
  fingerprint: string; // replay-stable identity of this item
  source: LogSource | undefined; // undefined for events with no source channel
  render(includeContent: boolean): string;
}

type HandleEvent = Parameters<Subscriber['handle']>[0];

function logItemsFor(event: HandleEvent): LogItem[] {
  const routeKind = ROUTE_KIND[event.kind as keyof typeof ROUTE_KIND] as string | undefined;
  if (routeKind === undefined) return []; // everything else: not this module's job

  if (event.kind === 'messageCreate') {
    if (event.authorIsBot) return [];
    const source: LogSource = { channelId: event.channelId, parentChannelId: event.parentChannelId };
    const fingerprint =
      fingerprintFor(event) ??
      `${event.kind}:${event.receivedAtMs}:${event.messageId ?? 'none'}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source,
        render: (includeContent) =>
          `Message created in <#${event.channelId}> by ${event.authorId === undefined ? 'an unknown member' : `<@${event.authorId}>`}${includeContent && event.content !== undefined ? `\nContent: ${event.content}` : ''}`,
      },
    ];
  }

  if (event.kind === 'messageUpdate') {
    const source: LogSource = { channelId: event.channelId, parentChannelId: event.parentChannelId };
    const fingerprint =
      fingerprintFor(event) ??
      `${event.kind}:${event.receivedAtMs}:${event.messageId ?? 'none'}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source,
        render: (includeContent) => formatMessageEdit(event, includeContent),
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
        render: () => formatMemberJoin(event),
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
        render: () => formatMemberLeave(event),
      },
    ];
  }

  if (event.kind === 'roleCreate') {
    const fingerprint = fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.guildId}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source: undefined,
        render: () => formatRoleCreate(event),
      },
    ];
  }

  if (event.kind === 'roleUpdate') {
    const fingerprint = fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.guildId}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source: undefined,
        render: () => formatRoleUpdate(event),
      },
    ];
  }

  if (event.kind === 'roleDelete') {
    const fingerprint = fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.guildId}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source: undefined,
        render: () => formatRoleDelete(event),
      },
    ];
  }

  if (event.kind === 'guildCreate') {
    const fingerprint = fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.guildId}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source: undefined,
        render: () => 'Server became available to Bananasaurs.',
      },
    ];
  }

  if (event.kind === 'guildDelete') {
    const fingerprint = fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.guildId}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source: undefined,
        render: () => 'Server became unavailable to Bananasaurs.',
      },
    ];
  }

  if (event.kind === 'autoModerationAction') {
    const fingerprint = fingerprintFor(event) ?? `${event.kind}:${event.receivedAtMs}:${event.guildId}`;
    return [
      {
        eventKind: routeKind,
        fingerprint,
        source: undefined,
        render: () =>
          `Discord AutoMod action ${event.actionType} for <@${event.userId}> under rule ${event.ruleId}.`,
      },
    ];
  }

  throw new Error(`unreachable log event kind: ${event.kind}`);
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
      const source: LogSource = {
        channelId: event.channelId,
        parentChannelId: event.parentChannelId,
      };
      if (isSourceExcluded(source, ports.isChannelExcluded)) return;
      const routes = ports.listEnabledRoutesFor('message_delete').filter((r) => routeAccepts(r, source));
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
        const text = change.render();
        return {
          eventKind: change.eventKind,
          fingerprint: `${event.userId}:${change.eventKind}:${baseline.version}:${shortHash(text)}`,
          source: undefined,
          render: () => text,
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
      if (firstError === undefined) {
        // Deletion is always allowed, regardless of routes.
        ports.deleteMemberSnapshot(event.userId);
      }
      if (firstError !== undefined) throw firstError;
      return;
    }

    const firstError = await postItems(ports, logItemsFor(event), event.kind);
    if (firstError !== undefined) throw firstError;
  },
});

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
      await ports.sendMessage(channelId, {
        content: formatGapMarker(event.disconnectedAtMs, event.receivedAtMs),
        // Log lines quote member-controlled text; mentions in the content
        // must never ping anyone in the log channel.
        allowedMentions: { parse: [] },
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
): Promise<unknown> {
  let firstError: unknown;
  for (const item of items) {
    if (isSourceExcluded(item.source, ports.isChannelExcluded)) continue;
    const routes = ports
      .listEnabledRoutesFor(item.eventKind)
      .filter((r) => routeAccepts(r, item.source));
    for (const route of routes) {
      const dedupeKind = routeDedupeKind(route.routeId, item.eventKind);
      if (!ports.claim({ eventKind: dedupeKind, fingerprint: item.fingerprint })) continue;
      try {
        await ports.sendMessage(route.channelId, {
          content: item.render(route.includeContent),
          allowedMentions: { parse: [] },
        });
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
        if (firstError === undefined) firstError = err;
      }
    }
  }
  return firstError;
}
