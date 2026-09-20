import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, effectRepo, guildRepo, loggingRepo } from '@bananasaurs/storage';
import { parseGuildId, type Capability } from '@bananasaurs/core';
import { createServer, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
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
];

const ALL_GRANTS: readonly Capability[] = [
  'config.read',
  'config.write',
  'logging.manage',
  'panels.manage',
  'moderation.act',
  'undo.execute',
  'roles.mutate',
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

  it('answers 400 for malformed bodies', async () => {
    const { cookie, csrf } = await signIn();
    grant(ALL_GRANTS);
    const bad: readonly Call[] = [
      { method: 'POST', url: '/api/settings', payload: { key: 'nope', value: 1 } },
      { method: 'POST', url: '/api/log-exclusions', payload: { channelId: 'not-a-snowflake' } },
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
        payload: call.payload,
      });
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(400);
    }
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
    grant(['config.write']);
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
