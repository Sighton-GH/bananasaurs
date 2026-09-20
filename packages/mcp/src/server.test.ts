import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseGuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, type McpPrincipal } from './scope.js';
import type { McpReadAuditPort } from './read-audit.js';
import { createMcpServer } from './server.js';
import {
  GET_MESSAGE_TOOL_NAME,
  READ_CHANNEL_HISTORY_TOOL_NAME,
  SEARCH_MESSAGES_TOOL_NAME,
  type McpArchivePort,
} from './tools/archive.js';
import { GET_HEALTH_TOOL_NAME, getHealthText, type McpHealthPort } from './tools/health.js';
import {
  GET_MOD_CASE_TOOL_NAME,
  GET_SERVER_OVERVIEW_TOOL_NAME,
  LIST_AUDIT_EVENTS_TOOL_NAME,
  LIST_MOD_CASES_TOOL_NAME,
  type McpRecordsPort,
} from './tools/records.js';
import {
  LIST_CHANNELS_TOOL_NAME,
  LIST_MEMBERS_TOOL_NAME,
  LIST_ROLES_TOOL_NAME,
  type McpGuildPort,
} from './tools/guild.js';
import { SEND_MESSAGE_TOOL_NAME, type McpSendPort } from './tools/send.js';

/** ADR 0050: the tests in this file do not exercise read logging; the server requires the port. */
const noopReadAudit: McpReadAuditPort = {
  auditContentRead: () => undefined,
  logStructuralRead: () => undefined,
};

/**
 * Task 3, `packages/mcp` side: `get_health` exercised through a real MCP
 * round-trip (client over the in-memory transport), with no Fastify. The
 * daemon-level refusal — a valid token whose reachable set was emptied after
 * minting — is pinned in `apps/daemon/src/mcp/wiring.test.ts`; this file pins
 * the handler contract that makes that refusal possible.
 */

const GUILD = parseGuildId('111111111111111111');

const stubPort = (): McpHealthPort => ({
  startedAtMs: 1_700_000_000_000,
  readonly: false,
  env: 'test',
  gateway: () => ({ connected: true, pingMs: 42, guildCount: 1 }),
  now: () => 1_700_000_000_000 + 3_661_000,
  guilds: () => [
    {
      guildId: GUILD,
      guildName: 'guild a',
      safety: { killswitch: false, dryRun: false, breakerOpen: false, breakerReason: null },
      jobCounts: { queued: 1, running: 0, failed: 0 },
      schedulerLagMs: 0,
    },
  ],
});

const principalWith = (
  reachableGuilds: McpPrincipal['reachableGuilds'],
  scopes: McpPrincipal['scopes'] = ['bananasaurs:read'],
): McpPrincipal => ({
  accountId: 'acct_test',
  reachableGuilds,
  scopes,
});

/** Minimal archive port: this file pins `get_health`, never the archive tools. */
const stubArchive = (): McpArchivePort => ({
  listArchiveChannelIds: () => [],
  searchMessages: () => ({ total: 0, hits: [] }),
  findMessage: () => undefined,
  listChannelHistory: () => [],
});

/** Minimal guild port: this file pins `get_health`, never the guild tools. */
const stubGuild = (): McpGuildPort => ({
  listChannels: () => [],
  listRoles: () => [],
  listMembers: () => Promise.resolve({ members: [], nextCursor: undefined }),
  memberCount: () => 0,
});

/** Minimal records port: this file pins `get_health`, never the records tools. */
const stubRecords = (): McpRecordsPort => ({
  listRecentCases: () => [],
  findCase: () => undefined,
  listCaseEvents: () => [],
  tailAudit: () => [],
  listRules: () => [],
  listPanels: () => [],
});

/** Minimal send port: this file pins registration, never the send itself. */
const stubSend = (): McpSendPort => ({
  send: () => Promise.resolve({ status: 'sent', messageId: 'mid-test' }),
});

