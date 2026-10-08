import type { GuildId } from '@bananasaurs/core';
import type { HttpDeps } from '@bananasaurs/http';
import type { McpAccessPort } from '@bananasaurs/mcp';
import { accountRepo, authzRepo } from '@bananasaurs/storage';

/**
 * The access port behind the live block of `bananasaurs_guide` (ADR 0133,
 * Task 4): one account's username, instance-owner flag and permissions in the
 * one guild asked for. It answers nothing for a missing or disabled account,
 * and it reads only that guild's capability rows (hard rule 2), so a grant in
 * one guild never answers for another. The answer carries no other account
 * detail: no password hash, no contact.
 */
export const accessPortFor = (deps: HttpDeps): McpAccessPort => ({
  forGuild: (accountId: string, guildId: GuildId) => {
    const account = accountRepo.findAccountById(deps.scopes.instance(), accountId);
    if (!account || account.disabled) return undefined;
    return {
      username: account.username,
      isOwner: account.isOwner,
      permissions: authzRepo.listAccountCapabilities(deps.scopes.forGuild(guildId), accountId),
    };
  },
});
