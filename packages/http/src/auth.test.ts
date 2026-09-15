import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzStoreFor, guildRepo, sessionRepo } from '@bananasaurs/storage';
import { authorize, parseGuildId } from '@bananasaurs/core';

import {
  actorFor,
  authenticate,
  bootstrap,
  bootstrapIsArmed,
  issueBootstrapTokenIfNeeded,
  login,
  logout,
  reauthenticate,
  reauthIsFresh,
  verifyAccountCredentials,
  type AuthDeps,
} from './auth.js';
import { POLICY } from './policy.js';
import { csrfTokenFor, hashPassword, hashToken } from './secrets.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const PASSWORD = 'correct horse battery staple';

let t: MigratedTestDatabase;
let clock: number;
let deps: AuthDeps;

const at = (ms: number): void => {
  clock = ms;
};

beforeEach(() => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  deps = {
    scopes: t.scopes,
    now: () => clock,
    guildIds: [GUILD_A, GUILD_B],
  };
  // Both guild rows are required by the foreign keys on account_guild_access
  // and dashboard_sessions.
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_A), { name: 'guild a', now: clock });
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_B), { name: 'guild b', now: clock });
});
afterEach(() => {
  t.close();
});

/** Provisions an account the way `bananasaurs` eventually will, minus the CLI. */
const provision = async (options: {
  username?: string;
  password?: string;
  guilds?: string[];
  capabilities?: ('killswitch.toggle' | 'audit.read')[];
  accountId?: string;
}): Promise<string> => {
  const instance = t.scopes.instance();
  const accountId = options.accountId ?? 'acct_0123456789abcdef0123456789abcdef';
  accountRepo.createAccount(instance, {
    accountId,
    username: options.username ?? 'owner',
    passwordHash: await hashPassword(options.password ?? PASSWORD),
    isOwner: true,
    now: clock,
  });
  for (const guildId of options.guilds ?? [GUILD_A]) {
    const scope = t.scopes.forGuild(parseGuildId(guildId));
    accountRepo.grantGuildAccess(scope, accountId);
    accountRepo.grantAllCapabilities(scope, {
      accountId,
      capabilities: options.capabilities ?? ['killswitch.toggle'],
      grantedBy: 'test',
      now: clock,
    });
  }
  return accountId;
};

