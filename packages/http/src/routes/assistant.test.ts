import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CLUB_ASSISTANT_SKILLS,
  DEFAULT_WIZARD_ANSWERS,
  JOB_KINDS,
  parseGuildId,
  ProviderError,
  reminderRecurrence,
  resourceRefreshDedupeKey,
  SAFETY_SUFFIX,
  SAFETY_SUFFIX_VERSION,
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
    expect(conflict.json()).toMatchObject({ error: 'prompt-version-conflict', currentVersion: 1 });
    expect(assistantRepo.listBehaviours(t.scopes.forGuild(GUILD))[0]?.systemPrompt).toBe(
      'Be helpful.',
    );
  });

  it('requires a mention role outside direct command and refuses ambiguous enabled routes', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const missing = await put(cookie, csrf, body({ mentionRoleId: undefined }));
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: 'mention-role-required' });
    expect((await put(cookie, csrf, body())).statusCode).toBe(200);
    const duplicateMention = await put(
      cookie,
      csrf,
      body({ id: 'help', surface: 'help', name: 'Help', promptVersion: 0 }),
    );
    expect(duplicateMention.statusCode).toBe(409);
    expect(duplicateMention.json()).toMatchObject({
      error: 'behaviour-conflict',
      behaviourId: 'club',
    });
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
    expect(duplicateDirect.json()).toMatchObject({
      error: 'behaviour-conflict',
      behaviourId: 'direct',
    });
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
    expect(empty.json()).toMatchObject({ error: 'bad-request' });
    const bad = await postStarter(cookie, csrf, { roleIds: ['not-a-snowflake'] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'bad-request' });
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
    expect(missing.json()).toMatchObject({ error: 'not-found' });
    const disabled = await putBotTag(cookie, csrf, { behaviourId: 'off' });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({ error: 'behaviour-disabled' });
    for (const payload of [{}, { behaviourId: 5 }, { behaviourId: '' }]) {
      const bad = await putBotTag(cookie, csrf, payload);
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: 'bad-request' });
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
    expect(on.json()).toMatchObject({ error: 'owner-only', field: 'searchEnabled' });
    const key = await putProvider(cookie, csrf, { searchApiKey: 'x'.repeat(20) });
    expect(key.json()).toMatchObject({ error: 'owner-only', field: 'searchApiKey' });
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
    expect(noKey.json()).toMatchObject({ error: 'no-key' });
    const other = await post(cookie, csrf, { provider: 'openrouter', apiKey: 'k' });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ error: 'unsupported' });
    const bad = await post(cookie, csrf, { provider: 'gemini', apiKey: 'bad' });
    expect(bad.statusCode).toBe(409);
    expect(bad.json()).toMatchObject({ error: 'provider-refused', kind: 'authentication' });
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

  it('refuses a github.com website with github-url-needs-import and saves nothing', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    const res = await putResource(cookie, csrf, {
      url: 'https://github.com/sfu-racerbot/racerbot-docs',
      kind: 'website',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'github-url-needs-import' });
    expect(assistantRepo.listResources(scope)).toHaveLength(0);
    expect(jobRepo.listJobs(scope, {})).toHaveLength(0);
  });

  it('does not refuse a github.com URL saved as a note', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const res = await putResource(cookie, csrf, {
      url: 'https://github.com/sfu-racerbot/racerbot-docs',
      kind: 'note',
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts a raw.githubusercontent.com website', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const res = await putResource(cookie, csrf, {
      url: 'https://raw.githubusercontent.com/sfu-racerbot/racerbot-docs/main/README.md',
      kind: 'website',
    });
    expect(res.statusCode).toBe(200);
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

describe('PUT /api/assistant/resources/:id/enabled (ADR 0084)', () => {
  const putEnabled = (cookie: string, csrf: string, id: string, payload: unknown) =>
    app.inject({
      method: 'PUT',
      url: `/api/assistant/resources/${id}/enabled`,
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: payload as Record<string, unknown>,
    });
  const seedGithubChild = (over: Record<string, unknown> = {}) => {
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.putResource(scope, {
      id: 'gh-acme',
      guildId: GUILD,
      title: 'acme',
      url: 'https://github.com/acme',
      kind: 'github-org',
      enabled: true,
      reviewedAt: new Date(0).toISOString(),
      meta: { owner: 'acme' },
    });
    assistantRepo.putResource(scope, {
      id: 'gh-acme-widget',
      guildId: GUILD,
      title: 'acme/widget',
      url: 'https://github.com/acme/widget',
      kind: 'github-repo',
      enabled: true,
      reviewedAt: new Date(0).toISOString(),
      parentId: 'gh-acme',
      meta: { owner: 'acme', repo: 'widget', branch: 'main' },
      ...over,
    });
    return scope;
  };

  it('disables a github-repo child, keeps its parentId and meta, and records disabledByOwner', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const scope = seedGithubChild();
    const response = await putEnabled(cookie, csrf, 'gh-acme-widget', { enabled: false });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    const stored = assistantRepo.listResources(scope).find((r) => r.id === 'gh-acme-widget');
    expect(stored).toMatchObject({ enabled: false, parentId: 'gh-acme' });
    expect(stored?.meta).toEqual({
      owner: 'acme',
      repo: 'widget',
      branch: 'main',
      disabledByOwner: true,
    });
  });

  it('enabling a github-repo child clears disabledByOwner but keeps its other meta', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const scope = seedGithubChild({
      enabled: false,
      meta: { owner: 'acme', repo: 'widget', branch: 'main', private: true, disabledByOwner: true },
    });
    const response = await putEnabled(cookie, csrf, 'gh-acme-widget', { enabled: true });
    expect(response.statusCode).toBe(200);
    const stored = assistantRepo.listResources(scope).find((r) => r.id === 'gh-acme-widget');
    expect(stored).toMatchObject({ enabled: true, parentId: 'gh-acme' });
    expect(stored?.meta).toEqual({ owner: 'acme', repo: 'widget', branch: 'main', private: true });
    expect(stored?.meta).not.toHaveProperty('disabledByOwner');
  });

  it('records disabledByOwner when a github-org is disabled', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const scope = seedGithubChild();
    expect(await putEnabled(cookie, csrf, 'gh-acme', { enabled: false })).toMatchObject({
      statusCode: 200,
    });
    expect(assistantRepo.listResources(scope).find((r) => r.id === 'gh-acme')?.meta).toEqual({
      owner: 'acme',
      disabledByOwner: true,
    });
  });

  it('toggles a website with no meta', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.putResource(scope, {
      id: 'res-1',
      guildId: GUILD,
      title: 'A resource',
      url: 'https://example.com/guide',
      kind: 'website',
      enabled: true,
      reviewedAt: new Date(0).toISOString(),
    });
    expect((await putEnabled(cookie, csrf, 'res-1', { enabled: false })).statusCode).toBe(200);
    const stored = assistantRepo.listResources(scope).find((r) => r.id === 'res-1');
    expect(stored).toMatchObject({ enabled: false });
    expect(stored?.meta).toBeUndefined();
    expect((await putEnabled(cookie, csrf, 'res-1', { enabled: true })).statusCode).toBe(200);
    expect(assistantRepo.listResources(scope).find((r) => r.id === 'res-1')).toMatchObject({
      enabled: true,
    });
  });

  it('keeps fetch status and last-fetched time when toggling enabled', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const scope = seedGithubChild();
    assistantRepo.recordResourceFetch(scope, 'gh-acme-widget', {
      status: 'ok',
      at: 123,
      detail: 'fresh evidence',
    });
    expect((await putEnabled(cookie, csrf, 'gh-acme-widget', { enabled: false })).statusCode).toBe(
      200,
    );
    expect(assistantRepo.listResources(scope).find((r) => r.id === 'gh-acme-widget')).toMatchObject(
      { enabled: false, fetchStatus: 'ok', lastFetchedAt: 123 },
    );
  });

  it('records an audit row with before and after enabled', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    seedGithubChild();
    expect((await putEnabled(cookie, csrf, 'gh-acme-widget', { enabled: false })).statusCode).toBe(
      200,
    );
    const row = effectRepo
      .tailAudit(t.scopes.forGuild(GUILD), {})
      .find((r) => r.action === 'assistant_resource.enabled_changed');
    expect(row).toMatchObject({ subjectType: 'assistant_resource', subjectId: 'gh-acme-widget' });
    expect(JSON.parse(row?.before as string)).toEqual({ enabled: true });
    expect(JSON.parse(row?.after as string)).toEqual({ enabled: false });
  });

  it('answers 404 for an unknown id', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const response = await putEnabled(cookie, csrf, 'no-such-resource', { enabled: false });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not-found' });
  });

  it('answers 400 for a bad body', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    seedGithubChild();
    const response = await putEnabled(cookie, csrf, 'gh-acme-widget', { enabled: 'yes' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'bad-request' });
  });

  it('requires config.write', async () => {
    seedGithubChild();
    const { cookie, csrf } = await signIn();
    const response = await putEnabled(cookie, csrf, 'gh-acme-widget', { enabled: false });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'no-grant' });
  });

  it('disabling a github-repo with no meta rebuilds owner meta from its URL', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.putResource(scope, {
      id: 'gh-acme-widget',
      guildId: GUILD,
      title: 'acme/widget',
      url: 'https://github.com/acme/widget',
      kind: 'github-repo',
      enabled: true,
      reviewedAt: new Date(0).toISOString(),
    });
    expect((await putEnabled(cookie, csrf, 'gh-acme-widget', { enabled: false })).statusCode).toBe(
      200,
    );
    const stored = assistantRepo.listResources(scope).find((r) => r.id === 'gh-acme-widget');
    expect(stored).toMatchObject({ enabled: false });
    expect(stored?.meta).toEqual({
      owner: 'acme',
      repo: 'widget',
      disabledByOwner: true,
    });
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
    expect(response.json()).toMatchObject({ error: 'not-found' });
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

  it('reads the scope and the scope-based who-can-use for each mode', async () => {
    grant('config.read');
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const headers = { cookie, [CSRF_HEADER]: csrf };
    const putScope = (skillId: string, payload: unknown) =>
      app.inject({
        method: 'PUT',
        url: `/api/assistant/skills/${encodeURIComponent(skillId)}/scope`,
        headers,
        payload: payload as Record<string, unknown>,
      });
    // Default: search-club is everyone, reminders is owner-only.
    expect((await get(cookie, 'search-club')).json<{ whoCanUse: string }>().whoCanUse).toBe(
      'Everyone who can ask a behaviour that allows this skill, and the server owner.',
    );
    const ownerDefault = await get(cookie, 'reminders');
    expect(ownerDefault.json<{ whoCanUse: string }>().whoCanUse).toBe('Only the server owner.');
    expect(ownerDefault.json<{ scope: unknown }>().scope).toEqual({
      mode: 'owner',
      roleIds: [],
      isDefault: true,
    });
    // Roles mode names directory roles and marks the ones that left.
    expect(
      (await putScope('search-club', { mode: 'roles', roleIds: [ROLE_A, ROLE_B] })).statusCode,
    ).toBe(200);
    const withoutDirectory = await get(cookie, 'search-club');
    expect(withoutDirectory.json<{ whoCanUse: string }>().whoCanUse).toBe(
      '@a role that left the server, @a role that left the server (among those who can ask), and the server owner.',
    );
    expect(withoutDirectory.json<{ scope: unknown }>().scope).toEqual({
      mode: 'roles',
      roleIds: [ROLE_A, ROLE_B],
      isDefault: false,
    });
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
      '@Member, @Helper (among those who can ask), and the server owner.',
    );
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
      skillId: 'reminders',
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

  // Task E1: slash commands are removed (ADR 0086 decision 8), so no skill
  // detail response carries a command key.
  it('carries no slash command key for any skill', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    for (const skill of CLUB_ASSISTANT_SKILLS) {
      const response = await get(cookie, skill.id);
      expect(response.statusCode).toBe(200);
      expect(response.json(), skill.id).not.toHaveProperty('command');
    }
  });
});

