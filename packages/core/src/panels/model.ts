import { z } from 'zod';
import { snowflakeIdSchema, type SnowflakeId } from '../ids.js';
import type { EmojiKey } from '../discord/port.js';

/**
 * What a role panel *is*, and what a valid one looks like.
 *
 * Two kinds, one behaviour set, one convergence function (docs/19 §6.3):
 *
 * |  | Adopted | Managed |
 * |---|---|---|
 * | Message owner | anyone | the bot |
 * | Input | reactions the bot seeds | buttons or a select menu |
 * | Bot may edit the text | no | yes |
 * | Missed events | yes, when offline | no — interactions are request/response |
 *
 * The schema below is the validator every panel definition passes, whether it
 * arrives from the operator CLI, the dashboard, or a row written by an older
 * version of this process. `CLAUDE.md` rule 3 does not distinguish those: they
 * are all input from outside this function.
 *
 * Several of these rules are *also* CHECK constraints. That is deliberate
 * rather than redundant. The constraint is the guarantee — it cannot be
 * forgotten by a new caller. The validator is the *explanation*: `docs/19`
 * §6.3 asks that `single_choice` on an adopted panel be refused "with a message
 * that says why and points at button panels, rather than failing a constraint
 * with a raw SQL error".
 */

export const PANEL_KINDS = ['adopted', 'managed'] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];

export const PANEL_BEHAVIOURS = ['toggle', 'add_only', 'remove_only', 'single_choice'] as const;
export type PanelBehaviour = (typeof PANEL_BEHAVIOURS)[number];

export const PANEL_COMPONENTS = ['reaction', 'button', 'select'] as const;
export type PanelComponent = (typeof PANEL_COMPONENTS)[number];

export const PANEL_STATUSES = ['enabled', 'disabled_by_doctor', 'disabled_by_owner'] as const;
export type PanelStatus = (typeof PANEL_STATUSES)[number];

export const ADOPTION_PASS_STATES = ['pending', 'running', 'done', 'refused'] as const;
export type AdoptionPassState = (typeof ADOPTION_PASS_STATES)[number];

/**
 * Discord's own ceiling: five action rows of five buttons, and a select menu
 * accepts twenty-five options. A panel above this cannot be posted at all, so
 * it is refused at definition time rather than at send time.
 */
export const MAX_PANEL_OPTIONS = 25;

/**
 * The canonical emoji key produced by `core/discord/emoji`.
 *
 * Validated by shape here rather than re-derived, because by the time a key is
 * stored it has already been through `unicodeEmojiKey`, which is the only thing
 * that can strip U+FE0F correctly. A key that does not match this shape did not
 * come from there.
 */
export const emojiKeySchema = z
  .string()
  .regex(
    /^(u:[0-9a-f]{1,6}(-[0-9a-f]{1,6})*|c:\d{17,20})$/,
    'not a canonical emoji key: expected u:<codepoints> or c:<snowflake>, from core/discord/emoji',
  );

/** Stable across renames, and it appears in a component custom id. */
const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    'must be lowercase letters, digits, underscore or hyphen, starting with a letter or digit',
  );

export interface PanelOption {
  readonly optionId: string;
  readonly roleId: SnowflakeId;
  /** Required on a reaction panel; absent on buttons and select menus. */
  readonly emojiKey: EmojiKey | undefined;
  /** Required on buttons and select menus; Discord will not render without it. */
  readonly label: string | undefined;
  /** Display order, and the tie-break when `maxRoles` clamps a selection. */
  readonly position: number;
}

export interface PanelConfig {
  readonly panelId: string;
  readonly kind: PanelKind;
  readonly channelId: SnowflakeId;
  /** NULL until a managed panel is posted. Always set on an adopted panel. */
  readonly messageId: SnowflakeId | undefined;
  readonly behaviour: PanelBehaviour;
  readonly component: PanelComponent;
  /** Per-panel ceiling on roles held from this panel. Undefined means none. */
  readonly maxRoles: number | undefined;
  readonly requiredRoleId: SnowflakeId | undefined;
  readonly blockedRoleIds: readonly SnowflakeId[];
  readonly status: PanelStatus;
  readonly adoptionPassState: AdoptionPassState;
  /**
   * The size of the change list the most recent adoption pass computed and
   * could not apply for lack of allowance. `0` means "no known blocked
   * backlog" — never examined, or resolved. See ADR 0021.
   */
  readonly adoptionBlockedCount: number;
  readonly options: readonly PanelOption[];
}

const panelOptionDefinitionSchema = z.object({
  optionId: identifierSchema,
  roleId: snowflakeIdSchema,
  emojiKey: emojiKeySchema.optional(),
  label: z.string().min(1).max(80).optional(),
  position: z.number().int().nonnegative(),
});

