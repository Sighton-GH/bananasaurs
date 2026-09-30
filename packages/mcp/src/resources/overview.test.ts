import { describe, expect, it } from 'vitest';
import type { McpReadAuditPort } from '../read-audit.js';

/** ADR 0050: this file does not exercise read logging; the server requires the port. */
const noopReadAudit: McpReadAuditPort = {
  auditContentRead: () => undefined,
  logStructuralRead: () => undefined,
};

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
import type { McpGuildChannel, McpGuildPort } from '../tools/guild.js';
import type { McpJobsPort } from '../tools/jobs.js';
import {
  buildOverviewCard,
  OVERVIEW_RESOURCE_URI_TEMPLATE,
  readOverviewResource,
  type OverviewCardInput,
} from './overview.js';
import { STRUCTURED_NOTE } from '../structured.js';

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
  listThreads: async () => [],
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

/** Minimal jobs port: this file pins the overview resource, never the jobs tools. */
const stubJobs = (): McpJobsPort => ({
  listJobs: () => [],
  findJob: () => undefined,
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
    // Required since M5 Task 4; never called by the resource pinned here.
    send: { send: () => Promise.resolve({ status: 'sent' as const, messageId: 'mid' }) },
    readAudit: noopReadAudit,
    jobs: stubJobs(),
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

/**
 * A large fixture modelling the ~125-block guild from the ADR 0110 context:
 * 6 categories of 10 text channels (each with a 40-character topic), 60
 * roles, 3 panels and 4 rules.
 */
const bigFixture = (): OverviewCardInput => {
  const channels: McpGuildChannel[] = [];
  for (let c = 0; c < 6; c += 1) {
    const categoryId = `40000000000000000${String(c)}`;
    channels.push({
      id: categoryId,
      name: `category-${String(c)}`,
      type: 'GuildCategory',
      parentId: undefined,
      parentName: undefined,
      topic: undefined,
      archiveEnabled: false,
    });
    for (let t = 0; t < 10; t += 1) {
      channels.push({
        id: `500000000000000${String(c)}${String(t)}`,
        name: `channel-${String(c)}-${String(t)}`,
        type: 'GuildText',
        parentId: categoryId,
        parentName: `category-${String(c)}`,
        topic: 't'.repeat(40),
        archiveEnabled: t % 2 === 0,
      });
    }
  }
  return {
    guildId: GUILD_A,
    channels,
    roles: Array.from({ length: 60 }, (_, i) => ({
      id: `6000000000000000${String(i).padStart(2, '0')}`,
      name: `role-${String(i)}`,
      position: i,
      color: 0,
      managedByBananasaurs: i % 3 === 0,
    })),
    memberCount: 210,
    rules: [
      { ruleId: 'rule-test', name: 'Test rule', mode: 'test', enabled: true },
      { ruleId: 'rule-observe-1', name: 'Observe one', mode: 'observe', enabled: true },
      { ruleId: 'rule-observe-2', name: 'Observe two', mode: 'observe', enabled: false },
      { ruleId: 'rule-enforce', name: 'Enforce rule', mode: 'enforce', enabled: true },
    ],
    panels: [{ panelId: 'roles-panel' }, { panelId: 'welcome' }, { panelId: 'rules' }],
  };
};

// measured with the pre-ADR-0110 evidence-block card
const PRE_ADR_0110_CARD_LENGTH = 31474;

/** Head line, note line, then the parsed JSON payload. */
const cardJsonOf = (text: string): Record<string, unknown> => {
  const lines = text.split('\n');
  expect(lines).toHaveLength(3);
  expect(lines[1]).toBe(STRUCTURED_NOTE);
  return JSON.parse(lines[2] ?? '') as Record<string, unknown>;
};

describe('overview tool on the MCP server', () => {
  it('the JSON card stays under a quarter of the evidence-block size', () => {
    expect(buildOverviewCard(bigFixture()).length).toBeLessThan(
      Math.ceil(PRE_ADR_0110_CARD_LENGTH / 4),
    );
  });

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

describe('overview card JSON (ADR 0110)', () => {
  const smallInput = (): OverviewCardInput => ({
    guildId: GUILD_A,
    channels: [
      {
        id: '333333333333333333',
        name: 'planning',
        type: 'GuildText',
        parentId: '444444444444444444',
        parentName: 'club',
        topic: 'plan the picnic',
        archiveEnabled: true,
      },
      {
        id: '777777777777777777',
        name: 'lounge',
        type: 'GuildVoice',
        parentId: undefined,
        parentName: undefined,
        topic: undefined,
        archiveEnabled: false,
      },
    ],
    roles: [
      {
        id: '666666666666666666',
        name: 'organizer',
        position: 3,
        color: 0,
        managedByBananasaurs: true,
      },
    ],
    memberCount: 210,
    rules: [
      { ruleId: 'rule-test', name: 'Test rule', mode: 'test', enabled: true },
      { ruleId: 'rule-enforce', name: 'Enforce rule', mode: 'enforce', enabled: true },
    ],
    panels: [{ panelId: 'roles-panel' }],
  });

  it('is head, note, then one line of JSON with the gateway scalar', () => {
    const text = buildOverviewCard(smallInput());
    const [head, note] = text.split('\n');
    expect(head).toBe(
      'Server overview for guild 111111111111111111: 210 members, ' +
        '2 channels, 1 roles, 1 panels, 2 rules. Channels without a type are text channels.',
    );
    expect(note).toBe(STRUCTURED_NOTE);
    const data = cardJsonOf(text);
    expect(data['guild']).toEqual({ id: '111111111111111111', memberCount: 210 });
  });

  it('groups channels by category and lists the unparented separately', () => {
    const data = cardJsonOf(buildOverviewCard(smallInput()));
    // No GuildCategory channel in the input, so the parent is synthesised
    // from the child's locator — the grouping still holds.
    expect(data['categories']).toEqual([
      {
        id: '444444444444444444',
        name: 'club',
        channels: [{ id: '333333333333333333', name: 'planning', archive: true }],
      },
    ]);
    expect(data['uncategorised']).toEqual([
      { id: '777777777777777777', name: 'lounge', type: 'GuildVoice' },
    ]);
  });

  it('a channel with an unknown parent category lands in a synthesised category', () => {
    const input = smallInput();
    const data = cardJsonOf(
      buildOverviewCard({
        ...input,
        channels: [
          {
            id: '999999999999999999',
            name: 'orphan',
            type: 'GuildText',
            parentId: '000000000000000001',
            parentName: undefined,
            topic: undefined,
            archiveEnabled: false,
          },
        ],
      }),
    );
    expect(data['categories']).toEqual([
      {
        id: '000000000000000001',
        name: '',
        channels: [{ id: '999999999999999999', name: 'orphan' }],
      },
    ]);
    expect(data['uncategorised']).toEqual([]);
  });

  it('topics are not in the overview', () => {
    expect(buildOverviewCard(smallInput())).not.toContain('plan the picnic');
  });

  it('a text channel omits type while a voice channel keeps it, and the head says so', () => {
    const text = buildOverviewCard(smallInput());
    expect(text.split('\n')[0]).toContain('Channels without a type are text channels.');
    const data = cardJsonOf(text);
    // planning is GuildText: no type key. lounge is GuildVoice: type kept.
    const categories = data['categories'] as ReadonlyArray<{
      channels: ReadonlyArray<Record<string, unknown>>;
    }>;
    expect(categories[0]?.channels).toEqual([
      { id: '333333333333333333', name: 'planning', archive: true },
    ]);
    expect(data['uncategorised']).toEqual([
      { id: '777777777777777777', name: 'lounge', type: 'GuildVoice' },
    ]);
  });

  it('lists roles highest-first as id and name, panels and rule counts', () => {
    const data = cardJsonOf(buildOverviewCard(smallInput()));
    expect(data['roles']).toEqual([
      {
        id: '666666666666666666',
        name: 'organizer',
        managed: true,
      },
    ]);
    expect(data['panels']).toEqual([{ id: 'roles-panel' }]);
    expect(data['rules']).toEqual({
      test: { total: 1, enabled: 1 },
      observe: { total: 0, enabled: 0 },
      enforce: { total: 1, enabled: 1 },
    });
  });

  it('an unmanaged role carries no managed key', () => {
    const input = smallInput();
    const data = cardJsonOf(
      buildOverviewCard({
        ...input,
        roles: [
          {
            id: '666666666666666666',
            name: 'organizer',
            position: 3,
            color: 0,
            managedByBananasaurs: true,
          },
          {
            id: '777777777777777777',
            name: 'member',
            position: 1,
            color: 0,
            managedByBananasaurs: false,
          },
        ],
      }),
    );
    // Highest position first; only the managed role carries the key.
    expect(data['roles']).toEqual([
      { id: '666666666666666666', name: 'organizer', managed: true },
      { id: '777777777777777777', name: 'member' },
    ]);
  });

  it('bigFixture groups six categories of ten with sixty roles', () => {
    const data = cardJsonOf(buildOverviewCard(bigFixture()));
    const categories = data['categories'] as ReadonlyArray<{
      channels: readonly unknown[];
    }>;
    expect(categories).toHaveLength(6);
    for (const category of categories) {
      expect(category.channels).toHaveLength(10);
    }
    expect(data['uncategorised']).toEqual([]);
    expect(data['roles'] as readonly unknown[]).toHaveLength(60);
    expect(data['panels'] as readonly unknown[]).toHaveLength(3);
    expect(data['rules']).toEqual({
      test: { total: 1, enabled: 1 },
      observe: { total: 2, enabled: 1 },
      enforce: { total: 1, enabled: 1 },
    });
  });
});
