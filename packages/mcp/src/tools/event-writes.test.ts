import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseGuildId, type GuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, INVALID_ARGUMENTS_MESSAGE, type McpPrincipal } from '../scope.js';
import { createMcpServer } from '../server.js';
import type { McpHealthPort } from './health.js';
import type { McpArchivePort } from './archive.js';
import type { McpGuildPort } from './guild.js';
import type { McpRecordsPort } from './records.js';
import type { McpJobsPort } from './jobs.js';
import type { McpMembersPort } from './members.js';
import type { McpContextPort } from './context.js';
import type { McpResourcesPort } from './resources.js';
import type { McpThreadsPort } from './threads.js';
import type { McpSendPort } from './send.js';
import type { McpThreadWritesPort } from './thread-writes.js';
import type { McpMessageWritesPort } from './message-writes.js';
import type { McpReadAuditPort } from '../read-audit.js';
import {
  CANCEL_EVENT_TOOL_NAME,
  CREATE_EVENT_TOOL_NAME,
  CREATE_POLL_TOOL_NAME,
  EDIT_EVENT_TOOL_NAME,
  cancelEventText,
  createEventText,
  createPollText,
  editEventText,
  type McpEventWriteOutcome,
  type McpEventWriteRefusal,
  type McpEventWritesPort,
} from './event-writes.js';

/**
 * Tool layer: the four event/poll write tools against a fake
 * `McpEventWritesPort` — the same seam the daemon's gateway wiring
 * implements, so the guard behaviour pinned here (guild gate, argument
 * boundary, refusal rendering) holds whichever implementation sits behind
 * it.
 *
 * Scope filtering is pinned through a real MCP round-trip at the bottom: a
 * read-only token must not see any of the four in `tools/list` at all, and
 * a send-only token must see them alongside the thirteen older send tools.
 */

/** ADR 0050: this file does not exercise read logging; the server requires the port. */
const noopReadAudit: McpReadAuditPort = {
  auditContentRead: () => undefined,
  logStructuralRead: () => undefined,
};

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL = '333333333333333333';
const EVENT = '444444444444444444';
const MESSAGE = '455555555555555555';
const ACTION = 'act-00000000000000000000000001';
const FUTURE_START = '2030-06-01T18:00:00.000Z';
const FUTURE_END = '2030-06-01T20:00:00.000Z';
const PAST_START = '2020-01-01T00:00:00.000Z';

const principalWith = (
  guilds: readonly GuildId[],
  scopes: readonly string[] = ['bananasaurs:send'],
): McpPrincipal => ({
  accountId: 'acct_00000000000000000000000000000000',
  reachableGuilds: guilds,
  scopes,
});

const createArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  name: 'Build night',
  description: 'Monthly build night',
  startAt: FUTURE_START,
  endAt: FUTURE_END,
  location: 'voice',
  channel: CHANNEL,
  idempotencyKey: 'event-k1',
  ...over,
});

const createExternalArgs = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  createArgs({
    location: 'external',
    channel: undefined,
    place: 'Community hall',
    ...over,
  });

const editArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  eventId: EVENT,
  name: 'Build night 2',
  idempotencyKey: 'event-edit-k1',
  ...over,
});

const cancelArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  eventId: EVENT,
  idempotencyKey: 'event-cancel-k1',
  ...over,
});

const pollArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  channelId: CHANNEL,
  question: 'When should we meet?',
  answers: ['Friday', 'Saturday'],
  durationHours: 24,
  idempotencyKey: 'poll-k1',
  ...over,
});

/** Fake event-writes port: every call recorded, the outcome scripted per test. */
const fakeEventPort = (
  outcome: McpEventWriteOutcome,
): McpEventWritesPort & { readonly calls: Record<string, number>; readonly lastInput: unknown } => {
  const calls: Record<string, number> = {
    createEvent: 0,
    editEvent: 0,
    cancelEvent: 0,
    createPoll: 0,
  };
  let lastInput: unknown;
  const record = (method: string, input: unknown): Promise<McpEventWriteOutcome> => {
    calls[method] = (calls[method] ?? 0) + 1;
    lastInput = input;
    return Promise.resolve(outcome);
  };
  return {
    get calls(): Record<string, number> {
      return calls;
    },
    get lastInput(): unknown {
      return lastInput;
    },
    createEvent: (_guildId, input) => record('createEvent', input),
    editEvent: (_guildId, input) => record('editEvent', input),
    cancelEvent: (_guildId, input) => record('cancelEvent', input),
    createPoll: (_guildId, input) => record('createPoll', input),
  };
};

