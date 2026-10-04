import { describe, expect, it } from 'vitest';
import type { MessageEvent } from '../discord/events.js';
import { ruleFingerprint } from './fingerprint.js';
import type { AutomodRule, PredicateInput } from './predicates/types.js';
import {
  createPredicateCache,
  evaluateRule,
  predicateCacheKey,
  predicateInputFrom,
} from './evaluate.js';

/**
 * Unit tests for the one predicate code path (ADR 0041 §3): the live
 * subscriber and the dry-run evaluator both build a `PredicateInput` through
 * `predicateInputFrom` and both evaluate a rule through `evaluateRule`. No
 * fakes stand in for the registry or the matcher — the point of this module
 * is that it *is* the production path, so these tests exercise the real
 * `keywordFilterPredicate` via `compileRule`.
 */

const GUILD = '100000000000000001';

const ruleWith = (terms: readonly string[]): AutomodRule => ({
  ruleId: 'r1',
  kind: 'keyword_filter',
  config: '{}',
  terms: terms.map((text) => ({ text, categoryId: 'profanity' })),
  allowlist: [],
  inviteAllowlist: [],
  linkDomains: [],
  countsAsViolation: true,
});

const inputWith = (content: string): PredicateInput => ({
  guildId: GUILD,
  channelId: '200000000000000001',
  messageId: '300000000000000001',
  authorId: '400000000000000001',
  eventKind: 'messageCreate',
  content,
  rawContent: content,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  atMs: 1_000,
});

const messageEvent = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  kind: 'messageCreate',
  guildId: GUILD,
  receivedAtMs: 7_000,
  channelId: '200000000000000001',
  parentChannelId: undefined,
  categoryId: undefined,
  isPrivateThread: false,
  messageId: '300000000000000001',
  authorId: '400000000000000001',
  authorDisplayName: undefined,
  authorIsBot: false,
  content: 'hello world',
  editedTimestampMs: undefined,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  ...over,
});

describe('evaluateRule', () => {
  it('matches through the real predicate and returns its trace', () => {
    const cache = createPredicateCache();
    const outcome = evaluateRule(cache, ruleWith(['badword']), inputWith('hello badword'));
    expect(outcome.kind).toBe('match');
    expect(outcome.kind === 'match' && outcome.match.trace.matchedOn).toBe('badword');
  });

  it('recompiles when the rule’s terms change, without a restart', () => {
    // The ADR 0039 failure, guarded: the cache used to key on rule id alone,
    // so an edited word list kept matching against the old compiled matcher
    // until the daemon was restarted.
    const cache = createPredicateCache();
    expect(evaluateRule(cache, ruleWith(['badword']), inputWith('hello newword')).kind).toBe(
      'no-match',
    );
    expect(evaluateRule(cache, ruleWith(['newword']), inputWith('hello newword')).kind).toBe(
      'match',
    );
  });

  it('reuses the compiled artifact when nothing changed', () => {
    // IMPORTANT-5: `cache.size` alone cannot prove reuse — a same-key
    // `Map.set` never changes `size`, so that assertion cannot fail no
    // matter what the cache does (verified: it stayed green with caching
    // removed entirely). Object identity of the cache *entry* across two
    // calls is the thing that actually distinguishes "recompiled and
    // overwrote the same key" from "reused the existing artifact".
    const cache = createPredicateCache();
    const rule = ruleWith(['badword']);
    const key = predicateCacheKey(GUILD, rule.ruleId);

    evaluateRule(cache, rule, inputWith('hello badword'));
    const entryAfterFirst = cache.get(key);
    expect(entryAfterFirst).toBeDefined();

    evaluateRule(cache, rule, inputWith('hello badword again'));
    const entryAfterSecond = cache.get(key);

    expect(entryAfterSecond).toBe(entryAfterFirst);
  });

  it('keys the cache by guild as well as rule, so two guilds cannot share a matcher', () => {
    // `daemon.ts` seeds every guild's default rule under the same id, so a
    // bare `ruleId` key would let whichever guild spoke first decide what
    // every other guild was matched against.
    const cache = createPredicateCache();
    const guildA = { ...inputWith('hello badword'), guildId: '100000000000000001' };
    const guildB = { ...inputWith('hello badword'), guildId: '100000000000000002' };
    evaluateRule(cache, ruleWith(['badword']), guildA);
    evaluateRule(cache, ruleWith(['badword']), guildB);
    expect(cache.size).toBe(2);
  });

  it('reports an unusable rule once per fingerprint, and again after an edit', () => {
    const cache = createPredicateCache();
    const empty = ruleWith([]);

    const first = evaluateRule(cache, empty, inputWith('anything'));
    expect(first).toMatchObject({ kind: 'unusable', reason: 'no-terms', firstSeen: true });

    const second = evaluateRule(cache, empty, inputWith('anything else'));
    expect(second).toMatchObject({ kind: 'unusable', reason: 'no-terms', firstSeen: false });

    // A different broken configuration is a different fingerprint, so the
    // operator hears about it rather than being told once ever.
    const alsoEmpty = { ...empty, allowlist: ['harmless'] };
    const third = evaluateRule(cache, alsoEmpty, inputWith('anything'));
    expect(third).toMatchObject({ kind: 'unusable', firstSeen: true });
  });

  it('returns `threw` rather than propagating when a predicate throws', () => {
    // Uses a rule kind with no registered predicate would be `no-predicate`,
    // not `threw` — so this needs a compiled predicate that throws at
    // evaluate time. Build one directly against the CompiledPredicate
    // interface and put it in the cache by hand, which is exactly the state
    // the subscriber would be in after a successful compile.
    const cache = createPredicateCache();
    const rule = ruleWith(['badword']);
    cache.set(predicateCacheKey('100000000000000001', 'r1'), {
      fingerprint: ruleFingerprint(rule),
      compiled: {
        evaluate() {
          throw new Error('predicate exploded');
        },
      },
    });

    const outcome = evaluateRule(cache, rule, inputWith('hello badword'));
    expect(outcome.kind).toBe('threw');
  });
});

describe('predicateInputFrom', () => {
  it('strips zero-width characters from a message’s content but keeps the raw text', () => {
    const input = predicateInputFrom({
      from: 'message',
      event: messageEvent({ content: 'bad​word' }),
    });
    expect(input?.content).toBe('badword');
    expect(input?.rawContent).toBe('bad​word');
  });

  it('returns undefined for a message with no author or no content', () => {
    expect(
      predicateInputFrom({ from: 'message', event: messageEvent({ content: undefined }) }),
    ).toBeUndefined();
    expect(
      predicateInputFrom({ from: 'message', event: messageEvent({ authorId: undefined }) }),
    ).toBeUndefined();
  });
});
