import { and, eq } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import {
  modRuleExemptions,
  modRules,
  wordAllowlist,
  wordCategories,
  wordTerms,
} from '../schema.js';

/**
 * Automod rules and the word list each one carries.
 *
 * A `mod_rules` row names a `keyword_filter` (ADR 0035's only predicate kind
 * this slice implements); its word list lives across three more tables —
 * `word_categories`, `word_terms`, `word_allowlist` — the same shape
 * `panels.ts` already established for "several tables, one aggregate": no
 * caller outside this module assembles a `RuleWithWordList` from parts,
 * because the subscriber (Task 9) builds one fuzzy matcher per rule from
 * exactly this shape, and a rule read without its terms is a rule that
 * silently stops matching.
 *
 * Every function takes a `GuildScope` first, like every repository here.
 * `word_categories`/`word_terms`/`word_allowlist` all carry composite foreign
 * keys back to `mod_rules(guild_id, rule_id)`, so a term cannot belong to
 * another guild's rule even if a caller tried.
 */

export type RuleMode = 'test' | 'observe' | 'enforce';
export type WordAction = 'log_only' | 'delete' | 'delete_and_case';

/**
 * What the automod subscriber (Task 9) needs to build a matcher and log a
 * hit: the rule's own id and mode, its flattened terms, and its allowlist.
 * Deliberately does not carry categories' `defaultAction` or terms'
 * `actionOverride` — Task 9's plan records every hit as `'deleted'` (or an
 * escalation variant) regardless of category, so those columns exist for a
 * later release's per-category action to read, not this one.
 */
export interface RuleWithWordList {
  readonly ruleId: string;
  readonly mode: RuleMode;
  readonly terms: readonly { text: string; categoryId: string }[];
  readonly allowlist: readonly string[];
}

type RuleRow = { ruleId: string; mode: string };

/**
 * Assembles one rule's word list from its three tables.
 *
 * Separate queries per table (and per category, for terms) rather than a
 * join, deliberately, mirroring `panels.ts`'s `hydrate`: a join across
 * categories and terms multiplies rows and needs de-duplicating in code,
 * which is where the bug would be. A guild's word list is small.
 */
const hydrate = (scope: GuildScope, row: RuleRow): RuleWithWordList =>
  read(scope, (db) => {
    const categories = db
      .select({ categoryId: wordCategories.categoryId })
      .from(wordCategories)
      .where(
        scope.only(
          wordCategories,
          and(eq(wordCategories.ruleId, row.ruleId), eq(wordCategories.enabled, 1)),
        ),
      )
      .all();

    const terms = categories.flatMap((category) =>
      db
        .select({ text: wordTerms.text, categoryId: wordTerms.categoryId })
        .from(wordTerms)
        .where(
          scope.only(
            wordTerms,
            and(eq(wordTerms.categoryId, category.categoryId), eq(wordTerms.enabled, 1)),
          ),
        )
        .all(),
    );

    const allowlist = db
      .select({ phrase: wordAllowlist.phrase })
      .from(wordAllowlist)
      .where(scope.only(wordAllowlist, eq(wordAllowlist.ruleId, row.ruleId)))
      .all()
      .map((r) => r.phrase);

    return {
      ruleId: row.ruleId,
      mode: row.mode as RuleMode,
      terms,
      allowlist,
    };
  });

/**
 * Every enabled `keyword_filter` rule, with its word list assembled.
 *
 * The subscriber (Task 9) calls this once per message and builds/caches one
 * matcher per rule from the result — a disabled rule never reaches it, which
 * is the whole of what "disabled" means here (there is no separate enforcement
 * check downstream).
 */
export const listEnabledKeywordFilterRules = (scope: GuildScope): readonly RuleWithWordList[] => {
  const rows = read(scope, (db) =>
    db
      .select({ ruleId: modRules.ruleId, mode: modRules.mode })
      .from(modRules)
      .where(
        scope.only(modRules, and(eq(modRules.kind, 'keyword_filter'), eq(modRules.enabled, 1))),
      )
      .all(),
  );
  return rows.map((row) => hydrate(scope, row));
};

export interface IsExemptInput {
  readonly authorRoleIds: readonly string[];
  readonly channelId: string;
}

