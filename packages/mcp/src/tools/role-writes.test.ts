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
import type { McpSendPort } from './send.js';
import type { McpJobsPort } from './jobs.js';
import type { McpMembersPort } from './members.js';
import type { McpContextPort } from './context.js';
import type { McpResourcesPort } from './resources.js';
import type { McpThreadsPort } from './threads.js';
import type { McpThreadWritesPort } from './thread-writes.js';
import type { McpMessageWritesPort } from './message-writes.js';
import type { McpReadAuditPort } from '../read-audit.js';
import {
  GRANT_ROLE_TOOL_NAME,
  REMOVE_ROLE_TOOL_NAME,
  grantRoleText,
  removeRoleText,
  type McpRoleWriteOutcome,
  type McpRoleWriteRefusal,
  type McpRoleWritesPort,
} from './role-writes.js';

/**
 * Slice 4 Task 3, tool layer: `grant_role` / `remove_role` against a fake
 * `McpRoleWritesPort` — the same seam the daemon's role wiring implements,
 * so the guard behaviour pinned here (guild gate, argument boundary,
 * id-or-name resolution, refusal rendering) holds whichever implementation
 * sits behind it.
 *
 * Member and role refs resolve here, in the tool, through `search_members`'
 * exact-name matching and `resolveRoleRef`: the daemon's port takes resolved
 * snowflake ids, and anything unresolvable refuses before it is ever called.
 */

const noopReadAudit: McpReadAuditPort = {
  auditContentRead: () => undefined,
  logStructuralRead: () => undefined,
};

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const MEMBER = '633333333333333333';
const MEMBER_TWIN = '634444444444444444';
const ROLE = '522222222222222222';
const ROLE_TWIN = '523333333333333333';
const ACTION = 'act-00000000000000000000000001';

const principalWith = (
  guilds: readonly GuildId[],
  scopes: readonly string[] = ['bananasaurs:roles'],
): McpPrincipal => ({
  accountId: 'acct_00000000000000000000000000000000',
  reachableGuilds: guilds,
  scopes,
});

const grantArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  member: MEMBER,
  role: ROLE,
  idempotencyKey: 'role-k1',
  ...over,
});

const removeArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  member: MEMBER,
  role: ROLE,
  idempotencyKey: 'role-k2',
  ...over,
});

/** Roles the fake guild port lists: `helpers` twice on purpose (ambiguity). */
const fakeGuild = (): McpGuildPort => ({
  listChannels: () => [],
  listThreads: () => Promise.resolve([]),
  listRoles: () => [
    { id: ROLE, name: 'helpers', position: 4, color: 0, managedByBananasaurs: true },
    { id: ROLE_TWIN, name: 'helpers', position: 3, color: 0, managedByBananasaurs: true },
    { id: '544444444444444444', name: 'ushers', position: 2, color: 0, managedByBananasaurs: true },
  ],
  listMembers: () => Promise.resolve({ members: [], nextCursor: undefined }),
  memberCount: () => 2,
});

/** Members the fake members port lists: two share the display name `Sam`. */
const fakeMembers = (): McpMembersPort => ({
  listAllMembers: () =>
    Promise.resolve({
      members: [
        {
          id: MEMBER,
          username: 'samwise',
          displayName: 'Sam',
          nickname: undefined,
          roleIds: [],
          joinedAt: undefined,
        },
        {
          id: MEMBER_TWIN,
          username: 'sam2',
          displayName: 'Sam',
          nickname: undefined,
          roleIds: [],
          joinedAt: undefined,
        },
      ],
      truncated: false,
    }),
  lastMessageAt: () => new Map(),
  now: () => 1_700_000_000_000,
});

/** Fake role-writes port: every call recorded, the outcome scripted per test. */
const fakeRolePort = (
  outcome: McpRoleWriteOutcome,
): McpRoleWritesPort & { readonly calls: number; readonly lastInput: unknown } => {
  let calls = 0;
  let lastInput: unknown;
  const record = (input: unknown): Promise<McpRoleWriteOutcome> => {
    calls += 1;
    lastInput = input;
    return Promise.resolve(outcome);
  };
  return {
    get calls(): number {
      return calls;
    },
    get lastInput(): unknown {
      return lastInput;
    },
    grant: (_guildId, input) => record(input),
    remove: (_guildId, input) => record(input),
  };
};

const doneOutcome = (): McpRoleWriteOutcome => ({ status: 'done', actionId: ACTION, alreadyHad: false });

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
  ['grant_role', grantRoleText, grantArgs] as const,
  ['remove_role', removeRoleText, removeArgs] as const,
];