const totalCalls = (port: { readonly calls: Record<string, number> }): number =>
  Object.values(port.calls).reduce((sum, n) => sum + n, 0);

const textOf = (outcome: { readonly ok: boolean; readonly text?: string }): string => {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error('expected ok:true');
  return (outcome as { readonly text: string }).text;
};

const messageOf = (outcome: { readonly ok: boolean; readonly message?: string }): string => {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('expected ok:false');
  return (outcome as { readonly message: string }).message;
};

const handlers = [
  ['create_event', createEventText, createArgs] as const,
  ['edit_event', editEventText, editArgs] as const,
  ['cancel_event', cancelEventText, cancelArgs] as const,
  ['create_poll', createPollText, pollArgs] as const,
];

const withoutKey = (args: Record<string, unknown>): Record<string, unknown> => {
  const next = { ...args };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) delete next[key];
  }
  return next;
};

describe('event-write guild gate (CLAUDE.md rule 2)', () => {
  it.each(handlers)(
    '%s refuses an unreachable guild with the shared refusal',
    async (_name, handler, args) => {
      const port = fakeEventPort({ status: 'done', actionId: ACTION, eventId: EVENT });
      const outcome = await handler(principalWith([GUILD_A]), port, {
        ...args(),
        guildId: '222222222222222222',
      });
      expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
      expect(totalCalls(port)).toBe(0);
    },
  );

  it.each(handlers)('%s refuses a malformed guild id identically', async (_name, handler, args) => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION, eventId: EVENT });
    const outcome = await handler(principalWith([GUILD_A]), port, {
      ...args(),
      guildId: 'not-a-snowflake',
    });
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(totalCalls(port)).toBe(0);
  });

  it.each(handlers)(
    '%s refuses an empty reachable set identically',
    async (_name, handler, args) => {
      const port = fakeEventPort({ status: 'done', actionId: ACTION, eventId: EVENT });
      const outcome = await handler(principalWith([]), port, args());
      expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
      expect(totalCalls(port)).toBe(0);
    },
  );

  it('a two-guild principal calling the other guild is refused without a port call', async () => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION, eventId: EVENT });
    const outcome = await createEventText(principalWith([GUILD_B]), port, createArgs());
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(totalCalls(port)).toBe(0);
  });
});

describe('create_event argument boundary (hard rule 3)', () => {
  it.each([
    ['name over 100 characters', { name: 'n'.repeat(101) }],
    ['empty name', { name: '' }],
    ['whitespace-only name', { name: '   ' }],
    ['description over 1000 characters', { description: 'd'.repeat(1001) }],
    ['empty description', { description: '' }],
    ['startAt in the past', { startAt: PAST_START }],
    ['startAt unparsable', { startAt: 'next Friday' }],
    ['endAt unparsable', { endAt: 'sometime' }],
    ['endAt before startAt', { endAt: '2030-05-01T20:00:00.000Z' }],
    ['endAt equal to startAt', { endAt: FUTURE_START }],
    ['bad location', { location: 'announcement' }],
    ['voice without a channel', { channel: undefined }],
    ['voice with a place', { place: 'Somewhere' }],
    ['stage without a channel', { location: 'stage', channel: undefined }],
    ['external without a place', { location: 'external', channel: undefined }],
    ['external with a channel', { location: 'external', place: 'Hall' }],
    ['external with a blank place', { location: 'external', channel: undefined, place: '  ' }],
    [
      'external without endAt',
      { location: 'external', channel: undefined, place: 'Hall', endAt: undefined },
    ],
    ['malformed channel id', { channel: 'not-a-channel' }],
    ['missing idempotency key', { idempotencyKey: undefined }],
    ['missing guild id', { guildId: undefined }],
  ])('%s is the argument fault and the port was never called', async (_label, over) => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION, eventId: EVENT });
    const outcome = await createEventText(
      principalWith([GUILD_A]),
      port,
      withoutKey(createArgs(over)),
    );
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(totalCalls(port)).toBe(0);
  });

  it('a stage event with a channel reaches the port', async () => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION, eventId: EVENT });
    const outcome = await createEventText(
      principalWith([GUILD_A]),
      port,
      createArgs({ location: 'stage' }),
    );
    expect(outcome.ok).toBe(true);
    expect(totalCalls(port)).toBe(1);
  });

  it('times leave as epoch ms and text leaves trimmed', async () => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION, eventId: EVENT });
    const outcome = await createEventText(
      principalWith([GUILD_A]),
      port,
      createArgs({ name: '  Build night  ', description: '  Monthly  ' }),
    );
    expect(outcome.ok).toBe(true);
    expect(port.lastInput).toMatchObject({
      name: 'Build night',
      description: 'Monthly',
      startAt: Date.parse(FUTURE_START),
      endAt: Date.parse(FUTURE_END),
      location: { kind: 'voice', channelId: CHANNEL },
    });
  });
});

