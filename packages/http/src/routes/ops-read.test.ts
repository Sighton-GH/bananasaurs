import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, guildRepo, jobRepo, mcpSendRepo } from '@bananasaurs/storage';
import { parseGuildId, type Capability } from '@bananasaurs/core';
import { createServer, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerOpsReadRoutes } from './ops-read.js';

const GUILD = parseGuildId('111111111111111111');
const PASSWORD = 'correct horse battery staple';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';

let t: MigratedTestDatabase;
let clock: number;
let deps: HttpDeps;
let app: FastifyInstance;

const buildApp = (): FastifyInstance =>
  createServer({ deps, registerRoutes: registerOpsReadRoutes });

const grant = (capabilities: readonly Capability[]): void => {
  const scope = t.scopes.forGuild(GUILD);
  for (const capability of capabilities) {
    authzRepo.grantAccountCapability(scope, {
      accountId: ACCOUNT,
      capability,
      grantedBy: 'test',
      now: clock,
    });
  }
};

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  deps = {
    scopes: t.scopes,
    now: () => clock,
    guildIds: [GUILD],
    logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never,
    readonly: false,
    portsFor: (scope) => testPortsFor(scope, () => clock),
    instance: testInstanceFor(t.scopes.instance(), () => clock),
  };
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'guild', now: clock });

  const instance = t.scopes.instance();
  accountRepo.createAccount(instance, {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), ACCOUNT);

  app = buildApp();
});

afterEach(async () => {
  await app.close();
  t.close();
});

const cookieFrom = (header: string | string[] | undefined): string => {
  const raw = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  return raw.split(';')[0] ?? '';
};

const signIn = async (): Promise<{ cookie: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'owner', password: PASSWORD },
  });
  return { cookie: cookieFrom(response.headers['set-cookie']) };
};

const GUILD_ROUTES = [
  '/api/guild/channels',
  '/api/guild/roles',
  '/api/guild/members',
  '/api/archive/channels/333333333333333333/messages',
  '/api/archive/messages/900000000000000002',
  '/api/archive/status',
  '/api/archive/search?q=hello',
  '/api/send-allowlist',
  '/api/mcp/sends',
] as const;

const INSTANCE_ROUTES = [
  '/api/doctor',
  '/api/doctor/public-surface',
  '/api/backups',
  '/api/config',
  '/api/accounts',
  '/api/mcp/clients',
  '/api/mcp/tokens',
  '/api/providers/eligibility',
] as const;

