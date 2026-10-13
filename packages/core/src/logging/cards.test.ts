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
