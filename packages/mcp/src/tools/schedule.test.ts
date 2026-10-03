import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGuildId, type GuildId } from '@bananasaurs/core';
import { reminderRecurrence } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, INVALID_ARGUMENTS_MESSAGE, type McpPrincipal } from '../scope.js';
import { MCP_READ_LIST_SCHEDULED } from '../read-audit.js';
import { EVIDENCE_CLOSE, EVIDENCE_OPEN, EVIDENCE_PREAMBLE } from '../envelope.js';
import { undoActionText, type McpActionsPort } from './actions.js';
import {
  CANCEL_SCHEDULED_TOOL_NAME,
  cancelScheduledText,
  EDIT_SCHEDULED_TOOL_NAME,
  editScheduledText,
  LIST_SCHEDULED_TOOL_NAME,
  listScheduledText,
  SCHEDULE_CONTENT_MAX,
  SCHEDULE_MESSAGE_TOOL_DESCRIPTION,
  SCHEDULE_MESSAGE_TOOL_NAME,
  SCHEDULE_PREVIEW_MAX,
  scheduleMessageText,
  type McpScheduleOutcome,
  type McpSchedulePort,
  type McpScheduleRefusal,
  type McpScheduledView,
} from './schedule.js';

/**
 * Task 3, tool layer: the four schedule tools against a fake
 * `McpSchedulePort` — the same seam the daemon's schedule wiring implements,
 * so the guard behaviour pinned here (guild gate, argument boundary, refusal
 * rendering, evidence framing) holds whichever implementation sits behind
 * it. Scope filtering (ruling M4-D17) is pinned in `registration.test.ts`
 * (the send set grows by four) and in the scope sections of the older write
 * tool tests; this file pins the four tools' own contract.
 */

const GUILD_A = parseGuildId('111111111111111111');
const CHANNEL = '333333333333333333';
const REMINDER = '2b2b2b2b-3c3c-4d4d-8e8e-5f5f5f5f5f5f';
const ACTION = 'act-00000000000000000000000001';
const FUTURE_ISO = '2031-05-06T12:00:00.000Z';
const FUTURE_MS = Date.parse(FUTURE_ISO);

const principalWith = (
  guilds: readonly GuildId[],
  scopes: readonly string[] = ['bananasaurs:send'],
): McpPrincipal => ({
  accountId: 'acct_00000000000000000000000000000000',
  reachableGuilds: guilds,
  scopes,
});

const scheduleArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  channel: CHANNEL,
  content: 'game night friday',
  at: FUTURE_ISO,
  idempotencyKey: 'sched-k1',
  ...over,
});

const editArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  reminderId: REMINDER,
  content: 'game night saturday',
  idempotencyKey: 'sched-e1',
  ...over,
});

const cancelArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  reminderId: REMINDER,
  idempotencyKey: 'sched-c1',
  ...over,
});

const listArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  ...over,
});

const recurrenceDaily = (): object =>
  reminderRecurrence.parse({ pattern: { kind: 'daily' }, timeZone: 'America/Vancouver' });

/** Fake schedule port: every call recorded, outcomes scripted per test. */
const fakeSchedulePort = (
  over: Partial<McpSchedulePort> = {},
): McpSchedulePort & {
  readonly calls: Record<string, number>;
} => {
  const calls: Record<string, number> = {
    scheduleMessage: 0,
    listScheduled: 0,
    editScheduled: 0,
    cancelScheduled: 0,
  };
  const done: McpScheduleOutcome = { status: 'done', actionId: ACTION, reminderId: REMINDER };
  return {
    calls,
    scheduleMessage: (_guildId, _input) => {
      calls['scheduleMessage'] = (calls['scheduleMessage'] ?? 0) + 1;
      return Promise.resolve(over.scheduleMessage?.(_guildId, _input) ?? done);
    },
    listScheduled: (_guildId, _input) => {
      calls['listScheduled'] = (calls['listScheduled'] ?? 0) + 1;
      return over.listScheduled?.(_guildId, _input) ?? [];
    },
    editScheduled: (_guildId, _input) => {
      calls['editScheduled'] = (calls['editScheduled'] ?? 0) + 1;
      return Promise.resolve(over.editScheduled?.(_guildId, _input) ?? done);
    },
    cancelScheduled: (_guildId, _input) => {
      calls['cancelScheduled'] = (calls['cancelScheduled'] ?? 0) + 1;
      return Promise.resolve(over.cancelScheduled?.(_guildId, _input) ?? done);
    },
  };
};

