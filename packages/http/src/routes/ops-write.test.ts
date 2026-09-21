import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import {
  accountRepo,
  authzRepo,
  effectRepo,
  guildRepo,
  loggingRepo,
  oauthRepo,
  roleRepo,
} from '@bananasaurs/storage';
import { CAPABILITIES, parseGuildId, type Capability } from '@bananasaurs/core';
import { createServer, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerOpsReadRoutes } from './ops-read.js';
import { registerOpsWriteRoutes } from './ops-write.js';

const GUILD = parseGuildId('111111111111111111');
const PASSWORD = 'correct horse battery staple';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const CSRF = 'x-bananasaurs-csrf';

let t: MigratedTestDatabase;
let clock: number;
let deps: HttpDeps;
let app: FastifyInstance;

const grant = (capabilities: readonly Capability[]): void => {
  const scope = t.scopes.forGuild(GUILD);
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
    guildIds: [GUILD],
    logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never,
    readonly: false,
    portsFor: (scope) => testPortsFor(scope, () => clock, { instanceScope: t.scopes.instance() }),
    instance: testInstanceFor(t.scopes.instance(), () => clock),
  };
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'guild', now: clock });

  const instance = t.scopes.instance();
  accountRepo.createAccount(instance, {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), ACCOUNT);

  app = createServer({ deps, registerRoutes: registerOpsWriteRoutes });
});

afterEach(async () => {
  await app.close();
  t.close();
});

const cookieFrom = (header: string | string[] | undefined): string => {
  const raw = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  return raw.split(';')[0] ?? '';
};

const signIn = async (): Promise<{ cookie: string; csrf: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'owner', password: PASSWORD },
  });
  const body: { csrfToken: string } = response.json();
  return { cookie: cookieFrom(response.headers['set-cookie']), csrf: body.csrfToken };
};

interface Call {
  readonly method: 'POST' | 'DELETE';
  readonly url: string;
  readonly payload?: Record<string, unknown>;
}

const ALL_CALLS: readonly Call[] = [
  { method: 'POST', url: '/api/jobs/1/retry' },
  {
    method: 'POST',
    url: '/api/panels',
    payload: {
      panelId: 'colour-roles',
      channelId: '444444444444444444',
      behaviour: 'toggle',
      component: 'button',
      options: [{ optionId: 'red', roleId: '333333333333333333', label: 'Red', position: 0 }],
    },
  },
  { method: 'POST', url: '/api/panels/p1/publish' },
  { method: 'POST', url: '/api/panels/p1/reconcile' },
  { method: 'POST', url: '/api/settings', payload: { key: 'dry_run', value: true } },
  { method: 'POST', url: '/api/log-routes/member_join/enabled', payload: { enabled: false } },
  { method: 'POST', url: '/api/log-exclusions', payload: { channelId: '333333333333333333' } },
  { method: 'DELETE', url: '/api/log-exclusions/333333333333333333' },
  {
    method: 'POST',
    url: '/api/archive/channels',
    payload: { channelId: '333333333333333333', attachmentPolicy: 'none' },
  },
  { method: 'DELETE', url: '/api/archive/channels/333333333333333333' },
  { method: 'POST', url: '/api/archive/categories', payload: { channelId: '333333333333333333' } },
  { method: 'DELETE', url: '/api/archive/categories/333333333333333333' },
  {
    method: 'POST',
    url: '/api/archive/channels/333333333333333333/threads',
    payload: { value: 'all' },
  },
  { method: 'POST', url: '/api/archive/messages/333333333333333333/preserve' },
  {
    method: 'POST',
    url: '/api/archive/link-case',
    payload: { messageId: '333333333333333333', caseId: 'case_1' },
  },
  { method: 'POST', url: '/api/archive/channels/333333333333333333/backfill' },
  { method: 'POST', url: '/api/archive/reindex' },
  { method: 'POST', url: '/api/undo', payload: { batchId: 'b1', reason: 'why' } },
  {
    method: 'POST',
    url: '/api/send-allowlist',
    payload: { channelId: '333333333333333333', accountId: ACCOUNT },
  },
  { method: 'DELETE', url: '/api/send-allowlist/333333333333333333' },
  {
    method: 'POST',
    url: '/api/send-allowlist/categories',
    payload: { channelId: '333333333333333333', accountId: ACCOUNT },
  },
  { method: 'DELETE', url: '/api/send-allowlist/categories/333333333333333333' },
  { method: 'POST', url: '/api/mcp/tokens/t1/revoke' },
  { method: 'POST', url: '/api/mcp/clients/c1/revoke' },
  { method: 'POST', url: '/api/adoption-allowance', payload: { count: 5 } },
  { method: 'POST', url: '/api/automod/rules/r1/ready' },
  { method: 'POST', url: '/api/automod/rules/r1/signoff', payload: { signedOffBy: 'owner' } },
  {
    method: 'POST',
    url: '/api/automod/rules/r1/invite-allowlist',
    payload: { code: 'abc123', label: 'friend' },
  },
  { method: 'DELETE', url: '/api/automod/rules/r1/invite-allowlist/abc123' },
  {
    method: 'POST',
    url: '/api/automod/rules/r1/link-domains',
    payload: { domain: 'example.com', listType: 'allow' },
  },
  { method: 'DELETE', url: '/api/automod/rules/r1/link-domains/example.com' },
  { method: 'POST', url: '/api/backup-now' },
  { method: 'POST', url: '/api/providers/unknown-provider/review' },
  { method: 'POST', url: '/api/accounts/nobody/disabled', payload: { disabled: true } },
  { method: 'DELETE', url: '/api/accounts/nobody' },
  { method: 'POST', url: '/api/accounts/nobody/revoke-credentials' },
  { method: 'POST', url: '/api/accounts/nobody/password', payload: { confirm: true } },
  { method: 'POST', url: '/api/accounts/nobody/grant-guild' },
  { method: 'POST', url: '/api/accounts/nobody/revoke-guild' },
  {
    method: 'POST',
    url: '/api/accounts/nobody/capabilities',
    payload: { capability: 'audit.read' },
  },
];