describe('edit_event argument boundary (hard rule 3)', () => {
  it.each([
    ['no field to change', {}],
    ['channel and place together', { channel: CHANNEL, place: 'Hall' }],
    ['name over 100 characters', { name: 'n'.repeat(101) }],
    ['empty name', { name: '' }],
    ['description over 1000 characters', { description: 'd'.repeat(1001) }],
    ['startAt in the past', { startAt: PAST_START }],
    ['startAt unparsable', { startAt: 'yesterday' }],
    ['endAt unparsable', { endAt: 'tomorrow' }],
    ['endAt before startAt', { startAt: FUTURE_START, endAt: PAST_START }],
    ['malformed event id', { eventId: 'not-an-event' }],
    ['malformed channel id', { name: undefined, channel: 'nope' }],
    ['blank place', { name: undefined, place: '  ' }],
    ['missing idempotency key', { idempotencyKey: undefined }],
  ])('%s is the argument fault and the port was never called', async (_label, over) => {
    const base = { ...editArgs(), name: undefined };
    const merged: Record<string, unknown> = { ...base, ...over };
    const cleaned = withoutKey(merged);
    // `no field to change` must keep only the envelope: drop the default name.
    const port = fakeEventPort({ status: 'done', actionId: ACTION });
    const outcome = await editEventText(principalWith([GUILD_A]), port, cleaned);
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(totalCalls(port)).toBe(0);
  });

  it('a move names only the channel; the daemon resolves the kind live', async () => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION });
    const outcome = await editEventText(
      principalWith([GUILD_A]),
      port,
      withoutKey({ ...editArgs(), name: undefined, channel: CHANNEL }),
    );
    expect(outcome.ok).toBe(true);
    expect(port.lastInput).toMatchObject({ location: { channelId: CHANNEL } });
  });
});

describe('cancel_event argument boundary (hard rule 3)', () => {
  it.each([
    ['malformed event id', { eventId: 'not-an-event' }],
    ['missing idempotency key', { idempotencyKey: undefined }],
    ['missing guild id', { guildId: undefined }],
  ])('%s is the argument fault and the port was never called', async (_label, over) => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION });
    const outcome = await cancelEventText(
      principalWith([GUILD_A]),
      port,
      withoutKey(cancelArgs(over)),
    );
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(totalCalls(port)).toBe(0);
  });
});

describe('create_poll argument boundary (hard rule 3)', () => {
  it.each([
    ['empty question', { question: '' }],
    ['whitespace-only question', { question: '   ' }],
    ['question over 300 characters', { question: 'q'.repeat(301) }],
    ['one answer', { answers: ['Friday'] }],
    ['eleven answers', { answers: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'] }],
    ['empty answer', { answers: ['Friday', ''] }],
    ['whitespace-only answer', { answers: ['Friday', '   '] }],
    ['answer over 55 characters', { answers: ['Friday', 'a'.repeat(56)] }],
    ['zero duration', { durationHours: 0 }],
    ['duration over 168', { durationHours: 169 }],
    ['fractional duration', { durationHours: 1.5 }],
    ['duration as a string', { durationHours: '24' }],
    ['multiselect as a string', { allowMultiselect: 'yes' }],
    ['malformed channel id', { channelId: 'not-a-channel' }],
    ['missing idempotency key', { idempotencyKey: undefined }],
    ['missing guild id', { guildId: undefined }],
  ])('%s is the argument fault and the port was never called', async (_label, over) => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION, messageId: MESSAGE });
    const outcome = await createPollText(principalWith([GUILD_A]), port, pollArgs(over));
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(totalCalls(port)).toBe(0);
  });

  it('multiselect defaults to false and text leaves trimmed', async () => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION, messageId: MESSAGE });
    const outcome = await createPollText(
      principalWith([GUILD_A]),
      port,
      pollArgs({ question: '  When?  ', answers: ['  Friday  ', 'Saturday'] }),
    );
    expect(outcome.ok).toBe(true);
    expect(port.lastInput).toMatchObject({
      question: 'When?',
      answers: ['Friday', 'Saturday'],
      allowMultiselect: false,
    });
  });
});