const baseDefinitionSchema = z.object({
  panelId: identifierSchema,
  kind: z.enum(PANEL_KINDS),
  channelId: snowflakeIdSchema,
  messageId: snowflakeIdSchema.optional(),
  behaviour: z.enum(PANEL_BEHAVIOURS),
  component: z.enum(PANEL_COMPONENTS),
  maxRoles: z.number().int().positive().optional(),
  requiredRoleId: snowflakeIdSchema.optional(),
  blockedRoleIds: z.array(snowflakeIdSchema).default([]),
  options: z.array(panelOptionDefinitionSchema).min(1).max(MAX_PANEL_OPTIONS),
});

const duplicates = <T>(values: readonly T[]): T[] => {
  const seen = new Set<T>();
  const dupes = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
};

export const panelDefinitionSchema = baseDefinitionSchema.superRefine((panel, ctx) => {
  const fail = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

  // Collision 1, docs/19 §6.3. Picking role B must clear role A, and clearing
  // somebody else's reaction needs Manage Messages, which docs/18 Layer 1
  // deliberately excludes. The reaction stays, the next reconciliation reads it
  // and re-grants A, and the panel flaps. There is a CHECK for this; the
  // message is here so the owner learns what to do instead.
  if (panel.behaviour === 'single_choice' && panel.kind !== 'managed') {
    fail(
      "single_choice cannot work on an adopted panel: clearing a member's stale reaction " +
        'requires Manage Messages, which Bananasaurs deliberately does not hold, so the ' +
        'reaction would stay and the next reconciliation would re-grant the old role. ' +
        'Use a managed panel with buttons or a select menu — those leave no residue.',
      ['behaviour'],
    );
  }

  // The bot did not author an adopted message and so cannot attach components.
  if (panel.kind === 'adopted' && panel.component !== 'reaction') {
    fail(
      "an adopted panel is somebody else's message, and a bot may only add components to " +
        'its own; adopted panels are reaction-driven',
      ['component'],
    );
  }

  // An adopted panel attaches by message id — there is nothing to post.
  if (panel.kind === 'adopted' && panel.messageId === undefined) {
    fail('an adopted panel attaches to an existing message, so messageId is required', [
      'messageId',
    ]);
  }

  if (panel.component === 'reaction') {
    panel.options.forEach((option, i) => {
      if (option.emojiKey === undefined) {
        fail('a reaction panel needs an emoji for every option; that is its only input', [
          'options',
          i,
          'emojiKey',
        ]);
      }
    });
  } else {
    panel.options.forEach((option, i) => {
      if (option.label === undefined) {
        fail(`a ${panel.component} panel needs a label for every option; Discord requires one`, [
          'options',
          i,
          'label',
        ]);
      }
    });
  }

  for (const duplicate of duplicates(panel.options.map((o) => o.optionId))) {
    fail(`duplicate optionId '${duplicate}'`, ['options']);
  }
  // Also UNIQUE in the schema. Two options for one role make the panel's own
  // state ambiguous: reacting to one and un-reacting the other has no answer.
  for (const duplicate of duplicates(panel.options.map((o) => o.roleId))) {
    fail(`two options offer the same role '${duplicate}'`, ['options']);
  }
  for (const duplicate of duplicates(
    panel.options.map((o) => o.emojiKey).filter((e): e is string => e !== undefined),
  )) {
    fail(`two options use the same emoji '${duplicate}'`, ['options']);
  }

  if (panel.requiredRoleId !== undefined && panel.blockedRoleIds.includes(panel.requiredRoleId)) {
    fail('the required role is also blocked, so nobody could ever use this panel', [
      'requiredRoleId',
    ]);
  }
});

export type PanelDefinition = z.infer<typeof panelDefinitionSchema>;

/** Options in the order the panel displays them, and the order `maxRoles` clamps in. */
export const orderedOptions = (panel: PanelConfig): readonly PanelOption[] =>
  [...panel.options].sort((a, b) =>
    a.position === b.position ? a.optionId.localeCompare(b.optionId) : a.position - b.position,
  );

/**
 * The roles this panel offers. A panel never touches a role outside this set.
 *
 * Widened to `string` deliberately: callers test membership of role ids that
 * arrived from Discord, and narrowing the set would force a cast onto
 * `SnowflakeId` at every call site — which the lint tripwire bans, and rightly.
 */
export const panelRoleIds = (panel: PanelConfig): ReadonlySet<string> =>
  new Set<string>(panel.options.map((o) => o.roleId));

export const optionByEmoji = (panel: PanelConfig, emoji: EmojiKey): PanelOption | undefined =>
  panel.options.find((o) => o.emojiKey === emoji);

export const optionById = (panel: PanelConfig, optionId: string): PanelOption | undefined =>
  panel.options.find((o) => o.optionId === optionId);
