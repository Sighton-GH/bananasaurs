import { and, asc, eq } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import {
  automodInviteAllowlist,
  automodLinkDomains,
  modRuleExemptions,
  modRules,
  wordAllowlist,
  wordCategories,
  wordTerms,
} from '../schema.js';
import type { InviteAllowlistEntry, LinkDomainEntry } from './automod-rule-lists.js';
import { enforcementEligibility, type EnforcementEligibility } from './enforcement-gate.js';

/**
 * Automod rules and the word list `keyword_filter` rules carry.
 *
 * A `mod_rules` row names its `kind` (one of the ten ADR 0040 permits) and
 * carries `config` — a scalar, whole-rule JSON blob validated by
 * `packages/core`'s predicate registry, not here (ADR 0014: storage may not
 * import core, so the string is the boundary; rule 3, CLAUDE.md: it is
 * untrusted input on the way back out just as much as on the way in).
 * `keyword_filter` is the one kind whose settings are *not* in `config`: its
 * word list lives across three more tables — `word_categories`, `word_terms`,
 * `word_allowlist` — the same shape `panels.ts` already established for
 * "several tables, one aggregate". No caller outside this module assembles a
 * `StoredAutomodRule` from parts, because the subscriber (Task 9) builds one
 * fuzzy matcher per rule from exactly this shape, and a rule read without its
 * terms is a rule that silently stops matching.
 *
 * Every function takes a `GuildScope` first, like every repository here.
 * `word_categories`/`word_terms`/`word_allowlist` all carry composite foreign
 * keys back to `mod_rules(guild_id, rule_id)`, so a term cannot belong to
 * another guild's rule even if a caller tried.
 */

export type RuleMode = 'test' | 'observe' | 'enforce';

/**
 * ADR 0042's cutover state machine (PR-27) — where a rule is in the journey
 * from "nobody has looked at it" to enforcing, and whether it has been pulled
 * back. Deliberately **not** the same axis as `RuleMode`: `mode` says what the
 * rule does to a message right now, `cutoverState` says how much evidence
 * stands behind that. A rule can sit in `mode: 'observe'` forever without ever
 * reaching `ready`, and `rolled_back` records a decision that outlives the
 * `mode: 'test'` it is accompanied by.
 */
export type CutoverState = 'not_started' | 'observing' | 'ready' | 'cutover' | 'rolled_back';
export type WordAction = 'log_only' | 'delete' | 'delete_and_case';

/** The ten predicate kinds `mod_rules_kind` permits (ADR 0040). */
export type RuleKind =
  | 'keyword_filter'
  | 'regex'
  | 'invite'
  | 'link_domain'
  | 'mention_spam'
  | 'rapid_spam'
  | 'duplicate_message'
  | 'caps'
  | 'attachment_type'
  | 'emoji';

/**
 * One enabled rule as stored, with its relational word list attached.
 *
 * `config` is the **raw JSON text**, deliberately unparsed. Parsing and
 * validating it belongs to `packages/core`'s predicate registry, which owns
 * the per-kind Zod schemas; storage may not import core and core may not
 * import storage (ADR 0014), so the string is the boundary.
 *
 * `terms` and `allowlist` are empty for every kind but `keyword_filter`,
 * whose data is relational by ADR 0040's split. `inviteAllowlist` and
 * `linkDomains` are the same split applied to `invite` and `link_domain`
 * (ADR 0040 §3): empty for every other kind.
 */
export interface StoredAutomodRule {
  readonly ruleId: string;
  readonly kind: RuleKind;
  readonly mode: RuleMode;
  readonly config: string;
  readonly terms: readonly { text: string; categoryId: string }[];
  readonly allowlist: readonly string[];
  readonly inviteAllowlist: readonly InviteAllowlistEntry[];
  readonly linkDomains: readonly LinkDomainEntry[];

  /**
   * ADR 0042's cutover-gate columns. Read on every rule, of every kind: the
   * gate is a property of a rule's evidence, not of its predicate, and a
   * `kind` branch here would be a second place to update when a kind is added
   * (the same reasoning the `hydrate` comment below gives for the lists).
   *
   * `countsAsViolation` is a boolean here and an INTEGER in SQLite;
   * `maxFalsePositiveRate` and `minReviewedMatches` are this rule's own
   * thresholds rather than constants, because ADR 0042 §4 lets a high-stakes
   * rule demand a stricter rate than the 5% default.
   */
  readonly cutoverState: CutoverState;
  readonly observeStartedAt: number | null;
  readonly legacyRuleRef: string | null;
  readonly countsAsViolation: boolean;
  readonly maxFalsePositiveRate: number;
  readonly minReviewedMatches: number;
  readonly enforceSignedOffBy: string | null;
  readonly enforceSignedOffAt: number | null;
}

type RuleRow = {
  ruleId: string;
  kind: string;
  mode: string;
  config: string;
  cutoverState: string;
  observeStartedAt: number | null;
  legacyRuleRef: string | null;
  countsAsViolation: number;
  maxFalsePositiveRate: number;
  minReviewedMatches: number;
  enforceSignedOffBy: string | null;
  enforceSignedOffAt: number | null;
};

