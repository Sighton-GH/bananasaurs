import { and, asc, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { AssistantBehaviour, ClubResource, Reminder, ReminderStatus } from '@bananasaurs/core';
import {
  assistantBehaviours,
  assistantReminders,
  assistantResources,
  assistantSkillActivity,
  assistantSkillGrants,
  assistantTickets,
  assistantDecisions,
} from '../schema.js';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';

const array = (raw: string): readonly string[] => {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    throw new Error('assistant list column is invalid');
  return value;
};
const toBehaviour = (r: typeof assistantBehaviours.$inferSelect): AssistantBehaviour => ({
  id: r.behaviourId,
  guildId: r.guildId,
  surface: r.surface as AssistantBehaviour['surface'],
  ...(r.mentionRoleId === null ? {} : { mentionRoleId: r.mentionRoleId }),
  name: r.name,
  systemPrompt: r.systemPrompt,
  promptVersion: r.promptVersion,
  allowedSkillIds: array(r.skillIdsJson),
  callerRoleIds: array(r.callerRoleIdsJson),
  ...(r.ticketChannelId === null ? {} : { ticketChannelId: r.ticketChannelId }),
  reviewerRoleIds: array(r.reviewerRoleIdsJson),
  resourceIds: array(r.resourceIdsJson),
  enabled: r.enabled === 1,
});
export const listBehaviours = (scope: GuildScope): readonly AssistantBehaviour[] =>
  read(scope, (db) =>
    db
      .select()
      .from(assistantBehaviours)
      .where(scope.only(assistantBehaviours))
      .orderBy(asc(assistantBehaviours.name))
      .all()
      .map(toBehaviour),
  );
export const putBehaviour = (scope: GuildScope, input: AssistantBehaviour, now: number): void =>
  write(scope, ({ db }) => {
    db.insert(assistantBehaviours)
      .values({
        guildId: scope.guildId,
        behaviourId: input.id,
        surface: input.surface,
        // Drizzle's update builder drops `undefined` from a set clause, which
        // turned "cleared" into "unchanged" (the stale channel kept routing
        // while the UI said fails-closed). Nullable columns, so normalise to
        // NULL here: a saved behaviour without the value means cleared.
        mentionRoleId: input.mentionRoleId ?? null,
        name: input.name,
        systemPrompt: input.systemPrompt,
        promptVersion: input.promptVersion,
        enabled: input.enabled ? 1 : 0,
        skillIdsJson: JSON.stringify(input.allowedSkillIds),
        callerRoleIdsJson: JSON.stringify(input.callerRoleIds),
        ticketChannelId: input.ticketChannelId ?? null,
        reviewerRoleIdsJson: JSON.stringify(input.reviewerRoleIds),
        resourceIdsJson: JSON.stringify(input.resourceIds),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [assistantBehaviours.guildId, assistantBehaviours.behaviourId],
        set: {
          surface: input.surface,
          mentionRoleId: input.mentionRoleId ?? null,
          name: input.name,
          systemPrompt: input.systemPrompt,
          promptVersion: input.promptVersion,
          enabled: input.enabled ? 1 : 0,
          skillIdsJson: JSON.stringify(input.allowedSkillIds),
          callerRoleIdsJson: JSON.stringify(input.callerRoleIds),
          ticketChannelId: input.ticketChannelId ?? null,
          reviewerRoleIdsJson: JSON.stringify(input.reviewerRoleIds),
          resourceIdsJson: JSON.stringify(input.resourceIds),
          updatedAt: now,
        },
      })
      .run();
  });
const toResource = (r: typeof assistantResources.$inferSelect): ClubResource => ({
  id: r.resourceId,
  guildId: r.guildId,
  title: r.title,
  url: r.url,
  kind: r.kind as ClubResource['kind'],
  enabled: r.enabled === 1,
  reviewedAt: new Date(r.reviewedAt).toISOString(),
  ...(r.lastFetchedAt === null ? {} : { lastFetchedAt: r.lastFetchedAt }),
  fetchStatus: r.fetchStatus as 'pending' | 'ok' | 'failed' | 'blocked',
  ...(r.content === null ? {} : { fetchDetail: r.content }),
});
export const listResources = (scope: GuildScope): readonly ClubResource[] =>
  read(scope, (db) =>
    db
      .select()
      .from(assistantResources)
      .where(scope.only(assistantResources))
      .orderBy(asc(assistantResources.title))
      .all()
      .map(toResource),
  );
export const putResource = (scope: GuildScope, input: ClubResource): void =>
  write(scope, ({ db }) => {
    db.insert(assistantResources)
      .values({
        guildId: scope.guildId,
        resourceId: input.id,
        title: input.title,
        url: input.url,
        kind: input.kind,
        enabled: input.enabled ? 1 : 0,
        reviewedAt: Date.parse(input.reviewedAt),
      })
      .onConflictDoUpdate({
        target: [assistantResources.guildId, assistantResources.resourceId],
        set: {
          title: input.title,
          url: input.url,
          kind: input.kind,
          enabled: input.enabled ? 1 : 0,
          reviewedAt: Date.parse(input.reviewedAt),
        },
      })
      .run();
  });
export const recordResourceFetch = (
  scope: GuildScope,
  id: string,
  input: {
    readonly status: 'ok' | 'failed' | 'blocked';
    readonly at: number;
    readonly detail: string;
  },
): void =>
  write(scope, ({ db }) => {
    db.update(assistantResources)
      .set({
        lastFetchedAt: input.at,
        fetchStatus: input.status,
        content: input.detail.slice(0, 500),
      })
      .where(scope.only(assistantResources, eq(assistantResources.resourceId, id)))
      .run();
  });
export interface StoredReminder extends Reminder {
  readonly failureReason?: string;
  /** Next scheduled attempt after a transient failure; undefined when none is pending. */
  readonly nextAttemptAt?: number;
  /** When the current delivery pass claimed the row; undefined before any claim. */
  readonly claimedAt?: number;
}
const toReminder = (r: typeof assistantReminders.$inferSelect): StoredReminder => ({
  id: r.reminderId,
  guildId: r.guildId,
  creatorId: r.creatorId,
  destinationId: r.destinationId,
  text: r.text,
  dueAt: r.dueAt,
  createdAt: r.createdAt,
  status: r.status as ReminderStatus,
  dedupeKey: r.dedupeKey,
  ...(r.failureReason === null ? {} : { failureReason: r.failureReason }),
  ...(r.nextAttemptAt === null ? {} : { nextAttemptAt: r.nextAttemptAt }),
  ...(r.claimedAt === null ? {} : { claimedAt: r.claimedAt }),
});
export const listReminders = (scope: GuildScope): readonly StoredReminder[] =>
  read(scope, (db) =>
    db
      .select()
      .from(assistantReminders)
      .where(scope.only(assistantReminders))
      .orderBy(asc(assistantReminders.dueAt))
      .all()
      .map(toReminder),
  );
/**
 * Creates a reminder, or reports the dedupe-key duplicate without throwing.
 *
 * The result is typed at the repo boundary: callers distinguish the benign
 * idempotency replay from real write failures (disk, schema, FK) without
 * matching on a driver's error message (independent audit, round 2).
 */
export type InsertReminderResult = 'created' | 'duplicate';

export const insertReminder = (scope: GuildScope, r: Reminder): InsertReminderResult =>
  write(scope, ({ db }) => {
    const inserted = db
      .insert(assistantReminders)
      .values({
        guildId: scope.guildId,
        reminderId: r.id,
        creatorId: r.creatorId,
        destinationId: r.destinationId,
        text: r.text,
        dueAt: r.dueAt,
        createdAt: r.createdAt,
        status: r.status,
        dedupeKey: r.dedupeKey,
      })
      // Exactly the dedupe constraint, named - any other constraint failure
      // still throws out of `write()`.
      .onConflictDoNothing({ target: [assistantReminders.guildId, assistantReminders.dedupeKey] })
      .run().changes;
    return inserted === 0 ? 'duplicate' : 'created';
  });

/**
 * Claims due reminders for one delivery pass.
 *
 * Select-then-update inside one `write()` — better-sqlite3 is synchronous and
 * `write()` forbids an await, so nothing interleaves between the read and the
 * claim, the same argument `jobRepo.claimNext` makes. Every transition in this
 * file names the status it expects, so two passes racing the same row see one
 * winner: the loser's `UPDATE` matches zero rows.
 *
 * Two claim sources, in due order:
 *
 * - `scheduled` rows at or past their due time.
 * - `delivering` rows whose claim is at least `staleMs` old. Staleness is
 *   measured off `claimed_at` (the claim stamps it; `due_at` keeps the
 *   original due time), and a `delivering` row is never re-claimed before
 *   the explicit threshold. Per-guild passes are serial (one
 *   `deliver_reminders` job at a time under the dedupe index, one worker
 *   draining it), so a row still younger than the threshold belongs to a
 *   pass that is running right now and must be left alone.
 *
 * The returned rows keep the original `dueAt`; the claim time is stamped in
 * `claimedAt`, matching what a re-read would return.
 */
/**
 * A cheap existence check for the delivery timer: is there anything a pass
 * would claim right now? Without it the timer enqueues one empty job per
 * guild every thirty seconds around the clock (should-fix). Same predicate
 * as `claimDueReminders` — due `scheduled` rows, or `delivering` rows whose
 * claim went stale — but one `LIMIT 1` read and no write.
 */
export const hasDeliverableReminders = (scope: GuildScope, now: number, staleMs: number): boolean =>
  read(scope, (db) => {
    const due = db
      .select({ reminderId: assistantReminders.reminderId })
      .from(assistantReminders)
      .where(
        scope.only(
          assistantReminders,
          eq(assistantReminders.status, 'scheduled'),
          or(
            lte(assistantReminders.nextAttemptAt, now),
            and(isNull(assistantReminders.nextAttemptAt), lte(assistantReminders.dueAt, now)),
          ),
        ),
      )
      .limit(1)
      .all();
    if (due.length > 0) return true;
    const stranded = db
      .select({ reminderId: assistantReminders.reminderId })
      .from(assistantReminders)
      .where(
        scope.only(
          assistantReminders,
          eq(assistantReminders.status, 'delivering'),
          lte(assistantReminders.claimedAt, now - staleMs),
        ),
      )
      .limit(1)
      .all();
    return stranded.length > 0;
  });

export const claimDueReminders = (
  scope: GuildScope,
  now: number,
  limit: number,
  staleMs: number,
): StoredReminder[] =>
  write(scope, ({ db }) => {
    const due = db
      .select()
      .from(assistantReminders)
      .where(
        scope.only(
          assistantReminders,
          eq(assistantReminders.status, 'scheduled'),
          // Due when the next attempt time (falling back to the original due
          // time) has arrived; due_at itself never moves.
          or(
            lte(assistantReminders.nextAttemptAt, now),
            and(isNull(assistantReminders.nextAttemptAt), lte(assistantReminders.dueAt, now)),
          ),
        ),
      )
      .orderBy(asc(assistantReminders.dueAt), asc(assistantReminders.reminderId))
      .limit(limit)
      .all();
    const stranded =
      due.length >= limit
        ? []
        : db
            .select()
            .from(assistantReminders)
            .where(
              scope.only(
                assistantReminders,
                eq(assistantReminders.status, 'delivering'),
                lte(assistantReminders.claimedAt, now - staleMs),
              ),
            )
            .orderBy(asc(assistantReminders.dueAt), asc(assistantReminders.reminderId))
            .limit(limit - due.length)
            .all();
    const rows = [...due, ...stranded];
    if (rows.length === 0) return [];
    db.update(assistantReminders)
      .set({ status: 'delivering', claimedAt: now })
      .where(
        scope.only(
          assistantReminders,
          inArray(
            assistantReminders.reminderId,
            rows.map((r) => r.reminderId),
          ),
          inArray(assistantReminders.status, ['scheduled', 'delivering']),
        ),
      )
      .run();
    return rows.map((r) => toReminder({ ...r, status: 'delivering', claimedAt: now }));
  });

/**
 * A state-guarded transition: the `WHERE` names the one status the row must
 * be in, and zero changed rows means some other pass moved it first — thrown,
 * because silently "succeeding" would hide a double-delivery bug exactly the
 * way an unguarded update would.
 */
const transitionReminder = (
  scope: GuildScope,
  id: string,
  from: ReminderStatus,
  set: {
    status?: ReminderStatus | undefined;
    failureReason?: string | null | undefined;
    nextAttemptAt?: number | null | undefined;
    claimedAt?: number | null | undefined;
  },
): void =>
  write(scope, ({ db }) => {
    const result = db
      .update(assistantReminders)
      .set(set)
      .where(
        scope.only(
          assistantReminders,
          eq(assistantReminders.reminderId, id),
          eq(assistantReminders.status, from),
        ),
      )
      .run();
    if (result.changes !== 1)
      throw new Error(`reminder ${id} is not ${from}; transition ${set.status ?? ''} refused`);
  });

export const completeReminder = (scope: GuildScope, id: string): void =>
  transitionReminder(scope, id, 'delivering', { status: 'delivered', failureReason: null });

export const failReminder = (scope: GuildScope, id: string, reason: string): void =>
  transitionReminder(scope, id, 'delivering', { status: 'failed', failureReason: reason });

export const retryReminder = (
  scope: GuildScope,
  id: string,
  reason: string,
  retryAt: number,
): void =>
  transitionReminder(scope, id, 'delivering', {
    status: 'scheduled',
    failureReason: reason,
    nextAttemptAt: retryAt,
    claimedAt: null,
  });

/**
 * Cancels a reminder that has not been claimed yet. Returns false for a row
 * in any other state — cancelling a reminder mid-send is not a thing this
 * store can do, and a false tells the caller exactly that.
 */
export const cancelReminder = (scope: GuildScope, id: string): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .update(assistantReminders)
      .set({ status: 'cancelled' })
      .where(
        scope.only(
          assistantReminders,
          eq(assistantReminders.reminderId, id),
          eq(assistantReminders.status, 'scheduled'),
        ),
      )
      .run();
    return result.changes === 1;
  });
