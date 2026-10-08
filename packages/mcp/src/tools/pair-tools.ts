import { z } from 'zod';
import { reminderRecurrence } from '@bananasaurs/core';
import { INVALID_ARGUMENTS_MESSAGE, type McpPrincipal } from '../scope.js';
import {
  addReactionText,
  pinMessageText,
  removeReactionText,
  unpinMessageText,
  type McpMessageWritesPort,
  type MessageWriteOutcomeText,
} from './message-writes.js';
import {
  addThreadMembersText,
  archiveThreadText,
  lockThreadText,
  removeThreadMembersText,
  type McpThreadWritesPort,
  type ThreadWriteOutcomeText,
} from './thread-writes.js';
import {
  cancelScheduledText,
  editScheduledText,
  SCHEDULE_CONTENT_MAX,
  type McpSchedulePort,
  type ScheduleOutcomeText,
} from './schedule.js';

/**
 * ADR 0132 (Task 2): the 5 action-based pair tools. Each merged tool takes
 * its selector (`action`, `pinned`, or exactly one of `archived`/`locked`)
 * plus the union of its sides' parameters as optional fields; routing
 * strips the selector and calls the existing handler, whose strict
 * per-side parse stays the real argument boundary. Over MCP the selector is
 * a `z.enum` (`pinned` is a `z.boolean()`), so the SDK refuses an unknown or
 * missing value first, with its own "Input validation error", and the
 * handler never runs. `INVALID_ARGUMENTS_MESSAGE` is the route's own refusal:
 * for a call that reaches the route without the SDK check (the routing tests
 * make such calls), for `set_thread_state` with both or neither of
 * `archived`/`locked`, and for a parameter belonging to the other side. The
 * handler is never called in any of those. Old tool names are removed, with
 * no aliases.
 */

const withoutSelector = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const rest = { ...record };
  delete rest[key];
  return rest;
};

export const REACT_TOOL_NAME = 'react';
export const REACT_TOOL_DESCRIPTION = [
  "Add or remove the bot's own reaction on a message in a channel where Write is on in this guild.",
  'add: adds the bot\u2019s own reaction. Emoji is a unicode emoji or name:id for a custom emoji of this guild.',
  'remove: removes the bot\u2019s own reaction.',
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
    'Pass dryRun to record without reacting.',
].join('\n');
export const reactParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  action: z.enum(['add', 'remove']).describe('add or remove.'),
  channelId: z.string().optional().describe('Every react action uses this.'),
  messageId: z.string().optional().describe('Every react action uses this.'),
  emoji: z
    .string()
    .optional()
    .describe('Every react action uses this: a unicode emoji, or name:id for a custom emoji.'),
  dryRun: z.boolean().optional().describe('Every react action uses this.'),
  idempotencyKey: z.string().optional().describe('Every react action uses this.'),
};
export const runReact = async (
  principal: McpPrincipal,
  port: McpMessageWritesPort,
  raw: unknown,
): Promise<MessageWriteOutcomeText> => {
  if (typeof raw !== 'object' || raw === null)
    return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  const record = raw as Record<string, unknown>;
  const action = record['action'];
  if (action !== 'add' && action !== 'remove')
    return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  const rest = withoutSelector(record, 'action');
  return action === 'add'
    ? addReactionText(principal, port, rest)
    : removeReactionText(principal, port, rest);
};

export const SET_PIN_TOOL_NAME = 'set_pin';
export const SET_PIN_TOOL_DESCRIPTION = [
  'Set the pin state of any message in a channel where Write is on in this guild. ' +
    'The bot needs the PinMessages or ManageMessages Discord permission in the channel.',
  'pinned true pins the message; false unpins it.',
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
    'Pass dryRun to record without changing anything.',
].join('\n');
export const setPinParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  pinned: z.boolean().describe('True pins the message; false unpins it.'),
  channelId: z.string().optional().describe('Pinned either way, this names the channel.'),
  messageId: z.string().optional().describe('Pinned either way, this names the message.'),
  dryRun: z.boolean().optional().describe('Pinned either way, this records without changing.'),
  idempotencyKey: z.string().optional().describe('Pinned either way, this keys the write.'),
};
export const runSetPin = async (
  principal: McpPrincipal,
  port: McpMessageWritesPort,
  raw: unknown,
): Promise<MessageWriteOutcomeText> => {
  if (typeof raw !== 'object' || raw === null)
    return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  const record = raw as Record<string, unknown>;
  const pinned = record['pinned'];
  if (typeof pinned !== 'boolean')
    return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  const rest = withoutSelector(record, 'pinned');
  return pinned ? pinMessageText(principal, port, rest) : unpinMessageText(principal, port, rest);
};

export const THREAD_MEMBERS_TOOL_NAME = 'thread_members';
export const THREAD_MEMBERS_TOOL_DESCRIPTION = [
  'Change which guild members are in a thread, up to 25 per call.',
  'add: adds up to 25 guild members to a thread. Each member must be in this guild.',
  'remove: removes up to 25 members from a thread. Removing a non-member is a no-op.',
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
    'Pass dryRun to record without changing anything.',
].join('\n');
export const threadMembersParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  action: z.enum(['add', 'remove']).describe('add or remove.'),
  threadId: z.string().optional().describe('Every thread_members action uses this.'),
  userIds: z
    .array(z.string())
    .optional()
    .describe('Every thread_members action uses this: up to 25 members, as ids.'),
  dryRun: z.boolean().optional().describe('Every thread_members action uses this.'),
  idempotencyKey: z.string().optional().describe('Every thread_members action uses this.'),
};
export const runThreadMembers = async (
  principal: McpPrincipal,
  port: McpThreadWritesPort,
  raw: unknown,
): Promise<ThreadWriteOutcomeText> => {
  if (typeof raw !== 'object' || raw === null)
    return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  const record = raw as Record<string, unknown>;
  const action = record['action'];
  if (action !== 'add' && action !== 'remove')
    return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  const rest = withoutSelector(record, 'action');
  return action === 'add'
    ? addThreadMembersText(principal, port, rest)
    : removeThreadMembersText(principal, port, rest);
};

