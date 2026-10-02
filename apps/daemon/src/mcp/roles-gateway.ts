import type { Client } from 'discord.js';
import {
  authorize,
  EffectGateway,
  rolePingAllowed,
  safeLogFields,
  type AuthzStore,
  type Authorized,
  type DiscordPort,
  type GuildId,
  type Logger,
  type RateLimiter,
  type RolePingRefusal,
} from '@bananasaurs/core';
import {
  authzStoreFor,
  effectRepo,
  guildRepo,
  isTargetProtected,
  mcpRolePolicyRepo,
  panelRepo,
  roleRepo,
  type GuildScope,
} from '@bananasaurs/storage';

/**
 * The MCP's own `EffectGateway` instance (ADR 0118 §1).
 *
 * The same shape as the production gateway in `runtime/guild.ts` — the same
 * repos for the effects ledger and `isTargetProtected`, the same panel-status
 * check — with exactly the four MCP differences: the grant policy as
 * `isRoleAllowlisted`, a breaker trip that logs instead of tripping, the
 * `mcp` rate bucket (intents carry `source: 'mcp'`), and `mcp_operator`
 * audit rows.
 */

export interface McpRoleGatewayDeps {
  readonly authz: AuthzStore;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  /** A property, not a method: it is destructured and passed on by value. */
  readonly now: () => number;
}

/**
 * The `roles.mutate` witness for one MCP role change (ADR 0118 §2), shared
 * by the HTTP role ports, the panel ports, the undo port and the bulk job.
 * The actor is the token's dashboard account with no Discord roles —
 * `authorize` drops dashboard role ids by construction, so a Discord grant
 * can never satisfy this. `undefined` on denial: the caller refuses with the
 * account's own refusal rather than falling back to anything else.
 */
export const authorizeRolesMutate = (
  scope: GuildScope,
  accountId: string,
): Authorized<'roles.mutate'> | undefined => {
  const result = authorize(
    {
      store: authzStoreFor(scope),
      guildId: scope.guildId,
      actor: { type: 'dashboard', id: accountId, roleIds: [] },
    },
    'roles.mutate',
  );
  return result.ok ? result.value : undefined;
};

/**
 * The MCP gateway's per-guild rate limiter, shared by the HTTP role ports
 * and the durable bulk job (whole-branch review): one limiter per guild, so
 * a bulk job plus interactive grants draw from one `roleRatePerMin` bucket
 * instead of two. Owned here, taken by `apps/daemon/src/mcp/wiring.ts` and
 * `apps/daemon/src/runtime/guild.ts` alike.
 *
 * One limiter per guild (buckets are per source, not per guild, so a single
 * limiter would let one guild spend another's budget); created lazily at the
 * guild's standing per-minute rate. The rate is read once, when the guild's
 * limiter is first built: a later change to `roleRatePerMin` applies after a
 * daemon restart, exactly as the production gateway's limiter behaves.
 */
const mcpLimiterRegistry = new Map<GuildId, RateLimiter>();

export const mcpRateLimiterFor = (scope: GuildScope): RateLimiter => {
  const existing = mcpLimiterRegistry.get(scope.guildId);
  if (existing !== undefined) return existing;
  const created = new RateLimiter(guildRepo.findGuild(scope)?.roleRatePerMin ?? 20);
  mcpLimiterRegistry.set(scope.guildId, created);
  return created;
};

/**
 * Test escape hatch: drops every cached limiter so buckets start full.
 * Production never calls this — one process owns its registry for life.
 */
export const resetMcpRateLimiters = (): void => {
  mcpLimiterRegistry.clear();
};

/**
 * The MCP grant policy (ADR 0118 §1, §3): the ping policy's rule with the
 * grant mode, fed live role facts from the discord.js client cache.
 *
 * Returns `true` or the first refusal, so the caller can name the reason.
 * A role missing from the cache fails closed as `not-allowlisted` — the
 * gateway maps that to its `role-not-allowlisted` refusal without a Discord
 * call. Task 3 names the reason in its refusal text from this return.
 */
export const roleGrantRefusal = (
  client: Client,
  scope: GuildScope,
  roleId: string,
): true | RolePingRefusal => {
  const guild = client.guilds.cache.get(scope.guildId);
  const role = guild?.roles.cache.get(roleId);
  if (guild === undefined || role === undefined) return 'not-allowlisted';
  return rolePingAllowed(
    {
      id: role.id,
      position: role.position,
      permissions: role.permissions.bitfield,
      managed: role.managed,
      isEveryone: role.id === guild.id,
    },
    guild.members.me?.roles.highest.position ?? 0,
    mcpRolePolicyRepo.readRolePolicy(scope).grantMode,
    mcpRolePolicyRepo.isRoleAllowlisted(scope, roleId, 'grant'),
  );
};

export const mcpRoleGatewayFor = (
  deps: McpRoleGatewayDeps,
  client: Client,
  discord: DiscordPort,
  scope: GuildScope,
): EffectGateway => {
  const guildId: GuildId = scope.guildId;
  const { authz, rateLimiter, logger, now } = deps;
  return new EffectGateway({
    guildId,
    authz,
    discord,
    rateLimiter,
    logger,
    now,
    state: {
      read: () => guildRepo.readSafetyState(scope),
      isPanelEnabled: (panelId) => panelRepo.isPanelEnabled(scope, panelId),
      // ADR 0118 amendment (owner decision 2026-10-01): the role must
      // already be on the bot's role allowlist (`managed_roles`, which
      // `role_effects` holds a foreign key into) AND pass the MCP grant
      // policy. The MCP never adds to `managed_roles` itself.
      isRoleAllowlisted: (roleId) =>
        roleRepo.isAllowlisted(scope, roleId) && roleGrantRefusal(client, scope, roleId) === true,
      isTargetProtected: (userId, roleId) => isTargetProtected(scope, { userId, roleId }),
      // ADR 0118 §2: an MCP rate overflow refuses but never opens the guild
      // breaker. A no-op that logs the allowlisted fields only — guild id
      // and reason — and never calls `guildRepo.tripBreaker`.
      tripBreaker: (reason, _atMs) => {
        logger.warn(
          safeLogFields({ component: 'mcp-roles', guildId, reason }),
          'mcp rate overflow refused; guild breaker left closed',
        );
      },
    },
    effects: {
      claim: ({ dedupeKey, intent, hadRoleBefore, atMs }) =>
        effectRepo.claimEffect(scope, {
          dedupeKey,
          batchId: intent.batchId,
          userId: intent.userId,
          roleId: intent.roleId,
          action: intent.action,
          hadRoleBefore,
          panelId: intent.panelId,
          now: atMs,
        }),
      record: ({ effectId, state, completedAtMs, errorCode }) =>
        effectRepo.recordOutcome(scope, {
          effectId,
          state,
          completedAt: completedAtMs,
          errorCode,
        }),
    },
    audit: {
      // ADR 0118 §2: role-effect audit rows record `actor_type =
      // 'mcp_operator'`, shaped like the production gateway's audit port
      // (actor, action, subject, batch, before/after, dry run) with the
      // `mcp_actions` vocabulary (`via: 'http' — the call arrived over HTTP
      // on the dashboard's own Fastify app, ruling M5-D10).
      record: (input) =>
        effectRepo.recordAudit(scope, {
          at: input.atMs,
          actorType: 'mcp_operator',
          actorId: input.actor.id,
          via: 'http',
          action: input.action,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          batchId: input.batchId,
          before: input.before,
          after: input.after,
          dryRun: input.dryRun,
        }),
    },
  });
};
