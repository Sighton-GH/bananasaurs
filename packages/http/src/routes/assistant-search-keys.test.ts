import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseGuildId } from '@bananasaurs/core';
import { accountRepo, effectRepo, guildRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createServer, CSRF_HEADER, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAssistantSearchKeyRoutes } from './assistant-search-keys.js';

const GUILD = parseGuildId('111111111111111111');
const OWNER = 'acct_0123456789abcdef0123456789abcdef';
const OPERATOR = 'acct_fedcba9876543210fedcba9876543210';
const PASSWORD = 'correct horse battery staple';
const SECRET = 'sk-search-SECRET-abc-98765';

let t: MigratedTestDatabase;
let deps: HttpDeps;
let app: FastifyInstance;
let clock: number;

interface FakeSearchKey {
  keyId: string;
  source: 'brave' | 'tavily';
  label: string;
  enabled: boolean;
  position: number;
  monthlyLimit: number | null;
  dailyLimit: number | null;
}

/** The pasted key, kept aside so tests can prove it never leaks. Accepted and dropped. */
let lastApiKey: string | undefined;
let addedInputs: Record<string, unknown>[];

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
    .filter((row) => row.action.startsWith('assistant_search.'));

const auditText = (): string =>
  auditRows()
    .map((row) => `${row.action} ${row.before ?? ''} ${row.after ?? ''}`)
    .join('\n');

/** In-memory stand-in for the daemon's search-key store. The key is accepted and dropped. */
const fakeStore = (
  over: {
    keys?: FakeSearchKey[];
    enabled?: boolean;
    source?: 'brave' | 'tavily';
    usage?: (
      keyId: string,
    ) =>
      | { readonly last24h: number; readonly last31d: number; readonly availableAt?: number }
      | undefined;
  } = {},
) => {
  let keys: FakeSearchKey[] = (over.keys ?? []).map((k) => ({ ...k }));
  let next = 1;
  const enabled = over.enabled ?? false;
  const source = over.source ?? 'brave';
  const usage = over.usage;
  return {
    status: () => ({
      provider: 'gemini',
      enabled: true,
      modelConfigured: true,
      keyConfigured: true,
      keyReadable: true,
      costClass: 'unknown' as const,
      secretSource: 'file' as const,
      webSearch: {
        keyConfigured: keys.length > 0,
        enabled,
        source,
      },
    }),
    save: () => undefined,
    searchKeys: () => keys.map((k) => ({ ...k })).sort((a, b) => a.position - b.position),
    addSearchKey: (input: {
      source: 'brave' | 'tavily';
      label: string;
      apiKey: string;
      monthlyLimit?: number | null | undefined;
      dailyLimit?: number | null | undefined;
    }) => {
      lastApiKey = input.apiKey;
      addedInputs.push({ ...input, apiKey: undefined, hasMonthly: 'monthlyLimit' in input });
      const keyId = `sk_${String(next++)}`;
      keys.push({
        keyId,
        source: input.source,
        label: input.label,
        enabled: true,
        position: keys.length,
        monthlyLimit: input.monthlyLimit === undefined ? 1000 : input.monthlyLimit,
        dailyLimit: input.dailyLimit ?? null,
      });
      return keyId;
    },
    updateSearchKey: (
      keyId: string,
      input: {
        label?: string | undefined;
        apiKey?: string | undefined;
        enabled?: boolean | undefined;
        monthlyLimit?: number | null | undefined;
        dailyLimit?: number | null | undefined;
      },
    ) => {
      const found = keys.find((k) => k.keyId === keyId);
      if (found === undefined) return false;
      if (input.apiKey !== undefined) lastApiKey = input.apiKey;
      if (input.label !== undefined) found.label = input.label;
      if (input.enabled !== undefined) found.enabled = input.enabled;
      if (input.monthlyLimit !== undefined) found.monthlyLimit = input.monthlyLimit;
      if (input.dailyLimit !== undefined) found.dailyLimit = input.dailyLimit;
      return true;
    },
    moveSearchKey: (keyId: string, direction: 'up' | 'down') => {
      const at = keys.findIndex((k) => k.keyId === keyId);
      if (at === -1) return false;
      const other = direction === 'up' ? at - 1 : at + 1;
      const neighbour = keys[other];
      const current = keys[at];
      if (neighbour === undefined || current === undefined) return true;
      const pos = current.position;
      current.position = neighbour.position;
      neighbour.position = pos;
      keys = keys.sort((a, b) => a.position - b.position);
      return true;
    },
    removeSearchKey: (keyId: string) => {
      if (!keys.some((k) => k.keyId === keyId)) return false;
      keys = keys.filter((k) => k.keyId !== keyId).map((k, position) => ({ ...k, position }));
      return true;
    },
    isSearchKeyReadable: () => true,
    searchKeyUsage: (keyId: string) => usage?.(keyId) ?? { last24h: 0, last31d: 0 },
  };
};