/**
 * Whether this message is exempt from `ruleId` by role or by channel.
 *
 * Called once per rule per message (Task 9), before the matcher runs at all —
 * an exempt author or channel never reaches the fuzzy matcher, so an
 * exemption is a skip, not a suppressed action.
 */
export const isExempt = (scope: GuildScope, ruleId: string, input: IsExemptInput): boolean =>
  read(scope, (db) => {
    const rows = db
      .select({ exemptType: modRuleExemptions.exemptType, exemptId: modRuleExemptions.exemptId })
      .from(modRuleExemptions)
      .where(scope.only(modRuleExemptions, eq(modRuleExemptions.ruleId, ruleId)))
      .all();
    return rows.some(
      (row) =>
        (row.exemptType === 'role' && input.authorRoleIds.includes(row.exemptId)) ||
        (row.exemptType === 'channel' && row.exemptId === input.channelId),
    );
  });

export interface EnforceRuleChannelScope {
  readonly ruleId: string;
  /** Channels this rule is exempted from, so `doctor` skips them. */
  readonly exemptChannelIds: readonly string[];
}

/**
 * Every enabled, `mode: 'enforce'` `keyword_filter` rule, with its channel
 * exemptions — the input `doctor`'s `listKeywordFilterRulesMissingManageMessages`
 * (`apps/daemon/src/ops/wiring.ts`) needs to check the bot's live permissions
 * against the rest of the guild's channels.
 *
 * Deliberately narrower than `listEnabledKeywordFilterRules`: a `test` or
 * `observe` rule never calls `deleteMessage` (Task 9's subscriber), so a
 * missing `Manage Messages` there is not yet a finding — only `enforce` mode
 * makes the permission load-bearing.
 */
export const listEnforceModeKeywordFilterRules = (
  scope: GuildScope,
): readonly EnforceRuleChannelScope[] => {
  const rules = read(scope, (db) =>
    db
      .select({ ruleId: modRules.ruleId })
      .from(modRules)
      .where(
        scope.only(
          modRules,
          and(
            eq(modRules.kind, 'keyword_filter'),
            eq(modRules.enabled, 1),
            eq(modRules.mode, 'enforce'),
          ),
        ),
      )
      .all(),
  );

  return rules.map((rule) => ({
    ruleId: rule.ruleId,
    exemptChannelIds: read(scope, (db) =>
      db
        .select({ exemptId: modRuleExemptions.exemptId })
        .from(modRuleExemptions)
        .where(
          scope.only(
            modRuleExemptions,
            and(
              eq(modRuleExemptions.ruleId, rule.ruleId),
              eq(modRuleExemptions.exemptType, 'channel'),
            ),
          ),
        )
        .all(),
    ).map((row) => row.exemptId),
  }));
};

/**
 * Whether a rule with this id exists at all — enabled or disabled.
 *
 * Deliberately broader than `listEnabledKeywordFilterRules`: that function
 * answers "what should the subscriber match against right now", which is
 * correctly silent about a disabled rule. This answers a different question —
 * "has this specific id already been created" — which the daemon's first-run
 * seeding (`apps/daemon/src/runtime/daemon.ts`) needs so that a rule an owner
 * has deliberately disabled does not get a second, conflicting `INSERT`
 * attempted against it on every restart (`mod_rules`' primary key is
 * `(guild_id, rule_id)`).
 */
export const ruleExists = (scope: GuildScope, ruleId: string): boolean =>
  read(
    scope,
    (db) =>
      db
        .select({ ruleId: modRules.ruleId })
        .from(modRules)
        .where(scope.only(modRules, eq(modRules.ruleId, ruleId)))
        .get() !== undefined,
  );

export interface CreateRuleInput {
  readonly ruleId: string;
  readonly name: string;
  readonly now: number;
}

