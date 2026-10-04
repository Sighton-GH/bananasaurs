import { describe, expect, it } from 'vitest';
import { compileRule } from './registry.js';
import type { AutomodRule, CompiledPredicate, PredicateInput } from './types.js';

const compile = (config: string, kind = 'rapid_spam'): CompiledPredicate => {
  const rule: AutomodRule = {
    ruleId: 'r1',
    kind,
    config,
    terms: [],
    allowlist: [],
    inviteAllowlist: [],
    linkDomains: [],
    countsAsViolation: true,
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

describe('the rapid_spam predicate', () => {
  it('fires when a member exceeds the rate, and not before', () => {
    const compiled = compile('{"maxMessages":3,"windowMs":10000}');
    const at = (ms: number) => message('anything', { atMs: ms, messageId: `m${String(ms)}` });
    expect(compiled.evaluate(at(1_000))).toBeUndefined();
    expect(compiled.evaluate(at(2_000))).toBeUndefined();
    expect(compiled.evaluate(at(3_000))).toBeUndefined();
    // The fourth inside the window is one too many.
    expect(compiled.evaluate(at(4_000))).toBeDefined();
  });

  it('forgets messages that fall out of the window', () => {
    // The ambiguity a single burst cannot show: the same four messages spread
    // beyond the window must NOT fire, so an implementation that never prunes
    // goes red here while passing the test above.
    const compiled = compile('{"maxMessages":3,"windowMs":10000}');
    const at = (ms: number) => message('anything', { atMs: ms, messageId: `m${String(ms)}` });
    expect(compiled.evaluate(at(1_000))).toBeUndefined();
    expect(compiled.evaluate(at(20_000))).toBeUndefined();
    expect(compiled.evaluate(at(40_000))).toBeUndefined();
    expect(compiled.evaluate(at(60_000))).toBeUndefined();
  });

  it('counts each member separately', () => {
    // Two members interleaved, neither exceeding the rate alone. An
    // implementation keyed on the rule only fires and goes red.
    const compiled = compile('{"maxMessages":3,"windowMs":10000}');
    for (const ms of [1_000, 2_000, 3_000, 4_000]) {
      expect(
        compiled.evaluate(
          message('x', {
            atMs: ms,
            authorId: ms % 2000 === 0 ? '111' : '222',
            messageId: `a${String(ms)}`,
          }),
        ),
      ).toBeUndefined();
    }
  });

  it('does not count an edit as a new message (ruling PR-23)', () => {
    // R-13 added eventKind a slice early for exactly this. A member fixing a
    // typo three times must not trip a rate rule.
    const compiled = compile('{"maxMessages":2,"windowMs":10000}');
    expect(compiled.evaluate(message('x', { atMs: 1_000, messageId: 'm1' }))).toBeUndefined();
    for (const ms of [1_100, 1_200, 1_300, 1_400]) {
      expect(
        compiled.evaluate(message('x', { atMs: ms, messageId: 'm1', eventKind: 'messageUpdate' })),
      ).toBeUndefined();
    }
  });

  it('does not fire at the threshold, only above it', () => {
    const compiled = compile('{"maxMessages":3,"windowMs":10000}');
    const at = (ms: number) => message('anything', { atMs: ms, messageId: `m${String(ms)}` });
    expect(compiled.evaluate(at(1_000))).toBeUndefined();
    expect(compiled.evaluate(at(2_000))).toBeUndefined();
    // Exactly at the threshold (3 messages) must not fire.
    expect(compiled.evaluate(at(3_000))).toBeUndefined();
  });

  it('is guild-scoped: two guilds do not share a member’s count', () => {
    // CLAUDE.md rule 2. Both guilds record for the "same" authorId, so an
    // implementation keyed on (memberId, ruleId) alone would combine them and
    // fire on the second guild's second message.
    const compiled = compile('{"maxMessages":1,"windowMs":10000}');
    expect(
      compiled.evaluate(message('x', { guildId: 'guild-a', atMs: 1_000, messageId: 'm1' })),
    ).toBeUndefined();
    expect(
      compiled.evaluate(message('x', { guildId: 'guild-b', atMs: 1_000, messageId: 'm2' })),
    ).toBeUndefined();
  });

  it('rejects an unrecognised config key', () => {
    const rule: AutomodRule = {
      ruleId: 'r1',
      kind: 'rapid_spam',
      config: '{"maxMessages":3,"windowMs":10000,"typo":true}',
      terms: [],
      allowlist: [],
      inviteAllowlist: [],
      linkDomains: [],
      countsAsViolation: true,
    };
    const result = compileRule(rule);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-config');
  });

  it('rejects a windowMs outside the bounded range', () => {
    const rule: AutomodRule = {
      ruleId: 'r1',
      kind: 'rapid_spam',
      config: '{"maxMessages":3,"windowMs":1}',
      terms: [],
      allowlist: [],
      inviteAllowlist: [],
      linkDomains: [],
      countsAsViolation: true,
    };
    const result = compileRule(rule);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-config');
  });
});
