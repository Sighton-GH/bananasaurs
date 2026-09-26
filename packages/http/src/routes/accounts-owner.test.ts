import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, effectRepo, guildRepo } from '@bananasaurs/storage';
import { parseGuildId, type Capability } from '@bananasaurs/core';
import { createServer, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerOpsWriteRoutes } from './ops-write.js';

/**
 * Owner protection (ADR 0069): every mutating dashboard account route except
 * create refuses an owner target with `403 owner-protected` — whoever asks —
 * while the owner may still change their own password. The instance here is a
 * stub whose account methods are spies, so the tests prove the guarded routes
 * never reach it; the ports and the owner lookup stay real.
 */

const GUILD = parseGuildId('111111111111111111');
const PASSWORD = 'correct horse battery staple';
const CSRF = 'x-bananasaurs-csrf';

const ALICE = 'acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SAM = 'acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OP = 'acct_cccccccccccccccccccccccccccccccc';

let t: MigratedTestDatabase;
let clock: number;
let app: FastifyInstance;
let instance: HttpDeps['instance'];
// Kept as their own bindings, not read back through `instance.accountDelete`
// / `instance.accountSetPassword`: `OpsInstance`'s methods use TypeScript
// method-shorthand syntax, so accessing one as a bare value (to hand it to
// `toHaveBeenCalled`) trips `@typescript-eslint/unbound-method`. A plain
// local variable has no such "this"-bound method type to lose.
let accountDeleteSpy: Mock;
let accountSetPasswordSpy: Mock;

const grantManage = (accountId: string): void => {
  authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD), {
    accountId,
    capability: 'accounts.manage',
    grantedBy: 'test',
    now: clock,
  });
};

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'guild', now: clock });

  const scope = t.scopes.instance();
  for (const [accountId, username, isOwner] of [
    [ALICE, 'alice', true],
    [SAM, 'sam', false],
    [OP, 'ops', false],
  ] as const) {
    accountRepo.createAccount(scope, {
      accountId,
      username,
      passwordHash: await hashPassword(PASSWORD),
      isOwner,
      now: clock,
    });
    accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), accountId);
  }
  grantManage(ALICE);
  grantManage(OP);

  const real = testInstanceFor(scope, () => clock);
  accountDeleteSpy = vi.fn((username: string) => ({
    username,
    accountId: `acct_${username}`,
    wasOwner: false,
    tokensRevoked: 0,
    codesDeleted: 0,
    enabledOwnersRemaining: 1,
    accountsRemaining: 2,
  }));
  accountSetPasswordSpy = vi.fn(async (username: string, password?: string) => ({
    username,
    accountId: `acct_${username}`,
    password: password ?? 'generated-fallback-password',
    sessionsRevoked: 0,
    guildsTouched: 1,
  }));
  instance = {
    ...real,
    // `real.accountCreate` is called rather than handed to `vi.fn` bare, for
    // the same `unbound-method` reason as the spies above.
    accountCreate: vi.fn((username: string, password?: string) =>
      real.accountCreate(username, password),
    ),
    // `accountSetDisabled` / `accountDelete` / `accountRevokeCredentials` are
    // synchronous on `OpsInstance` (ports.ts); the route handlers call them
    // without `await`, so a mock returning a Promise would hand the route a
    // pending Promise instead of the real result. Only `accountSetPassword`
    // is async.
    accountSetDisabled: vi.fn((username: string, disabled: boolean) => ({
      changed: true,
      username,
      isOwner: false,
      disabled,
      lockedUntil: null,
      enabledOwnersRemaining: 1,
    })),
    accountDelete: accountDeleteSpy,
    accountRevokeCredentials: vi.fn((username: string) => ({
      username,
      accountId: `acct_${username}`,
      sessionsRevoked: 0,
      tokensRevoked: 0,
      codesDeleted: 0,
      guildsTouched: 1,
      stillEnabled: true,
    })),
    accountSetPassword: accountSetPasswordSpy,
  };

  const deps: HttpDeps = {
    scopes: t.scopes,
    now: () => clock,
    guildIds: [GUILD],
    logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never,
    readonly: false,
    portsFor: (guildScope) =>
      testPortsFor(guildScope, () => clock, { instanceScope: t.scopes.instance() }),
    instance,
  };
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

