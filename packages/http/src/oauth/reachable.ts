import { accountRepo, authzStoreFor } from '@bananasaurs/storage';
import { authorize, parseGuildId, type GuildId } from '@bananasaurs/core';
import { actorFor } from '../auth.js';
import type { OAuthDeps } from './provider.js';

/**
 * The guilds in which `accountId` CURRENTLY holds `mcp.authorize`, among
 * the guilds this daemon serves. Never stored, never cached: revoking the
 * grant changes the next answer.
 *
 * ADR 0045 Amendment 1 PR-92: capabilities are guild-scoped, so a token
 * carries no guild and each call resolves the live grant set instead. The
 * route requires this to be non-empty before minting (refusal (f)), and M4
 * intersects it again per tool call.
 */
export const reachableGuilds = (deps: OAuthDeps, accountId: string): readonly GuildId[] => {
  const accessible = accountRepo.listAccessibleGuilds(deps.scopes.instance(), accountId);
  const out: GuildId[] = [];
  for (const id of accessible) {
    if (!deps.guildIds.includes(id)) continue;
    const guildId = parseGuildId(id);
    const scope = deps.scopes.forGuild(guildId);
    const result = authorize(
      { store: authzStoreFor(scope), guildId, actor: actorFor(accountId) },
      'mcp.authorize',
    );
    if (result.ok) out.push(guildId);
  }
  return out;
};