export const SET_THREAD_STATE_TOOL_NAME = 'set_thread_state';
export const SET_THREAD_STATE_TOOL_DESCRIPTION = [
  'Change whether a thread is archived or locked.',
  'archived: true archives the thread; false unarchives it.',
  'locked: true locks the thread; false unlocks it. A locked thread accepts no new messages except by moderators.',
  'Pass exactly one of archived or locked — both or neither is refused, because two state ' +
    'changes under one idempotency key would replay the second as the first.',
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
    'Pass dryRun to record without changing anything.',
].join('\n');
export const setThreadStateParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  threadId: z.string().optional().describe('With either flag, this names the thread.'),
  archived: z
    .boolean()
    .optional()
    .describe(
      'Pass exactly one of archived or locked: true archives the thread; false unarchives it.',
    ),
  locked: z
    .boolean()
    .optional()
    .describe('Pass exactly one of archived or locked: true locks the thread; false unlocks it.'),
  dryRun: z.boolean().optional().describe('With either flag, this records without changing.'),
  idempotencyKey: z.string().optional().describe('With either flag, this keys the write.'),
};
export const runSetThreadState = async (
  principal: McpPrincipal,
  port: McpThreadWritesPort,
  raw: unknown,
): Promise<ThreadWriteOutcomeText> => {
  if (typeof raw !== 'object' || raw === null)
    return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  const record = raw as Record<string, unknown>;
  // An explicit undefined counts as absent, so presence (`!== undefined`)
  // picks the side: both-or-neither (the ruling in the description) refuses
  // here, and a present but non-boolean flag is passed on, where the
  // handler's own parse refuses it.
  const hasArchived = record['archived'] !== undefined;
  const hasLocked = record['locked'] !== undefined;
  if (hasArchived === hasLocked) return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  return hasArchived
    ? archiveThreadText(principal, port, record)
    : lockThreadText(principal, port, record);
};

export const UPDATE_SCHEDULED_TOOL_NAME = 'update_scheduled';
export const UPDATE_SCHEDULED_TOOL_DESCRIPTION = [
  'Change a scheduled send of this guild. Only a message still waiting to send can be changed; ' +
    'an unknown id, or one already sent, cancelled or failed, is refused.',
  'edit: pass content, at, recurrence, pingRoles or pingUsers to change (at and recurrence are ' +
    'exclusive, like at creation); new pings are checked against the guild ping policy. ' +
    'The previous values are kept for undo.',
  'cancel: cancels the send. Undo restores the send while it is still due; past its due time the undo refuses as expired.',
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
    'Pass dryRun to record without changing anything.',
].join('\n');
/** Fields only the edit side takes: a cancel carrying any of them is refused here. */
const UPDATE_SCHEDULED_EDIT_ONLY = [
  'content',
  'at',
  'recurrence',
  'pingRoles',
  'pingUsers',
] as const;
export const updateScheduledParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  action: z.enum(['edit', 'cancel']).describe('edit or cancel.'),
  reminderId: z
    .string()
    .optional()
    .describe('Scheduled send to edit or cancel, from list_scheduled.'),
  content: z
    .string()
    .optional()
    .describe(`edit only: new message text, 1 to ${String(SCHEDULE_CONTENT_MAX)} characters.`),
  at: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      'edit only: new one-shot fire time as an ISO-8601 string or epoch milliseconds; must be in the future, and clears any recurrence. Exclusive with recurrence.',
    ),
  recurrence: reminderRecurrence
    .optional()
    .describe(
      'edit only: new recurring pattern with a time zone; the send re-anchors to its next occurrence. Exclusive with at.',
    ),
  pingRoles: z
    .array(z.string())
    .optional()
    .describe(
      'edit only: replacement role pings, as names or ids; checked against the guild ping policy.',
    ),
  pingUsers: z
    .array(z.string())
    .optional()
    .describe('edit only: replacement member pings, as ids.'),
  dryRun: z.boolean().optional().describe('Record without changing anything.'),
  idempotencyKey: z
    .string()
    .optional()
    .describe(
      'Caller-supplied key for this edit or cancellation; reuse the same value if you retry this call.',
    ),
};
export const runUpdateScheduled = async (
  principal: McpPrincipal,
  port: McpSchedulePort,
  raw: unknown,
): Promise<ScheduleOutcomeText> => {
  if (typeof raw !== 'object' || raw === null)
    return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  const record = raw as Record<string, unknown>;
  const action = record['action'];
  if (action !== 'edit' && action !== 'cancel')
    return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  if (action === 'cancel' && UPDATE_SCHEDULED_EDIT_ONLY.some((key) => record[key] !== undefined))
    return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  const rest = withoutSelector(record, 'action');
  return action === 'edit'
    ? editScheduledText(principal, port, rest)
    : cancelScheduledText(principal, port, rest);
};
