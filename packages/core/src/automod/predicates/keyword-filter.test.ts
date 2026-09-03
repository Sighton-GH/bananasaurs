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
  inviteAllowlist: [],
  linkDomains: [],
  ...over,
});

const message = (content: string): PredicateInput => ({
  guildId: '111111111111111111',
  channelId: '222222222222222222',
  messageId: '333333333333333333',
  authorId: '444444444444444444',
  eventKind: 'messageCreate',
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

  /**
   * Fix round 1, Finding 1. The old implementation recovered the span with
   * `input.content.indexOf(hit.snippet)`, which finds the *first* occurrence
   * of the matched text — not necessarily the occurrence obscenity actually
   * matched. This test's content contains "badword" twice: the first inside
   * an allowlisted phrase (suppressed, must not match), the second bare (must
   * match). The previous span test above is not enough to catch this, because
   * its content contains the term only once — `indexOf` cannot fail there.
   */
  it('points the span at the occurrence that actually matched, not the first occurrence of that text', () => {
    const compiled = compile(rule({ allowlist: ['that badword'] }));
    const content = 'that badword is fine but this badword is not';
    const match = compiled.evaluate(message(content));
    expect(match).toBeDefined();
    const [start, end] = match!.trace.span!;
    // The allowlisted occurrence starts at index 5; a naive `indexOf` would
    // land there. The real match is the second, unallowlisted occurrence.
    expect(start).not.toBe(5);
    expect(content.slice(start, end)).toBe('badword');
    expect(content.slice(0, start)).toBe('that badword is fine but this ');
  });

  /**
   * Fix round 1, Finding 2. `matchedOn` must name the *configured* term, not
   * whatever spelling matched — Slice 9's one-click suppression allowlists
   * `matchedOn`, and allowlisting a fuzzy spelling like `b4dw0rd` would leave
   * the term `badword` matching every other spelling untouched.
   */
  it('names the configured term in matchedOn, not the fuzzy spelling that matched', () => {
    const match = compile().evaluate(message('this is b4dw0rd here'));
    expect(match?.snippet).toBe('b4dw0rd');
    expect(match?.trace.matchedOn).toBe('badword');
  });
});
