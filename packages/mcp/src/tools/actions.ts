import { z } from 'zod';
import type { GuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';
import { MCP_READ_LIST_ACTIONS, type McpReadRecord } from '../read-audit.js';

/**
 * `undo_action` and `list_actions` (slice 3, Task 7): the task-tracking
 * write tools' neighbours — every MCP write runs through `runMcpAction`
 * and records an `mcp_actions` row, and these two tools read that ledger
 * back.
 *
 * They follow the same five steps as `send_message` in `send.ts` — Zod
 * parse → `requireReachableGuild` → port call → render — so hard rule 3
 * holds by construction, and the same two-message contract (ruling M4-D18):
 * a parse failure is the argument-fault message, a guild the caller cannot
 * reach or a throw out of the port is the shared refusal. No tool here
 * throws. Refusal texts are distinct, actionable and content-free (ids
 * only), as in `packages/mcp/src/tools/send.ts`.
 *
 * This module holds no ledger handle of any kind, for the same reason
 * `send.ts` holds no allowlist handle: the daemon's actions port owns the
 * ledger read, the inverse Discord calls and the safety reads, and this
 * package's port projects its outcomes field by field. The view below has
 * no content field by construction — `list_actions` cannot leak what the
 * ledger never sends it.
 *
 * `undo_action` takes no caller-supplied idempotency key (the one exemption
 * to the Global Constraints' "every write tool" rule): the daemon derives
 * the key as `undo:<actionId>`, so a retry names the same key whatever the
 * caller passes, and a new key can never undo twice. Slice 4 extends the
 * same tool with the role-kind inverses under the roles scope.
 */

/** `list_actions` shows at most this many rows per call. */
export const LIST_ACTIONS_LIMIT_MAX = 100;
/** `list_actions` shows this many rows when the caller passes no limit. */
export const LIST_ACTIONS_DEFAULT_LIMIT = 20;

export const UNDO_ACTION_TOOL_NAME = 'undo_action';
export const UNDO_ACTION_TOOL_DESCRIPTION =
  'Undoes one reversible MCP action in this guild: a message edit restores the previous text, ' +
  'an event edit restores the previous values, ' +
  'a scheduled-message edit restores the previous values, ' +
  'a scheduled-message cancellation restores the send while it is still due, ' +
  'a pin or unpin does the opposite, a reaction add or remove does the opposite, ' +
  'a thread-member add removes the same members, a thread archive or lock restores ' +
  'the previous state, a role grant removes the same role while a role removal re-grants it, ' +
  'and a role edit restores the previous name, color and mentionable. ' +
  'Posts, deletes, scheduled-message creation, event creation, event cancellation, thread creation, forum posts, ' +
  'member removals, role creation, panel creation, panel edits and panel deletion ' +
  'cannot be undone, and neither can a role change that changed nothing. Each action undoes at most once: repeating this call answers that ' +
  'it is already undone. Takes an actionId from list_actions; the undo runs as its own ' +
  'action with key undo:<actionId>.';

export const LIST_ACTIONS_TOOL_NAME = 'list_actions';
export const LIST_ACTIONS_TOOL_DESCRIPTION =
  'Lists the newest MCP actions in this guild — kind, status, target ids, whether each ' +
  'can be undone, and when it ran. Names ids only, never message content. Read-only.';

/**
 * One ledger row as `list_actions` shows it: kind, status, target ids,
 * whether it can still be undone, and when it ran. There is deliberately no
 * content field — not even the bot's own previous text from an edit's undo
 * row — so the renderer cannot leak it.
 */
export interface McpActionView {
  readonly actionId: string;
  readonly kind: string;
  readonly status: string;
  readonly targetChannelId?: string | undefined;
  readonly resultMessageId?: string | undefined;
  readonly resultThreadId?: string | undefined;
  readonly undoable: boolean;
  readonly createdAt: number;
}

/** What the daemon's actions wiring must satisfy (Task 7 implements it). */
export interface McpActionsPort {
  readonly undo: (
    guildId: GuildId,
    input: { readonly actionId: string },
  ) => Promise<McpUndoOutcome>;
  readonly list: (guildId: GuildId, input: { readonly limit: number }) => readonly McpActionView[];
}

/** Mirrors the gateway's outcomes, named in this package's own vocabulary. */
export type McpUndoOutcome =
  | {
      readonly status: 'done';
      readonly actionId: string;
      readonly undoneActionId: string;
      readonly kind: string;
    }
  | {
      readonly status: 'dry-run';
      readonly actionId: string;
      readonly undoneActionId: string;
      readonly kind: string;
    }
  | { readonly status: 'refused'; readonly reason: McpUndoRefusal; readonly detail?: string }
  | { readonly status: 'failed' };

export type McpUndoRefusal =
  | 'action-not-found'
  | 'already-undone'
  | 'action-dry-run'
  | 'action-failed'
  | 'action-incomplete'
  | 'not-undoable'
  | 'expired'
  | 'undo-in-progress'
  | 'scope-mismatch'
  | 'target-unavailable'
  | 'role-unavailable'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap';

export type UndoOutcomeText =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

export type ListActionsOutcomeText =
  | { readonly ok: true; readonly text: string; readonly read: McpReadRecord }
  | { readonly ok: false; readonly message: string };

/**
 * Zod schemas are the boundary (hard rule 3): a parse failure is the
 * argument-fault message, never a throw, and the parse runs before the
 * guild gate. `guildId` is a bare string on purpose, like `send.ts`: the
 * gate parses it and refuses malformed and unreachable identically. The
 * action id is opaque ledger vocabulary (a ULID-like id, or `legacy:…`
 * for a row copied by migration 0092), so it is never a snowflake and is
 * checked only for non-emptiness here — existence is the daemon's answer.
 */
const undoArgsSchema = z.object({
  guildId: z.string(),
  actionId: z.string().min(1),
});

const listArgsSchema = z.object({
  guildId: z.string(),
  limit: z.number().int().min(1).max(LIST_ACTIONS_LIMIT_MAX).optional(),
});

/**
 * The loose wire shapes registered with the MCP server. Deliberately
 * without refinements, like `sendMessageParams`: these document the wire
 * types for clients while the strict schemas above stay the single
 * boundary.
 */
export const undoActionParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  actionId: z
    .string()
    .describe('Action to undo, from list_actions. Each action undoes at most once.'),
};