describe('event-write ids are snowflakes before any port call (REST path safety)', () => {
  // An id goes into a REST route path unencoded, and a URL resolves `..`
  // segments: a traversal id must die at the argument boundary, never reach
  // the port (whole-branch review, slice 3).
  it.each([
    ['create_event channel', createEventText, () => createArgs()],
    ['edit_event eventId', editEventText, () => editArgs()],
    [
      'edit_event channel',
      editEventText,
      () => ({ ...editArgs(), name: undefined, channel: CHANNEL }),
    ],
    ['cancel_event eventId', cancelEventText, () => cancelArgs()],
    ['create_poll channel', createPollText, () => pollArgs()],
  ])('%s refuses a path-traversal id', async (_label, handler, valid) => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION, eventId: EVENT });
    const base = valid() as Record<string, unknown>;
    const key = 'channel' in base ? 'channel' : 'channelId' in base ? 'channelId' : 'eventId';
    const outcome = await handler(principalWith([GUILD_A]), port, {
      ...base,
      [key]: '../../../../guilds/111111111111111111/bans/222222222222222222',
    });
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(totalCalls(port)).toBe(0);
  });
});

describe('external events need an end time before the port', () => {
  it('an external event without endAt is refused with no port call', async () => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION, eventId: EVENT });
    const outcome = await createEventText(
      principalWith([GUILD_A]),
      port,
      withoutKey(createExternalArgs({ endAt: undefined })),
    );
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(totalCalls(port)).toBe(0);
  });

  it('an external event with endAt reaches the port with the venue', async () => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION, eventId: EVENT });
    const outcome = await createEventText(principalWith([GUILD_A]), port, createExternalArgs());
    expect(outcome.ok).toBe(true);
    expect(port.lastInput).toMatchObject({
      location: { kind: 'external', place: 'Community hall' },
    });
  });
});

describe('event-write refusal rendering', () => {
  const cases: ReadonlyArray<readonly [McpEventWriteRefusal, string]> = [
    ['channel-not-allowlisted', 'not on the send allowlist'],
    ['channel-not-in-guild', 'not a channel this guild'],
    ['private-thread', 'private thread'],
    ['bot-lacks-permission', 'lacks the'],
    ['event-not-found', 'was not found'],
    ['not-voice-or-stage', 'not a voice or stage channel'],
    ['killswitch', 'kill switch'],
    ['breaker-open', 'circuit breaker'],
    ['rate-cap', 'budget'],
    ['duplicate-key-different-content', 'different write'],
    ['duplicate-content-recently', 'already ran'],
  ];

  it.each(handlers)(
    '%s renders every refusal distinctly, with ids and no content',
    async (_name, handler, args) => {
      const texts = new Map<McpEventWriteRefusal, string>();
      for (const [reason] of cases) {
        const port = fakeEventPort({ status: 'refused', reason, detail: 'ManageEvents' });
        const outcome = await handler(principalWith([GUILD_A]), port, args());
        const text = messageOf(outcome);
        expect(text).toContain('111111111111111111');
        texts.set(reason, text);
      }
      // No two reasons share a string.
      expect(new Set(texts.values()).size).toBe(cases.length);
      for (const [reason, marker] of cases) {
        expect(texts.get(reason)).toContain(marker);
      }
    },
  );

  it('a channel permission refusal names the channel; an external one names the guild', async () => {
    const refused = {
      status: 'refused',
      reason: 'bot-lacks-permission',
      detail: 'ManageEvents',
    } as const;
    const channelText = messageOf(
      await createEventText(principalWith([GUILD_A]), fakeEventPort(refused), createArgs()),
    );
    expect(channelText).toContain(CHANNEL);
    expect(channelText).toContain('ManageEvents');
    const externalText = messageOf(
      await createEventText(principalWith([GUILD_A]), fakeEventPort(refused), createExternalArgs()),
    );
    expect(externalText).not.toContain(CHANNEL);
    expect(externalText).toContain('in guild 111111111111111111');
    expect(externalText).toContain('ManageEvents');
    expect(externalText).not.toBe(channelText);
  });

  it('a poll rate-cap names the message budget; an event rate-cap names the structure budget', async () => {
    const refused = { status: 'refused', reason: 'rate-cap' } as const;
    const pollText = messageOf(
      await createPollText(principalWith([GUILD_A]), fakeEventPort(refused), pollArgs()),
    );
    expect(pollText).toContain('message budget of 300');
    const eventText = messageOf(
      await createEventText(principalWith([GUILD_A]), fakeEventPort(refused), createArgs()),
    );
    expect(eventText).toContain('structure budget of 100');
  });
});

