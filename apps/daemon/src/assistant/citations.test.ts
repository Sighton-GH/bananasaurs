import { describe, expect, it } from 'vitest';
import { applyCitations, createCitationRegistry } from './citations.js';

describe('citation registry', () => {
  it('assigns stable tags and looks sources up', () => {
    const registry = createCitationRegistry();
    const source = { title: 'Handbook', url: 'https://example.com/handbook' };
    expect(registry.tag(source)).toBe('S1');
    expect(registry.tag(source)).toBe('S1');
    expect(registry.get('S1')).toEqual(source);
    expect(registry.tag({ ...source, heading: 'Guide' })).toBe('S2');
  });

  it('strips tags, deduplicates cited sources, and preserves order', () => {
    const registry = createCitationRegistry();
    const first = { title: 'First', url: 'https://example.com/1' };
    const second = { title: 'Second', url: 'https://example.com/2' };
    registry.tag(first);
    registry.tag(second);
    expect(applyCitations(`One [S1, S2]. Two [S1][S2].`, registry)).toEqual({
      text: 'One. Two.',
      cited: [first, second],
    });
  });

  it('removes unknown tags and model-written trailing source lines', () => {
    const registry = createCitationRegistry();
    registry.tag({ title: 'Known', url: 'https://example.com/known' });
    expect(applyCitations('Answer [S99]\nSource: unrelated', registry)).toEqual({
      text: 'Answer',
      cited: [],
    });
    expect(applyCitations('Answer\n-# Sources: unrelated', registry).text).toBe('Answer');
    expect(applyCitations('Sources are useful\nAnswer', registry).text).toBe(
      'Sources are useful\nAnswer',
    );
  });

  it('keeps tags inside fenced code blocks', () => {
    const registry = createCitationRegistry();
    registry.tag({ title: 'Known', url: 'https://example.com/known' });
    expect(applyCitations('```\nexample [S1]\n```\nAnswer', registry)).toEqual({
      text: '```\nexample [S1]\n```\nAnswer',
      cited: [],
    });
  });
});