const textOf = (outcome: { readonly ok: boolean; readonly text?: string }): string => {
  expect(outcome.ok).toBe(true);
  return (outcome as { readonly text: string }).text;
};

const messageOf = (outcome: { readonly ok: boolean; readonly message?: string }): string => {
  expect(outcome.ok).toBe(false);
  return (outcome as { readonly message: string }).message;
};

describe('schedule tools guild gate (CLAUDE.md rule 2)', () => {
  it.each([
    ['unreachable guild id', '222222222222222222', [GUILD_A]],
    ['malformed guild id', 'not-a-snowflake', [GUILD_A]],
    ['empty reachable set', '111111111111111111', []],
  ])('%s is the shared refusal and the port was never called', async (_label, guildId, guilds) => {
    const port = fakeSchedulePort();
    const [scheduled, edited, cancelled] = await Promise.all([
      scheduleMessageText(principalWith(guilds), port, { ...scheduleArgs(), guildId }),
      editScheduledText(principalWith(guilds), port, { ...editArgs(), guildId }),
      cancelScheduledText(principalWith(guilds), port, { ...cancelArgs(), guildId }),
    ]);
    expect(scheduled).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(edited).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(cancelled).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(listScheduledText(principalWith(guilds), port, { ...listArgs(), guildId })).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
    expect(Object.values(port.calls).every((count) => count === 0)).toBe(true);
  });

  it('empty, malformed and unreachable refusals are indistinguishable', async () => {
    const port = fakeSchedulePort();
    const outcomes = await Promise.all([
      scheduleMessageText(principalWith([]), port, scheduleArgs()),
      scheduleMessageText(principalWith([GUILD_A]), port, {
        ...scheduleArgs(),
        guildId: 'not-a-snowflake',
      }),
      scheduleMessageText(principalWith([GUILD_A]), port, {
        ...scheduleArgs(),
        guildId: '222222222222222222',
      }),
    ]);
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    }
    expect(port.calls['scheduleMessage']).toBe(0);
  });
});

