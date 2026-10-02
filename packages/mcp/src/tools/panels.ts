import { z } from 'zod';
import {
  MAX_PANEL_OPTIONS,
  PANEL_BEHAVIOURS,
  PANEL_COMPONENTS,
  type GuildId,
  type PanelBehaviour,
  type PanelComponent,
} from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';
import { resolveChannelRef, resolveRoleRef } from '../resolve.js';
import { safeName } from '../structured.js';
import { MCP_READ_GET_PANEL, MCP_READ_LIST_PANELS, type McpReadRecord } from '../read-audit.js';
import type { McpGuildPort, McpGuildChannel, McpGuildRole } from './guild.js';

/**
 * The five panel tools (slice 4, Task 6b): `list_panels` / `get_panel` under
 * the read scope, `create_panel` / `edit_panel` / `delete_panel` under the
 * roles scope (ADR 0114).
 *
 * They follow the same five steps as `send_message` — Zod parse →
 * `requireReachableGuild` → port call → render — so hard rule 3 holds by
 * construction, and the same two-message contract (ruling M4-D18): a parse
 * failure is the argument-fault message, a gate failure or any throw is the
 * shared refusal. No tool here throws. Refusal texts are distinct, actionable
 * and name ids only — never role names — as in `packages/mcp/src/tools/send.ts`.
 *
 * This module holds no panel handle of any kind: the daemon owns the
 * `panelDefinitionSchema` validation, the grant-policy check, the
 * dangerous-permission floor, the `roles.mutate` authorization and the
 * ledger, and this package's port projects its outcomes field by field.
 * Channel and role refs that are an id or a name resolve here, in the tool,
 * through the guild port — the same split `role-writes.ts` uses — so a
 * traversal-shaped string refuses here with no ledger row, and the daemon
 * re-checks every id live before its claim, so a role that vanished between
 * resolution and the call still refuses cleanly. Refs that only make sense
 * against the stored panel (`removeOptions`, `reorder`) travel raw and
 * resolve daemon-side.
 *
 * Every write runs as one `runMcpAction` on the daemon side (kinds
 * `panel.create` / `panel.edit` / `panel.delete`, cap group `structure`)
 * through the shared ops ports (`createPanel` / `updatePanel` /
 * `publishPanel` / `unpublishPanel`). None of the three writes is undoable;
 * each says so, and each names `delete_panel` (for a creation) or the
 * recreate path where one exists.
 */

export const LIST_PANELS_TOOL_NAME = 'list_panels';
export const LIST_PANELS_TOOL_DESCRIPTION =
  'Lists the role panels configured in this guild: id, title, behaviour, component, status and option count. Read-only.';

export const GET_PANEL_TOOL_NAME = 'get_panel';
export const GET_PANEL_TOOL_DESCRIPTION =
  'Shows one role panel in full: its channel and message ids, title and body, behaviour, component, status, ' +
  'and every option with its option id, role id, label and emoji. Names ids, labels and the title only — never role names. Read-only.';

export const CREATE_PANEL_TOOL_NAME = 'create_panel';
export const CREATE_PANEL_TOOL_DESCRIPTION =
  'Creates a managed role panel in an allowlisted channel of this guild and posts it. ' +
  'Takes a channel id or name, a title and an optional body (posted as the message text), ' +
  'a behaviour, a component, and 1 to 25 options. Each option names a role by id or name, ' +
  'or asks for a new zero-permission role with {create:{name, color?}}, plus a label and, for reaction panels, an emoji. ' +
  'Every option role must pass the MCP grant policy (below the bot, not managed, no dangerous permissions) ' +
  'and is allowlisted on creation. A creation cannot be undone; delete it with `delete_panel`. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without creating.';

export const EDIT_PANEL_TOOL_NAME = 'edit_panel';
export const EDIT_PANEL_TOOL_DESCRIPTION =
  'Edits a managed role panel and republishes its message: title, body, behaviour, component, ' +
  'added, removed or reordered options. Options added like in `create_panel`, removals and the new order ' +
  'as role ids or names. A panel\u2019s channel is immutable: passing a different channel refuses. ' +
  'An edit cannot be undone. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without editing.';

export const DELETE_PANEL_TOOL_NAME = 'delete_panel';
export const DELETE_PANEL_TOOL_DESCRIPTION =
  'Deletes a role panel: removes its Discord message (or counts an already-gone message as success) ' +
  'and deletes its configuration. Its roles stay allowlisted and members keep whatever they hold. ' +
  'A deletion cannot be undone. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without deleting.';

/** A Discord role name is capped at 100 characters (as in `role-admin.ts`). */
export const PANEL_ROLE_NAME_MAX = 100;
/** A Discord role color is a 24-bit integer (as in `role-admin.ts`). */
const PANEL_ROLE_COLOR_MAX = 0xff_ff_ff;
/** An option label is capped at 80 characters by `panelDefinitionSchema`. */
export const PANEL_OPTION_LABEL_MAX = 80;
/** A `name:id` custom emoji reference never needs more than this (as in `message-writes.ts`). */
const PANEL_EMOJI_MAX = 64;
/** Discord's message body limit, which caps the composed title plus body (ADR 0054). */
export const PANEL_CONTENT_MAX = 2000;