/**
 * Assembles one rule's word list from its three tables.
 *
 * Separate queries per table (and per category, for terms) rather than a
 * join, deliberately, mirroring `panels.ts`'s `hydrate`: a join across
 * categories and terms multiplies rows and needs de-duplicating in code,
 * which is where the bug would be. A guild's word list is small.
 *
 * Every kind but `keyword_filter` simply has no `word_categories` rows, so
 * `terms`/`allowlist` come back `[]` naturally — no branch on `kind` needed
 * here. The same is true of `inviteAllowlist` and `linkDomains` below: every
 * kind but `invite`/`link_domain` has no rows in those tables either, so they
 * are queried unconditionally too, with no branch on `kind` (Task 6, plan
 * Step 6) — a `kind` branch here would be a second place that has to be
 * updated when a kind is added.
 */
const hydrate = (scope: GuildScope, row: RuleRow): StoredAutomodRule =>
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

    // Ordered by `code`/`domain`: this feeds the rule fingerprint, and a
    // digest that changed with the query plan would recompile every matcher
    // in the guild at random (the fingerprint also sorts, so this is belt and
    // braces, matching `automod-rule-lists.ts`'s own repository functions).
    const inviteAllowlist = db
      .select({ code: automodInviteAllowlist.code, label: automodInviteAllowlist.label })
      .from(automodInviteAllowlist)
      .where(scope.only(automodInviteAllowlist, eq(automodInviteAllowlist.ruleId, row.ruleId)))
      .orderBy(asc(automodInviteAllowlist.code))
      .all();

    const linkDomains = db
      .select({ domain: automodLinkDomains.domain, listType: automodLinkDomains.listType })
      .from(automodLinkDomains)
      .where(scope.only(automodLinkDomains, eq(automodLinkDomains.ruleId, row.ruleId)))
      .orderBy(asc(automodLinkDomains.domain))
      .all()
      .map((r) => ({ domain: r.domain, listType: r.listType as 'allow' | 'deny' }));

    return {
      ruleId: row.ruleId,
      kind: row.kind as RuleKind,
      mode: row.mode as RuleMode,
      config: row.config,
      terms,
      allowlist,
      inviteAllowlist,
      linkDomains,
      cutoverState: row.cutoverState as CutoverState,
      observeStartedAt: row.observeStartedAt,
      legacyRuleRef: row.legacyRuleRef,
      countsAsViolation: row.countsAsViolation === 1,
      maxFalsePositiveRate: row.maxFalsePositiveRate,
      minReviewedMatches: row.minReviewedMatches,
      enforceSignedOffBy: row.enforceSignedOffBy,
      enforceSignedOffAt: row.enforceSignedOffAt,
    };
  });

/**
 * Every enabled rule, of any kind, with its word list assembled (empty for
 * every kind but `keyword_filter`).
 *
 * The subscriber (Task 9) calls this once per message and builds/caches one
 * matcher per rule from the result — a disabled rule never reaches it, which
 * is the whole of what "disabled" means here (there is no separate enforcement
 * check downstream).
 */
