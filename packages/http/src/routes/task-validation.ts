import type { taskRepo } from '@bananasaurs/storage';
import type { OpsPorts } from '@bananasaurs/core';

/** Return a diagnostic rather than treating missing gateway cache data as proof.
 * This is a read-only setup check; it never authorizes a member or a send. */
export function inspectTaskTeam(ports: OpsPorts, team: taskRepo.NewTeam): string[] {
  const channels = ports.listGuildChannels();
  const roles = ports.listGuildRoles();
  if (channels.length === 0 || roles.length === 0)
    return ['Discord directory is unavailable; cannot validate this team'];
  const category = channels.find((c) => c.channelId === team.categoryId && c.kind === 'category');
  const issues: string[] = [];
  if (!category) issues.push('Category is not in the current guild directory');
  if (team.leadRoleId && !roles.some((r) => r.roleId === team.leadRoleId))
    issues.push('Lead role is not in the current guild directory');
  if (team.memberRoleId && !roles.some((r) => r.roleId === team.memberRoleId))
    issues.push('Member role is not in the current guild directory');
  if (team.announcementChannelId) {
    const announcements = channels.find((c) => c.channelId === team.announcementChannelId);
    if (!announcements || announcements.parentId !== team.categoryId)
      issues.push('Announcements channel is not inside this category');
  }
  return issues;
}

export async function inspectTaskDestination(
  ports: OpsPorts,
  team: taskRepo.NewTeam,
  task: taskRepo.NewTask,
): Promise<string[]> {
  const channel = await ports.inspectTaskChannel(task.destinationId);
  if (!channel || channel.categoryId !== team.categoryId)
    return ['Destination could not be verified in the team category'];
  return [];
}