/**
 * Creates a rule. Always `kind: 'keyword_filter'` — the only predicate kind
 * this slice implements (ADR 0035) — and always starts in `mode: 'test'`
 * (spec §8: automod ships observing, not enforcing, until an owner opts in),
 * whatever mode a later `setRuleMode` call moves it to.
 *
 * Callers that might run more than once against the same `ruleId` (the
 * daemon's first-run seeding) must check `ruleExists` first — this function
 * itself is a plain `INSERT` and throws on a duplicate `(guild_id, rule_id)`,
 * matching every other `create*`-named write in this file. Making the insert
 * itself conflict-safe would not have been enough on its own: `addCategory`/
 * `addTerm` right below have the same duplicate-key exposure for a re-run
 * seeding attempt, so the fix belongs at the call site's guard, once, rather
 * than repeated ad hoc across every insert a re-run could repeat.
 */
export const createRule = (scope: GuildScope, input: CreateRuleInput): void =>
  write(scope, ({ db }) => {
    db.insert(modRules)
      .values({
        guildId: scope.guildId,
        ruleId: input.ruleId,
        kind: 'keyword_filter',
        name: input.name,
        mode: 'test',
        enabled: 1,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .run();
  });

export interface AddCategoryInput {
  readonly categoryId: string;
  readonly ruleId: string;
  readonly name: string;
  readonly defaultAction: WordAction;
}

export const addCategory = (scope: GuildScope, input: AddCategoryInput): void =>
  write(scope, ({ db }) => {
    db.insert(wordCategories)
      .values({
        guildId: scope.guildId,
        categoryId: input.categoryId,
        ruleId: input.ruleId,
        name: input.name,
        defaultAction: input.defaultAction,
        enabled: 1,
      })
      .run();
  });

export interface AddTermInput {
  readonly termId: string;
  readonly categoryId: string;
  readonly text: string;
  /** Omitted means the term inherits its category's `defaultAction`. */
  readonly actionOverride?: WordAction;
}

export const addTerm = (scope: GuildScope, input: AddTermInput): void =>
  write(scope, ({ db }) => {
    db.insert(wordTerms)
      .values({
        guildId: scope.guildId,
        termId: input.termId,
        categoryId: input.categoryId,
        text: input.text,
        actionOverride: input.actionOverride ?? null,
        enabled: 1,
      })
      .run();
  });

export interface AddAllowlistPhraseInput {
  readonly ruleId: string;
  readonly phrase: string;
}

/** Wired into obscenity's own allowlist mechanism at match time (Task 4/9). */
export const addAllowlistPhrase = (scope: GuildScope, input: AddAllowlistPhraseInput): void =>
  write(scope, ({ db }) => {
    db.insert(wordAllowlist)
      .values({ guildId: scope.guildId, ruleId: input.ruleId, phrase: input.phrase })
      .run();
  });

export interface AddRoleExemptionInput {
  readonly ruleId: string;
  readonly roleId: string;
}

export const addRoleExemption = (scope: GuildScope, input: AddRoleExemptionInput): void =>
  write(scope, ({ db }) => {
    db.insert(modRuleExemptions)
      .values({
        guildId: scope.guildId,
        ruleId: input.ruleId,
        exemptType: 'role',
        exemptId: input.roleId,
      })
      .run();
  });

export interface AddChannelExemptionInput {
  readonly ruleId: string;
  readonly channelId: string;
}

export const addChannelExemption = (scope: GuildScope, input: AddChannelExemptionInput): void =>
  write(scope, ({ db }) => {
    db.insert(modRuleExemptions)
      .values({
        guildId: scope.guildId,
        ruleId: input.ruleId,
        exemptType: 'channel',
        exemptId: input.channelId,
      })
      .run();
  });

export interface SetRuleModeInput {
  readonly ruleId: string;
  /** Omitted leaves the stored mode unchanged. */
  readonly mode?: RuleMode;
  /** Omitted leaves enabled/disabled unchanged. */
  readonly enabled?: boolean;
  readonly now: number;
}

/**
 * Updates a rule's mode and/or enabled flag. Both are optional so a caller
 * flipping one does not have to first read the other back — an owner turning
 * a rule off is not making a statement about what mode it should resume in.
 */
export const setRuleMode = (scope: GuildScope, input: SetRuleModeInput): void =>
  write(scope, ({ db }) => {
    db.update(modRules)
      .set({
        mode: input.mode,
        enabled: input.enabled === undefined ? undefined : input.enabled ? 1 : 0,
        updatedAt: input.now,
      })
      .where(scope.only(modRules, eq(modRules.ruleId, input.ruleId)))
      .run();
  });
