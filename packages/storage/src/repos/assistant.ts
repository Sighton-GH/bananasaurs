import { asc, desc } from 'drizzle-orm';
import type { AssistantBehaviour, ClubResource, Reminder, ReminderStatus } from '@bananasaurs/core';
import {
  assistantBehaviours,
  assistantReminders,
  assistantResources,
  assistantSkillActivity,
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
        mentionRoleId: input.mentionRoleId,
        name: input.name,
        systemPrompt: input.systemPrompt,
        enabled: input.enabled ? 1 : 0,
        skillIdsJson: JSON.stringify(input.allowedSkillIds),
        callerRoleIdsJson: JSON.stringify(input.callerRoleIds),
        ticketChannelId: input.ticketChannelId,
        reviewerRoleIdsJson: JSON.stringify(input.reviewerRoleIds),
        resourceIdsJson: JSON.stringify(input.resourceIds),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [assistantBehaviours.guildId, assistantBehaviours.behaviourId],
        set: {
          surface: input.surface,
          mentionRoleId: input.mentionRoleId,
          name: input.name,
          systemPrompt: input.systemPrompt,
          enabled: input.enabled ? 1 : 0,
          skillIdsJson: JSON.stringify(input.allowedSkillIds),
          callerRoleIdsJson: JSON.stringify(input.callerRoleIds),
          ticketChannelId: input.ticketChannelId,
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
export interface StoredReminder extends Reminder {
  readonly failureReason?: string;
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
export const insertReminder = (scope: GuildScope, r: Reminder): void =>
  write(scope, ({ db }) => {
    db.insert(assistantReminders)
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
      .run();
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