/** One panel as `list_panels` shows it: ids, enums and counts, plus the title. */
export interface McpPanelSummary {
  readonly panelId: string;
  readonly title: string;
  readonly behaviour: string;
  readonly component: string;
  readonly status: string;
  readonly messageId?: string | undefined;
  readonly optionCount: number;
}

/** One option as `get_panel` shows it: ids plus the label and emoji the panel renders. */
export interface McpPanelOptionView {
  readonly optionId: string;
  readonly roleId: string;
  /** Set on buttons and select menus; absent on reaction panels. */
  readonly label?: string | undefined;
  /** Set on reaction panels; absent on buttons and select menus. */
  readonly emoji?: string | undefined;
}

/** One panel as `get_panel` shows it: ids plus the title, body and option labels. */
export interface McpPanelDetail {
  readonly panelId: string;
  readonly channelId: string;
  readonly messageId?: string | undefined;
  readonly behaviour: string;
  readonly component: string;
  readonly status: string;
  readonly title: string;
  readonly body?: string | undefined;
  readonly options: readonly McpPanelOptionView[];
}

/** One option as the write tools take it: a resolved role id, or a creation spec. */
export interface McpPanelOptionInput {
  readonly role:
    string | { readonly create: { readonly name: string; readonly color?: number | undefined } };
  readonly label?: string | undefined;
  readonly emoji?: string | undefined;
}

