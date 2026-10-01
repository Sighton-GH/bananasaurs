import { and, eq } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write, type WriteTx } from '../write.js';
import { auditEvents, taskGuildRoles, taskTeamMembers } from '../schema.js';
import type { TaskActor } from './tasks.js';

const audit = (
  db: WriteTx['db'],
  scope: GuildScope,
  actor: TaskActor,
  now: number,
  action: string,
  subjectType: string,
  subjectId: string,
  before: unknown,
  after: unknown,
) =>
  db
    .insert(auditEvents)
    .values({
      guildId: scope.guildId,
      at: now,
      actorType: actor.actorType,
      actorId: actor.actorId,
      via: actor.via,
      action,
      subjectType,
      subjectId,
      before: before === undefined ? null : JSON.stringify(before),
      after: after === undefined ? null : JSON.stringify(after),
      dryRun: 0,
    })
    .run();

export const listMemberships = (scope: GuildScope, discordUserId: string) =>
  read(scope, (db) =>
    db
      .select()
      .from(taskTeamMembers)
      .where(scope.only(taskTeamMembers, eq(taskTeamMembers.discordUserId, discordUserId)))
      .all(),
  );

export const addMembership = (
  scope: GuildScope,
  teamId: string,
  discordUserId: string,
  kind: 'member' | 'lead',
  actor: TaskActor,
  now: number,
): void =>
  write(scope, ({ db }) => {
    db.insert(taskTeamMembers)
      .values({ guildId: scope.guildId, teamId, discordUserId, kind, createdAt: now })
      .onConflictDoUpdate({
        target: [taskTeamMembers.guildId, taskTeamMembers.teamId, taskTeamMembers.discordUserId],
        set: { kind },
      })
      .run();
    audit(db, scope, actor, now, 'task.member_added', 'task_team', teamId, undefined, {
      teamId,
      discordUserId,
      kind,
    });
  });

export const isMember = (scope: GuildScope, teamId: string, discordUserId: string) =>
  read(
    scope,
    (db) =>
      db
        .select({ teamId: taskTeamMembers.teamId })
        .from(taskTeamMembers)
        .where(
          scope.only(
            taskTeamMembers,
            and(
              eq(taskTeamMembers.teamId, teamId),
              eq(taskTeamMembers.discordUserId, discordUserId),
            ),
          ),
        )
        .get() !== undefined,
  );

/** Revoking a team membership never affects another team or another guild. */
export const removeMembership = (
  scope: GuildScope,
  teamId: string,
  discordUserId: string,
  actor: TaskActor,
  now: number,
): boolean =>
  write(scope, ({ db }) => {
    const changed =
      db
        .delete(taskTeamMembers)
        .where(
          scope.only(
            taskTeamMembers,
            and(
              eq(taskTeamMembers.teamId, teamId),
              eq(taskTeamMembers.discordUserId, discordUserId),
            ),
          ),
        )
        .run().changes === 1;
    if (!changed) return false;
    audit(
      db,
      scope,
      actor,
      now,
      'task.member_removed',
      'task_team',
      teamId,
      {
        teamId,
        discordUserId,
      },
      undefined,
    );
    return true;
  });

export const listTeamMemberships = (scope: GuildScope, teamId: string) =>
  read(scope, (db) =>
    db
      .select()
      .from(taskTeamMembers)
      .where(scope.only(taskTeamMembers, eq(taskTeamMembers.teamId, teamId)))
      .all(),
  );

export const presidentRoleId = (scope: GuildScope): string | undefined =>
  read(
    scope,
    (db) =>
      db
        .select({ roleId: taskGuildRoles.presidentRoleId })
        .from(taskGuildRoles)
        .where(scope.only(taskGuildRoles))
        .get()?.roleId,
  );

export const setPresidentRole = (
  scope: GuildScope,
  roleId: string,
  actor: TaskActor,
  now: number,
): void => {
  write(scope, ({ db }) => {
    db.insert(taskGuildRoles)
      .values({
        guildId: scope.guildId,
        presidentRoleId: roleId,
        updatedBy: actor.actorId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [taskGuildRoles.guildId],
        set: {
          presidentRoleId: roleId,
          updatedBy: actor.actorId,
          updatedAt: now,
        },
      })
      .run();
    audit(db, scope, actor, now, 'task.president_role_set', 'guild', scope.guildId, undefined, {
      roleId,
    });
  });
};

export const clearPresidentRole = (scope: GuildScope, actor: TaskActor, now: number): boolean =>
  write(scope, ({ db }) => {
    const changed = db.delete(taskGuildRoles).where(scope.only(taskGuildRoles)).run().changes === 1;
    if (!changed) return false;
    audit(
      db,
      scope,
      actor,
      now,
      'task.president_role_cleared',
      'guild',
      scope.guildId,
      {},
      undefined,
    );
    return true;
  });
