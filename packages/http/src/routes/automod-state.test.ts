import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, effectRepo, guildRepo } from '@bananasaurs/storage';
import { parseGuildId, type Capability, type GuildId } from '@bananasaurs/core';
import { createServer, CSRF_HEADER, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { POLICY } from '../policy.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAutomodStateRoutes } from './automod-state.js';

const GUILD = parseGuildId('111111111111111111');
const OTHER_GUILD = parseGuildId('222222222222222222');
const PASSWORD = 'correct horse battery staple';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';

let t: MigratedTestDatabase;
let clock: number;
let deps: HttpDeps;
let app: FastifyInstance;

const buildApp = (): FastifyInstance =>
  createServer({ deps, registerRoutes: registerAutomodStateRoutes });

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

const auditActions = (): readonly string[] =>
  effectRepo
    .tailAudit(t.scopes.forGuild(GUILD), { limit: 50, sinceMs: undefined })
    .map((row) => row.action);

const createKindRule = (guild: GuildId, ruleId: string, enabled: boolean): void => {
  testPortsFor(t.scopes.forGuild(guild), () => clock).createAutomodRule({
    ruleId,
    kind: 'keyword_filter',
    name: ruleId,
    config: '{}',
  });
  if (!enabled) {
    testPortsFor(t.scopes.forGuild(guild), () => clock).setAutomodRuleEnabled({
      ruleId,
      enabled: false,
    });
  }
};

describe('GET /api/automod/state', () => {
  it('a. answers 401 with no session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/automod/state' });
    expect(response.statusCode).toBe(401);
  });

  it('b. answers 403 no-grant without config.read', async () => {
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/automod/state',
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(response.statusCode).toBe(403);
  });

  it('c. reports the current position (default off)', async () => {
    grant(['config.read']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/automod/state',
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      state: 'off',
      dryRun: true,
      killswitch: false,
      enabledRules: [],
    });
  });

  it('d. names only the enabled rules of this guild', async () => {
    grant(['config.read']);
    createKindRule(GUILD, 'kw-one', true);
    createKindRule(GUILD, 'kw-two', false);
    createKindRule(OTHER_GUILD, 'kw-other', true);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/automod/state',
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      state: 'off',
      dryRun: true,
      killswitch: false,
      enabledRules: [{ ruleId: 'kw-one', name: 'kw-one' }],
    });
  });

  it('d2. reports killswitch true after the guild killswitch is set', async () => {
    grant(['config.read']);
    guildRepo.setKillswitch(t.scopes.forGuild(GUILD), true, clock);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/automod/state',
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ killswitch: true, dryRun: true, state: 'off' });
  });
});

describe('PUT /api/automod/state', () => {
  it('e. answers 400 for a position that is not off, watch or on', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/state',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { state: 'enforce' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'bad-request' });
  });

  it('f. moves off to watch and records one audit row', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/state',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { state: 'watch' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, state: 'watch' });
    expect(guildRepo.readSafetyState(t.scopes.forGuild(GUILD))?.automodState).toBe('watch');

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), {
      limit: 10,
      sinceMs: undefined,
    });
    const row = rows.find((r) => r.action === 'automod.state_set');
    expect(row?.actorType).toBe('dashboard');
    expect(row?.subjectType).toBe('guild');
    expect(row?.subjectId).toBe(GUILD);
    expect(JSON.parse(row?.before ?? 'null')).toEqual({ state: 'off' });
    expect(JSON.parse(row?.after ?? 'null')).toEqual({ state: 'watch' });
  });

  it('g. refuses a stale more-action move with reauth-required and changes nothing', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    clock += POLICY.reauthWindowMs + 1;
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/state',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { state: 'on' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'reauth-required' });
    expect(guildRepo.readSafetyState(t.scopes.forGuild(GUILD))?.automodState).toBe('off');
    expect(auditActions()).not.toContain('automod.state_set');
  });

  it('h. allows a stale less-action move without a fresh password', async () => {
    grant(['config.write']);
    guildRepo.setAutomodState(t.scopes.forGuild(GUILD), 'on', clock);
    const { cookie, csrf } = await signIn();
    clock += POLICY.reauthWindowMs + 1;
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/state',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { state: 'watch' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, state: 'watch' });
    expect(guildRepo.readSafetyState(t.scopes.forGuild(GUILD))?.automodState).toBe('watch');

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), {
      limit: 10,
      sinceMs: undefined,
    });
    expect(rows.find((r) => r.action === 'automod.state_set')).toBeDefined();
  });

  it('h2. allows a stale on-to-off move without a fresh password', async () => {
    grant(['config.write']);
    guildRepo.setAutomodState(t.scopes.forGuild(GUILD), 'on', clock);
    const { cookie, csrf } = await signIn();
    clock += POLICY.reauthWindowMs + 1;
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/state',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { state: 'off' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, state: 'off' });
    expect(guildRepo.readSafetyState(t.scopes.forGuild(GUILD))?.automodState).toBe('off');
  });

  it('f2. moves off to on with a fresh session and records exactly one audit row', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/state',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { state: 'on' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, state: 'on' });
    expect(guildRepo.readSafetyState(t.scopes.forGuild(GUILD))?.automodState).toBe('on');

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), {
      limit: 10,
      sinceMs: undefined,
    });
    const matches = rows.filter((r) => r.action === 'automod.state_set');
    expect(matches).toHaveLength(1);
    expect(JSON.parse(matches[0]?.before ?? 'null')).toEqual({ state: 'off' });
    expect(JSON.parse(matches[0]?.after ?? 'null')).toEqual({ state: 'on' });
  });

  it('e2. answers 400 for an empty body', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/state',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'bad-request' });
  });

  it('i. re-sending the current position succeeds and writes no audit row', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    clock += POLICY.reauthWindowMs + 1;
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/state',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { state: 'off' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, state: 'off' });
    expect(auditActions()).not.toContain('automod.state_set');
  });

  it('j. answers 403 no-grant without config.write and changes nothing', async () => {
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/state',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { state: 'watch' },
    });
    expect(response.statusCode).toBe(403);
    expect(guildRepo.readSafetyState(t.scopes.forGuild(GUILD))?.automodState).toBe('off');
    expect(auditActions()).not.toContain('automod.state_set');
  });

  it('j2. answers 403 without config.write even when re-sending the current state', async () => {
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/state',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { state: 'off' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('k. is guild-scoped: a change in one guild does not move the other', async () => {
    grant(['config.write'], GUILD);
    grant(['config.write'], OTHER_GUILD);
    const { cookie, csrf } = await signIn(GUILD);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/state',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { state: 'watch' },
    });
    expect(response.statusCode).toBe(200);
    expect(guildRepo.readSafetyState(t.scopes.forGuild(GUILD))?.automodState).toBe('watch');
    expect(guildRepo.readSafetyState(t.scopes.forGuild(OTHER_GUILD))?.automodState).toBe('off');
  });
});