/** What the daemon's panel wiring must satisfy (slice 4, Task 6b implements it). */
export interface McpPanelsPort {
  readonly list: (guildId: GuildId) => readonly McpPanelSummary[];
  readonly get: (guildId: GuildId, panelId: string) => McpPanelDetail | undefined;
  readonly create: (
    guildId: GuildId,
    input: {
      readonly channel: string;
      readonly title: string;
      readonly body: string | undefined;
      readonly behaviour: PanelBehaviour;
      readonly component: PanelComponent;
      readonly options: readonly McpPanelOptionInput[];
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpPanelOutcome>;
  readonly edit: (
    guildId: GuildId,
    input: {
      readonly panelId: string;
      /** Accepted solely to refuse a move: a panel's channel is immutable. */
      readonly channel: string | undefined;
      readonly title: string | undefined;
      readonly body: string | undefined;
      readonly behaviour: PanelBehaviour | undefined;
      readonly component: PanelComponent | undefined;
      readonly addOptions: readonly McpPanelOptionInput[] | undefined;
      /** Role refs (id or name) against the stored panel; resolved daemon-side. */
      readonly removeOptions: readonly string[] | undefined;
      /** Role refs (id or name) in the desired order; resolved daemon-side. */
      readonly reorder: readonly string[] | undefined;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpPanelOutcome>;
  readonly remove: (
    guildId: GuildId,
    input: { readonly panelId: string; readonly dryRun: boolean; readonly idempotencyKey: string },
  ) => Promise<McpPanelOutcome>;
}

/** Mirrors the daemon's outcomes, named in this package's own vocabulary. */
export type McpPanelOutcome =
  | {
      readonly status: 'done';
      readonly actionId: string;
      readonly panelId: string;
      readonly messageId?: string | undefined;
    }
  | { readonly status: 'dry-run'; readonly actionId: string; readonly panelId?: string | undefined }
  | {
      readonly status: 'replayed';
      readonly actionId: string;
      readonly panelId?: string | undefined;
      readonly messageId?: string | undefined;
    }
  | { readonly status: 'refused'; readonly reason: McpPanelRefusal; readonly detail?: string }
  | { readonly status: 'failed'; readonly panelId?: string | undefined };

export type McpPanelRefusal =
  | 'unknown-channel'
  | 'ambiguous-channel'
  | 'channel-not-allowlisted'
  | 'private-thread'
  | 'bot-lacks-permission'
  | 'unknown-role'
  | 'ambiguous-role'
  | 'unknown-panel'
  | 'unknown-emoji'
  | 'above-bot'
  | 'managed-or-everyone'
  | 'dangerous'
  | 'not-allowlisted'
  | 'invalid-definition'
  | 'bad-reorder'
  | 'channel-change'
  | 'unauthorized'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap'
  | 'duplicate-key-different-content'
  | 'duplicate-content-recently';

export type PanelOutcomeText =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

export type PanelsReadOutcomeText =
  | { readonly ok: true; readonly text: string; readonly read: McpReadRecord }
  | { readonly ok: false; readonly message: string };

const colorSchema = z.number().int().min(0).max(PANEL_ROLE_COLOR_MAX);

const roleCreateSchema = z
  .object({ name: z.string().min(1).max(PANEL_ROLE_NAME_MAX), color: colorSchema.optional() })
  .strict();

const optionSchema = z
  .object({
    role: z.union([
      z.string().min(1).max(PANEL_ROLE_NAME_MAX),
      z.object({ create: roleCreateSchema }).strict(),
    ]),
    label: z.string().min(1).max(PANEL_OPTION_LABEL_MAX).optional(),
    emoji: z.string().min(1).max(PANEL_EMOJI_MAX).optional(),
  })
  .strict();

/**
 * Zod schemas are the boundary (hard rule 3): a parse failure is the
 * argument-fault message, never a throw, and the parse runs before the guild
 * gate. `guildId` is a bare string on purpose, like `send.ts`: the gate
 * parses it and refuses malformed and unreachable identically. `channel` and
 * every string role ref take an id or a name (Discord role names run to 100
 * characters), resolved after the gate through the guild port; `{create}`
 * specs travel to the daemon, which mints the role. The schemas are
 * `.strict()`, so an unknown key — a `permissions` key, a `kind` key — is an
 * argument fault here, before anything is consulted or recorded.
 *
 * Field names, enums and limits come from `panelDefinitionSchema` and
 * ADR 0054: behaviours, components, 1–25 options, labels to 80 characters,
 * the composed title plus body to Discord's 2000-character message limit. The
 * one mapping the schema does not name is title plus body: `title` is
 * required, `body` is appended after a blank line when given, and `get_panel`
 * splits the stored content back on its first blank line, so the pair
 * round-trips exactly.
 */
const createArgsSchema = z
  .object({
    guildId: z.string(),
    channel: z.string().min(1).max(100),
    title: z.string().min(1),
    body: z.string().min(1).optional(),
    behaviour: z.enum(PANEL_BEHAVIOURS),
    component: z.enum(PANEL_COMPONENTS),
    options: z.array(optionSchema).min(1).max(MAX_PANEL_OPTIONS),
    dryRun: z.boolean().optional(),
    idempotencyKey: z.string().min(1),
  })
  .strict()
  .refine(
    (args) => {
      const title = args.title.trim();
      const body = args.body === undefined ? undefined : args.body.trim();
      if (title === '') return false;
      if (body !== undefined && body === '') return false;
      const content = body === undefined ? title : `${title}\n\n${body}`;
      if (content.length > PANEL_CONTENT_MAX) return false;
      return args.options.every((option) => {
        const label = option.label === undefined ? undefined : option.label.trim();
        const emoji = option.emoji === undefined ? undefined : option.emoji.trim();
        if (label !== undefined && label === '') return false;
        if (emoji !== undefined && emoji === '') return false;
        // The schema's per-component rule, up front: a reaction panel's only
        // input is the emoji, anything else needs the label Discord renders.
        return args.component === 'reaction' ? emoji !== undefined : label !== undefined;
      });
    },
    { message: 'title, body, label and emoji requirements' },
  );

const editArgsSchema = z
  .object({
    guildId: z.string(),
    panelId: z.string().min(1).max(64),
    channel: z.string().min(1).max(100).optional(),
    title: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    behaviour: z.enum(PANEL_BEHAVIOURS).optional(),
    component: z.enum(PANEL_COMPONENTS).optional(),
    addOptions: z.array(optionSchema).max(MAX_PANEL_OPTIONS).optional(),
    removeOptions: z
      .array(z.string().min(1).max(PANEL_ROLE_NAME_MAX))
      .max(MAX_PANEL_OPTIONS)
      .optional(),
    reorder: z.array(z.string().min(1).max(PANEL_ROLE_NAME_MAX)).max(MAX_PANEL_OPTIONS).optional(),
    dryRun: z.boolean().optional(),
    idempotencyKey: z.string().min(1),
  })
  .strict()
  .refine(
    (args) =>
      args.channel !== undefined ||
      args.title !== undefined ||
      args.body !== undefined ||
      args.behaviour !== undefined ||
      args.component !== undefined ||
      args.addOptions !== undefined ||
      args.removeOptions !== undefined ||
      args.reorder !== undefined,
    { message: 'a change is required' },
  )
  .refine(
    (args) => {
      if (args.title !== undefined && args.title.trim() === '') return false;
      if (args.body !== undefined && args.body.trim() === '') return false;
      if (args.addOptions !== undefined && args.addOptions.length === 0) return false;
      if (args.removeOptions !== undefined && args.removeOptions.length === 0) return false;
      if (args.reorder !== undefined && args.reorder.length === 0) return false;
      return (args.addOptions ?? []).every((option) => {
        const label = option.label === undefined ? undefined : option.label.trim();
        const emoji = option.emoji === undefined ? undefined : option.emoji.trim();
        if (label !== undefined && label === '') return false;
        if (emoji !== undefined && emoji === '') return false;
        // Without a component change the stored component decides, which only
        // the daemon knows — so this checks the pair only when the edit names
        // a new component, and the daemon's schema check owns the rest.
        if (args.component === undefined) return true;
        return args.component === 'reaction' ? emoji !== undefined : label !== undefined;
      });
    },
    { message: 'title, body and added-option requirements' },
  );

const deleteArgsSchema = z
  .object({
    guildId: z.string(),
    panelId: z.string().min(1).max(64),
    dryRun: z.boolean().optional(),
    idempotencyKey: z.string().min(1),
  })
  .strict();

const listArgsSchema = z.object({ guildId: z.string() }).strict();

const getArgsSchema = z
  .object({ guildId: z.string(), panelId: z.string().min(1).max(64) })
  .strict();

/**
 * The loose wire shapes registered with the MCP server. Deliberately without
 * refinements, like `sendMessageParams`: these document the wire types for
 * clients while the strict schemas above stay the single boundary.
 */
export const listPanelsParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
};

export const getPanelParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  panelId: z.string().describe('Panel id, from `list_panels`.'),
};

export const createPanelParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  channel: z.string().describe('Channel to post the panel in, as an id or a name.'),
  title: z.string().describe('Panel title, posted as the message heading.'),
  body: z.string().optional().describe('Optional message body under the title.'),
  behaviour: z
    .string()
    .describe('How picking works: toggle, add_only, remove_only or single_choice.'),
  component: z.string().describe('What members press: reaction, button or select.'),
  options: z
    .array(z.unknown())
    .describe(
      'One to twenty-five options: each a role id or name — or {create:{name, color?}} for a new zero-permission role — ' +
        'with a label (buttons and select menus) or an emoji (reaction panels).',
    ),
  dryRun: z.boolean().optional().describe('Record without creating: nothing reaches Discord.'),
  idempotencyKey: z
    .string()
    .describe(
      'Caller-supplied key for this creation; reuse the same value if you retry this call.',
    ),
};

export const editPanelParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  panelId: z.string().describe('Panel id, from `list_panels`.'),
  channel: z
    .string()
    .optional()
    .describe(
      'Accepted solely to refuse a move: a panel\u2019s channel is immutable, so a different channel refuses.',
    ),
  title: z.string().optional().describe('New title.'),
  body: z.string().optional().describe('New body.'),
  behaviour: z.string().optional().describe('New behaviour.'),
  component: z.string().optional().describe('New component.'),
  addOptions: z
    .array(z.unknown())
    .optional()
    .describe('Options to add, shaped like `create_panel` options.'),
  removeOptions: z
    .array(z.string())
    .optional()
    .describe('Roles to remove from the panel, each as an id or a name.'),
  reorder: z
    .array(z.string())
    .optional()
    .describe('Every remaining role in the desired display order, each as an id or a name.'),
  dryRun: z.boolean().optional().describe('Record without editing: nothing reaches Discord.'),
  idempotencyKey: z
    .string()
    .describe('Caller-supplied key for this edit; reuse the same value if you retry this call.'),
};

