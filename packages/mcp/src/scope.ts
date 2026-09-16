import { parseGuildId, type GuildId } from '@bananasaurs/core';

/**
 * The half of `packages/http`'s `BearerPrincipal` this package needs.
 * Declared here rather than imported because the eslint boundary forbids
 * importing `@bananasaurs/http` (ADR 0044 §4) — and structural typing means
 * Task 3 can hand a real `BearerPrincipal` to these functions unchanged.
 * `scopes` is another instance of the same reason: `readonly OAuthScope[]`
 * is structurally assignable to `readonly string[]`, so a real
 * `BearerPrincipal` still passes unchanged while this package never imports
 * the OAuth vocabulary.
 */
export interface McpPrincipal {
  readonly accountId: string;
  readonly reachableGuilds: readonly GuildId[];
  /** The OAuth scopes this token carries. */
  readonly scopes: readonly string[];
}

/**
 * The read scope every tool in this package requires (ruling M4-D17). A token
 * carrying only `bananasaurs:send` cannot see any tool in `tools/list` at
 * all — the tools are filtered out of the advertised set at registration,
 * not merely refused on call.
 */
export const MCP_READ_SCOPE = 'bananasaurs:read';

export const hasReadScope = (principal: McpPrincipal): boolean =>
  principal.scopes.includes(MCP_READ_SCOPE);

/**
 * The single refusal every tool returns, whatever the reason. Empty set,
 * malformed id, and unreachable id are indistinguishable to the caller on
 * purpose: distinct messages would be an oracle telling someone which guilds
 * exist and which they *nearly* have access to.
 */
export const GUILD_REFUSAL_MESSAGE = 'Unknown or unreachable guild.';

/**
 * The argument-fault answer (ruling M4-D18), distinct from the guild refusal
 * above. The single refusal exists so that an empty reachable set, a
 * malformed guild id and an unreachable guild id are indistinguishable to
 * the caller — that oracle argument is real and it stands. It does not
 * cover argument validation, because the Zod parse runs *before*
 * `requireReachableGuild` in every tool: a refusal returned there has
 * consulted nothing about which guilds exist, so naming it as an argument
 * fault leaks no membership fact and is not an oracle.
 */
export const INVALID_ARGUMENTS_MESSAGE = 'Invalid arguments for this tool.';

export type GuildRefusal = { readonly ok: false; readonly message: string };
export type GuildResolved = { readonly ok: true; readonly guildId: GuildId };
export type GuildOutcome = GuildRefusal | GuildResolved;

/**
 * Turn an untrusted `guildId` from a tool call into a `GuildId` the tool may
 * act on (CLAUDE.md rule 2: guild scope is a mandatory partition key). This
 * is the single place that conversion happens, so every tool refuses the
 * same way.
 *
 * Refuses when the id is malformed and when the parsed id is not in the
 * reachable set. An empty `principal.reachableGuilds` therefore refuses
 * every id as a consequence of that same membership check — the ADR 0044
 * §4 obligation-1 case, where a token stays valid for up to an hour after
 * the account lost `mcp.authorize` everywhere — not as a separate refusal.
 *
 * There is deliberately NO separate allowlist check here (ruling M4-D5):
 * `reachableGuilds` is built by filtering `deps.guildIds` in
 * `packages/http/src/oauth/reachable.ts` (`if (!deps.guildIds.includes(id))
 * continue`), so it is a subset of the allowlist by construction and
 * membership in it already implies allowlist membership. A second check
 * could never fire — do not "restore" it.
 */
export const requireReachableGuild = (
  principal: McpPrincipal,
  requestedGuildId: string,
): GuildOutcome => {
  // No empty-set early return here (ruling M4-D6): [].includes() is always
  // false so the membership check below already refuses every id; the
  // empty-set property (ADR 0044 obligation 1) is pinned by the named test, not a branch.
  let parsed: GuildId;
  try {
    parsed = parseGuildId(requestedGuildId);
  } catch {
    return { ok: false, message: GUILD_REFUSAL_MESSAGE };
  }
  if (!principal.reachableGuilds.includes(parsed)) {
    return { ok: false, message: GUILD_REFUSAL_MESSAGE };
  }
  return { ok: true, guildId: parsed };
};

/**
 * For tools that take no guild — `get_health`. A guild-independent tool
 * would otherwise be reachable by an account holding no grant anywhere, so
 * it still refuses on an empty reachable set (ADR 0044 §4 obligation 1).
 */
export const requireAnyReachableGuild = (
  principal: McpPrincipal,
): GuildRefusal | { readonly ok: true } => {
  if (principal.reachableGuilds.length === 0) {
    return { ok: false, message: GUILD_REFUSAL_MESSAGE };
  }
  return { ok: true };
};
