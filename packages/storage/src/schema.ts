import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { boolCheck, snowflake, snowflakeCheck } from './columns.js';

/**
 * Slice 2a carries one table, so the migration pipeline is demonstrably real
 * rather than scaffolded. The remaining Release 1 tables land in slice 2b with
 * the guild-scope invariant test that governs them.
 *
 * Snowflakes are TEXT because they exceed Number.MAX_SAFE_INTEGER. Timestamps
 * are INTEGER epoch-millis. Every table is STRICT — drizzle-kit cannot emit it,
 * so `scripts/strictify.mjs` adds it after generation and the schema invariant
 * test fails the build if a table ever loses it.
 */
export const guilds = sqliteTable(
  'guilds',
  {
    guildId: snowflake('guild_id').primaryKey(),
    name: text('name').notNull(),
    enabled: integer('enabled').notNull().default(0),

    // docs/18 Layer 6: stops side effects while leaving the process observable.
    killswitch: integer('killswitch').notNull().default(0),
    // docs/18 Layer 4. Defaults on: an unconfigured guild performs no writes.
    dryRun: integer('dry_run').notNull().default(1),

    // docs/18 Layer 3, as amended: the standing per-source ceiling.
    roleRatePerMin: integer('role_rate_per_min').notNull().default(20),
    reconcileBudget: integer('reconcile_budget').notNull().default(25),
    breakerThreshold: integer('breaker_threshold').notNull().default(5),
    breakerState: text('breaker_state').notNull().default('closed'),
    breakerTrippedAt: integer('breaker_tripped_at'),
    breakerReason: text('breaker_reason'),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    // The partition key is format-checked at the database, not only in Zod.
    check('guilds_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('guilds_breaker_state', sql`${t.breakerState} IN ('closed','open')`),
    check('guilds_enabled_bool', boolCheck(t.enabled)),
    check('guilds_killswitch_bool', boolCheck(t.killswitch)),
    check('guilds_dry_run_bool', boolCheck(t.dryRun)),
    check(
      'guilds_positive_limits',
      sql`${t.roleRatePerMin} > 0 AND ${t.reconcileBudget} > 0 AND ${t.breakerThreshold} > 0`,
    ),
  ],
);
