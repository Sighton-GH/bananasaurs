import { authorize, capabilityOf, type Authorized, type AuthzStore } from '../authz.js';
import type { DiscordPort } from '../discord/port.js';
import { DiscordApiError, DiscordErrorCode } from '../discord/errors.js';
import type { GuildId, SnowflakeId } from '../ids.js';
import { safeLogFields, type Logger } from '../obs/logger.js';

/**
 * The one function that can time out, untimeout, kick, ban, or unban a member.
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
 *                          (skipped only for `unban`: the target is not
 *                          a member — ADR 0037)
 *   9. idempotency         claim before the call                -> skip
 *  10. dry run             record, no REST call
 *  11. execute             the single REST call
 *
 * `deleteMessage` keeps 1, 2, 3, 9, 10, 11 — no hierarchy: Discord gates a
 * delete by Manage Messages, not role position.
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
  /**
   * ADR 0037: `ban` rides the full hierarchy path like kick; `unban` skips
   * it entirely (the target is not a member); `untimeout` targets a member
   * in the guild, so it keeps the hierarchy path like `timeout`.
   */
  readonly action: 'timeout' | 'untimeout' | 'kick' | 'ban' | 'unban';
  /** Ignored except for `timeout`. Clamped to Discord's 28-day maximum by the caller. */
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

export interface DeleteMessageIntent {
  readonly channelId: SnowflakeId;
  readonly messageId: SnowflakeId;
  readonly dedupeKey: string;
  /** Shown in Discord's own audit log. */
  readonly reason: string;
}

export type DeleteRefusalReason = 'unauthorized' | 'guild-unknown' | 'killswitch' | 'breaker-open';

export type DeleteMessageOutcome =
  | { readonly status: 'applied' }
  | { readonly status: 'dry-run' }
  | { readonly status: 'skipped'; readonly reason: 'already-applied' | 'message-gone' }
  | { readonly status: 'refused'; readonly reason: DeleteRefusalReason }
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

  /** Layers 1–3, shared by every action. Returns the safety state, or the refusal. */
  private preflight(
    auth: Authorized<'moderation.act'>,
    refuse: (reason: DeleteRefusalReason) => { status: 'refused'; reason: DeleteRefusalReason },
  ): ModerationSafetyState | { status: 'refused'; reason: DeleteRefusalReason } {
    const recheck = authorize(
      { store: this.deps.authz, guildId: this.deps.guildId, actor: auth.actor },
      capabilityOf(auth),
    );
    if (!recheck.ok || auth.guildId !== this.deps.guildId) return refuse('unauthorized');
    const state = this.deps.state.read();
    if (!state) return refuse('guild-unknown');
    if (state.killswitch) return refuse('killswitch');
    if (state.breakerOpen) return refuse('breaker-open');
    return state;
  }

  /**
   * Times out, untimeouts, kicks, bans, or unbans one member — or explains
   * why it did not.
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
    // --- 2, 3. kill switch and breaker --------------------------------------
    const pre = this.preflight(
      auth,
      (reason) => refuse(reason) as { status: 'refused'; reason: DeleteRefusalReason },
    );
    if ('status' in pre) return pre;
    const state = pre;

    // --- 7. hierarchy, checked live and immediately before acting -----------
    // Never cached: the failure mode is somebody reordering roles, or Discord
    // itself transferring ownership, after startup (REVIEW C9, mirrored from
    // gateway.ts's own layer 7).
    //
    // `unban` has no hierarchy block (ADR 0037): the target is not a member,
    // so there is no member record to compare roles against, and Discord
    // never refuses a ban removal for hierarchy reasons. Every other action
    // targets a member and gets the full check — `untimeout` included, since
    // the target is a member Discord itself still gates by role position.
    if (intent.action !== 'unban') {
      const [roles, botPosition, member] = await Promise.all([
        deps.discord.fetchRoles(deps.guildId),
        deps.discord.fetchBotHighestRolePosition(deps.guildId),
        deps.discord.fetchMember(deps.guildId, intent.userId),
      ]);

      // Discord never lets a bot act on the guild owner, whatever the
      // hierarchy says. Refusing here turns a confusing 403 into a stated
      // reason (gateway.ts:266's `member.isGuildOwner` check, same idea).
      if (member.isGuildOwner) return refuse('discord-owner');

      const highestMemberRolePosition = member.roleIds.reduce((max, roleId) => {
        const position = roles.find((r) => r.id === roleId)?.position ?? 0;
        return position > max ? position : max;
      }, 0);
      // Strictly below, matching resolveAssignability's own off-by-one guard:
      // a member whose highest role sits at exactly the bot's position is not
      // reachable either.
      if (highestMemberRolePosition >= botPosition) return refuse('role-above-bot');
    }

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
      switch (intent.action) {
        case 'timeout':
          await deps.discord.timeoutMember(
            deps.guildId,
            intent.userId,
            intent.timeoutMs ?? 0,
            intent.reason,
          );
          break;
        case 'untimeout':
          await deps.discord.untimeoutMember(deps.guildId, intent.userId, intent.reason);
          break;
        case 'kick':
          await deps.discord.kickMember(deps.guildId, intent.userId, intent.reason);
          break;
        case 'ban':
          await deps.discord.banMember(deps.guildId, intent.userId, intent.reason);
          break;
        case 'unban':
          await deps.discord.unbanMember(deps.guildId, intent.userId, intent.reason);
          break;
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

  /**
   * Deletes one message for a moderator (ADR 0141 decision 7). A message
   * someone else already removed is `skipped`, not `failed`: the outcome the
   * moderator wanted exists, but this click did not cause it.
   */
  async deleteMessage(
    auth: Authorized<'moderation.act'>,
    intent: DeleteMessageIntent,
  ): Promise<DeleteMessageOutcome> {
    const { deps } = this;
    const fields = {
      component: 'moderation-effects',
      guildId: deps.guildId,
      channelId: intent.channelId,
      messageId: intent.messageId,
      action: 'delete',
    };
    const refuse = (reason: DeleteRefusalReason) => {
      deps.logger.warn(safeLogFields({ ...fields, outcome: 'refused', reason }), 'moderation action refused');
      return { status: 'refused' as const, reason };
    };

    const pre = this.preflight(auth, refuse);
    if ('status' in pre) return pre;

    if (!deps.claims.claim(intent.dedupeKey).claimed)
      return { status: 'skipped', reason: 'already-applied' };

    if (pre.dryRun) {
      deps.logger.info(
        safeLogFields({ ...fields, dryRun: true, outcome: 'dry-run' }),
        'dry run: no Discord call was made',
      );
      return { status: 'dry-run' };
    }

    try {
      await deps.discord.deleteMessage(
        deps.guildId,
        { channelId: intent.channelId, messageId: intent.messageId },
        intent.reason,
      );
    } catch (err) {
      if (err instanceof DiscordApiError && err.code === DiscordErrorCode.UnknownMessage) {
        deps.logger.info(safeLogFields({ ...fields, outcome: 'message-gone' }), 'the message was already gone');
        return { status: 'skipped', reason: 'message-gone' };
      }
      const code = err instanceof Error ? err.name : 'UnknownError';
      deps.logger.error(safeLogFields({ ...fields, outcome: 'failed', code, err }), 'the Discord call failed');
      return { status: 'failed', code };
    }
    return { status: 'applied' };
  }
}
