import { describe, expect, it } from 'vitest';
import { compileRule } from './registry.js';
import type { AutomodRule, CompiledPredicate, PredicateInput } from './types.js';

/**
 * Compiles a rule of this file's kind, failing the test loudly if it does not
 * compile. Returning the artifact rather than the `CompileResult` keeps every
 * test below one line, and a compile failure is never the thing under test in
 * this file — it has its own tests.
 */
const compile = (config: string, kind = 'emoji'): CompiledPredicate => {
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

describe('the emoji predicate', () => {
  it('counts a ZWJ sequence as one emoji', () => {
    // Verified: Intl.Segmenter reports the family as 1 grapheme, while a
    // code-point scan reports 4 (plus joiners). A code-point implementation
    // fires here and this goes red.
    const compiled = compile('{"maxCount":3}');
    expect(compiled.evaluate(message('👨‍👩‍👧‍👦 👨‍👩‍👧‍👦 👨‍👩‍👧‍👦'))).toBeUndefined();
  });

  it('counts flags and keycaps, which are not Extended_Pictographic', () => {
    // Verified: '🇬🇧' and '1️⃣' both score 0 under \p{Extended_Pictographic}
    // while being one grapheme each. A pictographic-only implementation
    // counts zero here and this goes red.
    const compiled = compile('{"maxCount":3}');
    expect(compiled.evaluate(message('🇬🇧 🇬🇧 1️⃣ 2️⃣'))).toBeDefined();
  });

  it('counts a Discord custom emoji once, not as its literal characters', () => {
    // '<:party:123456789012345678>' is 26 characters of ordinary text. An
    // implementation that counted the pattern AND left it in the string for
    // grapheme counting would still report 1 here; one that forgot the
    // pattern entirely reports 0. Four of them against a threshold of 3 is
    // what separates the two.
    const compiled = compile('{"maxCount":3}');
    const custom = '<:party:123456789012345678>';
    expect(compiled.evaluate(message(custom.repeat(4)))).toBeDefined();
    expect(compiled.evaluate(message(custom.repeat(3)))).toBeUndefined();
  });

  it('counts an animated custom emoji too', () => {
    const compiled = compile('{"maxCount":1}');
    expect(
      compiled.evaluate(message('<a:spin:123456789012345678><a:spin:123456789012345679>')),
    ).toBeDefined();
  });

  it('leaves ordinary text alone', () => {
    const compiled = compile('{"maxCount":3}');
    expect(compiled.evaluate(message('good morning everyone, meeting at four'))).toBeUndefined();
  });
});
