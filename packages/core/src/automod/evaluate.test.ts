import { describe, expect, it } from 'vitest';
import type { MessageEvent } from '../discord/events.js';
import { ruleFingerprint } from './fingerprint.js';
import type { AutomodRule, FixtureRecord, PredicateInput } from './predicates/types.js';
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
  mode: 'test',
  config: '{}',
  terms: terms.map((text) => ({ text, categoryId: 'profanity' })),
  allowlist: [],
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
  messageId: '300000000000000001',
  authorId: '400000000000000001',
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
    const cache = createPredicateCache();
    const rule = ruleWith(['badword']);
    evaluateRule(cache, rule, inputWith('hello badword'));
    const sizeAfterFirst = cache.size;
    evaluateRule(cache, rule, inputWith('hello badword again'));
    expect(cache.size).toBe(sizeAfterFirst);
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
      failure: undefined,
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

  it('reconstructs mentions from a fixture’s content', () => {
    // Plan ruling PR-3: Discord mention syntax is literally present in the
    // message text, so the window tier can replay honestly from a text-only
    // corpus. Attachments are not recoverable and stay empty.
    const fixture: FixtureRecord = {
      fixtureId: '300000000000000001:abcdef0123456789',
      content:
        'hey <@400000000000000002> and <@!400000000000000003> and <@&500000000000000001> @everyone',
      authorId: '400000000000000001',
      label: 'unlabelled',
      source: 'observed',
      createdAt: 7_000,
    };
    const input = predicateInputFrom({
      from: 'fixture',
      guildId: '100000000000000001',
      fixture,
    });

    expect(input?.mentionedUserIds).toEqual(['400000000000000002', '400000000000000003']);
    expect(input?.mentionedRoleIds).toEqual(['500000000000000001']);
    expect(input?.mentionsEveryone).toBe(true);
    expect(input?.attachments).toEqual([]);
  });

  it('takes the replay clock from the fixture, never from the wall clock', () => {
    const fixture: FixtureRecord = {
      fixtureId: 'handwritten-1',
      content: 'ordinary',
      authorId: undefined,
      label: 'should_not_match',
      source: 'handwritten',
      createdAt: 7_000,
    };
    const input = predicateInputFrom({
      from: 'fixture',
      guildId: '100000000000000001',
      fixture,
    });
    expect(input?.atMs).toBe(7_000);
  });

  it('recovers the real message id from an observed fixture’s id', () => {
    const fixture: FixtureRecord = {
      fixtureId: '300000000000000001:abcdef0123456789',
      content: 'x',
      authorId: '400000000000000001',
      label: 'unlabelled',
      source: 'observed',
      createdAt: 1,
    };
    const input = predicateInputFrom({
      from: 'fixture',
      guildId: '100000000000000001',
      fixture,
    });
    expect(input?.messageId).toBe('300000000000000001');
  });
});
