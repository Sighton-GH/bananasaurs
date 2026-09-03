import type { MessageAttachment } from '../../discord/events.js';

/**
 * The ten predicate kinds `mod_rules_kind` permits (ADR 0040).
 *
 * Mirrors `packages/storage/src/repos/automod-rules.ts`'s `RuleKind` field for
 * field. Declared again here rather than imported, per ADR 0014 — `core`
 * depends on the shape, not on `@bananasaurs/storage`. The same arrangement
 * `RuleWithWordList` used before this slice.
 */
export const RULE_KINDS = [
  'keyword_filter',
  'regex',
  'invite',
  'link_domain',
  'mention_spam',
  'rapid_spam',
  'duplicate_message',
  'caps',
  'attachment_type',
  'emoji',
] as const;

export type RuleKind = (typeof RULE_KINDS)[number];

export const isRuleKind = (value: string): value is RuleKind =>
  (RULE_KINDS as readonly string[]).includes(value);

/**
 * One enabled rule as the subscriber sees it, kind-agnostic.
 *
 * Replaces ADR 0035's `RuleWithWordList`, which named `keyword_filter`'s
 * relational data in a type every predicate has to satisfy. `terms` and
 * `allowlist` are empty for every other kind (ADR 0040's split: scalar config
 * in JSON, list-shaped data in tables).
 *
 * `inviteAllowlist` and `linkDomains` are the same split applied to `invite`
 * and `link_domain` (ADR 0040 §3): each a relational list rather than JSON in
 * `config`, because the label/`listType` is per-item metadata and Slice 9's
 * one-click suppression for both predicates is a row edit. Empty for every
 * other kind. Mirrors storage's `StoredAutomodRule` field for field;
 * re-declared here rather than imported, per ADR 0014.
 */
export interface AutomodRule {
  readonly ruleId: string;
  readonly kind: string;
  readonly mode: 'test' | 'observe' | 'enforce';
  /** Raw JSON text from `mod_rules.config`. Untrusted until parsed. */
  readonly config: string;
  readonly terms: readonly { text: string; categoryId: string }[];
  readonly allowlist: readonly string[];
  readonly inviteAllowlist: readonly { code: string; label: string }[];
  readonly linkDomains: readonly { domain: string; listType: 'allow' | 'deny' }[];
}

/**
 * One message, as a predicate sees it.
 *
 * Deliberately not the `MessageEvent` itself: a predicate gets facts about a
 * message and nothing else — no `DiscordPort`, no database handle, no clock it
 * did not receive here. That is what makes Slice 2's invariant (the dry-run
 * evaluator and the live subscriber run the same code) achievable, because a
 * fixture can construct one of these completely.
 */
export interface PredicateInput {
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly authorId: string;
  /**
   * Which gateway event produced this input.
   *
   * Nothing in Slice 1 reads this — `keyword_filter` matches content, not
   * event history — which is expected: it is added now, ahead of need,
   * because the subscriber evaluates both `messageCreate` and
   * `messageUpdate` (`subscriber.ts`'s handler guard) and a predicate has no
   * other way to tell them apart. Slice 4's window-tier predicates
   * (`rapid_spam`, `duplicate_message`) count *events*, and without this a
   * member editing one message five times would count as five messages
   * rather than one — each predicate would have to re-derive "have I already
   * counted this `messageId`" from a fact the subscriber already has.
   * Cheaper to carry the field now than to retrofit it into every predicate's
   * interface and fixtures once the window tier needs it (the same reasoning
   * ADR 0040 gives for carrying `MatchTrace` a slice early).
   */
  readonly eventKind: 'messageCreate' | 'messageUpdate';
  /** Zero-width stripped (`stripZeroWidth`). What content predicates match. */
  readonly content: string;
  /** Exactly as Discord delivered it, for traces that must quote the original. */
  readonly rawContent: string;
  readonly mentionedUserIds: readonly string[];
  readonly mentionedRoleIds: readonly string[];
  readonly mentionsEveryone: boolean;
  readonly attachments: readonly MessageAttachment[];
  /**
   * When the adapter observed the message (`MessageEvent.receivedAtMs`), not
   * Discord's own timestamp. The window tier's clock (Slice 4) — passed in
   * rather than read from `Date.now()` so a fixture can drive it.
   */
  readonly atMs: number;
}

