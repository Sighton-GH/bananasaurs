import { authorize, capabilityOf, type Authorized, type AuthzStore } from '../authz.js';
import type { DiscordPort } from '../discord/port.js';
import type { GuildId, SnowflakeId } from '../ids.js';
import { safeLogFields, type Logger } from '../obs/logger.js';

/**
 * The one function that can time out or kick a member.
 *
 * `EffectGateway` (`gateway.ts`) is the model this mirrors, layer for layer:
 * one chokepoint rather than guard clauses scattered across call sites, so
 * "is dry-run respected?" is one test against one function. The target here
 * is a *member*, not a role, so the layers that only make sense for a role
 * change — panel status, the role allowlist, a protected-target lookup — have
 * no equivalent and are simply absent. Everything else keeps its place:
 *
 *   1. authorization      re-verified at runtime, not trusted from the witness
 *   2. kill switch         guilds.killswitch                    -> refuse
 *   3. circuit breaker     guilds.breaker_state = 'open'        -> refuse
 *   7. hierarchy           live, immediately before acting      -> refuse
 *   9. idempotency         claim before the call                -> skip
 *  10. dry run             record, no REST call
 *  11. execute             the single REST call
 *
 * (Numbering follows `gateway.ts`'s comment so the two stay easy to diff
 * against each other; 4, 5, 6 and 8 are the role-only layers with no member
 * equivalent, and 12 — the audit row — is deliberately not this class's job:
 * Task 9's subscriber calls `recordCaseEvent` with the `ModerationOutcome`
 * this method returns, which is where ADR 0035's durable-refusal-recording
 * requirement is actually satisfied. That mirrors `EffectGateway`'s own split
 * from `effectRepo.recordAudit` — the safety decision lives here, the case
 * bookkeeping does not.)
 */

export interface ModerationIntent {
  readonly userId: SnowflakeId;
  readonly action: 'timeout' | 'kick';
  /** Ignored for `kick`. Clamped to Discord's 28-day maximum by the caller. */
  readonly timeoutMs: number | undefined;
  readonly dedupeKey: string;
  /** Shown in Discord's own audit log. */
  readonly reason: string;
}

export type ModerationRefusalReason =
  | 'unauthorized'
  | 'guild-unknown'
  | 'killswitch'
  | 'breaker-open'
  /**
   * Reserved for a future per-source rate cap on moderation actions, the
   * member-action analogue of `EffectGateway`'s layer 8. Not wired in this
   * task — nothing in `ModerationGatewayDeps` produces it yet — kept in the
   * vocabulary so a caller pattern-matching on `ModerationOutcome` today does
   * not need to change when it is.
   */
  | 'rate-cap'
  | 'discord-owner'
  | 'role-above-bot';

export type ModerationOutcome =
  | { readonly status: 'applied' }
  | { readonly status: 'dry-run' }
  | { readonly status: 'skipped'; readonly reason: 'already-applied' }
  | { readonly status: 'refused'; readonly reason: ModerationRefusalReason }
  | { readonly status: 'failed'; readonly code: string };

export interface ModerationSafetyState {
  readonly killswitch: boolean;
  readonly breakerOpen: boolean;
  readonly dryRun: boolean;
}

/**
 * Everything the gateway needs, as ports — the same split `EffectGatewayDeps`
 * uses: `core` holds the ordering and the decisions, the guild scope, the
 * database handle and the concrete Discord client all stay on the other side
 * of these interfaces.
 */
export interface ModerationGatewayDeps {
  readonly guildId: GuildId;
  readonly authz: AuthzStore;
  readonly discord: DiscordPort;
  readonly logger: Logger;
  now(): number;

  readonly state: {
    read(): ModerationSafetyState | undefined;
  };

  readonly claims: {
    /** Same insert-or-ignore idempotency pattern `EffectGatewayDeps.effects.claim` uses. */
    claim(dedupeKey: string): { claimed: boolean };
  };
}

export class ModerationActionGateway {
  constructor(private readonly deps: ModerationGatewayDeps) {}

