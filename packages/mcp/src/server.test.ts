import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseGuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, type McpPrincipal } from './scope.js';
import { createMcpServer } from './server.js';
import {
  GET_HEALTH_TOOL_NAME,
  getHealthText,
  type McpHealthPort,
} from './tools/health.js';

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
  gateway: { connected: true, pingMs: 42, guildCount: 1 },
  now: () => 1_700_000_000_000 + 3_661_000,
  guilds: [
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
): McpPrincipal => ({ accountId: 'acct_test', reachableGuilds });

/** One connected client/server pair over the in-memory transport. */
const connectPair = async (
  principal: McpPrincipal,
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
  const server = createMcpServer({ principal, health: stubPort() });
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
  it('lists get_health and nothing else', async () => {
    const { client, close } = await connectPair(principalWith([GUILD]));
    try {
      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name)).toEqual([GET_HEALTH_TOOL_NAME]);
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
