import { describe, expect, it } from 'vitest';
import { parseGuildId, type GuildId } from '@bananasaurs/core';
import { INVALID_ARGUMENTS_MESSAGE, type McpPrincipal } from '../scope.js';
import {
  REACT_TOOL_NAME,
  runReact,
  runSetPin,
  runSetThreadState,
  runThreadMembers,
  runUpdateScheduled,
  SET_PIN_TOOL_NAME,
  SET_THREAD_STATE_TOOL_NAME,
  THREAD_MEMBERS_TOOL_NAME,
  UPDATE_SCHEDULED_TOOL_NAME,
} from './pair-tools.js';
import type { McpMessageWritesPort } from './message-writes.js';
import type { McpThreadWritesPort } from './thread-writes.js';
import type { McpSchedulePort } from './schedule.js';

/**
 * Task 2, routing: the five consolidated pair tools route to the existing
 * handlers with the selector stripped, against recording fake ports — the
 * same seam the handler tests use, so a wrong route would call the wrong
 * Discord method. An unknown action, a parameter belonging to the other
 * action, or (for `set_thread_state`) both/neither state flag is the
 * argument fault with no port call at all.
 */

const GUILD_A = parseGuildId('111111111111111111');
const CHANNEL = '333333333333333333';
const MESSAGE = '444444444444444444';
const THREAD = '344444444444444444';
const USER = '366666666666666666';
const REMINDER = '2b2b2b2b-3c3c-4d4d-8e8e-5f5f5f5f5f5f';
const ACTION = 'act-00000000000000000000000001';

const principalWith = (
  guilds: readonly GuildId[],
  scopes: readonly string[] = ['bananasaurs:send'],
): McpPrincipal => ({
  accountId: 'acct_00000000000000000000000000000000',
  reachableGuilds: guilds,
  scopes,
});

const messagePort = (): McpMessageWritesPort & {
  readonly calls: ReadonlyArray<{ readonly method: string; readonly input: unknown }>;
} => {
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  const record =
    (method: 'pin' | 'unpin' | 'addReaction' | 'removeReaction') =>
    (_guildId: GuildId, input: Record<string, unknown>) => {
      calls.push({ method, input });
      return Promise.resolve({
        status: 'done' as const,
        actionId: ACTION,
        messageId: MESSAGE,
      });
    };
  return {
    calls,
    edit: () => Promise.resolve({ status: 'done' as const, actionId: ACTION }),
    delete: () => Promise.resolve({ status: 'done' as const, actionId: ACTION }),
    pin: record('pin'),
    unpin: record('unpin'),
    addReaction: record('addReaction'),
    removeReaction: record('removeReaction'),
  };
};

const threadPort = (): McpThreadWritesPort & {
  readonly calls: ReadonlyArray<{ readonly method: string; readonly input: unknown }>;
} => {
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  const record =
    (method: 'addThreadMembers' | 'removeThreadMembers' | 'setThreadState') =>
    (_guildId: GuildId, input: Record<string, unknown>) => {
      calls.push({ method, input });
      return Promise.resolve({ status: 'done' as const, actionId: ACTION });
    };
  return {
    calls,
    createThread: () => Promise.resolve({ status: 'done' as const, actionId: ACTION }),
    addThreadMembers: record('addThreadMembers'),
    removeThreadMembers: record('removeThreadMembers'),
    createForumPost: () => Promise.resolve({ status: 'done' as const, actionId: ACTION }),
    setThreadState: record('setThreadState'),
  };
};

const schedulePort = (): McpSchedulePort & {
  readonly calls: ReadonlyArray<{ readonly method: string; readonly input: unknown }>;
} => {
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  const record =
    (method: 'editScheduled' | 'cancelScheduled') =>
    (_guildId: GuildId, input: Record<string, unknown>) => {
      calls.push({ method, input });
      return Promise.resolve({
        status: 'done' as const,
        actionId: ACTION,
        reminderId: REMINDER,
      });
    };
  return {
    calls,
    scheduleMessage: () =>
      Promise.resolve({ status: 'done' as const, actionId: ACTION, reminderId: REMINDER }),
    listScheduled: () => [],
    editScheduled: record('editScheduled'),
    cancelScheduled: record('cancelScheduled'),
  };
};

const reactionArgs = (): Record<string, unknown> => ({
  guildId: '111111111111111111',
  channelId: CHANNEL,
  messageId: MESSAGE,
  emoji: '👍',
  idempotencyKey: 'react-k1',
});

