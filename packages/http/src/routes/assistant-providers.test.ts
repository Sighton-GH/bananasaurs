import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseGuildId, ProviderError } from '@bananasaurs/core';
import {
  accountRepo,
  authzRepo,
  effectRepo,
  eligibilityRepo,
  guildRepo,
} from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createServer, CSRF_HEADER, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAssistantProviderRoutes } from './assistant-providers.js';

const GUILD = parseGuildId('111111111111111111');
const OWNER = 'acct_0123456789abcdef0123456789abcdef';
const OPERATOR = 'acct_fedcba9876543210fedcba9876543210';
const PASSWORD = 'correct horse battery staple';
const SECRET = 'sk-test-SECRET-xyz-12345';

let t: MigratedTestDatabase;
let deps: HttpDeps;
let app: FastifyInstance;
let clock: number;

interface FakeKey {
  keyId: string;
  provider: string;
  label: string;
  costClass: 'free' | 'paid' | 'unknown';
  enabled: boolean;
}

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
    .filter((row) => row.action.startsWith('assistant_provider.'));

const auditText = (): string =>
  auditRows()
    .map((row) => `${row.action} ${row.before ?? ''} ${row.after ?? ''}`)
    .join('\n');

/** In-memory stand-in for the daemon's ProviderConfigStore. The key is accepted and dropped. */
const fakeStore = (
  over: {
    keys?: FakeKey[];
    chain?: { keyId: string; model: string; rpmLimit?: number | null; rpdLimit?: number | null }[];
    eligibility?: Record<string, { trainsOnInput: string; productionUseAllowed: boolean }>;
    webSearch?: { keyConfigured: boolean; enabled: boolean };
    githubConfigured?: boolean;
    modelUsage?: (entry: {
      readonly keyId: string;
      readonly model: string;
      readonly providerId: string;
      readonly rpmLimit: number | null;
      readonly rpdLimit: number | null;
    }) =>
      | { readonly lastMinute: number; readonly today: number; readonly availableAt?: number }
      | undefined;
  } = {},
) => {
  let keys: FakeKey[] = over.keys ?? [
    { keyId: 'key_a', provider: 'gemini', label: 'Main key', costClass: 'free', enabled: true },
  ];
  let chain: {
    keyId: string;
    model: string;
    rpmLimit?: number | null;
    rpdLimit?: number | null;
  }[] = over.chain ?? [{ keyId: 'key_a', model: 'gemini-2.5-flash' }];
  let next = 1;
  const eligibility = over.eligibility ?? {
    gemini: { trainsOnInput: 'no', productionUseAllowed: true },
  };
  const findKey = (keyId: string): FakeKey | undefined => keys.find((k) => k.keyId === keyId);
  const providerOf = (keyId: string): string => findKey(keyId)?.provider ?? 'gemini';
  const labelOf = (keyId: string): string => findKey(keyId)?.label ?? keyId;
  return {
    status: () => ({
      provider: 'gemini',
      enabled: true,
      modelConfigured: true,
      keyConfigured: keys.length > 0,
      keyReadable: true,
      costClass: 'unknown' as const,
      secretSource: 'file' as const,
      ...(over.webSearch === undefined ? {} : { webSearch: over.webSearch }),
    }),
    save: () => undefined,
    keys: () => keys.map((k) => ({ ...k })),
    addKey: (input: { provider: string; label: string; costClass?: string }) => {
      const keyId = `key_new_${String(next++)}`;
      keys.push({
        keyId,
        provider: input.provider,
        label: input.label,
        costClass: (input.costClass ?? 'unknown') as FakeKey['costClass'],
        enabled: true,
      });
      return keyId;
    },
    updateKey: (
      keyId: string,
      input: { label?: string; costClass?: string; enabled?: boolean },
    ) => {
      keys = keys.map((k) =>
        k.keyId === keyId
          ? {
              ...k,
              ...(input.label === undefined ? {} : { label: input.label }),
              ...(input.costClass === undefined
                ? {}
                : { costClass: input.costClass as FakeKey['costClass'] }),
              ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            }
          : k,
      );
    },
    removeKey: (keyId: string) => {
      keys = keys.filter((k) => k.keyId !== keyId);
      chain = chain.filter((row) => row.keyId !== keyId);
    },
    chain: () =>
      chain.map((row) => {
        const key = findKey(row.keyId);
        if (key === undefined || !key.enabled) {
          return {
            providerId: providerOf(row.keyId),
            model: row.model,
            keyId: row.keyId,
            keyLabel: labelOf(row.keyId),
            provider: undefined,
            skip: key === undefined ? ('no-key' as const) : ('disabled' as const),
            mayTrain: false,
            rpmLimit: row.rpmLimit ?? null,
            rpdLimit: row.rpdLimit ?? null,
          };
        }
        const elig = eligibility[key.provider];
        if (elig === undefined) {
          return {
            providerId: key.provider,
            model: row.model,
            keyId: row.keyId,
            keyLabel: key.label,
            provider: undefined,
            skip: 'unverified' as const,
            mayTrain: false,
            rpmLimit: row.rpmLimit ?? null,
            rpdLimit: row.rpdLimit ?? null,
          };
        }
        if (!elig.productionUseAllowed) {
          return {
            providerId: key.provider,
            model: row.model,
            keyId: row.keyId,
            keyLabel: key.label,
            provider: undefined,
            skip: 'ineligible' as const,
            mayTrain: false,
            rpmLimit: row.rpmLimit ?? null,
            rpdLimit: row.rpdLimit ?? null,
          };
        }
        return {
          providerId: key.provider,
          model: row.model,
          keyId: row.keyId,
          keyLabel: key.label,
          provider: {
            id: key.provider,
            capabilities: new Set(['text']),
            generateText: async () => ({ text: 'ready', model: row.model }),
          },
          skip: undefined,
          mayTrain: elig.trainsOnInput !== 'no',
          rpmLimit: row.rpmLimit ?? null,
          rpdLimit: row.rpdLimit ?? null,
        };
      }),
    saveChain: (
      rows: readonly {
        keyId: string;
        model: string;
        rpmLimit?: number | null;
        rpdLimit?: number | null;
      }[],
    ) => {
      chain = rows.map((r) => ({ ...r }));
    },
    ...(over.modelUsage === undefined ? {} : { modelUsage: over.modelUsage }),
    saveGithubToken: () => undefined,
    isKeyReadable: () => true,
    githubTokenConfigured: () => over.githubConfigured ?? false,
    listModels: async () => [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }],
  };
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
    assistantProviderConfig: fakeStore() as unknown as HttpDeps['assistantProviderConfig'],
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
  eligibilityRepo.recordEligibilityClaim(t.scopes.instance(), {
    provider: 'gemini',
    trainsOnInput: 'no',
    evidenceUrl: 'https://example.test/terms',
    evidenceClause: 'Does not train on input.',
    productionUseAllowed: true,
    now: clock,
  });
  app = createServer({ deps, registerRoutes: registerAssistantProviderRoutes });
});
afterEach(async () => {
  await app.close();
  t.close();
});