  /**
   * Times out or kicks one member, or explains why it did not.
   *
   * `auth` cannot be forged by omission and cannot be omitted at all — there
   * is no overload without it. It is nonetheless re-verified below, because
   * the type is erased at runtime and a cast defeats it (authz.ts amendment 3).
   */
  async applyAction(
    auth: Authorized<'moderation.act'>,
    intent: ModerationIntent,
  ): Promise<ModerationOutcome> {
    const { deps } = this;
    const refuse = (reason: ModerationRefusalReason): ModerationOutcome => {
      deps.logger.warn(
        safeLogFields({
          component: 'moderation-effects',
          guildId: deps.guildId,
          userId: intent.userId,
          action: intent.action,
          outcome: 'refused',
          reason,
        }),
        'moderation action refused',
      );
      return { status: 'refused', reason };
    };

    // --- 1. authorization, re-verified --------------------------------------
    const recheck = authorize(
      { store: deps.authz, guildId: deps.guildId, actor: auth.actor },
      capabilityOf(auth),
    );
    if (!recheck.ok || auth.guildId !== deps.guildId) return refuse('unauthorized');

    // --- 2, 3. kill switch and breaker --------------------------------------
    const state = deps.state.read();
    if (!state) return refuse('guild-unknown');
    if (state.killswitch) return refuse('killswitch');
    if (state.breakerOpen) return refuse('breaker-open');

    // --- 7. hierarchy, checked live and immediately before acting -----------
    // Never cached: the failure mode is somebody reordering roles, or Discord
    // itself transferring ownership, after startup (REVIEW C9, mirrored from
    // gateway.ts's own layer 7).
    const [roles, botPosition, member] = await Promise.all([
      deps.discord.fetchRoles(deps.guildId),
      deps.discord.fetchBotHighestRolePosition(deps.guildId),
      deps.discord.fetchMember(deps.guildId, intent.userId),
    ]);

    // Discord never lets a bot act on the guild owner, whatever the hierarchy
    // says. Refusing here turns a confusing 403 into a stated reason
    // (gateway.ts:266's `member.isGuildOwner` check, same idea).
    if (member.isGuildOwner) return refuse('discord-owner');

    const highestMemberRolePosition = member.roleIds.reduce((max, roleId) => {
      const position = roles.find((r) => r.id === roleId)?.position ?? 0;
      return position > max ? position : max;
    }, 0);
    // Strictly below, matching resolveAssignability's own off-by-one guard: a
    // member whose highest role sits at exactly the bot's position is not
    // reachable either.
    if (highestMemberRolePosition >= botPosition) return refuse('role-above-bot');

    // --- 9. idempotency ------------------------------------------------------
    // Before the REST call, deliberately. If the process dies between the
    // claim and the call, the action is recorded as attempted and a replay
    // skips it — the failure direction that does not double-fire.
    const claim = deps.claims.claim(intent.dedupeKey);
    if (!claim.claimed) return { status: 'skipped', reason: 'already-applied' };

    // --- 10. dry run -----------------------------------------------------
    if (state.dryRun) {
      deps.logger.info(
        safeLogFields({
          component: 'moderation-effects',
          guildId: deps.guildId,
          userId: intent.userId,
          action: intent.action,
          dryRun: true,
          outcome: 'dry-run',
        }),
        'dry run: no Discord call was made',
      );
      return { status: 'dry-run' };
    }

    // --- 11. execute -------------------------------------------------------
    try {
      if (intent.action === 'timeout') {
        await deps.discord.timeoutMember(
          deps.guildId,
          intent.userId,
          intent.timeoutMs ?? 0,
          intent.reason,
        );
      } else {
        await deps.discord.kickMember(deps.guildId, intent.userId, intent.reason);
      }
    } catch (err) {
      const code = err instanceof Error ? err.name : 'UnknownError';
      deps.logger.error(
        safeLogFields({
          component: 'moderation-effects',
          guildId: deps.guildId,
          userId: intent.userId,
          action: intent.action,
          outcome: 'failed',
          code,
          err,
        }),
        'the Discord call failed',
      );
      return { status: 'failed', code };
    }

    return { status: 'applied' };
  }
}
