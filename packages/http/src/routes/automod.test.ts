import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import {
  accountRepo,
  authzRepo,
  automodAdminRepo,
  effectRepo,
  guildRepo,
  modCaseRepo,
} from '@bananasaurs/storage';
import { parseGuildId, type Capability } from '@bananasaurs/core';
import type { GuildId } from '@bananasaurs/core';
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
const MEMBER = '555555555555555555';

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

const createKindRule = (
  guild: GuildId,
  ruleId: string,
  kind: 'keyword_filter' | 'invite' | 'link_domain' | 'caps',
  config = '{}',
): void => {
  testPortsFor(t.scopes.forGuild(guild), () => clock).createAutomodRule({
    ruleId,
    kind,
    name: ruleId,
    config,
  });
};

/**
 * Seeds a case and one event against it — the shape a `test`/`observe`-mode
 * automod match really writes: a case event carrying a trace JSON string for
 * a Bananasaurs match, and none for a native hit.
 */
const seedMatch = (
  guild: GuildId,
  input: { readonly eventId: string; readonly ruleId: string; readonly trace?: string },
): void => {
  const scope = t.scopes.forGuild(guild);
  const { caseId } = modCaseRepo.openOrResolveCase(scope, { memberId: MEMBER, now: clock });
  modCaseRepo.recordCaseEvent(scope, {
    eventId: input.eventId,
    caseId,
    ruleId: input.ruleId,
    memberId: MEMBER,
    at: clock,
    matchedCategory: 'keyword_filter',
    matchedSnippet: 'snippet',
    actionTaken: input.trace === undefined ? 'native_blocked' : 'would_delete',
    ...(input.trace === undefined ? {} : { trace: input.trace }),
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

describe('GET /api/automod/review', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/automod/review' });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 no-grant without config.read', async () => {
    grant(['config.write']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/automod/review',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'no-grant' });
  });

  it('returns matches, native hits and the verdict split for this guild only', async () => {
    grant(['config.read', 'config.write']);
    grant(['config.read', 'config.write'], OTHER_GUILD);
    createKindRule(GUILD, 'kw-one', 'keyword_filter');
    // Same event ids in both guilds: the response must carry this guild's only.
    seedMatch(GUILD, { eventId: 'e1', ruleId: 'kw-one', trace: '{"kind":"keyword_filter"}' });
    seedMatch(GUILD, { eventId: 'e2', ruleId: 'kw-one', trace: '{"kind":"keyword_filter"}' });
    seedMatch(GUILD, { eventId: 'n1', ruleId: 'native:1' });
    seedMatch(OTHER_GUILD, { eventId: 'e1', ruleId: 'kw-one', trace: '{"kind":"keyword_filter"}' });
    seedMatch(OTHER_GUILD, { eventId: 'e2', ruleId: 'kw-one', trace: '{"kind":"keyword_filter"}' });
    seedMatch(OTHER_GUILD, { eventId: 'n1', ruleId: 'native:1' });

    const { cookie, csrf } = await signIn();
    const verdict = await app.inject({
      method: 'POST',
      url: '/api/automod/review/e1/verdict',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { verdict: 'false_positive' },
    });
    expect(verdict.statusCode).toBe(200);

    const response = await app.inject({
      method: 'GET',
      url: '/api/automod/review',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      matches: { eventId: string }[];
      nativeHits: { eventId: string }[];
      nativeBlocked: number;
      verdicts: Record<string, { falsePositive: number; truePositive: number; unclear: number }>;
    }>();
    // e1 was just reviewed, so only e2 remains unreviewed — once, not twice.
    expect(body.matches.map((m) => m.eventId)).toEqual(['e2']);
    expect(body.nativeHits.map((h) => h.eventId)).toEqual(['n1']);
    expect(body.nativeBlocked).toBe(1);
    expect(body.verdicts['kw-one']).toEqual({ falsePositive: 1, truePositive: 0, unclear: 0 });
  });

  it('filters matches by ruleId and validates the query', async () => {
    grant(['config.read']);
    createKindRule(GUILD, 'kw-one', 'keyword_filter');
    createKindRule(GUILD, 'kw-two', 'keyword_filter');
    seedMatch(GUILD, { eventId: 'e1', ruleId: 'kw-one', trace: '{"kind":"keyword_filter"}' });
    seedMatch(GUILD, { eventId: 'e2', ruleId: 'kw-two', trace: '{"kind":"keyword_filter"}' });
    const { cookie } = await signIn();

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/automod/review?ruleId=kw-one',
      headers: { cookie },
    });
    expect(filtered.statusCode).toBe(200);
    expect(
      filtered.json<{ matches: { eventId: string }[] }>().matches.map((m) => m.eventId),
    ).toEqual(['e1']);

    const badRule = await app.inject({
      method: 'GET',
      url: '/api/automod/review?ruleId=Bad_ID!',
      headers: { cookie },
    });
    expect(badRule.statusCode).toBe(400);

    const badLimit = await app.inject({
      method: 'GET',
      url: '/api/automod/review?limit=201',
      headers: { cookie },
    });
    expect(badLimit.statusCode).toBe(400);
  });
});

describe('POST /api/automod/review/:eventId/verdict', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/review/e1/verdict',
      payload: { verdict: 'false_positive' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 no-grant without config.write', async () => {
    grant(['config.read']);
    createKindRule(GUILD, 'kw-one', 'keyword_filter');
    seedMatch(GUILD, { eventId: 'e1', ruleId: 'kw-one', trace: '{"kind":"keyword_filter"}' });
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/review/e1/verdict',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { verdict: 'false_positive' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'no-grant' });
  });

  it('records the verdict with an attributed audit row', async () => {
    grant(['config.write']);
    createKindRule(GUILD, 'kw-one', 'keyword_filter');
    seedMatch(GUILD, { eventId: 'e1', ruleId: 'kw-one', trace: '{"kind":"keyword_filter"}' });
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/review/e1/verdict',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { verdict: 'false_positive', note: 'quoted text, not a slur' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, outcome: 'recorded' });

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), {
      limit: 10,
      sinceMs: undefined,
    });
    const row = rows.find((r) => r.action === 'automod_match.verdict_recorded');
    expect(row?.subjectType).toBe('automod_match');
    expect(row?.subjectId).toBe('e1');
    expect(row?.actorId).toBe(ACCOUNT);
    expect(JSON.parse(row?.after ?? 'null')).toMatchObject({ verdict: 'false_positive' });
  });

  it('records a revision by the same account and the counts move', async () => {
    grant(['config.write', 'config.read']);
    createKindRule(GUILD, 'kw-one', 'keyword_filter');
    seedMatch(GUILD, { eventId: 'e1', ruleId: 'kw-one', trace: '{"kind":"keyword_filter"}' });
    const { cookie, csrf } = await signIn();

    const first = await app.inject({
      method: 'POST',
      url: '/api/automod/review/e1/verdict',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { verdict: 'false_positive' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/automod/review/e1/verdict',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { verdict: 'true_positive' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, outcome: 'recorded' });

    const review = await app.inject({
      method: 'GET',
      url: '/api/automod/review',
      headers: { cookie },
    });
    expect(
      review.json<{
        verdicts: Record<string, { falsePositive: number; truePositive: number }>;
      }>().verdicts['kw-one'],
    ).toMatchObject({ falsePositive: 0, truePositive: 1 });
  });

  it('answers 404 for an unknown event and records no audit row', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/review/no-such-event/verdict',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { verdict: 'false_positive' },
    });
    expect(response.statusCode).toBe(404);
    expect(auditActions()).not.toContain('automod_match.verdict_recorded');
  });

  it('answers 400 for a malformed verdict', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/review/e1/verdict',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { verdict: 'wrong' },
    });
    expect(response.statusCode).toBe(400);
    expect(auditActions()).not.toContain('automod_match.verdict_recorded');
  });

  it("guild B's session cannot record a verdict on guild A's event", async () => {
    grant(['config.write']);
    grant(['config.write'], OTHER_GUILD);
    createKindRule(GUILD, 'kw-one', 'keyword_filter');
    seedMatch(GUILD, { eventId: 'e1', ruleId: 'kw-one', trace: '{"kind":"keyword_filter"}' });
    const { cookie, csrf } = await signIn(OTHER_GUILD);
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/review/e1/verdict',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { verdict: 'false_positive' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/automod/rules/:ruleId/suppress', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/suppress',
      payload: { kind: 'allowlist_phrase', value: 'hello' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 no-grant without config.write', async () => {
    grant(['config.read']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'allowlist_phrase', value: 'hello' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'no-grant' });
  });

  it('suppresses with an allowlist phrase and audits kind and value', async () => {
    grant(['config.write']);
    createKindRule(GUILD, 'kw-one', 'keyword_filter');
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'allowlist_phrase', value: 'hello world' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, outcome: 'added' });

    const detail = testPortsFor(t.scopes.forGuild(GUILD), () => clock).findAutomodRuleDetail(
      'kw-one',
    );
    expect(detail?.allowlist).toContain('hello world');

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), {
      limit: 10,
      sinceMs: undefined,
    });
    const row = rows.find((r) => r.action === 'automod_rule.suppression_added');
    expect(row?.subjectType).toBe('automod_rule');
    expect(row?.subjectId).toBe('kw-one');
    expect(JSON.parse(row?.after ?? 'null')).toEqual({
      kind: 'allowlist_phrase',
      value: 'hello world',
    });
  });

  it('canonicalises an allowlist phrase before comparing and storing', async () => {
    grant(['config.write']);
    createKindRule(GUILD, 'kw-one', 'keyword_filter');
    const { cookie, csrf } = await signIn();

    const first = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'allowlist_phrase', value: '  Free  SPEECH ' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, outcome: 'added' });

    const second = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'allowlist_phrase', value: 'free speech' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, outcome: 'already-present' });

    const detail = testPortsFor(t.scopes.forGuild(GUILD), () => clock).findAutomodRuleDetail(
      'kw-one',
    );
    expect(detail?.allowlist).toEqual(['free speech']);
  });

  it('treats an allowlist phrase as case-insensitive for already-present', async () => {
    grant(['config.write']);
    createKindRule(GUILD, 'kw-one', 'keyword_filter');
    const { cookie, csrf } = await signIn();

    const first = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'allowlist_phrase', value: 'Ass' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, outcome: 'added' });

    const second = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'allowlist_phrase', value: 'ass' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, outcome: 'already-present' });
  });

  it('answers 400 for a blank allowlist phrase and records no audit row', async () => {
    grant(['config.write']);
    createKindRule(GUILD, 'kw-one', 'keyword_filter');
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/kw-one/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'allowlist_phrase', value: '   ' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'bad-request' });
    expect(auditActions()).not.toContain('automod_rule.suppression_added');
  });

  it('suppresses with an invite code', async () => {
    grant(['config.write']);
    createKindRule(GUILD, 'inv-one', 'invite');
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/inv-one/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'invite_code', value: 'clubhouse' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, outcome: 'added' });

    const detail = testPortsFor(t.scopes.forGuild(GUILD), () => clock).findAutomodRuleDetail(
      'inv-one',
    );
    expect(detail?.inviteAllowlist).toContainEqual({
      code: 'clubhouse',
      label: 'added from review',
    });
  });

  it('allowlists a long invite code with an underscore, like the predicate matches', async () => {
    grant(['config.write']);
    createKindRule(GUILD, 'inv-one', 'invite');
    const code = `club_${'x'.repeat(35)}`;
    expect(code).toHaveLength(40);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/inv-one/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'invite_code', value: code },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, outcome: 'added' });
  });

  it('suppresses with a link domain', async () => {
    grant(['config.write']);
    createKindRule(GUILD, 'link-one', 'link_domain');
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/link-one/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'link_domain', value: 'Example.COM' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, outcome: 'added' });

    const detail = testPortsFor(t.scopes.forGuild(GUILD), () => clock).findAutomodRuleDetail(
      'link-one',
    );
    expect(detail?.linkDomains).toContainEqual({ domain: 'example.com', listType: 'allow' });
  });

  it('suppresses a deny-mode rule by removing the domain from its deny list', async () => {
    grant(['config.write']);
    createKindRule(GUILD, 'link-deny', 'link_domain', JSON.stringify({ mode: 'deny' }));
    const ports = testPortsFor(t.scopes.forGuild(GUILD), () => clock);
    expect(
      ports.addLinkDomain({ ruleId: 'link-deny', domain: 'example.com', listType: 'deny' }),
    ).toMatchObject({ outcome: 'added' });

    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/link-deny/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'link_domain', value: 'Example.COM' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, outcome: 'added' });

    expect(ports.listLinkDomains('link-deny')).toEqual([]);

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), {
      limit: 10,
      sinceMs: undefined,
    });
    const row = rows.find((r) => r.action === 'automod_rule.suppression_added');
    expect(row?.subjectId).toBe('link-deny');
    expect(JSON.parse(row?.after ?? 'null')).toEqual({
      kind: 'link_domain',
      value: 'Example.COM',
      listType: 'deny',
      removed: true,
    });
  });

  it('answers 409 not-denied when the domain is not on the deny list', async () => {
    grant(['config.write']);
    createKindRule(GUILD, 'link-deny', 'link_domain', JSON.stringify({ mode: 'deny' }));
    const ports = testPortsFor(t.scopes.forGuild(GUILD), () => clock);
    expect(
      ports.addLinkDomain({ ruleId: 'link-deny', domain: 'other.example', listType: 'deny' }),
    ).toMatchObject({ outcome: 'added' });

    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/link-deny/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'link_domain', value: 'example.com' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'not-denied' });

    expect(ports.listLinkDomains('link-deny')).toEqual([
      { domain: 'other.example', listType: 'deny' },
    ]);
    expect(auditActions()).not.toContain('automod_rule.suppression_added');
  });

  it('suppresses with a channel exemption', async () => {
    grant(['config.write']);
    createKindRule(GUILD, 'caps-one', 'caps');
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/caps-one/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'channel_exemption', value: CHANNEL },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, outcome: 'added' });
    expect(automodAdminRepo.listExemptions(t.scopes.forGuild(GUILD), 'caps-one')).toContainEqual({
      exemptType: 'channel',
      exemptId: CHANNEL,
    });
  });

  it('answers 409 wrong-kind for an allowlist phrase against an invite rule', async () => {
    grant(['config.write']);
    createKindRule(GUILD, 'inv-one', 'invite');
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/inv-one/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'allowlist_phrase', value: 'hello' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'wrong-kind' });
    expect(auditActions()).not.toContain('automod_rule.suppression_added');
  });

  it('answers 400 for a malformed value', async () => {
    grant(['config.write']);
    createKindRule(GUILD, 'inv-one', 'invite');
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/inv-one/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'invite_code', value: 'not a code!!' },
    });
    expect(response.statusCode).toBe(400);
    expect(auditActions()).not.toContain('automod_rule.suppression_added');
  });

  it('answers 404 for an unknown rule', async () => {
    grant(['config.write']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/automod/rules/no-such-rule/suppress',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { kind: 'allowlist_phrase', value: 'hello' },
    });
    expect(response.statusCode).toBe(404);
    expect(auditActions()).not.toContain('automod_rule.suppression_added');
  });
});
