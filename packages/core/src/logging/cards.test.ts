import { describe, expect, it } from 'vitest';
import { countComponents, countText } from '../ui/discord/budget.js';
import { renderLogCard, type LogCardView } from './cards.js';

const G = '100000000000000000';
const C = '111111111111111111';
const M = '222222222222222222';
const U = '333333333333333333';
const AT = 1_760_000_000_000;

const texts = (c: { components: readonly unknown[] }): string => {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    if (o['type'] === 10 && typeof o['content'] === 'string') out.push(o['content']);
    walk(o['components']);
  };
  walk(c.components);
  return out.join('\n');
};
const customIds = (c: { components: readonly unknown[] }): string[] =>
  JSON.stringify(c.components).match(/bs\.mod:[^"]+/g) ?? [];

const edit: LogCardView = {
  kind: 'message_edit',
  headline: `<@${U}> edited a message in <#${C}>`,
  quote: { label: 'Now reads', text: 'hello **world** @everyone' },
  at: AT,
  memberId: U,
  message: { channelId: C, messageId: M, exists: true },
};

describe('renderLogCard', () => {
  it('has an eyebrow, the headline, an escaped quote, a jump link and a relative time', () => {
    const t = texts(renderLogCard(edit, G));
    expect(t).toContain('-# ✏️ MESSAGE EDITED');
    expect(t).toContain(`<@${U}> edited a message in <#${C}>`);
    expect(t).toContain('**Now reads**\n> hello \\*\\*world\\*\\* @​everyone');
    expect(t).toContain(`https://discord.com/channels/${G}/${C}/${M}`);
    expect(t).toContain(`<t:${AT / 1000}:R>`);
  });

  it('never pings and carries no art', () => {
    const c = renderLogCard(edit, G);
    expect(c.allowedMentions).toEqual({ parse: [] });
    expect(c.art).toEqual([]);
  });

  it('offers Delete, Warn and Timeout on a message that still exists', () => {
    expect(customIds(renderLogCard(edit, G))).toEqual([
      `bs.mod:delete:${C}:${M}:${U}`,
      `bs.mod:warn:${U}`,
      `bs.mod:timeout:${U}`,
    ]);
  });

  it('drops Delete when the message is gone', () => {
    const c = renderLogCard(
      { ...edit, kind: 'message_delete', message: { channelId: C, messageId: M, exists: false } },
      G,
    );
    expect(customIds(c)).toEqual([`bs.mod:warn:${U}`, `bs.mod:timeout:${U}`]);
  });

  it('offers nothing on kinds that are not conduct', () => {
    const c = renderLogCard(
      {
        kind: 'member_nickname_changed',
        headline: `<@${U}> changed nickname`,
        at: AT,
        memberId: U,
      },
      G,
    );
    expect(customIds(c)).toEqual([]);
  });

  it('spoilers a quote when asked', () => {
    const t = texts(
      renderLogCard(
        { ...edit, kind: 'automod_match', quote: { label: 'Matched', text: 'bad', spoiler: true } },
        G,
      ),
    );
    expect(t).toContain('> ||bad||');
  });

  it('keeps repaired quote truncation within the exact cap', () => {
    const nonSpoilerText = [
      'a'.repeat(391),
      ...Array.from({ length: 368 }, () => 'a'),
      'b'.repeat(500),
    ].join('\n');
    const spoilerText = [
      'a'.repeat(384),
      ...Array.from({ length: 368 }, () => 'a'),
      'b'.repeat(500),
    ].join('\n');
    const display = (view: LogCardView): string =>
      displaysOf(
        renderLogCard({ ...edit, ...(view.quote === undefined ? {} : { quote: view.quote }) }, G),
      ).find((d) => d.startsWith('**Cut**')) ?? '';
    const nonSpoiler = display({
      kind: 'message_edit',
      headline: 'x',
      quote: { label: 'Cut', text: nonSpoilerText },
      at: AT,
    });
    const spoiler = display({
      kind: 'message_edit',
      headline: 'x',
      quote: { label: 'Cut', text: spoilerText, spoiler: true },
      at: AT,
    });

    expect(nonSpoiler.length).toBeLessThanOrEqual(1500);
    expect(nonSpoiler.endsWith('> …')).toBe(true);
    expect(spoiler.length).toBeLessThanOrEqual(1500);
    expect(spoiler.endsWith('> …||')).toBe(true);
    expect((spoiler.match(/\|\|/g) ?? []).length % 2).toBe(0);
  });

  it('caps hostile content and stays in budget', () => {
    const c = renderLogCard(
      { ...edit, quote: { label: 'Now reads', text: '```'.repeat(2000) } },
      G,
    );
    expect(countText(c.components)).toBeLessThanOrEqual(4000);
    expect(countComponents(c.components)).toBeLessThanOrEqual(40);
  });

  it('shows audit changes in a code block that cannot be closed early', () => {
    const t = texts(
      renderLogCard(
        {
          kind: 'channel_update',
          headline: 'Channel changed',
          changes: ['name: "a" → "b```"'],
          at: AT,
        },
        G,
      ),
    );
    expect(t).toContain('```\nname: "a" → "bˋˋˋ"\n```');
  });

  const displaysOf = (c: { components: readonly unknown[] }): string[] => {
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

  /** Odd `||` means a cut inside a spoiler; odd ``` means a cut code fence. */
  const countOccurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;

  const expectQuotedAndBalanced = (display: string, label: string): void => {
    const lines = display.split('\n');
    expect(lines[0]).toBe(`**${label}**`);
    for (const line of lines.slice(1)) expect(line.startsWith('> ')).toBe(true);
    expect(countOccurrences(display, '||') % 2).toBe(0);
    expect(countOccurrences(display, '```') % 2).toBe(0);
  };

  const expectWithinBudget = (c: { components: readonly unknown[] }): void => {
    expect(countText(c.components)).toBeLessThanOrEqual(4000);
    expect(countComponents(c.components)).toBeLessThanOrEqual(40);
  };

  describe('worst-case budget (P2 fix wave)', () => {
    it('message_edit with 4,000 hostile chars before and after stays in budget', () => {
      const view: LogCardView = {
        kind: 'message_edit',
        headline: `<@${U}> edited a message in <#${C}>`,
        details: [`Before:\n${'*\n'.repeat(2000)}`],
        quote: { label: 'Now reads', text: '*\n'.repeat(2000), spoiler: true },
        at: AT,
        memberId: U,
        message: { channelId: C, messageId: M, exists: true },
      };
      expect(view.details?.[0]).toHaveLength(4008);
      expect(view.quote?.text).toHaveLength(4000);
      let rendered: ReturnType<typeof renderLogCard>;
      expect(() => {
        rendered = renderLogCard(view, G);
      }).not.toThrow();
      rendered = renderLogCard(view, G);
      expectWithinBudget(rendered);
      const displays = displaysOf(rendered);
      expect(displays[0]?.length).toBeLessThanOrEqual(1000);
      const quote = displays.find((d) => d.startsWith('**Now reads**')) ?? '';
      expect(quote.length).toBeLessThanOrEqual(1500);
      expectQuotedAndBalanced(quote, 'Now reads');
    });

    it('message_delete with 4,000 pipe characters stays in budget', () => {
      const view: LogCardView = {
        kind: 'message_delete',
        headline: `Message by <@${U}> deleted in <#${C}>`,
        quote: { label: 'It read', text: '|'.repeat(4000) },
        at: AT,
        memberId: U,
        message: { channelId: C, messageId: M, exists: false },
      };
      let rendered: ReturnType<typeof renderLogCard>;
      expect(() => {
        rendered = renderLogCard(view, G);
      }).not.toThrow();
      rendered = renderLogCard(view, G);
      expectWithinBudget(rendered);
      const quote = displaysOf(rendered).find((d) => d.startsWith('**It read**')) ?? '';
      expect(quote.length).toBeLessThanOrEqual(1500);
      expectQuotedAndBalanced(quote, 'It read');
    });

    it('a member update with 200 change lines of 100 characters stays in budget', () => {
      const view: LogCardView = {
        kind: 'member_roles_changed',
        headline: `<@${U}> roles changed`,
        changes: Array.from({ length: 200 }, (_, i) => `c${i} `.padEnd(100, 'x')),
        at: AT,
        memberId: U,
      };
      for (const line of view.changes ?? []) expect(line).toHaveLength(100);
      let rendered: ReturnType<typeof renderLogCard>;
      expect(() => {
        rendered = renderLogCard(view, G);
      }).not.toThrow();
      rendered = renderLogCard(view, G);
      expectWithinBudget(rendered);
      const changes = displaysOf(rendered).find((d) => d.startsWith('```')) ?? '';
      expect(changes.length).toBeLessThanOrEqual(1300);
      expect(changes.endsWith('```')).toBe(true);
      expect(countOccurrences(changes, '```') % 2).toBe(0);
    });

    it('a 3,000-character headline with 20 detail lines of 500 characters stays in budget', () => {
      const view: LogCardView = {
        kind: 'member_nickname_changed',
        headline: 'h'.repeat(3000),
        details: Array.from({ length: 20 }, () => 'd'.repeat(500)),
        at: AT,
        memberId: U,
      };
      let rendered: ReturnType<typeof renderLogCard>;
      expect(() => {
        rendered = renderLogCard(view, G);
      }).not.toThrow();
      rendered = renderLogCard(view, G);
      expectWithinBudget(rendered);
      expect(displaysOf(rendered)[0]?.length).toBeLessThanOrEqual(1000);
    });
  });

  it('uses each kind’s tone', () => {
    const accent = (c: { components: readonly unknown[] }) =>
      (c.components[0] as { accent_color: number }).accent_color;
    expect(accent(renderLogCard({ kind: 'member_ban', headline: 'x', at: AT }, G))).toBe(0xd64545);
    expect(accent(renderLogCard({ kind: 'automod_match', headline: 'x', at: AT }, G))).toBe(
      0xe0a526,
    );
    expect(accent(renderLogCard({ kind: 'member_join', headline: 'x', at: AT }, G))).toBe(0x64748b);
  });
});
