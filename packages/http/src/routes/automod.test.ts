import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, automodAdminRepo, effectRepo, guildRepo } from '@bananasaurs/storage';
import { parseGuildId, type Capability } from '@bananasaurs/core';
import { createServer, CSRF_HEADER, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { POLICY } from '../policy.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAutomodRoutes } from './automod.js';

const GUILD = parseGuildId('111111111111111111');
const OTHER_GUILD = parseGuildId('222222222222222222');
const PASSWORD = 'correct horse battery staple';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const ROLE = '333333333333333333';
const CHANNEL = '444444444444444444';

let t: MigratedTestDatabase;
let clock: number;
let deps: HttpDeps;
let app: FastifyInstance;

const buildApp = (): FastifyInstance =>
  createServer({ deps, registerRoutes: registerAutomodRoutes });

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

const createRule = (ruleId = 'kw-one'): void => {
  testPortsFor(t.scopes.forGuild(GUILD), () => clock).createAutomodRule({
    ruleId,
    kind: 'keyword_filter',
    name: 'Keyword one',
    config: '{}',
  });
};

const auditActions = (): readonly string[] =>
  effectRepo
    .tailAudit(t.scopes.forGuild(GUILD), { limit: 50, sinceMs: undefined })
    .map((row) => row.action);

describe('GET /api/automod/rules', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/automod/rules' });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 no-grant without config.read', async () => {
    grant(['config.write']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/automod/rules',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'no-grant' });
  });

  it('lists the guild rules', async () => {
    grant(['config.read']);
    createRule();
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/automod/rules',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      rules: [expect.objectContaining({ ruleId: 'kw-one', kind: 'keyword_filter' })],
    });
  });
});

describe('GET /api/automod/rules/:ruleId', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/automod/rules/kw-one' });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 no-grant without config.read', async () => {
    grant(['config.write']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/automod/rules/kw-one',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'no-grant' });
  });

  it('returns the detail with the config parsed beside the raw string', async () => {
    grant(['config.read']);
    createRule();
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/automod/rules/kw-one',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({ ruleId: 'kw-one', config: '{}', configObject: {} }),
    );
  });

  it('answers 404 for an unknown rule', async () => {
    grant(['config.read']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/automod/rules/no-such-rule',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('answers 400 for a malformed rule id', async () => {
    grant(['config.read']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/automod/rules/Bad_ID!',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers 404 under a session for the other guild (guild scope)', async () => {
    grant(['config.read']);
    grant(['config.read'], OTHER_GUILD);
    createRule();
    const { cookie } = await signIn(OTHER_GUILD);
    const response = await app.inject({
      method: 'GET',
      url: '/api/automod/rules/kw-one',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/automod/rules', () => {
  const payload = {
    ruleId: 'kw-new',
    kind: 'keyword_filter',
    name: 'New rule',
    config: {},
  };

  it('answers 401 with no session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules',
      payload,
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 csrf without the header', async () => {
    grant(['config.write']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules',
      headers: { cookie },
      payload,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'csrf' });
  });

  it('answers 403 no-grant without config.write', async () => {
    grant(['config.read']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'no-grant' });
  });

  it('creates the rule and records an attributed audit row', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const detail = testPortsFor(t.scopes.forGuild(GUILD), () => clock).findAutomodRuleDetail(
      'kw-new',
    );
    expect(detail?.name).toBe('New rule');

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), {
      limit: 10,
      sinceMs: undefined,
    });
    const row = rows.find((r) => r.action === 'automod_rule.created');
    expect(row?.actorType).toBe('dashboard');
    expect(row?.actorId).toBe(ACCOUNT);
    expect(row?.via).toBe('http');
    expect(row?.subjectType).toBe('automod_rule');
    expect(row?.subjectId).toBe('kw-new');
  });

  it('answers 409 exists and records no audit row', async () => {
    grant(['config.write']);
    createRule('kw-new');
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'exists' });
    expect(auditActions()).not.toContain('automod_rule.created');
  });

  it('answers 400 for a malformed body', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { ruleId: 'kw-new', kind: 'keyword_filter', config: {} },
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers 401 reauth-required once the re-auth window has passed', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    clock += POLICY.reauthWindowMs + 1;
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'reauth-required' });
  });
});

