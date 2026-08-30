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

// --- writers (WP5 slice 13d) -------------------------------------------------

export interface SetRouteInput {
  eventKind: string;
  channelId: string;
  /**
   * Whether the rendered log line may quote the message.
   *
   * A per-route decision rather than a global one: an operator can log that a
   * message was deleted in #general without reproducing its text, which is the
   * distinction ADR 0023 draws between recording an event and republishing
   * content.
   */
  includeContent: boolean;
}

/**
 * Points an event kind at a channel, creating the route or re-pointing it.
 *
 * Upsert rather than insert-or-fail. The primary key is `(guild_id,
 * event_kind)`, so "route member joins to #logs" is a statement about one row
 * whatever its history — and an operator re-running the command after a dropped
 * SSH connection must not get a constraint error for saying the same thing
 * twice (`CLAUDE.md` rule 6, applied to configuration rather than to effects).
 *
 * It also re-enables: `log routing off` disables rather than deletes, so that
 * turning logging back on does not require remembering the channel id, and
 * `set` is what turns it back on.
 */
export const setRoute = (scope: GuildScope, input: SetRouteInput): void =>
  write(scope, ({ db }) => {
    db.insert(logRoutes)
      .values({
        guildId: scope.guildId,
        eventKind: input.eventKind,
        channelId: input.channelId,
        includeContent: input.includeContent ? 1 : 0,
        enabled: 1,
      })
      .onConflictDoUpdate({
        target: [logRoutes.guildId, logRoutes.eventKind],
        set: {
          channelId: input.channelId,
          includeContent: input.includeContent ? 1 : 0,
          enabled: 1,
        },
      })
      .run();
  });

/**
 * Turns a route on or off, keeping the channel.
 *
 * Returns whether a route existed to change. False is not a failure — it is the
 * difference between "logging stopped" and "you named an event kind that was
 * never routed", and an operator told the first when the second is true will
 * believe they have stopped logging something that is still being logged.
 */
export const setRouteEnabled = (scope: GuildScope, eventKind: string, enabled: boolean): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .update(logRoutes)
      .set({ enabled: enabled ? 1 : 0 })
      .where(scope.only(logRoutes, eq(logRoutes.eventKind, eventKind)))
      .run();
    return result.changes > 0;
  });

/**
 * Marks a source channel as never logged from. Returns whether it was new.
 *
 * `onConflictDoNothing` rather than a pre-read: the unique constraint is the
 * check, and a read-then-insert would be two statements where one will do.
 */
export const excludeChannel = (scope: GuildScope, channelId: string): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .insert(logExcludedChannels)
      .values({ guildId: scope.guildId, channelId })
      .onConflictDoNothing()
      .run();
    return result.changes > 0;
  });

/** Removes an exclusion. Returns whether there was one. */
export const unexcludeChannel = (scope: GuildScope, channelId: string): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .delete(logExcludedChannels)
      .where(scope.only(logExcludedChannels, eq(logExcludedChannels.channelId, channelId)))
      .run();
    return result.changes > 0;
  });