export const deletePanelParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  panelId: z.string().describe('Panel id, from `list_panels`.'),
  dryRun: z.boolean().optional().describe('Record without deleting: nothing reaches Discord.'),
  idempotencyKey: z
    .string()
    .describe(
      'Caller-supplied key for this deletion; reuse the same value if you retry this call.',
    ),
};

/** Which write tool is rendering, for the verbs below. */
type PanelWriteKind = 'create' | 'edit' | 'delete';

const refuse = (): PanelOutcomeText => ({ ok: false, message: GUILD_REFUSAL_MESSAGE });

const refuseInvalidArgs = (): PanelOutcomeText => ({
  ok: false,
  message: INVALID_ARGUMENTS_MESSAGE,
});

/**
 * Every refusal renders distinctly and actionably: the operator reading it
 * knows what stopped the write and what to do next. No two reasons share a
 * string (pinned by test). Ids only — never role names or option labels:
 * the daemon resolves a name to an id before refusing, and the refusals that
 * cannot name an id (`unknown-role`, `unknown-channel`) name the
 * caller-typed ref only in the tool-layer resolution below, never here.
 */
const refusalText = (
  kind: PanelWriteKind,
  guildId: GuildId,
  panelId: string | undefined,
  reason: McpPanelRefusal,
  detail: string | undefined,
): string => {
  const undone =
    kind === 'create'
      ? 'no panel was created'
      : kind === 'edit'
        ? 'nothing was changed'
        : 'nothing was deleted';
  const panel = panelId === undefined ? 'that panel' : `panel ${panelId}`;
  switch (reason) {
    case 'unknown-channel':
      return (
        `That channel is not in guild ${guildId}, so ${undone}. ` +
        'Pass a channel id or the exact name shown by `list_channels`.'
      );
    case 'ambiguous-channel':
      return (
        `That channel name matches several channels in guild ${guildId}` +
        `${detail !== undefined ? ` (${detail})` : ''}, so ${undone}. ` +
        'Pass one channel id instead of a name.'
      );
    case 'channel-not-allowlisted':
      return (
        `That channel in guild ${guildId} is not allowlisted for MCP posts, ` +
        `so ${undone}. An operator must allowlist it for sends before a panel can post there.`
      );
    case 'private-thread':
      return (
        `That thread in guild ${guildId} is private and not shared with the MCP, ` +
        `so ${undone}. Panels post to channels, not private threads.`
      );
    case 'bot-lacks-permission':
      return (
        `The bot lacks the Discord permission to post in that channel of guild ${guildId}` +
        `${detail !== undefined ? ` (missing ${detail})` : ''}, so ${undone}. ` +
        'An operator must grant it in Discord first.'
      );
    case 'unknown-role':
      return (
        `That role is not in guild ${guildId}, so ${undone}. ` +
        'Pass a role id or the exact name shown by `list_roles`, or {create:{name}} for a new role.'
      );
    case 'ambiguous-role':
      return (
        `That role name matches several roles in guild ${guildId}` +
        `${detail !== undefined ? ` (${detail})` : ''}, so ${undone}. ` +
        'Pass one role id instead of a name.'
      );
    case 'unknown-panel':
      return (
        `${panelId === undefined ? 'That panel' : `Panel ${panelId}`} is not in guild ${guildId}, ` +
        `so ${undone}. See \`list_panels\` for the ones that exist.`
      );
    case 'unknown-emoji':
      return (
        `That emoji is not a unicode emoji or a custom emoji of guild ${guildId}` +
        `${detail !== undefined ? ` (${detail})` : ''}, so ${undone}. ` +
        'Pass a unicode emoji, or name:id for a custom emoji of this guild.'
      );
    case 'above-bot':
      return (
        `Role ${detail ?? 'that role'} in guild ${guildId} sits at or above the bot\u2019s highest role, ` +
        `so ${undone}. The MCP only panels roles below the bot.`
      );
    case 'managed-or-everyone':
      return (
        `Role ${detail ?? 'that role'} in guild ${guildId} is managed by an integration or is @everyone, ` +
        `so ${undone}. Managed roles belong to their integration, not to a panel.`
      );
    case 'dangerous':
      return (
        `Role ${detail ?? 'that role'} in guild ${guildId} holds a dangerous Discord permission, ` +
        `so ${undone}. The MCP never panels a role that could escalate its holder.`
      );
    case 'not-allowlisted':
      return (
        `Role ${detail ?? 'that role'} in guild ${guildId} is not allowlisted for MCP grants, ` +
        `so ${undone}. An operator must allow it for MCP grants first.`
      );
    case 'invalid-definition':
      return (
        `${kind === 'create' ? 'That panel definition' : `The new definition for ${panel}`} ` +
        `failed validation in guild ${guildId}${detail !== undefined ? `: ${detail}` : ''}, ` +
        `so ${undone}. Reaction panels need an emoji per option, buttons and select menus a label per option, ` +
        'with 1 to 25 options and no role twice.'
      );
    case 'bad-reorder':
      return (
        `That order does not name exactly the panel\u2019s remaining roles in guild ${guildId}` +
        `${detail !== undefined ? ` (${detail})` : ''}, so ${undone}. ` +
        'Pass every remaining role id or name once, in the desired display order.'
      );
    case 'channel-change':
      return (
        `${panel} lives in its channel in guild ${guildId}, and a panel\u2019s channel is immutable, ` +
        `so ${undone}. The posted message lives in that channel and moving it would orphan it — ` +
        `delete the panel and recreate it instead.`
      );
    case 'unauthorized':
      return (
        `This account lacks roles.mutate in guild ${guildId}, so ${undone}. ` +
        'An operator who can edit authorization can grant it, then retry this call.'
      );
    case 'killswitch':
      return (
        `The kill switch is on for guild ${guildId}, so ${undone}. ` +
        'Panel changes stay paused until an operator turns it off; do not retry in a loop.'
      );
    case 'breaker-open':
      return (
        `The circuit breaker is open for guild ${guildId} after repeated Discord faults, ` +
        `so ${undone}. Wait for an operator to clear it; do not retry in a loop.`
      );
    case 'rate-cap':
      return (
        `Guild ${guildId} has used its structure budget of 100 panel, thread and role changes ` +
        `per rolling hour, so ${undone}. Wait for the window to pass before retrying` +
        `${detail !== undefined ? ` (resets at ${detail})` : ''}; ` +
        'answering an already-recorded idempotency key still works meanwhile.'
      );
    case 'duplicate-key-different-content':
      return (
        `That idempotency key was already used for a different write in guild ${guildId}, ` +
        `so ${undone}. To run this, retry with a fresh key; ` +
        'the earlier write under the old key is unaffected.'
      );
    case 'duplicate-content-recently':
      return (
        `The same write already ran in guild ${guildId} within the last minute, ` +
        `so ${undone}. Wait a minute, then retry with a fresh key.`
      );
  }
};

