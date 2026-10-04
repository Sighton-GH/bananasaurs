import { and, asc, eq } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { auditEvents, channelReadScope, channelReadSeeds } from '../schema.js';

/**
 * The Read switch's scope (ADR 0126): the channels and categories the
 * assistant may read. Every function takes a `GuildScope` first and scopes
 * through `scope.only`, like every repository here.
 */

export interface ReadScopeRow {
  readonly channelId: string;
  readonly scopeKind: 'channel' | 'category';
  readonly addedAt: number;
}

type ScopeKind = 'channel' | 'category';

/** Inserts the row; an already-allowed channel is a no-op reported as false. */
export const allowRead = (
  scope: GuildScope,
  input: { channelId: string; scopeKind: ScopeKind; now: number },
): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .insert(channelReadScope)
      .values({
        guildId: scope.guildId,
        channelId: input.channelId,
        scopeKind: input.scopeKind,
        addedAt: input.now,
      })
      .onConflictDoNothing({ target: [channelReadScope.guildId, channelReadScope.channelId] })
      .run();
    return result.changes === 1;
  });

/** Deletes the row whose kind matches the verb; the other kind is `'wrong-kind'` and kept. */
export const disallowRead = (
  scope: GuildScope,
  channelId: string,
  scopeKind: ScopeKind,
): 'removed' | 'not-allowed' | 'wrong-kind' =>
  write(scope, ({ db }) => {
    const row = db
      .select({ scopeKind: channelReadScope.scopeKind })
      .from(channelReadScope)
      .where(scope.only(channelReadScope, eq(channelReadScope.channelId, channelId)))
      .get();
    if (row === undefined) return 'not-allowed';
    if (row.scopeKind !== scopeKind) return 'wrong-kind';
    db.delete(channelReadScope)
      .where(
        and(
          scope.only(channelReadScope, eq(channelReadScope.channelId, channelId)),
          eq(channelReadScope.scopeKind, scopeKind),
        ),
      )
      .run();
    return 'removed';
  });

export const isReadScopeAllowed = (
  scope: GuildScope,
  channelId: string,
  scopeKind: ScopeKind,
): boolean =>
  read(
    scope,
    (db) =>
      db
        .select({ channelId: channelReadScope.channelId })
        .from(channelReadScope)
        .where(
          scope.only(
            channelReadScope,
            and(
              eq(channelReadScope.channelId, channelId),
              eq(channelReadScope.scopeKind, scopeKind),
            ),
          ),
        )
        .get() !== undefined,
  );

export const listReadScope = (scope: GuildScope): readonly ReadScopeRow[] =>
  read(scope, (db) =>
    db
      .select()
      .from(channelReadScope)
      .where(scope.only(channelReadScope))
      .orderBy(asc(channelReadScope.addedAt), asc(channelReadScope.channelId))
      .all()
      .map((row) => ({
        channelId: row.channelId,
        scopeKind: row.scopeKind as ScopeKind,
        addedAt: row.addedAt,
      })),
  );

/**
 * One transaction: claims the once-only marker, and inserts the rows only
 * when the claim succeeded. Empty `targets` claims nothing, so a later call
 * with targets still seeds. Existing rows are never overwritten.
 */
export const seedReadScopeOnce = (
  scope: GuildScope,
  input: { targets: readonly { channelId: string; scopeKind: ScopeKind }[]; now: number },
): 'seeded' | 'already-seeded' | 'nothing-to-seed' =>
  write(scope, ({ db }) => {
    if (input.targets.length === 0) return 'nothing-to-seed';
    const claim = db
      .insert(channelReadSeeds)
      .values({ guildId: scope.guildId, seededAt: input.now })
      .onConflictDoNothing({ target: channelReadSeeds.guildId })
      .run();
    if (claim.changes === 0) return 'already-seeded';
    for (const target of input.targets) {
      db.insert(channelReadScope)
        .values({
          guildId: scope.guildId,
          channelId: target.channelId,
          scopeKind: target.scopeKind,
          addedAt: input.now,
        })
        .onConflictDoNothing({ target: [channelReadScope.guildId, channelReadScope.channelId] })
        .run();
    }
    // N8: one audit row per seed, in the same transaction as the marker and
    // the rows — the same `auditEvents` table the `read_scope.allow` command
    // rows use. A system actor, the target count in `after`, and nothing on
    // the already-seeded or nothing-to-seed paths.
    db.insert(auditEvents)
      .values({
        guildId: scope.guildId,
        at: input.now,
        actorType: 'system',
        actorId: null,
        action: 'read_scope.seed',
        subjectType: 'guild',
        subjectId: scope.guildId,
        before: null,
        after: JSON.stringify({ targetCount: input.targets.length }),
        dryRun: 0,
      })
      .run();
    return 'seeded';
  });
