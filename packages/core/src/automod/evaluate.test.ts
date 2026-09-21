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

  it('reconstructs mentions from a fixture’s content', () => {
    // Plan ruling PR-3: Discord mention syntax is literally present in the
    // message text, so the window tier can replay honestly from a text-only
    // corpus. This fixture names no files, so attachments stay empty — that
    // is a fact about the fixture, not about what the corpus can hold (OD-3
    // superseded PR-3's note that attachments were unrecoverable; see the
    // dedicated test below for a fixture that has some).
    const fixture: FixtureRecord = {
      fixtureId: '300000000000000001:abcdef0123456789',
      content:
        'hey <@400000000000000002> and <@!400000000000000003> and <@&500000000000000001> @everyone',
      authorId: '400000000000000001',
      label: 'unlabelled',
      source: 'observed',
      createdAt: 7_000,
      attachments: [],
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

  it('reconstructs a fixture’s attachments onto the predicate input', () => {
    const input = predicateInputFrom({
      from: 'fixture',
      guildId: '100000000000000001',
      fixture: {
        fixtureId: '900000000000000001:0123456789abcdef',
        content: 'have a file',
        authorId: '800000000000000001',
        label: 'unlabelled',
        source: 'observed',
        createdAt: 5_000,
        attachments: [
          { fileName: 'payload.exe', contentType: 'application/x-msdownload', sizeBytes: 4096 },
        ],
      },
    });

    expect(input?.attachments).toEqual([
      { fileName: 'payload.exe', contentType: 'application/x-msdownload', sizeBytes: 4096 },
    ]);
  });

  it.each([
    ['an email whose domain starts "here"', 'write to user@heretical.com for help'],
    ['a longer word beginning "@here"', 'the @hereditary principle'],
    ['an email at a domain starting "everyone"', 'ping ops@everyonesbusiness.example'],
  ])('does not read %s as an @everyone mention', (_label, content) => {
    // `content.includes('@here')` said true for every one of these. On the
    // replay path that is not cosmetic: Slice 4's `mention_spam` dry run would
    // report matches on ordinary messages, and the output would be read as
    // evidence the rule over-fires when the rule is fine.
    const input = predicateInputFrom({
      from: 'fixture',
      guildId: '100000000000000001',
      fixture: {
        fixtureId: 'handwritten-1',
        content,
        authorId: undefined,
        label: 'should_not_match',
        source: 'handwritten',
        createdAt: 1,
        attachments: [],
      },
    });
    expect(input?.mentionsEveryone).toBe(false);
  });

  it.each([
    ['at the start of a message', '@everyone stand up'],
    ['after whitespace', 'hey @here look at this'],
    ['after punctuation', 'right, @everyone: meeting moved'],
  ])('still reads a real mention %s', (_label, content) => {
    const input = predicateInputFrom({
      from: 'fixture',
      guildId: '100000000000000001',
      fixture: {
        fixtureId: 'handwritten-2',
        content,
        authorId: undefined,
        label: 'should_match',
        source: 'handwritten',
        createdAt: 1,
        attachments: [],
      },
    });
    expect(input?.mentionsEveryone).toBe(true);
  });

  it('takes the replay clock from the fixture, never from the wall clock', () => {
    const fixture: FixtureRecord = {
      fixtureId: 'handwritten-1',
      content: 'ordinary',
      authorId: undefined,
      label: 'should_not_match',
      source: 'handwritten',
      createdAt: 7_000,
      attachments: [],
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
      attachments: [],
    };
    const input = predicateInputFrom({
      from: 'fixture',
      guildId: '100000000000000001',
      fixture,
    });
    expect(input?.messageId).toBe('300000000000000001');
  });
});