/**
 * Refused outcomes that name a role id carry it in `detail` (the daemon
 * resolves the caller's ref to an id before refusing, except for
 * `unknown-role` and `ambiguous-role`, which have no single id). The renderer
 * speaks ids only, so the detail passes through untouched — it is either a
 * role id, an id list, or a validator message over ids.
 */
const renderRefused = (
  kind: PanelWriteKind,
  guildId: GuildId,
  panelId: string | undefined,
  outcome: Extract<McpPanelOutcome, { status: 'refused' }>,
): PanelOutcomeText => {
  return {
    ok: false,
    message: refusalText(kind, guildId, panelId, outcome.reason, outcome.detail),
  };
};

const renderOutcome = (
  kind: PanelWriteKind,
  guildId: GuildId,
  panelId: string | undefined,
  outcome: McpPanelOutcome,
): PanelOutcomeText => {
  switch (outcome.status) {
    case 'done': {
      const id = outcome.panelId;
      const posted =
        outcome.messageId === undefined ? '' : ` Posted as message ${outcome.messageId}.`;
      if (kind === 'create') {
        return {
          ok: true,
          text:
            `Created panel ${id} in guild ${guildId} (action ${outcome.actionId}).${posted} ` +
            'Its option roles joined the bot\u2019s role allowlist. ' +
            'A creation cannot be undone — delete it with `delete_panel`.',
        };
      }
      if (kind === 'edit') {
        return {
          ok: true,
          text:
            `Edited panel ${id} in guild ${guildId} and republished it` +
            `${outcome.messageId === undefined ? '' : ` as message ${outcome.messageId}`} ` +
            `(action ${outcome.actionId}). An edit cannot be undone.`,
        };
      }
      return {
        ok: true,
        text:
          `Deleted panel ${id} in guild ${guildId}` +
          `${outcome.messageId === undefined ? '' : ` and removed its message ${outcome.messageId}`} ` +
          `(action ${outcome.actionId}). Its roles stay allowlisted and members keep whatever they hold. ` +
          'A deletion cannot be undone.',
      };
    }
    case 'dry-run':
      return {
        ok: true,
        text:
          `Dry run is on for guild ${guildId}: ` +
          (kind === 'create'
            ? 'no panel was created'
            : kind === 'edit'
              ? `nothing was changed on ${panelId ?? 'that panel'}`
              : `nothing was deleted for ${panelId ?? 'that panel'}`) +
          `. The write was recorded as action ${outcome.actionId} under its idempotency key ` +
          'but no Discord call was made and no role was created or allowlisted.',
      };
    case 'replayed':
      return {
        ok: true,
        text:
          `Already recorded under this idempotency key as action ${outcome.actionId}: ` +
          (kind === 'create'
            ? `nothing new was created in guild ${guildId}`
            : kind === 'edit'
              ? `nothing new was changed on ${outcome.panelId ?? panelId ?? 'that panel'}`
              : `nothing new was deleted for ${outcome.panelId ?? panelId ?? 'that panel'}`) +
          '.',
      };
    case 'refused':
      return renderRefused(kind, guildId, panelId, outcome);
    case 'failed':
      return {
        ok: false,
        message:
          kind === 'create'
            ? `The Discord call creating ${panelId ?? 'a panel'} in guild ${guildId} failed with an unknown result: ` +
              'the panel may or may not have been created. ' +
              'Check `list_panels` before retrying, and retry with the same idempotency key — never a fresh one.'
            : kind === 'edit'
              ? `The Discord call editing ${panelId ?? 'that panel'} in guild ${guildId} failed with an unknown result: ` +
                'the panel may or may not have been changed. Check `get_panel` before retrying, ' +
                'and retry with the same idempotency key — never a fresh one.'
              : `The Discord call deleting ${panelId ?? 'that panel'} in guild ${guildId} failed with an unknown result: ` +
                'the panel may or may not be gone. Check `list_panels` before retrying, ' +
                'and retry with the same idempotency key — never a fresh one.',
      };
  }
};