describe('login', () => {
  it('issues a session for a correct password', async () => {
    await provision({});
    const result = await login(deps, { username: 'owner', password: PASSWORD, ip: '127.0.0.1' });
    expect(result.ok).toBe(true);
  });

  it('never returns the token in a form that is also what is stored', async () => {
    await provision({});
    const result = await login(deps, { username: 'owner', password: PASSWORD, ip: null });
    if (!result.ok) throw new Error('expected a session');
    const row = sessionRepo.findSessionByHash(t.scopes.instance(), hashToken(result.token));
    expect(row).toBeDefined();
    // The row's key is the hash, and the hash is not the token: a database dump
    // yields nothing anyone can log in with.
    expect(row?.sessionId).not.toBe(result.token);
    expect(row?.sessionId).toBe(hashToken(result.token));
  });

  it('sets an absolute twelve-hour expiry (ADR 0029)', async () => {
    await provision({});
    const result = await login(deps, { username: 'owner', password: PASSWORD, ip: null });
    if (!result.ok) throw new Error('expected a session');
    expect(result.expiresAt).toBe(clock + POLICY.sessionTtlMs);
  });

  it('counts a fresh login as a re-authentication', async () => {
    // Otherwise the first destructive action after logging in would always ask
    // for the password a second time.
    await provision({});
    const result = await login(deps, { username: 'owner', password: PASSWORD, ip: null });
    if (!result.ok) throw new Error('expected a session');
    const auth = authenticate(deps, result.token);
    expect(auth.ok && reauthIsFresh(auth.session, clock)).toBe(true);
  });

  it('refuses a wrong password', async () => {
    await provision({});
    const result = await login(deps, { username: 'owner', password: 'wrong', ip: null });
    expect(result).toEqual({ ok: false, reason: 'invalid-credentials' });
  });

  it('answers an unknown username exactly as it answers a wrong password', async () => {
    await provision({});
    const unknown = await login(deps, { username: 'nobody', password: PASSWORD, ip: null });
    const wrong = await login(deps, { username: 'owner', password: 'wrong', ip: null });
    expect(unknown).toEqual(wrong);
  });

  it('refuses an account with no access to any guild this instance serves', async () => {
    const instance = t.scopes.instance();
    accountRepo.createAccount(instance, {
      accountId: 'acct_ffffffffffffffffffffffffffffffff',
      username: 'stranded',
      passwordHash: await hashPassword(PASSWORD),
      isOwner: false,
      now: clock,
    });
    const result = await login(deps, { username: 'stranded', password: PASSWORD, ip: null });
    expect(result).toEqual({ ok: false, reason: 'no-guild-access' });
  });

  it('infers the guild when exactly one is reachable', async () => {
    await provision({ guilds: [GUILD_A] });
    const result = await login(deps, { username: 'owner', password: PASSWORD, ip: null });
    expect(result.ok && result.guildId).toBe(GUILD_A);
  });

  it('refuses to guess when more than one guild is reachable', async () => {
    // Picking the first would silently log someone into the wrong server — the
    // same refusal the operator socket makes for a command with no --guild.
    await provision({ guilds: [GUILD_A, GUILD_B] });
    const result = await login(deps, { username: 'owner', password: PASSWORD, ip: null });
    expect(result).toEqual({ ok: false, reason: 'guild-required' });
  });

  it('accepts a named guild the account can reach', async () => {
    await provision({ guilds: [GUILD_A, GUILD_B] });
    const result = await login(deps, {
      username: 'owner',
      password: PASSWORD,
      guildId: GUILD_B,
      ip: null,
    });
    expect(result.ok && result.guildId).toBe(GUILD_B);
  });

  it('refuses a named guild the account cannot reach', async () => {
    await provision({ guilds: [GUILD_A] });
    const result = await login(deps, {
      username: 'owner',
      password: PASSWORD,
      guildId: GUILD_B,
      ip: null,
    });
    expect(result).toEqual({ ok: false, reason: 'guild-required' });
  });

  it('refuses a guild this instance does not serve, even with an access row', async () => {
    await provision({ guilds: [GUILD_A, GUILD_B] });
    const narrowed: AuthDeps = { ...deps, guildIds: [GUILD_A] };
    const result = await login(narrowed, {
      username: 'owner',
      password: PASSWORD,
      guildId: GUILD_B,
      ip: null,
    });
    expect(result).toEqual({ ok: false, reason: 'guild-required' });
  });

  it('refuses a disabled account without saying so', async () => {
    const accountId = await provision({});
    t.raw.prepare(`UPDATE dashboard_accounts SET disabled = 1 WHERE account_id = ?`).run(accountId);
    const result = await login(deps, { username: 'owner', password: PASSWORD, ip: null });
    expect(result).toEqual({ ok: false, reason: 'invalid-credentials' });
  });
});

describe('lockout (ADR 0029)', () => {
  it('locks after five wrong passwords', async () => {
    await provision({});
    for (let i = 0; i < 4; i++) {
      expect(await login(deps, { username: 'owner', password: 'wrong', ip: null })).toEqual({
        ok: false,
        reason: 'invalid-credentials',
      });
    }
    expect(await login(deps, { username: 'owner', password: 'wrong', ip: null })).toEqual({
      ok: false,
      reason: 'locked-out',
    });
  });

  it('refuses the correct password while locked', async () => {
    await provision({});
    for (let i = 0; i < 5; i++)
      await login(deps, { username: 'owner', password: 'wrong', ip: null });
    expect(await login(deps, { username: 'owner', password: PASSWORD, ip: null })).toEqual({
      ok: false,
      reason: 'locked-out',
    });
  });

  it('does not check the password at all while locked', async () => {
    // The failure counter must not keep rising while locked, or an attacker
    // could keep the account locked and keep testing guesses through it.
    await provision({});
    for (let i = 0; i < 5; i++)
      await login(deps, { username: 'owner', password: 'wrong', ip: null });
    const before = accountRepo.findAccountById(
      t.scopes.instance(),
      await currentAccountId(),
    )?.failedAttempts;
    await login(deps, { username: 'owner', password: 'wrong', ip: null });
    const after = accountRepo.findAccountById(
      t.scopes.instance(),
      await currentAccountId(),
    )?.failedAttempts;
    expect(after).toBe(before);
  });

  it('lets the correct password through once the window passes', async () => {
    await provision({});
    for (let i = 0; i < 5; i++)
      await login(deps, { username: 'owner', password: 'wrong', ip: null });
    at(clock + POLICY.lockoutMs + 1);
    expect((await login(deps, { username: 'owner', password: PASSWORD, ip: null })).ok).toBe(true);
  });

  it('resets the counter after a correct password', async () => {
    await provision({});
    for (let i = 0; i < 4; i++)
      await login(deps, { username: 'owner', password: 'wrong', ip: null });
    await login(deps, { username: 'owner', password: PASSWORD, ip: null });
    expect(
      accountRepo.findAccountById(t.scopes.instance(), await currentAccountId())?.failedAttempts,
    ).toBe(0);
  });
});