export interface SkillActivity {
  readonly id: string;
  readonly at: number;
  readonly behaviourId: string;
  readonly skillId: string;
  readonly actorId: string;
  readonly outcome: string;
  readonly detail?: string;
}
export const listSkillActivity = (scope: GuildScope, limit = 100): readonly SkillActivity[] =>
  read(scope, (db) =>
    db
      .select()
      .from(assistantSkillActivity)
      .where(scope.only(assistantSkillActivity))
      .orderBy(desc(assistantSkillActivity.at))
      .limit(limit)
      .all()
      .map((r) => ({
        id: r.activityId,
        at: r.at,
        behaviourId: r.behaviourId,
        skillId: r.skillId,
        actorId: r.actorId,
        outcome: r.outcome,
        ...(r.detail === null ? {} : { detail: r.detail }),
      })),
  );
export const recordSkillActivity = (scope: GuildScope, a: SkillActivity): void =>
  write(scope, ({ db }) => {
    db.insert(assistantSkillActivity)
      .values({
        guildId: scope.guildId,
        activityId: a.id,
        at: a.at,
        behaviourId: a.behaviourId,
        skillId: a.skillId,
        actorId: a.actorId,
        outcome: a.outcome,
        detail: a.detail,
      })
      .run();
  });

export interface AssistantSkillGrant {
  readonly skillId: string;
  readonly roleIds: readonly string[];
  readonly userIds: readonly string[];
}
export const listSkillGrants = (scope: GuildScope): readonly AssistantSkillGrant[] =>
  read(scope, (db) =>
    db
      .select()
      .from(assistantSkillGrants)
      .where(scope.only(assistantSkillGrants))
      .orderBy(asc(assistantSkillGrants.skillId))
      .all()
      .map((r) => ({
        skillId: r.skillId,
        roleIds: array(r.roleIdsJson),
        userIds: array(r.userIdsJson),
      })),
  );