const ALL_GRANTS: readonly Capability[] = [
  'config.read',
  'config.write',
  'logging.manage',
  'panels.manage',
  'moderation.act',
  'undo.execute',
  'roles.mutate',
  'accounts.manage',
];

describe('ops-write routes', () => {
  it('answers 401 without a session on every route', async () => {
    for (const call of ALL_CALLS) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        ...(call.payload !== undefined ? { payload: call.payload } : {}),
      });
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(401);
    }
  });

  it('answers 403 without the CSRF header on every route', async () => {
    const { cookie } = await signIn();
    grant(ALL_GRANTS);
    for (const call of ALL_CALLS) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        headers: { cookie },
        ...(call.payload !== undefined ? { payload: call.payload } : {}),
      });
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(403);
    }
  });

  it('answers 403 no-grant with CSRF but without capabilities on every route', async () => {
    const { cookie, csrf } = await signIn();
    for (const call of ALL_CALLS) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        headers: { cookie, [CSRF]: csrf },
        ...(call.payload !== undefined ? { payload: call.payload } : {}),
      });
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(403);
      expect(response.json(), `${call.method} ${call.url}`).toEqual({ error: 'no-grant' });
    }
  });

  it('account lifecycle routes need accounts.manage, not config.write (ADR 0056)', async () => {
    const { cookie, csrf } = await signIn();
    // Every capability the instance knows EXCEPT accounts.manage. The point
    // of the gate: config.write alone must not reach password reset, which
    // hands back working credentials for a more privileged account.
    grant(CAPABILITIES.filter((capability) => capability !== 'accounts.manage'));
    const accountCalls = ALL_CALLS.filter((call) => call.url.startsWith('/api/accounts/'));
    expect(accountCalls).toHaveLength(7);
    for (const call of accountCalls) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        headers: { cookie, [CSRF]: csrf },
        ...(call.payload !== undefined ? { payload: call.payload } : {}),
      });
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(403);
      expect(response.json(), `${call.method} ${call.url}`).toEqual({ error: 'no-grant' });
    }
  });

  it('answers 400 for malformed bodies', async () => {
    const { cookie, csrf } = await signIn();
    grant(ALL_GRANTS);
    const bad: readonly Call[] = [
      { method: 'POST', url: '/api/settings', payload: { key: 'nope', value: 1 } },
      { method: 'POST', url: '/api/log-exclusions', payload: { channelId: 'not-a-snowflake' } },
      { method: 'POST', url: '/api/archive/categories', payload: { channelId: 'nope' } },
      {
        method: 'POST',
        url: '/api/archive/channels/333333333333333333/threads',
        payload: { value: 'some' },
      },
      { method: 'POST', url: '/api/undo', payload: { batchId: '', reason: '' } },
      { method: 'POST', url: '/api/adoption-allowance', payload: { count: -1 } },
      { method: 'POST', url: '/api/accounts/x/disabled', payload: {} },
      { method: 'POST', url: '/api/accounts/x/password', payload: { confirm: false } },
    ];
    for (const call of bad) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        headers: { cookie, [CSRF]: csrf },
        payload: call.payload ?? {},
      });
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(400);
    }
  });

  it('revokes an MCP token lineage and audits it; unknown ids are 404 with no audit row', async () => {
    const { cookie, csrf } = await signIn();
    grant(ALL_GRANTS);
    const instance = t.scopes.instance();
    oauthRepo.createClient(instance, {
      clientId: 'client_1',
      clientName: 'Claude Desktop',
      redirectUris: ['https://claude.test/callback'],
      createdAt: clock,
      createdByAccountId: ACCOUNT,
      registrationSource: 'dynamic',
    });
    oauthRepo.createToken(instance, {
      tokenId: 'tok_1',
      tokenHash: 'hash_1',
      kind: 'access',
      clientId: 'client_1',
      accountId: ACCOUNT,
      scopes: ['mcp'],
      createdAt: clock,
      expiresAt: clock + 60_000,
      parentTokenId: null,
      issuedFromCodeHash: 'codehash_1',
    });

    const ok = await app.inject({
      method: 'POST',
      url: '/api/mcp/tokens/tok_1/revoke',
      headers: { cookie, [CSRF]: csrf },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ tokenId: 'tok_1', tokensRevoked: 1 });
    expect(oauthRepo.findTokenById(instance, 'tok_1')?.revokedAt).toBe(clock);
    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 5 });
    expect(rows.some((row) => row.action === 'mcp.token.revoked')).toBe(true);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/mcp/tokens/nope/revoke',
      headers: { cookie, [CSRF]: csrf },
    });
    expect(missing.statusCode).toBe(404);
    const missingBody: { error: string } = missing.json();
    expect(missingBody.error).toBe('no-such-token');

    const clientGone = await app.inject({
      method: 'POST',
      url: '/api/mcp/clients/client_1/revoke',
      headers: { cookie, [CSRF]: csrf },
    });
    expect(clientGone.statusCode).toBe(200);
    expect(oauthRepo.findClient(instance, 'client_1')).toBeUndefined();
  });

  it('maps usage answers to 404s', async () => {
    const { cookie, csrf } = await signIn();
    grant(ALL_GRANTS);
    const missing: readonly Call[] = [
      { method: 'POST', url: '/api/providers/unknown-provider/review' },
      { method: 'POST', url: '/api/accounts/nobody/disabled', payload: { disabled: true } },
      { method: 'DELETE', url: '/api/accounts/nobody' },
      { method: 'POST', url: '/api/accounts/nobody/grant-guild' },
      { method: 'POST', url: '/api/accounts/nobody/revoke-guild' },
      { method: 'POST', url: '/api/archive/messages/333333333333333333/preserve' },
    ];
    for (const call of missing) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        headers: { cookie, [CSRF]: csrf },
        ...(call.payload !== undefined ? { payload: call.payload } : {}),
      });
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(404);
    }
  });

  it('applies log exclusions and records the audit rows', async () => {
    const { cookie, csrf } = await signIn();
    grant(['logging.manage']);

    const added = await app.inject({
      method: 'POST',
      url: '/api/log-exclusions',
      headers: { cookie, [CSRF]: csrf },
      payload: { channelId: '333333333333333333' },
    });
    expect(added.statusCode).toBe(200);
    expect(loggingRepo.listExcludedChannels(t.scopes.forGuild(GUILD))).toContain(
      '333333333333333333',
    );

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/log-exclusions/333333333333333333',
      headers: { cookie, [CSRF]: csrf },
    });
    expect(removed.statusCode).toBe(200);
    expect(loggingRepo.listExcludedChannels(t.scopes.forGuild(GUILD))).not.toContain(
      '333333333333333333',
    );

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 10 });
    const actions = rows.map((row) => row.action);
    expect(actions).toContain('log_exclusion.added');
    expect(actions).toContain('log_exclusion.removed');
    for (const row of rows) {
      expect(row.actorType).toBe('dashboard');
      expect(row.via).toBe('http');
    }
  });

  it('disables and deletes a real account with audit attribution', async () => {
    const { cookie, csrf } = await signIn();
    grant(['accounts.manage']);
    const instance = t.scopes.instance();
    accountRepo.createAccount(instance, {
      accountId: 'acct_ffffffffffffffffffffffffffffffff',
      username: 'second',
      passwordHash: await hashPassword(PASSWORD),
      isOwner: false,
      now: clock,
    });

    const disabled = await app.inject({
      method: 'POST',
      url: '/api/accounts/second/disabled',
      headers: { cookie, [CSRF]: csrf },
      payload: { disabled: true },
    });
    expect(disabled.statusCode).toBe(200);
    const disabledBody: { disabled: boolean } = disabled.json();
    expect(disabledBody.disabled).toBe(true);

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/accounts/second',
      headers: { cookie, [CSRF]: csrf },
    });
    expect(deleted.statusCode).toBe(200);
    expect(accountRepo.findAccountByUsername(instance, 'second')).toBeUndefined();

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 10 });
    const actions = rows.map((row) => row.action);
    expect(actions).toContain('account.disabled');
    expect(actions).toContain('account.deleted');
  });

  it('refuses archive writes when the guild is not archive-enabled', async () => {
    const { cookie, csrf } = await signIn();
    grant(['config.write']);
    const response = await app.inject({
      method: 'POST',
      url: '/api/archive/channels',
      headers: { cookie, [CSRF]: csrf },
      payload: { channelId: '333333333333333333', attachmentPolicy: 'none' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'guild-not-archive-enabled' });
  });

  it('rebuilds the archive index and audits it', async () => {
    const { cookie, csrf } = await signIn();
    grant(['config.write']);
    const response = await app.inject({
      method: 'POST',
      url: '/api/archive/reindex',
      headers: { cookie, [CSRF]: csrf },
    });
    expect(response.statusCode).toBe(200);
    const reindexBody: { indexed: number } = response.json();
    expect(reindexBody.indexed).toBe(0);
    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 10 });
    expect(rows.map((row) => row.action)).toContain('archive_reindex.ran');
  });
});

