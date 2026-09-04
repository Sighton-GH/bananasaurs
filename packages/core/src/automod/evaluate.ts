import type { MessageEvent } from '../discord/events.js';
import { ruleFingerprint } from './fingerprint.js';
import { stripZeroWidth } from './matcher.js';
import { compileRule, type CompileFailure } from './predicates/registry.js';
import type {
  AutomodRule,
  CompiledPredicate,
  FixtureRecord,
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

/**
 * Discord mention syntax, as it appears in message content.
 *
 * `<@123>` and `<@!123>` are user mentions (the `!` form is the legacy
 * nickname variant Discord still delivers), `<@&123>` is a role mention.
 * Verified against a message's raw `content` rather than assumed — this is
 * what makes plan ruling PR-3 work: a text-only fixture can reconstruct the
 * mention lists the window tier reads, because Discord puts them in the text.
 */
const USER_MENTION = /<@!?(\d{17,20})>/g;
const ROLE_MENTION = /<@&(\d{17,20})>/g;

/**
 * `@everyone` / `@here`, as a *mention* rather than as a substring.
 *
 * A bare `content.includes('@here')` says true for `user@heretical.com`, and
 * for any email address whose domain starts `here`. That matters more than it
 * looks: this is the fixture-replay path, so a false positive here would make
 * Slice 4's `mention_spam` dry run report matches on ordinary messages and
 * would be read as evidence the rule is over-firing when the rule is fine.
 *
 * Two conditions, and both are needed. The lookbehind rejects an `@` glued to
 * a preceding word character, which is what an email address looks like. The
 * trailing `\b` rejects `@heretical`, where `@here` is a prefix of a longer
 * word. Neither alone is sufficient.
 *
 * The live path never reaches this: a real message carries Discord's own
 * `mentions_everyone` flag on the gateway event, and that flag is the
 * authority. This exists only because a text-only fixture has to reconstruct
 * the fact, which is the cost plan ruling PR-3 accepted.
 */
const EVERYONE_MENTION = /(?<!\w)@(?:everyone|here)\b/;

const matchIds = (content: string, pattern: RegExp): string[] =>
  [...content.matchAll(pattern)].map((m) => m[1]).filter((id): id is string => id !== undefined);

export type PredicateInputSource =
  | { readonly from: 'message'; readonly event: MessageEvent }
  | {
      readonly from: 'fixture';
      readonly guildId: string;
      readonly fixture: FixtureRecord;
    };

/**
 * The only place a `PredicateInput` is built (ADR 0041 §3).
 *
 * `undefined` means "this is not a message a predicate can be run against" —
 * a `messageCreate` with no author or no content, which the gateway does
 * deliver (an embed-only system message, a partial the adapter could not
 * resolve). A fixture always produces an input.
 *
 * **What a fixture can and cannot reproduce.** Mentions come back by parsing
 * the content, since Discord puts them there. Attachments come from the
 * corpus's own `automod_fixture_attachments` child table, added by OD-3 —
 * which supersedes plan ruling PR-3's note that they were metadata the corpus
 * did not hold. `attachment_type` can therefore be dry-run against observed
 * traffic: a fixture's `attachments` is the same shape a live message's is,
 * because `FixtureRecord.attachments` and `PredicateInput.attachments` are
 * both `readonly MessageAttachment[]`. A fixture captured before that
 * migration has none — an empty list is the honest representation of a real
 * message whose attachments were never recorded, not a gap being papered
 * over.
 */
export const predicateInputFrom = (source: PredicateInputSource): PredicateInput | undefined => {
  if (source.from === 'message') {
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
  }

  const { fixture } = source;
  // An observed fixture's id is `<messageId>:<contentHash>` (PR-1), so the
  // real message id comes back for free — which matters when a reviewer
  // wants to find the message in Discord. A handwritten fixture has no
  // message behind it and uses its own id.
  const messageId =
    fixture.source === 'observed'
      ? (fixture.fixtureId.split(':')[0] ?? fixture.fixtureId)
      : fixture.fixtureId;
  return {
    guildId: source.guildId,
    // No channel is recorded for a fixture, and inventing a plausible-looking
    // snowflake would be worse than saying so: a predicate that ever branched
    // on it would be silently wrong in a dry run.
    channelId: 'fixture',
    messageId,
    authorId: fixture.authorId ?? 'fixture',
    // A fixture is a message as first posted. Nothing in the corpus records
    // that a message was an edit, so replaying every fixture as a create is
    // the only honest option. **"Conservative" holds for content predicates
    // only** (CRITICAL-3, whole-branch review) — an earlier version of this
    // comment claimed it unconditionally, which is the load-bearing-comment
    // failure this project keeps hitting. For `keyword_filter` and the other
    // content predicates, treating an edit as a create counts it once rather
    // than not at all — genuinely conservative. For the window tier
    // (`rapid_spam`, `duplicate_message`), PR-1 gives every edit of the same
    // message its own corpus row, so this line turns each of those rows into
    // a separately counted event in a replay, where the live path (PR-23)
    // counts one create and ignores every edit — an over-count, not a
    // conservative under-count. `automod dryrun`'s `windowedCorpusCaveat`
    // (`ops/commands/automod.ts`) says so to whoever reads a windowed rule's
    // replay.
    eventKind: 'messageCreate',
    // Already zero-width stripped when captured; stripped again so a
    // handwritten fixture typed with a zero-width character behaves like a
    // captured one rather than like a different kind of input.
    content: stripZeroWidth(fixture.content),
    rawContent: fixture.content,
    mentionedUserIds: matchIds(fixture.content, USER_MENTION),
    mentionedRoleIds: matchIds(fixture.content, ROLE_MENTION),
    mentionsEveryone: EVERYONE_MENTION.test(fixture.content),
    attachments: fixture.attachments,
    atMs: fixture.createdAt,
  };
};
