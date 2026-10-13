import { describe, expect, it } from 'vitest';
import { assertWithinBudget, CardBudgetError, countComponents, countText } from './budget.js';
import { actionRow, button, container, section, text, thumbnail } from './kit.js';

describe('card budget', () => {
  it('counts nested components, including accessories', () => {
    const c = [
      container({
        accent: 1,
        children: [
          section([text('a'), text('b')], thumbnail('attachment://t.png')),
          actionRow([button({ customId: 'x', label: 'x' })]),
        ],
      }),
    ];
    // container, section, 2 texts, thumbnail, row, button
    expect(countComponents(c)).toBe(7);
    expect(countText(c)).toBe(2);
  });

  it('throws when a card exceeds 40 components', () => {
    const many = Array.from({ length: 40 }, (_, i) => text(String(i)));
    expect(() => assertWithinBudget([container({ accent: 1, children: many })])).toThrow(
      CardBudgetError,
    );
  });

  it('accepts a card of exactly 40 components', () => {
    const texts = Array.from({ length: 39 }, (_, i) => text(String(i)));
    const card = [container({ accent: 1, children: texts })];
    expect(countComponents(card)).toBe(40);
    expect(() => assertWithinBudget(card)).not.toThrow();
  });

  it('aggregates text across multiple Text Displays at the 4,000 boundary', () => {
    const ok = [text('x'.repeat(2000)), text('y'.repeat(2000))];
    expect(countText(ok)).toBe(4000);
    expect(() => assertWithinBudget(ok)).not.toThrow();
    const over = [text('x'.repeat(2000)), text('y'.repeat(2001))];
    expect(countText(over)).toBe(4001);
    expect(() => assertWithinBudget(over)).toThrow(CardBudgetError);
  });

  it('throws when text exceeds 4,000 characters', () => {
    expect(() => assertWithinBudget([text('x'.repeat(4001))])).toThrow(CardBudgetError);
    expect(() => assertWithinBudget([text('x'.repeat(4000))])).not.toThrow();
  });
});
