import { readFileSync } from 'node:fs';
import type { McpReadAuditPort } from '../read-audit.js';

/** ADR 0050: this file does not exercise read logging; the server requires the port. */
const noopReadAudit: McpReadAuditPort = {
  auditContentRead: () => undefined,
  logStructuralRead: () => undefined,
};

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseGuildId, type GuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, INVALID_ARGUMENTS_MESSAGE, type McpPrincipal } from '../scope.js';
import { createMcpServer } from '../server.js';
import {
  SEND_CONTENT_MAX,
  SEND_MESSAGE_TOOL_DESCRIPTION,
  SEND_MESSAGE_TOOL_NAME,
  sendMessageText,
  type McpSendOutcome,
  type McpSendPort,
  type McpSendRefusal,
} from './send.js';
import type { McpHealthPort } from './health.js';
import type { McpArchivePort } from './archive.js';
import type { McpGuildPort } from './guild.js';
import type { McpRecordsPort } from './records.js';
import type { McpJobsPort } from './jobs.js';
import type { McpMembersPort } from './members.js';
import { GET_SERVER_CONTEXT_TOOL_NAME, type McpContextPort } from './context.js';
import {
  OPEN_RESOURCE_TOOL_NAME,
  SEARCH_RESOURCES_TOOL_NAME,
  type McpResourcesPort,
} from './resources.js';
import type { McpThreadsPort } from './threads.js';

/**
 * Task 3, tool layer: `send_message` against a fake `McpSendPort` — the same
 * seam the daemon's gateway wiring (Task 4) implements, so the guard
 * behaviour pinned here (guild gate, argument boundary, refusal rendering)
 * holds whichever implementation sits behind it.
 *
 * Scope filtering (ruling M4-D17) is pinned through a real MCP round-trip at
 * the bottom: a read-only token must not see `send_message` in `tools/list`
 * at all, and a send-only token must see nothing else.
 *
 * NOTE on ruling M5-D6 (DM before the allowlist): there is deliberately no
 * DM test here. A DM channel id is a well-formed snowflake — Discord encodes
 * no channel-type bits in the id, so no string shape distinguishes a DM
 * channel from a guild channel — and this package's only channel-type source
 * would be a port lookup the fixed `McpSendPort` shape does not provide.
 * Recognising a DM therefore needs a design ruling (new port method, or an
 * explicit decision that the gateway's allowlist refusal covers it), not a
 * guessed heuristic in this file. See the Task 3 report.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL = '333333333333333333';

const principalWith = (
  guilds: readonly GuildId[],
  scopes: readonly string[] = ['bananasaurs:send'],
): McpPrincipal => ({
  accountId: 'acct_00000000000000000000000000000000',
  reachableGuilds: guilds,
  scopes,
});

const validArgs = (): Record<string, unknown> => ({
  guildId: '111111111111111111',
  channelId: CHANNEL,
  content: 'hello, club',
  idempotencyKey: 'key-00000000000000000000000000000001',
});

/** Fake send port: every call recorded, the outcome scripted per test. */
const fakeSendPort = (outcome: McpSendOutcome): McpSendPort & { readonly calls: number } => {
  let calls = 0;
  return {
    get calls(): number {
      return calls;
    },
    send: (_guildId, _input) => {
      calls += 1;
      return Promise.resolve(outcome);
    },
  };
};

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

describe('send_message guild gate (CLAUDE.md rule 2)', () => {
  it.each([
    ['unreachable guild id', '222222222222222222', [GUILD_A]],
    ['malformed guild id', 'not-a-snowflake', [GUILD_A]],
    ['empty reachable set', '111111111111111111', []],
  ])('%s is the shared refusal and the port was never called', async (_label, guildId, guilds) => {
    const port = fakeSendPort({ status: 'sent', messageId: '444444444444444444' });
    const outcome = await sendMessageText(principalWith(guilds), port, {
      ...validArgs(),
      guildId,
    });
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(port.calls).toBe(0);
  });

  it('empty, malformed and unreachable refusals are indistinguishable', async () => {
    const port = fakeSendPort({ status: 'sent', messageId: '444444444444444444' });
    const outcomes = await Promise.all([
      sendMessageText(principalWith([]), port, validArgs()),
      sendMessageText(principalWith([GUILD_A]), port, {
        ...validArgs(),
        guildId: 'not-a-snowflake',
      }),
      sendMessageText(principalWith([GUILD_A]), port, {
        ...validArgs(),
        guildId: '222222222222222222',
      }),
    ]);
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    }
    expect(port.calls).toBe(0);
  });
});

