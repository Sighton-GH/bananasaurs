import { createHash } from 'node:crypto';
import { authorize, capabilityOf, type Actor, type Authorized, type AuthzStore } from '../authz.js';
import { resolveAssignability, type Assignability } from '../discord/assignability.js';
import type { DiscordPort } from '../discord/port.js';
import type { GuildId, SnowflakeId } from '../ids.js';
import { safeLogFields, type Logger } from '../obs/logger.js';
import type { EffectSource, RateLimiter } from './rate-limit.js';

/**
 * The one function in the system that can change a role.
 *
 * Not guard clauses scattered across call sites — **one chokepoint, layered**.
 * `packages/discord`'s REST port is importable only from this directory
 * (ADR 0014), so this is the only code that can reach Discord's role API at
 * all. That is what makes "is dry-run respected?" one test against one
 * function rather than an audit of every caller.
 *
 * The order of the layers is not arbitrary. Cheap local refusals come before
 * anything that costs a REST call; the hierarchy check comes as late as
 * possible because it must reflect the state of the guild *now*; and the
 * idempotency claim comes before the call so a replay cannot double-execute
 * even if the process dies between the claim and the call.
 *
 *   1. authorization      re-verified at runtime, not trusted from the witness
 *   2. kill switch        guilds.killswitch                    -> refuse
 *   3. circuit breaker    guilds.breaker_state = 'open'        -> refuse
 *   4. panel status       panels.status <> 'enabled'           -> refuse
 *   5. role allowlist     managed_roles                        -> refuse
 *   6. protected target   principals.protected                 -> refuse
 *   7. hierarchy + managed  live, immediately before acting    -> refuse
 *   8. rate cap           per-source token bucket; overflow    -> trip breaker
 *   9. idempotency        INSERT OR IGNORE role_effects        -> 0 rows = skip
 *  10. dry run            guilds.dry_run -> record, no REST call
 *  11. execute            the single REST call
 *  12. record             outcome, before/after, batch id, audit row
 */

export interface RoleIntent {
  readonly userId: SnowflakeId;
  readonly roleId: SnowflakeId;
  readonly action: 'grant' | 'revoke';
  /** Absent for a CLI or reconciliation action not driven by a panel. */
  readonly panelId: string | undefined;
  /** Interaction id for a button, convergence pass id for a reaction. */
  readonly triggerRef: string;
  readonly source: EffectSource;
  readonly batchId: string;
  /** Shown in Discord's own audit log. */
  readonly reason: string;
}

export type RefusalReason =
  | 'unauthorized'
  | 'guild-unknown'
  | 'killswitch'
  | 'breaker-open'
  | 'panel-disabled'
  | 'role-not-allowlisted'
  | 'protected-target'
  | 'role-above-bot'
  | 'role-managed'
  | 'role-is-everyone'
  | 'role-missing'
  | 'rate-cap';

export type EffectOutcome =
  | { readonly status: 'applied'; readonly effectId: string; readonly hadRoleBefore: boolean }
  | { readonly status: 'dry-run'; readonly effectId: string; readonly hadRoleBefore: boolean }
  | { readonly status: 'skipped'; readonly reason: 'already-applied' | 'no-change-needed' }
  | { readonly status: 'refused'; readonly reason: RefusalReason }
  | { readonly status: 'failed'; readonly effectId: string; readonly code: string };

export interface SafetyState {
  readonly killswitch: boolean;
  readonly dryRun: boolean;
  readonly breakerOpen: boolean;
  readonly breakerThreshold: number;
}

export interface ClaimedEffect {
  /** False when this exact effect was already recorded — a replay. */
  readonly claimed: boolean;
  readonly effectId: string;
}

export interface EffectRecordInput {
  readonly effectId: string;
  readonly state: 'applied' | 'failed' | 'dry_run' | 'skipped';
  readonly completedAtMs: number;
  readonly errorCode?: string | undefined;
}

export interface AuditInput {
  readonly actor: Actor;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | undefined;
  readonly batchId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly dryRun: boolean;
  readonly atMs: number;
}

/**
 * Everything the gateway needs, as ports.
 *
 * `core` holds the ordering and the decisions; the guild scope, the database
 * handle and the concrete Discord client all stay on the other side of these
 * interfaces.
 */
export interface EffectGatewayDeps {
  readonly guildId: GuildId;
  readonly authz: AuthzStore;
  readonly discord: DiscordPort;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  now(): number;

  readonly state: {
    read(): SafetyState | undefined;
    isPanelEnabled(panelId: string): boolean;
    isRoleAllowlisted(roleId: SnowflakeId): boolean;
    /** The *target*, not the actor. See the note on `AuthzStore.anyProtected`. */
    isTargetProtected(userId: SnowflakeId, roleId: SnowflakeId): boolean;
    tripBreaker(reason: string, atMs: number): void;
  };