describe('event-write outcomes', () => {
  it('create names the event and points at cancel_event', async () => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION, eventId: EVENT });
    const text = textOf(await createEventText(principalWith([GUILD_A]), port, createArgs()));
    expect(text).toContain(EVENT);
    expect(text).toContain(ACTION);
    expect(text).toContain(CANCEL_EVENT_TOOL_NAME);
  });

  it('edit names the event and keeps the previous values for undo', async () => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION });
    const text = textOf(await editEventText(principalWith([GUILD_A]), port, editArgs()));
    expect(text).toContain(EVENT);
    expect(text).toContain(ACTION);
    expect(text).toContain('undo');
  });

  it('cancel says the event cannot be un-cancelled', async () => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION });
    const text = textOf(await cancelEventText(principalWith([GUILD_A]), port, cancelArgs()));
    expect(text).toContain(EVENT);
    expect(text).toContain(ACTION);
    expect(text).toContain('cannot be un-cancelled');
  });

  it('poll names the message and the channel', async () => {
    const port = fakeEventPort({ status: 'done', actionId: ACTION, messageId: MESSAGE });
    const text = textOf(await createPollText(principalWith([GUILD_A]), port, pollArgs()));
    expect(text).toContain(MESSAGE);
    expect(text).toContain(CHANNEL);
    expect(text).toContain(ACTION);
  });

  it('dry-run records without calling Discord content-free', async () => {
    const port = fakeEventPort({ status: 'dry-run', actionId: ACTION });
    const text = textOf(
      await createEventText(principalWith([GUILD_A]), port, { ...createArgs(), dryRun: true }),
    );
    expect(text).toContain('Dry run');
    expect(text).toContain(ACTION);
    expect(port.calls['createEvent']).toBe(1);
  });

  it('replayed answers without a new write', async () => {
    const port = fakeEventPort({ status: 'replayed', actionId: ACTION });
    const text = textOf(await editEventText(principalWith([GUILD_A]), port, editArgs()));
    expect(text).toContain('Already recorded under this idempotency key');
    expect(text).toContain(ACTION);
  });

  it('a poll replay names the message like any send', async () => {
    const port = fakeEventPort({ status: 'replayed', actionId: ACTION, messageId: MESSAGE });
    const text = textOf(await createPollText(principalWith([GUILD_A]), port, pollArgs()));
    expect(text).toContain('Already sent under this idempotency key');
    expect(text).toContain(MESSAGE);
  });

  it('failed reports an unknown result with the same key to retry on', async () => {
    const port = fakeEventPort({ status: 'failed' });
    const text = messageOf(await cancelEventText(principalWith([GUILD_A]), port, cancelArgs()));
    expect(text).toContain('same idempotency key');
  });

  it.each(handlers)(
    '%s never throws: a port fault is the shared refusal',
    async (_name, handler, args) => {
      const failing: McpEventWritesPort = {
        createEvent: () => Promise.reject(new Error('discord is down')),
        editEvent: () => Promise.reject(new Error('discord is down')),
        cancelEvent: () => Promise.reject(new Error('discord is down')),
        createPoll: () => Promise.reject(new Error('discord is down')),
      };
      const outcome = await handler(principalWith([GUILD_A]), failing, args());
      expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    },
  );
});