describe('ops-read routes', () => {
  it('answers 401 without a session on every route', async () => {
    for (const url of ['/api/jobs/1', ...GUILD_ROUTES, ...INSTANCE_ROUTES]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('answers 403 no-grant without the capability on every route', async () => {
    const { cookie } = await signIn();
    for (const url of ['/api/jobs/1', ...GUILD_ROUTES, ...INSTANCE_ROUTES]) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode, url).toBe(403);
      expect(response.json(), url).toEqual({ error: 'no-grant' });
    }
  });

  it('answers 200 with the granted capability on every route', async () => {
    const { cookie } = await signIn();
    grant(['config.read', 'audit.read']);
    for (const url of [...GUILD_ROUTES, ...INSTANCE_ROUTES]) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode, url).toBe(200);
    }
  });

  it('keeps archive search under audit.read, not config.read', async () => {
    const { cookie } = await signIn();
    grant(['config.read']);
    const response = await app.inject({
      method: 'GET',
      url: '/api/archive/search?q=hello',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('returns the job when it exists', async () => {
    const { cookie } = await signIn();
    grant(['config.read']);
    const enqueued = jobRepo.enqueue(t.scopes.forGuild(GUILD), {
      kind: 'panel_reconcile',
      payload: '{}',
      dedupeKey: 'test-job',
      now: clock,
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${enqueued.jobId ?? 0}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body: { kind: string } = response.json();
    expect(body.kind).toBe('panel_reconcile');
  });

  it('answers 404 for a job that does not exist', async () => {
    const { cookie } = await signIn();
    grant(['config.read']);
    const response = await app.inject({
      method: 'GET',
      url: '/api/jobs/999999',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not-found' });
  });

  it('answers 400 for a malformed job id and a missing search query', async () => {
    const { cookie } = await signIn();
    grant(['config.read', 'audit.read']);
    const badJob = await app.inject({
      method: 'GET',
      url: '/api/jobs/abc',
      headers: { cookie },
    });
    expect(badJob.statusCode).toBe(400);
    const noQuery = await app.inject({
      method: 'GET',
      url: '/api/archive/search',
      headers: { cookie },
    });
    expect(noQuery.statusCode).toBe(400);
  });

  it('returns the archive status shape and the instance listings', async () => {
    const { cookie } = await signIn();
    grant(['config.read', 'audit.read']);

    const status = await app.inject({
      method: 'GET',
      url: '/api/archive/status',
      headers: { cookie },
    });
    expect(status.json()).toEqual({
      channels: [],
      index: { indexed: 0, rows: 0 },
    });

    const accounts = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { cookie },
    });
    const accountBody: {
      accounts: { accountId: string; username: string; isOwner: boolean }[];
      capabilities: Record<string, readonly string[]>;
    } = accounts.json();
    expect(accountBody.accounts.map((a) => a.username)).toContain('owner');
    // CLI `account grant` parity, read half: the dashboard shows which
    // capabilities each account holds IN THIS GUILD.
    expect(accountBody.capabilities).toBeDefined();

    const search = await app.inject({
      method: 'GET',
      url: '/api/archive/search?q=hello',
      headers: { cookie },
    });
    expect(search.json()).toEqual({ hits: [], total: 0 });
  });
});

describe('GET /api/accounts capabilities map', () => {
  it('lists the capabilities each account holds in this guild', async () => {
    const { cookie } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    // The caller needs config.read to reach the route at all; the audit.read
    // row is the grant the map is expected to surface.
    for (const capability of ['config.read', 'audit.read'] as const) {
      authzRepo.grantAccountCapability(scope, {
        accountId: ACCOUNT,
        capability,
        grantedBy: 'test',
        now: clock,
      });
    }

    const response = await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body: { capabilities: Record<string, readonly string[]> } = response.json();
    expect(body.capabilities[ACCOUNT]).toContain('audit.read');
  });
});

describe('GET /api/guild/channels', () => {
  it('answers the guild channel list with names and kinds for the pickers', async () => {
    const { cookie } = await signIn();
    grant(['config.read']);
    const response = await app.inject({
      method: 'GET',
      url: '/api/guild/channels',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      channels: [
        {
          channelId: '333333333333333333',
          name: 'general',
          kind: 'text',
          parentId: '999999999999999999',
        },
        { channelId: '444444444444444444', name: 'mod-log', kind: 'text' },
        { channelId: '555555555555555555', name: 'announcements', kind: 'announcement' },
        { channelId: '999999999999999999', name: 'Community', kind: 'category' },
      ],
    });
  });
});

describe('GET /api/guild/roles', () => {
  it('answers the guild role list with colour, rank and managed flags for the pickers', async () => {
    const { cookie } = await signIn();
    grant(['config.read']);
    const response = await app.inject({
      method: 'GET',
      url: '/api/guild/roles',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      roles: [
        // The fixture bot role sits at position 4: Mod and Member are below
        // it and selectable (saving a panel allowlists them); Admin sits
        // above the bot and the bot's own role is Discord-managed, so those
        // two stay unselectable — the join is real.
        {
          roleId: '666666666666666666',
          name: 'Mod',
          colour: 0x3498db,
          position: 3,
          managed: false,
          manageable: true,
          allowlisted: false,
          optionable: true,
        },
        {
          roleId: '777777777777777777',
          name: 'Member',
          colour: 0,
          position: 1,
          managed: false,
          manageable: true,
          allowlisted: false,
          optionable: true,
        },
        {
          roleId: '111111111111111119',
          name: 'Admin',
          colour: 0,
          position: 5,
          managed: false,
          manageable: false,
          allowlisted: false,
          optionable: false,
        },
        {
          roleId: '888888888888888888',
          name: 'Bananasaurs',
          colour: 0xf1c40f,
          position: 4,
          managed: true,
          manageable: false,
          allowlisted: false,
          optionable: false,
        },
      ],
    });
  });
});

describe('GET /api/guild/members', () => {
  it('answers the first page of the member directory with joined dates', async () => {
    const { cookie } = await signIn();
    grant(['audit.read']);
    const response = await app.inject({
      method: 'GET',
      url: '/api/guild/members',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      members: [
        {
          memberId: '100000000000000001',
          username: 'bryan',
          displayName: 'Bryan',
          roleIds: ['666666666666666666'],
          joinedAt: 1_600_000_000_000,
        },
        {
          memberId: '100000000000000002',
          username: 'sasha',
          displayName: 'Sasha',
          roleIds: ['777777777777777777'],
          joinedAt: 1_650_000_000_000,
        },
        {
          memberId: '100000000000000003',
          username: 'kai',
          displayName: 'Kai',
          roleIds: [],
          joinedAt: null,
        },
      ],
      nextAfter: undefined,
    });
  });

  it('walks the cursor: after continues past that member', async () => {
    const { cookie } = await signIn();
    grant(['audit.read']);
    const response = await app.inject({
      method: 'GET',
      url: '/api/guild/members?after=100000000000000001',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body: { members: { memberId: string }[] } = response.json();
    expect(body.members.map((m) => m.memberId)).toEqual([
      '100000000000000002',
      '100000000000000003',
    ]);
  });

  it('honours a limit and carries the next cursor on a full page', async () => {
    const { cookie } = await signIn();
    grant(['audit.read']);
    const response = await app.inject({
      method: 'GET',
      url: '/api/guild/members?limit=2',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body: { members: { memberId: string }[]; nextAfter?: string } = response.json();
    expect(body.members).toHaveLength(2);
    expect(body.nextAfter).toBe('100000000000000002');
  });

  it('answers 400 invalid-query for a bad cursor or limit', async () => {
    const { cookie } = await signIn();
    grant(['audit.read']);
    for (const url of [
      '/api/guild/members?after=nope',
      '/api/guild/members?limit=0',
      '/api/guild/members?limit=101',
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode, url).toBe(400);
      expect(response.json(), url).toEqual({ error: 'invalid-query' });
    }
  });
});

describe('GET /api/mcp/sends (bounded ledger, audit S1)', () => {
  const seedSends = (count: number): void => {
    const scope = t.scopes.forGuild(GUILD);
    for (let i = 0; i < count; i += 1) {
      mcpSendRepo.claimSend(scope, {
        idempotencyKey: `k${String(i)}`,
        channelId: '333333333333333333',
        contentHash: `h${String(i)}`,
        tokenId: 't1',
        now: clock - i * 1000,
        outcome: 'sent',
      });
    }
  };

  it('defaults to the newest 25 rows, honours an explicit limit, and rejects a bad one', async () => {
    seedSends(30);
    const { cookie } = await signIn();
    grant(['audit.read']);

    const unbounded = await app.inject({
      method: 'GET',
      url: '/api/mcp/sends',
      headers: { cookie },
    });
    expect(unbounded.statusCode).toBe(200);
    const body: { sends: unknown[] } = unbounded.json();
    expect(body.sends).toHaveLength(25);

    const five = await app.inject({
      method: 'GET',
      url: '/api/mcp/sends?limit=5',
      headers: { cookie },
    });
    const fiveBody: { sends: unknown[] } = five.json();
    expect(fiveBody.sends).toHaveLength(5);

    const overCap = await app.inject({
      method: 'GET',
      url: '/api/mcp/sends?limit=201',
      headers: { cookie },
    });
    expect(overCap.statusCode).toBe(400);
  });
});

describe('GET /api/archive/channels/:channelId/messages (read_channel_history parity)', () => {
  it('answers the newest archived messages first, tombstones included', async () => {
    const { cookie } = await signIn();
    grant(['audit.read']);
    const response = await app.inject({
      method: 'GET',
      url: '/api/archive/channels/333333333333333333/messages',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body: { messages: { messageId: string; content: string | null }[] } = response.json();
    expect(body.messages.map((m) => m.messageId)).toEqual([
      '900000000000000002',
      '900000000000000001',
    ]);
    // The purged message is a tombstone: metadata intact, content null.
    expect(body.messages[1]?.content).toBeNull();
  });

  it('pages with the before cursor and honours limit', async () => {
    const { cookie } = await signIn();
    grant(['audit.read']);
    const response = await app.inject({
      method: 'GET',
      url: '/api/archive/channels/333333333333333333/messages?before=900000000000000002&limit=5',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body: { messages: { messageId: string }[] } = response.json();
    expect(body.messages.map((m) => m.messageId)).toEqual(['900000000000000001']);
  });

  it('answers empty, not an error, for a channel outside the archive-enabled set', async () => {
    const { cookie } = await signIn();
    grant(['audit.read']);
    const response = await app.inject({
      method: 'GET',
      url: '/api/archive/channels/444444444444444444/messages',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ messages: [] });
  });

  it('answers 400 invalid-query for a bad cursor or limit', async () => {
    const { cookie } = await signIn();
    grant(['audit.read']);
    for (const url of [
      '/api/archive/channels/nope/messages',
      '/api/archive/channels/333333333333333333/messages?before=nope',
      '/api/archive/channels/333333333333333333/messages?limit=0',
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode, url).toBe(400);
      expect(response.json(), url).toEqual({ error: 'invalid-query' });
    }
  });
});

describe('GET /api/archive/messages/:messageId (get_message parity)', () => {
  it('answers the archived message', async () => {
    const { cookie } = await signIn();
    grant(['audit.read']);
    const response = await app.inject({
      method: 'GET',
      url: '/api/archive/messages/900000000000000002',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      messageId: '900000000000000002',
      content: 'Movie night poll is up in the roles channel.',
    });
  });

  it('answers 404 for an unknown message', async () => {
    const { cookie } = await signIn();
    grant(['audit.read']);
    const response = await app.inject({
      method: 'GET',
      url: '/api/archive/messages/900000000000000009',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not-found' });
  });
});