describe('verifyAccountCredentials (the shared check the consent page uses)', () => {
  it('locks the account after five wrong passwords', async () => {
    await provision({});
    for (let i = 0; i < 4; i++) {
      expect(
        await verifyAccountCredentials(deps, {
          username: 'owner',
          password: 'wrong',
          ip: null,
        }),
      ).toEqual({ ok: false, reason: 'invalid-credentials' });
    }
    expect(
      await verifyAccountCredentials(deps, { username: 'owner', password: 'wrong', ip: null }),
    ).toEqual({ ok: false, reason: 'locked-out' });
    expect(
      accountRepo.findAccountById(t.scopes.instance(), await currentAccountId())?.lockedUntil,
    ).not.toBeNull();
  });

  it('refuses a locked-out account without checking the password or counting the attempt', async () => {
    await provision({});
    for (let i = 0; i < 5; i++)
      await verifyAccountCredentials(deps, { username: 'owner', password: 'wrong', ip: null });
    const before = accountRepo.findAccountById(
      t.scopes.instance(),
      await currentAccountId(),
    )?.failedAttempts;
    expect(
      await verifyAccountCredentials(deps, { username: 'owner', password: 'wrong', ip: null }),
    ).toEqual({ ok: false, reason: 'locked-out' });
    const after = accountRepo.findAccountById(
      t.scopes.instance(),
      await currentAccountId(),
    )?.failedAttempts;
    expect(after).toBe(before);
  });

  it('answers an unknown username exactly as it answers a wrong password', async () => {
    await provision({});
    const unknown = await verifyAccountCredentials(deps, {
      username: 'nobody',
      password: PASSWORD,
      ip: null,
    });
    const wrong = await verifyAccountCredentials(deps, {
      username: 'owner',
      password: 'wrong',
      ip: null,
    });
    expect(unknown).toEqual(wrong);
    expect(unknown).toEqual({ ok: false, reason: 'invalid-credentials' });
  });
});

const currentAccountId = async (): Promise<string> =>
  Promise.resolve(
    (
      t.raw.prepare(`SELECT account_id AS id FROM dashboard_accounts LIMIT 1`).get() as {
        id: string;
      }
    ).id,
  );

