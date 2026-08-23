import { z } from 'zod';
import type { OutgoingMessage } from '../discord/port.js';
import { MAX_PANEL_OPTIONS, orderedOptions, type PanelConfig, type PanelOption } from './model.js';

/**
 * What a managed panel looks like on Discord, and how a click gets back.
 *
 * The `custom_id` is the only thing Discord hands back when a button is
 * pressed, so it has to carry enough to identify the panel and the option — and
 * it comes back **from the client**, which makes it untrusted input in the
 * strict sense of `CLAUDE.md` rule 3, not merely in theory. A crafted
 * interaction can carry any custom id at all.
 *
 * That is why parsing is a Zod schema rather than a `split(':')`, and why the
 * ids it yields are then *looked up* in the panel's own configuration rather
 * than trusted. A custom id naming a panel that does not exist, or an option
 * the panel does not offer, resolves to nothing and the interaction is ignored.
 * The id is a lookup key, never an instruction.
 */

/** 100 characters, Discord's limit, and the prefix keeps ours apart. */
export const CUSTOM_ID_PREFIX = 'bs.panel';
const MAX_CUSTOM_ID = 100;

export const buildCustomId = (panelId: string, optionId: string): string => {
  const id = `${CUSTOM_ID_PREFIX}:${panelId}:${optionId}`;
  if (id.length > MAX_CUSTOM_ID) {
    // Refused here rather than at send time, where Discord rejects the whole
    // message and the panel simply never appears.
    throw new Error(
      `custom id '${id}' is ${id.length} characters; Discord allows ${MAX_CUSTOM_ID}`,
    );
  }
  return id;
};

/** The select menu's own id; the choice arrives in `values`, not the id. */
export const buildSelectCustomId = (panelId: string): string => buildCustomId(panelId, '_select');

const customIdSchema = z
  .string()
  .max(MAX_CUSTOM_ID)
  .transform((raw, ctx) => {
    const parts = raw.split(':');
    if (parts.length !== 3 || parts[0] !== CUSTOM_ID_PREFIX) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a Bananasaurs panel custom id' });
      return z.NEVER;
    }
    const [, panelId, optionId] = parts;
    if (panelId === undefined || panelId === '' || optionId === undefined || optionId === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'panel or option id missing' });
      return z.NEVER;
    }
    return { panelId, optionId };
  });

export interface ParsedCustomId {
  readonly panelId: string;
  readonly optionId: string;
}

/**
 * Non-throwing, because an unparseable custom id is an ordinary event — another
 * bot's component in a channel we can see, or a stale panel from before an
 * upgrade — not an error to log at warn level.
 */
export const parseCustomId = (raw: string): ParsedCustomId | undefined => {
  const result = customIdSchema.safeParse(raw);
  return result.success ? result.data : undefined;
};

export const isSelectCustomId = (parsed: ParsedCustomId): boolean => parsed.optionId === '_select';

// --- rendering ---------------------------------------------------------------

/**
 * Discord's component shapes, as plain data.
 *
 * `core` may not import discord.js (ADR 0014), so these are the wire shapes
 * rather than builder objects. The adapter passes them straight through, which
 * is also what makes a panel's rendering assertable in a test with no client.
 */
const ACTION_ROW = 1;
const BUTTON = 2;
const STRING_SELECT = 3;
/** Discord's "secondary" style: grey, which suits a role toggle. */
const BUTTON_STYLE_SECONDARY = 2;
/** Five buttons to a row, five rows to a message. */
const BUTTONS_PER_ROW = 5;

const emojiForComponent = (option: PanelOption): Record<string, unknown> | undefined => {
  if (option.emojiKey === undefined) return undefined;
  if (option.emojiKey.startsWith('c:')) return { id: option.emojiKey.slice(2) };
  // `u:1f9e0-200d-…` back to the characters Discord expects on the wire.
  const codepoints = option.emojiKey
    .slice(2)
    .split('-')
    .map((hex) => Number.parseInt(hex, 16));
  return { name: String.fromCodePoint(...codepoints) };
};

export const buildComponents = (panel: PanelConfig): readonly unknown[] => {
  const options = orderedOptions(panel);
  if (options.length > MAX_PANEL_OPTIONS) {
    throw new Error(`panel ${panel.panelId} has more options than Discord will render`);
  }

  if (panel.component === 'select') {
    return [
      {
        type: ACTION_ROW,
        components: [
          {
            type: STRING_SELECT,
            custom_id: buildSelectCustomId(panel.panelId),
            // `min_values: 0` is what lets a member clear their choice. Without
            // it a single-choice panel is a one-way door.
            min_values: 0,
            max_values: panel.behaviour === 'single_choice' ? 1 : options.length,
            options: options.map((option) => ({
              label: option.label ?? option.optionId,
              value: option.optionId,
              ...(emojiForComponent(option) ? { emoji: emojiForComponent(option) } : {}),
            })),
          },
        ],
      },
    ];
  }

  const rows: unknown[] = [];
  for (let i = 0; i < options.length; i += BUTTONS_PER_ROW) {
    rows.push({
      type: ACTION_ROW,
      components: options.slice(i, i + BUTTONS_PER_ROW).map((option) => ({
        type: BUTTON,
        style: BUTTON_STYLE_SECONDARY,
        custom_id: buildCustomId(panel.panelId, option.optionId),
        label: option.label ?? option.optionId,
        ...(emojiForComponent(option) ? { emoji: emojiForComponent(option) } : {}),
      })),
    });
  }
  return rows;
};

export const renderPanelMessage = (
  panel: PanelConfig,
  content: string | undefined,
): OutgoingMessage => ({
  content: content ?? `Pick your roles.`,
  components: buildComponents(panel),
});
