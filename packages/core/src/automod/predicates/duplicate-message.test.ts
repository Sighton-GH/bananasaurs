import { describe, expect, it } from 'vitest';
import { compileRule } from './registry.js';
import { normaliseForDuplicateCheck } from './duplicate-message.js';
import type { AutomodRule, CompiledPredicate, PredicateInput } from './types.js';

const compile = (config: string, kind = 'duplicate_message'): CompiledPredicate => {
  const rule: AutomodRule = {
    ruleId: 'r1',
    kind,
    mode: 'test',
    config,
    terms: [],
    allowlist: [],
    inviteAllowlist: [],
    linkDomains: [],
  };
  const result = compileRule(rule);
  if (!result.ok) throw new Error(`expected to compile, got ${result.reason}: ${result.detail}`);
  return result.compiled;
};

const message = (content: string, over: Partial<PredicateInput> = {}): PredicateInput => ({
  guildId: '100000000000000001',
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
  ...over,
});

describe('normaliseForDuplicateCheck', () => {
  it('lowercases and collapses internal whitespace, not just trims', () => {
    // Whitespace collapse must run before comparison, not only trimming —
    // the plan's own note on this predicate's third test.
    expect(normaliseForDuplicateCheck('BUY   Crypto  NOW')).toBe('buy crypto now');
  });

  it('strips zero-width characters', () => {
    // A zero-width character (U+200B) inserted mid-word, the evasion class
    // stripZeroWidth exists to close (PR-20). Between words rather than in
    // place of the space itself: stripZeroWidth deletes the character rather
    // than replacing it with a space, so a zero-width character standing in
    // for a space would concatenate the two words instead of matching the
    // space-separated original — a different, more severe evasion this
    // predicate does not claim to close (see duplicate-message.test.ts's
    // dedicated test below and its comment).
    expect(normaliseForDuplicateCheck('buy cry​pto now')).toBe('buy crypto now');
  });
});