export const listActionsParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  limit: z
    .number()
    .optional()
    .describe(
      `Newest actions to show, 1 to ${String(LIST_ACTIONS_LIMIT_MAX)}. Defaults to ${String(LIST_ACTIONS_DEFAULT_LIMIT)}.`,
    ),
};

const refuse = (): UndoOutcomeText => ({ ok: false, message: GUILD_REFUSAL_MESSAGE });

const refuseInvalidArgs = (): UndoOutcomeText => ({
  ok: false,
  message: INVALID_ARGUMENTS_MESSAGE,
});

/**
 * Every refusal renders distinctly and actionably: the operator reading it
 * knows what stopped the undo and what to do next. No two reasons share a
 * string (pinned by test), and none echoes message content — ids only. The
 * `detail` carries the undo's action id for `already-undone` and the
 * original kind for `not-undoable`.
 */
const undoRefusalText = (
  guildId: GuildId,
  actionId: string,
  reason: McpUndoRefusal,
  detail?: string,
): string => {
  switch (reason) {
    case 'action-not-found':
      return (
        `No MCP action ${actionId} in guild ${guildId}, so nothing was undone. ` +
        'Only actions of this guild can be undone: check the id with `list_actions`.'
      );
    case 'already-undone':
      return (
        `Action ${actionId} in guild ${guildId} was already undone` +
        `${detail !== undefined ? ` as action ${detail}` : ''}: nothing new was changed.`
      );
    case 'action-dry-run':
      return (
        `Action ${actionId} in guild ${guildId} was a dry run, so nothing reached Discord ` +
        'and there is nothing to undo.'
      );
    case 'action-failed':
      return (
        `Action ${actionId} in guild ${guildId} failed with an unknown result, ` +
        'so there is no known state to restore. Check the channel or thread by hand: ' +
        'the write may or may not have happened.'
      );
    case 'action-incomplete':
      return (
        `Action ${actionId} in guild ${guildId} has not completed yet, so there is nothing ` +
        'to undo yet. Wait for it to complete, then retry this call.'
      );
    case 'not-undoable':
      if (detail === 'role.bulk') {
        return (
          `Action ${actionId} in guild ${guildId} is a bulk role change, which cannot be undone: ` +
          'run the opposite bulk change (`bulk_role_change` with the other action over the same set) ' +
          'to reverse it.'
        );
      }
      return (
        `Action ${actionId} in guild ${guildId} cannot be undone` +
        `${detail !== undefined ? ` (kind ${detail})` : ''}: only message edits, event edits, ` +
        'scheduled-message edits and cancellations, pins, reactions, thread-member adds, thread state changes, role grants, role removals ' +
        'and role edits are reversible — posts, deletes, scheduled-message creation, event creation, event cancellation, ' +
        'thread creation, forum posts, member removals, role creation, panel creation, panel ' +
        'edits and panel deletion never are — a role change that changed nothing ' +
        '(the member already had the role, or did not have it) records no undo, and a reversible action whose ' +
        'stored previous state is missing or unreadable cannot be restored either.'
      );
    case 'undo-in-progress':
      return (
        `An undo of action ${actionId} in guild ${guildId} is already running` +
        `${detail !== undefined ? ` as action ${detail}` : ''}, so no second one was started. ` +
        'Check `list_actions` for its outcome before retrying.'
      );
    case 'expired':
      return (
        `Action ${actionId} in guild ${guildId} cancelled a scheduled message that has since fallen due` +
        `${detail !== undefined ? ` (${detail})` : ''}, so the undo expired and nothing was restored. ` +
        'A cancelled send can only be un-cancelled while it is still in the future: ' +
        'schedule the message again instead.'
      );
    case 'scope-mismatch':
      return (
        `Action ${actionId} in guild ${guildId} was not undone: undoing it needs the ` +
        `${detail ?? 'bananasaurs:send'} scope, which this token does not carry. ` +
        'Ask the owner to re-authorise the connector with that scope, then retry. ' +
        'Nothing was changed.'
      );
    case 'target-unavailable':
      return (
        `Action ${actionId} in guild ${guildId} was not undone: its channel or thread is no ` +
        'longer one this connector may write to' +
        `${detail !== undefined ? ` (${detail})` : ''}. An operator must restore send scope or ` +
        "the bot's permission there before the undo can run."
      );
    case 'role-unavailable':
      return (
        `Action ${actionId} in guild ${guildId} was not undone: ` +
        `${detail ?? 'its role or member is no longer available'}. ` +
        'The member, the role or the grant policy changed since the action ran — ' +
        'change it back by hand if the undo is still wanted.'
      );
    case 'killswitch':
      return (
        `The kill switch is on for guild ${guildId}, so action ${actionId} was not undone. ` +
        'Undoing stays paused until an operator turns it off; do not retry in a loop.'
      );
    case 'breaker-open':
      return (
        `The circuit breaker is open for guild ${guildId} after repeated Discord faults, ` +
        `so action ${actionId} was not undone. Wait for an operator to clear it; do not retry in a loop.`
      );
    case 'rate-cap':
      return (
        `Guild ${guildId} has used its rolling-hour budget for this kind of action, ` +
        `so action ${actionId} was not undone. Wait for the window to pass before retrying` +
        `${detail !== undefined ? ` (resets at ${detail})` : ''}; ` +
        'listing actions still works meanwhile.'
      );
  }
};

