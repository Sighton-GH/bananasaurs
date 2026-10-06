import type { GuildId } from '@bananasaurs/core';
import type { HttpDeps } from '@bananasaurs/http';
import { accountRepo, authzRepo } from '@bananasaurs/storage';

/**
 * The one answer to "may this account manage this guild's tasks?" (ADR 0130):
 * an enabled account that is the instance owner or holds `tasks.manage` in
 * that guild. Guild scope is mandatory — a grant in one guild never answers
 * for another — and the check reads the live rows, so a revoked permission
 * binds on the next call.
 */
export const canManageTasks = (deps: HttpDeps, accountId: string, guildId: GuildId): boolean => {
  const account = accountRepo.findAccountById(deps.scopes.instance(), accountId);
  if (!account || account.disabled) return false;
  if (account.isOwner) return true;
  return authzRepo
    .listAccountCapabilities(deps.scopes.forGuild(guildId), accountId)
    .includes('tasks.manage');
};

/**
 * Whether to advertise the task tools at connect time: the enabled owner, or
 * an account holding `tasks.manage` in at least one of the guilds the token
 * reaches. Advertising is not authority — every call rechecks per guild.
 */
export const canManageTasksInAny = (
  deps: HttpDeps,
  accountId: string,
  guildIds: readonly GuildId[],
): boolean => {
  const account = accountRepo.findAccountById(deps.scopes.instance(), accountId);
  if (!account || account.disabled) return false;
  return account.isOwner || guildIds.some((guildId) => canManageTasks(deps, accountId, guildId));
};
