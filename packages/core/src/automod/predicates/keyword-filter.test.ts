import { describe, expect, it } from 'vitest';
import { keywordFilterPredicate } from './keyword-filter.js';
import type { AutomodRule, PredicateInput } from './types.js';

const rule = (over: Partial<AutomodRule> = {}): AutomodRule => ({
  ruleId: 'r1',
  kind: 'keyword_filter',
  mode: 'enforce',
  config: '{}',
  terms: [{ text: 'badword', categoryId: 'slurs' }],
  allowlist: [],
  ...over,
});

const message = (content: string): PredicateInput => ({
  guildId: '111111111111111111',
  channelId: '222222222222222222',
  messageId: '333333333333333333',
  authorId: '444444444444444444',
  content,
  rawContent: content,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  atMs: 1_000,
});

const compile = (r: AutomodRule = rule()) =>
  keywordFilterPredicate.compile(r, keywordFilterPredicate.config.parse(JSON.parse(r.config)));

describe('keywordFilterPredicate', () => {
  it('accepts an empty config object', () => {
    expect(keywordFilterPredicate.config.parse({})).toEqual({});
  });

  it('rejects a config with unknown keys, so a typo is not silently ignored', () => {
    expect(() => keywordFilterPredicate.config.parse({ ratio: 0.7 })).toThrow();
  });

  it('matches a configured term and reports its category', () => {
    const match = compile().evaluate(message('this is a badword here'));
    expect(match?.categoryId).toBe('slurs');
    expect(match?.snippet).toBe('badword');
  });

  it('returns undefined when nothing matches', () => {
    expect(compile().evaluate(message('perfectly fine'))).toBeUndefined();
  });

  it('honours the allowlist', () => {
    const compiled = compile(rule({ allowlist: ['a badword phrase'] }));
    expect(compiled.evaluate(message('this is a badword phrase here'))).toBeUndefined();
  });

  it('still matches a term with a doubled letter outside obscenity’s six (ADR 0039)', () => {
    // The regression ADR 0039 fixed. `m` is not one of obscenity's six
    // custom-thresholded letters, so before that fix `spammer` could not match
    // even its own exact spelling.
    const compiled = compile(rule({ terms: [{ text: 'spammer', categoryId: 'spam' }] }));
    expect(compiled.evaluate(message('you are a spammer'))?.snippet).toBe('spammer');
  });

  it('produces a trace naming the matched term and its span', () => {
    const match = compile().evaluate(message('this is a badword here'));
    expect(match?.trace.kind).toBe('keyword_filter');
    expect(match?.trace.matchedOn).toBe('badword');
    expect(match?.trace.span).toEqual([10, 17]);
    expect(match?.trace.normalisations).toContain('zero-width stripped');
    expect(match?.trace.detail).toMatchObject({ categoryId: 'slurs' });
  });

  it('reports a span that actually indexes the matched snippet', () => {
    // A span nobody can slice with is a decorative trace. This is the guard
    // that makes the Slice 9 review screen's highlight trustworthy.
    const content = 'this is a badword here';
    const match = compile().evaluate(message(content));
    const [start, end] = match!.trace.span!;
    expect(content.slice(start, end)).toBe(match!.snippet);
  });
});