describe('POST /api/accounts/:username/capabilities (account grant parity)', () => {
  const MOD = 'acct_11111111111111111111111111111111';

  const call = (cookie: string, csrf: string, username: string, capability: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/accounts/${username}/capabilities`,
      headers: { cookie, [CSRF]: csrf },
      payload: { capability },
    });

  beforeEach(async () => {
    const instance = t.scopes.instance();
    accountRepo.createAccount(instance, {
      accountId: MOD,
      username: 'mod',
      passwordHash: await hashPassword(PASSWORD),
      isOwner: false,
      now: clock,
    });
  });

  it('grants a capability to an account with guild access and audits it', async () => {
    const { cookie, csrf } = await signIn();
    grant(ALL_GRANTS);
    accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), MOD);

    const first = await call(cookie, csrf, 'mod', 'audit.read');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ outcome: 'granted' });
    expect(authzRepo.listAccountCapabilities(t.scopes.forGuild(GUILD), MOD)).toContain(
      'audit.read',
    );

    const audits = effectRepo
      .tailAudit(t.scopes.forGuild(GUILD), { limit: 5 })
      .filter((row) => row.action === 'account.capability.granted');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.subjectId).toBe('mod');

    // Idempotent: the repeat is an answer, not a second change.
    const second = await call(cookie, csrf, 'mod', 'audit.read');
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ outcome: 'already-held' });
  });

  it('404s an unknown account and 409s one without guild access', async () => {
    const { cookie, csrf } = await signIn();
    grant(ALL_GRANTS);
    expect((await call(cookie, csrf, 'nobody', 'audit.read')).statusCode).toBe(404);
    expect((await call(cookie, csrf, 'mod', 'audit.read')).statusCode).toBe(409);
    expect(authzRepo.listAccountCapabilities(t.scopes.forGuild(GUILD), MOD)).toEqual([]);
  });

  it('400s a capability outside the known set', async () => {
    const { cookie, csrf } = await signIn();
    grant(ALL_GRANTS);
    accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), MOD);
    expect((await call(cookie, csrf, 'mod', 'everything.please')).statusCode).toBe(400);
  });
});

describe('POST /api/panels (ADR 0053, the builder)', () => {
  const PANEL_BODY = {
    panelId: 'colour-roles',
    channelId: '444444444444444444',
    behaviour: 'toggle',
    component: 'button',
    options: [
      { optionId: 'red', roleId: '333333333333333333', label: 'Red', position: 0 },
      {
        optionId: 'blue',
        roleId: '333333333333333334',
        label: 'Blue',
        emojiKey: 'u:1f535',
        position: 1,
      },
    ],
  };

  // A panel option must be a role Bananasaurs manages — the panel_options
  // foreign key enforces it, and the route refuses cleanly before it fires.
  const allowlistRoles = (): void => {
    const scope = t.scopes.forGuild(GUILD);
    roleRepo.allowlistRole(scope, '333333333333333333');
    roleRepo.allowlistRole(scope, '333333333333333334');
  };

  const post = (cookie: string, csrf: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/panels',
      headers: { cookie, [CSRF]: csrf },
      payload,
    });

  it('creates the panel, audits it as a dashboard write, and publishes nothing', async () => {
    const { cookie, csrf } = await signIn();
    grant(['panels.manage']);
    allowlistRoles();
    const response = await post(cookie, csrf, PANEL_BODY);
    expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
    expect(response.json()).toEqual({ ok: true, panelId: 'colour-roles', published: false });

    const scope = t.scopes.forGuild(GUILD);
    const stored = deps.portsFor(scope).findPanel('colour-roles');
    expect(stored).toMatchObject({ panelId: 'colour-roles', kind: 'managed', optionCount: 2 });
    // No message id: creating never reaches Discord.
    expect(stored?.messageId).toBeUndefined();

    const audit = effectRepo.tailAudit(scope, { limit: 5 });
    expect(audit[0]).toMatchObject({
      action: 'panel.created',
      subjectType: 'panel',
      subjectId: 'colour-roles',
      actorType: 'dashboard',
      actorId: ACCOUNT,
      via: 'http',
    });
  });

  it('stores message content and the allow/block gates (ADR 0054)', async () => {
    const { cookie, csrf } = await signIn();
    grant(['panels.manage']);
    allowlistRoles();
    const response = await post(cookie, csrf, {
      ...PANEL_BODY,
      content: 'Pick a colour — react below and the role is yours.',
      requiredRoleId: '777777777777777777',
      blockedRoleIds: ['888888888888888888'],
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(201);

    const stored = deps.portsFor(t.scopes.forGuild(GUILD)).findPanel('colour-roles');
    expect(stored).toMatchObject({
      content: 'Pick a colour — react below and the role is yours.',
      requiredRoleId: '777777777777777777',
      blockedRoleIds: ['888888888888888888'],
    });
  });

  it('answers 400 for a body the form could not have produced', async () => {
    const { cookie, csrf } = await signIn();
    grant(['panels.manage']);
    const response = await post(cookie, csrf, { ...PANEL_BODY, options: [] });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid-body' });
  });

  it('answers 400 naming the problem when the shared schema refuses the definition', async () => {
    const { cookie, csrf } = await signIn();
    grant(['panels.manage']);
    const response = await post(cookie, csrf, {
      ...PANEL_BODY,
      options: [{ optionId: 'red', roleId: '333333333333333333', emojiKey: 'banana', position: 0 }],
    });
    expect(response.statusCode).toBe(400);
    const body: { error: string; problems: string } = response.json();
    expect(body.error).toBe('invalid-definition');
    expect(body.problems).toContain('emojiKey');
  });

  it('answers 400 naming the role when an option is not in the live hierarchy', async () => {
    const { cookie, csrf } = await signIn();
    grant(['panels.manage']);
    const response = await post(cookie, csrf, PANEL_BODY);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'unmanageable-role',
      roleIds: ['333333333333333333', '333333333333333334'],
    });
    expect(deps.portsFor(t.scopes.forGuild(GUILD)).findPanel('colour-roles')).toBeUndefined();
  });

  it('refuses a role at or above the bot and allowlists a manageable picked role', async () => {
    const { cookie, csrf } = await signIn();
    grant(['panels.manage']);
    // Admin (position 5) sits above the fixture bot role (position 4).
    const above = await post(cookie, csrf, {
      ...PANEL_BODY,
      options: [{ optionId: 'admin', roleId: '111111111111111119', label: 'Admin', position: 0 }],
    });
    expect(above.statusCode).toBe(400);
    expect(above.json()).toEqual({
      error: 'unmanageable-role',
      roleIds: ['111111111111111119'],
    });

    // Member (position 1) is below the bot: selecting it allowlists it as
    // part of the audited save.
    const scope = t.scopes.forGuild(GUILD);
    expect(deps.portsFor(scope).isManagedRole('777777777777777777')).toBe(false);
    const picked = await post(cookie, csrf, {
      ...PANEL_BODY,
      options: [
        { optionId: 'member', roleId: '777777777777777777', label: 'Member', emojiKey: 'u:1f535', position: 0 },
      ],
    });
    expect(picked.statusCode).toBe(201);
    expect(deps.portsFor(scope).isManagedRole('777777777777777777')).toBe(true);
    expect(deps.portsFor(scope).findPanel('colour-roles')).toBeDefined();
  });

  it('answers 409 for a duplicate panel id and writes nothing', async () => {
    const { cookie, csrf } = await signIn();
    grant(['panels.manage']);
    allowlistRoles();
    expect((await post(cookie, csrf, PANEL_BODY)).statusCode).toBe(201);
    const again = await post(cookie, csrf, PANEL_BODY);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'already-exists' });

    const scope = t.scopes.forGuild(GUILD);
    const created = effectRepo
      .tailAudit(scope, { limit: 10 })
      .filter((row) => row.action === 'panel.created');
    expect(created).toHaveLength(1);
  });
});

describe('archive categories, threads and send-allowlist categories (threads merge parity)', () => {
  const rebuildWithArchive = async (): Promise<void> => {
    await app.close();
    deps = {
      ...deps,
      portsFor: (scope) =>
        testPortsFor(scope, () => clock, {
          archiveGuildEnabled: true,
          instanceScope: t.scopes.instance(),
        }),
    };
    app = createServer({
      deps,
      registerRoutes: (instance, guard, d) => {
        registerOpsReadRoutes(instance, guard, d);
        registerOpsWriteRoutes(instance, guard, d);
      },
    });
  };

  it('enables and disables an archive category with audit attribution', async () => {
    await rebuildWithArchive();
    const { cookie, csrf } = await signIn();
    grant(['config.write']);
    const headers = { cookie, [CSRF]: csrf };

    const enabled = await app.inject({
      method: 'POST',
      url: '/api/archive/categories',
      headers,
      payload: { channelId: '999999999999999999' },
    });
    expect(enabled.statusCode).toBe(200);
    const enabledBody: { outcome: string; coverage: { channels: number } } = enabled.json();
    expect(enabledBody.outcome).toBe('enabled');

    const again = await app.inject({
      method: 'POST',
      url: '/api/archive/categories',
      headers,
      payload: { channelId: '999999999999999999' },
    });
    expect(again.json()).toMatchObject({ outcome: 'already-enabled' });

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 5 });
    expect(rows.map((row) => row.action)).toContain('archive_category.enabled');
    expect(rows[0]?.actorType).toBe('dashboard');

    const disabled = await app.inject({
      method: 'DELETE',
      url: '/api/archive/categories/999999999999999999',
      headers,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ outcome: 'disabled' });
    const rowsAfter = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 5 });
    expect(rowsAfter.map((row) => row.action)).toContain('archive_category.disabled');

    // A repeat disable changes nothing and audits nothing.
    const before = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 20 }).length;
    const repeat = await app.inject({
      method: 'DELETE',
      url: '/api/archive/categories/999999999999999999',
      headers,
    });
    expect(repeat.json()).toMatchObject({ outcome: 'not-enabled' });
    expect(effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 20 }).length).toBe(before);
  });

  it('refuses category writes when the guild is not archive-enabled', async () => {
    const { cookie, csrf } = await signIn();
    grant(['config.write']);
    const response = await app.inject({
      method: 'POST',
      url: '/api/archive/categories',
      headers: { cookie, [CSRF]: csrf },
      payload: { channelId: '999999999999999999' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'guild-not-archive-enabled' });
  });

  it('sets thread inclusion on an archived channel; unknown channels are 404', async () => {
    await rebuildWithArchive();
    const { cookie, csrf } = await signIn();
    grant(['config.write', 'config.read']);
    const headers = { cookie, [CSRF]: csrf };

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/archive/channels/333333333333333333/threads',
      headers,
      payload: { value: 'none' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'not-archived' });

    const enabled = await app.inject({
      method: 'POST',
      url: '/api/archive/channels',
      headers,
      payload: { channelId: '333333333333333333', attachmentPolicy: 'none' },
    });
    expect(enabled.statusCode).toBe(200);

    const updated = await app.inject({
      method: 'POST',
      url: '/api/archive/channels/333333333333333333/threads',
      headers,
      payload: { value: 'none' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ outcome: 'updated' });
    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 5 });
    expect(rows.map((row) => row.action)).toContain('archive_channel.threads_set');

    // And the status read carries the flag for the page's toggle.
    const status = await app.inject({ method: 'GET', url: '/api/archive/status', headers });
    const statusBody: {
      channels: { channelId: string; includeThreads?: boolean }[];
    } = status.json();
    expect(
      statusBody.channels.find((c) => c.channelId === '333333333333333333')?.includeThreads,
    ).toBe(false);
  });

  it('link-case refusals are 404s with no audit row (audit B2)', async () => {
    await rebuildWithArchive();
    const { cookie, csrf } = await signIn();
    grant(['moderation.act']);
    const headers = { cookie, [CSRF]: csrf };

    const before = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 50 }).length;
    const refused = await app.inject({
      method: 'POST',
      url: '/api/archive/link-case',
      headers,
      payload: { messageId: '999999999999999999', caseId: 'case_1' },
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toEqual({ error: 'not-found' });
    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 50 });
    expect(rows.length).toBe(before);
    expect(rows.map((row) => row.action)).not.toContain('archive_message.case_linked');
  });

  it('allows and disallows a send category with audit attribution', async () => {
    await rebuildWithArchive();
    const { cookie, csrf } = await signIn();
    grant(['config.write', 'config.read']);
    const headers = { cookie, [CSRF]: csrf };

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/send-allowlist/categories',
      headers,
      payload: { channelId: '999999999999999999', accountId: ACCOUNT },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ outcome: 'allowed' });
    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 5 });
    expect(rows.map((row) => row.action)).toContain('send_category.allowed');

    const list = await app.inject({ method: 'GET', url: '/api/send-allowlist', headers });
    const listBody: { entries: { channelId: string; scopeKind?: string }[] } = list.json();
    expect(listBody.entries.find((e) => e.channelId === '999999999999999999')?.scopeKind).toBe(
      'category',
    );

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/send-allowlist/categories/999999999999999999',
      headers,
    });
    expect(removed.json()).toEqual({ ok: true, outcome: 'removed' });
    const rowsAfter = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 5 });
    expect(rowsAfter.map((row) => row.action)).toContain('send_category.disallowed');

    const before = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 20 }).length;
    const repeat = await app.inject({
      method: 'DELETE',
      url: '/api/send-allowlist/categories/999999999999999999',
      headers,
    });
    expect(repeat.json()).toEqual({ ok: true, outcome: 'not-allowed' });
    expect(effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 20 }).length).toBe(before);
  });
});