  readonly effects: {
    /** INSERT OR IGNORE on (guild_id, dedupe_key). Zero rows means a replay. */
    claim(input: {
      dedupeKey: string;
      intent: RoleIntent;
      hadRoleBefore: boolean;
      atMs: number;
    }): ClaimedEffect;
    record(input: EffectRecordInput): void;
  };

  readonly audit: {
    record(input: AuditInput): void;
  };
}

/**
 * The idempotency key. `docs/19` §4 specifies it exactly:
 *
 *     sha256(guild_id ‖ panel_id ‖ user_id ‖ role_id ‖ action ‖ trigger_ref)
 *
 * `trigger_ref` is the interaction id for a button and the convergence pass id
 * for a reaction. It is what keeps a *legitimate* repeat — a member toggling a
 * role off and on again — from colliding with a *replayed* one, which is the
 * distinction the whole design turns on.
 *
 * A pure function rather than a port, because getting it wrong silently breaks
 * idempotency and a port would let each caller get it wrong differently.
 */
export const dedupeKeyFor = (guildId: GuildId, intent: RoleIntent): string =>
  createHash('sha256')
    .update(
      [
        guildId,
        intent.panelId ?? '',
        intent.userId,
        intent.roleId,
        intent.action,
        intent.triggerRef,
      ].join('\u0000'),
    )
    .digest('hex');

/** Assignability refusals, mapped to the gateway's vocabulary. */
const REFUSAL_BY_ASSIGNABILITY: Record<
  Extract<Assignability, { assignable: false }>['reason'],
  RefusalReason
> = {
  above_bot: 'role-above-bot',
  managed: 'role-managed',
  is_everyone: 'role-is-everyone',
  missing: 'role-missing',
};

export class EffectGateway {
  constructor(private readonly deps: EffectGatewayDeps) {}