const signInAs = async (username: string): Promise<Record<string, string>> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username, password: PASSWORD, guildId: GUILD },
  });
  expect(response.statusCode).toBe(200);
  const body: { csrfToken: string } = response.json();
  return { cookie: cookieFrom(response.headers['set-cookie']), [CSRF]: body.csrfToken };
};

describe('owner protection (ADR 0069)', () => {
  it('refuses to delete the owner and never reaches the instance', async () => {
    const headers = await signInAs('ops');
    const response = await app.inject({ method: 'DELETE', url: '/api/accounts/alice', headers });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'owner-protected' });
    expect(accountDeleteSpy).not.toHaveBeenCalled();
    expect(accountRepo.findAccountByUsername(t.scopes.instance(), 'alice')).toBeDefined();
  });

  it.each([
    { method: 'POST', url: '/api/accounts/alice/disabled', payload: { disabled: true } },
    { method: 'POST', url: '/api/accounts/alice/revoke-credentials' },
    { method: 'POST', url: '/api/accounts/alice/grant-guild' },
    { method: 'POST', url: '/api/accounts/alice/revoke-guild' },
    {
      method: 'POST',
      url: '/api/accounts/alice/capabilities',
      payload: { capability: 'config.read' },
    },
    { method: 'DELETE', url: '/api/accounts/alice/capabilities/config.read' },
  ])('refuses $method $url on the owner', async ({ method, url, payload }) => {
    const headers = await signInAs('ops');
    const response = await app.inject({
      method: method as 'POST' | 'DELETE',
      url,
      headers,
      ...(payload !== undefined ? { payload } : {}),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'owner-protected' });
  });

  it('refuses every other owner mutation even from the owner session', async () => {
    const headers = await signInAs('alice');
    for (const call of [
      { method: 'DELETE', url: '/api/accounts/alice' },
      { method: 'POST', url: '/api/accounts/alice/disabled', payload: { disabled: true } },
      { method: 'POST', url: '/api/accounts/alice/revoke-credentials' },
      { method: 'POST', url: '/api/accounts/alice/revoke-guild' },
    ] as const) {
      const response = await app.inject({
        method: call.method,
        url: call.url,
        headers,
        ...('payload' in call ? { payload: call.payload } : {}),
      });
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(403);
      expect(response.json()).toMatchObject({ error: 'owner-protected' });
    }
    expect(accountDeleteSpy).not.toHaveBeenCalled();
  });

  it('lets the owner change their own password but refuses anyone else', async () => {
    const opHeaders = await signInAs('ops');
    const refused = await app.inject({
      method: 'PUT',
      url: '/api/accounts/alice/password',
      headers: opHeaders,
      payload: {},
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'owner-protected' });

    const aliceHeaders = await signInAs('alice');
    const allowed = await app.inject({
      method: 'PUT',
      url: '/api/accounts/alice/password',
      headers: aliceHeaders,
      payload: {},
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('applies the same operations to a member without an owner refusal', async () => {
    const headers = await signInAs('ops');

    const deleted = await app.inject({ method: 'DELETE', url: '/api/accounts/sam', headers });
    expect(deleted.statusCode).toBe(200);

    const disabled = await app.inject({
      method: 'POST',
      url: '/api/accounts/sam/disabled',
      headers,
      payload: { disabled: true },
    });
    expect(disabled.statusCode).toBe(200);

    const revokedGuild = await app.inject({
      method: 'POST',
      url: '/api/accounts/sam/revoke-guild',
      headers,
    });
    expect(revokedGuild.statusCode).toBe(200);

    const credentials = await app.inject({
      method: 'POST',
      url: '/api/accounts/sam/revoke-credentials',
      headers,
    });
    expect(credentials.statusCode).toBe(200);
  });
});

describe('create always grants this server (ADR 0069)', () => {
  it('grants the session guild and capabilities with no grantThisGuild field', async () => {
    const headers = await signInAs('ops');
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers,
      payload: { username: 'kim', capabilities: ['config.read'] satisfies Capability[] },
    });
    expect(response.statusCode).toBe(201);
    const body: { username: string; guildAccess: boolean; capabilities: string[] } =
      response.json();
    expect(body.guildAccess).toBe(true);
    expect(body.capabilities).toEqual(['config.read']);

    const row = accountRepo.findAccountByUsername(t.scopes.instance(), 'kim');
    expect(row).toBeDefined();
    expect(accountRepo.hasGuildAccess(t.scopes.forGuild(GUILD), row!.accountId)).toBe(true);
    expect(authzRepo.listAccountCapabilities(t.scopes.forGuild(GUILD), row!.accountId)).toEqual([
      'config.read',
    ]);
  });

  it('ignores a stale grantThisGuild field instead of refusing', async () => {
    const headers = await signInAs('ops');
    for (const [username, grantThisGuild] of [
      ['kim', false],
      ['ken', true],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers,
        payload: { username, grantThisGuild, capabilities: ['config.read'] },
      });
      expect(response.statusCode, `grantThisGuild: ${String(grantThisGuild)}`).toBe(201);
      expect(response.json()).toMatchObject({ guildAccess: true });
    }
  });
});