const pinArgs = (): Record<string, unknown> => ({
  guildId: '111111111111111111',
  channelId: CHANNEL,
  messageId: MESSAGE,
  idempotencyKey: 'pin-k1',
});

const membersArgs = (): Record<string, unknown> => ({
  guildId: '111111111111111111',
  threadId: THREAD,
  userIds: [USER],
  idempotencyKey: 'members-k1',
});

const stateArgs = (): Record<string, unknown> => ({
  guildId: '111111111111111111',
  threadId: THREAD,
  idempotencyKey: 'state-k1',
});

const editArgs = (): Record<string, unknown> => ({
  guildId: '111111111111111111',
  reminderId: REMINDER,
  content: 'game night saturday',
  idempotencyKey: 'sched-e1',
});

const cancelArgs = (): Record<string, unknown> => ({
  guildId: '111111111111111111',
  reminderId: REMINDER,
  idempotencyKey: 'sched-c1',
});

describe('pair tool names', () => {
  it('are the five contracted names', () => {
    expect(REACT_TOOL_NAME).toBe('react');
    expect(SET_PIN_TOOL_NAME).toBe('set_pin');
    expect(THREAD_MEMBERS_TOOL_NAME).toBe('thread_members');
    expect(SET_THREAD_STATE_TOOL_NAME).toBe('set_thread_state');
    expect(UPDATE_SCHEDULED_TOOL_NAME).toBe('update_scheduled');
  });
});

describe('react routing', () => {
  it('add reaches addReaction with the action stripped', async () => {
    const port = messagePort();
    const outcome = await runReact(principalWith([GUILD_A]), port, {
      ...reactionArgs(),
      action: 'add',
    });
    expect(outcome.ok).toBe(true);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.method).toBe('addReaction');
    expect(port.calls[0]?.input).toEqual({
      channelId: CHANNEL,
      messageId: MESSAGE,
      emoji: '👍',
      dryRun: false,
      idempotencyKey: 'react-k1',
    });
  });

  it('remove reaches removeReaction with the action stripped', async () => {
    const port = messagePort();
    const outcome = await runReact(principalWith([GUILD_A]), port, {
      ...reactionArgs(),
      action: 'remove',
    });
    expect(outcome.ok).toBe(true);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.method).toBe('removeReaction');
    expect(port.calls[0]?.input).toEqual({
      channelId: CHANNEL,
      messageId: MESSAGE,
      emoji: '👍',
      dryRun: false,
      idempotencyKey: 'react-k1',
    });
  });

  it.each([
    ['unknown action', { ...reactionArgs(), action: 'explode' }],
    ['missing action', reactionArgs()],
  ])('%s is the argument fault and no reaction is touched', async (_label, args) => {
    const port = messagePort();
    const outcome = await runReact(principalWith([GUILD_A]), port, args);
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls).toHaveLength(0);
  });
});

describe('set_pin routing', () => {
  it('pinned true reaches pin with the selector stripped', async () => {
    const port = messagePort();
    const outcome = await runSetPin(principalWith([GUILD_A]), port, {
      ...pinArgs(),
      pinned: true,
    });
    expect(outcome.ok).toBe(true);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.method).toBe('pin');
    expect(port.calls[0]?.input).toEqual({
      channelId: CHANNEL,
      messageId: MESSAGE,
      dryRun: false,
      idempotencyKey: 'pin-k1',
    });
  });

  it('pinned false reaches unpin with the selector stripped', async () => {
    const port = messagePort();
    const outcome = await runSetPin(principalWith([GUILD_A]), port, {
      ...pinArgs(),
      pinned: false,
    });
    expect(outcome.ok).toBe(true);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.method).toBe('unpin');
    expect(port.calls[0]?.input).toEqual({
      channelId: CHANNEL,
      messageId: MESSAGE,
      dryRun: false,
      idempotencyKey: 'pin-k1',
    });
  });

  it.each([
    ['missing pinned', pinArgs()],
    ['non-boolean pinned', { ...pinArgs(), pinned: 'yes' }],
  ])('%s is the argument fault and nothing is pinned', async (_label, args) => {
    const port = messagePort();
    const outcome = await runSetPin(principalWith([GUILD_A]), port, args);
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls).toHaveLength(0);
  });
});

