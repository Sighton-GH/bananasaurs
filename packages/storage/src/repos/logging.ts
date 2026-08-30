import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { auditEvents, logExcludedChannels, logRoutes, messageDeleteRuns } from '../schema.js';

/**
 * Where a logged event kind goes, and which source channels never log.
 *
 * WP4 shipped this read-only, with the note that nothing in Release 1
 * configured either table except a future operator CLI. That CLI is WP5
 * slice 13, and `log routing list` (13c) and `log routing set` (13d) are its
 * commands — so the listing reads below join the lookup reads above, and the
 * writers arrive with them.
 */

export interface LogRoute {
  guildId: string;
  eventKind: string;
  channelId: string;
  includeContent: boolean;
  enabled: boolean;
}

/** Undefined means "nobody configured this event kind" — treat as disabled. */
export const findRoute = (scope: GuildScope, eventKind: string): LogRoute | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(logRoutes)
      .where(scope.only(logRoutes, eq(logRoutes.eventKind, eventKind)))
      .get();
    if (!row) return undefined;
    return {
      guildId: row.guildId,
      eventKind: row.eventKind,
      channelId: row.channelId,
      includeContent: row.includeContent === 1,
      enabled: row.enabled === 1,
    };
  });

/**
 * Every distinct channel currently enabled for at least one event kind.
 *
 * For the gap marker (ADR 0023 decision 5): a channel routed under two event
 * kinds gets one marker, not two.
 */
export const listEnabledLogChannels = (scope: GuildScope): string[] =>
  read(scope, (db) => {
    const rows = db
      .selectDistinct({ channelId: logRoutes.channelId })
      .from(logRoutes)
      .where(scope.only(logRoutes, eq(logRoutes.enabled, 1)))
      .all();
    return rows.map((r) => r.channelId);
  });

/**
 * Every configured route, for `bananasaurs log routing list`.
 *
 * Ordered by event kind so two runs of the command are comparable — a listing
 * whose order depends on insertion is one an operator cannot diff.
 */
export const listRoutes = (scope: GuildScope): LogRoute[] =>
  read(scope, (db) =>
    db
      .select()
      .from(logRoutes)
      .where(scope.only(logRoutes))
      .orderBy(asc(logRoutes.eventKind))
      .all()
      .map((row) => ({
        guildId: row.guildId,
        eventKind: row.eventKind,
        channelId: row.channelId,
        includeContent: row.includeContent === 1,
        enabled: row.enabled === 1,
      })),
  );

/** Every excluded source channel, for `bananasaurs log routing list`. */
export const listExcludedChannels = (scope: GuildScope): string[] =>
  read(scope, (db) =>
    db
      .select({ channelId: logExcludedChannels.channelId })
      .from(logExcludedChannels)
      .where(scope.only(logExcludedChannels))
      .orderBy(asc(logExcludedChannels.channelId))
      .all()
      .map((r) => r.channelId),
  );

/** True when this source channel must never be logged from, whatever the routes say. */
export const isChannelExcluded = (scope: GuildScope, channelId: string): boolean =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(logExcludedChannels)
      .where(scope.only(logExcludedChannels, eq(logExcludedChannels.channelId, channelId)))
      .get();
    return row !== undefined;
  });

export interface DeletionRunKey {
  actorUserId: string;
  authorId: string;
  channelId: string;
}

const runMatch = (t: typeof messageDeleteRuns, key: DeletionRunKey) =>
  and(
    eq(t.actorUserId, key.actorUserId),
    eq(t.authorId, key.authorId),
    eq(t.channelId, key.channelId),
  );

/** How much of this run's live count this module has already attributed. Defaults to 0. */
export const claimedCountFor = (scope: GuildScope, key: DeletionRunKey): number =>
  read(scope, (db) => {
    const row = db
      .select({ claimedCount: messageDeleteRuns.claimedCount })
      .from(messageDeleteRuns)
      .where(scope.only(messageDeleteRuns, runMatch(messageDeleteRuns, key)))
      .get();
    return row?.claimedCount ?? 0;
  });

/**
 * Claims exactly one more unit of this run's count (ADR 0023 decision 3): not
 * the whole visible delta, so a burst of N deletions by the same actor — each
 * its own job — each independently sees an unclaimed increment regardless of
 * execution order.
 */
export const incrementClaimedCount = (scope: GuildScope, key: DeletionRunKey): void =>
  write(scope, ({ db }) => {
    db.insert(messageDeleteRuns)
      .values({
        guildId: scope.guildId,
        actorUserId: key.actorUserId,
        authorId: key.authorId,
        channelId: key.channelId,
        claimedCount: 1,
      })
      .onConflictDoUpdate({
        target: [
          messageDeleteRuns.guildId,
          messageDeleteRuns.actorUserId,
          messageDeleteRuns.authorId,
          messageDeleteRuns.channelId,
        ],
        set: { claimedCount: sql`${messageDeleteRuns.claimedCount} + 1` },
      })
      .run();
  });

export interface MessageDeleteAttribution {
  actorId: string | undefined;
  inferred: boolean;
}

/**
 * The already-recorded outcome for a message's deletion, if one exists.
 *
 * Read before resolving a fresh attribution (the job handler's own
 * idempotency): a retry after a failed Discord send must reuse what was
 * already decided rather than re-consulting the audit log, which could see a
 * different, contradictory answer the second time (ADR 0023 decision 3's
 * cursor advances on a successful resolution, so a naive re-resolve after
 * one already succeeded would find its own increment already claimed and
 * wrongly downgrade to "unknown").
 */
export const findMessageDeleteAttribution = (
  scope: GuildScope,
  messageId: string,
): MessageDeleteAttribution | undefined =>
  read(scope, (db) => {
    const row = db
      .select({ actorId: auditEvents.actorId, inferred: auditEvents.inferred })
      .from(auditEvents)
      .where(
        scope.only(
          auditEvents,
          and(eq(auditEvents.action, 'message_delete'), eq(auditEvents.subjectId, messageId)),
        ),
      )
      .orderBy(desc(auditEvents.auditId))
      .get();
    if (!row) return undefined;
    return { actorId: row.actorId ?? undefined, inferred: row.inferred === 1 };
  });