/**
 * A channel ref to a snowflake id, through the guild port's channel listing:
 * a well-formed id passes through (existence is the target layer's business),
 * anything else matches case-insensitively against names after one leading
 * `#` is stripped. A path-traversal string is neither, so it refuses here —
 * the daemon port is never called.
 */
const resolveChannel = (
  channels: readonly McpGuildChannel[],
  ref: string,
):
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly message: string } => {
  const resolved = resolveChannelRef(channels, ref);
  return resolved.ok ? { ok: true, id: resolved.id } : { ok: false, message: resolved.message };
};

/**
 * A role ref to a snowflake id, through the guild port's role listing. A
 * path-traversal string is neither an id nor a name, so it refuses here —
 * the daemon port is never called.
 */
const resolveRole = (
  roles: readonly McpGuildRole[],
  ref: string,
):
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly message: string } => {
  const resolved = resolveRoleRef(roles, ref);
  return resolved.ok ? { ok: true, id: resolved.id } : { ok: false, message: resolved.message };
};

const listPanelsInner = (
  principal: McpPrincipal,
  port: McpPanelsPort,
  rawArgs: unknown,
): PanelsReadOutcomeText => {
  const parsed = listArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, message: INVALID_ARGUMENTS_MESSAGE };
  const gate = requireReachableGuild(principal, parsed.data.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const panels = port.list(gate.guildId);
  if (panels.length === 0) {
    return {
      ok: true,
      text: `No role panels configured in guild ${gate.guildId}.`,
      read: {
        kind: 'structural',
        action: MCP_READ_LIST_PANELS,
        guildIds: [gate.guildId],
        resultCount: 0,
      },
    };
  }
  const lines = panels.map((panel) => {
    const parts = [
      panel.panelId,
      safeName(panel.title),
      panel.behaviour,
      panel.component,
      panel.status,
      `${String(panel.optionCount)} option(s)`,
      ...(panel.messageId !== undefined ? [`message ${panel.messageId}`] : ['(not posted)']),
    ];
    return parts.join(' | ');
  });
  return {
    ok: true,
    text:
      `Role panels in guild ${gate.guildId}: ${String(panels.length)} shown.\n` + lines.join('\n'),
    // Ids, enums, counts and titles are structure, not member content:
    // structural read under ADR 0050's split (one log line, never an audit
    // row — and the record carries no title or label either).
    read: {
      kind: 'structural',
      action: MCP_READ_LIST_PANELS,
      guildIds: [gate.guildId],
      resultCount: panels.length,
    },
  };
};

