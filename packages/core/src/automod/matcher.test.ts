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
    expect(result).toEqual({ categoryId: 'cat-1', snippet: 'badword' });
  });

  it('matches leetspeak-substituted evasion via obscenity transformers', () => {
    const matcher = buildMatcher([{ text: 'badword', categoryId: 'cat-1' }], []);
    expect(matcher.match('b4dw0rd')).toBeDefined();
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