describe('schedule_message argument boundary (hard rule 3)', () => {
  it.each([
    ['content over 2000 characters', { content: 'x'.repeat(SCHEDULE_CONTENT_MAX + 1) }],
    ['empty content', { content: '' }],
    ['whitespace-only content', { content: '   \n\t  ' }],
    ['missing idempotency key', { idempotencyKey: undefined }],
    ['missing channel', { channel: undefined }],
    ['empty channel', { channel: '' }],
    ['neither at nor recurrence', { at: undefined }],
    ['both at and recurrence', { recurrence: 'RECURRENCE' }],
    ['unparseable at', { at: 'not-a-time' }],
    ['NaN at', { at: Number.NaN }],
    ['non-string non-number at', { at: true }],
    ['eleven ping roles', { pingRoles: Array.from({ length: 11 }, (_, i) => `role-${String(i)}`) }],
    ['malformed ping user id', { pingUsers: ['not-a-user'] }],
    ['missing guild id', { guildId: undefined }],
    ['non-string content', { content: 42 }],
  ])(
    '%s is the argument fault and the port was never called',
    async (_label: string, over: Record<string, unknown>) => {
      const port = fakeSchedulePort();
      // An explicit `undefined` unsets the default, exercising the missing and
      // neither-at-nor-recurrence shapes through the same table.
      const args = scheduleArgs(
        over['recurrence'] === 'RECURRENCE' ? { recurrence: recurrenceDaily() } : over,
      );
      const outcome = await scheduleMessageText(principalWith([GUILD_A]), port, args);
      expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
      expect(port.calls['scheduleMessage']).toBe(0);
    },
  );

  it('an epoch-ms at and a recurrence each reach the port', async () => {
    const seen: Array<Parameters<McpSchedulePort['scheduleMessage']>[1]> = [];
    const port = fakeSchedulePort({
      scheduleMessage: (_guildId, input) => {
        seen.push(input);
        return Promise.resolve({ status: 'done', actionId: ACTION, reminderId: REMINDER });
      },
    });
    const byMs = await scheduleMessageText(principalWith([GUILD_A]), port, {
      ...scheduleArgs({ at: FUTURE_MS, idempotencyKey: 'k-ms' }),
    });
    expect(byMs.ok).toBe(true);
    const {
      at: _droppedAt,
      recurrence: _droppedRecurrence,
      ...withoutTime
    } = scheduleArgs({
      idempotencyKey: 'k-rec',
    });
    void _droppedAt;
    void _droppedRecurrence;
    const byRecurrence = await scheduleMessageText(principalWith([GUILD_A]), port, {
      ...withoutTime,
      recurrence: recurrenceDaily(),
    });
    expect(byRecurrence.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.at).toBe(FUTURE_MS);
    expect(seen[0]?.recurrence).toBeUndefined();
    expect(seen[1]?.at).toBeUndefined();
    expect(seen[1]?.recurrence).toMatchObject({ pattern: { kind: 'daily' } });
  });

  it('a channel name reaches the port unresolved; ping names ride along', async () => {
    let seen: Parameters<McpSchedulePort['scheduleMessage']>[1] | undefined;
    const port = fakeSchedulePort({
      scheduleMessage: (_guildId, input) => {
        seen = input;
        return Promise.resolve({ status: 'done', actionId: ACTION, reminderId: REMINDER });
      },
    });
    const outcome = await scheduleMessageText(principalWith([GUILD_A]), port, {
      ...scheduleArgs({ channel: 'planning', idempotencyKey: 'k-name' }),
      pingRoles: ['helpers'],
      pingUsers: ['377777777777777777'],
    });
    expect(outcome.ok).toBe(true);
    expect(seen?.channel).toBe('planning');
    expect(seen?.pingRoles).toEqual(['helpers']);
    expect(seen?.pingUsers).toEqual(['377777777777777777']);
  });

  it('content is trimmed before the port sees it', async () => {
    let seen: string | undefined;
    const port = fakeSchedulePort({
      scheduleMessage: (_guildId, input) => {
        seen = input.content;
        return Promise.resolve({ status: 'done', actionId: ACTION, reminderId: REMINDER });
      },
    });
    await scheduleMessageText(principalWith([GUILD_A]), port, {
      ...scheduleArgs({ content: '  game night  ', idempotencyKey: 'k-trim' }),
    });
    expect(seen).toBe('game night');
  });
});

