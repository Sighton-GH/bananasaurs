import { describe, expect, it } from 'vitest';
import { compileRule } from './registry.js';
import type { AutomodRule, CompiledPredicate, PredicateInput } from './types.js';

/**
 * Compiles a rule of this file's kind, failing the test loudly if it does not
 * compile. Returning the artifact rather than the `CompileResult` keeps every
 * test below one line, and a compile failure is never the thing under test in
 * this file — it has its own tests.
 */
const compile = (config: string, kind = 'caps'): CompiledPredicate => {
  const rule: AutomodRule = {
    ruleId: 'r1',
    kind,
    mode: 'test',
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

const message = (content: string): PredicateInput => ({
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
});

describe('the caps predicate', () => {
  it('does not fire below the minimum length', () => {
    // The spec names short messages as one of this predicate's three
    // false-positive sources, and requires a floor.
    const compiled = compile('{"minLength":10,"maxRatio":0.7}');
    expect(compiled.evaluate(message('OK FINE'))).toBeUndefined();
  });

  it('fires on a long shout', () => {
    const compiled = compile('{"minLength":10,"maxRatio":0.7}');
    const match = compiled.evaluate(message('EVERYONE COME AND LOOK AT THIS NOW'));
    expect(match?.trace.detail.ratio).toBeGreaterThan(0.7);
    expect(match?.trace.span).toBeUndefined();
  });

  it('measures capitals against letters, not against every character', () => {
    // The ambiguity: punctuation would dilute the ratio under a
    // count-everything implementation, so 'HELLO!!!!!!!!!!!!!!!' would score
    // about 0.5 and pass a 0.7 threshold that plain 'HELLO' exceeds. Same
    // letters, same shout, opposite verdict.
    const compiled = compile('{"minLength":10,"maxRatio":0.7}');
    expect(compiled.evaluate(message('HELLO!!!!!!!!!!!!!!!'))).toBeDefined();
  });

  it('ignores fenced and inline code', () => {
    // The third false-positive source the spec names. A message that is a
    // shouted SQL snippet is not shouting at anyone.
    const compiled = compile('{"minLength":10,"maxRatio":0.7}');
    expect(
      compiled.evaluate(message('here you go ```SELECT * FROM MOD_RULES WHERE ENABLED = 1```')),
    ).toBeUndefined();

    // Decorative guard 3: the assertion above passes for two reasons at
    // once — the code is stripped, *and* the surviving prose ('here you go')
    // happens to have a 0.0 caps ratio, so it would pass even if stripping
    // did nothing at all and the whole message (mixed-case prose plus
    // upper-case SQL) were scored together. A shout *outside* the fence
    // pins the actual intent: it must still fire after the fenced block is
    // removed, which only holds if stripping — not a coincidentally low
    // ratio — is what is under test.
    const shoutOutsideFence = compiled.evaluate(
      message('LOOK AT THIS RIGHT NOW ```select * from mod_rules where enabled = 1``` EVERYONE'),
    );
    expect(shoutOutsideFence).toBeDefined();
    expect(shoutOutsideFence?.trace.detail.ratio).toBe(1);
  });

  it('does not divide by zero on a message with no letters', () => {
    const compiled = compile('{"minLength":3,"maxRatio":0.7}');
    expect(compiled.evaluate(message('12345 !!!! ????'))).toBeUndefined();
  });
});
