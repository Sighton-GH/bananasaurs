import { and, asc, eq, sql } from 'drizzle-orm';
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

/**
 * Removes one code from `ruleId`'s invite allowlist. Returns whether there
 * was an entry to remove — false is a real answer.
 *
 * Matched case-insensitively against the stored, case-preserving `code`
 * (IMPORTANT-2, review of Slices 3+5): `addInviteAllowlistEntry` stores the
 * operator's code verbatim — case-preserving, because the label is for a
 * human reading the list later — and `invite.ts`'s predicate already
 * matches codes case-insensitively (`code.toLowerCase()`), so removal must
 * use the same rule or `automod invite-deny r1 CLUBHOUSE` silently fails to
 * remove `clubhouse`. This is deliberate consistency with the predicate, not
 * drift from the add path's case-preserving storage.
 */
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
          and(
            eq(automodInviteAllowlist.ruleId, ruleId),
            sql`lower(${automodInviteAllowlist.code}) = lower(${code})`,
          ),
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

/**
 * The one place that knows `link_domain`'s canonical domain form (IMPORTANT-2,
 * review of Slices 3+5): lower-cased, with a leading `www.` stripped, so
 * `www.example.com` and `example.com` cannot both be entered as if they were
 * different rows — the primary key would not catch that on its own. Used by
 * both `addLinkDomain` and `removeLinkDomain` so there is exactly one place
 * to update if the rule ever changes, rather than two copies that can drift
 * (which is exactly how `removeLinkDomain` used to compare verbatim while
 * `addLinkDomain` canonicalised).
 */
const canonicalDomain = (domain: string): string => domain.toLowerCase().replace(/^www\./, '');

export interface AddLinkDomainInput {
  readonly ruleId: string;
  readonly domain: string;
  readonly listType: 'allow' | 'deny';
  readonly now: number;
}

export interface AddLinkDomainResult {
  /** The canonical form actually written or matched, for the caller to look up the stored row. */
  readonly domain: string;
  /** Whether the insert changed anything. False means the domain was already on one of the lists. */
  readonly inserted: boolean;
}

/**
 * Adds one domain to `ruleId`'s allow or deny list, or does nothing if it is
 * already on it — under either `listType`, since the primary key is
 * `(guild, rule, domain)` (IMPORTANT-1, review of Slices 3+5).
 *
 * Returns the canonical domain and whether the insert actually happened,
 * rather than `void`, so the composition root can report the domain's real
 * stored `listType` on a no-op without re-deriving the canonical form itself
 * — that duplication is exactly what let `removeLinkDomain` drift in the
 * first place.
 */
export const addLinkDomain = (
  scope: GuildScope,
  input: AddLinkDomainInput,
): AddLinkDomainResult => {
  const domain = canonicalDomain(input.domain);
  const changes = write(
    scope,
    ({ db }) =>
      db
        .insert(automodLinkDomains)
        .values({
          guildId: scope.guildId,
          ruleId: input.ruleId,
          domain,
          listType: input.listType,
          addedAt: input.now,
        })
        .onConflictDoNothing({
          target: [
            automodLinkDomains.guildId,
            automodLinkDomains.ruleId,
            automodLinkDomains.domain,
          ],
        })
        .run().changes,
  );
  return { domain, inserted: changes > 0 };
};

/**
 * Removes one domain from either of `ruleId`'s lists. Returns whether there
 * was a domain to remove — false is a real answer.
 *
 * Canonicalises before comparing (IMPORTANT-2): `addLinkDomain` stores the
 * canonical form, but until this fix `removeLinkDomain` compared the
 * operator's string verbatim, so `automod domain-rm r1 WWW.Example.COM`
 * deleted nothing for a domain added as `example.com`.
 */
export const removeLinkDomain = (scope: GuildScope, ruleId: string, domain: string): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .delete(automodLinkDomains)
      .where(
        scope.only(
          automodLinkDomains,
          and(
            eq(automodLinkDomains.ruleId, ruleId),
            eq(automodLinkDomains.domain, canonicalDomain(domain)),
          ),
        ),
      )
      .run();
    return result.changes > 0;
  });