const getPanelInner = (
  principal: McpPrincipal,
  port: McpPanelsPort,
  rawArgs: unknown,
): PanelsReadOutcomeText => {
  const parsed = getArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, message: INVALID_ARGUMENTS_MESSAGE };
  const gate = requireReachableGuild(principal, parsed.data.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const panel = port.get(gate.guildId, parsed.data.panelId);
  if (panel === undefined) {
    return {
      ok: false,
      message:
        `No panel ${parsed.data.panelId} in guild ${gate.guildId}. ` +
        'See `list_panels` for the ones that exist.',
    };
  }
  const lines = [
    `panel     ${panel.panelId}`,
    `title     ${safeName(panel.title)}`,
    ...(panel.body !== undefined ? [`body      ${safeName(panel.body)}`] : []),
    `behaviour ${panel.behaviour} (${panel.component})`,
    `status    ${panel.status}`,
    `channel   ${panel.channelId}`,
    `message   ${panel.messageId ?? '(not posted)'}`,
    'options',
    ...panel.options.map(
      (option) =>
        `  ${option.optionId} -> role ${option.roleId}` +
        `${option.label !== undefined ? ` (${safeName(option.label)})` : ''}` +
        `${option.emoji !== undefined ? ` [${option.emoji}]` : ''}`,
    ),
  ];
  return {
    ok: true,
    text: lines.join('\n'),
    // As above: ids, labels and the title are structure — one log line, and
    // the record itself carries the panel id only through the guild key.
    read: {
      kind: 'structural',
      action: MCP_READ_GET_PANEL,
      guildIds: [gate.guildId],
      resultCount: 1,
    },
  };
};

/** Never throws and never rejects: a rejected port promise is the shared refusal. */
export const listPanelsText = (
  principal: McpPrincipal,
  port: McpPanelsPort,
  rawArgs: unknown,
): PanelsReadOutcomeText => {
  try {
    return listPanelsInner(principal, port, rawArgs);
  } catch {
    return { ok: false, message: GUILD_REFUSAL_MESSAGE };
  }
};

/** Never throws and never rejects: a rejected port promise is the shared refusal. */
export const getPanelText = (
  principal: McpPrincipal,
  port: McpPanelsPort,
  rawArgs: unknown,
): PanelsReadOutcomeText => {
  try {
    return getPanelInner(principal, port, rawArgs);
  } catch {
    return { ok: false, message: GUILD_REFUSAL_MESSAGE };
  }
};

