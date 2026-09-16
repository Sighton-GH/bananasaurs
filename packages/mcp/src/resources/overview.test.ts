import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { parseGuildId, type GuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, INVALID_ARGUMENTS_MESSAGE, type McpPrincipal } from '../scope.js';
import { createMcpServer } from '../server.js';
import type { McpHealthPort } from '../tools/health.js';
import type { McpArchivePort } from '../tools/archive.js';
import {
  GET_SERVER_OVERVIEW_TOOL_NAME,
  getServerOverviewText,
  type McpRecordsPort,
} from '../tools/records.js';
import type { McpGuildPort } from '../tools/guild.js';
import { OVERVIEW_RESOURCE_URI_TEMPLATE, readOverviewResource } from './overview.js';

/**
 * Task 6 (absorbing Task 8), resource side: `bananasaurs://guild/{guildId}/overview`
 * through a real MCP round-trip (client over the in-memory transport), with no
 * Fastify. The load-bearing property is ruling M4-D13 — the `{guildId}` in the
 * URI is untrusted input exactly like a tool argument, so the resource refuses
 * the same way the tool does, and both doors serve the same card text.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');

const principalWith = (...guilds: readonly GuildId[]): McpPrincipal => ({
  accountId: 'acct_00000000000000000000000000000000',
  reachableGuilds: guilds,
  scopes: ['bananasaurs:read'],
});

const stubHealth = (): McpHealthPort => ({
  startedAtMs: 1_700_000_000_000,
  readonly: false,
  env: 'test',
  gateway: { connected: true, pingMs: 42, guildCount: 1 },
  now: () => 1_700_000_000_000 + 3_661_000,
  guilds: [],
});

const stubArchive = (): McpArchivePort => ({
  listArchiveChannelIds: () => [],
  searchMessages: () => ({ total: 0, hits: [] }),
  findMessage: () => undefined,
  listChannelHistory: () => [],
});

const stubGuild = (): McpGuildPort => ({
  listChannels: () => [
    {
      id: '333333333333333333',
      name: 'planning',
      type: 'GuildText',
      parentId: '444444444444444444',
      parentName: 'club',
      topic: 'plan the picnic',
      archiveEnabled: true,
    },
  ],
  listRoles: () => [
    {
      id: '666666666666666666',
      name: 'organizer',
      position: 3,
      color: 0,
      managedByBananasaurs: true,
    },
  ],
  listMembers: () => Promise.resolve({ members: [], nextCursor: undefined }),
  memberCount: () => 210,
});

const stubRecords = (): McpRecordsPort => ({
  listRecentCases: () => [],
  findCase: () => undefined,
  listCaseEvents: () => [],
  tailAudit: () => [],
  listRules: () => [
    { ruleId: 'rule-test', name: 'Test rule', mode: 'test', enabled: true },
    { ruleId: 'rule-enforce', name: 'Enforce rule', mode: 'enforce', enabled: true },
  ],
  listPanels: () => [{ panelId: 'roles-panel' }],
});

/** One connected client/server pair over the in-memory transport. */
const connectPair = async (
  principal: McpPrincipal,
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
  const server = createMcpServer({
    principal,
    health: stubHealth(),
    archive: stubArchive(),
    guild: stubGuild(),
    records: stubRecords(),
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

const resourceTextOf = (result: ReadResourceResult): string => {
  expect(result.contents).toHaveLength(1);
  const block = result.contents[0];
  expect(block?.mimeType).toBe('text/plain');
  if (block === undefined || !('text' in block)) throw new Error('expected a text resource');
  const text = block.text;
  expect(typeof text).toBe('string');
  return text;
};

describe('overview resource guard', () => {
  it('refuses guild B as a guild-A-only principal with the shared message', async () => {
    const { client, close } = await connectPair(principalWith(GUILD_A));
    try {
      await expect(
        client.readResource({ uri: 'bananasaurs://guild/222222222222222222/overview' }),
      ).rejects.toThrow(GUILD_REFUSAL_MESSAGE);
    } finally {
      await close();
    }
  });

  it('refuses a malformed guildId in the URI identically', async () => {
    const { client, close } = await connectPair(principalWith(GUILD_A, GUILD_B));
    try {
      await expect(
        client.readResource({ uri: 'bananasaurs://guild/not-a-snowflake/overview' }),
      ).rejects.toThrow(GUILD_REFUSAL_MESSAGE);
    } finally {
      await close();
    }
  });

  it('a non-string template variable is an argument fault, never the shared refusal (ruling M4-D18)', () => {
    const principal = principalWith(GUILD_A);
    // The shape check runs before the guild gate, so it has consulted
    // nothing about which guilds exist — naming it leaks no membership fact.
    for (const raw of [undefined, 42, { guildId: '111111111111111111' }]) {
      expect(readOverviewResource(principal, stubGuild(), stubRecords(), raw)).toEqual({
        ok: false,
        message: INVALID_ARGUMENTS_MESSAGE,
      });
    }
    // While a string that is simply not ours stays the shared refusal.
    expect(
      readOverviewResource(principal, stubGuild(), stubRecords(), '222222222222222222'),
    ).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });

  it('answers its own guild through the same check the tool uses', async () => {
    const { client, close } = await connectPair(principalWith(GUILD_A));
    try {
      const result = await client.readResource({
        uri: 'bananasaurs://guild/111111111111111111/overview',
      });
      expect(resourceTextOf(result)).toContain('210');
    } finally {
      await close();
    }
  });
});

describe('resource and tool serve the same card', () => {
  it('returns equal text for the same guild', async () => {
    const principal = principalWith(GUILD_A);
    const guild = stubGuild();
    const records = stubRecords();
    const tool = getServerOverviewText(principal, guild, records, {
      guildId: '111111111111111111',
    });
    expect(tool.ok).toBe(true);
    if (!tool.ok) throw new Error('expected ok:true');
    const { client, close } = await connectPair(principal);
    try {
      const result = await client.readResource({
        uri: 'bananasaurs://guild/111111111111111111/overview',
      });
      expect(resourceTextOf(result)).toBe(tool.text);
    } finally {
      await close();
    }
  });

  it('the direct read helper agrees with the tool too', () => {
    const principal = principalWith(GUILD_A);
    const guild = stubGuild();
    const records = stubRecords();
    const tool = getServerOverviewText(principal, guild, records, {
      guildId: '111111111111111111',
    });
    const resource = readOverviewResource(principal, guild, records, '111111111111111111');
    expect(resource).toEqual(tool);
    expect(OVERVIEW_RESOURCE_URI_TEMPLATE).toBe('bananasaurs://guild/{guildId}/overview');
  });
});

describe('overview tool on the MCP server', () => {
  it('answers get_server_overview through a tool call', async () => {
    const { client, close } = await connectPair(principalWith(GUILD_A));
    try {
      const result = (await client.callTool({
        name: GET_SERVER_OVERVIEW_TOOL_NAME,
        arguments: { guildId: '111111111111111111' },
      })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      const blocks = result.content as ReadonlyArray<{ type: string; text: string }>;
      expect(blocks[0]?.text).toContain('210');
    } finally {
      await close();
    }
  });
});
