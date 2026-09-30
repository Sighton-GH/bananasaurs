import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseGuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE } from './scope.js';
import { registerReadTool, type ReadOutcome } from './register.js';
import type { McpReadAuditPort } from './read-audit.js';

/**
 * `registerReadTool` is the single handler shape every read tool in
 * `server.ts` uses: refusal → isError text; success → the ADR 0050 record,
 * then the text; any throw → the shared refusal.
 */

const textOf = (result: CallToolResult): string => {
  const blocks = result.content as ReadonlyArray<{ type: string; text: string }> | undefined;
  expect(blocks).toHaveLength(1);
  expect(blocks?.[0]?.type).toBe('text');
  const text = blocks?.[0]?.text;
  expect(typeof text).toBe('string');
  return text as string;
};

const connectWith = async (
  run: (args: unknown) => ReadOutcome | Promise<ReadOutcome>,
  readAudit: McpReadAuditPort,
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const client = new Client({ name: 'mcp-register-test-client', version: '0.0.0' });
  const server = new McpServer({ name: 'bananasaurs-register-test', version: '0.0.0' });
  registerReadTool(
    {
      server,
      principal: { accountId: 'acct_test', reachableGuilds: [], scopes: [] },
      readAudit,
    },
    'fake_tool',
    'A fake tool for the registration contract.',
    { echo: z.string().describe('An echo string.') },
    run,
  );
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

const countingAudit = (): McpReadAuditPort & { calls: number } => {
  const port = {
    calls: 0,
    auditContentRead: () => undefined,
    logStructuralRead: () => {
      port.calls += 1;
    },
  };
  return port;
};

describe('registerReadTool', () => {
  it('an ok outcome returns the text and performs the read record once', async () => {
    const audit = countingAudit();
    const { client, close } = await connectWith(
      (): ReadOutcome => ({
        ok: true,
        text: 'hello',
        read: {
          kind: 'structural',
          action: 'mcp.read.fake_tool',
          guildIds: [parseGuildId('111111111111111111')],
          resultCount: 1,
        },
      }),
      audit,
    );
    try {
      const result = (await client.callTool({
        name: 'fake_tool',
        arguments: { echo: 'hi' },
      })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toBe('hello');
      expect(audit.calls).toBe(1);
    } finally {
      await close();
    }
  });

  it('a refusal answers isError with the message and records nothing', async () => {
    const audit = countingAudit();
    const { client, close } = await connectWith(
      (): ReadOutcome => ({ ok: false, message: 'nope' }),
      audit,
    );
    try {
      const result = (await client.callTool({
        name: 'fake_tool',
        arguments: { echo: 'hi' },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('nope');
      expect(audit.calls).toBe(0);
    } finally {
      await close();
    }
  });

  it('a throwing run answers the shared refusal', async () => {
    const audit = countingAudit();
    const { client, close } = await connectWith((): ReadOutcome => {
      throw new Error('boom');
    }, audit);
    try {
      const result = (await client.callTool({
        name: 'fake_tool',
        arguments: { echo: 'hi' },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(GUILD_REFUSAL_MESSAGE);
      expect(audit.calls).toBe(0);
    } finally {
      await close();
    }
  });
});