describe('edit_scheduled and cancel_scheduled argument boundary', () => {
  it.each([
    ['empty reminder id', { ...editArgs(), reminderId: '' }],
    ['missing reminder id', { guildId: '111111111111111111', idempotencyKey: 'k' }],
    ['missing idempotency key', { guildId: '111111111111111111', reminderId: REMINDER }],
    [
      'no changed field',
      { guildId: '111111111111111111', reminderId: REMINDER, idempotencyKey: 'k' },
    ],
    [
      'both at and recurrence',
      { ...editArgs(), at: FUTURE_ISO, recurrence: recurrenceDaily(), content: undefined },
    ],
    ['unparseable at', { ...editArgs(), at: 'soon-ish', content: undefined }],
    ['whitespace-only content', { ...editArgs(), content: '  ' }],
    [
      'twenty-six ping users',
      {
        ...editArgs(),
        content: undefined,
        pingUsers: Array.from({ length: 26 }, () => '377777777777777777'),
      },
    ],
  ])('%s is the argument fault and the port was never called', async (_label, args) => {
    const port = fakeSchedulePort();
    const outcome = await editScheduledText(principalWith([GUILD_A]), port, args);
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls['editScheduled']).toBe(0);
  });

  it('an edit carrying only pings reaches the port', async () => {
    let seen: Parameters<McpSchedulePort['editScheduled']>[1] | undefined;
    const port = fakeSchedulePort({
      editScheduled: (_guildId, input) => {
        seen = input;
        return Promise.resolve({ status: 'done', actionId: ACTION, reminderId: REMINDER });
      },
    });
    const outcome = await editScheduledText(principalWith([GUILD_A]), port, {
      guildId: '111111111111111111',
      reminderId: REMINDER,
      pingUsers: ['377777777777777777'],
      idempotencyKey: 'k-pings',
    });
    expect(outcome.ok).toBe(true);
    expect(seen?.pingUsers).toEqual(['377777777777777777']);
    expect(seen?.content).toBeUndefined();
  });

  it.each([
    ['empty reminder id', { ...cancelArgs(), reminderId: '' }],
    ['missing reminder id', { guildId: '111111111111111111', idempotencyKey: 'k' }],
    ['missing idempotency key', { guildId: '111111111111111111', reminderId: REMINDER }],
  ])('cancel %s is the argument fault and the port was never called', async (_label, args) => {
    const port = fakeSchedulePort();
    const outcome = await cancelScheduledText(principalWith([GUILD_A]), port, args);
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls['cancelScheduled']).toBe(0);
  });
});

