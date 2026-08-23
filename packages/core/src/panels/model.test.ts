import { describe, expect, it } from 'vitest';
import { parseSnowflakeId } from '../ids.js';
import {
  emojiKeySchema,
  optionByEmoji,
  optionById,
  orderedOptions,
  panelDefinitionSchema,
  panelRoleIds,
  type PanelConfig,
} from './model.js';

const ROLE_A = '111111111111111111';
const ROLE_B = '222222222222222222';
const CHANNEL = '333333333333333333';
const MESSAGE = '444444444444444444';

const adopted = (over: Record<string, unknown> = {}) => ({
  panelId: 'roles',
  kind: 'adopted',
  channelId: CHANNEL,
  messageId: MESSAGE,
  behaviour: 'toggle',
  component: 'reaction',
  options: [
    { optionId: 'a', roleId: ROLE_A, emojiKey: 'u:1f9e0', position: 0 },
    { optionId: 'b', roleId: ROLE_B, emojiKey: 'u:2714', position: 1 },
  ],
  ...over,
});

const managed = (over: Record<string, unknown> = {}) => ({
  panelId: 'roles',
  kind: 'managed',
  channelId: CHANNEL,
  behaviour: 'single_choice',
  component: 'button',
  options: [
    { optionId: 'a', roleId: ROLE_A, label: 'Alpha', position: 0 },
    { optionId: 'b', roleId: ROLE_B, label: 'Beta', position: 1 },
  ],
  ...over,
});

/** The message a failed parse produced, so a test asserts what an owner reads. */
const errorFor = (input: unknown): string => {
  const result = panelDefinitionSchema.safeParse(input);
  if (result.success) throw new Error('expected the definition to be refused, but it parsed');
  return result.error.issues.map((i) => i.message).join('\n');
};

describe('a valid definition', () => {
  it('accepts an adopted reaction panel', () => {
    const result = panelDefinitionSchema.safeParse(adopted());
    expect(result.success).toBe(true);
  });

  it('accepts a managed button panel', () => {
    expect(panelDefinitionSchema.safeParse(managed()).success).toBe(true);
  });

  it('defaults blockedRoleIds to empty rather than undefined', () => {
    const result = panelDefinitionSchema.parse(adopted());
    expect(result.blockedRoleIds).toEqual([]);
  });
});

describe('collision 1 — single_choice on an adopted panel', () => {
  /**
   * There is a CHECK for this too. The validator exists so the owner is told
   * what to do instead of being handed SQLITE_CONSTRAINT_CHECK (docs/19 §6.3).
   */
  it('is refused', () => {
    expect(panelDefinitionSchema.safeParse(adopted({ behaviour: 'single_choice' })).success).toBe(
      false,
    );
  });

  it('explains why, and points at button panels', () => {
    const message = errorFor(adopted({ behaviour: 'single_choice' }));
    expect(message).toContain('Manage Messages');
    expect(message).toContain('managed panel');
  });

  it('permits single_choice on a managed panel', () => {
    expect(panelDefinitionSchema.safeParse(managed({ behaviour: 'single_choice' })).success).toBe(
      true,
    );
  });
});

describe('kind and component must agree', () => {
  it('refuses buttons on an adopted panel', () => {
    const message = errorFor(
      adopted({
        component: 'button',
        options: [{ optionId: 'a', roleId: ROLE_A, label: 'Alpha', position: 0 }],
      }),
    );
    expect(message).toContain('may only add components to its own');
  });

  it('refuses an adopted panel with no message to attach to', () => {
    expect(errorFor(adopted({ messageId: undefined }))).toContain('messageId is required');
  });
});

describe('an option carries what its component needs', () => {
  it('refuses a reaction option without an emoji', () => {
    const message = errorFor(
      adopted({ options: [{ optionId: 'a', roleId: ROLE_A, position: 0 }] }),
    );
    expect(message).toContain('needs an emoji for every option');
  });

  it('refuses a button option without a label', () => {
    const message = errorFor(
      managed({ options: [{ optionId: 'a', roleId: ROLE_A, position: 0 }] }),
    );
    expect(message).toContain('needs a label for every option');
  });

  it('refuses an emoji key that did not come from core/discord/emoji', () => {
    // The raw character, not the canonical key. Storing this is how a panel
    // silently ignores half its reactions: one client sends U+2714 U+FE0F and
    // another bare U+2714.
    const message = errorFor(
      adopted({ options: [{ optionId: 'a', roleId: ROLE_A, emojiKey: '✔️', position: 0 }] }),
    );
    expect(message).toContain('canonical emoji key');
  });
});

