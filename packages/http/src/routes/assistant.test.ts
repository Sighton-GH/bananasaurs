import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseGuildId, STARTER_SKILL_IDS, type Capability } from '@bananasaurs/core';
import { accountRepo, assistantRepo, authzRepo, effectRepo, guildRepo } from '@bananasaurs/storage';
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
