import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { INSTANCE_SETTINGS, parseGuildId, settingDefinition } from '@bananasaurs/core';
import { accountRepo, effectRepo, guildRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createServer, CSRF_HEADER, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAssistantTuningRoutes } from './assistant-tuning.js';

const GUILD = parseGuildId('111111111111111111');
const OWNER = 'acct_0123456789abcdef0123456789abcdef';
const OPERATOR = 'acct_fedcba9876543210fedcba9876543210';
const PASSWORD = 'correct horse battery staple';
const SECRET = 'tok-SECRET-999';

let t: MigratedTestDatabase;
let deps: HttpDeps;
let app: FastifyInstance;
let clock: number;

const cookieFrom = (header: string | string[] | undefined): string =>
  (Array.isArray(header) ? (header[0] ?? '') : (header ?? '')).split(';')[0] ?? '';

const signInAs = async (username: string): Promise<{ cookie: string; csrf: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username, password: PASSWORD, guildId: GUILD },
  });
  return {
    cookie: cookieFrom(response.headers['set-cookie']),
    csrf: response.json<{ csrfToken: string }>().csrfToken,
  };
};

const auditRows = () =>
  effectRepo
    .tailAudit(t.scopes.forGuild(GUILD), {})
    .filter((row) => row.action.startsWith('instance_setting.'));

/** In-memory stand-in for the daemon's InstanceSettingsStore. The secret is masked in views. */
const fakePort = (over: { sealedSecrets?: boolean } = {}) => {
  const values = new Map<string, { value: unknown; updatedBy: string; updatedAt: number }>();
  const viewOf = (key: string) => {
    const def = settingDefinition(key);
    if (def === undefined) throw new Error(`unknown setting: ${key}`);
    const row = values.get(key);
    const raw = row === undefined ? def.defaultValue : row.value;
    const secret = def.secret === true;
    return {
      key,
      group: def.group,
      label: def.label,
      help: def.help,
      display: def.display,
      ...(def.bounds === undefined ? {} : { bounds: def.bounds }),
      value: secret ? { configured: raw !== null } : raw,
      defaultValue: secret ? { configured: false } : def.defaultValue,
      isDefault: row === undefined,
      ...(row === undefined ? {} : { updatedAt: row.updatedAt, updatedBy: row.updatedBy }),
    };
  };
  return {
    get: (key: string) => values.get(key)?.value ?? settingDefinition(key)?.defaultValue,
    list: () => INSTANCE_SETTINGS.map((def) => viewOf(def.key)),
    set: (key: string, value: unknown, by: string, now: number) => {
      const def = settingDefinition(key);
      if (def === undefined) return { ok: false as const, code: 'unknown-setting' as const };
      const checked = def.schema.safeParse(value);
      if (!checked.success)
        return { ok: false as const, code: 'invalid-setting' as const, error: checked.error };
      if (def.secret === true && typeof value === 'string' && over.sealedSecrets === false)
        return {
          ok: false as const,
          code: 'provider-secret-store-not-configured' as const,
        };
      const before = viewOf(key).value;
      if (def.secret === true && value === null) values.delete(key);
      else values.set(key, { value, updatedBy: by, updatedAt: now });
      const view = viewOf(key);
      return { ok: true as const, before, after: view.value, view };
    },
    reset: (key: string) => {
      if (settingDefinition(key) === undefined)
        return { ok: false as const, code: 'unknown-setting' as const };
      const before = viewOf(key).value;
      values.delete(key);
      const view = viewOf(key);
      return { ok: true as const, before, after: view.value, view };
    },
  };
};

const rebuild = (port: HttpDeps['instanceSettings']): void => {
  deps = { ...deps, instanceSettings: port };
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
    instanceSettings: fakePort(),
  };
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'guild', now: clock });
  accountRepo.createAccount(t.scopes.instance(), {
    accountId: OWNER,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), OWNER);
  accountRepo.createAccount(t.scopes.instance(), {
    accountId: OPERATOR,
    username: 'operator',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: false,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), OPERATOR);
  app = createServer({ deps, registerRoutes: registerAssistantTuningRoutes });
});
afterEach(async () => {
  await app.close();
  t.close();
});