export const putSkillGrant = (scope: GuildScope, input: AssistantSkillGrant, now: number): void =>
  write(scope, ({ db }) => {
    db.insert(assistantSkillGrants)
      .values({
        guildId: scope.guildId,
        skillId: input.skillId,
        roleIdsJson: JSON.stringify(input.roleIds),
        userIdsJson: JSON.stringify(input.userIds),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [assistantSkillGrants.guildId, assistantSkillGrants.skillId],
        set: {
          roleIdsJson: JSON.stringify(input.roleIds),
          userIdsJson: JSON.stringify(input.userIds),
          updatedAt: now,
        },
      })
      .run();
  });
export const listTickets = (scope: GuildScope) =>
  read(scope, (db) =>
    db
      .select()
      .from(assistantTickets)
      .where(scope.only(assistantTickets))
      .orderBy(desc(assistantTickets.createdAt))
      .all()
      .map((r) => ({
        id: r.ticketId,
        behaviourId: r.behaviourId,
        channelId: r.channelId,
        requesterId: r.requesterId,
        summary: r.summary,
        status: r.status,
        at: r.createdAt,
      })),
  );
export const listDecisions = (scope: GuildScope) =>
  read(scope, (db) =>
    db
      .select()
      .from(assistantDecisions)
      .where(scope.only(assistantDecisions))
      .orderBy(desc(assistantDecisions.createdAt))
      .all()
      .map((r) => ({
        id: r.decisionId,
        kind: r.kind,
        summary: r.summary,
        status: r.status,
        requesterId: r.requesterId,
        provenance: r.provenance,
        at: r.createdAt,
      })),
  );
