import { PermissionsBitField, type Client } from 'discord.js';
import { safeDisplayName } from '@bananasaurs/core';
import type { GuildScope } from '@bananasaurs/storage';
import { checkRolePing, rolePingContextFor } from '../mcp/targets.js';
import { extractPingPhrases, matchPingNames, namedIn, replacePingTokens } from './reply-pings.js';

export interface ReplyPingRequest {
  readonly askerId: string;
  readonly channelId: string | undefined;
  /** The answer, model output: it only says WHERE a ping goes, never WHO may be pinged. */
  readonly text: string;
  /** The asker's own message, raw. A name counts as "named" only if it appears here (D3). */
  readonly askerText: string;
  readonly mentionedUserIds: readonly string[];
  readonly mentionedRoleIds: readonly string[];
}
export interface ReplyPingResult {
  readonly content: string;
  readonly userIds: readonly string[];
  readonly roles: readonly string[];
}

export const resolveReplyPings = async (
  client: Client,
  scope: GuildScope,
  caps: { readonly members: number; readonly roles: number },
  input: ReplyPingRequest,
): Promise<ReplyPingResult> => {
  const plain: ReplyPingResult = { content: input.text, userIds: [], roles: [] };
  try {
    if (input.channelId === undefined) return plain;
    const guild = client.guilds.cache.get(scope.guildId);
    if (guild === undefined) return plain;
    const asker = await guild.members.fetch(input.askerId).catch(() => undefined);
    if (asker === undefined) return plain;
    // The ping skill's Send gate: without Send in the answer channel, nothing pings.
    if (!asker.permissionsIn(input.channelId).has(PermissionsBitField.Flags.SendMessages))
      return plain;
    // Candidates: mentioned ids first (display names, best effort), then
    // exact-name search for tokens the asker named without mentioning.
    const users: { id: string; name: string }[] = [];
    for (const id of input.mentionedUserIds.slice(0, 25)) {
      const member =
        guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => undefined));
      const name = safeDisplayName(member?.displayName);
      if (name !== undefined && !users.some((u) => u.id === id)) users.push({ id, name });
    }
    const roles: { id: string; name: string }[] = [];
    for (const id of input.mentionedRoleIds.slice(0, 10)) {
      const name = safeDisplayName(guild.roles.cache.get(id)?.name);
      if (name !== undefined && !roles.some((r) => r.id === id)) roles.push({ id, name });
    }
    const occurrences = extractPingPhrases(input.text);
    const known = (phrase: string, list: readonly { name: string }[]): boolean =>
      list.some((entry) => entry.name.toLowerCase() === phrase.toLowerCase());
    // Named-but-not-mentioned (D3): a phrase from the answer is looked up ONLY
    // when the asker's own message contains it as whole words. Model output
    // never widens who may be pinged. Members: one exact display-name search
    // over a page of 25 (a page of 5 can hide a second same-name member behind
    // prefix matches), single exact hit only (the reminder-targets.ts:166-191
    // rule). Roles: exact cache-name match, unambiguous only. At most 5
    // lookups per reply.
    const extraUsers: { id: string; name: string }[] = [];
    const extraRoles: { id: string; name: string }[] = [];
    let lookups = 0;
    for (const phrases of occurrences) {
      for (const phrase of phrases) {
        if (known(phrase, [...users, ...extraUsers, ...roles, ...extraRoles])) break;
        if (!namedIn(input.askerText, phrase)) continue;
        if (lookups >= 5) break;
        lookups += 1;
        const roleHits = [...guild.roles.cache.values()].filter(
          (r) => r.name.toLowerCase() === phrase.toLowerCase(),
        );
        if (roleHits.length === 1 && roleHits[0] !== undefined) {
          extraRoles.push({ id: roleHits[0].id, name: roleHits[0].name });
          break;
        }
        const hits = await guild.members
          .search({ query: phrase, limit: 25 })
          .catch(() => undefined);
        const exact = [...(hits?.values() ?? [])].filter(
          (m) => m.displayName.toLowerCase() === phrase.toLowerCase(),
        );
        if (exact.length === 1 && exact[0] !== undefined) {
          extraUsers.push({ id: exact[0].id, name: exact[0].displayName });
          break;
        }
      }
    }
    const memberIds = matchPingNames(occurrences, [...users, ...extraUsers]).slice(0, caps.members);
    const memberReplacements = new Map(
      memberIds.map((id) => {
        const name = [...users, ...extraUsers].find((u) => u.id === id)!.name;
        return [name, `<@${id}>`] as const;
      }),
    );
    // Roles: ADR 0117 policy per role; a non-mentionable role also needs the
    // asker's Mention Everyone (the reminder-targets.ts:248-257 rule).
    const context = rolePingContextFor(client, scope, scope.guildId);
    const askerMayMass = asker
      .permissionsIn(input.channelId)
      .has(PermissionsBitField.Flags.MentionEveryone);
    const roleIds: string[] = [];
    const roleReplacements = new Map<string, string>();
    for (const id of matchPingNames(occurrences, [...roles, ...extraRoles])) {
      if (roleIds.length >= caps.roles) break;
      const role = guild.roles.cache.get(id);
      if (role === undefined) continue;
      if (!role.mentionable && !askerMayMass) continue;
      if (checkRolePing(client, scope, scope.guildId, id, context).ok !== true) continue;
      roleIds.push(id);
      roleReplacements.set([...roles, ...extraRoles].find((r) => r.id === id)!.name, `<@&${id}>`);
    }
    return {
      content: replacePingTokens(
        replacePingTokens(input.text, memberReplacements),
        roleReplacements,
      ),
      userIds: memberIds,
      roles: roleIds,
    };
  } catch {
    return plain;
  }
};
