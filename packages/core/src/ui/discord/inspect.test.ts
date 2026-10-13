import { describe, expect, it } from 'vitest';
import { cardCustomIds, cardTexts } from './inspect.js';

const sample = [
  {
    type: 17,
    accent_color: 1,
    components: [
      { type: 10, content: 'one' },
      { type: 9, components: [{ type: 10, content: 'two' }], accessory: { type: 11 } },
      { type: 1, components: [{ type: 2, style: 2, custom_id: 'a:1', label: 'A' }, { type: 2, style: 5, url: 'https://x', label: 'L' }] },
      { type: 10, content: 'three' },
    ],
  },
];

describe('card inspection', () => {
  it('reads text displays in order, including inside sections', () => {
    expect(cardTexts(sample)).toBe('one\ntwo\nthree');
  });
  it('reads custom ids and skips link buttons', () => {
    expect(cardCustomIds(sample)).toEqual(['a:1']);
  });
});