describe('the duplicate_message predicate', () => {
  it('fires on the same text repeated within the window', () => {
    const compiled = compile('{"maxRepeats":2,"windowMs":30000,"minLength":5}');
    const say = (ms: number, text: string) =>
      compiled.evaluate(message(text, { atMs: ms, messageId: `m${String(ms)}` }));
    expect(say(1_000, 'buy crypto now')).toBeUndefined();
    expect(say(2_000, 'buy crypto now')).toBeUndefined();
    expect(say(3_000, 'buy crypto now')).toBeDefined();
  });

  it('does not count different messages toward the repeat', () => {
    // The ambiguity: three messages, only two identical, so an implementation
    // that counted every message (a rate rule by mistake) goes red.
    const compiled = compile('{"maxRepeats":2,"windowMs":30000,"minLength":5}');
    const say = (ms: number, text: string) =>
      compiled.evaluate(message(text, { atMs: ms, messageId: `m${String(ms)}` }));
    expect(say(1_000, 'buy crypto now')).toBeUndefined();
    expect(say(2_000, 'a totally different message')).toBeUndefined();
    expect(say(3_000, 'buy crypto now')).toBeUndefined();
  });

  it('still fires when the repeats are interleaved with a different message (CRITICAL-1)', () => {
    // The buffer used to be sized `maxRepeats + 1` — enough events *in
    // total*, but this predicate counts events *of one text*
    // (`countMatching`), and `record` puts every message in the same buffer.
    // So one interleaved message evicted a repeat before the count could ever
    // exceed the threshold, at every configuration. The test above could not
    // catch this: three messages against a buffer of three never evicts
    // anything. This one uses a buffer that would be sized 2 under the old
    // arithmetic (`maxRepeats: 1`) and four messages — spam / filler / spam —
    // which the old sizing evicts the first "spam" to make room for
    // "filler", so the second "spam" only ever counts 1 match and never
    // fires. It must fire.
    const compiled = compile('{"maxRepeats":1,"windowMs":30000,"minLength":1}');
    const say = (ms: number, text: string) =>
      compiled.evaluate(message(text, { atMs: ms, messageId: `m${String(ms)}` }));
    expect(say(1_000, 'spam')).toBeUndefined();
    expect(say(2_000, 'filler')).toBeUndefined();
    expect(say(3_000, 'spam')).toBeDefined();
  });

  it('treats case and spacing differences as the same message', () => {
    const compiled = compile('{"maxRepeats":1,"windowMs":30000,"minLength":5}');
    const say = (ms: number, text: string) =>
      compiled.evaluate(message(text, { atMs: ms, messageId: `m${String(ms)}` }));
    expect(say(1_000, 'buy crypto now')).toBeUndefined();
    expect(say(2_000, 'BUY   Crypto  NOW')).toBeDefined();
  });

  it('ignores a zero-width character inserted to evade it', () => {
    // stripZeroWidth is the one normalisation shared with the matcher
    // (PR-20), and this is what it buys.
    //
    // **Adapted from the plan's literal fixture.** The plan's text used a
    // zero-width character (U+200B) *in place of* the space between words
    // ("buy" + U+200B + "crypto" + U+200B + "now", no real spaces at all).
    // stripZeroWidth
    // (imported as-is, per PR-20 — not reimplemented) only deletes the
    // character; it does not insert a space in its place. Deleting a
    // word-separator zero-width character therefore concatenates the words
    // ('buycryptonow'), which does not equal the space-separated original
    // after whitespace collapse — so the plan's literal fixture cannot pass
    // under the normaliser PR-20 mandates, for the same reason PR-20 rejects
    // reusing the matcher's fuller transformer chain: doing better would cost
    // more than this predicate's tier is worth. This test instead inserts the
    // zero-width character *inside* a word, which is the evasion class
    // stripZeroWidth actually defends against (breaking a keyword-style
    // substring match) and the one this predicate can honestly claim to
    // close.
    const compiled = compile('{"maxRepeats":1,"windowMs":30000,"minLength":5}');
    const say = (ms: number, text: string) =>
      compiled.evaluate(message(text, { atMs: ms, messageId: `m${String(ms)}` }));
    expect(say(1_000, 'buy crypto now')).toBeUndefined();
    expect(say(2_000, 'buy cry​pto now')).toBeDefined();
  });

  it('does not fire below the minimum length', () => {
    const compiled = compile('{"maxRepeats":1,"windowMs":30000,"minLength":10}');
    const say = (ms: number, text: string) =>
      compiled.evaluate(message(text, { atMs: ms, messageId: `m${String(ms)}` }));
    expect(say(1_000, 'ok')).toBeUndefined();
    expect(say(2_000, 'ok')).toBeUndefined();
    expect(say(3_000, 'ok')).toBeUndefined();
  });

  it('defaults minLength to 0, so a short repeated message still fires', () => {
    // Task 4: the schema's default must not silently suppress a match an
    // operator's maxRepeats/windowMs configured. No minLength in the config.
    const compiled = compile('{"maxRepeats":1,"windowMs":30000}');
    const say = (ms: number, text: string) =>
      compiled.evaluate(message(text, { atMs: ms, messageId: `m${String(ms)}` }));
    expect(say(1_000, 'ok')).toBeUndefined();
    expect(say(2_000, 'ok')).toBeDefined();
  });

  it('does not treat two captionless attachment-only posts as a repeat (CRITICAL-2)', () => {
    // `minLength: 0` is deliberate — refusing to invent a floor an operator
    // did not ask for. But an attachment-only message has `content === ''`,
    // and `0 < 0` is false, so `''` used to be recorded as the member's
    // "repeated text" and two captionless images matched on the default
    // config. Absent content is not short content; it must never fire.
    const compiled = compile('{"maxRepeats":1,"windowMs":30000}');
    const say = (ms: number) =>
      compiled.evaluate(message('', { atMs: ms, messageId: `m${String(ms)}` }));
    expect(say(1_000)).toBeUndefined();
    expect(say(2_000)).toBeUndefined();
  });

  it('does not count an edit as a new message (ruling PR-23)', () => {
    const compiled = compile('{"maxRepeats":1,"windowMs":30000,"minLength":5}');
    expect(
      compiled.evaluate(message('buy crypto now', { atMs: 1_000, messageId: 'm1' })),
    ).toBeUndefined();
    for (const ms of [1_100, 1_200, 1_300]) {
      expect(
        compiled.evaluate(
          message('buy crypto now', { atMs: ms, messageId: 'm1', eventKind: 'messageUpdate' }),
        ),
      ).toBeUndefined();
    }
  });

  it('is guild-scoped: two guilds do not share a member’s repeat count', () => {
    // CLAUDE.md rule 2.
    const compiled = compile('{"maxRepeats":1,"windowMs":30000,"minLength":5}');
    expect(
      compiled.evaluate(
        message('buy crypto now', { guildId: 'guild-a', atMs: 1_000, messageId: 'm1' }),
      ),
    ).toBeUndefined();
    expect(
      compiled.evaluate(
        message('buy crypto now', { guildId: 'guild-b', atMs: 1_000, messageId: 'm2' }),
      ),
    ).toBeUndefined();
  });

  it('rejects an unrecognised config key', () => {
    const rule: AutomodRule = {
      ruleId: 'r1',
      kind: 'duplicate_message',
      mode: 'test',
      config: '{"maxRepeats":1,"windowMs":30000,"typo":true}',
      terms: [],
      allowlist: [],
      inviteAllowlist: [],
      linkDomains: [],
    };
    const result = compileRule(rule);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-config');
  });

  it('rejects a windowMs outside the bounded range', () => {
    const rule: AutomodRule = {
      ruleId: 'r1',
      kind: 'duplicate_message',
      mode: 'test',
      config: '{"maxRepeats":1,"windowMs":1}',
      terms: [],
      allowlist: [],
      inviteAllowlist: [],
      linkDomains: [],
    };
    const result = compileRule(rule);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-config');
  });
});