export const listEnabledRules = (scope: GuildScope): readonly StoredAutomodRule[] => {
  const rows = read(scope, (db) =>
    db
      .select({
        ruleId: modRules.ruleId,
        kind: modRules.kind,
        mode: modRules.mode,
        config: modRules.config,
        cutoverState: modRules.cutoverState,
        observeStartedAt: modRules.observeStartedAt,
        legacyRuleRef: modRules.legacyRuleRef,
        countsAsViolation: modRules.countsAsViolation,
        maxFalsePositiveRate: modRules.maxFalsePositiveRate,
        minReviewedMatches: modRules.minReviewedMatches,
        enforceSignedOffBy: modRules.enforceSignedOffBy,
        enforceSignedOffAt: modRules.enforceSignedOffAt,
      })
      .from(modRules)
      .where(scope.only(modRules, eq(modRules.enabled, 1)))
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

/**
 * Whether `ruleId` has any **role**-type exemption configured.
 *
 * Exists so the subscriber (Task 9) can decide whether it needs the author's
 * role ids *before* paying for them: `isExempt` above takes them as input,
 * and the only source of a member's live roles is `DiscordPort.fetchMember`,
 * an uncached REST call. A guild whose rules exempt only channels — or
 * nothing at all, which is the seeded default — never makes that call.
 */
export const hasRoleExemption = (scope: GuildScope, ruleId: string): boolean =>
  read(
    scope,
    (db) =>
      db
        .select({ exemptId: modRuleExemptions.exemptId })
        .from(modRuleExemptions)
        .where(
          scope.only(
            modRuleExemptions,
            and(eq(modRuleExemptions.ruleId, ruleId), eq(modRuleExemptions.exemptType, 'role')),
          ),
        )
        .get() !== undefined,
  );

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
 * Deliberately narrower than `listEnabledRules`: a `test` or `observe` rule
 * never calls `deleteMessage` (Task 9's subscriber), so a missing
 * `Manage Messages` there is not yet a finding — only `enforce` mode makes
 * the permission load-bearing.
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
 * Deliberately broader than `listEnabledRules`: that function answers "what
 * should the subscriber match against right now", which is correctly silent
 * about a disabled rule. This answers a different question —
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

export interface RuleKindAndConfig {
  readonly kind: RuleKind;
  /** Raw JSON text, unparsed — same boundary reasoning as `StoredAutomodRule.config`. */
  readonly config: string;
}

/**
 * A rule's `kind` and raw `config`, or `undefined` if no rule with this id
 * exists — enabled or disabled, mirroring `ruleExists` (IMPORTANT-7, review
 * of Slices 3+5).
 *
 * `ruleExists` alone answers "does this id name a rule", which is not enough
 * to guard `automod invite-allow` / `invite-deny` / `domain-add` / `domain-rm`:
 * those four commands each require one specific `kind`, and a rule id that
 * exists but is the wrong kind (a `keyword_filter` rule handed to
 * `invite-allow`, say) writes a row nothing will ever read. The composition
 * root uses `kind` for that check, and `config` for `link_domain`'s
 * `config.mode` — needed to report what an empty active list means
 * (CRITICAL-2) — without a second read for it.
 */
export const findRuleKindAndConfig = (
  scope: GuildScope,
  ruleId: string,
): RuleKindAndConfig | undefined => {
  const row = read(scope, (db) =>
    db
      .select({ kind: modRules.kind, config: modRules.config })
      .from(modRules)
      .where(scope.only(modRules, eq(modRules.ruleId, ruleId)))
      .get(),
  );
  return row === undefined ? undefined : { kind: row.kind as RuleKind, config: row.config };
};

export interface CreateRuleInput {
  readonly ruleId: string;
  readonly kind: RuleKind;
  readonly name: string;
  /**
   * Serialised JSON. The caller must validate it with core's
   * `validateRuleConfig(kind, config)` first — the CHECK cannot (ADR 0040 §2,
   * `setRuleConfig`'s doc comment below has the full reasoning).
   */
  readonly config: string;
  readonly now: number;
}

/**
 * Creates a rule of any of the ten ADR 0040 kinds, always starting in
 * `mode: 'test'` (spec §8: automod ships observing, not enforcing, until an
 * owner opts in), whatever mode a later `setRuleMode` call moves it to.
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
        kind: input.kind,
        name: input.name,
        config: input.config,
        mode: 'test',
        enabled: 1,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .run();
  });

export interface SetRuleConfigInput {
  readonly ruleId: string;
  /** Serialised JSON, already validated against the kind's schema by core. */
  readonly config: string;
  readonly now: number;
}

/**
 * Replaces a rule's config wholesale — not a merge. A partial update would
 * need a read-modify-write, and the caller that has a validated config
 * object already has the whole of it.
 *
 * **The caller must call `validateRuleConfig(kind, config)` from
 * `packages/core` first and refuse the write on `{ok: false}`.** This
 * function does not, and cannot: ADR 0014 keeps the per-kind Zod schemas in
 * core and bars storage from importing core's predicate registry, so this is
 * a plain `UPDATE` with no validation of its own. ADR 0040 §2 requires
 * `mod_rules.config` to be validated on write as well as on read (the read
 * side is `compileRule`, called by the subscriber and by `doctor`) — the
 * write-side guard has to live at the call site for exactly that reason.
 */
export const setRuleConfig = (scope: GuildScope, input: SetRuleConfigInput): void =>
  write(scope, ({ db }) => {
    db.update(modRules)
      .set({ config: input.config, updatedAt: input.now })
      .where(scope.only(modRules, eq(modRules.ruleId, input.ruleId)))
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
 *
 * **The only write path to `mode = 'enforce'` (ADR 0042 §3), and it is
 * gated.** A request for `mode: 'enforce'` is checked against
 * `enforcementEligibility` before anything is written; a refusal writes
 * nothing at all — not the mode, not `enabled`, not `updatedAt` — so a
 * refused request leaves the row exactly as it was. On success, the same
 * write advances `cutover_state` from `ready` (or an already-`cutover` rule)
 * to `cutover` (PR-27): a gate that permitted enforcement without recording
 * that it happened would leave `doctor` unable to tell an enforced rule from
 * one merely eligible.
 *
 * Every other `mode` (`'test'`, `'observe'`, or omitted) bypasses the gate
 * entirely — it exists to guard the one transition ADR 0042 is about.
 */
export const setRuleMode = (scope: GuildScope, input: SetRuleModeInput): EnforcementEligibility =>
  write(scope, ({ db }) => {
    let cutoverState: CutoverState | undefined;
    if (input.mode === 'enforce') {
      const eligibility = enforcementEligibility(scope, input.ruleId);
      if (!eligibility.ok) return eligibility;
      cutoverState = 'cutover';
    }

    db.update(modRules)
      .set({
        mode: input.mode,
        enabled: input.enabled === undefined ? undefined : input.enabled ? 1 : 0,
        cutoverState,
        updatedAt: input.now,
      })
      .where(scope.only(modRules, eq(modRules.ruleId, input.ruleId)))
      .run();

    return { ok: true };
  });