/**
 * Why a rule matched, in enough detail for a human to agree or disagree.
 *
 * Carried from Slice 1 even though only Slice 2 renders it: retrofitting a
 * trace into ten predicates afterwards is exactly the cost Slice 2 is
 * sequenced early to avoid (ADR 0040, Consequences).
 */
export interface MatchTrace {
  readonly kind: RuleKind;
  /** The configured thing that matched: a term, a pattern, a domain, a threshold. */
  readonly matchedOn: string;
  /**
   * Half-open `[start, end)` into `PredicateInput.content`. `undefined` for a
   * predicate whose match is a property of the whole message rather than a
   * span of it — a mention count, a message rate.
   */
  readonly span: readonly [number, number] | undefined;
  /**
   * Which normalisations were applied to the input before matching, in the
   * order they ran. A reviewer looking at a surprising match needs to know
   * that `s0me` was folded to `some` before they can judge it.
   */
  readonly normalisations: readonly string[];
  /** Predicate-specific detail, rendered as `key: value` lines. */
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

export interface PredicateMatch {
  /**
   * What goes into `mod_case_events.matched_category`. `keyword_filter` uses
   * the word category's id; a predicate with no categories uses its own kind.
   */
  readonly categoryId: string;
  /** What goes into `mod_case_events.matched_snippet`. */
  readonly snippet: string;
  readonly trace: MatchTrace;
}

/**
 * One corpus row, as `core` sees it.
 *
 * Re-declared here rather than imported from `@bananasaurs/storage`
 * (ADR 0014), the same arrangement `AutomodRule` has. `packages/storage`'s
 * `AutomodFixture` is the authority on the columns; this is the shape the
 * dry-run evaluator needs, which is a subset — `note` is a reviewer's prose
 * and no predicate reads it.
 */
export interface FixtureRecord {
  readonly fixtureId: string;
  /** Zero-width stripped, exactly as the predicate saw it when captured. */
  readonly content: string;
  readonly authorId: string | undefined;
  readonly label: 'should_match' | 'should_not_match' | 'unlabelled';
  readonly source: 'observed' | 'handwritten';
  /** The replay clock. `PredicateInput.atMs` comes from here (ADR 0041 §6). */
  readonly createdAt: number;
  /**
   * Filename, declared content type and size for each file on the message
   * (OD-3).
   *
   * `MessageAttachment` is the same shape the live path carries, deliberately:
   * `attachment_type` must not be able to tell a replayed fixture from a live
   * message, because the one-code-path invariant (ADR 0041 section 3) is only
   * worth something if the input it produces is the same on both sides.
   *
   * Empty for a handwritten fixture that names no files, and for every
   * fixture captured before the OD-3 migration — those rows are real evidence
   * about a message whose attachments were never recorded, and an empty list
   * is the honest representation of that.
   */
  readonly attachments: readonly MessageAttachment[];
}

/** A rule compiled once, then evaluated against many messages. */
export interface CompiledPredicate {
  /** Synchronous and side-effect free with respect to Discord. */
  evaluate(input: PredicateInput): PredicateMatch | undefined;
}

/** Just enough of a Zod schema to validate a config, without depending on it. */
export interface ConfigSchema<T> {
  parse(input: unknown): T;
}

export interface Predicate<T = unknown> {
  readonly kind: RuleKind;
  readonly config: ConfigSchema<T>;
  /**
   * Turns a rule into a reusable artifact: the `obscenity` matcher for
   * `keyword_filter`, a compiled `RegExp` for `regex`, a ring buffer for the
   * window tier. Called on a rule change, not per message — the subscriber's
   * fingerprinted cache decides when.
   *
   * May throw. A rule whose configuration compiles to nothing usable (an
   * invalid regex, a word list `obscenity` rejects) is reported by
   * `compileRule` below rather than crashing the subscriber.
   */
  compile(rule: AutomodRule, config: T): CompiledPredicate;
}

/**
 * The type a *collection* of predicates takes.
 *
 * `Predicate<never>` looks like the right existential and is not, for exactly
 * the reason `packages/core/src/jobs/worker.ts` records for `AnyJobHandler`:
 * `config` is `ConfigSchema<T>` whose `parse` returns `T`, which is covariant.
 * `unknown` works in both positions — the return type widens, and `compile` is
 * declared as a method, so its parameter is bivariant.
 */
export type AnyPredicate = Predicate<unknown>;
