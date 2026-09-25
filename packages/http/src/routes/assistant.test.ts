import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CLUB_ASSISTANT_SKILLS,
  JOB_KINDS,
  parseGuildId,
  ProviderError,
  resourceRefreshDedupeKey,
  skillInstructionLine,
  STARTER_SKILL_IDS,
  TOOL_CATALOGUE,
  type Capability,
} from '@bananasaurs/core';
import {
  accountRepo,
  assistantRepo,
  authzRepo,
  effectRepo,
  guildRepo,
  jobRepo,
} from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createServer, CSRF_HEADER, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAssistantRoutes } from './assistant.js';

const GUILD = parseGuildId('111111111111111111');
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const ROLE_A = '222222222222222222';
const ROLE_B = '333333333333333333';
let t: MigratedTestDatabase;
let deps: HttpDeps;
let app: FastifyInstance;
let clock: number;

const cookieFrom = (header: string | string[] | undefined): string =>
  (Array.isArray(header) ? (header[0] ?? '') : (header ?? '')).split(';')[0] ?? '';
const signIn = async (): Promise<{ cookie: string; csrf: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'owner', password: PASSWORD, guildId: GUILD },
  });
  return {
    cookie: cookieFrom(response.headers['set-cookie']),
    csrf: response.json<{ csrfToken: string }>().csrfToken,
  };
};
const grant = (capability: Capability): void =>
  authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD), {
    accountId: ACCOUNT,
    capability,
    grantedBy: 'test',
    now: clock,
  });
const body = (over: Record<string, unknown> = {}) => ({
  id: 'club',
  surface: 'bananasaurs',
  mentionRoleId: ROLE_A,
  name: 'Club',
  systemPrompt: 'Be helpful.',
  promptVersion: 0,
  allowedSkillIds: ['search-club'],
  callerRoleIds: [],
  ticket: { reviewerRoleIds: [] },
  resourceIds: [],
  enabled: true,
  ...over,
});
const put = (cookie: string, csrf: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PUT',
    url: `/api/assistant/behaviours/${String(payload.id)}`,
    headers: { cookie, [CSRF_HEADER]: csrf },
    payload,
  });

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
  accountRepo.createAccount(t.scopes.instance(), {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), ACCOUNT);
  app = createServer({ deps, registerRoutes: registerAssistantRoutes });
});
afterEach(async () => {
  await app.close();
  t.close();
});

describe('assistant routes', () => {
  it('requires config.read for the directory and config.write for changes', async () => {
    const { cookie, csrf } = await signIn();
    expect(
      (await app.inject({ method: 'GET', url: '/api/assistant', headers: { cookie } })).statusCode,
    ).toBe(403);
    grant('config.read');
    expect(
      (await app.inject({ method: 'GET', url: '/api/assistant', headers: { cookie } })).statusCode,
    ).toBe(200);
    expect((await put(cookie, csrf, body())).statusCode).toBe(403);
  });

  it('returns prompt-version-conflict without overwriting', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    expect((await put(cookie, csrf, body())).statusCode).toBe(200);
    const conflict = await put(cookie, csrf, body({ systemPrompt: 'stale edit' }));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'prompt-version-conflict', currentVersion: 1 });
    expect(assistantRepo.listBehaviours(t.scopes.forGuild(GUILD))[0]?.systemPrompt).toBe(
      'Be helpful.',
    );
  });

  it('requires a mention role outside direct command and refuses ambiguous enabled routes', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const missing = await put(cookie, csrf, body({ mentionRoleId: undefined }));
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ error: 'mention-role-required' });
    expect((await put(cookie, csrf, body())).statusCode).toBe(200);
    const duplicateMention = await put(
      cookie,
      csrf,
      body({ id: 'help', surface: 'help', name: 'Help', promptVersion: 0 }),
    );
    expect(duplicateMention.statusCode).toBe(409);
    expect(duplicateMention.json()).toEqual({ error: 'behaviour-conflict', behaviourId: 'club' });
    expect(
      (
        await put(
          cookie,
          csrf,
          body({ id: 'direct', surface: 'direct-command', mentionRoleId: undefined }),
        )
      ).statusCode,
    ).toBe(200);
    const duplicateDirect = await put(
      cookie,
      csrf,
      body({ id: 'direct-two', surface: 'direct-command', mentionRoleId: undefined }),
    );
    expect(duplicateDirect.statusCode).toBe(409);
    expect(duplicateDirect.json()).toEqual({ error: 'behaviour-conflict', behaviourId: 'direct' });
    expect(
      (
        await put(
          cookie,
          csrf,
          body({ id: 'disabled', surface: 'help', mentionRoleId: ROLE_A, enabled: false }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await put(cookie, csrf, body({ id: 'other', surface: 'help', mentionRoleId: ROLE_B })))
        .statusCode,
    ).toBe(200);
  });
});

