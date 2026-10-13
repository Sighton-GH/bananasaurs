import { describe, expect, it } from 'vitest';
import {
  actionRow,
  button,
  container,
  gallery,
  label,
  linkButton,
  modal,
  radioGroup,
  section,
  selectRow,
  separator,
  stringSelect,
  text,
  textInput,
  thumbnail,
} from './kit.js';

describe('card kit constructors', () => {
  it('builds a text display', () => {
    expect(text('hi')).toEqual({ type: 10, content: 'hi' });
  });

  it('builds a section with a thumbnail accessory', () => {
    expect(section([text('a')], thumbnail('attachment://x.png', 'alt'))).toEqual({
      type: 9,
      components: [{ type: 10, content: 'a' }],
      accessory: { type: 11, media: { url: 'attachment://x.png' }, description: 'alt' },
    });
  });

  it('refuses a section with no text or more than three', () => {
    expect(() => section([], thumbnail('attachment://x.png'))).toThrow(RangeError);
    expect(() =>
      section([text('1'), text('2'), text('3'), text('4')], thumbnail('attachment://x.png')),
    ).toThrow(RangeError);
  });

  it('maps button styles to Discord numbers and omits absent options', () => {
    expect(button({ customId: 'a', label: 'Go', style: 'primary' })).toEqual({
      type: 2,
      style: 1,
      custom_id: 'a',
      label: 'Go',
    });
    expect(button({ customId: 'b', label: 'X', style: 'danger', emoji: '🗑️' })).toEqual({
      type: 2,
      style: 4,
      custom_id: 'b',
      label: 'X',
      emoji: { name: '🗑️' },
    });
    expect(button({ customId: 'c', label: 'Y' }).style).toBe(2);
    expect(button({ customId: 'd', label: 'Z', style: 'success' }).style).toBe(3);
  });

  it('takes a custom emoji by id', () => {
    expect(button({ customId: 'a', label: 'A', emoji: { id: '123' } }).emoji).toEqual({ id: '123' });
    expect(button({ customId: 'a', label: 'A', emoji: '🔧' }).emoji).toEqual({ name: '🔧' });
  });

  it('builds a link button with style 5 and no custom id', () => {
    expect(linkButton({ url: 'https://example.com', label: 'Docs' })).toEqual({
      type: 2,
      style: 5,
      url: 'https://example.com',
      label: 'Docs',
    });
  });

  it('refuses an empty or oversized action row', () => {
    expect(() => actionRow([])).toThrow(RangeError);
    const six = Array.from({ length: 6 }, (_, i) => button({ customId: `b${i}`, label: 'x' }));
    expect(() => actionRow(six)).toThrow(RangeError);
  });

  it('builds separators with small spacing and a divider by default', () => {
    expect(separator()).toEqual({ type: 14, divider: true, spacing: 1 });
    expect(separator({ divider: false, spacing: 'large' })).toEqual({
      type: 14,
      divider: false,
      spacing: 2,
    });
  });

  it('builds a media gallery of 1 to 10 items', () => {
    expect(gallery([{ media: { url: 'attachment://b.png' }, description: 'd' }])).toEqual({
      type: 12,
      items: [{ media: { url: 'attachment://b.png' }, description: 'd' }],
    });
    expect(() => gallery([])).toThrow(RangeError);
    const ten = Array.from({ length: 10 }, (_, i) => ({
      media: { url: `attachment://g${i}.png` },
    }));
    expect(gallery(ten)).toEqual({ type: 12, items: ten });
    expect(() => gallery([...ten, { media: { url: 'attachment://g10.png' } }])).toThrow(RangeError);
  });

  it('builds a container with an accent colour', () => {
    expect(container({ accent: 0x2f5bd3, children: [text('x')] })).toEqual({
      type: 17,
      accent_color: 0x2f5bd3,
      components: [{ type: 10, content: 'x' }],
    });
  });

  it('builds a modal of labelled inputs and truncates the title to 45 characters', () => {
    const m = modal({
      customId: 'bs.task:update:x',
      title: 'A'.repeat(60),
      components: [
        label({
          label: 'What did you get done?',
          description: 'Shown on the task card.',
          component: textInput({
            customId: 'body',
            style: 'paragraph',
            required: true,
            minLength: 3,
            maxLength: 1000,
          }),
        }),
        label({
          label: 'How long?',
          component: radioGroup({
            customId: 'duration',
            required: true,
            options: [
              { value: '10m', label: '10 minutes' },
              { value: '1h', label: '1 hour', default: true },
            ],
          }),
        }),
      ],
    });
    expect(m.title).toHaveLength(45);
    expect(m.title.endsWith('…')).toBe(true);
    expect(m.components[0]).toEqual({
      type: 18,
      label: 'What did you get done?',
      description: 'Shown on the task card.',
      component: {
        type: 4,
        custom_id: 'body',
        style: 2,
        required: true,
        min_length: 3,
        max_length: 1000,
      },
    });
    expect(m.components[1]).toEqual({
      type: 18,
      label: 'How long?',
      component: {
        type: 21,
        custom_id: 'duration',
        required: true,
        options: [
          { value: '10m', label: '10 minutes' },
          { value: '1h', label: '1 hour', default: true },
        ],
      },
    });
  });
});