/** Minimal ports: this block pins registration, never the tools themselves. */
const stubHealth = (): McpHealthPort => ({
  startedAtMs: 1_700_000_000_000,
  readonly: false,
  env: 'test',
  gateway: () => ({ connected: true, pingMs: 42, guildCount: 1 }),
  now: () => 1_700_000_000_000,
  guilds: () => [],
});
const stubArchive = (): McpArchivePort => ({
  now: () => 1_700_000_000_000,
  listArchiveChannelIds: () => [],
  searchMessages: () => ({ total: 0, hits: [] }),
  findMessage: () => undefined,
  listChannelHistory: () => [],
  listMessagesSince: () => [],
  listUnansweredRoleMentions: () => [],
  messageMeta: () => Promise.resolve(undefined),
  botUserId: () => undefined,
});
const stubGuild = (): McpGuildPort => ({
  listChannels: () => [],
  listThreads: async () => [],
  listRoles: () => [],
  listMembers: () => Promise.resolve({ members: [], nextCursor: undefined }),
  memberCount: () => 0,
});
const stubRecords = (): McpRecordsPort => ({
  listRecentCases: () => [],
  findCase: () => undefined,
  listCaseEvents: () => [],
  tailAudit: () => [],
  listRules: () => [],
  listPanels: () => [],
});
const stubSend = (): McpSendPort => ({
  send: () => Promise.resolve({ status: 'sent', messageId: 'mid-test', actionId: 'act-test' }),
});
const stubThreadWrites = (): McpThreadWritesPort => ({
  createThread: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  addThreadMembers: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  removeThreadMembers: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  createForumPost: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  setThreadState: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
});
const stubMessageWrites = (): McpMessageWritesPort => ({
  edit: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  delete: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  pin: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  unpin: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  addReaction: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  removeReaction: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
});
const stubEventWrites = (): McpEventWritesPort =>
  fakeEventPort({ status: 'done', actionId: 'act-test', eventId: 'evt-test' });
const stubJobs = (): McpJobsPort => ({
  listJobs: () => [],
  findJob: () => undefined,
});
const stubMembers = (): McpMembersPort => ({
  listAllMembers: () => Promise.resolve({ members: [], truncated: false }),
  lastMessageAt: () => new Map(),
  now: () => 1_700_000_000_000,
});
const stubContext = (): McpContextPort => ({
  serverCard: () => '',
  timeZone: 'America/Vancouver',
  now: () => 1_700_000_000_000,
  skills: () => [],
});
const stubResources = (): McpResourcesPort => ({
  listResources: () => [],
  searchChunks: () => [],
  resourceChunks: () => [],
});
const stubThreads = (): McpThreadsPort => ({
  archiveThread: () => [],
  threadInfo: () => Promise.resolve(undefined),
  privateThreadReadable: () => Promise.resolve(false),
  liveThreadMessages: () => Promise.resolve([]),
});

const connectPair = async (
  principal: McpPrincipal,
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const client = new Client({ name: 'mcp-event-writes-test-client', version: '0.0.0' });
  const server = createMcpServer({
    principal,
    health: stubHealth(),
    archive: stubArchive(),
    guild: stubGuild(),
    records: stubRecords(),
    send: stubSend(),
    messageWrites: stubMessageWrites(),
    threadWrites: stubThreadWrites(),
    eventWrites: stubEventWrites(),
    readAudit: noopReadAudit,
    jobs: stubJobs(),
    members: stubMembers(),
    context: stubContext(),
    resources: stubResources(),
    threads: stubThreads(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

describe('event-write scope filtering (ruling M4-D17)', () => {
  const SEND_TOOL_NAMES = [
    'send_message',
    CREATE_EVENT_TOOL_NAME,
    EDIT_EVENT_TOOL_NAME,
    CANCEL_EVENT_TOOL_NAME,
    CREATE_POLL_TOOL_NAME,
  ];

  it('a read-only token sees none of the four event tools', async () => {
    const { client, close } = await connectPair(principalWith([GUILD_A], ['bananasaurs:read']));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of SEND_TOOL_NAMES) expect(names).not.toContain(name);
    } finally {
      await close();
    }
  });

  it('a send-only token sees send_message and the four event tools', async () => {
    const { client, close } = await connectPair(principalWith([GUILD_A], ['bananasaurs:send']));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      // send_message, the six thread tools and the six message-write tools
      // share the scope; this file pins its own four.
      expect(names).toHaveLength(17);
      expect(names).toEqual(expect.arrayContaining(SEND_TOOL_NAMES));
    } finally {
      await close();
    }
  });
});
