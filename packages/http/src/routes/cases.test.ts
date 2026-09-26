import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, guildRepo, modCaseRepo } from '@bananasaurs/storage';
import { parseGuildId, type Capability } from '@bananasaurs/core';
import { createServer, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerCaseRoutes } from './cases.js';

const GUILD = parseGuildId('111111111111111111');
const OTHER_GUILD = parseGuildId('222222222222222222');
const PASSWORD = 'correct horse battery staple';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const MEMBER = '555555555555555555';
const OTHER_MEMBER = '666666666666666666';

let t: MigratedTestDatabase;
let clock: number;
let deps: HttpDeps;
let app: FastifyInstance;

const buildApp = (): FastifyInstance => createServer({ deps, registerRoutes: registerCaseRoutes });

const grant = (capabilities: readonly Capability[], guild = GUILD): void => {
  const scope = t.scopes.forGuild(guild);
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
    guildIds: [GUILD, OTHER_GUILD],
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
  accountRepo.grantGuildAccess(t.scopes.forGuild(OTHER_GUILD), ACCOUNT);

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

const signIn = async (
  guildId: string = GUILD,
  target = app,
): Promise<{ cookie: string; csrf: string }> => {
  const response = await target.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'owner', password: PASSWORD, guildId },
  });
  const body = response.json<{ csrfToken: string }>();
  return { cookie: cookieFrom(response.headers['set-cookie']), csrf: body.csrfToken };
};

const openCase = (memberId: string = MEMBER, guild = GUILD): string =>
  modCaseRepo.openOrResolveCase(t.scopes.forGuild(guild), { memberId, now: clock }).caseId;

const recordEvent = (caseId: string, memberId: string = MEMBER, guild = GUILD): string => {
  const eventId = randomUUID();
  modCaseRepo.recordCaseEvent(t.scopes.forGuild(guild), {
    eventId,
    caseId,
    ruleId: 'kw-one',
    memberId,
    at: clock,
    matchedCategory: 'slur',
    matchedSnippet: 'the matched text',
    actionTaken: 'would_delete',
  });
  return eventId;
};

describe('GET /api/mod/cases', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/mod/cases' });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 no-grant without audit.read', async () => {
    grant(['config.read']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/mod/cases',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'no-grant' });
  });

  it('lists the newest cases first', async () => {
    grant(['audit.read']);
    const first = openCase(MEMBER);
    clock += 1_000;
    const second = openCase(OTHER_MEMBER);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/mod/cases',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ cases: { caseId: string }[] }>();
    expect(body.cases.map((c) => c.caseId)).toEqual([second, first]);
  });

  it('honours limit', async () => {
    grant(['audit.read']);
    openCase(MEMBER);
    openCase(OTHER_MEMBER);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/mod/cases?limit=1',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ cases: unknown[] }>().cases).toHaveLength(1);
  });

  it('answers 400 for limit=0', async () => {
    grant(['audit.read']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/mod/cases?limit=0',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers 400 for limit=abc', async () => {
    grant(['audit.read']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/mod/cases?limit=abc',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it('sees nothing from the other guild', async () => {
    grant(['audit.read']);
    grant(['audit.read'], OTHER_GUILD);
    openCase(MEMBER);
    const { cookie } = await signIn(OTHER_GUILD);
    const response = await app.inject({
      method: 'GET',
      url: '/api/mod/cases',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cases: [] });
  });
});

describe('GET /api/mod/cases/:caseId', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/mod/cases/${randomUUID()}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 no-grant without audit.read', async () => {
    grant(['config.read']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: `/api/mod/cases/${randomUUID()}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'no-grant' });
  });

  it('returns the case with its events and member', async () => {
    grant(['audit.read']);
    const caseId = openCase();
    const eventId = recordEvent(caseId);
    const originalPortsFor = deps.portsFor;
    deps = {
      ...deps,
      portsFor: (scope) => ({
        ...originalPortsFor(scope),
        fetchGuildMembers: (memberIds) =>
          Promise.resolve(
            memberIds.includes(MEMBER)
              ? [
                  {
                    memberId: MEMBER,
                    username: 'case-member',
                    displayName: 'Case Member',
                    roleIds: [],
                    joinedAt: clock,
                  },
                ]
              : [],
          ),
      }),
    };
    await app.close();
    app = buildApp();
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: `/api/mod/cases/${caseId}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      case: expect.objectContaining({
        caseId,
        memberId: MEMBER,
        status: 'open',
        member: expect.objectContaining({
          memberId: MEMBER,
          username: 'case-member',
          displayName: 'Case Member',
        }),
      }),
      events: [expect.objectContaining({ eventId, caseId, ruleId: 'kw-one' })],
    });
  });

  it('answers 404 for an unknown case', async () => {
    grant(['audit.read']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: `/api/mod/cases/${randomUUID()}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('answers 400 for a malformed case id', async () => {
    grant(['audit.read']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/mod/cases/not-a-uuid',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers 404 for a case in the other guild (guild scope)', async () => {
    grant(['audit.read']);
    grant(['audit.read'], OTHER_GUILD);
    const caseId = openCase();
    const { cookie } = await signIn(OTHER_GUILD);
    const response = await app.inject({
      method: 'GET',
      url: `/api/mod/cases/${caseId}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/mod/members/:memberId/cases', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/mod/members/${MEMBER}/cases`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 no-grant without audit.read', async () => {
    grant(['config.read']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: `/api/mod/members/${MEMBER}/cases`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'no-grant' });
  });

  it('lists every case for the member', async () => {
    grant(['audit.read']);
    const caseId = openCase();
    openCase(OTHER_MEMBER);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: `/api/mod/members/${MEMBER}/cases`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      cases: [expect.objectContaining({ caseId, memberId: MEMBER })],
    });
  });

  it('answers 400 for a malformed member id', async () => {
    grant(['audit.read']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/mod/members/not-a-snowflake/cases',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it('sees nothing from the other guild', async () => {
    grant(['audit.read']);
    grant(['audit.read'], OTHER_GUILD);
    openCase();
    const { cookie } = await signIn(OTHER_GUILD);
    const response = await app.inject({
      method: 'GET',
      url: `/api/mod/members/${MEMBER}/cases`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cases: [] });
  });
});
