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

  it('returns trimmed text with no cited sources when there are no tags', () => {
    const registry = createCitationRegistry();
    expect(applyCitations('  hello  ', registry)).toEqual({ text: 'hello', cited: [] });
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
      text: 'Answer\nSource: unrelated',
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

  it('keeps tags inside indented and tilde fences, closed only by the same marker', () => {
    const registry = createCitationRegistry();
    const known = { title: 'Known', url: 'https://example.com/known' };
    registry.tag(known);
    expect(applyCitations('  ```\nexample [S1]\n  ```\nAnswer [S1]', registry)).toEqual({
      text: '```\nexample [S1]\n  ```\nAnswer',
      cited: [known],
    });
    expect(applyCitations('~~~\nexample [S1]\n~~~\nAnswer [S1]', registry)).toEqual({
      text: '~~~\nexample [S1]\n~~~\nAnswer',
      cited: [known],
    });
    // A ``` line inside a ~~~ fence does not close it.
    expect(applyCitations('~~~\ncode [S1]\n```\nmore [S1]\n~~~\nAnswer [S1]', registry)).toEqual({
      text: '~~~\ncode [S1]\n```\nmore [S1]\n~~~\nAnswer',
      cited: [known],
    });
  });

  it('keeps tags inside inline code spans', () => {
    const registry = createCitationRegistry();
    const known = { title: 'Known', url: 'https://example.com/known' };
    registry.tag(known);
    expect(applyCitations('Use `[S1]` for facts [S1]', registry)).toEqual({
      text: 'Use `[S1]` for facts',
      cited: [known],
    });
  });

  it('removes a trailing multi-line sources block but keeps a prose source sentence', () => {
    const registry = createCitationRegistry();
    const known = { title: 'Known', url: 'https://example.com/known' };
    registry.tag(known);
    expect(applyCitations('Answer [S1]\n\nSources:\n- Handbook\n- Web page', registry)).toEqual({
      text: 'Answer',
      cited: [known],
    });
    expect(applyCitations('Answer\nSources: https://x.test', registry).text).toBe('Answer');
    expect(applyCitations('Answer\n-# Sources: Handbook, Wikipedia', registry).text).toBe('Answer');
    expect(applyCitations('Answer\nSources: Handbook', registry).text).toBe('Answer');
    expect(applyCitations('Answer\nSource: ask the treasurer', registry).text).toBe(
      'Answer\nSource: ask the treasurer',
    );
  });
});