describe('AI tuning is owner-only', () => {
  it.each([['GET', '/api/assistant/tuning']])('%s %s refuses a non-owner', async (method, url) => {
    const operator = await signInAs('operator');
    const response = await app.inject({
      method: method as 'GET',
      url,
      headers: { cookie: operator.cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'owner-only' });
  });

  it.each([['PUT', '/api/assistant/tuning/assistant.maxToolRounds']])(
    '%s %s refuses a non-owner',
    async (method, url) => {
      const operator = await signInAs('operator');
      const response = await app.inject({
        method: method as 'PUT',
        url,
        headers: { cookie: operator.cookie, [CSRF_HEADER]: operator.csrf },
        payload: { value: 6 },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'owner-only' });
    },
  );

  it.each([['DELETE', '/api/assistant/tuning/assistant.maxToolRounds']])(
    '%s %s refuses a non-owner',
    async (method, url) => {
      const operator = await signInAs('operator');
      const response = await app.inject({
        method: method as 'DELETE',
        url,
        headers: { cookie: operator.cookie, [CSRF_HEADER]: operator.csrf },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'owner-only' });
    },
  );
});

describe('AI tuning without a store', () => {
  it('answers 503 settings-unavailable', async () => {
    await app.close();
    rebuild(undefined);
    app = createServer({ deps, registerRoutes: registerAssistantTuningRoutes });
    const owner = await signInAs('owner');
    const fetched = await app.inject({
      method: 'GET',
      url: '/api/assistant/tuning',
      headers: { cookie: owner.cookie },
    });
    expect(fetched.statusCode).toBe(503);
    expect(fetched.json()).toMatchObject({ error: 'settings-unavailable' });
  });
});

describe('GET /api/assistant/tuning', () => {
  it('lists the 18 settings for the owner', async () => {
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/tuning',
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ settings: { key: string }[] }>();
    expect(body.settings).toHaveLength(18);
    expect(body.settings.map((s) => s.key)).toContain('assistant.retryDelaysMs');
    expect(body.settings.map((s) => s.key)).toContain('assistant.channelContextMessages');
    expect(body.settings.map((s) => s.key)).toContain('mcp.cap.message');
    expect(body.settings.map((s) => s.key)).toContain('mcp.cap.structure');
  });
});

describe('PUT /api/assistant/tuning/:key', () => {
  it('saves a valid value and audits it once', async () => {
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'PUT',
      url: '/api/assistant/tuning/assistant.maxToolRounds',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: { value: 6 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      setting: { key: 'assistant.maxToolRounds', value: 6 },
    });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'instance_setting.changed',
      subjectId: 'assistant.maxToolRounds',
    });
  });

  it('refuses an over-total retry schedule with the custom message and fields', async () => {
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'PUT',
      url: '/api/assistant/tuning/assistant.retryDelaysMs',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: { value: [60_000, 60_000, 60_001] },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: string; message?: string; fields?: unknown }>();
    expect(body.error).toBe('invalid-setting');
    expect(body.message).toBe('Retry delays must add up to 3 minutes or less.');
    expect(body.fields).toBeDefined();
  });

  it('never returns the header secret in the response or the audit', async () => {
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'PUT',
      url: '/api/assistant/tuning/resources.fetchHeaderValue',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: { value: SECRET },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).not.toContain(SECRET);
    expect(JSON.stringify(auditRows())).not.toContain(SECRET);
  });

  it('answers 503 when the secret store cannot seal', async () => {
    await app.close();
    rebuild(fakePort({ sealedSecrets: false }));
    app = createServer({ deps, registerRoutes: registerAssistantTuningRoutes });
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'PUT',
      url: '/api/assistant/tuning/resources.fetchHeaderValue',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: { value: SECRET },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'provider-secret-store-not-configured' });
  });

  it('answers 404 for an unknown key', async () => {
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'PUT',
      url: '/api/assistant/tuning/nope',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: { value: 1 },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'unknown-setting' });
  });
});

describe('DELETE /api/assistant/tuning/:key', () => {
  it('resets to the default and audits the write', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/assistant/tuning/assistant.maxToolRounds',
      headers,
      payload: { value: 6 },
    });
    expect(saved.statusCode).toBe(200);
    const reset = await app.inject({
      method: 'DELETE',
      url: '/api/assistant/tuning/assistant.maxToolRounds',
      headers,
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ setting: { key: 'assistant.maxToolRounds', value: 4 } });
    expect(auditRows()).toHaveLength(2);
  });
});
