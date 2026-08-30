import { and, desc, eq, sql } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { auditEvents, logExcludedChannels, logRoutes, messageDeleteRuns } from '../schema.js';

/**
 * Where a logged event kind goes, and which source channels never log.
 *
 * Read-only: nothing in Release 1 configures either table except the
 * operator CLI (`docs/19` slice 13, WP5), which does not exist yet. Tests
 * seed rows by inserting into the schema tables directly, the way
 * `write.test.ts` and `columns.test.ts` already do for tables with no writer.
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