const rebuild = async (store: unknown): Promise<void> => {
  deps = {
    ...deps,
    assistantProviderConfig: store as HttpDeps['assistantProviderConfig'],
  };
  await app.close();
  app = createServer({ deps, registerRoutes: registerAssistantSearchKeyRoutes });
};

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  lastApiKey = undefined;
  addedInputs = [];
  deps = {
    scopes: t.scopes,
    now: () => clock,
    guildIds: [GUILD],
    logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never,
    readonly: false,
    portsFor: (scope) => testPortsFor(scope, () => clock),
    instance: testInstanceFor(t.scopes.instance(), () => clock),
    assistantProviderConfig: fakeStore() as HttpDeps['assistantProviderConfig'],
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
  app = createServer({ deps, registerRoutes: registerAssistantSearchKeyRoutes });
});
afterEach(async () => {
  await app.close();
  t.close();
});

describe('search-key routes are owner-only', () => {
  it.each([
    ['GET', '/api/assistant/search-keys'],
    ['POST', '/api/assistant/search-keys'],
    ['PATCH', '/api/assistant/search-keys/sk_1'],
    ['POST', '/api/assistant/search-keys/sk_1/move'],
    ['DELETE', '/api/assistant/search-keys/sk_1'],
  ])('%s %s refuses a non-owner', async (method, url) => {
    const operator = await signInAs('operator');
    const response = await app.inject({
      method: method as 'POST',
      url,
      headers: { cookie: operator.cookie, [CSRF_HEADER]: operator.csrf },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'owner-only' });
  });
});

describe('search-key routes answer 503 without a store', () => {
  it.each([
    ['GET', '/api/assistant/search-keys'],
    ['POST', '/api/assistant/search-keys'],
    ['PATCH', '/api/assistant/search-keys/sk_1'],
    ['POST', '/api/assistant/search-keys/sk_1/move'],
    ['DELETE', '/api/assistant/search-keys/sk_1'],
  ])('%s %s answers provider-secret-store-not-configured', async (method, url) => {
    await rebuild({});
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: method as 'POST',
      url,
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'provider-secret-store-not-configured' });
  });
});

describe('POST then GET lists the key without ever leaking it', () => {
  it('returns source, label, enabled, position, limits, readable and usage', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const added = await app.inject({
      method: 'POST',
      url: '/api/assistant/search-keys',
      headers,
      payload: { source: 'tavily', label: 'Main', apiKey: SECRET },
    });
    expect(added.statusCode).toBe(200);
    const keyId = added.json<{ keyId: string }>().keyId;
    expect(keyId).toMatch(/^sk_/);
    expect(JSON.stringify(added.json())).not.toContain(SECRET);
    const fetched = await app.inject({
      method: 'GET',
      url: '/api/assistant/search-keys',
      headers: { cookie: owner.cookie },
    });
    expect(fetched.statusCode).toBe(200);
    const body = fetched.json<{
      enabled: boolean;
      source: string;
      keys: Record<string, unknown>[];
    }>();
    expect(body.enabled).toBe(false);
    expect(body.source).toBe('brave');
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toEqual({
      keyId,
      source: 'tavily',
      label: 'Main',
      enabled: true,
      position: 0,
      monthlyLimit: 1000,
      dailyLimit: null,
      readable: true,
      usage: { last24h: 0, last31d: 0 },
    });
    const text = JSON.stringify(fetched.json());
    expect(text).not.toContain(SECRET);
    expect(fetched.json()).not.toHaveProperty('apiKey');
    expect(text).not.toContain('apiKeyEnc');
    expect(lastApiKey).toBe(SECRET);
    expect(auditText()).not.toContain(SECRET);
  });
});

