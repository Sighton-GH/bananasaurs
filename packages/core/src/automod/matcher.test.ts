import { describe, expect, it } from 'vitest';
import { buildMatcher, stripZeroWidth } from './matcher.js';

describe('stripZeroWidth', () => {
  it('removes zero-width space, non-joiner, joiner, and BOM', () => {
    expect(stripZeroWidth('b​a‌d‍﻿')).toBe('bad');
  });

  it('leaves ordinary text untouched', () => {
    expect(stripZeroWidth('hello world')).toBe('hello world');
  });
});

describe('buildMatcher', () => {
  it('matches a configured term and reports its category', () => {
    const matcher = buildMatcher([{ text: 'badword', categoryId: 'cat-1' }], []);
    const result = matcher.match('this message has badword in it');
    expect(result).toEqual({
      categoryId: 'cat-1',
      termText: 'badword',
      snippet: 'badword',
      startIndex: 17,
      endIndex: 23,
    });
  });

  it('matches leetspeak-substituted evasion via obscenity transformers', () => {
    const matcher = buildMatcher([{ text: 'badword', categoryId: 'cat-1' }], []);
    expect(matcher.match('b4dw0rd')).toBeDefined();
  });

  it('reports the configured term text, not the evasive spelling that matched', () => {
    const matcher = buildMatcher([{ text: 'badword', categoryId: 'cat-1' }], []);
    const result = matcher.match('b4dw0rd');
    expect(result?.termText).toBe('badword');
    expect(result?.snippet).toBe('b4dw0rd');
  });

  it('does not match after zero-width characters are stripped, then matches', () => {
    const matcher = buildMatcher([{ text: 'badword', categoryId: 'cat-1' }], []);
    // The caller is responsible for calling stripZeroWidth before match() —
    // this asserts match() itself has no opinion on pre-stripped input.
    expect(matcher.match('bad​word')).toBeDefined();
  });

  it('suppresses a match covered by the allowlist', () => {
    const matcher = buildMatcher([{ text: 'ass', categoryId: 'cat-1' }], ['assassin']);
    expect(matcher.match('an assassin walked by')).toBeUndefined();
  });

  it('reports no match for clean text', () => {
    const matcher = buildMatcher([{ text: 'badword', categoryId: 'cat-1' }], []);
    expect(matcher.match('hello world')).toBeUndefined();
  });
});

/**
 * ADR 0039: `collapseDuplicatesTransformer` collapses doubled letters in the
 * *matched input* but never in a `parseRawPattern`-compiled term, unless the
 * letter is one of obscenity's six hand-tuned exceptions (b/e/o/l/s/g). A
 * configured term with a doubled letter outside that set — `spammer`
 * (doubled `m`), `forbidden` (doubled `d`), `bitter` (doubled `t`) — used to
 * never match, at any stretch, including its own exact literal spelling.
 * These cases are drawn directly from ADR 0039's validation suite.
 */
describe('buildMatcher — doubled-letter terms outside obscenity’s six exceptions (ADR 0039)', () => {
  it('matches the exact literal spelling of a term with a doubled letter (m)', () => {
    const matcher = buildMatcher([{ text: 'spammer', categoryId: 'cat-1' }], []);
    expect(matcher.match('you are a spammer')).toBeDefined();
  });

  it('matches a stretched (evasion) spelling of the same term', () => {
    const matcher = buildMatcher([{ text: 'spammer', categoryId: 'cat-1' }], []);
    expect(matcher.match('you are a spaaaammmmer')).toBeDefined();
  });

  it('matches a term with a doubled letter (d) mid-word', () => {
    const matcher = buildMatcher([{ text: 'forbidden', categoryId: 'cat-1' }], []);
    expect(matcher.match('that is forbidden here')).toBeDefined();
  });

  it('matches a term with a doubled letter (t)', () => {
    const matcher = buildMatcher([{ text: 'bitter', categoryId: 'cat-1' }], []);
    expect(matcher.match('so bitter today')).toBeDefined();
  });

  it('still matches a plain, undoubled control term', () => {
    const matcher = buildMatcher([{ text: 'badword', categoryId: 'cat-1' }], []);
    expect(matcher.match('this has badword in it')).toBeDefined();
  });

  it('still matches a stretched plain control term', () => {
    const matcher = buildMatcher([{ text: 'badword', categoryId: 'cat-1' }], []);
    expect(matcher.match('this has baaaadword in it')).toBeDefined();
  });

  it('does NOT match an unrelated word that happens to be the single-letter form (no false positive)', () => {
    const matcher = buildMatcher([{ text: 'spammer', categoryId: 'cat-1' }], []);
    expect(matcher.match('please do not spamer me')).toBeUndefined();
  });

  it('cross-term: with both a doubled-letter term and a plain term configured, each still behaves independently', () => {
    const matcher = buildMatcher(
      [
        { text: 'spammer', categoryId: 'cat-spam' },
        { text: 'badword', categoryId: 'cat-bad' },
      ],
      [],
    );
    expect(matcher.match('this has badword in it')).toEqual({
      categoryId: 'cat-bad',
      termText: 'badword',
      snippet: 'badword',
      startIndex: 9,
      endIndex: 15,
    });
    expect(matcher.match('this has baaaadword in it')).toBeDefined();
    expect(matcher.match('please do not spamer me')).toBeUndefined();
    expect(matcher.match('you are a spammer')).toEqual({
      categoryId: 'cat-spam',
      termText: 'spammer',
      snippet: 'spammer',
      startIndex: 10,
      endIndex: 16,
    });
  });

  it('keeps matching terms already covered by obscenity’s six built-in thresholds', () => {
    const bollocks = buildMatcher([{ text: 'bollocks', categoryId: 'cat-1' }], []);
    expect(bollocks.match('a load of bollocks')).toBeDefined();
    const assess = buildMatcher([{ text: 'assess', categoryId: 'cat-1' }], []);
    expect(assess.match('let us assess this')).toBeDefined();
  });
});
