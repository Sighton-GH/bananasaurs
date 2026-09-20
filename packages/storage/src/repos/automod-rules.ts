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

/**
 * One rule by id, enabled or disabled, with its word list assembled.
 *
 * The same select as `listEnabledRules` with `eq(modRules.ruleId, ruleId)`
 * instead of the enabled filter. Exists for the dashboard's dry run (Slice 8,
 * PR-47): an operator edits a disabled rule, dry-runs it, then enables it —
 * the CLI's enabled-only path (`listEnabledRules(...).find(...)` in
 * `apps/daemon/src/ops/wiring.ts`) is unchanged, since a disabled rule will
 * not match a message in production either.
 */
export const findRuleIncludingDisabled = (
  scope: GuildScope,
  ruleId: string,
): StoredAutomodRule | undefined => {
  const row = read(scope, (db) =>
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
      .where(scope.only(modRules, eq(modRules.ruleId, ruleId)))
      .get(),
  );
  return row === undefined ? undefined : hydrate(scope, row);
};

export interface IsExemptInput {
  readonly authorRoleIds: readonly string[];
  readonly channelId: string;
  readonly parentChannelId?: string | undefined;
  readonly categoryId?: string | undefined;
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
        (row.exemptType === 'channel' &&
          [input.channelId, input.parentChannelId, input.categoryId].includes(row.exemptId)),
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
      .set({
        config: input.config,
        // The config edit voids any sign-off (ADR 0042 Amendment 2). A sign-off
        // attests "I replayed *this rule* against the fixture corpus and it was
        // clean", and this replaces the rule's config wholesale, so the thing
        // that was replayed no longer exists. Left standing, it let an owner
        // sign off a narrow pattern, widen it to something matching half the
        // guild, and enforce on fewer than `min_reviewed_matches` — with
        // PR-29's machine-checked corpus pass having been run against a
        // different rule.
        //
        // `cutover_state` is deliberately *not* reset here: a config edit is not
        // a rollback, and the rule has still served whatever observe window it
        // served. Only the attestation about the config is void.
        enforceSignedOffBy: null,
        enforceSignedOffAt: null,
        updatedAt: input.now,
      })
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
 * Every other `mode` (`'test'`, `'observe'`, or omitted) bypasses the *gate*,
 * which exists to guard the one transition ADR 0042 is about — but not the
 * state machine. **This function owns three of PR-27's five arrows** besides
 * `ready → cutover`, because `mode` is the only thing that moves them:
 *
 * | From | To | On |
 * | --- | --- | --- |
 * | `not_started` | `observing` | `mode: 'observe'` — stamps `observe_started_at` |
 * | `cutover` | `rolled_back` | any non-`enforce` `mode` |
 * | `rolled_back` | `observing` | `mode: 'observe'` — **resets** `observe_started_at` |
 *
 * Three properties in that table are load-bearing and each has its own test:
 *
 * - **A rule already `observing` does not restart its clock.** `doctor` reports
 *   rules past their observe floor by comparing `observe_started_at` to now, so
 *   a stamp refreshed on every call would hold every rule permanently
 *   just-started and that check would never fire — ADR 0039's shape.
 * - **`cutover` plus `mode: 'observe'` lands on `rolled_back`, not
 *   `observing`.** One step to `observing` would skip the state that carries the
 *   safety property: `automod ready` refuses from `rolled_back`, which is what
 *   stops a rollback being undone by retrying. Returning to `observing` is a
 *   deliberate second call, and *that* call resets the clock, because a rule
 *   pulled back from enforcement has to earn a fresh window.
 * - **A disable is not a rollback.** `setRuleMode({ enabled: false })` is the
 *   daemon's panic path and requests no mode change; `cutover` means "this rule
 *   has been enforced", which stays true across a pause, and the evidence
 *   behind it does not expire.
 */
export const setRuleMode = (scope: GuildScope, input: SetRuleModeInput): EnforcementEligibility =>
  write(scope, ({ db }) => {
    let cutoverState: CutoverState | undefined;
    let observeStartedAt: number | undefined;
    // `null` writes the column back to NULL; `undefined` leaves it alone.
    let signedOffBy: string | null | undefined;
    let signedOffAt: number | null | undefined;

    if (input.mode === 'enforce') {
      const eligibility = enforcementEligibility(scope, input.ruleId);
      if (!eligibility.ok) return eligibility;
      cutoverState = 'cutover';
    } else if (input.mode !== undefined) {
      // A mode change was actually requested, so the state machine may move.
      // Read the current state rather than inferring it: every arrow below
      // depends on where the rule *is*, and this is the only place that knows.
      const current = db
        .select({ cutoverState: modRules.cutoverState })
        .from(modRules)
        .where(scope.only(modRules, eq(modRules.ruleId, input.ruleId)))
        .get()?.cutoverState as CutoverState | undefined;

      if (current === 'cutover') {
        // Off enforce from `cutover` is a rollback, whatever mode it lands in.
        cutoverState = 'rolled_back';
        // And the rollback withdraws the sign-off. `rolled_back` alone only
        // blocks the direct route back to enforcement; the indirect one —
        // rolled_back -> observing -> ready -> enforce — stayed open, and since
        // a sign-off is the one thing that clears the low-volume floor, a stale
        // one let the rule re-enforce on fewer than `min_reviewed_matches`,
        // making the fresh window it was sent to serve count for nothing.
        //
        // A sign-off attests "I replayed this rule against the corpus and it was
        // clean". Pulling it out of enforcement says it was not in fact safe, so
        // the attestation behind that decision cannot outlive it. The owner signs
        // off again, against whatever the new window produces.
        signedOffBy = null;
        signedOffAt = null;
      } else if (
        input.mode === 'observe' &&
        (current === 'not_started' || current === 'rolled_back')
      ) {
        // The two states that start a window, and both stamp the clock: a fresh
        // rule has none yet, and a rolled-back one has to earn a new one.
        //
        // `observing` and `ready` are excluded deliberately, not by omission:
        // re-observing an observing rule must not restart its clock, and a
        // `ready` rule an owner sends back to `observe` keeps the window it has
        // already served.
        cutoverState = 'observing';
        observeStartedAt = input.now;
      }
    }

    db.update(modRules)
      .set({
        mode: input.mode,
        enabled: input.enabled === undefined ? undefined : input.enabled ? 1 : 0,
        cutoverState,
        observeStartedAt,
        enforceSignedOffBy: signedOffBy,
        enforceSignedOffAt: signedOffAt,
        updatedAt: input.now,
      })
      .where(scope.only(modRules, eq(modRules.ruleId, input.ruleId)))
      .run();

    return { ok: true };
  });

export interface SetRuleReadyInput {
  readonly ruleId: string;
  readonly now: number;
}

/** The outcome of `automod ready` (Task 6): success, or the actual state that refused it. */
export type SetRuleReadyOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-observing'; readonly state: CutoverState };

/**
 * `automod ready` (ADR 0042 §3/PR-27, Task 6): the fourth of PR-27's five
 * arrows, `observing -> ready` — the explicit human act ADR 0042 exists to
 * require, since a clock elapsing is not the same as a human having looked.
 *
 * **Refused from every state but `observing`, including `ready` itself.**
 * The refusal matters most from `rolled_back`: without this precondition, a
 * rollback could be undone by `ready` then a successful
 * `setRuleMode(mode: 'enforce')` without ever revisiting `observing` — the
 * exact scenario ADR 0042 exists to prevent (PR-27).
 *
 * A rule id with no row reads back as `not_started`, mirroring
 * `enforcementEligibility`'s own treatment of a stale id: no row means no
 * evidence and no state, which is the same refusal a real `not_started` row
 * gets, rather than a distinct "no such rule" branch this function would
 * otherwise have to invent.
 */
export const setRuleReady = (scope: GuildScope, input: SetRuleReadyInput): SetRuleReadyOutcome =>
  write(scope, ({ db }) => {
    const current = db
      .select({ cutoverState: modRules.cutoverState })
      .from(modRules)
      .where(scope.only(modRules, eq(modRules.ruleId, input.ruleId)))
      .get()?.cutoverState as CutoverState | undefined;

    const state = current ?? 'not_started';
    if (state !== 'observing') {
      return { ok: false, reason: 'not-observing', state };
    }

    db.update(modRules)
      .set({ cutoverState: 'ready', updatedAt: input.now })
      .where(scope.only(modRules, eq(modRules.ruleId, input.ruleId)))
      .run();

    return { ok: true };
  });

export interface SetEnforceSignOffInput {
  readonly ruleId: string;
  readonly signedOffBy: string;
  readonly now: number;
}

/**
 * `automod signoff` (ADR 0042 §4/PR-29, Task 6): records
 * `enforce_signed_off_by`/`_at` on a rule.
 *
 * **Deliberately unconditional**, the same way `setRuleConfig` is a plain
 * `UPDATE` that trusts its caller to have already validated the config: the
 * precondition PR-29 actually requires — a clean dry run against the fixture
 * corpus — needs `runDryRun` from `packages/core`, which `packages/storage`
 * may not import (ADR 0014). The command that calls this port (`packages/core`,
 * which can reach both the rule and the corpus) runs that check and refuses
 * before ever calling this function; duplicating a weaker version of the same
 * check here would only be a second place for the two to drift.
 */
export const setEnforceSignOff = (scope: GuildScope, input: SetEnforceSignOffInput): void =>
  write(scope, ({ db }) => {
    db.update(modRules)
      .set({
        enforceSignedOffBy: input.signedOffBy,
        enforceSignedOffAt: input.now,
        updatedAt: input.now,
      })
      .where(scope.only(modRules, eq(modRules.ruleId, input.ruleId)))
      .run();
  });