describe('POST limits and strict bodies', () => {
  it('omitted monthlyLimit passes no limit through and audits 1000; null is accepted', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const added = await app.inject({
      method: 'POST',
      url: '/api/assistant/search-keys',
      headers,
      payload: { source: 'brave', label: 'A', apiKey: SECRET },
    });
    expect(added.statusCode).toBe(200);
    expect(addedInputs[0]?.['hasMonthly']).toBe(false);
    const row = auditRows().find((r) => r.action === 'assistant_search.key_added');
    expect(JSON.parse(row?.after ?? 'null')).toEqual({
      source: 'brave',
      label: 'A',
      monthlyLimit: 1000,
      dailyLimit: null,
    });
    const nulled = await app.inject({
      method: 'POST',
      url: '/api/assistant/search-keys',
      headers,
      payload: { source: 'brave', label: 'B', apiKey: SECRET, monthlyLimit: null },
    });
    expect(nulled.statusCode).toBe(200);
  });

  it.each([[0], [1.5], [1_000_001]])('refuses monthlyLimit %s with 400', async (monthlyLimit) => {
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/search-keys',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: { source: 'brave', label: 'A', apiKey: SECRET, monthlyLimit },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an unknown field and a label longer than 60', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const extra = await app.inject({
      method: 'POST',
      url: '/api/assistant/search-keys',
      headers,
      payload: { source: 'brave', label: 'A', apiKey: SECRET, extra: 1 },
    });
    expect(extra.statusCode).toBe(400);
    const long = await app.inject({
      method: 'POST',
      url: '/api/assistant/search-keys',
      headers,
      payload: { source: 'brave', label: 'x'.repeat(61), apiKey: SECRET },
    });
    expect(long.statusCode).toBe(400);
  });
});

