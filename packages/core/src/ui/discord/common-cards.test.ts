import { describe, expect, it } from 'vitest';
import { errorCard, resultCard } from './common-cards.js';
import { countComponents, countText } from './budget.js';
import { ERROR_COPY, type ErrorCode } from '../../copy/errors.js';
import { escapeText } from './text.js';

/** Every text display's content, in order. */
const contents = (c: { components: readonly unknown[] }): string[] => {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    if (o['type'] === 10 && typeof o['content'] === 'string') out.push(o['content']);
    walk(o['components']);
  };
  walk(c.components);
  return out;
};
const accent = (c: { components: readonly unknown[] }) =>
  (c.components[0] as { accent_color: number }).accent_color;

describe('errorCard', () => {
  it('shows title, detail and next step, in the entry’s tone, with no pings or art', () => {
    const c = errorCard('task.not-yours');
    const all = contents(c).join('\n');
    expect(all).toContain("**✋ This task isn't yours to pick up**");
    expect(all).toContain('Only people assigned to it');
    expect(all).toContain('💡 Ask a team lead');
    expect(accent(c)).toBe(0xe0a526);
    expect(c.allowedMentions).toEqual({ parse: [] });
    expect(c.art).toEqual([]);
  });

  it('uses the error icon and red for danger entries', () => {
    const c = errorCard('task.unavailable');
    expect(contents(c)[0]).toContain("**❌ Couldn't update the task**");
    expect(accent(c)).toBe(0xd64545);
  });

  it('quotes the member’s text back, escaped, as a block quote', () => {
    const c = errorCard('task.update-not-saved', { quote: 'line one @everyone\n**two**' });
    const quote = contents(c)[1];
    expect(quote).toBe('> line one @​everyone\n> \\*\\*two\\*\\*');
  });

  it('caps a very long quote so the card stays in budget', () => {
    const c = errorCard('task.update-not-saved', { quote: 'x'.repeat(10_000) });
    expect(countText(c.components)).toBeLessThanOrEqual(4000);
  });

  it.each(
    Object.entries(ERROR_COPY)
      .filter(([, entry]) => entry.audience === 'member')
      .map(([code]) => code as ErrorCode),
  )('never shows Ref to a member for %s', (code) => {
    expect(contents(errorCard(code, { ref: '7F3K' })).join('\n')).not.toContain('Ref ');
  });

  it('shows Ref to moderators', () => {
    const code = 'task.not-yours';
    const original = Object.getOwnPropertyDescriptor(ERROR_COPY, code);
    if (original === undefined) throw new Error(`Missing local error entry: ${code}`);
    Object.defineProperty(ERROR_COPY, code, {
      ...original,
      value: { ...ERROR_COPY[code], audience: 'moderator' },
    });
    try {
      expect(contents(errorCard(code, { ref: '7F3K' })).join('\n')).toContain('Ref 7F3K');
    } finally {
      Object.defineProperty(ERROR_COPY, code, original);
    }
  });

  it.each(['*'.repeat(10000), 'x\n'.repeat(10000), '@<\n'.repeat(10000)])(
    'budgets the escaped quote including block quote prefixes',
    (quote) => {
      const c = errorCard('task.update-not-saved', { quote });
      expect(countText(c.components)).toBeLessThanOrEqual(4000);
      expect(contents(c)[1]?.length).toBeLessThanOrEqual(1500);
      expect(countComponents(c.components)).toBeLessThanOrEqual(40);
      expect(contents(c)[1]).toMatch(/…$/);
    },
  );

  it('does not render an empty quote', () => {
    expect(contents(errorCard('task.update-not-saved', { quote: ' \n ' }))).toHaveLength(1);
  });
});

describe('resultCard', () => {
  it('caps escaped title and detail independently at the final wire length', () => {
    const c = resultCard({
      icon: 'done',
      title: '*_~@<'.repeat(2000),
      detail: '*_~@<'.repeat(2000),
      tone: 'ok',
    });
    const rendered = contents(c)[0] ?? '';
    expect(rendered.length).toBeLessThanOrEqual(4000);
    expect(rendered).toContain('…');
  });
  it('escapes member or operator supplied title and detail', () => {
    const title = '@everyone **title**';
    const detail = '<@&123456789012345678> **detail**';
    const c = resultCard({ icon: 'done', title, detail, tone: 'ok' });
    expect(contents(c)).toEqual([`**✅ ${escapeText(title)}**\n${escapeText(detail)}`]);
    expect(c.allowedMentions).toEqual({ parse: [] });
    expect(c.art).toEqual([]);
  });

  it('budgets hostile long titles and details on their escaped length', () => {
    const c = resultCard({
      icon: 'done',
      title: '*'.repeat(10000),
      detail: '@<*'.repeat(10000),
      tone: 'ok',
    });
    expect(countText(c.components)).toBeLessThanOrEqual(4000);
    expect(contents(c)[0]).toContain('…');
  });

  it('omits absent detail', () => {
    expect(contents(resultCard({ icon: 'done', title: 'Done', tone: 'ok' }))).toEqual([
      '**✅ Done**',
    ]);
  });

  it('renders an icon title and optional detail in the given tone', () => {
    const c = resultCard({
      icon: 'update',
      title: 'Update saved',
      detail: 'It shows on the task card.',
      tone: 'ok',
    });
    expect(contents(c)).toEqual(['**📝 Update saved**\nIt shows on the task card.']);
    expect(accent(c)).toBe(0x2e9a62);
  });
});