describe('duplicates inside one panel', () => {
  it('refuses two options offering the same role', () => {
    const message = errorFor(
      adopted({
        options: [
          { optionId: 'a', roleId: ROLE_A, emojiKey: 'u:1f9e0', position: 0 },
          { optionId: 'b', roleId: ROLE_A, emojiKey: 'u:2714', position: 1 },
        ],
      }),
    );
    expect(message).toContain('same role');
  });

  it('refuses two options using the same emoji', () => {
    const message = errorFor(
      adopted({
        options: [
          { optionId: 'a', roleId: ROLE_A, emojiKey: 'u:1f9e0', position: 0 },
          { optionId: 'b', roleId: ROLE_B, emojiKey: 'u:1f9e0', position: 1 },
        ],
      }),
    );
    expect(message).toContain('same emoji');
  });

  it('refuses a duplicate optionId', () => {
    const message = errorFor(
      adopted({
        options: [
          { optionId: 'a', roleId: ROLE_A, emojiKey: 'u:1f9e0', position: 0 },
          { optionId: 'a', roleId: ROLE_B, emojiKey: 'u:2714', position: 1 },
        ],
      }),
    );
    expect(message).toContain("duplicate optionId 'a'");
  });
});

describe('limits', () => {
  it('refuses maxRoles of zero', () => {
    expect(panelDefinitionSchema.safeParse(adopted({ maxRoles: 0 })).success).toBe(false);
  });

  it('refuses a panel with no options at all', () => {
    expect(panelDefinitionSchema.safeParse(adopted({ options: [] })).success).toBe(false);
  });

  it('refuses more options than Discord will render', () => {
    const many = Array.from({ length: 26 }, (_, i) => ({
      optionId: `o${i}`,
      roleId: parseSnowflakeId(String(100000000000000000n + BigInt(i))),
      emojiKey: `u:${(0x1f000 + i).toString(16)}`,
      position: i,
    }));
    expect(panelDefinitionSchema.safeParse(adopted({ options: many })).success).toBe(false);
  });

  it('refuses a panel whose required role is also blocked', () => {
    const message = errorFor(adopted({ requiredRoleId: ROLE_A, blockedRoleIds: [ROLE_A] }));
    expect(message).toContain('nobody could ever use this panel');
  });
});

describe('emojiKeySchema', () => {
  it.each(['u:1f9e0', 'u:1f469-200d-1f4bb', 'c:123456789012345678'])('accepts %s', (key) => {
    expect(emojiKeySchema.safeParse(key).success).toBe(true);
  });

  it.each(['✔️', 'u:', 'c:12', '1f9e0', 'u:ZZZZ'])('refuses %s', (key) => {
    expect(emojiKeySchema.safeParse(key).success).toBe(false);
  });
});

describe('helpers', () => {
  const panel: PanelConfig = {
    panelId: 'roles',
    kind: 'adopted',
    channelId: parseSnowflakeId(CHANNEL),
    messageId: parseSnowflakeId(MESSAGE),
    behaviour: 'toggle',
    component: 'reaction',
    maxRoles: undefined,
    requiredRoleId: undefined,
    blockedRoleIds: [],
    status: 'enabled',
    adoptionPassState: 'done',
    options: [
      {
        optionId: 'b',
        roleId: parseSnowflakeId(ROLE_B),
        emojiKey: 'u:2714',
        label: undefined,
        position: 5,
      },
      {
        optionId: 'a',
        roleId: parseSnowflakeId(ROLE_A),
        emojiKey: 'u:1f9e0',
        label: undefined,
        position: 1,
      },
    ],
  };

  it('orders options by position, not by insertion', () => {
    expect(orderedOptions(panel).map((o) => o.optionId)).toEqual(['a', 'b']);
  });

  it('breaks a position tie deterministically, so a clamp is reproducible', () => {
    const tied: PanelConfig = {
      ...panel,
      options: panel.options.map((o) => ({ ...o, position: 0 })),
    };
    expect(orderedOptions(tied).map((o) => o.optionId)).toEqual(['a', 'b']);
  });

  it('lists exactly the roles the panel offers', () => {
    expect([...panelRoleIds(panel)].sort()).toEqual([ROLE_A, ROLE_B].sort());
  });

  it('finds an option by emoji and by id', () => {
    expect(optionByEmoji(panel, 'u:1f9e0')?.optionId).toBe('a');
    expect(optionByEmoji(panel, 'u:0000')).toBeUndefined();
    expect(optionById(panel, 'b')?.roleId).toBe(ROLE_B);
  });
});
