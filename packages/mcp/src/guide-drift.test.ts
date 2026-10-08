import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GUIDE_TOPICS, parseGuildId } from '@bananasaurs/core';
import { createMcpServer } from './server.js';
import type { McpPrincipal } from './scope.js';
import { fullDeps } from './test-support/full-deps.js';

/**
 * ADR 0133: every tool a connected app can see must be named in the guide, so a
 * tool added later without a guide line fails here. The reverse holds too: a
 * tool the guide still names but the server no longer advertises fails. The
 * all-scope owner sees the full set. The port stubs come from the shared
 * `test-support/full-deps.ts` builder, the same one `registration.test.ts` uses.
 */

const GUILD = parseGuildId('111111111111111111');

const OWNER: McpPrincipal = {
  accountId: 'acct_owner',
  reachableGuilds: [GUILD],
  scopes: ['bananasaurs:read', 'bananasaurs:send', 'bananasaurs:roles', 'bananasaurs:tasks'],
};

/** The names `tools/list` advertises to this principal, sorted. */
const advertisedToolNames = async (principal: McpPrincipal): Promise<readonly string[]> => {
  const client = new Client({ name: 'guide-drift-test-client', version: '0.0.0' });
  const server = createMcpServer(fullDeps(principal));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const list = await client.listTools();
    return list.tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
};

/**
 * A name that is a tool by its shape: snake_case, as every multi-word tool is.
 * A one-word tool cannot be told from prose by shape, so those are listed by
 * hand. `react` is the only one today.
 */
const ONE_WORD_TOOL_NAMES: readonly string[] = ['react'];
const looksLikeToolName = (token: string): boolean =>
  /^[a-z]+(_[a-z]+)+$/.test(token) || ONE_WORD_TOOL_NAMES.includes(token);

/** Each name written between backticks in a guide body. */
const backticked = (body: string): readonly string[] =>
  [...body.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '');

describe('the guide names every MCP tool', () => {
  it('lists the tools an all-scope owner sees, including the core reads and writes', async () => {
    const names = await advertisedToolNames(OWNER);
    expect(names).toContain('get_health');
    expect(names).toContain('send_message');
    expect(names).toContain('create_task');
  });

  it('names every advertised tool, as code, in some guide topic', async () => {
    const names = await advertisedToolNames(OWNER);
    const guideText = GUIDE_TOPICS.map((topic) => topic.body).join('\n');
    const unnamed = names.filter((name) => !guideText.includes(`\`${name}\``));
    expect(unnamed).toEqual([]);
  });

  it('names no removed or renamed tool in a claude-tools topic', async () => {
    const advertised = new Set(await advertisedToolNames(OWNER));
    const claudeToolTopics = GUIDE_TOPICS.filter((topic) => topic.id.startsWith('claude-tools-'));
    const toolLike = claudeToolTopics
      .flatMap((topic) => backticked(topic.body))
      .filter(looksLikeToolName);
    // The shape rule must find the tools the topics name, or the check is empty.
    expect(toolLike.length).toBeGreaterThan(0);
    const unadvertised = toolLike.filter((token) => !advertised.has(token));
    expect(unadvertised).toEqual([]);
  });
});