export interface NewAssistantTicket {
  readonly id: string;
  readonly behaviourId: string;
  readonly channelId: string;
  readonly requesterId: string;
  readonly summary: string;
  readonly dedupeKey: string;
  readonly at: number;
}
export const insertTicket = (scope: GuildScope, input: NewAssistantTicket): boolean =>
  write(
    scope,
    ({ db }) =>
      db
        .insert(assistantTickets)
        .values({
          guildId: scope.guildId,
          ticketId: input.id,
          behaviourId: input.behaviourId,
          channelId: input.channelId,
          requesterId: input.requesterId,
          summary: input.summary,
          status: 'open',
          dedupeKey: input.dedupeKey,
          createdAt: input.at,
        })
        .onConflictDoNothing()
        .run().changes > 0,
  );
export interface NewAssistantDecision {
  readonly id: string;
  readonly kind: 'decision' | 'review-plan';
  readonly summary: string;
  readonly requesterId: string;
  readonly provenance: string;
  readonly at: number;
}
export const insertDecisionDraft = (scope: GuildScope, input: NewAssistantDecision): void =>
  write(scope, ({ db }) => {
    db.insert(assistantDecisions)
      .values({
        guildId: scope.guildId,
        decisionId: input.id,
        kind: input.kind,
        summary: input.summary,
        status: 'draft',
        requesterId: input.requesterId,
        provenance: input.provenance,
        createdAt: input.at,
      })
      .run();
  });
export const transitionDecision = (
  scope: GuildScope,
  id: string,
  expected: 'draft' | 'reviewed',
  next: 'reviewed' | 'saved',
): boolean =>
  write(
    scope,
    ({ db }) =>
      db
        .update(assistantDecisions)
        .set({ status: next })
        .where(
          scope.only(
            assistantDecisions,
            eq(assistantDecisions.decisionId, id),
            eq(assistantDecisions.status, expected),
          ),
        )
        .run().changes > 0,
  );