describe('authenticate', () => {
  const loginToken = async (): Promise<string> => {
    await provision({});
    const result = await login(deps, { username: 'owner', password: PASSWORD, ip: null });
    if (!result.ok) throw new Error('expected a session');
    return result.token;
  };

  it('accepts a live session', async () => {
    const token = await loginToken();
    expect(authenticate(deps, token).ok).toBe(true);
  });

  it('takes the guild from the row, never from the caller', async () => {
    const token = await loginToken();
    const result = authenticate(deps, token);
    expect(result.ok && result.session.guildId).toBe(GUILD_A);
  });

  it('rejects a missing cookie', () => {
    expect(authenticate(deps, undefined)).toEqual({ ok: false, reason: 'no-cookie' });
  });

  it('rejects an empty cookie rather than hashing it', () => {
    expect(authenticate(deps, '')).toEqual({ ok: false, reason: 'no-cookie' });
  });

  it('rejects a token that was never issued', async () => {
    await loginToken();
    expect(authenticate(deps, 'not-a-real-token')).toEqual({
      ok: false,
      reason: 'unknown-session',
    });
  });

  it('rejects the stored hash presented as if it were the token', async () => {
    // The failure this guards: hashing on write but comparing on read, so the
    // value in the database becomes a usable credential.
    const token = await loginToken();
    expect(authenticate(deps, hashToken(token)).ok).toBe(false);
  });

  it('rejects an expired session on the injected clock', async () => {
    const token = await loginToken();
    at(clock + POLICY.sessionTtlMs + 1);
    expect(authenticate(deps, token)).toEqual({ ok: false, reason: 'session-expired' });
  });

  it('accepts a session one millisecond before it expires', async () => {
    const token = await loginToken();
    at(clock + POLICY.sessionTtlMs - 1);
    expect(authenticate(deps, token).ok).toBe(true);
  });

  it('rejects a revoked session immediately (docs/19 §6.10)', async () => {
    const token = await loginToken();
    const session = authenticate(deps, token);
    if (!session.ok) throw new Error('expected a session');
    logout(deps, session.session);
    expect(authenticate(deps, token)).toEqual({ ok: false, reason: 'session-revoked' });
  });

  it('rejects a session whose account was disabled mid-session', async () => {
    const token = await loginToken();
    t.raw.prepare(`UPDATE dashboard_accounts SET disabled = 1`).run();
    expect(authenticate(deps, token)).toEqual({ ok: false, reason: 'account-disabled' });
  });

  it('rejects a session whose guild access was revoked mid-session', async () => {
    // Without this, revoking access would take effect only at the next login,
    // which on a twelve-hour session is not revocation.
    const token = await loginToken();
    accountRepo.revokeGuildAccess(t.scopes.forGuild(GUILD_A), await currentAccountId());
    expect(authenticate(deps, token)).toEqual({ ok: false, reason: 'access-revoked' });
  });

  it('derives a CSRF token that is not the session token and not its hash', async () => {
    const token = await loginToken();
    const result = authenticate(deps, token);
    if (!result.ok) throw new Error('expected a session');
    expect(result.session.csrfToken).toBe(csrfTokenFor(token));
    expect(result.session.csrfToken).not.toBe(token);
    expect(result.session.csrfToken).not.toBe(hashToken(token));
  });

  it('builds a dashboard actor with no Discord roles (ADR 0028)', async () => {
    const token = await loginToken();
    const result = authenticate(deps, token);
    expect(result.ok && result.session.actor).toEqual({
      type: 'dashboard',
      id: await currentAccountId(),
      roleIds: [],
    });
  });
});

describe('the session actor is authorized through capability_grants (ADR 0028)', () => {
  it('is granted what the account holds', async () => {
    await provision({ capabilities: ['killswitch.toggle'] });
    const accountId = await currentAccountId();
    const scope = t.scopes.forGuild(GUILD_A);
    const result = authorize(
      { store: authzStoreFor(scope), guildId: GUILD_A, actor: actorFor(accountId) },
      'killswitch.toggle',
    );
    expect(result.ok).toBe(true);
  });

  it('is refused what it does not hold', async () => {
    await provision({ capabilities: ['audit.read'] });
    const scope = t.scopes.forGuild(GUILD_A);
    const result = authorize(
      { store: authzStoreFor(scope), guildId: GUILD_A, actor: actorFor(await currentAccountId()) },
      'killswitch.toggle',
    );
    expect(result).toMatchObject({ ok: false, error: { reason: 'no-grant' } });
  });

  it('is refused in a guild it has no grant in, even holding the capability elsewhere', async () => {
    await provision({ guilds: [GUILD_A, GUILD_B], capabilities: ['killswitch.toggle'] });
    const accountId = await currentAccountId();
    accountRepo.revokeGuildAccess(t.scopes.forGuild(GUILD_B), accountId);
    const scope = t.scopes.forGuild(GUILD_B);
    const result = authorize(
      { store: authzStoreFor(scope), guildId: GUILD_B, actor: actorFor(accountId) },
      'killswitch.toggle',
    );
    expect(result.ok).toBe(false);
  });
});