const callHandler = (
  handler: (typeof handlers)[number][1],
  args: Record<string, unknown>,
  outcome: McpRoleWriteOutcome = doneOutcome(),
): Promise<{ readonly message: string; readonly calls: number }> =>
  (async () => {
    const port = fakeRolePort(outcome);
    const result = await handler(principalWith([GUILD_A]), port, fakeGuild(), fakeMembers(), args);
    return { message: messageOf(result), calls: port.calls };
  })();

describe('role-write guild gate (CLAUDE.md rule 2)', () => {
  it.each(handlers)('%s refuses an unreachable guild with the shared refusal', async (...[, handler, args]) => {
    const port = fakeRolePort(doneOutcome());
    const outcome = await handler(principalWith([GUILD_A]), port, fakeGuild(), fakeMembers(), {
      ...args(),
      guildId: '222222222222222222',
    });
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(port.calls).toBe(0);
  });

  it.each(handlers)('%s refuses a malformed guild id identically', async (...[, handler, args]) => {
    const port = fakeRolePort(doneOutcome());
    const outcome = await handler(principalWith([GUILD_A]), port, fakeGuild(), fakeMembers(), {
      ...args(),
      guildId: 'not-a-snowflake',
    });
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(port.calls).toBe(0);
  });

  it.each(handlers)('%s refuses an empty reachable set identically', async (...[, handler, args]) => {
    const port = fakeRolePort(doneOutcome());
    const outcome = await handler(principalWith([]), port, fakeGuild(), fakeMembers(), args());
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(port.calls).toBe(0);
  });

  it('a two-guild principal calling the other guild is refused without a port call', async () => {
    for (const [, handler, args] of handlers) {
      const port = fakeRolePort(doneOutcome());
      const outcome = await handler(principalWith([GUILD_B]), port, fakeGuild(), fakeMembers(), args());
      expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
      expect(port.calls).toBe(0);
    }
  });
});

describe('role-write argument boundary (hard rule 3)', () => {
  it.each(handlers)('%s refuses malformed arguments and the port was never called', async (...[, handler, args]) => {
    const cases: ReadonlyArray<Record<string, unknown>> = [
      { ...args(), member: '' },
      { ...args(), member: 'm'.repeat(101) },
      { ...args(), role: '' },
      { ...args(), role: 'r'.repeat(101) },
      { ...args(), idempotencyKey: '' },
      { ...args(), guildId: undefined },
      { ...args(), member: undefined },
      { ...args(), role: undefined },
    ];
    for (const invalid of cases) {
      const port = fakeRolePort(doneOutcome());
      const outcome = await handler(principalWith([GUILD_A]), port, fakeGuild(), fakeMembers(), invalid);
      expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
      expect(port.calls).toBe(0);
    }
  });
});

describe('role-write refs resolve before any port call', () => {
  // A ref goes to Discord only as a resolved snowflake id. A path-traversal
  // string is neither an id nor a known name, so resolution refuses it — the
  // daemon port is never called.
  it.each(handlers)(
    '%s refuses a path-traversal member id with no port call',
    async (...[, handler, args]) => {
      const port = fakeRolePort(doneOutcome());
      const outcome = await handler(principalWith([GUILD_A]), port, fakeGuild(), fakeMembers(), {
        ...args(),
        member: '../../../../guilds/111111111111111111/bans/222222222222222222',
      });
      expect(messageOf(outcome)).toContain('No member');
      expect(port.calls).toBe(0);
    },
  );

  it.each(handlers)(
    '%s refuses a path-traversal role id with no port call',
    async (...[, handler, args]) => {
      const port = fakeRolePort(doneOutcome());
      const outcome = await handler(principalWith([GUILD_A]), port, fakeGuild(), fakeMembers(), {
        ...args(),
        role: '1/../../guilds/111111111111111111',
      });
      expect(messageOf(outcome)).toContain('No role');
      expect(port.calls).toBe(0);
    },
  );

  it('an unknown member id refuses with no port call', async () => {
    const { message, calls } = await callHandler(grantRoleText, grantArgs({ member: '699999999999999999' }));
    expect(message).toContain('No member');
    expect(message).toContain('699999999999999999');
    expect(calls).toBe(0);
  });

  it('an unknown member name refuses with no port call', async () => {
    const { message, calls } = await callHandler(grantRoleText, grantArgs({ member: 'Nobody Here' }));
    expect(message).toContain('No member');
    expect(calls).toBe(0);
  });

  it('an ambiguous member name answers candidates with no port call', async () => {
    const { message, calls } = await callHandler(grantRoleText, grantArgs({ member: 'Sam' }));
    expect(message).toContain('2 members');
    expect(message).toContain(MEMBER);
    expect(message).toContain(MEMBER_TWIN);
    expect(calls).toBe(0);
  });

  it('an unknown role name refuses with no port call', async () => {
    const { message, calls } = await callHandler(grantRoleText, grantArgs({ role: 'janitors' }));
    expect(message).toContain('No role named');
    expect(calls).toBe(0);
  });

  it('an ambiguous role name answers candidates with no port call', async () => {
    const { message, calls } = await callHandler(removeRoleText, removeArgs({ role: 'helpers' }));
    expect(message).toContain('2 roles');
    expect(calls).toBe(0);
  });

  it('a member username and a unique role name resolve to ids at the port', async () => {
    const port = fakeRolePort(doneOutcome());
    const outcome = await grantRoleText(
      principalWith([GUILD_A]),
      port,
      fakeGuild(),
      fakeMembers(),
      grantArgs({ member: 'samwise', role: 'ushers' }),
    );
    expect(outcome.ok).toBe(true);
    expect(port.calls).toBe(1);
    expect(port.lastInput).toMatchObject({ memberId: MEMBER, roleId: '544444444444444444' });
  });
});

