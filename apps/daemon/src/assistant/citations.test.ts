import { describe, expect, it } from 'vitest';
import { applyCitations, createCitationRegistry } from './citations.js';

describe('applyCitations', () => {
  it('no tags returns the same text trimmed and empty cited', () => {
    const registry = createCitationRegistry();
    registry.tag({ title: 'Handbook', url: 'https://example.com/handbook' });
    expect(applyCitations('  Just hello.  ', registry)).toEqual({
      text: 'Just hello.',
      cited: [],
    });
  });

  it('one tag is stripped and its source cited', () => {
    const registry = createCitationRegistry();
    const source = { title: 'Handbook', url: 'https://example.com/handbook' };
    const tag = registry.tag(source);
    expect(tag).toBe('S1');
    const result = applyCitations(`Meetings are Mondays [${tag}].`, registry);
    expect(result.text).toBe('Meetings are Mondays.');
    expect(result.cited).toEqual([source]);
    expect(result.text).not.toContain('[S');
  });

  it('repeated tags keep first-appearance order with duplicates removed', () => {
    const registry = createCitationRegistry();
    const first = { title: 'First', url: 'https://example.com/1' };
    const second = { title: 'Second', url: 'https://example.com/2' };
    registry.tag(first);
    registry.tag(second);
    const result = applyCitations('a [S2] b [S1] c [S2]', registry);
    expect(result.text).toBe('a b c');
    expect(result.cited).toEqual([second, first]);
  });

  it('[S1, S3] cites both in order', () => {
    const registry = createCitationRegistry();
    const sources = [
      { title: 'One', url: 'https://example.com/1' },
      { title: 'Two', url: 'https://example.com/2' },
      { title: 'Three', url: 'https://example.com/3' },
    ];
    for (const source of sources) registry.tag(source);
    const result = applyCitations('Both say so [S1, S3].', registry);
    expect(result.text).toBe('Both say so.');
    expect(result.cited).toEqual([sources[0], sources[2]]);
  });

  it('[S1][S3] cites both in order', () => {
    const registry = createCitationRegistry();
    const sources = [
      { title: 'One', url: 'https://example.com/1' },
      { title: 'Two', url: 'https://example.com/2' },
      { title: 'Three', url: 'https://example.com/3' },
    ];
    for (const source of sources) registry.tag(source);
    const result = applyCitations('Both say so[S1][S3].', registry);
    expect(result.text).toBe('Both say so.');
    expect(result.cited).toEqual([sources[0], sources[2]]);
  });

  it('an unknown tag is removed and ignored', () => {
    const registry = createCitationRegistry();
    registry.tag({ title: 'Known', url: 'https://example.com/known' });
    const result = applyCitations('Hello [S9] world.', registry);
    expect(result.text).toBe('Hello world.');
    expect(result.cited).toEqual([]);
  });

  it('a tag inside a code fence is kept', () => {
    const registry = createCitationRegistry();
    const source = { title: 'Handbook', url: 'https://example.com/handbook' };
    registry.tag(source);
    const result = applyCitations(
      'Use this [S1].\n```\ncode [S1] here\n```\nDone [S1].',
      registry,
    );
    expect(result.text).toBe('Use this.\n```\ncode [S1] here\n```\nDone.');
    expect(result.cited).toEqual([source]);
  });

  it('a trailing Source: line is removed', () => {
    const registry = createCitationRegistry();
    const result = applyCitations('The answer.\nSource: https://example.com/other', registry);
    expect(result.text).toBe('The answer.');
    expect(result.cited).toEqual([]);
  });

  it('a trailing -# Sources: line is removed', () => {
    const registry = createCitationRegistry();
    const result = applyCitations('The answer.\n-# Sources: Handbook', registry);
    expect(result.text).toBe('The answer.');
    expect(result.cited).toEqual([]);
  });

  it('a mid-text line starting with Sources is kept', () => {
    const registry = createCitationRegistry();
    const result = applyCitations('Sources are listed in the handbook.\nThe answer.', registry);
    expect(result.text).toBe('Sources are listed in the handbook.\nThe answer.');
  });
});

describe('createCitationRegistry', () => {
  it('the same url with different headings gets different tags', () => {
    const registry = createCitationRegistry();
    const first = registry.tag({
      title: 'Handbook',
      url: 'https://example.com/handbook',
      heading: 'Part 0',
    });
    const second = registry.tag({
      title: 'Handbook',
      url: 'https://example.com/handbook',
      heading: 'Part 1',
    });
    expect(first).toBe('S1');
    expect(second).toBe('S2');
    expect(registry.get('S1')).toEqual({
      title: 'Handbook',
      url: 'https://example.com/handbook',
      heading: 'Part 0',
    });
    expect(registry.get('S2')).toEqual({
      title: 'Handbook',
      url: 'https://example.com/handbook',
      heading: 'Part 1',
    });
  });

  it('an identical source gets the same tag', () => {
    const registry = createCitationRegistry();
    const source = {
      title: 'Handbook',
      url: 'https://example.com/handbook',
      heading: 'Part 0',
    };
    expect(registry.tag(source)).toBe('S1');
    expect(registry.tag({ ...source })).toBe('S1');
    expect(registry.get('S1')).toEqual(source);
    expect(registry.get('S9')).toBeUndefined();
  });
});
