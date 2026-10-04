import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import type { Db } from '../db.js';
import { read, write } from '../write.js';
import {
  auditEvents,
  logExcludedChannels,
  logMemberSnapshots,
  logRouteEvents,
  logRouteExclusions,
  logRoutes,
  messageDeleteRuns,
} from '../schema.js';

/**
 * Named logging routes (ADR 0123 decisions 1-3 and 8).
 *
 * A route is a row with its own random-UUID id; its event kinds and its
 * per-route excluded source channels are child rows. One event kind may
 * appear in several routes, and each route is de-duplicated separately
 * downstream (the claim namespace is `log:r<route_id>:<event_kind>`).
 *
 * The guild-wide exclusion list (`log_excluded_channels`) is separate and
 * owned by Permissions: if a channel is on it, nothing is logged from it by
 * any route. The writers below never touch it; `excludeChannel` /
 * `unexcludeChannel` stay because `log routing exclude | unexclude` edit that
 * list.
 */

export interface LogRoute {
  guildId: string;
  routeId: string;
  name: string;
  channelId: string;
  includeContent: boolean;
  enabled: boolean;
  createdAtMs: number;
  /** Sorted ascending, no duplicates. */
  eventKinds: string[];
  /** Sorted ascending, no duplicates. */
  excludedChannelIds: string[];
}

export interface LogRouteInput {
  name: string;
  channelId: string;
  includeContent: boolean;
  enabled: boolean;
  /** Duplicates collapse. */
  eventKinds: readonly string[];
  /** Duplicates collapse. */
  excludedChannelIds: readonly string[];
}

/** Sorted ascending, de-duplicated. Event kinds are not validated here — the API boundary does that, against core's `LOG_EVENT_KINDS`. */
const normalizeList = (values: readonly string[]): string[] => [...new Set(values)].sort();

type LogRouteRow = typeof logRoutes.$inferSelect;

const assembleRoute = (
  guildId: string,
  row: LogRouteRow,
  kindsByRoute: Map<string, string[]>,
  exclusionsByRoute: Map<string, string[]>,
): LogRoute => ({
  guildId,
  routeId: row.routeId,
  name: row.name,
  channelId: row.channelId,
  includeContent: row.includeContent === 1,
  enabled: row.enabled === 1,
  createdAtMs: row.createdAtMs,
  eventKinds: kindsByRoute.get(row.routeId) ?? [],
  excludedChannelIds: exclusionsByRoute.get(row.routeId) ?? [],
});

const groupChildren = (rows: { routeId: string; value: string }[]): Map<string, string[]> => {
  const byRoute = new Map<string, Set<string>>();
  for (const row of rows) {
    let set = byRoute.get(row.routeId);
    if (!set) {
      set = new Set();
      byRoute.set(row.routeId, set);
    }
    set.add(row.value);
  }
  return new Map([...byRoute].map(([routeId, set]) => [routeId, [...set].sort()]));
};

const loadRouteMap = (db: Db, scope: GuildScope): Map<string, LogRoute> => {
  const parents = db
    .select()
    .from(logRoutes)
    .where(scope.only(logRoutes))
    .orderBy(asc(logRoutes.createdAtMs), asc(logRoutes.routeId))
    .all();
  const kindsByRoute = groupChildren(
    db
      .select({ routeId: logRouteEvents.routeId, value: logRouteEvents.eventKind })
      .from(logRouteEvents)
      .where(scope.only(logRouteEvents))
      .all(),
  );
  const exclusionsByRoute = groupChildren(
    db
      .select({ routeId: logRouteExclusions.routeId, value: logRouteExclusions.channelId })
      .from(logRouteExclusions)
      .where(scope.only(logRouteExclusions))
      .all(),
  );
  return new Map(
    parents.map((row) => [
      row.routeId,
      assembleRoute(scope.guildId, row, kindsByRoute, exclusionsByRoute),
    ]),
  );
};