const createPanelInner = async (
  principal: McpPrincipal,
  port: McpPanelsPort,
  guild: McpGuildPort,
  rawArgs: unknown,
): Promise<PanelOutcomeText> => {
  const parsed = createArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  const input = parsed.data;
  const gate = requireReachableGuild(principal, input.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const guildId = gate.guildId;
  const channel = resolveChannel(guild.listChannels(guildId), input.channel);
  if (!channel.ok) return { ok: false, message: channel.message };
  const roles = guild.listRoles(guildId);
  const options: McpPanelOptionInput[] = [];
  for (const option of input.options) {
    if (typeof option.role === 'string') {
      const resolved = resolveRole(roles, option.role);
      if (!resolved.ok) return { ok: false, message: resolved.message };
      options.push({
        role: resolved.id,
        ...(option.label !== undefined ? { label: option.label.trim() } : {}),
        ...(option.emoji !== undefined ? { emoji: option.emoji.trim() } : {}),
      });
    } else {
      const name = option.role.create.name.trim();
      if (name === '') return refuseInvalidArgs();
      options.push({
        role: {
          create: {
            name,
            ...(option.role.create.color !== undefined ? { color: option.role.create.color } : {}),
          },
        },
        ...(option.label !== undefined ? { label: option.label.trim() } : {}),
        ...(option.emoji !== undefined ? { emoji: option.emoji.trim() } : {}),
      });
    }
  }
  const title = input.title.trim();
  const body = input.body === undefined ? undefined : input.body.trim();
  const outcome = await port.create(guildId, {
    channel: channel.id,
    title,
    body,
    behaviour: input.behaviour,
    component: input.component,
    options,
    dryRun: input.dryRun ?? false,
    idempotencyKey: input.idempotencyKey,
  });
  return renderOutcome('create', guildId, undefined, outcome);
};

/**
 * Never throws and never rejects: a malformed argument is the
 * argument-fault message, and anything unexpected (a port fault) is the
 * shared refusal rather than an exception out of the handler. The two
 * messages are deliberately different (ruling M4-D18).
 */
export const createPanelText = async (
  principal: McpPrincipal,
  port: McpPanelsPort,
  guild: McpGuildPort,
  rawArgs: unknown,
): Promise<PanelOutcomeText> => {
  try {
    return await createPanelInner(principal, port, guild, rawArgs);
  } catch {
    return refuse();
  }
};

const editPanelInner = async (
  principal: McpPrincipal,
  port: McpPanelsPort,
  guild: McpGuildPort,
  rawArgs: unknown,
): Promise<PanelOutcomeText> => {
  const parsed = editArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  const input = parsed.data;
  const gate = requireReachableGuild(principal, input.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const guildId = gate.guildId;
  // The channel travels raw on purpose: it is accepted solely to refuse a
  // move (a panel's channel is immutable), and resolving a channel that will
  // only ever refuse would consult the listing for nothing. Traversal-shaped
  // strings refuse daemon-side as an unknown channel, never as a path.
  const roles = guild.listRoles(guildId);
  let addOptions: readonly McpPanelOptionInput[] | undefined;
  if (input.addOptions !== undefined) {
    const resolved: McpPanelOptionInput[] = [];
    for (const option of input.addOptions) {
      if (typeof option.role === 'string') {
        const match = resolveRole(roles, option.role);
        if (!match.ok) return { ok: false, message: match.message };
        resolved.push({
          role: match.id,
          ...(option.label !== undefined ? { label: option.label.trim() } : {}),
          ...(option.emoji !== undefined ? { emoji: option.emoji.trim() } : {}),
        });
      } else {
        const name = option.role.create.name.trim();
        if (name === '') return refuseInvalidArgs();
        resolved.push({
          role: {
            create: {
              name,
              ...(option.role.create.color !== undefined
                ? { color: option.role.create.color }
                : {}),
            },
          },
          ...(option.label !== undefined ? { label: option.label.trim() } : {}),
          ...(option.emoji !== undefined ? { emoji: option.emoji.trim() } : {}),
        });
      }
    }
    addOptions = resolved;
  }
  const outcome = await port.edit(guildId, {
    panelId: input.panelId,
    channel: input.channel,
    title: input.title === undefined ? undefined : input.title.trim(),
    body: input.body === undefined ? undefined : input.body.trim(),
    behaviour: input.behaviour,
    component: input.component,
    addOptions,
    removeOptions: input.removeOptions,
    reorder: input.reorder,
    dryRun: input.dryRun ?? false,
    idempotencyKey: input.idempotencyKey,
  });
  return renderOutcome('edit', guildId, input.panelId, outcome);
};

/** Never throws and never rejects: see `createPanelText`. */
export const editPanelText = async (
  principal: McpPrincipal,
  port: McpPanelsPort,
  guild: McpGuildPort,
  rawArgs: unknown,
): Promise<PanelOutcomeText> => {
  try {
    return await editPanelInner(principal, port, guild, rawArgs);
  } catch {
    return refuse();
  }
};

const deletePanelInner = async (
  principal: McpPrincipal,
  port: McpPanelsPort,
  rawArgs: unknown,
): Promise<PanelOutcomeText> => {
  const parsed = deleteArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  const gate = requireReachableGuild(principal, parsed.data.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const outcome = await port.remove(gate.guildId, {
    panelId: parsed.data.panelId,
    dryRun: parsed.data.dryRun ?? false,
    idempotencyKey: parsed.data.idempotencyKey,
  });
  return renderOutcome('delete', gate.guildId, parsed.data.panelId, outcome);
};

/** Never throws and never rejects: see `createPanelText`. */
export const deletePanelText = async (
  principal: McpPrincipal,
  port: McpPanelsPort,
  rawArgs: unknown,
): Promise<PanelOutcomeText> => {
  try {
    return await deletePanelInner(principal, port, rawArgs);
  } catch {
    return refuse();
  }
};