  /**
   * Applies one role change, or explains why it did not.
   *
   * `auth` cannot be forged by omission and cannot be omitted at all — there is
   * no overload without it. It is nonetheless re-verified below, because the
   * type is erased at runtime and a cast defeats it (amendment 3).
   */
  async applyRoleEffect(
    auth: Authorized<'roles.mutate'>,
    intent: RoleIntent,
  ): Promise<EffectOutcome> {
    const { deps } = this;
    const now = deps.now();
    const refuse = (reason: RefusalReason): EffectOutcome => {
      deps.logger.warn(
        safeLogFields({
          component: 'effects',
          guildId: deps.guildId,
          userId: intent.userId,
          roleId: intent.roleId,
          action: intent.action,
          batchId: intent.batchId,
          panelId: intent.panelId,
          outcome: 'refused',
          reason,
        }),
        'effect refused',
      );
      return { status: 'refused', reason };
    };

    // --- 1. authorization, re-verified ------------------------------------
    // The witness says the check passed. It is erased at runtime and a cast
    // produces one for free, so the check is done again against the same
    // capability_grants table. One indexed lookup on a composite primary key.
    const recheck = authorize(
      { store: deps.authz, guildId: deps.guildId, actor: auth.actor },
      capabilityOf(auth),
    );
    if (!recheck.ok || auth.guildId !== deps.guildId) return refuse('unauthorized');

    // --- 2, 3. kill switch and breaker ------------------------------------
    const state = deps.state.read();
    if (!state) return refuse('guild-unknown');
    if (state.killswitch) return refuse('killswitch');
    if (state.breakerOpen) return refuse('breaker-open');

    // --- 4. panel status (the doctor's disable) ----------------------------
    if (intent.panelId !== undefined && !deps.state.isPanelEnabled(intent.panelId)) {
      return refuse('panel-disabled');
    }

    // --- 5. role allowlist -------------------------------------------------
    // Also a foreign key, so this is the readable refusal rather than the
    // guarantee. The constraint is the guarantee.
    if (!deps.state.isRoleAllowlisted(intent.roleId)) return refuse('role-not-allowlisted');

    // --- 6. protected target ----------------------------------------------
    if (deps.state.isTargetProtected(intent.userId, intent.roleId)) {
      return refuse('protected-target');
    }

    // --- 7. hierarchy and managed, live -----------------------------------
    // Immediately before acting, never cached: the failure mode is somebody
    // reordering roles in the Discord UI months after startup (REVIEW C9).
    const [roles, botPosition, member] = await Promise.all([
      deps.discord.fetchRoles(deps.guildId),
      deps.discord.fetchBotHighestRolePosition(deps.guildId),
      deps.discord.fetchMember(deps.guildId, intent.userId),
    ]);

    const assignability = resolveAssignability(
      roles.find((r) => r.id === intent.roleId),
      botPosition,
      deps.guildId,
    );
    if (!assignability.assignable) return refuse(REFUSAL_BY_ASSIGNABILITY[assignability.reason]);

    // Discord never lets a bot act on the guild owner, whatever the hierarchy
    // says. Refusing here turns a confusing 403 into a stated reason.
    if (member.isGuildOwner) return refuse('protected-target');

    // --- no-op check -------------------------------------------------------
    // Convergence diffs against the member's LIVE roles (amendment 4), so by
    // this point we know the real state. A grant of a role already held is not
    // an error and not a rate-cap cost; it is simply nothing to do.
    const hadRoleBefore = member.roleIds.includes(intent.roleId);
    const wouldChange = intent.action === 'grant' ? !hadRoleBefore : hadRoleBefore;
    if (!wouldChange) return { status: 'skipped', reason: 'no-change-needed' };

    // --- 8. rate cap -------------------------------------------------------
    if (!deps.rateLimiter.take(intent.source, now)) {
      // Overflow is not a wait: it is evidence something is wrong. The breaker
      // opens durably so a restart does not resume the storm.
      deps.state.tripBreaker(`rate cap exceeded by source '${intent.source}'`, now);
      return refuse('rate-cap');
    }

    // --- 9. idempotency ----------------------------------------------------
    // Before the REST call, deliberately. If the process dies between the claim
    // and the call, the effect is recorded as attempted and a replay skips it —
    // the failure direction that does not double-grant.
    const dedupeKey = dedupeKeyFor(deps.guildId, intent);
    const claim = deps.effects.claim({ dedupeKey, intent, hadRoleBefore, atMs: now });
    if (!claim.claimed) return { status: 'skipped', reason: 'already-applied' };

    // --- 10. dry run -------------------------------------------------------
    if (state.dryRun) {
      deps.effects.record({ effectId: claim.effectId, state: 'dry_run', completedAtMs: now });
      this.#audit(auth.actor, intent, hadRoleBefore, true, now);
      deps.logger.info(
        safeLogFields({
          component: 'effects',
          guildId: deps.guildId,
          userId: intent.userId,
          roleId: intent.roleId,
          action: intent.action,
          batchId: intent.batchId,
          effectId: claim.effectId,
          dryRun: true,
          outcome: 'dry-run',
        }),
        'dry run: no Discord call was made',
      );
      return { status: 'dry-run', effectId: claim.effectId, hadRoleBefore };
    }

    // --- 11. execute -------------------------------------------------------
    try {
      if (intent.action === 'grant') {
        await deps.discord.addRole(deps.guildId, intent.userId, intent.roleId, intent.reason);
      } else {
        await deps.discord.removeRole(deps.guildId, intent.userId, intent.roleId, intent.reason);
      }
    } catch (err) {
      const code = err instanceof Error ? err.name : 'UnknownError';
      deps.effects.record({
        effectId: claim.effectId,
        state: 'failed',
        completedAtMs: deps.now(),
        errorCode: code,
      });
      deps.logger.error(
        safeLogFields({
          component: 'effects',
          guildId: deps.guildId,
          userId: intent.userId,
          roleId: intent.roleId,
          action: intent.action,
          batchId: intent.batchId,
          effectId: claim.effectId,
          outcome: 'failed',
          code,
          err,
        }),
        'the Discord call failed',
      );
      return { status: 'failed', effectId: claim.effectId, code };
    }

    // --- 12. record --------------------------------------------------------
    const completedAt = deps.now();
    deps.effects.record({ effectId: claim.effectId, state: 'applied', completedAtMs: completedAt });
    this.#audit(auth.actor, intent, hadRoleBefore, false, completedAt);

    return { status: 'applied', effectId: claim.effectId, hadRoleBefore };
  }

  /**
   * `had_role_before` is what makes undo possible: without it, undoing a grant
   * cannot distinguish "we added this role" from "they already had it and we
   * did nothing".
   */
  #audit(
    actor: Actor,
    intent: RoleIntent,
    hadRoleBefore: boolean,
    dryRun: boolean,
    atMs: number,
  ): void {
    this.deps.audit.record({
      actor,
      action: intent.action === 'grant' ? 'role.grant' : 'role.revoke',
      subjectType: 'member',
      subjectId: intent.userId,
      batchId: intent.batchId,
      before: { hasRole: hadRoleBefore },
      after: { hasRole: intent.action === 'grant' },
      dryRun,
      atMs,
    });
  }
}
