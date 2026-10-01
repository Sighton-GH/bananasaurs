import { and, asc, eq, inArray, lt, lte, isNull, ne, notInArray } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import {
  auditEvents,
  clubTasks,
  taskMessageAnchors,
  taskNudgeDeliveries,
  taskNudgeSlots,
  taskNudgeSlotTasks,
  taskReplyChoices,
  taskReports,
  taskTeams,
} from '../schema.js';
import type { TaskActor } from './tasks.js';

export type NudgeKind =
  | 'pre_due'
  | 'custom'
  | 'checkin'
  | 'digest'
  | 'followup'
  | 'announce'
  | 'review'
  | 'clarify'
  | 'evaluate';
export type NudgeSlot = typeof taskNudgeSlots.$inferSelect;

/** Stable keys make repeated scans and restarts harmless. Caller chooses the cycle. */
export function schedule(
  scope: GuildScope,
  input: {
    slotId: string;
    taskId?: string;
    teamId?: string;
    kind: NudgeKind;
    dueAt: number;
    destinationId?: string;
    payload?: string;
  },
  now: number,
): void {
  if (!Number.isSafeInteger(input.dueAt) || input.dueAt < 0) throw new Error('invalid-nudge-time');
  write(scope, ({ db }) => {
    db.insert(taskNudgeSlots)
      .values({
        guildId: scope.guildId,
        slotId: input.slotId,
        taskId: input.taskId ?? null,
        teamId: input.teamId ?? null,
        kind: input.kind,
        dueAt: input.dueAt,
        destinationId: input.destinationId ?? null,
        payload: input.payload ?? null,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  });
}

/** Custom times are immutable and keyed by task + instant; a second append is a no-op
 * that returns false and writes no audit row. When an actor is given, the
 * 'task.reminder_added' audit row is written in the same transaction as the
 * slot insert, so a duplicate append writes nothing at all. */
export function appendCustom(
  scope: GuildScope,
  taskId: string,
  at: number,
  now: number,
  actor?: TaskActor,
): boolean {
  return write(scope, ({ db }) => {
    const task = db
      .select()
      .from(clubTasks)
      .where(scope.only(clubTasks, eq(clubTasks.taskId, taskId), isNull(clubTasks.archivedAt)))
      .get();
    if (!task || task.status === 'done' || task.status === 'awaiting_approval')
      throw new Error('task-not-open');
    if (at <= now || at >= task.dueAt) throw new Error('custom-reminder-must-precede-due-date');
    const inserted =
      db
        .insert(taskNudgeSlots)
        .values({
          guildId: scope.guildId,
          slotId: `custom:${taskId}:${at}`,
          taskId,
          kind: 'custom',
          dueAt: at,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run().changes === 1;
    if (inserted && actor) {
      db.insert(auditEvents)
        .values({
          guildId: scope.guildId,
          at: now,
          actorType: actor.actorType,
          actorId: actor.actorId,
          via: actor.via,
          action: 'task.reminder_added',
          subjectType: 'club_task',
          subjectId: taskId,
          before: null,
          after: JSON.stringify({ at }),
          dryRun: 0,
        })
        .run();
    }
    return inserted;
  });
}

export const listDue = (
  scope: GuildScope,
  now: number,
  limit = 40,
  excludeKinds?: readonly string[],
): NudgeSlot[] =>
  read(scope, (db) =>
    db
      .select()
      .from(taskNudgeSlots)
      .where(
        scope.only(
          taskNudgeSlots,
          eq(taskNudgeSlots.state, 'pending'),
          lte(taskNudgeSlots.dueAt, now),
          // Quiet hours hold the scheduled kinds in SQL, so a full page of
          // held slots can never starve an event kind behind the limit.
          ...(excludeKinds !== undefined && excludeKinds.length > 0
            ? [notInArray(taskNudgeSlots.kind, [...excludeKinds])]
            : []),
        ),
      )
      .orderBy(taskNudgeSlots.dueAt)
      .limit(limit)
      .all(),
  );

export const listSlots = (scope: GuildScope) =>
  read(scope, (db) => db.select().from(taskNudgeSlots).where(scope.only(taskNudgeSlots)).all());

export const slotsForTask = (scope: GuildScope, taskId: string) =>
  read(scope, (db) =>
    db
      .select()
      .from(taskNudgeSlots)
      .where(scope.only(taskNudgeSlots, eq(taskNudgeSlots.taskId, taskId)))
      .orderBy(asc(taskNudgeSlots.dueAt))
      .all(),
  );

/** The task's reminder listing: only `pre_due` and `custom` slots. Announce,
 * review, evaluate, check-in, digest, clarify and followup slots belong to
 * other surfaces and never appear here. */
export const reminderSlotsForTask = (scope: GuildScope, taskId: string) =>
  read(scope, (db) =>
    db
      .select()
      .from(taskNudgeSlots)
      .where(
        scope.only(
          taskNudgeSlots,
          eq(taskNudgeSlots.taskId, taskId),
          inArray(taskNudgeSlots.kind, ['pre_due', 'custom']),
        ),
      )
      .orderBy(asc(taskNudgeSlots.dueAt))
      .all(),
  );

/** Cancel one pending custom reminder of this task. */
export const cancelCustom = (
  scope: GuildScope,
  taskId: string,
  slotId: string,
  now: number,
): 'cancelled' | 'not-pending' =>
  write(scope, ({ db }) => {
    const changed = db
      .update(taskNudgeSlots)
      .set({ state: 'superseded', lastError: 'cancelled by owner', updatedAt: now })
      .where(
        scope.only(
          taskNudgeSlots,
          and(
            eq(taskNudgeSlots.slotId, slotId),
            eq(taskNudgeSlots.taskId, taskId),
            eq(taskNudgeSlots.kind, 'custom'),
            eq(taskNudgeSlots.state, 'pending'),
          ),
        ),
      )
      .run().changes;
    return changed === 1 ? 'cancelled' : 'not-pending';
  });
export const listDeliveries = (scope: GuildScope) =>
  read(scope, (db) =>
    db.select().from(taskNudgeDeliveries).where(scope.only(taskNudgeDeliveries)).all(),
  );
/** A sent bot post by its delivered message, for reply attribution. */
export const sentSlotForMessage = (
  scope: GuildScope,
  channelId: string,
  messageId: string,
): NudgeSlot | undefined =>
  read(scope, (db) =>
    db
      .select()
      .from(taskNudgeSlots)
      .where(
        scope.only(
          taskNudgeSlots,
          eq(taskNudgeSlots.state, 'sent'),
          eq(taskNudgeSlots.messageId, messageId),
          eq(taskNudgeSlots.destinationId, channelId),
        ),
      )
      .get(),
  );
export const getSlot = (scope: GuildScope, slotId: string): NudgeSlot | undefined =>
  read(scope, (db) =>
    db
      .select()
      .from(taskNudgeSlots)
      .where(scope.only(taskNudgeSlots, eq(taskNudgeSlots.slotId, slotId)))
      .get(),
  );
export type ReplyChoiceRow = typeof taskReplyChoices.$inferSelect;
/** Hold a multi-candidate progress reply until its author picks one. Idempotent on the reply message. */
export const insertReplyChoice = (
  scope: GuildScope,
  input: {
    messageId: string;
    authorId: string;
    channelId: string;
    body: string;
    createdAt: number;
  },
): boolean =>
  write(
    scope,
    ({ db }) =>
      db
        .insert(taskReplyChoices)
        .values({
          guildId: scope.guildId,
          messageId: input.messageId,
          authorId: input.authorId,
          channelId: input.channelId,
          body: input.body,
          createdAt: input.createdAt,
        })
        .onConflictDoNothing()
        .run().changes === 1,
  );
export const getReplyChoice = (scope: GuildScope, messageId: string): ReplyChoiceRow | undefined =>
  read(scope, (db) =>
    db
      .select()
      .from(taskReplyChoices)
      .where(scope.only(taskReplyChoices, eq(taskReplyChoices.messageId, messageId)))
      .get(),
  );
export const deleteReplyChoice = (scope: GuildScope, messageId: string): boolean =>
  write(
    scope,
    ({ db }) =>
      db
        .delete(taskReplyChoices)
        .where(scope.only(taskReplyChoices, eq(taskReplyChoices.messageId, messageId)))
        .run().changes === 1,
  );
/** Drop held choices older than 7 days. */
export const pruneReplyChoices = (scope: GuildScope, now: number): number =>
  write(
    scope,
    ({ db }) =>
      db
        .delete(taskReplyChoices)
        .where(scope.only(taskReplyChoices, lt(taskReplyChoices.createdAt, now - 7 * 86_400_000)))
        .run().changes,
  );
export const taskFor = (scope: GuildScope, taskId: string) =>
  read(scope, (db) =>
    db
      .select()
      .from(clubTasks)
      .where(scope.only(clubTasks, eq(clubTasks.taskId, taskId)))
      .get(),
  );
export const teamFor = (scope: GuildScope, teamId: string) =>
  read(scope, (db) =>
    db
      .select()
      .from(taskTeams)
      .where(scope.only(taskTeams, eq(taskTeams.teamId, teamId)))
      .get(),
  );
export const openTasks = (scope: GuildScope) =>
  read(scope, (db) =>
    db
      .select()
      .from(clubTasks)
      .where(scope.only(clubTasks, isNull(clubTasks.archivedAt)))
      .all(),
  );
export const teams = (scope: GuildScope) =>
  read(scope, (db) => db.select().from(taskTeams).where(scope.only(taskTeams)).all());

/** Claim before network I/O. A crashed claim is intentionally not replayed: Discord has no idempotency token for message sends. */
export const claim = (scope: GuildScope, slotId: string, now: number): boolean =>
  write(
    scope,
    ({ db }) =>
      db
        .update(taskNudgeSlots)
        .set({ state: 'claimed', updatedAt: now })
        .where(
          scope.only(
            taskNudgeSlots,
            eq(taskNudgeSlots.slotId, slotId),
            eq(taskNudgeSlots.state, 'pending'),
          ),
        )
        .run().changes === 1,
  );

export type Outcome = 'sent' | 'planned' | 'paused' | 'failed' | 'superseded';
/** One terminal attempt per slot; even a rejected/unknown send is audited and never sent twice. */
export function settle(
  scope: GuildScope,
  slotId: string,
  outcome: Outcome,
  now: number,
  destinationId?: string,
  messageId?: string,
  detail?: string,
): boolean {
  return write(scope, ({ db }) => {
    const changed = db
      .update(taskNudgeSlots)
      .set({
        state: outcome,
        updatedAt: now,
        destinationId: destinationId ?? null,
        messageId: messageId ?? null,
        lastError: detail ?? null,
      })
      .where(
        scope.only(
          taskNudgeSlots,
          eq(taskNudgeSlots.slotId, slotId),
          eq(taskNudgeSlots.state, 'claimed'),
        ),
      )
      .run().changes;
    if (!changed) return false;
    db.insert(taskNudgeDeliveries)
      .values({
        guildId: scope.guildId,
        slotId,
        outcome,
        attemptedAt: now,
        destinationId: destinationId ?? null,
        messageId: messageId ?? null,
        detail: detail ?? null,
      })
      .run();
    return true;
  });
}

/**
 * Settle a weekly check-in as 'sent' exactly as settle() does, and in the
 * same transaction record which open tasks the message listed (one row per
 * task, duplicates ignored). A second call finds no claimed slot and writes
 * nothing.
 */
export function settleWithTasks(
  scope: GuildScope,
  slotId: string,
  now: number,
  destinationId: string,
  messageId: string,
  taskIds: readonly string[],
): boolean {
  return write(scope, ({ db }) => {
    const changed = db
      .update(taskNudgeSlots)
      .set({
        state: 'sent',
        updatedAt: now,
        destinationId,
        messageId,
        lastError: null,
      })
      .where(
        scope.only(
          taskNudgeSlots,
          eq(taskNudgeSlots.slotId, slotId),
          eq(taskNudgeSlots.state, 'claimed'),
        ),
      )
      .run().changes;
    if (!changed) return false;
    db.insert(taskNudgeDeliveries)
      .values({
        guildId: scope.guildId,
        slotId,
        outcome: 'sent',
        attemptedAt: now,
        destinationId,
        messageId,
        detail: null,
      })
      .run();
    for (const taskId of taskIds) {
      db.insert(taskNudgeSlotTasks)
        .values({ guildId: scope.guildId, slotId, taskId })
        .onConflictDoNothing()
        .run();
    }
    return true;
  });
}

/** Which open tasks a sent weekly check-in listed, so a reply can be attributed. */
export const listSlotTasks = (scope: GuildScope, slotId: string): string[] =>
  read(scope, (db) =>
    db
      .select({ taskId: taskNudgeSlotTasks.taskId })
      .from(taskNudgeSlotTasks)
      .where(scope.only(taskNudgeSlotTasks, eq(taskNudgeSlotTasks.slotId, slotId)))
      .all()
      .map((row) => row.taskId),
  );

/** One stored progress report by its id, for the evaluate worker. Guild-scoped like every other reader. */
export const getReport = (
  scope: GuildScope,
  taskId: string,
  reportId: string,
): typeof taskReports.$inferSelect | undefined =>
  read(scope, (db) =>
    db
      .select()
      .from(taskReports)
      .where(
        scope.only(taskReports, eq(taskReports.taskId, taskId), eq(taskReports.reportId, reportId)),
      )
      .get(),
  );

/**
 * True when the message id is a bot task post (ADR 0112 decision 4): a task
 * anchor or a sent nudge slot carrying that message. Guild-scoped, so another
 * guild's post never counts.
 */
export const isTaskPost = (scope: GuildScope, messageId: string): boolean =>
  read(scope, (db) => {
    const anchor = db
      .select({ messageId: taskMessageAnchors.messageId })
      .from(taskMessageAnchors)
      .where(scope.only(taskMessageAnchors, eq(taskMessageAnchors.messageId, messageId)))
      .get();
    if (anchor !== undefined) return true;
    return (
      db
        .select({ slotId: taskNudgeSlots.slotId })
        .from(taskNudgeSlots)
        .where(
          scope.only(
            taskNudgeSlots,
            eq(taskNudgeSlots.state, 'sent'),
            eq(taskNudgeSlots.messageId, messageId),
            // A followup slot's message id is the member's own reply, never a
            // bot post, so it must not count as a task post.
            ne(taskNudgeSlots.kind, 'followup'),
          ),
        )
        .get() !== undefined
    );
  });

/** Reconcile ambiguous in-flight sends after restart without retrying them. */
export function reconcileClaims(scope: GuildScope, now: number): number {
  return write(scope, ({ db }) => {
    const claims = db
      .select()
      .from(taskNudgeSlots)
      .where(scope.only(taskNudgeSlots, eq(taskNudgeSlots.state, 'claimed')))
      .all();
    for (const slot of claims) {
      db.update(taskNudgeSlots)
        .set({ state: 'paused', lastError: 'send outcome unknown after restart', updatedAt: now })
        .where(scope.only(taskNudgeSlots, eq(taskNudgeSlots.slotId, slot.slotId)))
        .run();
      db.insert(taskNudgeDeliveries)
        .values({
          guildId: scope.guildId,
          slotId: slot.slotId,
          outcome: 'paused',
          attemptedAt: now,
          detail: 'send outcome unknown after restart',
        })
        .onConflictDoNothing()
        .run();
    }
    return claims.length;
  });
}
