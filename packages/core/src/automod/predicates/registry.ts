import { attachmentTypePredicate } from './attachment-type.js';
import { capsPredicate } from './caps.js';
import { emojiPredicate } from './emoji.js';
import { invitePredicate } from './invite.js';
import { keywordFilterPredicate } from './keyword-filter.js';
import { linkDomainPredicate, type LinkDomainConfig } from './link-domain.js';
import { mentionSpamPredicate } from './mention-spam.js';
import { regexPredicate } from './regex.js';
import {
  isRuleKind,
  type AnyPredicate,
  type AutomodRule,
  type CompiledPredicate,
  type RuleKind,
} from './types.js';

/**
 * kind → predicate. Slices 3-5 each add an entry and change nothing else —
 * which is what ADR 0035 promised and ADR 0040 actually delivers.
 *
 * Two of the ten kinds `mod_rules_kind` permits (`rapid_spam`,
 * `duplicate_message`) are still absent as of Slice 4's Task 5a, until Tasks
 * 3-4 ship them. A rule naming an absent kind is inert, and `compileRule`
 * reports `'no-predicate'` so `doctor` can say so out loud rather than the
 * rule quietly never firing (ADR 0040 §4 — the ADR 0039 failure mode).
 */
const PREDICATES: Partial<Record<RuleKind, AnyPredicate>> = {
  keyword_filter: keywordFilterPredicate,
  attachment_type: attachmentTypePredicate,
  invite: invitePredicate,
  link_domain: linkDomainPredicate,
  regex: regexPredicate,
  caps: capsPredicate,
  emoji: emojiPredicate,
  mention_spam: mentionSpamPredicate,
};

export const predicateFor = (kind: string): AnyPredicate | undefined =>
  isRuleKind(kind) ? PREDICATES[kind] : undefined;

/**
 * `kind` → predicate, against an explicitly supplied registry.
 *
 * Exists so `no-predicate` stays testable after this slice, when every one of
 * the ten kinds `mod_rules_kind` permits has an implementation and no real
 * `RuleKind` value is left to stand for "not shipped yet". `resolveConfig`
 * checks `isRuleKind` first, so a made-up string yields `unknown-kind` — a
 * different failure, deliberately — and therefore no cast can reach the
 * `no-predicate` branch through the public entry points (`compileRule`,
 * `validateRuleConfig`, `predicateFor`) once `PREDICATES` is complete.
 *
 * The branch stays because an eleventh kind will arrive the way the tenth
 * did: ruling R-2 widened the SQL CHECK to all ten kinds *ahead* of their
 * predicates, precisely so a rule naming an unshipped kind was inert and loud
 * rather than silently non-matching. This is the seam that keeps that promise
 * under test instead of on trust — tests pass an empty (or partial) registry
 * rather than waiting for the next predicate to ship and then borrowing its
 * kind, which is what forced three repoints of the same four assertions
 * before this seam existed (plan ruling, Slice 4 Task 5a).
 */
const resolveConfigWith = (
  registry: Partial<Record<RuleKind, AnyPredicate>>,
  kind: string,
  configJson: string,
): ResolvedConfig => {
  if (!isRuleKind(kind)) {
    return { ok: false, reason: 'unknown-kind', detail: kind };
  }
  const predicate = registry[kind];
  if (predicate === undefined) {
    return { ok: false, reason: 'no-predicate', detail: kind };
  }

  try {
    // Parsed and validated on the way *out* of the database, not only on the
    // way in (CLAUDE.md rule 3, ADR 0037's `jobs.payload` precedent): a row
    // written by an older schema version, or by hand in `sqlite3`, is exactly
    // what this catches.
    const config: unknown = predicate.config.parse(JSON.parse(configJson));
    return { ok: true, predicate, config };
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid-config',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
};

export type CompileFailure =
  /** A `kind` the CHECK should have rejected — a hand-edited row, or a schema drift. */
  | 'unknown-kind'
  /** A permitted kind whose predicate has not shipped yet. */
  | 'no-predicate'
  /** `config` is not JSON, or fails its kind's Zod schema. */
  | 'invalid-config'
  /** The predicate's own `compile` threw — an invalid regex, an unparseable term. */
  | 'compile-failed'
  /**
   * A rule whose active list has nothing on it — a `keyword_filter` rule
   * with no enabled terms, or a `link_domain` rule with no row on the list
   * its own `config.mode` names.
   *
   * `buildMatcher([], [])` compiles cleanly — an empty blacklist is a valid
   * `RegExpMatcher` — so this is not a `compile-failed`. It is the same shape
   * of failure ADR 0039 spent a slice on: a rule that looks configured and
   * can never match, or — for `link_domain` in `allow` mode specifically —
   * one that matches everything, which is just as much "cannot be trusted to
   * do what its configuration says" as never matching is. "Cannot be
   * compiled" is a strict subset of "cannot be trusted to do what it says";
   * this closes the gap between them (ADR 0040 §4, review IMPORTANT-2 and
   * CRITICAL-2).
   */
  | 'no-terms';

export type CompileResult =
  | { readonly ok: true; readonly compiled: CompiledPredicate }
  | { readonly ok: false; readonly reason: CompileFailure; readonly detail: string };

/** The subset of `CompileFailure` a config, on its own, can fail with. */
export type ConfigValidationFailure = 'unknown-kind' | 'no-predicate' | 'invalid-config';

export type ConfigValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ConfigValidationFailure; readonly detail: string };

