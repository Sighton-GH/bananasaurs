import type { MessageEvent } from '../discord/events.js';
import { ruleFingerprint } from './fingerprint.js';
import { stripZeroWidth } from './matcher.js';
import { compileRule, type CompileFailure } from './predicates/registry.js';
import type {
  AutomodRule,
  CompiledPredicate,
  PredicateInput,
  PredicateMatch,
} from './predicates/types.js';

/**
 * The one predicate code path (ADR 0041 §3).
 *
 * The live subscriber and the dry-run evaluator both build their
 * `PredicateInput` here and both evaluate a rule here. That is the slice's
 * hard invariant, and it is made structural rather than promised: there is
 * no second construction site and no second evaluation site to drift from.
 * A test that merely compared two implementations' outputs would pass on the
 * day someone forked the logic and kept the behaviour identical for the
 * cases the test happened to cover.
 *
 * Deliberately pure: no logger, no clock, no database, no Discord. The
 * subscriber does the logging, using `firstSeen` below to keep saying it
 * once per broken configuration rather than once per message. Giving this
 * module a logger is what would make it un-callable from a dry run.
 */

/**
 * A cached compile: either an artifact, or the reason there isn't one.
 *
 * A union rather than one record with two nullable fields, so "compiled to
 * nothing, and no reason why" cannot be constructed. The record shape needed
 * a fallback for that state, and a fallback for a state that cannot occur
 * reads like error handling while testing nothing — this codebase has shipped
 * enough of those. The union deletes the state instead of guarding it.
 */
export type CacheEntry =
  | { readonly fingerprint: string; readonly compiled: CompiledPredicate }
  | {
      readonly fingerprint: string;
      readonly failure: { readonly reason: CompileFailure; readonly detail: string };
    };

/**
 * Compiled artifacts, keyed by `<guildId>:<ruleId>` and invalidated by a
 * content fingerprint (ADR 0040 §5).
 *
 * A `Map` the caller owns, rather than module state: the subscriber holds
 * one per instance so two guilds' subscribers cannot share compiled
 * artifacts through a module-level singleton, and a dry run gets a fresh
 * one per invocation so the window tier's mutable state never leaks between
 * runs (ADR 0041 §6).
 */
export type PredicateCache = Map<string, CacheEntry>;

export const createPredicateCache = (): PredicateCache => new Map();

/**
 * Guild-scoped, per CLAUDE.md rule 2 — a bare `ruleId` is not a key.
 * `daemon.ts` seeds every guild's default rule under the same id
 * (`'default-word-filter'`), so with a bare key whichever guild spoke first
 * would decide what every other guild was matched against.
 */
export const predicateCacheKey = (guildId: string, ruleId: string): string =>
  `${guildId}:${ruleId}`;

export type EvaluateOutcome =
  | { readonly kind: 'match'; readonly match: PredicateMatch }
  | { readonly kind: 'no-match' }
  | {
      readonly kind: 'unusable';
      readonly reason: CompileFailure;
      readonly detail: string;
      /**
       * Whether this failure was computed on *this* call rather than read
       * from the cache.
       *
       * The subscriber logs only when it is true, which makes the log once
       * per broken configuration — and again after an operator edits the
       * rule, because an edit changes the fingerprint. That is the ADR 0040
       * §4 behaviour, kept intact while the logger stays out of this module.
       */
      readonly firstSeen: boolean;
    }
  | { readonly kind: 'threw'; readonly error: unknown };

/**
 * Looks up or compiles the rule's artifact, evaluates it, and says what
 * happened. Never throws.
 */
export const evaluateRule = (
  cache: PredicateCache,
  rule: AutomodRule,
  input: PredicateInput,
): EvaluateOutcome => {
  const key = predicateCacheKey(input.guildId, rule.ruleId);
  const fingerprint = ruleFingerprint(rule);
  let entry = cache.get(key);
  let firstSeen = false;

  if (entry === undefined || entry.fingerprint !== fingerprint) {
    firstSeen = true;
    const result = compileRule(rule);
    entry = result.ok
      ? { fingerprint, compiled: result.compiled }
      : { fingerprint, failure: { reason: result.reason, detail: result.detail } };
    cache.set(key, entry);
  }

  if ('failure' in entry) {
    return {
      kind: 'unusable',
      reason: entry.failure.reason,
      detail: entry.failure.detail,
      firstSeen,
    };
  }

  try {
    const match = entry.compiled.evaluate(input);
    return match === undefined ? { kind: 'no-match' } : { kind: 'match', match };
  } catch (error) {
    return { kind: 'threw', error };
  }
};

export type PredicateInputSource = { readonly from: 'message'; readonly event: MessageEvent };

/**
 * The only place a `PredicateInput` is built (ADR 0041 §3).
 *
 * `undefined` means "this is not a message a predicate can be run against" —
 * a `messageCreate` with no author or no content, which the gateway does
 * deliver (an embed-only system message, a partial the adapter could not
 * resolve).
 */
export const predicateInputFrom = (source: PredicateInputSource): PredicateInput | undefined => {
  const { event } = source;
  // `MessageEvent.kind` also carries `messageDelete`, which no predicate can
  // be run against — there is no message left to match. The subscriber
  // already returns early on it, but this function is the *only* place a
  // `PredicateInput` is built (ADR 0041 §3), so it decides what is
  // evaluable rather than trusting each caller to have guarded first.
  // Narrowing the parameter type instead would push the guard back out to
  // the callers, which is the arrangement this module exists to end.
  if (event.kind !== 'messageCreate' && event.kind !== 'messageUpdate') return undefined;
  if (event.authorId === undefined || event.content === undefined) return undefined;
  return {
    guildId: event.guildId,
    channelId: event.channelId,
    messageId: event.messageId,
    authorId: event.authorId,
    eventKind: event.kind,
    content: stripZeroWidth(event.content),
    rawContent: event.content,
    mentionedUserIds: event.mentionedUserIds,
    mentionedRoleIds: event.mentionedRoleIds,
    mentionsEveryone: event.mentionsEveryone,
    attachments: event.attachments,
    atMs: event.receivedAtMs,
  };
};
