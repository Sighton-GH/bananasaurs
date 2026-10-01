import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import {
  accountRepo,
  authzRepo,
  effectRepo,
  guildRepo,
  loggingRepo,
  panelRepo,
  roleRepo,
} from '@bananasaurs/storage';
import { panelDefinitionSchema, parseGuildId, type Capability } from '@bananasaurs/core';
import { createServer, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerReadRoutes } from './read.js';

const GUILD = parseGuildId('111111111111111111');
const OTHER_GUILD = parseGuildId('222222222222222222');
const PASSWORD = 'correct horse battery staple';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';

let t: MigratedTestDatabase;
let clock: number;
let deps: HttpDeps;
let app: FastifyInstance;

const buildApp = (): FastifyInstance => createServer({ deps, registerRoutes: registerReadRoutes });

/** Grants exactly the given capabilities — the rest stay unheld. */
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
  guildRepo.upsertGuild(t.scopes.forGuild(OTHER_GUILD), { name: 'other guild', now: clock });

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

const readRouteCases: readonly (readonly [string, string, Capability])[] = [
  ['GET /api/health', '/api/health', 'config.read'],
  ['GET /api/log-routes', '/api/log-routes', 'logging.manage'],
  ['GET /api/panels', '/api/panels', 'panels.manage'],
  ['GET /api/audit', '/api/audit', 'audit.read'],
  ['GET /api/jobs', '/api/jobs', 'config.read'],
];

describe.each(readRouteCases)('%s', (_name, url, capability) => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(401);
  });

  it(`answers 403 no-grant without ${capability}`, async () => {
    // Every other capability granted, deliberately, so the failure can only be
    // this one route's missing check — not a session with no grants at all.
    grant(
      (
        ['config.read', 'logging.manage', 'panels.manage', 'audit.read'] as readonly Capability[]
      ).filter((c) => c !== capability),
    );
    const { cookie } = await signIn();
    const response = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'no-grant' });
  });

  it('answers 200 once granted', async () => {
    grant([capability]);
    const { cookie } = await signIn();
    const response = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(response.statusCode).toBe(200);
  });
});

describe('GET /api/health', () => {
  it('reports gateway, safety, job counts and scheduler lag', async () => {
    grant(['config.read']);
    const { cookie } = await signIn();
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: { cookie } });
    const body = response.json<{
      guildId: string;
      guildName: string | null;
      gateway: unknown;
      safety: { killswitch: boolean };
      jobCounts: unknown;
      oldestDueJobAtMs: number | undefined;
    }>();
    // A health page that cannot say which guild it is looking at cannot be
    // told apart from any other instance's — found live in the Release 1
    // smoke test, where the dashboard rendered no guild identity at all.
    expect(body.guildId).toBe(GUILD);
    expect(body.guildName).toBe('guild');
    expect(body.gateway).toBeDefined();
    expect(body.safety.killswitch).toBe(false);
    expect(body.jobCounts).toBeDefined();
  });
});

describe('GET /api/log-routes — routes with kinds and exclusions plus excludedChannels', () => {
  it('lists every route with its kinds and exclusions, and the guild-wide list beside it', async () => {
    grant(['logging.manage']);
    loggingRepo.createRoute(t.scopes.forGuild(GUILD), {
      name: 'mod log',
      channelId: '444444444444444444',
      includeContent: true,
      enabled: true,
      eventKinds: ['member_leave', 'member_join'],
      excludedChannelIds: ['555555555555555555'],
      nowMs: clock,
    });
    loggingRepo.excludeChannel(t.scopes.forGuild(GUILD), '666666666666666666');

    const { cookie } = await signIn();
    const response = await app.inject({ method: 'GET', url: '/api/log-routes', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      routes: {
        routeId: string;
        name: string;
        channelId: string;
        eventKinds: string[];
        excludedChannelIds: string[];
      }[];
      excludedChannels: string[];
    }>();
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0]).toMatchObject({
      name: 'mod log',
      channelId: '444444444444444444',
      eventKinds: ['member_join', 'member_leave'],
      excludedChannelIds: ['555555555555555555'],
    });
    expect(body.excludedChannels).toEqual(['666666666666666666']);
  });
});

describe('GET /api/panels/:id', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/panels/nope' });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 without panels.manage', async () => {
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/panels/nope',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('answers 404 for an unknown panel id', async () => {
    grant(['panels.manage']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/panels/nope',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/audit — guild scope comes from session.scope, not the request', () => {
  it('never returns another guild’s audit rows', async () => {
    grant(['audit.read']);
    effectRepo.recordAudit(t.scopes.forGuild(OTHER_GUILD), {
      at: clock,
      actorType: 'operator_cli',
      actorId: undefined,
      actorUnixUserClaimed: 'someone',
      via: 'ssh',
      action: 'killswitch.enabled',
      subjectType: 'guild',
      subjectId: OTHER_GUILD,
      dryRun: false,
    });
    effectRepo.recordAudit(t.scopes.forGuild(GUILD), {
      at: clock,
      actorType: 'operator_cli',
      actorId: undefined,
      actorUnixUserClaimed: 'someone',
      via: 'ssh',
      action: 'killswitch.enabled',
      subjectType: 'guild',
      subjectId: GUILD,
      dryRun: false,
    });

    const { cookie } = await signIn();
    const response = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } });
    const rows = response.json<{ subjectId: string }[]>();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subjectId).toBe(GUILD);
  });

  it('rejects a query parameter that is not a number', async () => {
    grant(['audit.read']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/audit?limit=not-a-number',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/panels — guild scope comes from session.scope, not the request', () => {
  const ROLE = '444444444444444444';

  const panelDefinition = panelDefinitionSchema.parse({
    panelId: 'roles',
    kind: 'managed',
    component: 'button',
    behaviour: 'toggle',
    channelId: '333333333333333333',
    options: [{ optionId: 'a', roleId: ROLE, label: 'A', position: 0 }],
  });

  it('never returns another guild’s panels', async () => {
    grant(['panels.manage']);
    roleRepo.allowlistRole(t.scopes.forGuild(OTHER_GUILD), ROLE);
    panelRepo.createPanel(t.scopes.forGuild(OTHER_GUILD), panelDefinition, clock);

    const { cookie } = await signIn();
    const response = await app.inject({ method: 'GET', url: '/api/panels', headers: { cookie } });
    expect(response.json<unknown[]>()).toHaveLength(0);
  });

  it('returns this guild’s own panel', async () => {
    grant(['panels.manage']);
    roleRepo.allowlistRole(t.scopes.forGuild(GUILD), ROLE);
    panelRepo.createPanel(t.scopes.forGuild(GUILD), panelDefinition, clock);

    const { cookie } = await signIn();
    const response = await app.inject({ method: 'GET', url: '/api/panels', headers: { cookie } });
    const panels = response.json<{ panelId: string }[]>();
    expect(panels).toHaveLength(1);
    expect(panels[0]?.panelId).toBe('roles');
  });
});