/** Creates a route with a fresh randomUUID() id; returns it as getRoute would. */
export const createRoute = (
  scope: GuildScope,
  input: LogRouteInput & { nowMs: number },
): LogRoute =>
  write(scope, ({ db }) => {
    const routeId = randomUUID();
    db.insert(logRoutes)
      .values({
        guildId: scope.guildId,
        routeId,
        name: input.name,
        channelId: input.channelId,
        includeContent: input.includeContent ? 1 : 0,
        enabled: input.enabled ? 1 : 0,
        createdAtMs: input.nowMs,
      })
      .run();
    const eventKinds = normalizeList(input.eventKinds);
    if (eventKinds.length > 0) {
      db.insert(logRouteEvents)
        .values(eventKinds.map((eventKind) => ({ guildId: scope.guildId, routeId, eventKind })))
        .run();
    }
    const excludedChannelIds = normalizeList(input.excludedChannelIds);
    if (excludedChannelIds.length > 0) {
      db.insert(logRouteExclusions)
        .values(
          excludedChannelIds.map((channelId) => ({ guildId: scope.guildId, routeId, channelId })),
        )
        .run();
    }
    const created = loadRouteMap(db, scope).get(routeId);
    if (!created) throw new Error('log route insert did not persist');
    return created;
  });

/**
 * Replaces every field and both child lists in one write(); undefined if no
 * such route in this guild. createdAtMs unchanged.
 */
export const updateRoute = (
  scope: GuildScope,
  routeId: string,
  input: LogRouteInput,
): LogRoute | undefined =>
  write(scope, ({ db }) => {
    const existing = db
      .select()
      .from(logRoutes)
      .where(scope.only(logRoutes, eq(logRoutes.routeId, routeId)))
      .get();
    if (!existing) return undefined;
    db.update(logRoutes)
      .set({
        name: input.name,
        channelId: input.channelId,
        includeContent: input.includeContent ? 1 : 0,
        enabled: input.enabled ? 1 : 0,
      })
      .where(scope.only(logRoutes, eq(logRoutes.routeId, routeId)))
      .run();
    db.delete(logRouteEvents)
      .where(scope.only(logRouteEvents, eq(logRouteEvents.routeId, routeId)))
      .run();
    db.delete(logRouteExclusions)
      .where(scope.only(logRouteExclusions, eq(logRouteExclusions.routeId, routeId)))
      .run();
    const eventKinds = normalizeList(input.eventKinds);
    if (eventKinds.length > 0) {
      db.insert(logRouteEvents)
        .values(eventKinds.map((eventKind) => ({ guildId: scope.guildId, routeId, eventKind })))
        .run();
    }
    const excludedChannelIds = normalizeList(input.excludedChannelIds);
    if (excludedChannelIds.length > 0) {
      db.insert(logRouteExclusions)
        .values(
          excludedChannelIds.map((channelId) => ({ guildId: scope.guildId, routeId, channelId })),
        )
        .run();
    }
    return loadRouteMap(db, scope).get(routeId);
  });

/** Returns whether a route existed to change. */
export const setRouteEnabled = (scope: GuildScope, routeId: string, enabled: boolean): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .update(logRoutes)
      .set({ enabled: enabled ? 1 : 0 })
      .where(scope.only(logRoutes, eq(logRoutes.routeId, routeId)))
      .run();
    return result.changes > 0;
  });

/** Deletes the route; child rows go by ON DELETE CASCADE. Returns whether it existed. */
export const deleteRoute = (scope: GuildScope, routeId: string): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .delete(logRoutes)
      .where(scope.only(logRoutes, eq(logRoutes.routeId, routeId)))
      .run();
    return result.changes > 0;
  });

export const getRoute = (scope: GuildScope, routeId: string): LogRoute | undefined =>
  read(scope, (db) => loadRouteMap(db, scope).get(routeId));

