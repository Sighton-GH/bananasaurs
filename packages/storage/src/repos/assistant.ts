import { and, asc, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type {
  AssistantBehaviour,
  ClubResource,
  PromptWizardAnswers,
  Reminder,
  ReminderStatus,
  ResourceMeta,
} from '@bananasaurs/core';
import { parseResourceMeta, promptWizardAnswers } from '@bananasaurs/core';
import {
  assistantBehaviours,
  assistantReminders,
  assistantResources,
  assistantSkillActivity,
  assistantSkillGrants,
  assistantTickets,
  assistantDecisions,
  assistantServerCards,
  assistantMemories,
  assistantMemoryPreferences,
  assistantSettings,
} from '../schema.js';
import { forgetAuthor } from './conversations.js';
import { deleteTracesForUser } from './traces.js';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';

const array = (raw: string): readonly string[] => {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    throw new Error('assistant list column is invalid');
  return value;
};
const toPromptWizard = (raw: string | null): PromptWizardAnswers | undefined => {
  if (raw === null) return undefined;
  try {
    const parsed = promptWizardAnswers.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};
const toBehaviour = (r: typeof assistantBehaviours.$inferSelect): AssistantBehaviour => {
  const promptWizard = toPromptWizard(r.promptWizardJson);
  return {
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
    answersBotTag: r.answersBotTag === 1,
    // Anything invalid reads as undefined and never throws: a hand-edited or
    // older-database value must not break the behaviours list.
    ...(promptWizard === undefined ? {} : { promptWizard }),
  };
};
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
        // Only setBotTagBehaviour changes this flag (ADR 0063): a new
        // behaviour starts unflagged and a re-save leaves it as it was.
        answersBotTag: 0,
        // Absent answers mean hand-written or cleared: stored as NULL, never
        // as the string "undefined".
        promptWizardJson:
          input.promptWizard === undefined ? null : JSON.stringify(input.promptWizard),
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
          promptWizardJson:
            input.promptWizard === undefined ? null : JSON.stringify(input.promptWizard),
          updatedAt: now,
        },
      })
      .run();
  });
/**
 * Makes `behaviourId` the one behaviour that answers a tag of the bot user,
 * clearing the flag from every other behaviour in the guild in the same
 * write, so the partial unique index never sees two. `null` clears it
 * everywhere. Returns false, changing nothing, when `behaviourId` is not a
 * behaviour of this guild (ADR 0063).
 */
export const setBotTagBehaviour = (
  scope: GuildScope,
  behaviourId: string | null,
  now: number,
): boolean =>
  write(scope, ({ db }) => {
    if (behaviourId !== null) {
      const exists = db
        .select({ id: assistantBehaviours.behaviourId })
        .from(assistantBehaviours)
        .where(
          and(scope.only(assistantBehaviours), eq(assistantBehaviours.behaviourId, behaviourId)),
        )
        .get();
      if (exists === undefined) return false;
    }
    db.update(assistantBehaviours)
      .set({ answersBotTag: 0, updatedAt: now })
      .where(and(scope.only(assistantBehaviours), eq(assistantBehaviours.answersBotTag, 1)))
      .run();
    if (behaviourId !== null)
      db.update(assistantBehaviours)
        .set({ answersBotTag: 1, updatedAt: now })
        .where(
          and(scope.only(assistantBehaviours), eq(assistantBehaviours.behaviourId, behaviourId)),
        )
        .run();
    return true;
  });
/** ADR 0065: guild-wide assistant settings. Absent fields are unset. */
export interface AssistantSettings {
  readonly logChannelId?: string;
}
export const getAssistantSettings = (scope: GuildScope): AssistantSettings =>
  read(scope, (db) => {
    const row = db.select().from(assistantSettings).where(scope.only(assistantSettings)).get();
    return row === undefined || row.logChannelId === null ? {} : { logChannelId: row.logChannelId };
  });
/** Sets or (with `null`) clears the AI log channel. */
export const setLogChannel = (scope: GuildScope, channelId: string | null, now: number): void =>
  write(scope, ({ db }) => {
    db.insert(assistantSettings)
      .values({ guildId: scope.guildId, logChannelId: channelId, updatedAt: now })
      .onConflictDoUpdate({
        target: assistantSettings.guildId,
        set: { logChannelId: channelId, updatedAt: now },
      })
      .run();
  });

/**
 * Task 19: how long a conversation lives past its last activity, in days —
 * 61 (2 months), 182 (6 months) or 365 (12 months). `null` keeps forever. A
 * guild with no settings row reads the default 182; anything else is refused
 * by the table CHECK, the same way `setLogChannel` leans on its snowflake
 * CHECK rather than re-validating.
 */
export type ConversationRetentionDays = 61 | 182 | 365;
export const CONVERSATION_RETENTION_DEFAULT: ConversationRetentionDays = 182;
export const getConversationRetention = (scope: GuildScope): ConversationRetentionDays | null =>
  read(scope, (db) => {
    const row = db.select().from(assistantSettings).where(scope.only(assistantSettings)).get();
    if (row === undefined) return CONVERSATION_RETENTION_DEFAULT;
    if (row.conversationRetentionDays === null) return null;
    return row.conversationRetentionDays as ConversationRetentionDays;
  });
