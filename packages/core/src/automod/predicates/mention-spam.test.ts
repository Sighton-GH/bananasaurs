import { describe, expect, it } from 'vitest';
import { compileRule } from './registry.js';
import type { AutomodRule, CompiledPredicate, PredicateInput } from './types.js';

/**
 * Compiles a rule of this file's kind, failing the test loudly if it does not
 * compile. Returning the artifact rather than the `CompileResult` keeps every
 * test below one line, and a compile failure is never the thing under test in
 * this file — it has its own tests.
 */
const compile = (config: string, kind = 'mention_spam'): CompiledPredicate => {
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

describe('the mention_spam predicate', () => {
  it('counts user and role mentions together', () => {
    // The ambiguity: neither list alone reaches the threshold, so an
    // implementation that counted only one of them goes red.
    const compiled = compile('{"maxMentions":3}');
    expect(
      compiled.evaluate(
        message('hi', {
          mentionedUserIds: ['1', '2'],
          mentionedRoleIds: ['3', '4'],
        }),
      ),
    ).toBeDefined();
  });

  it('does not fire at the threshold, only above it', () => {
    const compiled = compile('{"maxMentions":3}');
    expect(compiled.evaluate(message('hi', { mentionedUserIds: ['1', '2', '3'] }))).toBeUndefined();
  });

  it('weights @everyone above a single mention', () => {
    // One @everyone alone exceeds a threshold of 3 at the default weight of 5.
    const compiled = compile('{"maxMentions":3}');
    expect(compiled.evaluate(message('hi', { mentionsEveryone: true }))).toBeDefined();
  });

  it('reads Discord’s own everyone flag, not the message text', () => {
    // A live message carries mentionsEveryone from the gateway; the text is not
    // the authority. 'user@heretical.com' must not count.
    const compiled = compile('{"maxMentions":1}');
    expect(
      compiled.evaluate(message('mail me at user@heretical.com', { mentionsEveryone: false })),
    ).toBeUndefined();
  });

  it('has no span, because the count is a property of the whole message', () => {
    const compiled = compile('{"maxMentions":1}');
    expect(
      compiled.evaluate(message('hi', { mentionedUserIds: ['1', '2'] }))?.trace.span,
    ).toBeUndefined();
  });

  it('makes countEveryoneAs configurable rather than hard-coded', () => {
    // With the weight turned down to 1, one @everyone plus one user mention is
    // 2 total — at the threshold of 2, not above it, so it must not fire. An
    // implementation that hard-coded the default weight of 5 would fire here.
    const compiled = compile('{"maxMentions":2,"countEveryoneAs":1}');
    expect(
      compiled.evaluate(message('hi', { mentionedUserIds: ['1'], mentionsEveryone: true })),
    ).toBeUndefined();
  });

  it('rejects an unrecognised config key', () => {
    // ADR 0040 §2: config is a `.strict()` schema, validated on read.
    const rule: AutomodRule = {
      ruleId: 'r1',
      kind: 'mention_spam',
      mode: 'test',
      config: '{"maxMentions":3,"typo":true}',
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