describe('revoke one permission (ADR 0069)', () => {
  it('revokes a single capability with audit and is idempotent', async () => {
    const headers = await signInAs('ops');
    const granted = await app.inject({
      method: 'POST',
      url: '/api/accounts/sam/capabilities',
      headers,
      payload: { capability: 'config.read' },
    });
    expect(granted.statusCode).toBe(200);

    const revoked = await app.inject({
      method: 'DELETE',
      url: '/api/accounts/sam/capabilities/config.read',
      headers,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ outcome: 'revoked' });
    expect(
      authzRepo.listAccountCapabilities(
        t.scopes.forGuild(GUILD),
        accountRepo.findAccountByUsername(t.scopes.instance(), 'sam')!.accountId,
      ),
    ).toEqual([]);

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 10 });
    const row = rows.find((r) => r.action === 'account.capability_revoked');
    expect(row).toBeDefined();
    expect(row!.subjectId).toBe('sam');
    expect(JSON.parse(row!.after ?? '{}')).toMatchObject({
      capability: 'config.read',
      changed: true,
    });

    const repeat = await app.inject({
      method: 'DELETE',
      url: '/api/accounts/sam/capabilities/config.read',
      headers,
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual({ outcome: 'not-held' });
  });

  it('answers 400 for an unknown capability and 404 for an unknown account', async () => {
    const headers = await signInAs('ops');
    const unknownCapability = await app.inject({
      method: 'DELETE',
      url: '/api/accounts/sam/capabilities/not-a-capability',
      headers,
    });
    expect(unknownCapability.statusCode).toBe(400);

    const unknownAccount = await app.inject({
      method: 'DELETE',
      url: '/api/accounts/nobody/capabilities/config.read',
      headers,
    });
    expect(unknownAccount.statusCode).toBe(404);
    expect(unknownAccount.json()).toMatchObject({ error: 'no-such-account' });
  });
});

describe('chosen passwords (ADR 0069)', () => {
  it('refuses a short password without reaching the instance', async () => {
    const headers = await signInAs('ops');
    const response = await app.inject({
      method: 'PUT',
      url: '/api/accounts/sam/password',
      headers,
      payload: { password: 'short' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'weak-password' });
    expect(accountSetPasswordSpy).not.toHaveBeenCalled();
  });

  it('echoes a chosen password once and never audits it', async () => {
    const headers = await signInAs('ops');
    const chosen = 'correct horse battery';
    const response = await app.inject({
      method: 'PUT',
      url: '/api/accounts/sam/password',
      headers,
      payload: { password: chosen },
    });
    expect(response.statusCode).toBe(200);
    const body: { username: string; password: string } = response.json();
    expect(body.username).toBe('sam');
    expect(body.password).toBe(chosen);

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 10 });
    const reset = rows.find((r) => r.action === 'account.password_reset');
    expect(reset).toBeDefined();
    expect(JSON.parse(reset!.after ?? '{}')).toMatchObject({ chosen: true });
    // The plaintext appears in no audit row and no log call.
    expect(JSON.stringify(rows)).not.toContain(chosen);
  });

  it('generates a password when none is chosen', async () => {
    const headers = await signInAs('ops');
    const response = await app.inject({
      method: 'PUT',
      url: '/api/accounts/sam/password',
      headers,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body: { username: string; password: string } = response.json();
    expect(body.username).toBe('sam');
    expect(typeof body.password).toBe('string');
    expect(body.password.length).toBeGreaterThan(0);

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 10 });
    const reset = rows.find((r) => r.action === 'account.password_reset');
    expect(reset).toBeDefined();
    expect(JSON.parse(reset!.after ?? '{}')).toMatchObject({ chosen: false });
  });

  it('keeps the legacy POST reset working', async () => {
    const headers = await signInAs('ops');
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/sam/password',
      headers,
      payload: { confirm: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ username: 'sam' });
  });
});