describe('PATCH /api/assistant/search-keys/:keyId', () => {
  it('404s an unknown id and 400s an empty body', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/assistant/search-keys/sk_missing',
      headers,
      payload: { label: 'New' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'not-found' });
    const added = await app.inject({
      method: 'POST',
      url: '/api/assistant/search-keys',
      headers,
      payload: { source: 'brave', label: 'A', apiKey: SECRET },
    });
    const keyId = added.json<{ keyId: string }>().keyId;
    const empty = await app.inject({
      method: 'PATCH',
      url: `/api/assistant/search-keys/${keyId}`,
      headers,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: 'bad-request' });
  });

  it('changing limits audits before and after', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const added = await app.inject({
      method: 'POST',
      url: '/api/assistant/search-keys',
      headers,
      payload: { source: 'brave', label: 'A', apiKey: SECRET },
    });
    const keyId = added.json<{ keyId: string }>().keyId;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/assistant/search-keys/${keyId}`,
      headers,
      payload: { monthlyLimit: 50, dailyLimit: 5 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({ ok: true });
    const row = auditRows().find((r) => r.action === 'assistant_search.key_updated');
    expect(JSON.parse(row?.before ?? 'null')).toMatchObject({ monthlyLimit: 1000 });
    expect(JSON.parse(row?.after ?? 'null')).toMatchObject({ monthlyLimit: 50, dailyLimit: 5 });
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it('clearing limits to null audits null, not the old value', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const added = await app.inject({
      method: 'POST',
      url: '/api/assistant/search-keys',
      headers,
      payload: { source: 'brave', label: 'A', apiKey: SECRET, dailyLimit: 5 },
    });
    const keyId = added.json<{ keyId: string }>().keyId;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/assistant/search-keys/${keyId}`,
      headers,
      payload: { monthlyLimit: null, dailyLimit: null },
    });
    expect(patched.statusCode).toBe(200);
    const row = auditRows().find((r) => r.action === 'assistant_search.key_updated');
    expect(JSON.parse(row?.before ?? 'null')).toMatchObject({
      monthlyLimit: 1000,
      dailyLimit: 5,
    });
    expect(JSON.parse(row?.after ?? 'null')).toMatchObject({
      monthlyLimit: null,
      dailyLimit: null,
    });
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it('replacing the key audits keyReplaced without the key', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const added = await app.inject({
      method: 'POST',
      url: '/api/assistant/search-keys',
      headers,
      payload: { source: 'brave', label: 'A', apiKey: SECRET },
    });
    const keyId = added.json<{ keyId: string }>().keyId;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/assistant/search-keys/${keyId}`,
      headers,
      payload: { apiKey: SECRET },
    });
    expect(patched.statusCode).toBe(200);
    const row = auditRows().find((r) => r.action === 'assistant_search.key_updated');
    expect(JSON.parse(row?.after ?? 'null')).toMatchObject({ keyReplaced: true });
    expect(auditText()).not.toContain(SECRET);
  });
});

describe('POST /api/assistant/search-keys/:keyId/move', () => {
  it('404s an unknown id, 400s a bad direction, and moves', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const missing = await app.inject({
      method: 'POST',
      url: '/api/assistant/search-keys/sk_missing/move',
      headers,
      payload: { direction: 'up' },
    });
    expect(missing.statusCode).toBe(404);
    const added = await app.inject({
      method: 'POST',
      url: '/api/assistant/search-keys',
      headers,
      payload: { source: 'brave', label: 'A', apiKey: SECRET },
    });
    const keyId = added.json<{ keyId: string }>().keyId;
    const bad = await app.inject({
      method: 'POST',
      url: `/api/assistant/search-keys/${keyId}/move`,
      headers,
      payload: { direction: 'sideways' },
    });
    expect(bad.statusCode).toBe(400);
    const moved = await app.inject({
      method: 'POST',
      url: `/api/assistant/search-keys/${keyId}/move`,
      headers,
      payload: { direction: 'down' },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toEqual({ ok: true });
    const row = auditRows().find((r) => r.action === 'assistant_search.key_moved');
    expect(JSON.parse(row?.after ?? 'null')).toEqual({ direction: 'down' });
  });
});

describe('DELETE /api/assistant/search-keys/:keyId', () => {
  it('404s an unknown id, removes, and GET no longer lists it', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const missing = await app.inject({
      method: 'DELETE',
      url: '/api/assistant/search-keys/sk_missing',
      headers,
    });
    expect(missing.statusCode).toBe(404);
    const added = await app.inject({
      method: 'POST',
      url: '/api/assistant/search-keys',
      headers,
      payload: { source: 'brave', label: 'A', apiKey: SECRET },
    });
    const keyId = added.json<{ keyId: string }>().keyId;
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/assistant/search-keys/${keyId}`,
      headers,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true });
    const fetched = await app.inject({
      method: 'GET',
      url: '/api/assistant/search-keys',
      headers: { cookie: owner.cookie },
    });
    expect(fetched.json<{ keys: unknown[] }>().keys).toEqual([]);
    const row = auditRows().find((r) => r.action === 'assistant_search.key_removed');
    expect(JSON.parse(row?.before ?? 'null')).toEqual({ source: 'brave', label: 'A' });
    expect(auditText()).not.toContain(SECRET);
  });
});
