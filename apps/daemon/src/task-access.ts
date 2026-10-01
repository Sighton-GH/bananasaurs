import { ChannelType, type Client } from 'discord.js';
import type { DiscordMember, DiscordPort } from '@bananasaurs/core';
import { taskRepo, taskBindingRepo, type GuildScope } from '@bananasaurs/storage';

/** One row of `taskTeams` for this guild. */
export type TaskTeamRow = ReturnType<typeof taskRepo.listTeams>[number];
/** One row of `taskTeamMembers` for the accessing user. */
export type TaskMembershipRow = ReturnType<typeof taskBindingRepo.listMemberships>[number];

export interface TaskMemberAccess {
  readonly member: DiscordMember;
  /** The configured president role exists and the member holds it. */
  readonly president: boolean;
  readonly memberships: readonly TaskMembershipRow[];
  /** Teams whose category is live (fetched with force) and that this member is on. */
  readonly teams: readonly TaskTeamRow[];
  /** Stored membership (any kind), or holds the team's existing memberRoleId, or president. */
  readonly onTeam: (teamId: string) => boolean;
  /** Stored 'lead' membership AND holds the team's existing leadRoleId. */
  readonly leadOf: (teamId: string) => boolean;
}

/** One live access check for task authority. Role names never grant anything;
 * only role IDs checked live do. Throws when the member fetch fails or
 * returns another user id (callers already catch). */
export const taskMemberAccess = async (
  scope: GuildScope,
  client: Client,
  discord: DiscordPort,
  userId: string,
): Promise<TaskMemberAccess> => {
  const guildId = scope.guildId;
  const member = await discord.fetchMember(guildId, userId);
  if (member.userId !== userId) throw new Error('member-identity-mismatch');
  const roles = await discord.fetchRoles(guildId);
  const liveRoleIds = new Set(roles.map((role) => role.id));
  const configuredRole = taskBindingRepo.presidentRoleId(scope);
  const president =
    !!configuredRole && liveRoleIds.has(configuredRole) && member.roleIds.includes(configuredRole);
  const memberships = taskBindingRepo.listMemberships(scope, userId);
  const teamsById = new Map(taskRepo.listTeams(scope).map((team) => [team.teamId, team] as const));

  const onTeam = (teamId: string): boolean => {
    const team = teamsById.get(teamId);
    if (!team) return false;
    if (president) return true;
    if (memberships.some((m) => m.teamId === teamId)) return true;
    return (
      !!team.memberRoleId &&
      liveRoleIds.has(team.memberRoleId) &&
      member.roleIds.includes(team.memberRoleId)
    );
  };
  const leadOf = (teamId: string): boolean => {
    const team = teamsById.get(teamId);
    if (!team?.leadRoleId || !liveRoleIds.has(team.leadRoleId)) return false;
    if (!member.roleIds.includes(team.leadRoleId)) return false;
    return memberships.some((m) => m.teamId === teamId && m.kind === 'lead');
  };

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { member, president, memberships, teams: [], onTeam, leadOf };
  const verified = await Promise.all(
    [...teamsById.values()].map(async (team) => {
      try {
        // Fetch instead of trusting gateway cache: moved/deleted categories fail closed.
        const category = await guild.channels.fetch(team.categoryId, { force: true });
        if (category?.type !== ChannelType.GuildCategory) return undefined;
        // A deleted lead role only removes lead powers (R12): the team stays
        // visible to its members via onTeam, which never checks leadRoleId.
        return onTeam(team.teamId) ? team : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  const teams = verified.filter((team) => team !== undefined);
  return { member, president, memberships, teams, onTeam, leadOf };
};
