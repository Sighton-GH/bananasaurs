import { describe, expect, it } from 'vitest';
import { parseSnowflakeId } from '../ids.js';
import { cardCustomIds, cardTexts } from '../ui/discord/inspect.js';
import type { ActionRow, Button, Container, StringSelect } from '../ui/discord/kit.js';
import type { PanelBehaviour, PanelComponent, PanelConfig } from './model.js';
import {
  buildComponents,
  buildCustomId,
  buildSelectCustomId,
  isSelectCustomId,
  parseCustomId,
  renderPanelCard,
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
    const rows = buildComponents(panelWith()) as ActionRow[];
    expect(rows).toHaveLength(1);
    const buttons = rows[0]?.components as Button[];
    expect(buttons.map((c) => c.custom_id)).toEqual([
      'bs.panel:roles:alpha',
      'bs.panel:roles:beta',
    ]);
    expect(buttons.map((c) => c.label)).toEqual(['Alpha', 'Beta']);
  });

  it('wraps at five to a row, because Discord refuses six', () => {
    const options = Array.from({ length: 7 }, (_, i) => ({
      optionId: `o${i}`,
      roleId: ROLE(i + 10),
      emojiKey: undefined,
      label: `Option ${i}`,
      position: i,
    }));
    const rows = buildComponents(panelWith({ options })) as ActionRow[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.components).toHaveLength(5);
    expect(rows[1]?.components).toHaveLength(2);
  });

  it('turns a canonical emoji key back into what Discord expects on the wire', () => {
    const buttons = (buildComponents(panelWith()) as ActionRow[])[0]?.components as Button[];
    expect(buttons[0]?.emoji).toEqual({ name: '🧠' });
    // No emoji configured: the field is absent rather than null, which Discord
    // rejects.
    expect(buttons[1]).not.toHaveProperty('emoji');
  });

  it('passes a custom emoji through by id', () => {
    const buttons = (
      buildComponents(
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
      ) as ActionRow[]
    )[0]?.components as Button[];
    expect(buttons[0]?.emoji).toEqual({ id: '123456789012345678' });
  });

  it('orders buttons by position, not by storage order', () => {
    const buttons = (
      buildComponents(
        panelWith({
          options: [
            { optionId: 'beta', roleId: ROLE(2), emojiKey: undefined, label: 'Beta', position: 5 },
            {
              optionId: 'alpha',
              roleId: ROLE(1),
              emojiKey: undefined,
              label: 'Alpha',
              position: 1,
            },
          ],
        }),
      ) as ActionRow[]
    )[0]?.components as Button[];
    expect(buttons.map((c) => c.label)).toEqual(['Alpha', 'Beta']);
  });
});

describe('select menus', () => {
  it('renders one menu whose values are option ids', () => {
    const selects = (buildComponents(panelWith({ component: 'select' })) as ActionRow[])[0]
      ?.components as StringSelect[];
    expect(selects[0]?.custom_id).toBe('bs.panel:roles:_select');
    expect(selects[0]?.options.map((o) => o.value)).toEqual(['alpha', 'beta']);
  });

  it('permits clearing the selection, so a choice is not a one-way door', () => {
    const selects = (buildComponents(panelWith({ component: 'select' })) as ActionRow[])[0]
      ?.components as StringSelect[];
    expect(selects[0]?.min_values).toBe(0);
  });

  it('caps a single_choice menu at one value', () => {
    const selects = (
      buildComponents(panelWith({ component: 'select', behaviour: 'single_choice' })) as ActionRow[]
    )[0]?.components as StringSelect[];
    expect(selects[0]?.max_values).toBe(1);
  });

  it('lets a toggle menu take every option', () => {
    const selects = (buildComponents(panelWith({ component: 'select' })) as ActionRow[])[0]
      ?.components as StringSelect[];
    expect(selects[0]?.max_values).toBe(2);
  });
});

const threeOptions = (): PanelConfig =>
  panelWith({
    options: [
      { optionId: 'mech', roleId: ROLE(1), emojiKey: 'u:1f527', label: 'Mechanical', position: 0 },
      { optionId: 'elec', roleId: ROLE(2), emojiKey: undefined, label: 'Electrical', position: 1 },
      { optionId: 'soft', roleId: ROLE(3), emojiKey: undefined, label: 'Software', position: 2 },
    ],
  });

