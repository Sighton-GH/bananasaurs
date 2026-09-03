import { and, asc, eq } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { automodInviteAllowlist, automodLinkDomains } from '../schema.js';

/**
 * The two relational lists ADR 0040 §3 names: `invite`'s labelled code
 * allowlist and `link_domain`'s allow/deny lists.
 *
 * Follows `automod-fixtures.ts`'s conventions: every function takes a
 * `GuildScope` first, every query goes through `scope.only(...)`, and
 * `onConflictDoNothing` is targeted at the primary key so a replayed add is a
 * no-op rather than a thrown duplicate-key error.
 *
 * Both tables carry composite foreign keys back to `mod_rules(guild_id,
 * rule_id)` with `ON DELETE CASCADE`, so a deleted rule cannot leave an
 * orphaned list row behind.
 */

export interface InviteAllowlistEntry {
  readonly code: string;
  readonly label: string;
}

export interface LinkDomainEntry {
  readonly domain: string;
  readonly listType: 'allow' | 'deny';
}

/**
 * `ruleId`'s invite allowlist, ordered by `code`.
 *
 * Deterministic order is not cosmetic: this feeds `hydrate`, which feeds
 * `AutomodRule.inviteAllowlist`, which the rule fingerprint hashes after its
 * own sort — so this ordering is belt and braces, not load-bearing on its
 * own, but a digest that changed with the query plan would recompile every
 * matcher in the guild at random, and there is no reason to depend on the
 * fingerprint's sort alone when the query can be deterministic for free.
 */
export const listInviteAllowlist = (
  scope: GuildScope,
  ruleId: string,
): readonly InviteAllowlistEntry[] =>
  read(scope, (db) =>
    db
      .select({ code: automodInviteAllowlist.code, label: automodInviteAllowlist.label })
      .from(automodInviteAllowlist)
      .where(scope.only(automodInviteAllowlist, eq(automodInviteAllowlist.ruleId, ruleId)))
      .orderBy(asc(automodInviteAllowlist.code))
      .all(),
  );

export interface AddInviteAllowlistEntryInput {
  readonly ruleId: string;
  readonly code: string;
  readonly label: string;
  readonly now: number;
}

/**
 * Adds one code to `ruleId`'s invite allowlist, or does nothing if the code
 * is already on it (a re-run of the same add is not an error).
 */
export const addInviteAllowlistEntry = (
  scope: GuildScope,
  input: AddInviteAllowlistEntryInput,
): void =>
  write(scope, ({ db }) => {
    db.insert(automodInviteAllowlist)
      .values({
        guildId: scope.guildId,
        ruleId: input.ruleId,
        code: input.code,
        label: input.label,
        addedAt: input.now,
      })
      .onConflictDoNothing({
        target: [
          automodInviteAllowlist.guildId,
          automodInviteAllowlist.ruleId,
          automodInviteAllowlist.code,
        ],
      })
      .run();
  });

/** Returns whether there was an entry to remove. False is a real answer. */
export const removeInviteAllowlistEntry = (
  scope: GuildScope,
  ruleId: string,
  code: string,
): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .delete(automodInviteAllowlist)
      .where(
        scope.only(
          automodInviteAllowlist,
          and(eq(automodInviteAllowlist.ruleId, ruleId), eq(automodInviteAllowlist.code, code)),
        ),
      )
      .run();
    return result.changes > 0;
  });

/**
 * `ruleId`'s allow and deny domain lists together, ordered by `domain`.
 *
 * One query, one table, `listType` distinguishes the two lists — see the
 * schema comment on `automodLinkDomains` for why this is one table rather
 * than two.
 */
export const listLinkDomains = (scope: GuildScope, ruleId: string): readonly LinkDomainEntry[] =>
  read(scope, (db) =>
    db
      .select({ domain: automodLinkDomains.domain, listType: automodLinkDomains.listType })
      .from(automodLinkDomains)
      .where(scope.only(automodLinkDomains, eq(automodLinkDomains.ruleId, ruleId)))
      .orderBy(asc(automodLinkDomains.domain))
      .all()
      .map((row) => ({ domain: row.domain, listType: row.listType as 'allow' | 'deny' })),
  );

export interface AddLinkDomainInput {
  readonly ruleId: string;
  readonly domain: string;
  readonly listType: 'allow' | 'deny';
  readonly now: number;
}

/**
 * Adds one domain to `ruleId`'s allow or deny list, or does nothing if it is
 * already on it.
 *
 * Lower-cases the domain and strips a leading `www.` before storing, so the
 * list holds one canonical form and `www.example.com` and `example.com`
 * cannot both be entered as if they were different rows — the primary key
 * would not catch that on its own.
 */
export const addLinkDomain = (scope: GuildScope, input: AddLinkDomainInput): void => {
  const domain = input.domain.toLowerCase().replace(/^www\./, '');
  write(scope, ({ db }) => {
    db.insert(automodLinkDomains)
      .values({
        guildId: scope.guildId,
        ruleId: input.ruleId,
        domain,
        listType: input.listType,
        addedAt: input.now,
      })
      .onConflictDoNothing({
        target: [automodLinkDomains.guildId, automodLinkDomains.ruleId, automodLinkDomains.domain],
      })
      .run();
  });
};

/** Returns whether there was a domain to remove. False is a real answer. */
export const removeLinkDomain = (scope: GuildScope, ruleId: string, domain: string): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .delete(automodLinkDomains)
      .where(
        scope.only(
          automodLinkDomains,
          and(eq(automodLinkDomains.ruleId, ruleId), eq(automodLinkDomains.domain, domain)),
        ),
      )
      .run();
    return result.changes > 0;
  });