describe('PUT /api/automod/rules/:ruleId/config', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/rules/kw-one/config',
      payload: { config: {} },
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 no-grant without config.write', async () => {
    grant(['config.read']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/rules/kw-one/config',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { config: {} },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'no-grant' });
  });

  it('replaces the config and records before and after', async () => {
    grant(['config.write']);
    testPortsFor(t.scopes.forGuild(GUILD), () => clock).createAutomodRule({
      ruleId: 'caps-one',
      kind: 'caps',
      name: 'Caps one',
      config: '{"minLength":10,"maxRatio":0.7}',
    });
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/rules/caps-one/config',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { config: { minLength: 20, maxRatio: 0.5 } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const detail = testPortsFor(t.scopes.forGuild(GUILD), () => clock).findAutomodRuleDetail(
      'caps-one',
    );
    expect(detail?.config).toBe('{"minLength":20,"maxRatio":0.5}');

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), {
      limit: 10,
      sinceMs: undefined,
    });
    const row = rows.find((r) => r.action === 'automod_rule.config_set');
    expect(row?.subjectType).toBe('automod_rule');
    expect(row?.subjectId).toBe('caps-one');
    expect(JSON.parse(row?.before ?? 'null')).toBe('{"minLength":10,"maxRatio":0.7}');
    expect(JSON.parse(row?.after ?? 'null')).toBe('{"minLength":20,"maxRatio":0.5}');
  });

  it('answers 404 for an unknown rule and records no audit row', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/rules/no-such-rule/config',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { config: {} },
    });
    expect(response.statusCode).toBe(404);
    expect(auditActions()).not.toContain('automod_rule.config_set');
  });

  it('answers 400 with reason and detail and leaves the stored config alone', async () => {
    grant(['config.write']);
    createRule();
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/automod/rules/kw-one/config',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { config: { ratio: 0.7 } },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: string; reason: string; detail: string }>();
    expect(body.error).toBe('invalid-config');
    expect(body.reason).toBe('invalid-config');
    expect(typeof body.detail).toBe('string');

    const detail = testPortsFor(t.scopes.forGuild(GUILD), () => clock).findAutomodRuleDetail(
      'kw-one',
    );
    expect(detail?.config).toBe('{}');
    expect(auditActions()).not.toContain('automod_rule.config_set');
  });
});

describe('POST /api/automod/rules/:ruleId/mode', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/mode',
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 no-grant without config.write', async () => {
    grant(['config.read']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/mode',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'no-grant' });
  });

  it('answers 400 when neither mode nor enabled is given', async () => {
    grant(['config.write']);
    createRule();
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/mode',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('toggles enabled and records before and after', async () => {
    grant(['config.write']);
    createRule();
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/mode',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const detail = testPortsFor(t.scopes.forGuild(GUILD), () => clock).findAutomodRuleDetail(
      'kw-one',
    );
    expect(detail?.enabled).toBe(false);

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), {
      limit: 10,
      sinceMs: undefined,
    });
    const row = rows.find((r) => r.action === 'automod_rule.mode_set');
    expect(row?.subjectType).toBe('automod_rule');
    expect(row?.subjectId).toBe('kw-one');
    expect(JSON.parse(row?.before ?? 'null')).toEqual({
      mode: 'test',
      enabled: true,
      cutoverState: 'not_started',
      observeStartedAt: null,
    });
    expect(JSON.parse(row?.after ?? 'null')).toEqual({ enabled: false });
  });

  it('answers 404 for an unknown rule and records no audit row', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/no-such-rule/mode',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(404);
    expect(auditActions()).not.toContain('automod_rule.mode_set');
  });

  it('answers 409 not-eligible for enforce on a not_started rule and leaves the row alone', async () => {
    grant(['config.write']);
    createRule();
    const before = automodAdminRepo.findRule(t.scopes.forGuild(GUILD), 'kw-one');
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/mode',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { mode: 'enforce' },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json<{
      error: string;
      refusal: { reason: string; state: string };
    }>();
    expect(body.error).toBe('not-eligible');
    expect(body.refusal.reason).toBe('cutover-state');

    const after = automodAdminRepo.findRule(t.scopes.forGuild(GUILD), 'kw-one');
    expect(after).toEqual(before);
    expect(auditActions()).not.toContain('automod_rule.mode_set');
  });

  it('answers 401 reauth-required once the re-auth window has passed', async () => {
    grant(['config.write']);
    createRule();
    const { cookie, csrf } = await signIn();
    clock += POLICY.reauthWindowMs + 1;
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/mode',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'reauth-required' });
  });
});

