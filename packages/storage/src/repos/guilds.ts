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

/** docs/18 Layer 6. Stops side effects while leaving the process observable. */
export const setKillswitch = (scope: GuildScope, on: boolean, now: number): void =>
  write(scope, ({ db }) => {
    db.update(guilds)
      .set({ killswitch: on ? 1 : 0, updatedAt: now })
      .where(scope.only(guilds))
      .run();
  });

export interface SafetyState {
  killswitch: boolean;
  dryRun: boolean;
  breakerOpen: boolean;
  breakerReason: string | null;
  roleRatePerMin: number;
  reconcileBudget: number;
  breakerThreshold: number;
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