describe('assistant provider configuration', () => {
  it('refuses key input when the encrypted secret store is not configured', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/assistant/provider',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { provider: 'gemini', model: 'x', apiKey: 'must-not-echo', enabled: true },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('must-not-echo');
  });
  it('returns only keyConfigured after a write', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    let saved = false;
    deps = {
      ...deps,
      assistantProviderConfig: {
        status: () => ({
          provider: 'gemini',
          enabled: true,
          modelConfigured: true,
          keyConfigured: saved,
          keyReadable: saved,
          costClass: 'unknown',
          secretSource: 'env',
        }),
        save: (input) => {
          expect(input.apiKey).toBe('must-not-echo');
          saved = true;
        },
      },
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantRoutes });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/assistant/provider',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { provider: 'gemini', model: 'x', apiKey: 'must-not-echo', enabled: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      provider: 'gemini',
      enabled: true,
      modelConfigured: true,
      keyConfigured: true,
      keyReadable: true,
      costClass: 'unknown',
      secretSource: 'env',
    });
    expect(response.body).not.toContain('must-not-echo');
  });
});

describe('assistant memory routes', () => {
  it('round-trips server card and sectioned memory without exposing another guild', async () => {
    grant('config.read');
    grant('config.write');
    const { cookie, csrf } = await signIn();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/assistant/server-card',
          headers: { cookie, [CSRF_HEADER]: csrf },
          payload: { content: 'Club operating context' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/assistant/memories/goal-1',
          headers: { cookie, [CSRF_HEADER]: csrf },
          payload: { id: 'goal-1', section: 'Club goals', content: 'Finish the EV build' },
        })
      ).statusCode,
    ).toBe(200);
    const result = await app.inject({ method: 'GET', url: '/api/assistant', headers: { cookie } });
    expect(result.json()).toMatchObject({
      serverCard: 'Club operating context',
      memories: [{ id: 'goal-1', section: 'Club goals', content: 'Finish the EV build' }],
    });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/assistant/memories/goal-1',
          headers: { cookie, [CSRF_HEADER]: csrf },
        })
      ).statusCode,
    ).toBe(200);
    expect(assistantRepo.listMemories(t.scopes.forGuild(GUILD))).toEqual([]);
  });
});

describe('memory proposal save', () => {
  it('validates before transition and then materializes memory atomically', async () => {
    grant('config.read');
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const s = t.scopes.forGuild(GUILD);
    assistantRepo.insertDecisionDraft(s, {
      id: 'mp',
      kind: 'memory',
      summary: 'draft',
      requesterId: ROLE_A,
      provenance: 'test',
      at: clock,
    });
    expect(assistantRepo.transitionDecision(s, 'mp', 'draft', 'reviewed')).toBe(true);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/assistant/decisions/mp/save',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: {},
    });
    expect(bad.statusCode).toBe(400);
    expect(assistantRepo.listDecisions(s)[0]).toMatchObject({ status: 'reviewed' });
    const good = await app.inject({
      method: 'POST',
      url: '/api/assistant/decisions/mp/save',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { section: 'Exec', content: 'Confirm budget' },
    });
    expect(good.statusCode).toBe(200);
    expect(assistantRepo.listDecisions(s)[0]).toMatchObject({ status: 'saved' });
    expect(assistantRepo.listMemories(s)[0]).toMatchObject({
      section: 'Exec',
      content: 'Confirm budget',
    });
  });
});