type ResolvedConfig =
  | { readonly ok: true; readonly predicate: AnyPredicate; readonly config: unknown }
  | { readonly ok: false; readonly reason: ConfigValidationFailure; readonly detail: string };

/**
 * Validates a rule's `config` column against its kind's schema, without
 * compiling it.
 *
 * ADR 0040 §2: `mod_rules.config` is validated on write *and* on read.
 * `compileRule` below is the read-side validator, called from the subscriber
 * and from `doctor`. This is the write-side validator: storage cannot
 * validate (ADR 0014 — the Zod schemas live in core, and storage may not
 * import core's predicate registry the way core may not import storage), so a
 * writer of `mod_rules.config` — `createRule`, `setRuleConfig` — must call
 * this first and refuse the write on `{ok: false}`. Mirrors `compileRule`'s
 * `{ok: true} | {ok: false, reason, detail}` shape deliberately, so a caller
 * that already knows one convention does not have to learn a second.
 *
 * `validateRuleConfigWith` is the injectable form, for the same reason
 * `compileRuleWith` below is: it keeps `no-predicate` testable without a real
 * unregistered `RuleKind` to borrow (see `resolveConfigWith`'s doc comment).
 */
export const validateRuleConfigWith = (
  registry: Partial<Record<RuleKind, AnyPredicate>>,
  kind: string,
  configJson: string,
): ConfigValidationResult => {
  const resolved = resolveConfigWith(registry, kind, configJson);
  return resolved.ok ? { ok: true } : resolved;
};

/** The production entry point: `validateRuleConfigWith` over the shipped registry. */
export const validateRuleConfig = (kind: string, configJson: string): ConfigValidationResult =>
  validateRuleConfigWith(PREDICATES, kind, configJson);

/**
 * Validates a rule's config against its kind's schema and compiles it, or says
 * exactly why it could not.
 *
 * Never throws. A rule that cannot be compiled must not take down the
 * subscriber, because that would stop every *other* rule in the guild from
 * matching — but it must not be silent either. The caller logs it once per
 * fingerprint and `doctor` reports it (ADR 0040 §4).
 *
 * `compileRuleWith` is the injectable form — see `resolveConfigWith`'s doc
 * comment for why it exists. `compileRule` below is the production entry
 * point, over the shipped registry.
 */
export const compileRuleWith = (
  registry: Partial<Record<RuleKind, AnyPredicate>>,
  rule: AutomodRule,
): CompileResult => {
  const resolved = resolveConfigWith(registry, rule.kind, rule.config);
  if (!resolved.ok) return resolved;
  const { predicate, config } = resolved;

  // A `keyword_filter` rule whose last enabled term (or category) was just
  // removed has valid, empty config and compiles to a matcher that can never
  // fire. Checked here, against the hydrated word list, because it cannot be
  // caught by validating `config` above — the word list is not in `config`
  // (ADR 0040 §3) — and `predicate.compile` below has no reason to throw on
  // an empty term list, which is correct behaviour for `buildMatcher` itself.
  if (rule.kind === 'keyword_filter' && rule.terms.length === 0) {
    return {
      ok: false,
      reason: 'no-terms',
      detail: 'no enabled terms in this rule; it can never match a message',
    };
  }

  /**
   * `link_domain` compiles from `rule.linkDomains.filter(entry =>
   * entry.listType === config.mode)` (CRITICAL-2, review of Slices 3+5).
   * When that filter is empty the failure is silent and, in `allow` mode,
   * backwards from what an operator would expect:
   *
   * - `mode: 'deny'` with no deny rows: the rule can never fire. ADR 0039's
   *   exact failure mode, for the one kind whose guard was never
   *   generalised past `keyword_filter`.
   * - `mode: 'allow'` with no allow rows: "on neither list" is true of every
   *   link, so the rule matches **everything** — in `enforce` mode, every
   *   message containing a link.
   *
   * Refusing to compile either state is deliberately louder than letting
   * `allow` mode fire on everything: `doctor`'s `listUnusableAutomodRules`
   * reports both, and a rule that cannot compile is a rule an operator is
   * told to fix, not one quietly deleting every linked message.
   *
   * `invite` gets no equivalent guard, deliberately: an `invite` rule with
   * an empty allowlist is correct and useful — it fires on every invite,
   * which is the point of the predicate (there is only one list, not an
   * allow/deny pair whose meaning flips on emptiness). The asymmetry is
   * real, not an oversight — `link_domain`'s `allow` mode inverts its
   * meaning when its list empties; `invite`'s single list does not invert
   * anything by being empty.
   */
  if (rule.kind === 'link_domain') {
    const mode = (config as LinkDomainConfig).mode;
    const hasActiveRow = rule.linkDomains.some((entry) => entry.listType === mode);
    if (!hasActiveRow) {
      return {
        ok: false,
        reason: 'no-terms',
        detail:
          mode === 'allow'
            ? 'this rule is a whitelist (mode allow) with no domains on its allow list; it would match every link, so it is treated as unusable rather than compiled'
            : 'this rule is a blocklist (mode deny) with no domains on its deny list; it can never match a link',
      };
    }
  }

  try {
    return { ok: true, compiled: predicate.compile(rule, config) };
  } catch (err) {
    return {
      ok: false,
      reason: 'compile-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
};

/** The production entry point: `compileRuleWith` over the shipped registry. */
export const compileRule = (rule: AutomodRule): CompileResult => compileRuleWith(PREDICATES, rule);