describe('GET /api/assistant/providers permission split', () => {
  it('answers the owner and refuses anyone else with owner-only', async () => {
    const owner = await signInAs('owner');
    const ok = await app.inject({
      method: 'GET',
      url: '/api/assistant/providers',
      headers: { cookie: owner.cookie },
    });
    expect(ok.statusCode).toBe(200);
    const operator = await signInAs('operator');
    const refused = await app.inject({
      method: 'GET',
      url: '/api/assistant/providers',
      headers: { cookie: operator.cookie },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'owner-only' });
  });
});

describe('key routes are owner-only', () => {
  it.each([
    ['POST', '/api/assistant/keys'],
    ['PATCH', '/api/assistant/keys/key_a'],
    ['DELETE', '/api/assistant/keys/key_a'],
    ['PUT', '/api/assistant/model-chain'],
    ['POST', '/api/assistant/model-chain/test'],
    ['PUT', '/api/assistant/github-token'],
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

describe('key validation codes', () => {
  it('rejects a bad provider, a blank label and a missing key', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const badProvider = await app.inject({
      method: 'POST',
      url: '/api/assistant/keys',
      headers,
      payload: { provider: 'nope', label: 'Main', apiKey: SECRET },
    });
    expect(badProvider.statusCode).toBe(400);
    const longLabel = await app.inject({
      method: 'POST',
      url: '/api/assistant/keys',
      headers,
      payload: { provider: 'gemini', label: 'x'.repeat(61), apiKey: SECRET },
    });
    expect(longLabel.statusCode).toBe(400);
    const missingKey = await app.inject({
      method: 'POST',
      url: '/api/assistant/keys',
      headers,
      payload: { provider: 'gemini', label: 'Main' },
    });
    expect(missingKey.statusCode).toBe(400);
  });

  it('rejects an unknown key in the chain as unknown-key', async () => {
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'PUT',
      url: '/api/assistant/model-chain',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: { entries: [{ keyId: 'key_missing', model: 'm' }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'unknown-key' });
  });

  it('rejects a duplicate pair as duplicate-entry and seven rows as too-many', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const duplicate = await app.inject({
      method: 'PUT',
      url: '/api/assistant/model-chain',
      headers,
      payload: {
        entries: [
          { keyId: 'key_a', model: 'm' },
          { keyId: 'key_a', model: 'm' },
        ],
      },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({ error: 'duplicate-entry' });
    const many = await app.inject({
      method: 'PUT',
      url: '/api/assistant/model-chain',
      headers,
      payload: {
        entries: Array.from({ length: 7 }, (_, i) => ({ keyId: 'key_a', model: `m${i}` })),
      },
    });
    expect(many.statusCode).toBe(400);
    expect(many.json()).toMatchObject({ error: 'too-many' });
  });

  it('allows the same model on two keys', async () => {
    deps = {
      ...deps,
      assistantProviderConfig: fakeStore({
        keys: [
          { keyId: 'key_a', provider: 'gemini', label: 'A', costClass: 'free', enabled: true },
          { keyId: 'key_b', provider: 'gemini', label: 'B', costClass: 'free', enabled: true },
        ],
      }) as unknown as HttpDeps['assistantProviderConfig'],
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantProviderRoutes });
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'PUT',
      url: '/api/assistant/model-chain',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: {
        entries: [
          { keyId: 'key_a', model: 'gemini-2.5-flash' },
          { keyId: 'key_b', model: 'gemini-2.5-flash' },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('a key never appears in any response, audit row, log or error', () => {
  it('add, edit, get, chain save and chain test keep the key out', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const added = await app.inject({
      method: 'POST',
      url: '/api/assistant/keys',
      headers,
      payload: { provider: 'gemini', label: 'Spare', apiKey: SECRET },
    });
    expect(added.statusCode).toBe(200);
    expect(JSON.stringify(added.json())).not.toContain(SECRET);
    const keyId = added.json<{ keyId: string }>().keyId;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/assistant/keys/${keyId}`,
      headers,
      payload: { apiKey: SECRET },
    });
    expect(patched.statusCode).toBe(200);
    expect(JSON.stringify(patched.json())).not.toContain(SECRET);
    const fetched = await app.inject({
      method: 'GET',
      url: '/api/assistant/providers',
      headers: { cookie: owner.cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect(JSON.stringify(fetched.json())).not.toContain(SECRET);
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/assistant/model-chain',
      headers,
      payload: { entries: [{ keyId, model: 'gemini-2.5-flash' }] },
    });
    expect(saved.statusCode).toBe(200);
    expect(JSON.stringify(saved.json())).not.toContain(SECRET);
    const tested = await app.inject({
      method: 'POST',
      url: '/api/assistant/model-chain/test',
      headers,
      payload: { position: 0 },
    });
    expect(tested.statusCode).toBe(200);
    expect(JSON.stringify(tested.json())).not.toContain(SECRET);
    expect(auditText()).not.toContain(SECRET);
    expect(auditRows().length).toBeGreaterThan(0);
    for (const row of auditRows()) {
      expect(JSON.stringify(row)).not.toContain(SECRET);
    }
  });
});

describe('GET shape and ledger reset', () => {
  it('lists providers, keys, chain, web search and the github flag', async () => {
    deps = {
      ...deps,
      assistantProviderConfig: fakeStore({
        webSearch: { keyConfigured: true, enabled: true },
        githubConfigured: true,
      }) as unknown as HttpDeps['assistantProviderConfig'],
      assistantAllowanceResetsAt: () => undefined,
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantProviderRoutes });
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/providers',
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      providers: {
        provider: string;
        eligibility: string;
        supportsTools: boolean;
        keyCount: number;
      }[];
      keys: { keyId: string; provider: string; label: string }[];
      chain: {
        position: number;
        keyId: string;
        keyLabel: string;
        provider: string;
        model: string;
        status: string;
      }[];
      webSearch: { keyConfigured: boolean; enabled: boolean };
      github: { tokenConfigured: boolean };
    }>();
    expect(body.providers.map((p) => p.provider).sort()).toEqual([
      'gemini',
      'nvidia-nim',
      'openrouter',
    ]);
    expect(body.providers.every((p) => p.supportsTools)).toBe(true);
    expect(body.providers.find((p) => p.provider === 'gemini')).toMatchObject({
      eligibility: 'eligible',
      keyCount: 1,
    });
    expect(body.keys).toMatchObject([{ keyId: 'key_a', provider: 'gemini', label: 'Main key' }]);
    expect(body.chain).toMatchObject([
      {
        position: 0,
        keyId: 'key_a',
        keyLabel: 'Main key',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        status: 'ready',
      },
    ]);
    expect(body.webSearch).toEqual({ keyConfigured: true, enabled: true });
    expect(body.github).toEqual({ tokenConfigured: true });
  });

  it('shows the allowance reset from the shared ledger', async () => {
    const resetAt = clock + 3_600_000;
    deps = {
      ...deps,
      assistantAllowanceResetsAt: (keyId) => (keyId === 'key_a' ? resetAt : undefined),
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantProviderRoutes });
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/providers',
      headers: { cookie: owner.cookie },
    });
    const body = response.json<{
      keys: { keyId: string; allowanceResetsAt?: number }[];
      chain: { status: string; allowanceResetsAt?: number }[];
    }>();
    expect(body.keys.find((k) => k.keyId === 'key_a')?.allowanceResetsAt).toBe(resetAt);
    expect(body.chain[0]).toMatchObject({ status: 'allowance-used', allowanceResetsAt: resetAt });
  });

  it('marks an unverified provider and its chain row', async () => {
    deps = {
      ...deps,
      assistantProviderConfig: fakeStore({
        keys: [
          {
            keyId: 'key_or',
            provider: 'openrouter',
            label: 'OR',
            costClass: 'free',
            enabled: true,
          },
        ],
        chain: [{ keyId: 'key_or', model: 'some-model' }],
        eligibility: {},
      }) as unknown as HttpDeps['assistantProviderConfig'],
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantProviderRoutes });
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/providers',
      headers: { cookie: owner.cookie },
    });
    const body = response.json<{
      providers: { provider: string; eligibility: string }[];
      chain: { status: string }[];
    }>();
    expect(body.providers.find((p) => p.provider === 'openrouter')?.eligibility).toBe('unverified');
    expect(body.chain[0]?.status).toBe('unverified');
  });
});

describe('chain test and github token', () => {
  it('tests one entry with the ready prompt and reports latency', async () => {
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/model-chain/test',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: { position: 0 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ ok: boolean; latencyMs: number; reply?: string }>();
    expect(body.ok).toBe(true);
    expect(body.reply).toBe('ready');
    expect(typeof body.latencyMs).toBe('number');
  });

  it('saves and clears the github token without ever returning it', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/assistant/github-token',
      headers,
      payload: { token: 'ghp_secret-token' },
    });
    expect(saved.statusCode).toBe(200);
    expect(JSON.stringify(saved.json())).not.toContain('ghp_secret-token');
    const cleared = await app.inject({
      method: 'PUT',
      url: '/api/assistant/github-token',
      headers,
      payload: { token: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(auditText()).not.toContain('ghp_secret-token');
  });

  it('deletes a key and its chain rows', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/assistant/keys/key_a',
      headers,
    });
    expect(removed.statusCode).toBe(200);
    const fetched = await app.inject({
      method: 'GET',
      url: '/api/assistant/providers',
      headers: { cookie: owner.cookie },
    });
    expect(fetched.json<{ keys: unknown[]; chain: unknown[] }>()).toMatchObject({
      keys: [],
      chain: [],
    });
  });
});

describe('chain-test edge cases', () => {
  const TERMS =
    "The AI provider's terms are not recorded or don't allow this use, so no content was sent outside the server.";

  it('answers 404 not-found for an out-of-range position', async () => {
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/model-chain/test',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: { position: 5 },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not-found' });
  });

  it('refuses a store-skipped ineligible entry with the terms sentence', async () => {
    deps = {
      ...deps,
      assistantProviderConfig: fakeStore({
        eligibility: { gemini: { trainsOnInput: 'no', productionUseAllowed: false } },
      }) as unknown as HttpDeps['assistantProviderConfig'],
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantProviderRoutes });
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/model-chain/test',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: { position: 0 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ ok: boolean; latencyMs: number; error?: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBe(TERMS);
  });

  it('refuses a repo-unverified entry without calling the provider', async () => {
    const base = fakeStore({
      keys: [
        {
          keyId: 'key_or',
          provider: 'openrouter',
          label: 'OR',
          costClass: 'free',
          enabled: true,
        },
      ],
      chain: [{ keyId: 'key_or', model: 'some-model' }],
      eligibility: { openrouter: { trainsOnInput: 'no', productionUseAllowed: true } },
    });
    let calls = 0;
    const store = {
      ...base,
      chain: () =>
        base.chain().map((entry) =>
          entry.provider === undefined
            ? entry
            : {
                ...entry,
                provider: {
                  ...entry.provider,
                  generateText: async () => {
                    calls += 1;
                    return entry.provider.generateText();
                  },
                },
              },
        ),
    };
    deps = {
      ...deps,
      assistantProviderConfig: store as unknown as HttpDeps['assistantProviderConfig'],
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantProviderRoutes });
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/model-chain/test',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: { position: 0 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ ok: boolean; latencyMs: number; error?: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBe(TERMS);
    expect(calls).toBe(0);
  });
});

describe('PATCH validation and owner-only with capabilities', () => {
  it('rejects an empty PATCH body with 400', async () => {
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/assistant/keys/key_a',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'bad-request' });
  });

  it('refuses a config.write non-owner with owner-only on GET and on a write route', async () => {
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD), {
      accountId: OPERATOR,
      capability: 'config.write',
      grantedBy: 'test',
      now: clock,
    });
    const operator = await signInAs('operator');
    const fetched = await app.inject({
      method: 'GET',
      url: '/api/assistant/providers',
      headers: { cookie: operator.cookie },
    });
    expect(fetched.statusCode).toBe(403);
    expect(fetched.json()).toMatchObject({ error: 'owner-only' });
    const written = await app.inject({
      method: 'POST',
      url: '/api/assistant/keys',
      headers: { cookie: operator.cookie, [CSRF_HEADER]: operator.csrf },
      payload: { provider: 'gemini', label: 'Sneaky', apiKey: SECRET },
    });
    expect(written.statusCode).toBe(403);
    expect(written.json()).toMatchObject({ error: 'owner-only' });
  });
});

describe('chain-test provider failures are fixed sentences', () => {
  const rebuildWithThrower = async (thrown: unknown): Promise<void> => {
    const base = fakeStore();
    const store = {
      ...base,
      chain: () =>
        base.chain().map((entry) =>
          entry.provider === undefined
            ? entry
            : {
                ...entry,
                provider: {
                  ...entry.provider,
                  generateText: async (): Promise<{ text: string; model: string }> => {
                    throw thrown;
                  },
                },
              },
        ),
    };
    deps = {
      ...deps,
      assistantProviderConfig: store as unknown as HttpDeps['assistantProviderConfig'],
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantProviderRoutes });
  };

  const testAt = async (position = 0) => {
    const owner = await signInAs('owner');
    return app.inject({
      method: 'POST',
      url: '/api/assistant/model-chain/test',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: { position },
    });
  };

  it('never echoes a key-bearing provider error', async () => {
    await rebuildWithThrower(new Error(`provider says no: ${SECRET}`));
    const response = await testAt();
    expect(response.statusCode).toBe(200);
    const text = JSON.stringify(response.json());
    expect(text).not.toContain(SECRET);
    expect(response.json()).toMatchObject({ ok: false, error: 'The provider request failed' });
  });

  it.each([
    ['authentication', `HTTP 401 for key ${SECRET}`, 'The provider rejected the API key'],
    ['timeout', 'timed out after 30s', 'The provider did not answer in time'],
    ['invalid-request', 'no such model', 'This model is not available on this key'],
    ['capability-mismatch', 'no text support', 'This model is not available on this key'],
    ['outage', 'HTTP 503', 'The request to the provider failed'],
  ])('maps %s to its classified title', async (kind, message, sentence) => {
    await rebuildWithThrower(
      new ProviderError(kind as 'authentication', `${message} ${SECRET}`, false),
    );
    const response = await testAt();
    const text = JSON.stringify(response.json());
    expect(text).not.toContain(SECRET);
    expect(response.json()).toMatchObject({ ok: false, error: sentence });
  });
});

describe('Task 10 (f): chain test classifies failures and honours reserveTestCall', () => {
  const rebuildWithThrower = async (thrown: unknown): Promise<void> => {
    const base = fakeStore();
    const store = {
      ...base,
      chain: () =>
        base.chain().map((entry) =>
          entry.provider === undefined
            ? entry
            : {
                ...entry,
                provider: {
                  ...entry.provider,
                  generateText: async (): Promise<{ text: string; model: string }> => {
                    throw thrown;
                  },
                },
              },
        ),
    };
    deps = {
      ...deps,
      assistantProviderConfig: store as unknown as HttpDeps['assistantProviderConfig'],
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantProviderRoutes });
  };

  const testAt = async (position = 0) => {
    const owner = await signInAs('owner');
    return app.inject({
      method: 'POST',
      url: '/api/assistant/model-chain/test',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: { position },
    });
  };

  const connectTimeout = (): ProviderError =>
    new ProviderError('outage', 'UPSTREAM-SAID-xyz', true, {
      cause: new TypeError('fetch failed', {
        cause: Object.assign(new Error('Connect Timeout Error'), {
          code: 'UND_ERR_CONNECT_TIMEOUT',
        }),
      }),
      host: 'openrouter.ai',
    });

  it('classifies a connect-timeout without echoing provider text', async () => {
    await rebuildWithThrower(connectTimeout());
    const response = await testAt();
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      ok: boolean;
      failure?: { code?: string };
    }>();
    expect(body.ok).toBe(false);
    expect(body.failure?.code).toBe('provider-connect-timeout');
    expect(JSON.stringify(body)).not.toContain('UPSTREAM-SAID-xyz');
  });

  it('a reserveTestCall refusal answers local-rpm-limit without calling the provider', async () => {
    const base = fakeStore();
    let calls = 0;
    const store = {
      ...base,
      reserveTestCall: () => ({ ok: false, code: 'local-rpm-limit', availableAt: 123 }),
      chain: () =>
        base.chain().map((entry) =>
          entry.provider === undefined
            ? entry
            : {
                ...entry,
                provider: {
                  ...entry.provider,
                  generateText: async (): Promise<{ text: string; model: string }> => {
                    calls += 1;
                    return { text: 'ready', model: 'm' };
                  },
                },
              },
        ),
    };
    deps = {
      ...deps,
      assistantProviderConfig: store as unknown as HttpDeps['assistantProviderConfig'],
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantProviderRoutes });
    const response = await testAt();
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      ok: boolean;
      failure?: { code?: string };
    }>();
    expect(body.ok).toBe(false);
    expect(body.failure?.code).toBe('local-rpm-limit');
    expect(calls).toBe(0);
  });
});

describe('per-entry RPM/RPD limits (ADR 0081)', () => {
  it('PUT stores the limits, audits them and GET returns them', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/assistant/model-chain',
      headers,
      payload: {
        entries: [{ keyId: 'key_a', model: 'gemini-2.5-flash', rpmLimit: 15, rpdLimit: 1000 }],
      },
    });
    expect(saved.statusCode).toBe(200);
    const fetched = await app.inject({
      method: 'GET',
      url: '/api/assistant/providers',
      headers: { cookie: owner.cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect(
      fetched.json<{
        chain: { keyId: string; model: string; rpmLimit: number | null; rpdLimit: number | null }[];
      }>().chain[0],
    ).toMatchObject({ keyId: 'key_a', rpmLimit: 15, rpdLimit: 1000 });
    const audit = auditRows().find((row) => row.action === 'assistant_provider.chain_saved');
    expect(audit).toBeTruthy();
    const after = JSON.parse(audit!.after as string) as {
      entries: {
        keyId: string;
        model: string;
        rpmLimit: number | null;
        rpdLimit: number | null;
      }[];
    };
    expect(after.entries[0]).toMatchObject({
      keyId: 'key_a',
      model: 'gemini-2.5-flash',
      rpmLimit: 15,
      rpdLimit: 1000,
    });
  });

  it('PUT refuses 0 and 1.5 with a field error on entries.0.rpmLimit', async () => {
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const zero = await app.inject({
      method: 'PUT',
      url: '/api/assistant/model-chain',
      headers,
      payload: { entries: [{ keyId: 'key_a', model: 'm', rpmLimit: 0 }] },
    });
    expect(zero.statusCode).toBe(400);
    expect(zero.json<{ fields: { path: string; problem: string }[] }>().fields).toContainEqual({
      path: 'entries.0.rpmLimit',
      problem: expect.anything(),
    });
    const fractional = await app.inject({
      method: 'PUT',
      url: '/api/assistant/model-chain',
      headers,
      payload: { entries: [{ keyId: 'key_a', model: 'm', rpmLimit: 1.5 }] },
    });
    expect(fractional.statusCode).toBe(400);
    expect(
      fractional.json<{ fields: { path: string; problem: string }[] }>().fields,
    ).toContainEqual({
      path: 'entries.0.rpmLimit',
      problem: expect.anything(),
    });
  });

  it('PUT without the limit keys saves null for both', async () => {
    const store = deps.assistantProviderConfig as unknown as {
      saveChain: (
        rows: readonly {
          keyId: string;
          model: string;
          rpmLimit?: number | null;
          rpdLimit?: number | null;
        }[],
        now?: number,
      ) => void;
    };
    const original = store.saveChain.bind(store);
    let savedRows: { rpmLimit?: number | null; rpdLimit?: number | null }[] = [];
    store.saveChain = (rows, now) => {
      savedRows = rows.map((row) => ({ ...row }));
      original(rows, now);
    };
    const owner = await signInAs('owner');
    const headers = { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf };
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/assistant/model-chain',
      headers,
      payload: { entries: [{ keyId: 'key_a', model: 'gemini-2.5-flash' }] },
    });
    expect(saved.statusCode).toBe(200);
    expect(savedRows).toHaveLength(1);
    expect(savedRows[0]?.rpmLimit).toBeNull();
    expect(savedRows[0]?.rpdLimit).toBeNull();
    const fetched = await app.inject({
      method: 'GET',
      url: '/api/assistant/providers',
      headers: { cookie: owner.cookie },
    });
    expect(
      fetched.json<{ chain: { rpmLimit: number | null; rpdLimit: number | null }[] }>().chain[0],
    ).toMatchObject({ rpmLimit: null, rpdLimit: null });
  });

  it('GET includes usage from modelUsage and omits it when undefined', async () => {
    deps = {
      ...deps,
      assistantProviderConfig: fakeStore({
        modelUsage: () => ({ lastMinute: 3, today: 40, availableAt: 123 }),
      }) as unknown as HttpDeps['assistantProviderConfig'],
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantProviderRoutes });
    const owner = await signInAs('owner');
    const withUsage = await app.inject({
      method: 'GET',
      url: '/api/assistant/providers',
      headers: { cookie: owner.cookie },
    });
    expect(withUsage.json<{ chain: { usage?: unknown }[] }>().chain[0]?.usage).toEqual({
      lastMinute: 3,
      today: 40,
      availableAt: 123,
    });

    deps = {
      ...deps,
      assistantProviderConfig: fakeStore({
        modelUsage: () => undefined,
      }) as unknown as HttpDeps['assistantProviderConfig'],
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantProviderRoutes });
    const owner2 = await signInAs('owner');
    const withoutUsage = await app.inject({
      method: 'GET',
      url: '/api/assistant/providers',
      headers: { cookie: owner2.cookie },
    });
    expect(
      'usage' in (withoutUsage.json<{ chain: Record<string, unknown>[] }>().chain[0] ?? {}),
    ).toBe(false);
  });
});
