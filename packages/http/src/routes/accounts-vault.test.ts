import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, effectRepo, guildRepo } from '@bananasaurs/storage';
import { parseGuildId } from '@bananasaurs/core';
import { createServer, CSRF_HEADER, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { POLICY } from '../policy.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerOpsWriteRoutes } from './ops-write.js';

/**
 * `POST /api/accounts/:username/reveal-password` (ADR 0070, spec A4).
 *
 * Owner-only regardless of capability, requires a fresh reauth, refuses an
 * owner target, and never lets the password reach anywhere but the response
 * body — asserted directly against the audit row's JSON, not just against
 * what the route intended to write.
 */

const GUILD = parseGuildId('111111111111111111');
const PASSWORD = 'correct horse battery staple';

const OWNER = 'acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_OWNER = 'acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MOD = 'acct_cccccccccccccccccccccccccccccccc';
const OPS = 'acct_dddddddddddddddddddddddddddddddd';

const REVEALED_PASSWORD = 'the-actual-plaintext-password';

let t: MigratedTestDatabase;
let clock: number;
let app: FastifyInstance;
let accountRevealPasswordSpy: Mock;

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'guild', now: clock });

  const scope = t.scopes.instance();
  for (const [accountId, username, isOwner] of [
    [OWNER, 'owner', true],
    [OTHER_OWNER, 'other-owner', true],
    [MOD, 'mod', false],
    [OPS, 'ops', false],
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
  // OPS holds accounts.manage but is not an owner — the reveal route checks
  // `isInstanceOwner`, not the capability, so this account proves that
  // holding the capability alone is not enough.
  authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD), {
    accountId: OPS,
    capability: 'accounts.manage',
    grantedBy: 'test',
    now: clock,
  });

  const real = testInstanceFor(scope, () => clock);
  // The vault's own seal/open contract is covered by password-vault.test.ts;
  // here the port is a spy so each test controls exactly what the route
  // sees, the same pattern `accounts-owner.test.ts` uses for
  // `accountSetPassword`.
  accountRevealPasswordSpy = vi.fn((username: string) => {
    if (username === 'mod') return { username: 'mod', password: REVEALED_PASSWORD };
    if (username === 'no-sealed-copy') return 'not-revealable' as const;
    return 'no-such-account' as const;
  });
  const instance: HttpDeps['instance'] = {
    ...real,
    accountRevealPassword: accountRevealPasswordSpy,
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
  return { cookie: cookieFrom(response.headers['set-cookie']), [CSRF_HEADER]: body.csrfToken };
};

const reveal = (username: string, headers: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: `/api/accounts/${username}/reveal-password`,
    headers,
    payload: {},
  });

const auditRows = () =>
  effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 50, sinceMs: undefined });

describe('POST /api/accounts/:username/reveal-password', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/mod/reveal-password',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it('owner session with fresh reauth reveals the password and audits with no password in the row', async () => {
    const headers = await signInAs('owner');
    const response = await reveal('mod', headers);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ username: 'mod', password: REVEALED_PASSWORD });
    expect(accountRevealPasswordSpy).toHaveBeenCalledWith('mod');

    const rows = auditRows();
    const row = rows.find((r) => r.action === 'account.password_revealed');
    expect(row).toBeDefined();
    expect(row?.subjectId).toBe('mod');
    // The audit JSON must not carry the plaintext anywhere — before, after,
    // or otherwise (hard rule 4).
    expect(JSON.stringify(row)).not.toContain(REVEALED_PASSWORD);
    expect(row?.after).toBe('{}');
  });

  it('owner session without fresh reauth answers 401 reauth-required and does not reveal', async () => {
    const headers = await signInAs('owner');
    clock += POLICY.reauthWindowMs + 1;
    const response = await reveal('mod', headers);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'reauth-required' });
    expect(accountRevealPasswordSpy).not.toHaveBeenCalled();
  });

  it('a non-owner session, even holding accounts.manage, answers 403 owner-only', async () => {
    const headers = await signInAs('ops');
    const response = await reveal('mod', headers);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'owner-only' });
    expect(accountRevealPasswordSpy).not.toHaveBeenCalled();
  });

  it('a target that is an owner answers 403 owner-protected, whoever asks', async () => {
    const headers = await signInAs('owner');
    const response = await reveal('other-owner', headers);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'owner-protected' });
    expect(accountRevealPasswordSpy).not.toHaveBeenCalled();
  });

  it('an unknown username answers 404 no-such-account', async () => {
    const headers = await signInAs('owner');
    const response = await reveal('nobody', headers);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'no-such-account' });
  });

  it('an account with no sealed copy (or one that will not open) answers 409 not-revealable', async () => {
    accountRepo.createAccount(t.scopes.instance(), {
      accountId: 'acct_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      username: 'no-sealed-copy',
      passwordHash: await hashPassword(PASSWORD),
      isOwner: false,
      now: clock,
    });
    accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), 'acct_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');

    const headers = await signInAs('owner');
    const response = await reveal('no-sealed-copy', headers);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'not-revealable' });
  });

  it('does not audit a 404 or a 409', async () => {
    const headers = await signInAs('owner');
    await reveal('nobody', headers);
    await reveal('no-sealed-copy', headers);
    expect(auditRows().some((r) => r.action === 'account.password_revealed')).toBe(false);
  });
});