describe('re-authentication (ADR 0029)', () => {
  const live = async () => {
    await provision({});
    const result = await login(deps, { username: 'owner', password: PASSWORD, ip: null });
    if (!result.ok) throw new Error('expected a session');
    const auth = authenticate(deps, result.token);
    if (!auth.ok) throw new Error('expected a session');
    return { token: result.token, session: auth.session };
  };

  it('is fresh right after login', async () => {
    const { session } = await live();
    expect(reauthIsFresh(session, clock)).toBe(true);
  });

  it('is stale after the window', async () => {
    const { session } = await live();
    expect(reauthIsFresh(session, clock + POLICY.reauthWindowMs + 1)).toBe(false);
  });

  it('is fresh exactly at the window boundary', async () => {
    const { session } = await live();
    expect(reauthIsFresh(session, clock + POLICY.reauthWindowMs)).toBe(true);
  });

  it('becomes fresh again on a correct password', async () => {
    const { token, session } = await live();
    at(clock + POLICY.reauthWindowMs + 1);
    expect(await reauthenticate(deps, session, PASSWORD)).toBe(true);
    const again = authenticate(deps, token);
    expect(again.ok && reauthIsFresh(again.session, clock)).toBe(true);
  });

  it('does not become fresh on a wrong password', async () => {
    const { token, session } = await live();
    at(clock + POLICY.reauthWindowMs + 1);
    expect(await reauthenticate(deps, session, 'wrong')).toBe(false);
    const again = authenticate(deps, token);
    expect(again.ok && reauthIsFresh(again.session, clock)).toBe(false);
  });

  it('counts a failed re-authentication towards the lockout', async () => {
    // A password field on an authenticated page must not be the cheapest place
    // in the system to guess.
    const { session } = await live();
    for (let i = 0; i < 5; i++) await reauthenticate(deps, session, 'wrong');
    expect(
      accountRepo.findAccountById(t.scopes.instance(), session.accountId)?.lockedUntil,
    ).not.toBeNull();
  });

  it('refuses while the account is locked, even with the correct password', async () => {
    const { session } = await live();
    for (let i = 0; i < 5; i++) await reauthenticate(deps, session, 'wrong');
    expect(await reauthenticate(deps, session, PASSWORD)).toBe(false);
  });

  it('does not extend the session it refreshed', async () => {
    const { token, session } = await live();
    const before = session.expiresAt;
    at(clock + POLICY.reauthWindowMs + 1);
    await reauthenticate(deps, session, PASSWORD);
    const again = authenticate(deps, token);
    expect(again.ok && again.session.expiresAt).toBe(before);
  });
});