const undoActionInner = async (
  principal: McpPrincipal,
  port: McpActionsPort,
  rawArgs: unknown,
): Promise<UndoOutcomeText> => {
  const parsed = undoArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  const gate = requireReachableGuild(principal, parsed.data.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const outcome = await port.undo(gate.guildId, { actionId: parsed.data.actionId });
  switch (outcome.status) {
    case 'done':
      return {
        ok: true,
        text:
          `Undid ${outcome.kind} action ${outcome.undoneActionId} in guild ${gate.guildId} ` +
          `(undo action ${outcome.actionId}).`,
      };
    case 'dry-run':
      return {
        ok: true,
        text:
          `Dry run is on for guild ${gate.guildId}: ` +
          `nothing was undone for ${outcome.kind} action ${outcome.undoneActionId}. The undo was recorded ` +
          `as action ${outcome.actionId} under its key but no Discord call was made.`,
      };
    case 'refused':
      return {
        ok: false,
        message: undoRefusalText(
          gate.guildId,
          parsed.data.actionId,
          outcome.reason,
          outcome.detail,
        ),
      };
    case 'failed':
      // The Discord call failed with an unknown result: Discord may have
      // applied the inverse and the response been lost, so this must not
      // claim nothing changed — nobody knows that. A retry with the same
      // action id runs the inverse again under a fresh attempt key; every
      // inverse is idempotent (edit back, pin/unpin, own reaction, member
      // removal, thread state), so a second application changes nothing.
      return {
        ok: false,
        message:
          `The Discord call undoing action ${parsed.data.actionId} ` +
          `in guild ${gate.guildId} failed with an unknown result: the target ` +
          `may or may not have been restored. Retrying with the same action id is safe: ` +
          'the inverse is re-applied, and re-applying it changes nothing that already happened.',
      };
  }
};

/**
 * Never throws and never rejects: a malformed argument is the
 * argument-fault message, and anything unexpected (a port fault, which
 * cannot carry message content outward from here) is the shared refusal
 * rather than an exception out of the handler. The two messages are
 * deliberately different (ruling M4-D18).
 */
export const undoActionText = async (
  principal: McpPrincipal,
  port: McpActionsPort,
  rawArgs: unknown,
): Promise<UndoOutcomeText> => {
  try {
    return await undoActionInner(principal, port, rawArgs);
  } catch {
    return refuse();
  }
};

const listActionsInner = (
  principal: McpPrincipal,
  port: McpActionsPort,
  rawArgs: unknown,
): ListActionsOutcomeText => {
  const parsed = listArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, message: INVALID_ARGUMENTS_MESSAGE };
  const gate = requireReachableGuild(principal, parsed.data.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const views = port.list(gate.guildId, { limit: parsed.data.limit ?? LIST_ACTIONS_DEFAULT_LIMIT });
  if (views.length === 0) {
    return {
      ok: true,
      text: `No MCP actions recorded in guild ${gate.guildId}.`,
      read: {
        kind: 'structural',
        action: MCP_READ_LIST_ACTIONS,
        guildIds: [gate.guildId],
        resultCount: 0,
      },
    };
  }
  const lines = views.map((view) => {
    const parts = [
      view.actionId,
      view.kind,
      view.status,
      ...(view.targetChannelId !== undefined ? [`target ${view.targetChannelId}`] : []),
      ...(view.resultMessageId !== undefined ? [`message ${view.resultMessageId}`] : []),
      ...(view.resultThreadId !== undefined ? [`thread ${view.resultThreadId}`] : []),
      `undoable ${view.undoable ? 'yes' : 'no'}`,
      `created ${new Date(view.createdAt).toISOString()}`,
    ];
    return parts.join(' | ');
  });
  return {
    ok: true,
    text:
      `MCP actions in guild ${gate.guildId}: ${String(views.length)} shown (newest first).\n` +
      lines.join('\n'),
    // Ids, kinds, statuses and timestamps are structure, not member
    // content: structural read under ADR 0050's split (one log line).
    read: {
      kind: 'structural',
      action: MCP_READ_LIST_ACTIONS,
      guildIds: [gate.guildId],
      resultCount: views.length,
    },
  };
};

/** Never throws and never rejects: a rejected port promise is the shared refusal. */
export const listActionsText = (
  principal: McpPrincipal,
  port: McpActionsPort,
  rawArgs: unknown,
): Promise<ListActionsOutcomeText> => {
  try {
    return Promise.resolve(listActionsInner(principal, port, rawArgs));
  } catch {
    return Promise.resolve({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  }
};