describe('thread_members routing', () => {
  it('add reaches addThreadMembers with the action stripped', async () => {
    const port = threadPort();
    const outcome = await runThreadMembers(principalWith([GUILD_A]), port, {
      ...membersArgs(),
      action: 'add',
    });
    expect(outcome.ok).toBe(true);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.method).toBe('addThreadMembers');
    expect(port.calls[0]?.input).toEqual({
      threadId: THREAD,
      userIds: [USER],
      dryRun: false,
      idempotencyKey: 'members-k1',
    });
  });

  it('remove reaches removeThreadMembers with the action stripped', async () => {
    const port = threadPort();
    const outcome = await runThreadMembers(principalWith([GUILD_A]), port, {
      ...membersArgs(),
      action: 'remove',
    });
    expect(outcome.ok).toBe(true);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.method).toBe('removeThreadMembers');
    expect(port.calls[0]?.input).toEqual({
      threadId: THREAD,
      userIds: [USER],
      dryRun: false,
      idempotencyKey: 'members-k1',
    });
  });

  it.each([
    ['unknown action', { ...membersArgs(), action: 'explode' }],
    ['missing action', membersArgs()],
  ])('%s is the argument fault and the member list is untouched', async (_label, args) => {
    const port = threadPort();
    const outcome = await runThreadMembers(principalWith([GUILD_A]), port, args);
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls).toHaveLength(0);
  });
});

describe('set_thread_state routing', () => {
  it('archived reaches the archive path with the flag kept', async () => {
    const port = threadPort();
    const outcome = await runSetThreadState(principalWith([GUILD_A]), port, {
      ...stateArgs(),
      archived: true,
    });
    expect(outcome.ok).toBe(true);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.method).toBe('setThreadState');
    expect(port.calls[0]?.input).toEqual({
      threadId: THREAD,
      archived: true,
      dryRun: false,
      idempotencyKey: 'state-k1',
    });
  });

  it('locked reaches the lock path with the flag kept', async () => {
    const port = threadPort();
    const outcome = await runSetThreadState(principalWith([GUILD_A]), port, {
      ...stateArgs(),
      locked: false,
    });
    expect(outcome.ok).toBe(true);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.method).toBe('setThreadState');
    expect(port.calls[0]?.input).toEqual({
      threadId: THREAD,
      locked: false,
      dryRun: false,
      idempotencyKey: 'state-k1',
    });
  });

  it.each([
    ['both flags together', { ...stateArgs(), archived: true, locked: true }],
    ['neither flag', stateArgs()],
  ])('%s is the argument fault and the thread state is untouched', async (_label, args) => {
    const port = threadPort();
    const outcome = await runSetThreadState(principalWith([GUILD_A]), port, args);
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls).toHaveLength(0);
  });
});

describe('update_scheduled routing', () => {
  it('edit reaches editScheduled with the action stripped', async () => {
    const port = schedulePort();
    const outcome = await runUpdateScheduled(principalWith([GUILD_A]), port, {
      ...editArgs(),
      action: 'edit',
    });
    expect(outcome.ok).toBe(true);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.method).toBe('editScheduled');
    expect(port.calls[0]?.input).toEqual({
      reminderId: REMINDER,
      content: 'game night saturday',
      at: undefined,
      recurrence: undefined,
      pingRoles: undefined,
      pingUsers: undefined,
      dryRun: false,
      idempotencyKey: 'sched-e1',
    });
  });

  it('cancel reaches cancelScheduled with the action stripped', async () => {
    const port = schedulePort();
    const outcome = await runUpdateScheduled(principalWith([GUILD_A]), port, {
      ...cancelArgs(),
      action: 'cancel',
    });
    expect(outcome.ok).toBe(true);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.method).toBe('cancelScheduled');
    expect(port.calls[0]?.input).toEqual({
      reminderId: REMINDER,
      dryRun: false,
      idempotencyKey: 'sched-c1',
    });
  });

  it.each([
    ['unknown action', { ...cancelArgs(), action: 'explode' }],
    ['missing action', cancelArgs()],
    [
      'cancel carrying an edit-only field',
      { ...cancelArgs(), action: 'cancel', content: 'late change' },
    ],
    [
      'cancel carrying a re-time',
      { ...cancelArgs(), action: 'cancel', at: '2031-05-06T12:00:00.000Z' },
    ],
  ])('%s is the argument fault and nothing is stored', async (_label, args) => {
    const port = schedulePort();
    const outcome = await runUpdateScheduled(principalWith([GUILD_A]), port, args);
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls).toHaveLength(0);
  });
});
