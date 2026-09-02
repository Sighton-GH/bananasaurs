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

export interface CacheEntry {
  readonly fingerprint: string;
  /** `undefined` when the rule could not be compiled; `failure` says why. */
  readonly compiled: CompiledPredicate | undefined;
  readonly failure: { readonly reason: CompileFailure; readonly detail: string } | undefined;
}

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
      ? { fingerprint, compiled: result.compiled, failure: undefined }
      : {
          fingerprint,
          compiled: undefined,
          failure: { reason: result.reason, detail: result.detail },
        };
    cache.set(key, entry);
  }

  if (entry.compiled === undefined) {
    const failure = entry.failure ?? {
      reason: 'compile-failed' as const,
      detail: 'the rule has no compiled artifact and no recorded reason',
    };
    return { kind: 'unusable', reason: failure.reason, detail: failure.detail, firstSeen };
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
 * **What a fixture cannot reproduce**, and why that is recorded here rather
 * than discovered later (plan ruling PR-3): `automod_fixtures` holds text,
 * an author and a timestamp, because that is the shape the owner approved.
 * Mentions come back by parsing the content, since Discord puts them there.
 * Attachments do not — they are metadata the corpus does not hold — so
 * `attachments` is empty for every fixture, and Slice 5's `attachment_type`
 * predicate therefore cannot be dry-run against observed traffic. Its
 * regression cases must be handwritten, and whether the corpus should carry
 * attachment metadata is an owner question for that slice.
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
    // the only honest option — and it is the conservative one for Slice 4,
    // where treating an edit as a create counts it once rather than not at all.
    eventKind: 'messageCreate',
    // Already zero-width stripped when captured; stripped again so a
    // handwritten fixture typed with a zero-width character behaves like a
    // captured one rather than like a different kind of input.
    content: stripZeroWidth(fixture.content),
    rawContent: fixture.content,
    mentionedUserIds: matchIds(fixture.content, USER_MENTION),
    mentionedRoleIds: matchIds(fixture.content, ROLE_MENTION),
    mentionsEveryone: fixture.content.includes('@everyone') || fixture.content.includes('@here'),
    attachments: [],
    atMs: fixture.createdAt,
  };
};