const containerOf = (panel: PanelConfig): Container =>
  renderPanelCard(panel).components[0] as Container;

describe('renderPanelCard', () => {
  it('posts one container whose first child is the panel banner', () => {
    const card = renderPanelCard(threeOptions());
    expect(card.components).toHaveLength(1);
    const [first] = (card.components[0] as Container).components;
    expect(first).toMatchObject({
      type: 12,
      items: [{ media: { url: 'attachment://banner-panel.png' } }],
    });
    expect(card.art).toEqual(['bannerPanel']);
  });

  it('posts the owner text exactly as written, without pinging', () => {
    const card = renderPanelCard(panelWith({ content: '**Bold** <@&123>' }));
    expect(cardTexts(card.components)).toContain('**Bold** <@&123>');
    expect(cardTexts(card.components)).not.toContain('\\*\\*Bold');
    expect(card.allowedMentions).toEqual({ parse: [] });
  });

  it('falls back to Pick your roles with no content', () => {
    const card = renderPanelCard(panelWith({ content: undefined }));
    expect(cardTexts(card.components)).toContain('**Pick your roles**');
  });

  const HINTS: readonly (readonly [PanelBehaviour, PanelComponent, string])[] = [
    ['toggle', 'button', 'Press a role to add it. Press it again to remove it.'],
    ['add_only', 'button', "Press a role to add it. This panel doesn't remove roles."],
    ['remove_only', 'button', 'Press a role to remove it.'],
    ['single_choice', 'button', 'Pick one. Picking another swaps it.'],
    ['toggle', 'select', 'Choose from the menu. Clear your choice to remove the role.'],
    ['remove_only', 'select', 'Choose from the menu. Clear your choice to remove the role.'],
    ['single_choice', 'select', 'Choose from the menu. Clear your choice to remove the role.'],
    ['add_only', 'select', 'Choose from the menu.'],
  ];

  it.each(HINTS)('a %s %s panel hints "%s"', (behaviour, component, hint) => {
    const card = renderPanelCard(panelWith({ behaviour, component }));
    expect(cardTexts(card.components)).toContain(hint);
  });

  it('lays 25 options out as five rows of five with the same custom ids', () => {
    const options = Array.from({ length: 25 }, (_, i) => ({
      optionId: `o${i}`,
      roleId: ROLE(i + 10),
      emojiKey: undefined,
      label: `Option ${i}`,
      position: i,
    }));
    const card = renderPanelCard(panelWith({ options }));
    // Banner, content, hint, separator, then the five rows.
    const rows = containerOf(panelWith({ options })).components.slice(4) as ActionRow[];
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.components).toHaveLength(5);
    expect(cardCustomIds(card.components)).toEqual(
      options.map((o) => buildCustomId('roles', o.optionId)),
    );
  });

  it('renders a select panel as one menu that can be cleared', () => {
    const rows = containerOf(panelWith({ component: 'select' })).components.slice(4) as ActionRow[];
    expect(rows).toHaveLength(1);
    const selects = rows[0]?.components as StringSelect[];
    expect(selects).toHaveLength(1);
    expect(selects[0]?.custom_id).toBe(buildSelectCustomId('roles'));
    expect(selects[0]?.min_values).toBe(0);
    expect(selects[0]?.max_values).toBe(2);
  });

  it('caps a single_choice select menu at one value', () => {
    const rows = containerOf(
      panelWith({ component: 'select', behaviour: 'single_choice' }),
    ).components.slice(4) as ActionRow[];
    const selects = rows[0]?.components as StringSelect[];
    expect(selects[0]?.max_values).toBe(1);
  });

  it('passes a custom emoji by id and a unicode emoji by name', () => {
    const card = renderPanelCard(
      panelWith({
        options: [
          { optionId: 'c', roleId: ROLE(1), emojiKey: 'c:123', label: 'Custom', position: 0 },
          { optionId: 'u', roleId: ROLE(2), emojiKey: 'u:1f527', label: 'Unicode', position: 1 },
        ],
      }),
    );
    const cardButtons = (card.components[0] as Container).components.slice(4) as ActionRow[];
    const rendered = cardButtons[0]?.components as Button[];
    expect(rendered[0]?.emoji).toEqual({ id: '123' });
    expect(rendered[1]?.emoji).toEqual({ name: '🔧' });
  });
});
