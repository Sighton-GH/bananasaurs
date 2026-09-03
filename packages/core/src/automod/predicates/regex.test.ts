import { describe, expect, it } from 'vitest';
import { compileRule } from './registry.js';
import { REGEX_TIMEOUT_MS } from './regex.js';
import type { AutomodRule, PredicateInput } from './types.js';

const rule = (config: string): AutomodRule => ({
  ruleId: 'r1',
  kind: 'regex',
  mode: 'test',
  config,
  terms: [],
  allowlist: [],
  inviteAllowlist: [],
  linkDomains: [],
});

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

describe('the regex predicate', () => {
  it('matches, and traces the configured pattern rather than the matched text', () => {
    const compiled = compileRule(rule('{"pattern":"buy \\\\w+ now"}'));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const match = compiled.compiled.evaluate(message('please buy crypto now friends'));

    expect(match?.snippet).toBe('buy crypto now');
    // matchedOn is the CONFIGURED thing, not the matched text — ruling R-8:
    // a field whose job is "which configured thing matched" that duplicates
    // the snippet beside it carries no information, and Slice 9's
    // suppression reads it.
    expect(match?.trace.matchedOn).toBe('buy \\w+ now');
    expect(match?.trace.matchedOn).not.toBe(match?.snippet);
  });

  it('points the span at the occurrence that actually matched', () => {
    // The ambiguity ruling R-9 was written about, and the fixture matters
    // more than the assertion. The matched text 'cat' occurs TWICE in this
    // content: once embedded in 'concatenate' at index 3, and once as the
    // real word at index 14. The word-boundary pattern matches only the
    // second, so:
    //
    //   content.indexOf('cat')        === 3   (wrong: inside 'concatenate')
    //   /\bcat\b/.exec(content).index === 14  (right: the real word)
    //
    // An implementation that computes the span with indexOf on the matched
    // text therefore produces a different, wrong span and this goes red.
    //
    // The first draft of this test used /n[o0]w/ against 'now or n0w', where
    // the two alternatives are different literals occurring once each — so
    // indexOf and the engine agreed and the test could not fail for the bug
    // it names. That is the decorative-guard shape docs/22 records: a fixture
    // too simple to reach the branch the test is named after.
    const compiled = compileRule(rule('{"pattern":"\\\\bcat\\\\b"}'));
    if (!compiled.ok) throw new Error('should compile');
    const content = 'concatenate a cat';
    const match = compiled.compiled.evaluate(message(content));

    expect(match?.snippet).toBe('cat');
    expect(match?.trace.span).toEqual([14, 17]);
    // Pins the fixture's own premise: if someone edits `content` and breaks
    // the two-occurrence property, this fails loudly rather than quietly
    // turning the test above decorative again.
    expect(content.indexOf('cat')).toBe(3);
  });

  it('rejects a pattern that does not compile', () => {
    const result = compileRule(rule('{"pattern":"([unclosed"}'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('compile-failed');
  });

  it('rejects the g and y flags, which carry lastIndex across messages', () => {
    // Verified behaviour, not a theory: /a/g answers true, true, then false
    // for the same content on a reused regex. This predicate reuses one
    // compiled regex for a rule's whole lifetime.
    for (const flags of ['g', 'y', 'gi']) {
      const result = compileRule(rule(JSON.stringify({ pattern: 'spam', flags })));
      expect(result.ok, `flags ${flags} must be refused`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-config');
    }
  });

  it('accepts the flags that are safe to reuse', () => {
    const result = compileRule(rule('{"pattern":"SPAM","flags":"i"}'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.evaluate(message('spam'))).toBeDefined();
  });

  it('caps the pattern length', () => {
    const result = compileRule(rule(JSON.stringify({ pattern: 'a'.repeat(1_001) })));
    expect(result.ok).toBe(false);
  });

  // ── The gate the spec names (section 4, Slice 3) ──────────────────────
  it('survives a catastrophic-backtracking pattern within the timeout', () => {
    // ^(a+)+$ against 'a'*26 + 'b' was measured at 3052 ms in this Node.
    // 60 a's would not finish in the lifetime of this project. The
    // assertion is that the predicate returns control, and does so within a
    // small multiple of the budget rather than hanging the subscriber.
    const compiled = compileRule(rule('{"pattern":"^(a+)+$"}'));
    if (!compiled.ok) throw new Error('should compile: the pattern is valid, only slow');

    const started = Date.now();
    expect(() => compiled.compiled.evaluate(message('a'.repeat(60) + 'b'))).toThrow(/timed out/i);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(REGEX_TIMEOUT_MS * 8);
  }, 20_000);

  it('a rule whose pattern timed out still evaluates the next message', () => {
    // The context is reused, so a timeout must not poison it. Verified
    // behaviour, pinned here because it is the difference between one bad
    // message and a rule that is dead until restart.
    const compiled = compileRule(rule('{"pattern":"^(a+)+$"}'));
    if (!compiled.ok) throw new Error('should compile');
    expect(() => compiled.compiled.evaluate(message('a'.repeat(60) + 'b'))).toThrow();
    expect(compiled.compiled.evaluate(message('aaa'))).toBeDefined();
  }, 20_000);
});
