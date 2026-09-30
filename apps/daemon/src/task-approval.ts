import { ChannelType, type Client } from 'discord.js';
import type { DiscordPort } from '@bananasaurs/core';
import { taskRepo, type GuildScope } from '@bananasaurs/storage';
import { taskMemberAccess } from './task-access.js';

/** Who may approve or send back a completed task: the team's lead, or the
 * president (who may also approve exec tasks). Self-approval is allowed —
 * there is no check against who requested completion. Never takes an account
 * binding or a role name as proof of the Discord actor's authority. */
export const decideTaskReview = async (
  scope: GuildScope,
  client: Client,
  discord: DiscordPort,
  actorId: string,
  taskId: string,
  expectedVersion: number,
  decision: 'approve' | 'reject',
  now: number,
): Promise<'done' | 'sent-back' | 'not-authorised' | 'conflict'> => {
  const task = taskRepo.getTask(scope, taskId);
  if (!task || task.archivedAt) return 'not-authorised';
  if (task.status !== 'awaiting_approval' || task.version !== expectedVersion) return 'conflict';
  const team = taskRepo.listTeams(scope).find((t) => t.teamId === task.teamId);
  if (!team) return 'not-authorised';
  const guild = client.guilds.cache.get(scope.guildId);
  if (!guild) return 'not-authorised';
  try {
    // Fetch instead of trusting gateway cache: moved/deleted categories fail closed.
    const category = await guild.channels.fetch(team.categoryId, { force: true });
    if (category?.type !== ChannelType.GuildCategory) return 'not-authorised';
    const access = await taskMemberAccess(scope, client, discord, actorId);
    const authorised =
      team.kind === 'exec' ? access.president : access.leadOf(team.teamId) || access.president;
    if (!authorised) return 'not-authorised';
    const actor = { actorType: 'member', actorId, via: 'gateway' } as const;
    if (decision === 'approve')
      return taskRepo.approveTask(scope, taskId, expectedVersion, actor, now) ? 'done' : 'conflict';
    return taskRepo.rejectTask(scope, taskId, expectedVersion, actor, now)
      ? 'sent-back'
      : 'conflict';
  } catch {
    // Discord outages, missing members/categories and invalid IDs all deny.
    return 'not-authorised';
  }
};