describe('GET /api/assistant/skills/:skillId items (Task E1)', () => {
  const get = (cookie: string, skillId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/assistant/skills/${encodeURIComponent(skillId)}`,
      headers: { cookie },
    });
  const MEMBER = '555555555555555555';
  const CHANNEL = '666666666666666666';
  const seedReminder = (
    id: string,
    status: 'scheduled' | 'delivering' | 'delivered' | 'cancelled' | 'failed',
    dueAt: number,
    over: Record<string, unknown> = {},
  ): void => {
    assistantRepo.insertReminder(t.scopes.forGuild(GUILD), {
      id,
      guildId: GUILD,
      creatorId: MEMBER,
      destinationId: CHANNEL,
      text: `text-${id}`,
      dueAt,
      createdAt: clock,
      status,
      dedupeKey: `${GUILD}:${id}`,
      mentions: { userIds: [], roleIds: [], everyone: false, here: false },
      deliveredCount: status === 'delivered' ? 1 : 0,
      ...over,
    });
  };
  const seedDecision = (
    id: string,
    kind: 'decision' | 'review-plan' | 'memory',
    status: 'draft' | 'reviewed',
  ): void => {
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.insertDecisionDraft(scope, {
      id,
      kind,
      summary: `summary-${id}`,
      requesterId: MEMBER,
      provenance: 'test',
      at: clock,
    });
    if (status === 'reviewed')
      expect(assistantRepo.transitionDecision(scope, id, 'draft', 'reviewed')).toBe(true);
  };
  const withDirectories = async (): Promise<void> => {
    deps = {
      ...deps,
      assistantDirectories: () =>
        Promise.resolve({
          roles: [],
          members: [{ id: MEMBER, name: 'Remy' }],
          channels: [{ id: CHANNEL, name: 'general' }],
        }),
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantRoutes });
  };

  it('lists every live reminder plus the newest finished ones, with directory names', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    await withDirectories();
    seedReminder('live-one', 'scheduled', clock + 1000, { context: 'why one' });
    seedReminder('live-two', 'delivering', clock + 2000);
    seedReminder('old-one', 'delivered', clock + 500);
    seedReminder('old-two', 'cancelled', clock + 3000);
    const response = await get(cookie, 'reminders');
    expect(response.statusCode).toBe(200);
    const parsed: {
      items: {
        kind: string;
        reminders: {
          id: string;
          creatorId: string;
          creatorName?: string;
          destinationId: string;
          destinationName?: string;
          text: string;
          context?: string;
          dueAt: number;
          status: string;
          mentions: unknown;
          deliveredCount: number;
        }[];
      };
    } = response.json();
    expect(parsed.items.kind).toBe('reminders');
    expect(parsed.items.reminders.map((r) => r.id)).toEqual([
      'live-one',
      'live-two',
      'old-two',
      'old-one',
    ]);
    expect(parsed.items.reminders[0]).toMatchObject({
      id: 'live-one',
      creatorId: MEMBER,
      creatorName: 'Remy',
      destinationId: CHANNEL,
      destinationName: 'general',
      text: 'text-live-one',
      context: 'why one',
      dueAt: clock + 1000,
      status: 'scheduled',
      mentions: { userIds: [], roleIds: [], everyone: false, here: false },
      deliveredCount: 0,
    });
  });

  it('caps the finished reminders at the 50 most recent', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    for (let i = 0; i < 55; i += 1) {
      seedReminder(`done-${i}`, 'delivered', clock + i);
    }
    const response = await get(cookie, 'reminders');
    const parsed: { items: { kind: string; reminders: { id: string }[] } } = response.json();
    expect(parsed.items.kind).toBe('reminders');
    expect(parsed.items.reminders).toHaveLength(50);
    expect(parsed.items.reminders[0]?.id).toBe('done-54');
  });

  it('omits directory names when no directory is available', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    seedReminder('live-one', 'scheduled', clock + 1000);
    const response = await get(cookie, 'reminders');
    const parsed: { items: { reminders: Record<string, unknown>[] } } = response.json();
    expect(parsed.items.reminders[0]).not.toHaveProperty('creatorName');
    expect(parsed.items.reminders[0]).not.toHaveProperty('destinationName');
  });

  it('lists draft and reviewed memory proposals for propose-memory', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    seedDecision('mem-draft', 'memory', 'draft');
    seedDecision('mem-reviewed', 'memory', 'reviewed');
    seedDecision('dec-draft', 'decision', 'draft');
    const response = await get(cookie, 'propose-memory');
    const parsed: { items: { kind: string; proposals: { id: string }[] } } = response.json();
    expect(parsed.items.kind).toBe('memory-proposals');
    expect(parsed.items.proposals.map((p) => p.id).sort()).toEqual(['mem-draft', 'mem-reviewed']);
  });

  it('lists draft and reviewed non-memory decisions for record-decision', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    seedDecision('dec-draft', 'decision', 'draft');
    seedDecision('plan-reviewed', 'review-plan', 'reviewed');
    seedDecision('mem-draft', 'memory', 'draft');
    const response = await get(cookie, 'record-decision');
    const parsed: { items: { kind: string; decisions: { id: string }[] } } = response.json();
    expect(parsed.items.kind).toBe('decisions');
    expect(parsed.items.decisions.map((d) => d.id).sort()).toEqual(['dec-draft', 'plan-reviewed']);
  });

  it('reports no items for every other skill', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    const response = await get(cookie, 'search-club');
    expect(response.json<{ items: unknown }>().items).toEqual({ kind: 'none' });
  });
});

describe('PUT /api/assistant/behaviours/:id promptWizard (Task 18)', () => {
  it('stores valid answers, keeps them when omitted, clears them on null, refuses invalid', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    expect(
      (await put(cookie, csrf, body({ promptWizard: DEFAULT_WIZARD_ANSWERS.club }))).statusCode,
    ).toBe(200);
    expect(assistantRepo.listBehaviours(scope)[0]?.promptWizard).toEqual(
      DEFAULT_WIZARD_ANSWERS.club,
    );
    // Omitted keeps the stored answers; the version still moves on.
    expect(
      (await put(cookie, csrf, body({ promptVersion: 1, systemPrompt: 'Edited.' }))).statusCode,
    ).toBe(200);
    expect(assistantRepo.listBehaviours(scope)[0]?.promptWizard).toEqual(
      DEFAULT_WIZARD_ANSWERS.club,
    );
    // Explicit null clears them.
    expect(
      (await put(cookie, csrf, body({ promptVersion: 2, promptWizard: null }))).statusCode,
    ).toBe(200);
    expect(assistantRepo.listBehaviours(scope)[0]?.promptWizard).toBeUndefined();
    // Invalid answers are refused without touching the stored behaviour.
    const bad = await put(cookie, csrf, body({ promptVersion: 3, promptWizard: { audience: [] } }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'bad-request' });
    expect(assistantRepo.listBehaviours(scope)[0]?.promptVersion).toBe(3);
  });

  it('audits every saved field plus whether answers exist, never the answers text', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const answers = {
      ...DEFAULT_WIZARD_ANSWERS.club,
      clubFacts: 'The mascot is a backwards banana.',
    };
    expect((await put(cookie, csrf, body({ promptWizard: answers }))).statusCode).toBe(200);
    const rows = effectRepo
      .tailAudit(t.scopes.forGuild(GUILD), {})
      .filter(
        (row) =>
          row.action === 'assistant_behaviour.saved' ||
          row.action === 'assistant_behaviour.created',
      );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.after ?? 'null') as unknown).toEqual({
      name: 'Club',
      surface: 'bananasaurs',
      enabled: true,
      allowedSkillIds: ['search-club'],
      callerRoleIds: [],
      resourceIds: [],
      mentionRoleId: ROLE_A,
      ticketChannelId: null,
      reviewerRoleIds: [],
      systemPrompt: 'Be helpful.',
      promptWizard: true,
    });
    // The distinctive free-text answer must appear nowhere in the audit row.
    expect(JSON.stringify(rows[0])).not.toContain('The mascot is a backwards banana.');
  });

  it('round-trips promptWizard through PUT into GET /api/assistant, and null clears it', async () => {
    grant('config.read');
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const readBehaviours = async (): Promise<{ promptWizard?: unknown }[]> =>
      (await app.inject({ method: 'GET', url: '/api/assistant', headers: { cookie } })).json<{
        behaviours: { promptWizard?: unknown }[];
      }>().behaviours;
    expect(
      (await put(cookie, csrf, body({ promptWizard: DEFAULT_WIZARD_ANSWERS.club }))).statusCode,
    ).toBe(200);
    expect(await readBehaviours()).toEqual([
      expect.objectContaining({ id: 'club', promptWizard: DEFAULT_WIZARD_ANSWERS.club }),
    ]);
    expect(
      (await put(cookie, csrf, body({ promptVersion: 1, promptWizard: null }))).statusCode,
    ).toBe(200);
    const cleared = await readBehaviours();
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).not.toHaveProperty('promptWizard');
  });
});

describe('GET /api/assistant/behaviours/:id/preview (Task 18)', () => {
  const get = (cookie: string, id: string) =>
    app.inject({
      method: 'GET',
      url: `/api/assistant/behaviours/${encodeURIComponent(id)}/preview`,
      headers: { cookie },
    });

  it('requires config.read', async () => {
    const { cookie } = await signIn();
    expect((await get(cookie, 'club')).statusCode).toBe(403);
  });

  it('404s an unknown behaviour id', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    const response = await get(cookie, 'no-such-behaviour');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not-found' });
  });

  it('returns the eight sections in order with sizes, and never member memories', async () => {
    grant('config.read');
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    expect((await put(cookie, csrf, body())).statusCode).toBe(200);
    assistantRepo.putResource(scope, {
      id: 'handbook',
      guildId: GUILD,
      title: 'Club handbook',
      url: 'https://example.com/handbook',
      kind: 'document',
      enabled: true,
      reviewedAt: new Date(clock).toISOString(),
    });
    assistantRepo.putMemory(
      scope,
      { id: 'm1', section: 'Likes', content: 'Loves pineapple pizza, hates Mondays' },
      clock,
    );
    const response = await get(cookie, 'club');
    expect(response.statusCode).toBe(200);
    const parsed: {
      sections: { name: string; chars: number; estTokens: number; text: string }[];
      totalChars: number;
      totalEstTokens: number;
    } = response.json();
    expect(parsed.sections.map((s) => s.name)).toEqual([
      'surface',
      'behaviour-prompt',
      'safety-suffix',
      'output-rules',
      'evidence-rule',
      'server-card',
      'resources',
      'skills',
    ]);
    for (const section of parsed.sections) {
      expect(section.chars).toBe(section.text.length);
      expect(section.estTokens).toBe(Math.ceil(section.chars / 4));
      expect(section.text.length).toBeGreaterThan(0);
    }
    expect(parsed.totalChars).toBe(parsed.sections.reduce((sum, s) => sum + s.chars, 0));
    expect(parsed.totalEstTokens).toBe(Math.ceil(parsed.totalChars / 4));
    expect(parsed.sections.find((s) => s.name === 'safety-suffix')?.text).toBe(SAFETY_SUFFIX);
    expect(
      parsed.sections.find((s) => s.name === 'output-rules')?.text?.startsWith('OUTPUT RULES'),
    ).toBe(true);
    expect(parsed.sections.find((s) => s.name === 'behaviour-prompt')?.text).toBe('Be helpful.');
    expect(JSON.stringify(parsed)).not.toContain('Loves pineapple pizza');
  });
});

describe('GET /api/assistant/safety-suffix (Task 18)', () => {
  const get = (cookie: string) =>
    app.inject({ method: 'GET', url: '/api/assistant/safety-suffix', headers: { cookie } });

  it('requires config.read', async () => {
    const { cookie } = await signIn();
    expect((await get(cookie)).statusCode).toBe(403);
  });

  it('returns the locked version and the exact text', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    const response = await get(cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: SAFETY_SUFFIX_VERSION, text: SAFETY_SUFFIX });
  });
});

describe('PUT /api/assistant/skills/:skillId/scope (Task E1)', () => {
  const putScope = (cookie: string, csrf: string, skillId: string, payload: unknown) =>
    app.inject({
      method: 'PUT',
      url: `/api/assistant/skills/${encodeURIComponent(skillId)}/scope`,
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: payload as Record<string, unknown>,
    });

  it('round-trips a roles scope and clears role ids when leaving roles mode', async () => {
    grant('config.read');
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const roles = await putScope(cookie, csrf, 'reminders', { mode: 'roles', roleIds: [ROLE_A] });
    expect(roles.statusCode).toBe(200);
    expect(roles.json()).toEqual({
      ok: true,
      scope: { mode: 'roles', roleIds: [ROLE_A], isDefault: false },
    });
    const read = await app.inject({ method: 'GET', url: '/api/assistant', headers: { cookie } });
    expect(read.json<{ skillScopes: Record<string, unknown> }>().skillScopes['reminders']).toEqual({
      mode: 'roles',
      roleIds: [ROLE_A],
      isDefault: false,
    });
    // Extra role ids do not survive a non-roles mode.
    const everyone = await putScope(cookie, csrf, 'reminders', {
      mode: 'everyone',
      roleIds: [ROLE_A],
    });
    expect(everyone.statusCode).toBe(200);
    expect(everyone.json()).toEqual({
      ok: true,
      scope: { mode: 'everyone', roleIds: [], isDefault: false },
    });
    expect(assistantRepo.listSkillGrants(t.scopes.forGuild(GUILD))).toEqual([
      expect.objectContaining({ skillId: 'reminders', mode: 'everyone', roleIds: [] }),
    ]);
  });

  it('refuses roles mode with no roles', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const response = await putScope(cookie, csrf, 'reminders', { mode: 'roles', roleIds: [] });
    expect(response.statusCode).toBe(400);
    expect(assistantRepo.listSkillGrants(t.scopes.forGuild(GUILD))).toEqual([]);
  });

  it('404s an unknown skill', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const response = await putScope(cookie, csrf, 'no-such-skill', {
      mode: 'owner',
      roleIds: [],
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not-found' });
  });

  it('requires config.write', async () => {
    grant('config.read');
    const { cookie, csrf } = await signIn();
    const response = await putScope(cookie, csrf, 'reminders', { mode: 'owner', roleIds: [] });
    expect(response.statusCode).toBe(403);
  });

  it('audits the scope change with the effective scope before and after', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    expect(
      (await putScope(cookie, csrf, 'reminders', { mode: 'roles', roleIds: [ROLE_A] })).statusCode,
    ).toBe(200);
    const row = effectRepo
      .tailAudit(t.scopes.forGuild(GUILD), {})
      .find((r) => r.action === 'assistant_skill_scope.saved');
    expect(row).toMatchObject({ subjectType: 'assistant_skill', subjectId: 'reminders' });
    expect(JSON.parse(row?.before as string)).toEqual({
      mode: 'owner',
      roleIds: [],
      isDefault: true,
    });
    expect(JSON.parse(row?.after as string)).toEqual({
      mode: 'roles',
      roleIds: [ROLE_A],
      isDefault: false,
    });
  });
});

describe('GET /api/assistant skill scopes and item counts (Task E1)', () => {
  const seedReminder = (
    id: string,
    status: 'scheduled' | 'delivering' | 'delivered' | 'cancelled',
    dueAt: number,
  ): void => {
    assistantRepo.insertReminder(t.scopes.forGuild(GUILD), {
      id,
      guildId: GUILD,
      creatorId: ROLE_A,
      destinationId: ROLE_B,
      text: id,
      dueAt,
      createdAt: clock,
      status,
      dedupeKey: `${GUILD}:${id}`,
      mentions: { userIds: [], roleIds: [], everyone: false, here: false },
      deliveredCount: 0,
    });
  };
  const seedDecision = (
    id: string,
    kind: 'decision' | 'review-plan' | 'memory',
    status: 'draft' | 'reviewed' | 'saved',
  ): void => {
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.insertDecisionDraft(scope, {
      id,
      kind,
      summary: id,
      requesterId: ROLE_A,
      provenance: 'test',
      at: clock,
    });
    if (status !== 'draft')
      expect(assistantRepo.transitionDecision(scope, id, 'draft', 'reviewed')).toBe(true);
    if (status === 'saved')
      expect(assistantRepo.transitionDecision(scope, id, 'reviewed', 'saved')).toBe(true);
  };

  it('reports default scopes and zero counts on a fresh guild', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const parsed: {
      skillScopes: Record<string, { mode: string; roleIds: string[]; isDefault: boolean }>;
      skillItemCounts: Record<string, number>;
    } = response.json();
    expect(parsed.skillScopes['reminders']).toEqual({
      mode: 'owner',
      roleIds: [],
      isDefault: true,
    });
    expect(parsed.skillScopes['search-club']).toEqual({
      mode: 'everyone',
      roleIds: [],
      isDefault: true,
    });
    expect(Object.keys(parsed.skillScopes).sort()).toEqual(
      CLUB_ASSISTANT_SKILLS.map((s) => s.id).sort(),
    );
    expect(parsed.skillItemCounts['reminders']).toBe(0);
    expect(parsed.skillItemCounts['propose-memory']).toBe(0);
    expect(parsed.skillItemCounts['record-decision']).toBe(0);
    expect(parsed.skillItemCounts['search-club']).toBe(0);
  });

  it('counts live reminders and draft proposals', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    seedReminder('live-one', 'scheduled', clock + 1000);
    seedReminder('live-two', 'delivering', clock + 2000);
    seedReminder('old-one', 'delivered', clock + 3000);
    seedReminder('old-two', 'cancelled', clock + 4000);
    seedDecision('mem-draft', 'memory', 'draft');
    seedDecision('mem-reviewed', 'memory', 'reviewed');
    seedDecision('dec-draft', 'decision', 'draft');
    seedDecision('plan-reviewed', 'review-plan', 'reviewed');
    seedDecision('dec-saved', 'decision', 'saved');
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant',
      headers: { cookie },
    });
    const parsed: { skillItemCounts: Record<string, number> } = response.json();
    expect(parsed.skillItemCounts['reminders']).toBe(2);
    expect(parsed.skillItemCounts['propose-memory']).toBe(1);
    expect(parsed.skillItemCounts['record-decision']).toBe(1);
    expect(parsed.skillItemCounts['search-club']).toBe(0);
  });
});

describe('PATCH /api/assistant/reminders/:id (Task E1)', () => {
  const patch = (cookie: string, csrf: string, id: string, payload: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `/api/assistant/reminders/${encodeURIComponent(id)}`,
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: payload as Record<string, unknown>,
    });
  const seed = (id: string, over: Record<string, unknown> = {}): void => {
    assistantRepo.insertReminder(t.scopes.forGuild(GUILD), {
      id,
      guildId: GUILD,
      creatorId: ROLE_A,
      destinationId: ROLE_B,
      text: `text-${id}`,
      dueAt: clock + 3_600_000,
      createdAt: clock,
      status: 'scheduled',
      dedupeKey: `${GUILD}:${id}`,
      mentions: { userIds: [], roleIds: [], everyone: false, here: false },
      deliveredCount: 0,
      ...over,
    });
  };
  const repeating = () =>
    reminderRecurrence.parse({ pattern: { kind: 'daily' }, timeZone: 'America/Vancouver' });

  it('edits the text and audits only the changed fields', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    seed('r1');
    const response = await patch(cookie, csrf, 'r1', { text: 'new text' });
    expect(response.statusCode).toBe(200);
    expect(assistantRepo.getReminder(t.scopes.forGuild(GUILD), 'r1')?.text).toBe('new text');
    const row = effectRepo
      .tailAudit(t.scopes.forGuild(GUILD), {})
      .find((r) => r.action === 'assistant_reminder.edited');
    expect(row).toMatchObject({ subjectType: 'assistant_reminder', subjectId: 'r1' });
    expect(JSON.parse(row?.before as string)).toEqual({ text: 'text-r1' });
    expect(JSON.parse(row?.after as string)).toEqual({ text: 'new text' });
  });

  it('refuses a past dueAt without touching the row', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    seed('r1');
    const response = await patch(cookie, csrf, 'r1', { dueAt: clock - 1000 });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid-reminder' });
    expect(assistantRepo.getReminder(t.scopes.forGuild(GUILD), 'r1')?.dueAt).toBe(
      clock + 3_600_000,
    );
  });

  it('stops a repeat with null', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    seed('r1', { recurrence: repeating() });
    expect((await patch(cookie, csrf, 'r1', { recurrence: null })).statusCode).toBe(200);
    expect(assistantRepo.getReminder(t.scopes.forGuild(GUILD), 'r1')?.recurrence).toBeUndefined();
  });

  it('keeps the time zone when the pattern of a repeating reminder changes', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    seed('r1', { recurrence: repeating() });
    const response = await patch(cookie, csrf, 'r1', {
      recurrence: { pattern: { kind: 'weekdays' } },
    });
    expect(response.statusCode).toBe(200);
    expect(assistantRepo.getReminder(t.scopes.forGuild(GUILD), 'r1')?.recurrence).toEqual(
      reminderRecurrence.parse({ pattern: { kind: 'weekdays' }, timeZone: 'America/Vancouver' }),
    );
  });

  it('refuses to add a repeat to a one-off reminder', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    seed('r1');
    const response = await patch(cookie, csrf, 'r1', {
      recurrence: { pattern: { kind: 'daily' } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'recurrence-needs-time-zone',
      message: `Repeating reminders are created from chat, where the club's time zone is known.`,
    });
    expect(assistantRepo.getReminder(t.scopes.forGuild(GUILD), 'r1')?.recurrence).toBeUndefined();
  });

  it('answers 409 for a cancelled reminder', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    seed('r1');
    expect(assistantRepo.cancelReminder(t.scopes.forGuild(GUILD), 'r1')).toBe(true);
    const response = await patch(cookie, csrf, 'r1', { text: 'too late' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'invalid-transition' });
  });

  it('answers 404 for a missing id', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const response = await patch(cookie, csrf, 'nope', { text: 'nothing' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not-found' });
  });

  it('requires config.write', async () => {
    grant('config.read');
    const { cookie, csrf } = await signIn();
    seed('r1');
    expect((await patch(cookie, csrf, 'r1', { text: 'new text' })).statusCode).toBe(403);
  });
});