/** Upserts only the retention (plus `updatedAt`), so a log channel survives it and vice versa. */
export const setConversationRetention = (
  scope: GuildScope,
  days: ConversationRetentionDays | null,
  now: number,
): void =>
  write(scope, ({ db }) => {
    db.insert(assistantSettings)
      .values({ guildId: scope.guildId, conversationRetentionDays: days, updatedAt: now })
      .onConflictDoUpdate({
        target: assistantSettings.guildId,
        set: { conversationRetentionDays: days, updatedAt: now },
      })
      .run();
  });
const toResource = (r: typeof assistantResources.$inferSelect): ClubResource => {
  // `meta_json` this process wrote is still untrusted on the way back in
  // (CLAUDE.md rule 3, the same reason `jobs.payload` has a validator): a
  // hand-edited or corrupt value reads as absent, never throws.
  const meta = parseResourceMeta(r.metaJson);
  return {
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
    ...(r.parentId === null ? {} : { parentId: r.parentId }),
    ...(meta === undefined ? {} : { meta }),
  };
};
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
        // Absent means cleared (the same normalise-to-NULL discipline
        // `putBehaviour` follows): a re-save without meta/parent must not
        // keep the stale import details.
        parentId: input.parentId ?? null,
        metaJson: input.meta === undefined ? null : JSON.stringify(input.meta),
      })
      .onConflictDoUpdate({
        target: [assistantResources.guildId, assistantResources.resourceId],
        set: {
          title: input.title,
          url: input.url,
          kind: input.kind,
          enabled: input.enabled ? 1 : 0,
          reviewedAt: Date.parse(input.reviewedAt),
          lastFetchedAt: null,
          fetchStatus: 'pending',
          content: null,
          parentId: input.parentId ?? null,
          metaJson: input.meta === undefined ? null : JSON.stringify(input.meta),
        },
      })
      .run();
  });

/**
 * Changes only a resource's enabled flag and meta (ADR 0084): fetch status,
 * last-fetched time, title and URL are untouched. `meta: undefined` clears it.
 * Returns false when this guild has no resource with that id.
 */
export const setResourceEnabled = (
  scope: GuildScope,
  id: string,
  input: { readonly enabled: boolean; readonly meta: ResourceMeta | undefined },
): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .update(assistantResources)
      .set({
        enabled: input.enabled ? 1 : 0,
        metaJson: input.meta === undefined ? null : JSON.stringify(input.meta),
      })
      .where(scope.only(assistantResources, eq(assistantResources.resourceId, id)))
      .run();
    return result.changes === 1;
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
/**
 * Adds roles to several skills' grants in one transaction. A union: existing
 * role and user ids are kept, duplicates are not repeated. Returns the grants
 * as stored after the write, in the order given.
 */
