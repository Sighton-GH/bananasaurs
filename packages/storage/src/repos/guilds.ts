import { eq } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { guilds } from '../schema.js';

/**
 * The guilds repository.
 *
 * Every function takes a `GuildScope` first and there is no overload without
 * it. That is the shape every repository in this package follows: the scope
 * carries both the partition key and the database handle, so a caller cannot
 * reach a row without naming a guild, and cannot name a guild it was not given
 * a scope for.
 */

export interface GuildRow {
  guildId: string;
  name: string;
  enabled: number;
  killswitch: number;
  dryRun: number;
  roleRatePerMin: number;
  reconcileBudget: number;
  breakerThreshold: number;
  breakerState: string;
  breakerTrippedAt: number | null;
  breakerReason: string | null;
  automodState: string;
  createdAt: number;
  updatedAt: number;
}

/** The guild this scope names, or undefined if it has never been seen. */
export const findGuild = (scope: GuildScope): GuildRow | undefined =>
  read(scope, (db) => db.select().from(guilds).where(scope.only(guilds)).get());

export interface UpsertGuild {
  name: string;
  enabled?: boolean;
  now: number;
}

/**
 * Records a guild on GUILD_CREATE. Idempotent: a reconnect replays
 * GUILD_CREATE for every guild, so this must not fail or duplicate.
 */
export const upsertGuild = (scope: GuildScope, input: UpsertGuild): void =>
  write(scope, ({ db }) => {
    db.insert(guilds)
      .values({
        guildId: scope.guildId,
        name: input.name,
        enabled: input.enabled === true ? 1 : 0,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: guilds.guildId,
        // Deliberately narrow. A replayed GUILD_CREATE must not reset the kill
        // switch, the dry-run flag, or a tripped breaker back to their
        // defaults — those are operator state, not gateway state.
        set: { name: input.name, updatedAt: input.now },
      })
      .run();
  });

/**
 * docs/18 Layer 4. Written from `BANANASAURS_DRY_RUN` at every start.
 *
 * Deliberately not folded into `upsertGuild`, whose conflict clause is narrow
 * precisely so a replayed GUILD_CREATE cannot reset operator state. This is the
 * opposite case: an explicit statement of intent from the environment, applied
 * once at startup by the composition root (ADR 0020).
 */
export const setDryRun = (scope: GuildScope, on: boolean, now: number): void =>
  write(scope, ({ db }) => {
    db.update(guilds)
      .set({ dryRun: on ? 1 : 0, updatedAt: now })
      .where(scope.only(guilds))
      .run();
  });

/** docs/18 Layer 6. Stops side effects while leaving the process observable. */
export const setKillswitch = (scope: GuildScope, on: boolean, now: number): void =>
  write(scope, ({ db }) => {
    db.update(guilds)
      .set({ killswitch: on ? 1 : 0, updatedAt: now })
      .where(scope.only(guilds))
      .run();
  });

/** ADR 0121's three positions. Validated at the HTTP boundary by Zod. */
export type AutomodState = 'off' | 'watch' | 'on';
export const AUTOMOD_STATES: readonly AutomodState[] = ['off', 'watch', 'on'];

// Fail closed: anything unrecognised reads as off. The `guilds_automod_state`
// CHECK (migration 0101) makes such a row impossible to write; this stays as
// the guard for one written with CHECKs off.
const toAutomodState = (raw: string): AutomodState =>
  raw === 'watch' || raw === 'on' ? raw : 'off';

/** ADR 0121: sets the guild's automod switch. Guild-scoped by signature. */
export const setAutomodState = (scope: GuildScope, state: AutomodState, now: number): void =>
  write(scope, ({ db }) => {
    db.update(guilds).set({ automodState: state, updatedAt: now }).where(scope.only(guilds)).run();
  });

export interface SafetyState {
  killswitch: boolean;
  dryRun: boolean;
  breakerOpen: boolean;
  breakerReason: string | null;
  roleRatePerMin: number;
  reconcileBudget: number;
  breakerThreshold: number;
  /** ADR 0121's guild-wide automod switch. */
  automodState: AutomodState;
}

/**
 * Everything the effect gateway checks before acting, in one read.
 *
 * One row, one query, on the path every side effect traverses — so the gateway
 * does not make five separate reads to decide whether it may act.
 */
export const readSafetyState = (scope: GuildScope): SafetyState | undefined => {
  const row = findGuild(scope);
  if (!row) return undefined;
  return {
    killswitch: row.killswitch === 1,
    dryRun: row.dryRun === 1,
    breakerOpen: row.breakerState === 'open',
    breakerReason: row.breakerReason,
    roleRatePerMin: row.roleRatePerMin,
    reconcileBudget: row.reconcileBudget,
    breakerThreshold: row.breakerThreshold,
    automodState: toAutomodState(row.automodState),
  };
};

/**
 * Opens the breaker. Durable, so it survives a restart — a breaker that resets
 * on restart is a breaker that a crash loop defeats.
 */
export const tripBreaker = (scope: GuildScope, reason: string, now: number): void =>
  write(scope, ({ db }) => {
    db.update(guilds)
      .set({ breakerState: 'open', breakerTrippedAt: now, breakerReason: reason, updatedAt: now })
      .where(scope.only(guilds, eq(guilds.breakerState, 'closed')))
      .run();
  });

/** Closes the breaker. Deliberately manual: a human decides it is safe. */
export const resetBreaker = (scope: GuildScope, now: number): void =>
  write(scope, ({ db }) => {
    db.update(guilds)
      .set({ breakerState: 'closed', breakerTrippedAt: null, breakerReason: null, updatedAt: now })
      .where(scope.only(guilds))
      .run();
  });

/**
 * The three tunable per-guild limits (`docs/18` layers 3 and 5).
 *
 * A patch rather than three setters: `bananasaurs config set` writes one key at
 * a time, but the caller that widens a rate cap and a reconcile budget together
 * during an incident should do it in one transaction, not two.
 *
 * An empty patch writes nothing — **including `updated_at`**. That is the whole
 * of the guard's job, and worth stating because the obvious reason is wrong: it
 * is not that drizzle raises on an update with no columns, since `updatedAt` is
 * always in the `set` and the statement is never empty. It is that
 * `guilds.updated_at` is evidence about when the guild's configuration last
 * changed, and a call that changed nothing must not claim it did.
 *
 * The `guilds_positive_limits` CHECK is left to reject a zero, so a caller that
 * skipped validation still cannot install a rate cap that silently stops every
 * role change.
 */
export interface LimitsPatch {
  roleRatePerMin?: number | undefined;
  reconcileBudget?: number | undefined;
  breakerThreshold?: number | undefined;
}

export const setLimits = (scope: GuildScope, patch: LimitsPatch, now: number): void =>
  write(scope, ({ db }) => {
    const set: Record<string, number> = {};
    if (patch.roleRatePerMin !== undefined) set['roleRatePerMin'] = patch.roleRatePerMin;
    if (patch.reconcileBudget !== undefined) set['reconcileBudget'] = patch.reconcileBudget;
    if (patch.breakerThreshold !== undefined) set['breakerThreshold'] = patch.breakerThreshold;
    if (Object.keys(set).length === 0) return;

    db.update(guilds)
      .set({ ...set, updatedAt: now })
      .where(scope.only(guilds))
      .run();
  });