describe('send_message argument boundary (hard rule 3)', () => {
  it.each([
    ['content over 2000 characters', { ...validArgs(), content: 'x'.repeat(SEND_CONTENT_MAX + 1) }],
    ['empty content', { ...validArgs(), content: '' }],
    [
      'missing idempotency key',
      { guildId: '111111111111111111', channelId: CHANNEL, content: 'hi' },
    ],
    ['malformed channel id', { ...validArgs(), channelId: 'not-a-channel' }],
    ['missing guild id', { channelId: CHANNEL, content: 'hi', idempotencyKey: 'k' }],
    ['non-string content', { ...validArgs(), content: 42 }],
  ])('%s is the argument fault and the port was never called', async (_label, args) => {
    const port = fakeSendPort({ status: 'sent', messageId: '444444444444444444' });
    const outcome = await sendMessageText(principalWith([GUILD_A]), port, args);
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(port.calls).toBe(0);
  });

  it('content of exactly 2000 characters reaches the port', async () => {
    const port = fakeSendPort({ status: 'sent', messageId: '444444444444444444' });
    const outcome = await sendMessageText(principalWith([GUILD_A]), port, {
      ...validArgs(),
      content: 'x'.repeat(SEND_CONTENT_MAX),
    });
    expect(port.calls).toBe(1);
    expect(textOf(outcome)).toContain('444444444444444444');
  });

  it('whitespace-only content is an argument fault and the port was never called', async () => {
    // M8: refused before anything is claimed — the port never runs, so no
    // ledger row, no rate-cap slot, no Discord call.
    const port = fakeSendPort({ status: 'sent', messageId: '444444444444444444' });
    for (const content of ['   ', '\n\t  ', ' \n ']) {
      const outcome = await sendMessageText(principalWith([GUILD_A]), port, {
        ...validArgs(),
        content,
      });
      expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    }
    expect(port.calls).toBe(0);
  });

  it('content with meaningful internal whitespace is sent with edges trimmed and interior intact', async () => {
    let seen: string | undefined;
    const port: McpSendPort = {
      send: (_guildId, input) => {
        seen = input.content;
        return Promise.resolve({ status: 'sent', messageId: '444444444444444444' });
      },
    };
    const outcome = await sendMessageText(principalWith([GUILD_A]), port, {
      ...validArgs(),
      content: '  hello   world\nnewline  ',
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toBe('hello   world\nnewline');
  });
});

describe('send_message refusal rendering (M5-D3/M5-D9 outcomes)', () => {
  const ALL_REFUSALS: readonly McpSendRefusal[] = [
    'private-thread',
    'channel-not-allowlisted',
    'channel-not-in-guild',
    'killswitch',
    'breaker-open',
    'rate-cap',
    'duplicate-key-different-content',
    'duplicate-content-recently',
  ];

  it('every refusal is an error with distinct, non-empty text', async () => {
    const messages: string[] = [];
    for (const reason of ALL_REFUSALS) {
      const port = fakeSendPort({ status: 'refused', reason });
      const outcome = await sendMessageText(principalWith([GUILD_A]), port, validArgs());
      expect(port.calls).toBe(1);
      const message = messageOf(outcome);
      expect(message.length).toBeGreaterThan(0);
      messages.push(message);
    }
    // Distinctness asserted programmatically, not by eyeballing.
    expect(new Set(messages).size).toBe(ALL_REFUSALS.length);
  });

  it.each([
    ['private-thread', 'private thread'],
    ['channel-not-allowlisted', 'allowlist'],
    ['channel-not-in-guild', 'will not help'],
    ['killswitch', 'kill switch'],
    ['breaker-open', 'breaker'],
    ['rate-cap', 'hour'],
    ['duplicate-key-different-content', 'different message'],
    ['duplicate-content-recently', 'minute'],
  ])('%s tells the operator what to do next (%s)', async (reason, phrase) => {
    const port = fakeSendPort({ status: 'refused', reason: reason as McpSendRefusal });
    const outcome = await sendMessageText(principalWith([GUILD_A]), port, validArgs());
    expect(messageOf(outcome)).toContain(phrase);
  });
});

it('the allowlist remediation names the guild', async () => {
  const port = fakeSendPort({ status: 'refused', reason: 'channel-not-allowlisted' });
  const outcome = await sendMessageText(principalWith([GUILD_A]), port, validArgs());
  expect(messageOf(outcome)).toContain('--guild 111111111111111111');
});

describe('send_message happy path', () => {
  it('sent renders with the message id', async () => {
    const port = fakeSendPort({ status: 'sent', messageId: '444444444444444444' });
    const text = textOf(await sendMessageText(principalWith([GUILD_A]), port, validArgs()));
    expect(text).toContain('444444444444444444');
  });

  it('dry-run says plainly that nothing was posted because dry run is on', async () => {
    const port = fakeSendPort({ status: 'dry-run' });
    const text = textOf(await sendMessageText(principalWith([GUILD_A]), port, validArgs()));
    expect(text).toContain('ry run');
    expect(text).toContain('nothing was posted');
  });

  it('replayed is ok:true with the original id, never failure language', async () => {
    const port = fakeSendPort({ status: 'replayed', messageId: '444444444444444444' });
    const outcome = await sendMessageText(principalWith([GUILD_A]), port, validArgs());
    expect(outcome.ok).toBe(true);
    const text = textOf(outcome);
    expect(text).toContain('444444444444444444');
    expect(text).toContain('othing new was posted');
    expect(text.toLowerCase()).not.toContain('fail');
  });

  it('replayed without a message id says to check the channel and reuse the key, never a fresh one', async () => {
    // I4: probe F2 showed a fresh key 61 s later posts again, so this text
    // must contain nothing that would produce a second send.
    const port = fakeSendPort({ status: 'replayed', messageId: undefined });
    const outcome = await sendMessageText(principalWith([GUILD_A]), port, validArgs());
    expect(outcome.ok).toBe(true);
    const text = textOf(outcome);
    expect(text).toContain('othing new was posted');
    expect(text).toContain('may or may not have been posted');
    expect(text).toContain(`Check channel ${CHANNEL}`);
    expect(text).toContain('reuse this same idempotency key');
    expect(text).not.toContain('fresh key');
  });

  it('replayed with and without an id render differently', async () => {
    const withId = textOf(
      await sendMessageText(
        principalWith([GUILD_A]),
        fakeSendPort({ status: 'replayed', messageId: '444444444444444444' }),
        validArgs(),
      ),
    );
    const withoutId = textOf(
      await sendMessageText(
        principalWith([GUILD_A]),
        fakeSendPort({ status: 'replayed', messageId: undefined }),
        validArgs(),
      ),
    );
    expect(withId).toContain('444444444444444444');
    expect(withoutId).not.toContain('444444444444444444');
    expect(withId).not.toBe(withoutId);
  });

  it('failed says the result is unknown and reuses the key, never claims nothing was posted', async () => {
    const port = fakeSendPort({ status: 'failed' });
    const outcome = await sendMessageText(principalWith([GUILD_A]), port, validArgs());
    expect(outcome.ok).toBe(false);
    const message = messageOf(outcome);
    expect(message).toContain('may or may not have been posted');
    expect(message).toContain('same idempotency key');
    expect(message).not.toContain('nothing was posted');
  });

  it('a throwing port is the shared refusal, never an exception', async () => {
    const port: McpSendPort = {
      send: () => Promise.reject(new Error('boom')),
    };
    const outcome = await sendMessageText(principalWith([GUILD_A]), port, validArgs());
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });
});

describe('send_message tool description (ruling M5-D8)', () => {
  it('tells the model to reuse the idempotency key on retry', () => {
    expect(SEND_MESSAGE_TOOL_DESCRIPTION).toContain('allowlist');
    expect(SEND_MESSAGE_TOOL_DESCRIPTION).toContain('2000');
    expect(SEND_MESSAGE_TOOL_DESCRIPTION).toContain('ping');
    // The load-bearing sentence: a regenerated key on retry double-posts.
    expect(SEND_MESSAGE_TOOL_DESCRIPTION).toContain('same value');
    expect(SEND_MESSAGE_TOOL_DESCRIPTION).toContain('retry');
    expect(SEND_MESSAGE_TOOL_DESCRIPTION).toContain('twice');
  });
});

describe('send.ts boundary (ADR 0044 §4, ruling M4-D14)', () => {
  it('goes through the port: no storage, http or discord.js import', () => {
    const source = readFileSync(new URL('./send.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('@bananasaurs/storage');
    expect(source).not.toContain('@bananasaurs/http');
    expect(source).not.toContain('discord.js');
  });
});

/** Minimal stubs: this section pins scope filtering, never the read tools. */
const stubHealth = (): McpHealthPort => ({
  startedAtMs: 1_700_000_000_000,
  readonly: false,
  env: 'test',
  gateway: () => ({ connected: true, pingMs: 42, guildCount: 1 }),
  now: () => 1_700_000_000_000 + 3_661_000,
  guilds: () => [],
});

const stubArchive = (): McpArchivePort => ({
  listArchiveChannelIds: () => [],
  searchMessages: () => ({ total: 0, hits: [] }),
  findMessage: () => undefined,
  listChannelHistory: () => [],
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
  send: () => Promise.resolve({ status: 'sent', messageId: '444444444444444444' }),
});

/** Minimal jobs port: this file pins `send_message`, never the jobs tools. */
const stubJobs = (): McpJobsPort => ({
  listJobs: () => [],
  findJob: () => undefined,
});

/** Minimal members port: this file pins `send_message`, never the member tools. */
const stubMembers = (): McpMembersPort => ({
  listAllMembers: () => Promise.resolve({ members: [], truncated: false }),
  lastMessageAt: () => new Map(),
  now: () => 1_700_000_000_000,
});

/** Minimal context port: this file pins `send_message`, never the context tool. */
const stubContext = (): McpContextPort => ({
  serverCard: () => '',
  timeZone: 'America/Vancouver',
  now: () => 1_700_000_000_000,
  skills: () => [],
});

/** Minimal resources port: this file pins `send_message`, never the resource tools. */
const stubResources = (): McpResourcesPort => ({
  listResources: () => [],
  searchChunks: () => [],
  resourceChunks: () => [],
});

/** Minimal threads port: this file pins `send_message`, never the thread tool. */
const stubThreads = (): McpThreadsPort => ({
  archiveThread: () => [],
  threadInfo: () => Promise.resolve(undefined),
  privateThreadReadable: () => Promise.resolve(false),
  liveThreadMessages: () => Promise.resolve([]),
});

const READ_TOOL_NAMES = [
  'get_health',
  'search_messages',
  'read_channel_history',
  'get_message',
  'read_thread',
  'list_channels',
  'list_threads',
  'list_roles',
  'list_members',
  'list_mod_cases',
  'get_mod_case',
  'list_audit_events',
  'get_server_overview',
  'list_jobs',
  'get_job',
  'get_member',
  'search_members',
  GET_SERVER_CONTEXT_TOOL_NAME,
  SEARCH_RESOURCES_TOOL_NAME,
  OPEN_RESOURCE_TOOL_NAME,
];

const connectPair = async (
  principal: McpPrincipal,
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const client = new Client({ name: 'mcp-send-test-client', version: '0.0.0' });
  const server = createMcpServer({
    principal,
    health: stubHealth(),
    archive: stubArchive(),
    guild: stubGuild(),
    records: stubRecords(),
    send: stubSend(),
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

const toolNamesOf = async (principal: McpPrincipal): Promise<string[]> => {
  const { client, close } = await connectPair(principal);
  try {
    const list = await client.listTools();
    return list.tools.map((tool) => tool.name);
  } finally {
    await close();
  }
};

describe('send_message scope filtering (ruling M4-D17)', () => {
  it('a read-only token sees the twenty read tools and not send_message', async () => {
    const names = await toolNamesOf(principalWith([GUILD_A, GUILD_B], ['bananasaurs:read']));
    expect(names).toHaveLength(20);
    expect(names).toEqual(READ_TOOL_NAMES);
    expect(names).not.toContain(SEND_MESSAGE_TOOL_NAME);
  });

  it('a send-only token sees only send_message', async () => {
    const names = await toolNamesOf(principalWith([GUILD_A], ['bananasaurs:send']));
    expect(names).toHaveLength(1);
    expect(names).toEqual([SEND_MESSAGE_TOOL_NAME]);
  });

  it('a token with both scopes sees twenty-one tools', async () => {
    const names = await toolNamesOf(
      principalWith([GUILD_A], ['bananasaurs:read', 'bananasaurs:send']),
    );
    expect(names).toHaveLength(21);
    expect(names).toContain(SEND_MESSAGE_TOOL_NAME);
  });

  it('send_message answers through the server round-trip', async () => {
    const { client, close } = await connectPair(
      principalWith([GUILD_A], ['bananasaurs:read', 'bananasaurs:send']),
    );
    try {
      const result = (await client.callTool({
        name: SEND_MESSAGE_TOOL_NAME,
        arguments: validArgs(),
      })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      const blocks = result.content as ReadonlyArray<{ type: string; text: string }>;
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.text).toContain('444444444444444444');
    } finally {
      await close();
    }
  });
});