export const addRolesToSkillGrants = (
  scope: GuildScope,
  input: { skillIds: readonly string[]; roleIds: readonly string[] },
  now: number,
): readonly AssistantSkillGrant[] =>
  write(scope, ({ db }) => {
    if (input.skillIds.length === 0) return [];
    const existing = db
      .select()
      .from(assistantSkillGrants)
      .where(
        scope.only(
          assistantSkillGrants,
          inArray(assistantSkillGrants.skillId, [...input.skillIds]),
        ),
      )
      .all();
    const bySkillId = new Map(existing.map((row) => [row.skillId, row]));
    const result: AssistantSkillGrant[] = [];
    for (const skillId of input.skillIds) {
      const row = bySkillId.get(skillId);
      const currentRoleIds = row === undefined ? [] : array(row.roleIdsJson);
      const currentUserIds = row === undefined ? [] : array(row.userIdsJson);
      const roleIds = [...currentRoleIds];
      for (const roleId of input.roleIds) {
        if (!roleIds.includes(roleId)) roleIds.push(roleId);
      }
      db.insert(assistantSkillGrants)
        .values({
          guildId: scope.guildId,
          skillId,
          roleIdsJson: JSON.stringify(roleIds),
          userIdsJson: JSON.stringify(currentUserIds),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [assistantSkillGrants.guildId, assistantSkillGrants.skillId],
          set: {
            roleIdsJson: JSON.stringify(roleIds),
            userIdsJson: JSON.stringify(currentUserIds),
            updatedAt: now,
          },
        })
        .run();
      result.push({ skillId, roleIds, userIds: [...currentUserIds] });
      bySkillId.set(skillId, {
        guildId: scope.guildId,
        skillId,
        roleIdsJson: JSON.stringify(roleIds),
        userIdsJson: JSON.stringify(currentUserIds),
        updatedAt: now,
      });
    }
    return result;
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
  readonly kind: 'decision' | 'review-plan' | 'memory';
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
export const saveMemoryProposal = (
  scope: GuildScope,
  id: string,
  memory: {
    readonly section: string;
    readonly content: string;
    readonly subjectId?: string | undefined;
  },
  now: number,
): boolean =>
  write(scope, ({ db }) => {
    const proposal = db
      .select()
      .from(assistantDecisions)
      .where(
        scope.only(
          assistantDecisions,
          eq(assistantDecisions.decisionId, id),
          eq(assistantDecisions.kind, 'memory'),
          eq(assistantDecisions.status, 'reviewed'),
        ),
      )
      .get();
    if (proposal === undefined) return false;
    db.insert(assistantMemories)
      .values({
        guildId: scope.guildId,
        memoryId: `proposal-${id}`,
        section: memory.section,
        content: memory.content,
        subjectId: memory.subjectId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.update(assistantDecisions)
      .set({ status: 'saved' })
      .where(
        scope.only(
          assistantDecisions,
          eq(assistantDecisions.decisionId, id),
          eq(assistantDecisions.status, 'reviewed'),
        ),
      )
      .run();
    return true;
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

export interface AssistantMemoryRow {
  readonly id: string;
  readonly section: string;
  readonly content: string;
  readonly subjectId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export const getServerCard = (scope: GuildScope): string =>
  read(
    scope,
    (db) =>
      db.select().from(assistantServerCards).where(scope.only(assistantServerCards)).get()
        ?.content ?? 'Bananasaurs club assistant',
  );
export const putServerCard = (scope: GuildScope, content: string, now: number): void =>
  write(scope, ({ db }) => {
    db.insert(assistantServerCards)
      .values({ guildId: scope.guildId, content, updatedAt: now })
      .onConflictDoUpdate({
        target: assistantServerCards.guildId,
        set: { content, updatedAt: now },
      })
      .run();
  });
export const listMemories = (scope: GuildScope): readonly AssistantMemoryRow[] =>
  read(scope, (db) =>
    db
      .select()
      .from(assistantMemories)
      .where(scope.only(assistantMemories))
      .orderBy(asc(assistantMemories.createdAt))
      .all()
      .map((r) => ({
        id: r.memoryId,
        section: r.section,
        content: r.content,
        ...(r.subjectId === null ? {} : { subjectId: r.subjectId }),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
  );
export const putMemory = (
  scope: GuildScope,
  input: { id: string; section: string; content: string; subjectId?: string | undefined },
  now: number,
): void =>
  write(scope, ({ db }) => {
    db.insert(assistantMemories)
      .values({
        guildId: scope.guildId,
        memoryId: input.id,
        section: input.section,
        content: input.content,
        subjectId: input.subjectId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [assistantMemories.guildId, assistantMemories.memoryId],
        set: {
          section: input.section,
          content: input.content,
          subjectId: input.subjectId ?? null,
          updatedAt: now,
        },
      })
      .run();
  });
export const deleteMemory = (scope: GuildScope, id: string): boolean =>
  write(
    scope,
    ({ db }) =>
      db
        .delete(assistantMemories)
        .where(scope.only(assistantMemories, eq(assistantMemories.memoryId, id)))
        .run().changes > 0,
  );
export const memoryPreference = (scope: GuildScope, userId: string): { optedOut: boolean } =>
  read(scope, (db) => ({
    optedOut:
      db
        .select()
        .from(assistantMemoryPreferences)
        .where(
          scope.only(assistantMemoryPreferences, eq(assistantMemoryPreferences.userId, userId)),
        )
        .get()?.optedOut === 1,
  }));
export const setMemoryOptOut = (
  scope: GuildScope,
  userId: string,
  optedOut: boolean,
  now: number,
): void =>
  write(scope, ({ db }) => {
    db.insert(assistantMemoryPreferences)
      .values({ guildId: scope.guildId, userId, optedOut: optedOut ? 1 : 0, updatedAt: now })
      .onConflictDoUpdate({
        target: [assistantMemoryPreferences.guildId, assistantMemoryPreferences.userId],
        set: { optedOut: optedOut ? 1 : 0, updatedAt: now },
      })
      .run();
  });
/**
 * Forgets a member: drops their curated memories, opts them out, removes
 * their conversation turns (Task 19) and deletes their assistant traces, which
 * hold their question and answer. Each delete runs as its own write right
 * after, in the same function — `write()` forbids nesting one transaction
 * inside another, so they cannot share one.
 */
export const forgetMember = (scope: GuildScope, userId: string, now: number): number => {
  const removed = write(scope, ({ db }) => {
    const deleted = db
      .delete(assistantMemories)
      .where(scope.only(assistantMemories, eq(assistantMemories.subjectId, userId)))
      .run().changes;
    db.insert(assistantMemoryPreferences)
      .values({ guildId: scope.guildId, userId, optedOut: 1, updatedAt: now })
      .onConflictDoUpdate({
        target: [assistantMemoryPreferences.guildId, assistantMemoryPreferences.userId],
        set: { optedOut: 1, updatedAt: now },
      })
      .run();
    return deleted;
  });
  forgetAuthor(scope, userId);
  deleteTracesForUser(scope, userId);
  return removed;
};