describe('role-write refusal rendering', () => {
  const cases: ReadonlyArray<readonly [McpRoleWriteRefusal, string]> = [
    ['unknown-member', 'not in guild'],
    ['unknown-role', 'does not exist'],
    ['role-not-allowlisted', 'not on the bot'],
    ['role-not-permitted', 'grant policy'],
    ['protected-target', 'protected'],
    ['unauthorized', 'roles.mutate'],
    ['killswitch', 'kill switch'],
    ['breaker-open', 'circuit breaker'],
    ['rate-cap', 'budget'],
    ['duplicate-key-different-content', 'different write'],
  ];

  it.each(handlers)(
    '%s renders every refusal distinctly, with ids and no content',
    async (...[, handler, args]) => {
      const texts = new Map<McpRoleWriteRefusal, string>();
      for (const [reason] of cases) {
        const port = fakeRolePort({ status: 'refused', reason, detail: 'above-bot' });
        const outcome = await handler(principalWith([GUILD_A]), port, fakeGuild(), fakeMembers(), args());
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

  it('the grant-policy refusal names the reason: above, managed, dangerous, allowlist', async () => {
    const details: ReadonlyArray<readonly [string, string]> = [
      ['above-bot', 'above the bot'],
      ['managed-or-everyone', 'managed'],
      ['dangerous', 'dangerous'],
      ['not-allowlisted', 'grant allowlist'],
    ];
    const texts = new Set<string>();
    for (const [detail, marker] of details) {
      const port = fakeRolePort({ status: 'refused', reason: 'role-not-permitted', detail });
      const outcome = await grantRoleText(
        principalWith([GUILD_A]),
        port,
        fakeGuild(),
        fakeMembers(),
        grantArgs(),
      );
      const text = messageOf(outcome);
      expect(text).toContain(marker);
      texts.add(text);
    }
    expect(texts.size).toBe(details.length);
  });

  it('the protected-target refusal names the guild owner distinctly', async () => {
    const ownerPort = fakeRolePort({
      status: 'refused',
      reason: 'protected-target',
      detail: 'guild-owner',
    });
    const ownerText = messageOf(
      await grantRoleText(principalWith([GUILD_A]), ownerPort, fakeGuild(), fakeMembers(), grantArgs()),
    );
    expect(ownerText).toContain('guild owner');
    const otherPort = fakeRolePort({ status: 'refused', reason: 'protected-target' });
    const otherText = messageOf(
      await grantRoleText(principalWith([GUILD_A]), otherPort, fakeGuild(), fakeMembers(), grantArgs()),
    );
    expect(otherText).toContain('protected');
    expect(otherText).not.toBe(ownerText);
  });
});

describe('role-write outcomes', () => {
  it('done names the action, the member and the role', async () => {
    const grantPort = fakeRolePort(doneOutcome());
    const granted = textOf(
      await grantRoleText(principalWith([GUILD_A]), grantPort, fakeGuild(), fakeMembers(), grantArgs()),
    );
    expect(granted).toContain(ACTION);
    expect(granted).toContain(MEMBER);
    expect(granted).toContain('Granted');

    const removePort = fakeRolePort(doneOutcome());
    const removed = textOf(
      await removeRoleText(principalWith([GUILD_A]), removePort, fakeGuild(), fakeMembers(), removeArgs()),
    );
    expect(removed).toContain(ACTION);
    expect(removed).toContain('Removed');
  });

  it('a grant that changed nothing answers already had', async () => {
    const port = fakeRolePort({ status: 'done', actionId: ACTION, alreadyHad: true });
    const text = textOf(
      await grantRoleText(principalWith([GUILD_A]), port, fakeGuild(), fakeMembers(), grantArgs()),
    );
    expect(text).toContain('already had');
    expect(text).toContain(ACTION);
  });

  it('a removal that changed nothing answers did not have', async () => {
    const port = fakeRolePort({ status: 'done', actionId: ACTION, alreadyHad: true });
    const text = textOf(
      await removeRoleText(principalWith([GUILD_A]), port, fakeGuild(), fakeMembers(), removeArgs()),
    );
    expect(text).toContain('did not have');
    expect(text).toContain(ACTION);
  });

  it('dry-run records without changing', async () => {
    const port = fakeRolePort({ status: 'dry-run', actionId: ACTION });
    const text = textOf(
      await grantRoleText(principalWith([GUILD_A]), port, fakeGuild(), fakeMembers(), {
        ...grantArgs(),
        dryRun: true,
      }),
    );
    expect(text).toContain('Dry run');
    expect(text).toContain(ACTION);
    expect(port.lastInput).toMatchObject({ dryRun: true });
  });

  it('replayed answers without a new change', async () => {
    const port = fakeRolePort({ status: 'replayed', actionId: ACTION });
    const text = textOf(
      await removeRoleText(principalWith([GUILD_A]), port, fakeGuild(), fakeMembers(), removeArgs()),
    );
    expect(text).toContain('Already recorded under this idempotency key');
    expect(text).toContain(ACTION);
  });

  it('failed reports an unknown result with the same key to retry on', async () => {
    const port = fakeRolePort({ status: 'failed' });
    const text = messageOf(
      await grantRoleText(principalWith([GUILD_A]), port, fakeGuild(), fakeMembers(), grantArgs()),
    );
    expect(text).toContain('same idempotency key');
  });

  it.each(handlers)('%s never throws: a port fault is the shared refusal', async (...[, handler, args]) => {
    const failing: McpRoleWritesPort = {
      grant: () => Promise.reject(new Error('discord is down')),
      remove: () => Promise.reject(new Error('discord is down')),
    };
    const outcome = await handler(principalWith([GUILD_A]), failing, fakeGuild(), fakeMembers(), args());
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });
});

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
const stubRoleWrites = (): McpRoleWritesPort =>
  fakeRolePort({ status: 'done', actionId: 'act-test', alreadyHad: false });
const stubJobs = (): McpJobsPort => ({
  listJobs: () => [],
  findJob: () => undefined,
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
  const client = new Client({ name: 'mcp-role-writes-test-client', version: '0.0.0' });
  const server = createMcpServer({
    principal,
    health: stubHealth(),
    archive: stubArchive(),
    guild: fakeGuild(),
    records: stubRecords(),
    send: stubSend(),
    messageWrites: stubMessageWrites(),
    threadWrites: stubThreadWrites(),
    roleWrites: stubRoleWrites(),
    readAudit: noopReadAudit,
    jobs: stubJobs(),
    members: fakeMembers(),
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

describe('role-write scope filtering (ruling M4-D17, ADR 0114)', () => {
  it('a roles-scope token sees exactly grant_role and remove_role', async () => {
    const { client, close } = await connectPair(principalWith([GUILD_A], ['bananasaurs:roles']));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual([GRANT_ROLE_TOOL_NAME, REMOVE_ROLE_TOOL_NAME]);
    } finally {
      await close();
    }
  });

  it('a read-only token sees neither role tool', async () => {
    const { client, close } = await connectPair(principalWith([GUILD_A], ['bananasaurs:read']));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain(GRANT_ROLE_TOOL_NAME);
      expect(names).not.toContain(REMOVE_ROLE_TOOL_NAME);
    } finally {
      await close();
    }
  });

  it('a send-only token sees neither role tool', async () => {
    const { client, close } = await connectPair(principalWith([GUILD_A], ['bananasaurs:send']));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain(GRANT_ROLE_TOOL_NAME);
      expect(names).not.toContain(REMOVE_ROLE_TOOL_NAME);
    } finally {
      await close();
    }
  });
});