/** Every route, ordered by createdAtMs then routeId. */
export const listRoutes = (scope: GuildScope): LogRoute[] =>
  read(scope, (db) => [...loadRouteMap(db, scope).values()]);

/** Enabled routes whose event kinds include `eventKind`, ordered by createdAtMs then routeId. */
export const listEnabledRoutesFor = (scope: GuildScope, eventKind: string): LogRoute[] =>
  read(scope, (db) =>
    [...loadRouteMap(db, scope).values()].filter(
      (route) => route.enabled && route.eventKinds.includes(eventKind),
    ),
  );

/**
 * Every distinct destination channel of enabled routes, sorted.
 *
 * For the gap marker (ADR 0023 decision 5): a channel routed under two routes
 * gets one marker, not two.
 */
export const listEnabledLogChannels = (scope: GuildScope): string[] =>
  read(scope, (db) => {
    const rows = db
      .selectDistinct({ channelId: logRoutes.channelId })
      .from(logRoutes)
      .where(scope.only(logRoutes, eq(logRoutes.enabled, 1)))
      .orderBy(asc(logRoutes.channelId))
      .all();
    return rows.map((r) => r.channelId);
  });

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

export interface MemberSnapshot {
  userId: string;
  username: string;
  globalName: string | undefined;
  nickname: string | undefined;
  avatarHash: string | undefined;
  guildAvatarHash: string | undefined;
  /** Sorted. */
  roleIds: string[];
  updatedAtMs: number;
}

/** JSON read back is still untrusted: if it is not an array of strings, return []. */
const parseRoleIds = (raw: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || !parsed.every((v): v is string => typeof v === 'string')) return [];
  return [...parsed].sort();
};

export const getMemberSnapshot = (scope: GuildScope, userId: string): MemberSnapshot | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(logMemberSnapshots)
      .where(scope.only(logMemberSnapshots, eq(logMemberSnapshots.userId, userId)))
      .get();
    if (!row) return undefined;
    return {
      userId: row.userId,
      username: row.username,
      globalName: row.globalName ?? undefined,
      nickname: row.nickname ?? undefined,
      avatarHash: row.avatarHash ?? undefined,
      guildAvatarHash: row.guildAvatarHash ?? undefined,
      roleIds: parseRoleIds(row.roleIds),
      updatedAtMs: row.updatedAtMs,
    };
  });

/** Insert or replace this member's row. Stores roleIds sorted as JSON. */
export const upsertMemberSnapshot = (scope: GuildScope, snapshot: MemberSnapshot): void =>
  write(scope, ({ db }) => {
    db.insert(logMemberSnapshots)
      .values({
        guildId: scope.guildId,
        userId: snapshot.userId,
        username: snapshot.username,
        globalName: snapshot.globalName ?? null,
        nickname: snapshot.nickname ?? null,
        avatarHash: snapshot.avatarHash ?? null,
        guildAvatarHash: snapshot.guildAvatarHash ?? null,
        roleIds: JSON.stringify([...snapshot.roleIds].sort()),
        updatedAtMs: snapshot.updatedAtMs,
      })
      .onConflictDoUpdate({
        target: [logMemberSnapshots.guildId, logMemberSnapshots.userId],
        set: {
          username: snapshot.username,
          globalName: snapshot.globalName ?? null,
          nickname: snapshot.nickname ?? null,
          avatarHash: snapshot.avatarHash ?? null,
          guildAvatarHash: snapshot.guildAvatarHash ?? null,
          roleIds: JSON.stringify([...snapshot.roleIds].sort()),
          updatedAtMs: snapshot.updatedAtMs,
        },
      })
      .run();
  });

/** Returns whether a row existed. */
export const deleteMemberSnapshot = (scope: GuildScope, userId: string): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .delete(logMemberSnapshots)
      .where(scope.only(logMemberSnapshots, eq(logMemberSnapshots.userId, userId)))
      .run();
    return result.changes > 0;
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