/** One connected client/server pair over the in-memory transport. */
const connectPair = async (
  principal: McpPrincipal,
  send: McpSendPort = stubSend(),
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
  const server = createMcpServer({
    principal,
    health: stubPort(),
    archive: stubArchive(),
    guild: stubGuild(),
    records: stubRecords(),
    readAudit: noopReadAudit,
    send,
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

const textOf = (result: CallToolResult): string => {
  const blocks = result.content as ReadonlyArray<{ type: string; text: string }> | undefined;
  expect(blocks).toHaveLength(1);
  expect(blocks?.[0]?.type).toBe('text');
  const text = blocks?.[0]?.text;
  expect(typeof text).toBe('string');
  return text as string;
};

describe('getHealthText', () => {
  it('refuses a principal with an empty reachable set, with the shared refusal', () => {
    expect(getHealthText(principalWith([]), stubPort())).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
  });

  it('reports process facts for a principal that reaches a guild', () => {
    const outcome = getHealthText(principalWith([GUILD]), stubPort());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain('connected');
    expect(outcome.text).toContain('guild a');
    expect(outcome.text).toContain('uptime');
  });
});

describe('createMcpServer', () => {
  it('lists send_message first, alongside the twelve read tools', async () => {
    const { client, close } = await connectPair(
      principalWith([GUILD], ['bananasaurs:read', 'bananasaurs:send']),
    );
    try {
      const list = await client.listTools();
      expect(list.tools).toHaveLength(13);
      expect(list.tools.map((tool) => tool.name)).toEqual([
        SEND_MESSAGE_TOOL_NAME,
        GET_HEALTH_TOOL_NAME,
        SEARCH_MESSAGES_TOOL_NAME,
        READ_CHANNEL_HISTORY_TOOL_NAME,
        GET_MESSAGE_TOOL_NAME,
        LIST_CHANNELS_TOOL_NAME,
        'list_threads',
        LIST_ROLES_TOOL_NAME,
        LIST_MEMBERS_TOOL_NAME,
        LIST_MOD_CASES_TOOL_NAME,
        GET_MOD_CASE_TOOL_NAME,
        LIST_AUDIT_EVENTS_TOOL_NAME,
        GET_SERVER_OVERVIEW_TOOL_NAME,
      ]);
      const resources = await client.listResourceTemplates();
      expect(resources.resourceTemplates).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('(ruling M4-D17) a send-only principal gets send_message and nothing else', async () => {
    const { client, close } = await connectPair(principalWith([GUILD], ['bananasaurs:send']));
    try {
      // `send_message` registers under the send scope independently of the
      // read-scope block, so a send-only server lists exactly one tool — and
      // still no resource, which stays behind the read scope.
      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name)).toEqual([SEND_MESSAGE_TOOL_NAME]);
      // The SDK installs its `resources/templates/list` handler lazily on the
      // first `registerResource()` call, so a server with no resource answers
      // Method-not-found rather than an empty array.
      await expect(client.listResourceTemplates()).rejects.toMatchObject({ code: -32601 });
    } finally {
      await close();
    }
  });

  it('(slice M5) a read-only principal never sees send_message', async () => {
    // Required (ruling M5-D11) means the port is always present, not that the
    // tool is always advertised: without the send scope there is no
    // `send_message`, even with the port threaded through.
    const { client, close } = await connectPair(principalWith([GUILD]));
    try {
      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name)).not.toContain(SEND_MESSAGE_TOOL_NAME);
    } finally {
      await close();
    }
  });

  it('answers get_health for a principal that reaches a guild', async () => {
    const { client, close } = await connectPair(principalWith([GUILD]));
    try {
      const result = (await client.callTool({
        name: GET_HEALTH_TOOL_NAME,
      })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('guild a');
    } finally {
      await close();
    }
  });

  it('refuses get_health for a principal with an empty reachable set', async () => {
    const { client, close } = await connectPair(principalWith([]));
    try {
      const result = (await client.callTool({
        name: GET_HEALTH_TOOL_NAME,
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(GUILD_REFUSAL_MESSAGE);
    } finally {
      await close();
    }
  });
});