describe('list_scheduled argument boundary', () => {
  it.each([
    ['limit zero', { limit: 0 }],
    ['limit over 100', { limit: 101 }],
    ['bad status', { status: 'mailed' }],
    ['non-integer limit', { limit: 2.5 }],
  ])('%s is the argument fault and the port was never called', async (_label, over) => {
    const port = fakeSchedulePort();
    const outcome = listScheduledText(principalWith([GUILD_A]), port, {
      ...listArgs(),
      ...over,
    });
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls['listScheduled']).toBe(0);
  });

  it('status and limit reach the port', async () => {
    let seen: Parameters<McpSchedulePort['listScheduled']>[1] | undefined;
    const port = fakeSchedulePort({
      listScheduled: (_guildId, input) => {
        seen = input;
        return [];
      },
    });
    const outcome = listScheduledText(principalWith([GUILD_A]), port, {
      ...listArgs(),
      status: 'scheduled',
      limit: 5,
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual({ status: 'scheduled', limit: 5 });
  });
});

describe('schedule refusal rendering', () => {
  const ALL_REFUSALS: readonly McpScheduleRefusal[] = [
    'private-thread',
    'channel-not-allowlisted',
    'channel-not-in-guild',
    'ambiguous-channel',
    'bot-lacks-permission',
    'role-unknown',
    'role-dangerous',
    'role-managed-or-everyone',
    'role-above-bot',
    'role-not-allowlisted',
    'user-not-member',
    'past-due',
    'reminder-not-found',
    'reminder-not-editable',
    'killswitch',
    'breaker-open',
    'rate-cap',
    'duplicate-key-different-content',
    'duplicate-content-recently',
  ];

  it('every refusal is an error with distinct, non-empty text per tool', async () => {
    const calls: Array<{
      readonly run: () => Promise<{ readonly ok: boolean }>;
      readonly name: string;
    }> = [];
    for (const reason of ALL_REFUSALS) {
      const port = fakeSchedulePort({
        scheduleMessage: () => Promise.resolve({ status: 'refused', reason, detail: 'probe' }),
        editScheduled: () => Promise.resolve({ status: 'refused', reason, detail: 'probe' }),
        cancelScheduled: () => Promise.resolve({ status: 'refused', reason, detail: 'probe' }),
      });
      calls.push({
        run: () => scheduleMessageText(principalWith([GUILD_A]), port, scheduleArgs()),
        name: `schedule:${reason}`,
      });
      calls.push({
        run: () => editScheduledText(principalWith([GUILD_A]), port, editArgs()),
        name: `edit:${reason}`,
      });
      calls.push({
        run: () => cancelScheduledText(principalWith([GUILD_A]), port, cancelArgs()),
        name: `cancel:${reason}`,
      });
    }
    const byTool = new Map<string, string[]>();
    for (const call of calls) {
      const [tool] = call.name.split(':');
      const message = messageOf(await call.run());
      expect(message.length).toBeGreaterThan(0);
      byTool.set(tool ?? '?', [...(byTool.get(tool ?? '?') ?? []), message]);
    }
    // No two reasons share a string within one tool, pinned the way the
    // older write tools pin it. Across tools the shared refusal vocabulary
    // may read the same — the verbs differ instead (pinned below).
    for (const messages of byTool.values()) {
      expect(new Set(messages).size).toBe(ALL_REFUSALS.length);
    }
  });

  it.each([
    ['private-thread', 'private thread'],
    ['channel-not-allowlisted', 'allowlist'],
    ['channel-not-in-guild', 'will not help'],
    ['ambiguous-channel', 'instead of a name'],
    ['bot-lacks-permission', 'permission'],
    ['role-unknown', 'No role'],
    ['role-dangerous', 'never allows'],
    ['role-managed-or-everyone', 'never be pinged'],
    ['role-above-bot', 'highest role'],
    ['role-not-allowlisted', 'allowlist'],
    ['user-not-member', 'not a member'],
    ['past-due', 'past'],
    ['reminder-not-found', 'No scheduled message'],
    ['reminder-not-editable', 'no longer scheduled'],
    ['killswitch', 'kill switch'],
    ['breaker-open', 'breaker'],
    ['rate-cap', 'hour'],
    ['duplicate-key-different-content', 'different'],
    ['duplicate-content-recently', 'minute'],
  ])('%s tells the operator what to do next (%s)', async (reason, phrase) => {
    const port = fakeSchedulePort({
      scheduleMessage: () =>
        Promise.resolve({ status: 'refused', reason: reason as McpScheduleRefusal }),
    });
    const outcome = await scheduleMessageText(principalWith([GUILD_A]), port, scheduleArgs());
    expect(messageOf(outcome)).toContain(phrase);
  });

  it('the edit and cancel verbs differ for the same reminder refusal', async () => {
    const port = fakeSchedulePort({
      editScheduled: () => Promise.resolve({ status: 'refused', reason: 'reminder-not-found' }),
      cancelScheduled: () => Promise.resolve({ status: 'refused', reason: 'reminder-not-found' }),
    });
    const edited = messageOf(await editScheduledText(principalWith([GUILD_A]), port, editArgs()));
    const cancelled = messageOf(
      await cancelScheduledText(principalWith([GUILD_A]), port, cancelArgs()),
    );
    expect(edited).not.toBe(cancelled);
    expect(edited).toContain('edit');
    expect(cancelled).toContain('cancel');
  });

  it('a past-due recurrence says the series ended', async () => {
    const port = fakeSchedulePort({
      scheduleMessage: () =>
        Promise.resolve({ status: 'refused', reason: 'past-due', detail: 'recurrence-ended' }),
    });
    const outcome = await scheduleMessageText(principalWith([GUILD_A]), port, scheduleArgs());
    expect(messageOf(outcome)).toContain('already ended');
  });
});

describe('schedule happy path', () => {
  it('scheduled names the reminder id, the channel and the action id, never the content', async () => {
    const port = fakeSchedulePort();
    const text = textOf(await scheduleMessageText(principalWith([GUILD_A]), port, scheduleArgs()));
    expect(text).toContain(REMINDER);
    expect(text).toContain(CHANNEL);
    expect(text).toContain(ACTION);
    expect(text).not.toContain('game night friday');
  });

  it('scheduling says it cannot be undone and names the cancelling tool', async () => {
    const port = fakeSchedulePort();
    const text = textOf(await scheduleMessageText(principalWith([GUILD_A]), port, scheduleArgs()));
    expect(text).toContain(CANCEL_SCHEDULED_TOOL_NAME);
    expect(text).toContain('cannot be undone');
  });

  it('edited keeps the previous values for undo; cancelled names undo_action', async () => {
    const port = fakeSchedulePort();
    const edited = textOf(await editScheduledText(principalWith([GUILD_A]), port, editArgs()));
    expect(edited).toContain(REMINDER);
    expect(edited).toContain(ACTION);
    expect(edited).toContain('undo');
    const cancelled = textOf(
      await cancelScheduledText(principalWith([GUILD_A]), port, cancelArgs()),
    );
    expect(cancelled).toContain(REMINDER);
    expect(cancelled).toContain(ACTION);
    expect(cancelled).toContain('undo_action');
  });

  it('dry-run says plainly that nothing was stored', async () => {
    const port = fakeSchedulePort({
      scheduleMessage: () => Promise.resolve({ status: 'dry-run', actionId: ACTION }),
      editScheduled: () => Promise.resolve({ status: 'dry-run', actionId: ACTION }),
      cancelScheduled: () => Promise.resolve({ status: 'dry-run', actionId: ACTION }),
    });
    for (const outcome of [
      await scheduleMessageText(principalWith([GUILD_A]), port, scheduleArgs()),
      await editScheduledText(principalWith([GUILD_A]), port, editArgs()),
      await cancelScheduledText(principalWith([GUILD_A]), port, cancelArgs()),
    ]) {
      const text = textOf(outcome);
      expect(text).toContain('ry run');
      expect(text).toContain(ACTION);
      expect(text.toLowerCase()).not.toContain('sent');
    }
  });

  it('replayed points at list_scheduled instead of claiming a send', async () => {
    const port = fakeSchedulePort({
      scheduleMessage: () => Promise.resolve({ status: 'replayed', actionId: ACTION }),
    });
    const outcome = await scheduleMessageText(principalWith([GUILD_A]), port, scheduleArgs());
    expect(outcome.ok).toBe(true);
    const text = textOf(outcome);
    expect(text).toContain(ACTION);
    expect(text).toContain(LIST_SCHEDULED_TOOL_NAME);
    expect(text.toLowerCase()).not.toContain('sent');
  });

  it('failed says the result is unknown and reuses the key', async () => {
    const port = fakeSchedulePort({
      scheduleMessage: () => Promise.resolve({ status: 'failed' }),
    });
    const outcome = await scheduleMessageText(principalWith([GUILD_A]), port, scheduleArgs());
    expect(outcome.ok).toBe(false);
    const message = messageOf(outcome);
    expect(message).toContain('may or may not have been stored');
    expect(message).toContain('same idempotency key');
  });

  it('a throwing port is the shared refusal, never an exception', async () => {
    const port: McpSchedulePort = {
      scheduleMessage: () => Promise.reject(new Error('boom')),
      listScheduled: () => {
        throw new Error('boom');
      },
      editScheduled: () => Promise.reject(new Error('boom')),
      cancelScheduled: () => Promise.reject(new Error('boom')),
    };
    expect(await scheduleMessageText(principalWith([GUILD_A]), port, scheduleArgs())).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
    expect(await editScheduledText(principalWith([GUILD_A]), port, editArgs())).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
    expect(await cancelScheduledText(principalWith([GUILD_A]), port, cancelArgs())).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
    expect(listScheduledText(principalWith([GUILD_A]), port, listArgs())).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
  });
});

describe('list_scheduled rendering', () => {
  const view = (over: Partial<McpScheduledView> = {}): McpScheduledView => ({
    reminderId: REMINDER,
    channelId: CHANNEL,
    dueAt: FUTURE_MS,
    recurrence: 'one-shot',
    status: 'scheduled',
    preview: 'game night friday',
    ...over,
  });

  it('names ids, the due time, the recurrence, the status and the channel', () => {
    const port = fakeSchedulePort({ listScheduled: () => [view()] });
    const outcome = listScheduledText(principalWith([GUILD_A]), port, listArgs());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain(REMINDER);
    expect(outcome.text).toContain(CHANNEL);
    expect(outcome.text).toContain(new Date(FUTURE_MS).toISOString());
    expect(outcome.text).toContain('one-shot');
    expect(outcome.text).toContain('scheduled');
    expect(outcome.read).toEqual({
      kind: 'content',
      action: MCP_READ_LIST_SCHEDULED,
      guildId: GUILD_A,
      subjectType: 'guild',
      subjectId: undefined,
      resultCount: 1,
    });
  });

  it('frames the preview as evidence and never leaks beyond 100 characters', () => {
    const port = fakeSchedulePort({
      listScheduled: () => [view({ preview: 'p'.repeat(SCHEDULE_PREVIEW_MAX) })],
    });
    const outcome = listScheduledText(principalWith([GUILD_A]), port, listArgs());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain(EVIDENCE_PREAMBLE);
    expect(outcome.text).toContain(EVIDENCE_OPEN);
    expect(outcome.text).toContain(EVIDENCE_CLOSE);
    expect(outcome.text).toContain('p'.repeat(SCHEDULE_PREVIEW_MAX));
    // A port that ignored the cap would still be caught here: the tool never
    // renders more than the cap of stored text per row.
    const longPort = fakeSchedulePort({
      listScheduled: () => [view({ preview: 'q'.repeat(SCHEDULE_PREVIEW_MAX + 50) })],
    });
    const longOutcome = listScheduledText(principalWith([GUILD_A]), longPort, listArgs());
    expect(longOutcome.ok).toBe(true);
    if (!longOutcome.ok) return;
    expect(longOutcome.text).not.toContain('q'.repeat(SCHEDULE_PREVIEW_MAX + 1));
  });

  it('an empty outbox says so and audits zero rows', () => {
    const port = fakeSchedulePort({ listScheduled: () => [] });
    const outcome = listScheduledText(principalWith([GUILD_A]), port, listArgs());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain('No scheduled messages');
    expect(outcome.read).toMatchObject({ resultCount: 0 });
  });
});

describe('schedule undo texts', () => {
  it('an expired cancel undo refuses as expired with the due time', async () => {
    const port: McpActionsPort = {
      undo: () =>
        Promise.resolve({
          status: 'refused',
          reason: 'expired',
          detail: '2031-05-06T12:00:00.000Z',
        }),
      list: () => [],
    };
    const outcome = await undoActionText(principalWith([GUILD_A]), port, {
      guildId: '111111111111111111',
      actionId: ACTION,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('expired');
    expect(outcome.message).toContain('2031-05-06T12:00:00.000Z');
  });
});

describe('schedule tool descriptions', () => {
  it('tells the model the exclusivity, the undo story and the retry rule', () => {
    expect(SCHEDULE_MESSAGE_TOOL_DESCRIPTION).toContain('idempotencyKey');
    expect(SCHEDULE_MESSAGE_TOOL_DESCRIPTION).toContain('same value');
    expect(SCHEDULE_MESSAGE_TOOL_DESCRIPTION).toContain('dryRun');
    expect(SCHEDULE_MESSAGE_TOOL_DESCRIPTION).toContain('cannot be undone');
    expect(SCHEDULE_MESSAGE_TOOL_DESCRIPTION).toContain(CANCEL_SCHEDULED_TOOL_NAME);
    expect(SCHEDULE_MESSAGE_TOOL_DESCRIPTION).toContain('2000');
  });
});

describe('schedule.ts boundary (ADR 0044 §4, ruling M4-D14)', () => {
  it('goes through the port: no storage, http or discord.js import', () => {
    const source = readFileSync(new URL('./schedule.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('@bananasaurs/storage');
    expect(source).not.toContain('@bananasaurs/http');
    expect(source).not.toContain('discord.js');
  });
});

describe('tool names', () => {
  it('are the four contracted names', () => {
    expect(SCHEDULE_MESSAGE_TOOL_NAME).toBe('schedule_message');
    expect(LIST_SCHEDULED_TOOL_NAME).toBe('list_scheduled');
    expect(EDIT_SCHEDULED_TOOL_NAME).toBe('edit_scheduled');
    expect(CANCEL_SCHEDULED_TOOL_NAME).toBe('cancel_scheduled');
  });
});