describe('assistant context writes are audited', () => {
  it('audits the server card, memory opt-out and member forget', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const headers = { cookie, [CSRF_HEADER]: csrf };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/assistant/server-card',
          headers,
          payload: { content: 'Club operating context' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/assistant/memory-preferences/${ROLE_A}`,
          headers,
          payload: { optedOut: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/assistant/member-memory/${ROLE_B}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    const actions = effectRepo.tailAudit(t.scopes.forGuild(GUILD), {}).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'assistant_server_card.saved',
        'assistant_memory_preference.saved',
        'assistant_member_memory.forgotten',
      ]),
    );
  });
});

describe('assistant setup checklist', () => {
  it('returns setup, providerTerms and viewerIsOwner for the owner', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    const result = await app.inject({ method: 'GET', url: '/api/assistant', headers: { cookie } });
    expect(result.statusCode).toBe(200);
    const body: {
      setup: { steps: { id: string }[]; answering: boolean };
      providerTerms: unknown;
      viewerIsOwner: boolean;
    } = result.json();
    expect(body.setup.steps.map((step) => step.id)).toEqual([
      'connect',
      'terms',
      'cost',
      'who',
      'skills',
      'on',
    ]);
    expect(body.providerTerms).toBeNull();
    expect(body.viewerIsOwner).toBe(true);
  });

  it('names the roles in the who step from the roles directory', async () => {
    grant('config.read');
    grant('config.write');
    const { cookie, csrf } = await signIn();
    expect((await put(cookie, csrf, body({ callerRoleIds: [ROLE_A, ROLE_B] }))).statusCode).toBe(
      200,
    );
    deps = {
      ...deps,
      assistantDirectories: () =>
        Promise.resolve({
          roles: [
            { id: ROLE_A, name: 'Member', position: 10 },
            { id: ROLE_B, name: 'Helper', position: 5 },
          ],
          members: [],
          channels: [],
        }),
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantRoutes });
    const result = await app.inject({ method: 'GET', url: '/api/assistant', headers: { cookie } });
    expect(result.statusCode).toBe(200);
    const parsed: { setup: { steps: { id: string; detail: string }[] } } = result.json();
    expect(parsed.setup.steps.find((step) => step.id === 'who')?.detail).toBe(
      'Member and Helper can ask.',
    );
  });

  it('falls back to counts when the roles directory is absent', async () => {
    grant('config.read');
    grant('config.write');
    const { cookie, csrf } = await signIn();
    expect((await put(cookie, csrf, body({ callerRoleIds: [ROLE_A, ROLE_B] }))).statusCode).toBe(
      200,
    );
    const result = await app.inject({ method: 'GET', url: '/api/assistant', headers: { cookie } });
    expect(result.statusCode).toBe(200);
    const parsed: { setup: { steps: { id: string; detail: string }[] } } = result.json();
    expect(parsed.setup.steps.find((step) => step.id === 'who')?.detail).toBe('2 roles can ask.');
  });
});

describe('provider cost statement is owner-only', () => {
  it('refuses a non-owner changing the cost class but lets them save other settings', async () => {
    const OPERATOR = 'acct_fedcba9876543210fedcba9876543210';
    accountRepo.createAccount(t.scopes.instance(), {
      accountId: OPERATOR,
      username: 'operator',
      passwordHash: await hashPassword(PASSWORD),
      isOwner: false,
      now: clock,
    });
    accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), OPERATOR);
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD), {
      accountId: OPERATOR,
      capability: 'config.write',
      grantedBy: 'test',
      now: clock,
    });
    let costClass: 'free' | 'paid' | 'unknown' = 'unknown';
    deps = {
      ...deps,
      assistantProviderConfig: {
        status: () => ({
          provider: 'gemini',
          enabled: false,
          modelConfigured: true,
          keyConfigured: true,
          keyReadable: true,
          costClass,
          secretSource: 'file',
        }),
        save: (input) => {
          costClass = input.costClass ?? costClass;
        },
      },
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantRoutes });
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'operator', password: PASSWORD, guildId: GUILD },
    });
    const cookie = cookieFrom(login.headers['set-cookie']);
    const csrf = login.json<{ csrfToken: string }>().csrfToken;
    const headers = { cookie, [CSRF_HEADER]: csrf };
    const refused = await app.inject({
      method: 'PUT',
      url: '/api/assistant/provider',
      headers,
      payload: { provider: 'gemini', enabled: true, costClass: 'free' },
    });
    expect(refused.statusCode).toBe(403);
    expect(costClass).toBe('unknown');
    const allowed = await app.inject({
      method: 'PUT',
      url: '/api/assistant/provider',
      headers,
      payload: { provider: 'gemini', enabled: true, costClass: 'unknown' },
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe('assistant skill-grant starter', () => {
  const postStarter = (cookie: string, csrf: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/assistant/skill-grants/starter',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload,
    });
  it('requires config.write', async () => {
    const { cookie, csrf } = await signIn();
    const response = await postStarter(cookie, csrf, { roleIds: [ROLE_A] });
    expect(response.statusCode).toBe(403);
  });
  it('rejects an empty roleIds or a non-snowflake', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const empty = await postStarter(cookie, csrf, { roleIds: [] });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: 'bad-request' });
    const bad = await postStarter(cookie, csrf, { roleIds: ['not-a-snowflake'] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'bad-request' });
  });
  it('grants the starter skills once, leaves confirmation skills alone, and stays idempotent', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const first = await postStarter(cookie, csrf, { roleIds: [ROLE_A, ROLE_B] });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ skillIds: [...STARTER_SKILL_IDS] });
    expect(STARTER_SKILL_IDS).toHaveLength(9);
    const scope = t.scopes.forGuild(GUILD);
    const grants = assistantRepo.listSkillGrants(scope);
    for (const skillId of STARTER_SKILL_IDS) {
      expect(grants.find((grant) => grant.skillId === skillId)?.roleIds).toEqual([ROLE_A, ROLE_B]);
    }
    expect(grants.find((grant) => grant.skillId === 'create-reminder')).toBeUndefined();
    const starterAudits = effectRepo
      .tailAudit(scope, {})
      .filter((row) => row.action === 'assistant_skill_grant.starter_applied');
    expect(starterAudits).toHaveLength(1);
    expect(starterAudits[0]).toMatchObject({
      action: 'assistant_skill_grant.starter_applied',
      subjectType: 'assistant_skill_grant',
      subjectId: 'starter',
    });
    const second = await postStarter(cookie, csrf, { roleIds: [ROLE_A, ROLE_B] });
    expect(second.statusCode).toBe(200);
    const afterSecond = assistantRepo.listSkillGrants(scope);
    for (const skillId of STARTER_SKILL_IDS) {
      expect(afterSecond.find((grant) => grant.skillId === skillId)?.roleIds).toEqual([
        ROLE_A,
        ROLE_B,
      ]);
    }
    expect(afterSecond).toEqual(grants);
  });
});

describe('PUT /api/assistant/bot-tag (ADR 0063)', () => {
  const putBotTag = (cookie: string, csrf: string, payload: unknown) =>
    app.inject({
      method: 'PUT',
      url: '/api/assistant/bot-tag',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: payload as Record<string, unknown>,
    });
  const flags = async (cookie: string) =>
    Object.fromEntries(
      (await app.inject({ method: 'GET', url: '/api/assistant', headers: { cookie } }))
        .json<{ behaviours: { id: string; answersBotTag: boolean }[] }>()
        .behaviours.map((b) => [b.id, b.answersBotTag]),
    );
  const auditRows = () =>
    effectRepo
      .tailAudit(t.scopes.forGuild(GUILD), {})
      .filter((row) => row.action === 'assistant_bot_tag.set');

  let cookie: string;
  let csrf: string;
  beforeEach(async () => {
    grant('config.read');
    grant('config.write');
    ({ cookie, csrf } = await signIn());
    expect((await put(cookie, csrf, body())).statusCode).toBe(200);
    expect(
      (await put(cookie, csrf, body({ id: 'help', surface: 'help', mentionRoleId: ROLE_B })))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await put(
          cookie,
          csrf,
          body({ id: 'off', surface: 'help', mentionRoleId: ROLE_B, enabled: false }),
        )
      ).statusCode,
    ).toBe(200);
  });

  it('sets, moves and clears the one behaviour that answers a bot tag', async () => {
    expect(await flags(cookie)).toEqual({ club: false, help: false, off: false });
    const set = await putBotTag(cookie, csrf, { behaviourId: 'club' });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ ok: true, behaviourId: 'club' });
    expect(await flags(cookie)).toEqual({ club: true, help: false, off: false });
    expect((await putBotTag(cookie, csrf, { behaviourId: 'help' })).statusCode).toBe(200);
    expect(await flags(cookie)).toEqual({ club: false, help: true, off: false });
    const cleared = await putBotTag(cookie, csrf, { behaviourId: null });
    expect(cleared.json()).toEqual({ ok: true, behaviourId: null });
    expect(await flags(cookie)).toEqual({ club: false, help: false, off: false });
  });

  it('audits each change with the previous and new behaviour', async () => {
    await putBotTag(cookie, csrf, { behaviourId: 'club' });
    await putBotTag(cookie, csrf, { behaviourId: 'help' });
    await putBotTag(cookie, csrf, { behaviourId: null });
    const rows = auditRows().map((row) => ({
      subjectId: row.subjectId,
      before: JSON.parse(row.before ?? 'null') as unknown,
      after: JSON.parse(row.after ?? 'null') as unknown,
    }));
    expect(rows).toEqual(
      expect.arrayContaining([
        { subjectId: 'club', before: { behaviourId: null }, after: { behaviourId: 'club' } },
        { subjectId: 'help', before: { behaviourId: 'club' }, after: { behaviourId: 'help' } },
        { subjectId: 'help', before: { behaviourId: 'help' }, after: { behaviourId: null } },
      ]),
    );
    expect(rows).toHaveLength(3);
  });

  it('refuses an unknown behaviour, a disabled one, and a malformed body without changing anything', async () => {
    await putBotTag(cookie, csrf, { behaviourId: 'club' });
    const missing = await putBotTag(cookie, csrf, { behaviourId: 'nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not-found' });
    const disabled = await putBotTag(cookie, csrf, { behaviourId: 'off' });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toEqual({ error: 'behaviour-disabled' });
    for (const payload of [{}, { behaviourId: 5 }, { behaviourId: '' }]) {
      const bad = await putBotTag(cookie, csrf, payload);
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toEqual({ error: 'bad-request' });
    }
    expect(await flags(cookie)).toEqual({ club: true, help: false, off: false });
    expect(auditRows()).toHaveLength(1);
  });
});

describe('PUT /api/assistant/bot-tag authorisation', () => {
  it('requires config.write', async () => {
    grant('config.read');
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/assistant/bot-tag',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { behaviourId: null },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('provider fallback model and web search (ADR 0066)', () => {
  const OPERATOR = 'acct_fedcba9876543210fedcba9876543211';
  type SaveInput = Parameters<NonNullable<HttpDeps['assistantProviderConfig']>['save']>[0];
  let saved: SaveInput[];
  const restart = async () => {
    saved = [];
    deps = {
      ...deps,
      assistantProviderConfig: {
        status: () => ({
          provider: 'gemini',
          enabled: true,
          modelConfigured: true,
          keyConfigured: true,
          keyReadable: true,
          costClass: 'free',
          secretSource: 'file',
          ...(saved.at(-1)?.fallbackModels
            ? { fallbackModels: [...saved.at(-1)!.fallbackModels!] }
            : {}),
          ...(saved.at(-1)?.searchEnabled !== undefined
            ? { webSearch: { keyConfigured: true, enabled: saved.at(-1)!.searchEnabled! } }
            : {}),
        }),
        save: (input) => {
          saved.push(input);
        },
      },
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantRoutes });
  };
  const putProvider = (cookie: string, csrf: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: '/api/assistant/provider',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { provider: 'gemini', enabled: true, ...payload },
    });

  it('lets the owner save a fallback model and a Brave key, and never audits the key', async () => {
    grant('config.write');
    await restart();
    const { cookie, csrf } = await signIn();
    const response = await putProvider(cookie, csrf, {
      fallbackModels: ['gemini-2.5-flash-lite', 'gemma-3-27b-it'],
      searchApiKey: 'brave-raw-key',
      searchEnabled: true,
    });
    expect(response.statusCode).toBe(200);
    expect(saved[0]).toMatchObject({
      fallbackModels: ['gemini-2.5-flash-lite', 'gemma-3-27b-it'],
      searchApiKey: 'brave-raw-key',
      searchEnabled: true,
    });
    const row = effectRepo
      .tailAudit(t.scopes.forGuild(GUILD), {})
      .find((r) => r.action === 'assistant_provider.saved');
    expect(JSON.parse(row?.after ?? 'null')).toMatchObject({
      fallbackModels: ['gemini-2.5-flash-lite', 'gemma-3-27b-it'],
      searchEnabled: true,
      searchKeyReplaced: true,
    });
    expect(JSON.stringify(row)).not.toContain('brave-raw-key');
    expect(JSON.stringify(response.json())).not.toContain('brave-raw-key');
  });

  it('clears the backups with an empty list and refuses more than two or a blank', async () => {
    grant('config.write');
    await restart();
    const { cookie, csrf } = await signIn();
    expect((await putProvider(cookie, csrf, { fallbackModels: [] })).statusCode).toBe(200);
    expect(saved[0]?.fallbackModels).toEqual([]);
    expect((await putProvider(cookie, csrf, { fallbackModels: ['a', 'b', 'c'] })).statusCode).toBe(
      400,
    );
    expect((await putProvider(cookie, csrf, { fallbackModels: [''] })).statusCode).toBe(400);
  });

  it('keeps turning on web search and replacing its key owner-only', async () => {
    accountRepo.createAccount(t.scopes.instance(), {
      accountId: OPERATOR,
      username: 'operator2',
      passwordHash: await hashPassword(PASSWORD),
      isOwner: false,
      now: clock,
    });
    accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), OPERATOR);
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD), {
      accountId: OPERATOR,
      capability: 'config.write',
      grantedBy: 'test',
      now: clock,
    });
    await restart();
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'operator2', password: PASSWORD, guildId: GUILD },
    });
    const cookie = cookieFrom(login.headers['set-cookie']);
    const csrf = login.json<{ csrfToken: string }>().csrfToken;
    const on = await putProvider(cookie, csrf, { searchEnabled: true });
    expect(on.statusCode).toBe(403);
    expect(on.json()).toEqual({ error: 'owner-only', field: 'searchEnabled' });
    const key = await putProvider(cookie, csrf, { searchApiKey: 'x'.repeat(20) });
    expect(key.json()).toEqual({ error: 'owner-only', field: 'searchApiKey' });
    expect(saved).toHaveLength(0);
  });
});

describe('PUT /api/assistant/log-channel (ADR 0065)', () => {
  const LOG = '444444444444444444';
  const putLog = (cookie: string, csrf: string, payload: unknown) =>
    app.inject({
      method: 'PUT',
      url: '/api/assistant/log-channel',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: payload as Record<string, unknown>,
    });

  it('sets and clears the log channel, audited, and GET reports it', async () => {
    grant('config.read');
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const set = await putLog(cookie, csrf, { channelId: LOG });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ ok: true, channelId: LOG });
    const read = await app.inject({ method: 'GET', url: '/api/assistant', headers: { cookie } });
    expect(read.json<{ settings: unknown }>().settings).toEqual({ logChannelId: LOG });
    expect((await putLog(cookie, csrf, { channelId: null })).statusCode).toBe(200);
    expect(assistantRepo.getAssistantSettings(t.scopes.forGuild(GUILD))).toEqual({});
    const rows = effectRepo
      .tailAudit(t.scopes.forGuild(GUILD), {})
      .filter((r) => r.action === 'assistant_log_channel.set')
      .map((r) => [JSON.parse(r.before ?? 'null'), JSON.parse(r.after ?? 'null')] as const);
    expect(rows).toEqual(
      expect.arrayContaining([
        [{ channelId: null }, { channelId: LOG }],
        [{ channelId: LOG }, { channelId: null }],
      ]),
    );
  });

  it('requires config.write and a snowflake', async () => {
    grant('config.read');
    const { cookie, csrf } = await signIn();
    expect((await putLog(cookie, csrf, { channelId: LOG })).statusCode).toBe(403);
    grant('config.write');
    expect((await putLog(cookie, csrf, { channelId: 'general' })).statusCode).toBe(400);
  });
});

describe('POST /api/assistant/provider/models (ADR 0068)', () => {
  const listed = [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }];
  let calls: { provider: string; apiKey?: string | undefined }[];
  const restart = async (
    listModels: (provider: string, apiKey?: string) => Promise<typeof listed>,
  ) => {
    calls = [];
    deps = {
      ...deps,
      assistantProviderConfig: {
        status: () => ({
          provider: 'gemini',
          enabled: true,
          modelConfigured: true,
          keyConfigured: true,
          keyReadable: true,
          costClass: 'free',
          secretSource: 'file',
        }),
        save: () => undefined,
        listModels: async (provider, apiKey) => {
          calls.push({ provider, apiKey });
          return await listModels(provider, apiKey);
        },
      },
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantRoutes });
  };
  const post = (cookie: string, csrf: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/assistant/provider/models',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload,
    });

  it('lists the models with a pasted key and never echoes the key', async () => {
    grant('config.write');
    await restart(async () => listed);
    const { cookie, csrf } = await signIn();
    const response = await post(cookie, csrf, { provider: 'gemini', apiKey: 'pasted-secret' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ models: listed });
    expect(calls).toEqual([{ provider: 'gemini', apiKey: 'pasted-secret' }]);
    expect(response.body).not.toContain('pasted-secret');
    const withSaved = await post(cookie, csrf, { provider: 'gemini' });
    expect(withSaved.statusCode).toBe(200);
    expect(calls[1]).toEqual({ provider: 'gemini', apiKey: undefined });
  });

  it('explains a missing key, an unsupported service and a rejected key', async () => {
    grant('config.write');
    await restart(async (_provider, apiKey) => {
      if (apiKey === 'bad') throw new ProviderError('authentication', 'HTTP 403', false);
      throw new Error(apiKey === undefined ? 'no-key' : 'unsupported');
    });
    const { cookie, csrf } = await signIn();
    const noKey = await post(cookie, csrf, { provider: 'gemini' });
    expect(noKey.statusCode).toBe(409);
    expect(noKey.json()).toEqual({ error: 'no-key' });
    const other = await post(cookie, csrf, { provider: 'openrouter', apiKey: 'k' });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toEqual({ error: 'unsupported' });
    const bad = await post(cookie, csrf, { provider: 'gemini', apiKey: 'bad' });
    expect(bad.statusCode).toBe(409);
    expect(bad.json()).toEqual({ error: 'provider-refused', kind: 'authentication' });
  });

  it('requires config.write', async () => {
    grant('config.read');
    await restart(async () => listed);
    const { cookie, csrf } = await signIn();
    expect((await post(cookie, csrf, { provider: 'gemini' })).statusCode).toBe(403);
  });
});

describe('PUT /api/assistant/resources/:id (ADR 0073 enqueue on add)', () => {
  const putResource = (
    cookie: string,
    csrf: string,
    over: Record<string, unknown> & { id?: string } = {},
  ) =>
    app.inject({
      method: 'PUT',
      url: `/api/assistant/resources/${over.id ?? 'res-1'}`,
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: {
        id: 'res-1',
        title: 'A resource',
        url: 'https://example.com/guide',
        kind: 'website',
        enabled: true,
        reviewedAt: new Date(0).toISOString(),
        ...over,
      },
    });

  /**
   * The production-shaped enqueue behind the route (mirrors
   * `apps/daemon/src/http/wiring.ts`): these two tests prove the dedupe
   * behaviour the wiring gets, while the spy test below proves the route
   * calls whatever it is given.
   */
  const withJobEnqueue = async (): Promise<void> => {
    deps = {
      ...deps,
      enqueueResourceRefresh: (scope, resourceId, reason) => {
        jobRepo.enqueue(scope, {
          kind: JOB_KINDS.resourceRefresh,
          payload: JSON.stringify({ resourceId, reason }),
          dedupeKey: resourceRefreshDedupeKey({ reason, resourceId }),
          now: clock,
        });
      },
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantRoutes });
  };

  it('enqueues one resource_refresh job with reason added on create', async () => {
    grant('config.write');
    await withJobEnqueue();
    const { cookie, csrf } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    expect((await putResource(cookie, csrf)).statusCode).toBe(200);

    const jobs = jobRepo.listJobs(scope, {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.kind).toBe('resource_refresh');
    expect(jobs[0]?.payload).toBe(JSON.stringify({ resourceId: 'res-1', reason: 'added' }));
  });

  it('enqueues again on an edit, and a second save in the same instant collapses to one pending job', async () => {
    grant('config.write');
    await withJobEnqueue();
    const { cookie, csrf } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    await putResource(cookie, csrf);
    await putResource(cookie, csrf, { title: 'Edited title' });

    // Both saves land inside the same still-queued job (no time bucket for
    // 'added' — see resourceRefreshDedupeKey), so there is still exactly one.
    expect(jobRepo.listJobs(scope, {})).toHaveLength(1);
  });

  it('refuses an unsafe URL and enqueues nothing', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    const res = await putResource(cookie, csrf, { url: 'https://127.0.0.1/' });
    expect(res.statusCode).toBe(400);
    expect(jobRepo.listJobs(scope, {})).toHaveLength(0);
  });

  it('calls the injected enqueue with reason added on create and on edit, and enqueues nothing without it', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const calls: { resourceId: string; reason: string }[] = [];
    deps = {
      ...deps,
      enqueueResourceRefresh: (scope, resourceId, reason) => {
        expect(scope.guildId).toBe(GUILD);
        calls.push({ resourceId, reason });
      },
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantRoutes });
    const headers = { cookie, [CSRF_HEADER]: csrf };
    const payload = {
      id: 'res-1',
      title: 'A resource',
      url: 'https://example.com/guide',
      kind: 'website',
      enabled: true,
      reviewedAt: new Date(0).toISOString(),
    };
    expect(
      (await app.inject({ method: 'PUT', url: '/api/assistant/resources/res-1', headers, payload }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/assistant/resources/res-1',
          headers,
          payload: { ...payload, title: 'Edited title' },
        })
      ).statusCode,
    ).toBe(200);
    expect(calls).toEqual([
      { resourceId: 'res-1', reason: 'added' },
      { resourceId: 'res-1', reason: 'added' },
    ]);
  });

  it('enqueues nothing when no enqueue function is injected', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/assistant/resources/res-1',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: {
        id: 'res-1',
        title: 'A resource',
        url: 'https://example.com/guide',
        kind: 'website',
        enabled: true,
        reviewedAt: new Date(0).toISOString(),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(jobRepo.listJobs(scope, {})).toHaveLength(0);
  });
});

describe('GET /api/assistant/skills/:skillId', () => {
  const get = (cookie: string, skillId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/assistant/skills/${encodeURIComponent(skillId)}`,
      headers: { cookie },
    });

  it('requires config.read', async () => {
    const { cookie } = await signIn();
    expect((await get(cookie, 'search-club')).statusCode).toBe(403);
  });

  it('404s an unknown skill id', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    const response = await get(cookie, 'no-such-skill');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not-found' });
  });

  it('returns the skill, its exact instruction line, its tools and every behaviour with allowed', async () => {
    grant('config.read');
    grant('config.write');
    const { cookie, csrf } = await signIn();
    expect(
      (await put(cookie, csrf, body({ id: 'club', allowedSkillIds: ['search-club'] }))).statusCode,
    ).toBe(200);
    expect(
      (
        await put(
          cookie,
          csrf,
          body({
            id: 'help',
            surface: 'help',
            mentionRoleId: ROLE_B,
            name: 'Help',
            allowedSkillIds: [],
          }),
        )
      ).statusCode,
    ).toBe(200);
    const response = await get(cookie, 'search-club');
    expect(response.statusCode).toBe(200);
    const skill = CLUB_ASSISTANT_SKILLS.find((s) => s.id === 'search-club')!;
    const parsed: {
      skill: { id: string };
      instructionLine: string;
      behaviours: { id: string; name: string; allowed: boolean }[];
      whoCanUse: string;
      tools: { name: string }[];
      command?: { name: string; options: unknown[] };
      recentRuns: unknown[];
    } = response.json();
    expect(parsed.skill.id).toBe('search-club');
    expect(parsed.instructionLine).toBe(skillInstructionLine(skill));
    expect(parsed.behaviours).toEqual(
      expect.arrayContaining([
        { id: 'club', name: 'Club', allowed: true },
        { id: 'help', name: 'Help', allowed: false },
      ]),
    );
    expect(parsed.tools.map((t) => t.name)).toEqual(
      TOOL_CATALOGUE.filter((t) => t.skills.includes('search-club')).map((t) => t.name),
    );
    // Every read tool lists the question-answering skill.
    expect(parsed.tools.length).toBe(TOOL_CATALOGUE.length);
    expect(parsed.recentRuns).toEqual([]);
  });

  it('names the caller roles from the directory, falls back without one, and states owner-only skills plainly', async () => {
    grant('config.read');
    grant('config.write');
    const { cookie, csrf } = await signIn();
    // No caller roles configured on the one allowed behaviour yet.
    expect((await put(cookie, csrf, body({ allowedSkillIds: ['search-club'] }))).statusCode).toBe(
      200,
    );
    const unconfigured = await get(cookie, 'search-club');
    expect(unconfigured.json<{ whoCanUse: string }>().whoCanUse).toBe(
      'Only the server owner, until a behaviour that allows it has Who can ask roles.',
    );
    expect(
      (
        await put(
          cookie,
          csrf,
          body({
            promptVersion: 1,
            callerRoleIds: [ROLE_A, ROLE_B],
            allowedSkillIds: ['search-club'],
          }),
        )
      ).statusCode,
    ).toBe(200);
    const withoutDirectory = await get(cookie, 'search-club');
    expect(withoutDirectory.json<{ whoCanUse: string }>().whoCanUse).toBe(
      '@a role that left the server, @a role that left the server, and the server owner',
    );
    deps = {
      ...deps,
      assistantDirectories: () =>
        Promise.resolve({
          roles: [
            { id: ROLE_A, name: 'Member', position: 10 },
            { id: ROLE_B, name: 'Helper', position: 5 },
          ],
          members: [],
          channels: [],
        }),
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantRoutes });
    const withDirectory = await get(cookie, 'search-club');
    expect(withDirectory.json<{ whoCanUse: string }>().whoCanUse).toBe(
      '@Member, @Helper, and the server owner',
    );
    const ownerOnly = await get(cookie, 'send-reminder');
    expect(ownerOnly.json<{ whoCanUse: string }>().whoCanUse).toBe('Only the server owner.');
  });

  it("lists up to 50 of this skill's own activity rows, newest first, never another skill's", async () => {
    grant('config.read');
    const scope = t.scopes.forGuild(GUILD);
    for (let i = 0; i < 55; i += 1) {
      assistantRepo.recordSkillActivity(scope, {
        id: `a${i}`,
        at: clock + i,
        behaviourId: 'club',
        skillId: 'search-club',
        actorId: ROLE_A,
        outcome: 'completed',
      });
    }
    assistantRepo.recordSkillActivity(scope, {
      id: 'other',
      at: clock + 1000,
      behaviourId: 'club',
      skillId: 'create-reminder',
      actorId: ROLE_A,
      outcome: 'completed',
    });
    const { cookie } = await signIn();
    const response = await get(cookie, 'search-club');
    const parsed: { recentRuns: { id: string; skillId: string; at: number }[] } = response.json();
    expect(parsed.recentRuns).toHaveLength(50);
    expect(parsed.recentRuns.every((row) => row.skillId === 'search-club')).toBe(true);
    expect(parsed.recentRuns[0]?.id).toBe('a54');
  });

  // The command shapes below are copied by hand from `RELEASE_3_COMMANDS`
  // (`packages/discord/src/rest/commands.ts`), not imported: `packages/http`
  // may not depend on `@bananasaurs/discord` (`no-restricted-imports`,
  // ADR 0014 - that package is discord.js-only, reachable from the effect
  // gateway and the daemon composition root). This test is the drift check
  // a human re-reads when either file changes.
  const LIVE_COMMANDS: Readonly<Record<string, { name: string; options: unknown[] }>> = {
    'search-club': {
      name: 'find',
      options: [{ name: 'query', required: true, description: 'What to find' }],
    },
    'create-reminder': {
      name: 'remind',
      options: [
        {
          name: 'when',
          required: true,
          description: 'When to send it, including date or time zone',
        },
        { name: 'text', required: true, description: 'Reminder text' },
      ],
    },
    'propose-memory': {
      name: 'remember',
      options: [
        {
          name: 'request',
          required: true,
          description: 'What the assistant should consider remembering',
        },
      ],
    },
    'record-decision': {
      name: 'decision',
      options: [
        { name: 'topic', required: true, description: 'Decision topic' },
        { name: 'context', required: false, description: 'Optional context or constraints' },
      ],
    },
    'review-plan': {
      name: 'review-plan',
      options: [{ name: 'plan', required: true, description: 'Plan to review' }],
    },
    'onboarding-guide': {
      name: 'onboard',
      options: [{ name: 'request', required: true, description: 'What you need' }],
    },
    'draft-agenda': {
      name: 'agenda',
      options: [{ name: 'request', required: true, description: 'What you need' }],
    },
    'summarise-meeting': {
      name: 'summarise',
      options: [{ name: 'request', required: true, description: 'What you need' }],
    },
    'draft-announcement': {
      name: 'announce',
      options: [{ name: 'request', required: true, description: 'What you need' }],
    },
    'event-checklist': {
      name: 'checklist',
      options: [{ name: 'request', required: true, description: 'What you need' }],
    },
    'draft-handoff': {
      name: 'handoff',
      options: [{ name: 'request', required: true, description: 'What you need' }],
    },
  };

  it('gives every skill named in RELEASE_3_COMMANDS its exact slash command and options', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    for (const skill of CLUB_ASSISTANT_SKILLS) {
      const response = await get(cookie, skill.id);
      const parsed: { command?: { name: string; options: unknown[] } } = response.json();
      expect(parsed.command, skill.id).toEqual(LIVE_COMMANDS[skill.id]);
    }
    // Every skill this route maps to a command is one the test above checked byte-for-byte.
    expect(Object.keys(LIVE_COMMANDS).sort()).toEqual(
      CLUB_ASSISTANT_SKILLS.filter((s) => LIVE_COMMANDS[s.id] !== undefined)
        .map((s) => s.id)
        .sort(),
    );
  });

  it('leaves owner-only send-reminder and tool-only open-resource without a slash command', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    const sendReminder = await get(cookie, 'send-reminder');
    expect(sendReminder.json<{ command?: unknown }>().command).toBeUndefined();
    const openResource = await get(cookie, 'open-resource');
    expect(openResource.json<{ command?: unknown }>().command).toBeUndefined();
  });
});