describe('stringSelect, selectRow and radioGroup (fix round 2)', () => {
  const opts = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ label: `L${i}`, value: `v${i}` }));

  it('rejects 0 and 26 options and accepts 1 and 25', () => {
    expect(() => stringSelect({ customId: 's', options: [] })).toThrow(RangeError);
    expect(() => stringSelect({ customId: 's', options: opts(26) })).toThrow(RangeError);
    expect(stringSelect({ customId: 's', options: opts(1) }).options).toHaveLength(1);
    expect(stringSelect({ customId: 's', options: opts(25) }).options).toHaveLength(25);
  });

  it('omits absent optional wire fields and includes the ones that are set', () => {
    expect(stringSelect({ customId: 's', options: opts(1) })).toEqual({
      type: 3,
      custom_id: 's',
      options: [{ label: 'L0', value: 'v0' }],
    });
    expect(
      stringSelect({
        customId: 's',
        placeholder: 'Pick one',
        minValues: 1,
        maxValues: 3,
        options: opts(2),
      }),
    ).toEqual({
      type: 3,
      custom_id: 's',
      placeholder: 'Pick one',
      min_values: 1,
      max_values: 3,
      options: [
        { label: 'L0', value: 'v0' },
        { label: 'L1', value: 'v1' },
      ],
    });
  });

  it('wraps a select in a single-component action row', () => {
    const s = stringSelect({ customId: 's', options: opts(1) });
    expect(selectRow(s)).toEqual({ type: 1, components: [s] });
  });

  it('builds a radio group directly with its wire shape', () => {
    expect(
      radioGroup({
        customId: 'r',
        required: false,
        options: [
          { value: 'a', label: 'A', description: 'the first' },
          { value: 'b', label: 'B', default: true },
        ],
      }),
    ).toEqual({
      type: 21,
      custom_id: 'r',
      required: false,
      options: [
        { value: 'a', label: 'A', description: 'the first' },
        { value: 'b', label: 'B', default: true },
      ],
    });
  });
});

describe('kit limits (fix round 1)', () => {
  it('accepts a button label at the boundary and rejects one over it', () => {
    expect(() => button({ customId: 'a', label: 'x'.repeat(38) })).not.toThrow();
    expect(() => button({ customId: 'a', label: 'x'.repeat(39) })).toThrow(RangeError);
    expect(() => button({ customId: 'a', label: 'x'.repeat(34), emoji: '🗑️' })).not.toThrow();
    expect(() => button({ customId: 'a', label: 'x'.repeat(35), emoji: '🗑️' })).toThrow(RangeError);
    expect(() => linkButton({ url: 'https://e.example', label: 'x'.repeat(38) })).not.toThrow();
    expect(() => linkButton({ url: 'https://e.example', label: 'x'.repeat(39) })).toThrow(
      RangeError,
    );
  });

  it('cuts modal titles, labels and descriptions without splitting a surrogate pair', () => {
    const m = modal({ customId: 'm', title: '😀'.repeat(30), components: [] });
    expect(m.title.length).toBeLessThanOrEqual(45);
    expect(m.title.endsWith('…')).toBe(true);
    expect(m.title).not.toMatch(/[\ud800-\udbff]…$/);
    const l = label({
      label: '😀'.repeat(30),
      description: '😀'.repeat(60),
      component: textInput({ customId: 'b', style: 'short', required: true }),
    });
    expect(l.label.length).toBeLessThanOrEqual(45);
    expect((l.description ?? '').length).toBeLessThanOrEqual(100);
    expect(l.label).not.toMatch(/[\ud800-\udbff]$/);
    expect(l.description).not.toMatch(/[\ud800-\udbff]$/);
  });

  it('keeps a title of exactly 45 characters untouched', () => {
    expect(modal({ customId: 'm', title: 'A'.repeat(45), components: [] }).title).toBe(
      'A'.repeat(45),
    );
  });
});
