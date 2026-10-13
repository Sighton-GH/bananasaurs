import { z } from 'zod';
import { ART, artUrl } from '../ui/discord/art.js';
import { card, type CardMessage } from '../ui/discord/card.js';
import {
  actionRow,
  button,
  gallery,
  selectRow,
  separator,
  stringSelect,
  text,
  type ActionRow,
} from '../ui/discord/kit.js';
import { subtext, truncate } from '../ui/discord/text.js';
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

/** Five buttons to a row, five rows to a message. */
const BUTTONS_PER_ROW = 5;

/**
 * The emoji for one option, as a spreadable fragment: absent, `{ id }` for a
 * custom emoji, or the characters for a unicode one.
 */
const emojiFor = (option: PanelOption): { readonly emoji?: string | { readonly id: string } } => {
  if (option.emojiKey === undefined) return {};
  if (option.emojiKey.startsWith('c:')) return { emoji: { id: option.emojiKey.slice(2) } };
  // `u:1f9e0-200d-…` back to the characters Discord expects on the wire.
  const codepoints = option.emojiKey
    .slice(2)
    .split('-')
    .map((hex) => Number.parseInt(hex, 16));
  return { emoji: String.fromCodePoint(...codepoints) };
};

/** A select option's wire emoji: the kit's `SelectOption` takes `{ name }`, not bare characters. */
const selectEmojiFor = (
  option: PanelOption,
): { readonly emoji?: { readonly name: string } | { readonly id: string } } => {
  const { emoji } = emojiFor(option);
  if (emoji === undefined) return {};
  return typeof emoji === 'string' ? { emoji: { name: emoji } } : { emoji };
};

export const buildComponents = (panel: PanelConfig): readonly ActionRow[] => {
  const options = orderedOptions(panel);
  if (options.length > MAX_PANEL_OPTIONS) {
    throw new Error(`panel ${panel.panelId} has more options than Discord will render`);
  }

  if (panel.component === 'select') {
    return [
      selectRow(
        stringSelect({
          customId: buildSelectCustomId(panel.panelId),
          // `minValues: 0` is what lets a member clear their choice. Without
          // it a single-choice panel is a one-way door.
          minValues: 0,
          maxValues: panel.behaviour === 'single_choice' ? 1 : options.length,
          options: options.map((option) => ({
            label: option.label ?? option.optionId,
            value: option.optionId,
            ...selectEmojiFor(option),
          })),
        }),
      ),
    ];
  }

  const rows: ActionRow[] = [];
  for (let i = 0; i < options.length; i += BUTTONS_PER_ROW) {
    rows.push(
      actionRow(
        options.slice(i, i + BUTTONS_PER_ROW).map((option) =>
          button({
            customId: buildCustomId(panel.panelId, option.optionId),
            label: option.label ?? option.optionId,
            ...emojiFor(option),
          }),
        ),
      ),
    );
  }
  return rows;
};

const PANEL_CONTENT_MAX = 1500;
const PANEL_HINT = (panel: PanelConfig): string => {
  if (panel.component === 'select')
    return panel.behaviour === 'add_only'
      ? 'Choose from the menu.'
      : 'Choose from the menu. Clear your choice to remove the role.';
  switch (panel.behaviour) {
    case 'toggle':
      return 'Press a role to add it. Press it again to remove it.';
    case 'add_only':
      return "Press a role to add it. This panel doesn't remove roles.";
    case 'remove_only':
      return 'Press a role to remove it.';
    case 'single_choice':
      return 'Pick one. Picking another swaps it.';
  }
};

/**
 * A managed panel as a card (ADR 0141 decision 10). The owner's text is
 * posted as written: it is their Markdown, and `allowedMentions` stops any
 * mention in it from pinging.
 */
export const renderPanelCard = (panel: PanelConfig): CardMessage =>
  card({
    tone: 'accent',
    art: ['bannerPanel'],
    children: [
      gallery([{ media: { url: artUrl('bannerPanel') }, description: ART.bannerPanel.alt }]),
      text(truncate(panel.content ?? '**Pick your roles**', PANEL_CONTENT_MAX)),
      text(subtext(PANEL_HINT(panel))),
      separator(),
      ...buildComponents(panel),
    ],
  });
