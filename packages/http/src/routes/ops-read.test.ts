import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, guildRepo, jobRepo } from '@bananasaurs/storage';
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
        { channelId: '333333333333333333', name: 'general', kind: 'text' },
        { channelId: '444444444444444444', name: 'mod-log', kind: 'text' },
        { channelId: '555555555555555555', name: 'announcements', kind: 'announcement' },
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
        { roleId: '666666666666666666', name: 'Mod', colour: 0x3498db, position: 3, managed: false },
        { roleId: '777777777777777777', name: 'Member', colour: 0, position: 1, managed: false },
        {
          roleId: '888888888888888888',
          name: 'Bananasaurs',
          colour: 0xf1c40f,
          position: 4,
          managed: true,
        },
      ],
    });
  });
});