describe('POST /api/automod/rules/:ruleId/exemptions', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/exemptions',
      payload: { exemptType: 'role', exemptId: ROLE },
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 no-grant without config.write', async () => {
    grant(['config.read']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/exemptions',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { exemptType: 'role', exemptId: ROLE },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'no-grant' });
  });

  it('adds the exemption, then reports already-present, with an audit row', async () => {
    grant(['config.write']);
    createRule();
    const { cookie, csrf } = await signIn();

    const first = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/exemptions',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { exemptType: 'role', exemptId: ROLE },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, outcome: 'added' });

    const second = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/exemptions',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { exemptType: 'role', exemptId: ROLE },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, outcome: 'already-present' });

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), {
      limit: 10,
      sinceMs: undefined,
    });
    const row = rows.find((r) => r.action === 'automod_rule.exemption_added');
    expect(row?.subjectType).toBe('automod_rule');
    expect(row?.subjectId).toBe('kw-one');
  });

  it('answers 404 for an unknown rule', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/no-such-rule/exemptions',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { exemptType: 'channel', exemptId: CHANNEL },
    });
    expect(response.statusCode).toBe(404);
  });

  it('answers 400 for a malformed exemption id', async () => {
    grant(['config.write']);
    createRule();
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/exemptions',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { exemptType: 'role', exemptId: 'not-a-snowflake' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('DELETE /api/automod/rules/:ruleId/exemptions/:exemptType/:exemptId', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/automod/rules/kw-one/exemptions/role/${ROLE}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 no-grant without config.write', async () => {
    grant(['config.read']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/automod/rules/kw-one/exemptions/role/${ROLE}`,
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'no-grant' });
  });

  it('removes the exemption, then reports not-present, with an audit row', async () => {
    grant(['config.write']);
    createRule();
    const ports = testPortsFor(t.scopes.forGuild(GUILD), () => clock);
    expect(
      ports.addAutomodExemption({ ruleId: 'kw-one', exemptType: 'role', exemptId: ROLE }),
    ).toBe('added');
    const { cookie, csrf } = await signIn();

    const first = await app.inject({
      method: 'DELETE',
      url: `/api/automod/rules/kw-one/exemptions/role/${ROLE}`,
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, outcome: 'removed' });

    const second = await app.inject({
      method: 'DELETE',
      url: `/api/automod/rules/kw-one/exemptions/role/${ROLE}`,
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, outcome: 'not-present' });

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), {
      limit: 10,
      sinceMs: undefined,
    });
    const row = rows.find((r) => r.action === 'automod_rule.exemption_removed');
    expect(row?.subjectType).toBe('automod_rule');
    expect(row?.subjectId).toBe('kw-one');
  });

  it('answers 400 for a malformed exemption id', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/automod/rules/kw-one/exemptions/role/not-a-snowflake',
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /api/automod/rules/:ruleId/dry-run', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/dry-run',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 no-grant without config.read', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/dry-run',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'no-grant' });
  });

  it('returns the dry-run report', async () => {
    grant(['config.read']);
    createRule();
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/dry-run',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ ruleId: 'kw-one' }));
  });

  it('dry-runs a disabled rule (the edit, dry-run, enable workflow)', async () => {
    grant(['config.read']);
    createRule();
    const ports = testPortsFor(t.scopes.forGuild(GUILD), () => clock);
    expect(ports.setAutomodRuleMode({ ruleId: 'kw-one', enabled: false })).toEqual({ ok: true });
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/dry-run',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ ruleId: 'kw-one' }));
  });

  it('answers 404 for an unknown rule', async () => {
    grant(['config.read']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/no-such-rule/dry-run',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });
});