describe('the first-account bootstrap (docs/19 §6.10)', () => {
  it('issues a token on an empty instance', () => {
    const issued = issueBootstrapTokenIfNeeded(deps, { readonly: false });
    expect(issued?.expiresAt).toBe(clock + POLICY.bootstrapTtlMs);
  });

  it('stores only the hash of the token it printed', () => {
    const issued = issueBootstrapTokenIfNeeded(deps, { readonly: false });
    if (issued === undefined) throw new Error('expected a token');
    const stored = t.raw.prepare(`SELECT token_hash AS h FROM bootstrap_tokens`).get() as {
      h: string;
    };
    expect(stored.h).toBe(hashToken(issued.token));
    expect(stored.h).not.toBe(issued.token);
  });

  it('issues nothing once an account exists', async () => {
    await provision({});
    expect(issueBootstrapTokenIfNeeded(deps, { readonly: false })).toBeUndefined();
  });

  it('issues nothing under BANANASAURS_READONLY, rather than throwing at startup', () => {
    // Slice 13d found the daemon could not start read-only. This runs at
    // startup and writes, so it is the same class of bug.
    const roDeps: AuthDeps = { ...deps, scopes: t.readonlyScopes };
    expect(() => issueBootstrapTokenIfNeeded(roDeps, { readonly: true })).not.toThrow();
    expect(issueBootstrapTokenIfNeeded(roDeps, { readonly: true })).toBeUndefined();
  });

  /**
   * Split into four, after mutation 205 survived the version that was one test.
   *
   * That test ended with "provision an account, expect not armed" — but it had
   * already advanced the clock past the token's expiry, and `at(clock)` after
   * `at(clock + ttl + 1)` reads the *advanced* value, so the clock never went
   * back. The final assertion therefore passed because the token had expired
   * and said nothing about the account count. Deleting the zero-accounts check
   * from `bootstrapIsArmed` left the whole suite green.
   *
   * Each condition now gets its own test, and the two that matter set up
   * exactly one reason to refuse.
   */
  it('is not armed on an empty instance with no token', () => {
    expect(bootstrapIsArmed(deps)).toBe(false);
  });

  it('is armed with zero accounts and a live token', () => {
    issueBootstrapTokenIfNeeded(deps, { readonly: false });
    expect(bootstrapIsArmed(deps)).toBe(true);
  });

  it('is not armed once the token expires, accounts or not', () => {
    issueBootstrapTokenIfNeeded(deps, { readonly: false });
    at(clock + POLICY.bootstrapTtlMs + 1);
    expect(bootstrapIsArmed(deps)).toBe(false);
  });

  it('is not armed once an account exists, even with a live token', async () => {
    // The case mutation 205 exposed. An instance that has been provisioned must
    // not offer the setup page again just because a token is lying around —
    // that is the same hole `bootstrap reissue` refuses to open from the shell.
    issueBootstrapTokenIfNeeded(deps, { readonly: false });
    await provision({});
    expect(bootstrapIsArmed(deps)).toBe(false);
  });

  it('creates the owner, consumes the token, and issues a session', async () => {
    const issued = issueBootstrapTokenIfNeeded(deps, { readonly: false });
    if (issued === undefined) throw new Error('expected a token');
    const result = await bootstrap(deps, {
      token: issued.token,
      username: 'owner',
      password: PASSWORD,
      ip: null,
    });
    expect(result.ok).toBe(true);
    expect(bootstrapIsArmed(deps)).toBe(false);
    expect(result.ok && authenticate(deps, result.token).ok).toBe(true);
  });

  it('gives the owner every capability, as real grants (docs/19 §6.10 step 3)', async () => {
    const issued = issueBootstrapTokenIfNeeded(deps, { readonly: false });
    if (issued === undefined) throw new Error('expected a token');
    const result = await bootstrap(deps, {
      token: issued.token,
      username: 'owner',
      password: PASSWORD,
      ip: null,
    });
    if (!result.ok) throw new Error('expected an account');
    const scope = t.scopes.forGuild(GUILD_A);
    for (const capability of ['killswitch.toggle', 'audit.read', 'config.write'] as const) {
      expect(
        authorize(
          { store: authzStoreFor(scope), guildId: GUILD_A, actor: actorFor(result.accountId) },
          capability,
        ).ok,
      ).toBe(true);
    }
  });

  it('marks the owner as owner, which is not the same as granting anything', async () => {
    const issued = issueBootstrapTokenIfNeeded(deps, { readonly: false });
    if (issued === undefined) throw new Error('expected a token');
    const result = await bootstrap(deps, {
      token: issued.token,
      username: 'owner',
      password: PASSWORD,
      ip: null,
    });
    if (!result.ok) throw new Error('expected an account');
    expect(accountRepo.findAccountById(t.scopes.instance(), result.accountId)?.isOwner).toBe(true);
  });

  it('refuses a token that was never issued', async () => {
    issueBootstrapTokenIfNeeded(deps, { readonly: false });
    const result = await bootstrap(deps, {
      token: 'guessed',
      username: 'owner',
      password: PASSWORD,
      ip: null,
    });
    expect(result).toEqual({ ok: false, reason: 'bad-token' });
  });

  it('refuses an expired token', async () => {
    const issued = issueBootstrapTokenIfNeeded(deps, { readonly: false });
    if (issued === undefined) throw new Error('expected a token');
    at(clock + POLICY.bootstrapTtlMs + 1);
    const result = await bootstrap(deps, {
      token: issued.token,
      username: 'owner',
      password: PASSWORD,
      ip: null,
    });
    expect(result).toEqual({ ok: false, reason: 'bad-token' });
  });

  it('creates exactly one owner when the same token is submitted twice', async () => {
    // The token is consumed before the password is hashed, so the window
    // between the check and the consumption — the window a second owner account
    // fits in — does not exist.
    const issued = issueBootstrapTokenIfNeeded(deps, { readonly: false });
    if (issued === undefined) throw new Error('expected a token');
    const body = { token: issued.token, password: PASSWORD, ip: null };
    const [first, second] = await Promise.all([
      bootstrap(deps, { ...body, username: 'owner' }),
      bootstrap(deps, { ...body, username: 'owner2' }),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(accountRepo.countAccounts(t.scopes.instance())).toBe(1);
  });

  it('refuses once an account exists, even holding a live token', async () => {
    const issued = issueBootstrapTokenIfNeeded(deps, { readonly: false });
    if (issued === undefined) throw new Error('expected a token');
    await provision({});
    const result = await bootstrap(deps, {
      token: issued.token,
      username: 'second',
      password: PASSWORD,
      ip: null,
    });
    expect(result).toEqual({ ok: false, reason: 'already-provisioned' });
  });
});
