import { describe, expect, it } from 'vitest';
import { parseSnowflakeId } from '../ids.js';
import type { PanelConfig } from './model.js';
import {
  buildComponents,
  buildCustomId,
  buildSelectCustomId,
  isSelectCustomId,
  parseCustomId,
  renderPanelMessage,
} from './components.js';

const ROLE = (n: number) => parseSnowflakeId(String(100000000000000000n + BigInt(n)));

const panelWith = (over: Partial<PanelConfig> = {}): PanelConfig => ({
  panelId: 'roles',
  kind: 'managed',
  channelId: parseSnowflakeId('222222222222222222'),
  messageId: undefined,
  behaviour: 'toggle',
  component: 'button',
  maxRoles: undefined,
  requiredRoleId: undefined,
  blockedRoleIds: [],
  status: 'enabled',
  adoptionPassState: 'done',
  adoptionBlockedCount: 0,
  options: [
    { optionId: 'alpha', roleId: ROLE(1), emojiKey: 'u:1f9e0', label: 'Alpha', position: 0 },
    { optionId: 'beta', roleId: ROLE(2), emojiKey: undefined, label: 'Beta', position: 1 },
  ],
  ...over,
});

describe('custom ids are a lookup key, never an instruction', () => {
  it('round-trips a panel and option id', () => {
    expect(parseCustomId(buildCustomId('roles', 'alpha'))).toEqual({
      panelId: 'roles',
      optionId: 'alpha',
    });
  });

  it.each([
    ["another bot's component", 'someoneelse:thing'],
    ['our prefix with a part missing', 'bs.panel:roles'],
    ['an empty option id', 'bs.panel:roles:'],
    ['an empty panel id', 'bs.panel::alpha'],
    ['an extra segment, which a crafted payload could add', 'bs.panel:roles:alpha:extra'],
    ['nothing at all', ''],
  ])('refuses %s', (_name, raw) => {
    expect(parseCustomId(raw)).toBeUndefined();
  });

  it('refuses an id longer than Discord permits', () => {
    expect(parseCustomId(`bs.panel:${'x'.repeat(200)}:alpha`)).toBeUndefined();
  });

  it('refuses to build one longer than Discord permits, rather than at send time', () => {
    // Discord rejects the whole message, so the panel would simply never appear
    // and the cause would be a 400 with no obvious link to the option id.
    expect(() => buildCustomId('roles', 'x'.repeat(120))).toThrow(/Discord allows 100/);
  });

  it('recognises the select menu id, whose choice arrives in values', () => {
    const parsed = parseCustomId(buildSelectCustomId('roles'));
    expect(parsed).toBeDefined();
    expect(parsed && isSelectCustomId(parsed)).toBe(true);
  });
});

describe('buttons', () => {
  it('renders one button per option, carrying its custom id', () => {
    const rows = buildComponents(panelWith()) as {
      components: { custom_id: string; label: string }[];
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.components.map((c) => c.custom_id)).toEqual([
      'bs.panel:roles:alpha',
      'bs.panel:roles:beta',
    ]);
    expect(rows[0]?.components.map((c) => c.label)).toEqual(['Alpha', 'Beta']);
  });

  it('wraps at five to a row, because Discord refuses six', () => {
    const options = Array.from({ length: 7 }, (_, i) => ({
      optionId: `o${i}`,
      roleId: ROLE(i + 10),
      emojiKey: undefined,
      label: `Option ${i}`,
      position: i,
    }));
    const rows = buildComponents(panelWith({ options })) as { components: unknown[] }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.components).toHaveLength(5);
    expect(rows[1]?.components).toHaveLength(2);
  });

  it('turns a canonical emoji key back into what Discord expects on the wire', () => {
    const rows = buildComponents(panelWith()) as {
      components: { emoji?: { name?: string; id?: string } }[];
    }[];
    expect(rows[0]?.components[0]?.emoji?.name).toBe('🧠');
    // No emoji configured: the field is absent rather than null, which Discord
    // rejects.
    expect(rows[0]?.components[1]).not.toHaveProperty('emoji');
  });

  it('passes a custom emoji through by id', () => {
    const rows = buildComponents(
      panelWith({
        options: [
          {
            optionId: 'alpha',
            roleId: ROLE(1),
            emojiKey: 'c:123456789012345678',
            label: 'Alpha',
            position: 0,
          },
        ],
      }),
    ) as { components: { emoji?: { id?: string } }[] }[];
    expect(rows[0]?.components[0]?.emoji?.id).toBe('123456789012345678');
  });

  it('orders buttons by position, not by storage order', () => {
    const rows = buildComponents(
      panelWith({
        options: [
          { optionId: 'beta', roleId: ROLE(2), emojiKey: undefined, label: 'Beta', position: 5 },
          { optionId: 'alpha', roleId: ROLE(1), emojiKey: undefined, label: 'Alpha', position: 1 },
        ],
      }),
    ) as { components: { label: string }[] }[];
    expect(rows[0]?.components.map((c) => c.label)).toEqual(['Alpha', 'Beta']);
  });
});

describe('select menus', () => {
  it('renders one menu whose values are option ids', () => {
    const rows = buildComponents(panelWith({ component: 'select' })) as {
      components: { custom_id: string; options: { value: string }[] }[];
    }[];
    expect(rows[0]?.components[0]?.custom_id).toBe('bs.panel:roles:_select');
    expect(rows[0]?.components[0]?.options.map((o) => o.value)).toEqual(['alpha', 'beta']);
  });

  it('permits clearing the selection, so a choice is not a one-way door', () => {
    const rows = buildComponents(panelWith({ component: 'select' })) as {
      components: { min_values: number }[];
    }[];
    expect(rows[0]?.components[0]?.min_values).toBe(0);
  });

  it('caps a single_choice menu at one value', () => {
    const rows = buildComponents(
      panelWith({ component: 'select', behaviour: 'single_choice' }),
    ) as { components: { max_values: number }[] }[];
    expect(rows[0]?.components[0]?.max_values).toBe(1);
  });

  it('lets a toggle menu take every option', () => {
    const rows = buildComponents(panelWith({ component: 'select' })) as {
      components: { max_values: number }[];
    }[];
    expect(rows[0]?.components[0]?.max_values).toBe(2);
  });
});

describe('the posted message', () => {
  it("uses the panel's own content when set", () => {
    const message = renderPanelMessage(panelWith(), 'React to pick up a role!');
    expect(message.content).toBe('React to pick up a role!');
  });

  it('falls back to plain default copy when no content is set', () => {
    const message = renderPanelMessage(panelWith(), undefined);
    expect(message.content).toBe('Pick your roles.');
  });
});
