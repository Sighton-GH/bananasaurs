import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAccountId, parseGuildId, CAPABILITIES } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope, InstanceScope } from '../scope.js';
import { ReadonlyError } from '../write.js';
import { upsertGuild } from './guilds.js';
import { authzStoreFor, grantAccountCapability, listAccountCapabilities } from './authz.js';
import {
  clearFailedAttempts,
  consumeBootstrapToken,
  countAccounts,
  countEnabledOwners,
  countUnconsumedBootstrapTokens,
  createAccount,
  deleteAccount,
  findAccountById,
  findAccountByUsername,
  getPasswordSealed,
  grantAllCapabilities,
  grantGuildAccess,
  hasGuildAccess,
  hasUsableBootstrapToken,
  issueBootstrapToken,
  listAccessibleGuilds,
  listAccounts,
  recordFailedAttempt,
  revokeGuildAccess,
  setAccountDisabled,
  setPasswordHash,
  setPasswordSealed,
} from './accounts.js';
import {
  createAuthorizationCode,
  createClient,
  createToken,
  findAuthorizationCode,
  findClient,
  findTokenById,
  revokeToken,
} from './oauth.js';
import { createSession, findSessionByHash } from './sessions.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const ACCOUNT_ID = parseAccountId(ACCOUNT);
const OTHER = 'acct_fedcba9876543210fedcba9876543210';

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;
let instance: InstanceScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  instance = t.scopes.instance();
  upsertGuild(a, { name: 'guild a', now: 1000 });
  upsertGuild(b, { name: 'guild b', now: 1000 });
});
afterEach(() => {
  t.close();
});

const seedAccount = (accountId = ACCOUNT, username = 'owner'): void =>
  createAccount(instance, {
    accountId,
    username,
    passwordHash: '$argon2id$fake',
    isOwner: true,
    now: 1000,
  });

describe('accounts are instance-level (ADR 0012, ADR 0027)', () => {
  it('counts zero on a fresh database, which is what /bootstrap keys off', () => {
    expect(countAccounts(instance)).toBe(0);
  });

  it('counts one after the bootstrap account is created', () => {
    seedAccount();
    expect(countAccounts(instance)).toBe(1);
  });

  it('finds an account by username', () => {
    seedAccount();
    expect(findAccountByUsername(instance, 'owner')?.accountId).toBe(ACCOUNT);
  });

  it('returns undefined for an unknown username rather than throwing', () => {
    expect(findAccountByUsername(instance, 'nobody')).toBeUndefined();
  });

  it('refuses a duplicate username', () => {
    seedAccount();
    expect(() => seedAccount(OTHER, 'owner')).toThrow();
  });

  it('records the password hash verbatim and nothing else', () => {
    seedAccount();
    const row = findAccountById(instance, ACCOUNT);
    expect(row?.passwordHash).toBe('$argon2id$fake');
    expect(row?.isOwner).toBe(true);
    expect(row?.disabled).toBe(false);
    expect(row?.failedAttempts).toBe(0);
    expect(row?.lockedUntil).toBeNull();
  });

  it('replaces the hash on a password change', () => {
    seedAccount();
    setPasswordHash(instance, { accountId: ACCOUNT, passwordHash: '$argon2id$new' });
    expect(findAccountById(instance, ACCOUNT)?.passwordHash).toBe('$argon2id$new');
  });
});

describe('password_sealed (ADR 0070)', () => {
  it('is null on a freshly created account', () => {
    seedAccount();
    expect(getPasswordSealed(instance, ACCOUNT)).toBeNull();
    expect(findAccountById(instance, ACCOUNT)?.passwordSealed).toBeNull();
  });

  it('stores and reads back the sealed value verbatim', () => {
    seedAccount();
    setPasswordSealed(instance, ACCOUNT, 'sealed-ciphertext');
    expect(getPasswordSealed(instance, ACCOUNT)).toBe('sealed-ciphertext');
    expect(findAccountById(instance, ACCOUNT)?.passwordSealed).toBe('sealed-ciphertext');
  });

  it('clears the sealed value back to null', () => {
    seedAccount();
    setPasswordSealed(instance, ACCOUNT, 'sealed-ciphertext');
    setPasswordSealed(instance, ACCOUNT, null);
    expect(getPasswordSealed(instance, ACCOUNT)).toBeNull();
  });

  it('reads null for an unknown account rather than throwing', () => {
    expect(getPasswordSealed(instance, 'acct_missing')).toBeNull();
  });
});

describe('lockout (ADR 0029)', () => {
  beforeEach(() => {
    seedAccount();
  });

  const fail = (now: number) =>
    recordFailedAttempt(instance, { accountId: ACCOUNT, now, maxAttempts: 5, lockoutMs: 900_000 });

  it('increments the counter', () => {
    expect(fail(2000).attempts).toBe(1);
    expect(fail(2001).attempts).toBe(2);
  });

  it('does not lock before the threshold', () => {
    for (let i = 0; i < 4; i++) fail(2000 + i);
    expect(findAccountById(instance, ACCOUNT)?.lockedUntil).toBeNull();
  });

  it('locks exactly at the threshold, for the configured window', () => {
    for (let i = 0; i < 5; i++) fail(2000);
    expect(findAccountById(instance, ACCOUNT)?.lockedUntil).toBe(2000 + 900_000);
  });

  it('uses the injected clock, not the wall clock', () => {
    for (let i = 0; i < 5; i++) fail(1_700_000_000_000);
    expect(findAccountById(instance, ACCOUNT)?.lockedUntil).toBe(1_700_000_000_000 + 900_000);
  });

  it('clears the counter and the lockout on a correct password', () => {
    for (let i = 0; i < 5; i++) fail(2000);
    clearFailedAttempts(instance, ACCOUNT);
    const row = findAccountById(instance, ACCOUNT);
    expect(row?.failedAttempts).toBe(0);
    expect(row?.lockedUntil).toBeNull();
  });

  it('counts attempts per account, not globally', () => {
    seedAccount(OTHER, 'second');
    for (let i = 0; i < 5; i++) fail(2000);
    expect(findAccountById(instance, OTHER)?.failedAttempts).toBe(0);
    expect(findAccountById(instance, OTHER)?.lockedUntil).toBeNull();
  });
});

describe('guild access is a separate grant from capability (ADR 0012, ADR 0028)', () => {
  beforeEach(() => {
    seedAccount();
  });

  it('grants nothing by default', () => {
    expect(listAccessibleGuilds(instance, ACCOUNT)).toEqual([]);
    expect(hasGuildAccess(a, ACCOUNT)).toBe(false);
  });

  it('grants access to one guild without granting another', () => {
    grantGuildAccess(a, ACCOUNT);
    expect(hasGuildAccess(a, ACCOUNT)).toBe(true);
    expect(hasGuildAccess(b, ACCOUNT)).toBe(false);
  });

  it('is idempotent, because a replayed provisioning must not fail', () => {
    grantGuildAccess(a, ACCOUNT);
    grantGuildAccess(a, ACCOUNT);
    expect(listAccessibleGuilds(instance, ACCOUNT)).toEqual([GUILD_A]);
  });

  it('refuses a capability grant for a guild the account cannot reach', () => {
    // The composite foreign key, not a check in application code. Capability
    // without reachability is not representable (ADR 0028).
    expect(() =>
      grantAccountCapability(a, {
        accountId: ACCOUNT,
        capability: 'killswitch.toggle',
        grantedBy: 'test',
        now: 1000,
      }),
    ).toThrow();
  });

  it('cascades capabilities away when access is revoked', () => {
    grantGuildAccess(a, ACCOUNT);
    grantAccountCapability(a, {
      accountId: ACCOUNT,
      capability: 'killswitch.toggle',
      grantedBy: 'test',
      now: 1000,
    });
    expect(listAccountCapabilities(a, ACCOUNT)).toEqual(['killswitch.toggle']);

    revokeGuildAccess(a, ACCOUNT);
    expect(listAccountCapabilities(a, ACCOUNT)).toEqual([]);
  });

  it('does not revoke access in another guild', () => {
    grantGuildAccess(a, ACCOUNT);
    grantGuildAccess(b, ACCOUNT);
    revokeGuildAccess(a, ACCOUNT);
    expect(listAccessibleGuilds(instance, ACCOUNT)).toEqual([GUILD_B]);
  });

  it('gives the bootstrap owner every capability, in one guild only', () => {
    grantGuildAccess(a, ACCOUNT);
    grantAllCapabilities(a, {
      accountId: ACCOUNT,
      capabilities: CAPABILITIES,
      grantedBy: 'bootstrap',
      now: 1000,
    });
    expect(listAccountCapabilities(a, ACCOUNT).sort()).toEqual([...CAPABILITIES].sort());
    expect(listAccountCapabilities(b, ACCOUNT)).toEqual([]);
  });
});

describe('authorize() reaches account grants through the same store (ADR 0028)', () => {
  beforeEach(() => {
    seedAccount();
    grantGuildAccess(a, ACCOUNT);
  });

  it('says no before any grant', () => {
    expect(
      authzStoreFor(a).hasGrant('killswitch.toggle', [
        { principalType: 'account', principalId: ACCOUNT_ID },
      ]),
    ).toBe(false);
  });

  it('says yes after the grant', () => {
    grantAccountCapability(a, {
      accountId: ACCOUNT,
      capability: 'killswitch.toggle',
      grantedBy: 'test',
      now: 1000,
    });
    expect(
      authzStoreFor(a).hasGrant('killswitch.toggle', [
        { principalType: 'account', principalId: ACCOUNT_ID },
      ]),
    ).toBe(true);
  });

  it('does not leak a grant into another guild', () => {
    grantGuildAccess(b, ACCOUNT);
    grantAccountCapability(a, {
      accountId: ACCOUNT,
      capability: 'killswitch.toggle',
      grantedBy: 'test',
      now: 1000,
    });
    expect(
      authzStoreFor(b).hasGrant('killswitch.toggle', [
        { principalType: 'account', principalId: ACCOUNT_ID },
      ]),
    ).toBe(false);
  });

  it('does not answer one capability with another', () => {
    grantAccountCapability(a, {
      accountId: ACCOUNT,
      capability: 'audit.read',
      grantedBy: 'test',
      now: 1000,
    });
    expect(
      authzStoreFor(a).hasGrant('killswitch.toggle', [
        { principalType: 'account', principalId: ACCOUNT_ID },
      ]),
    ).toBe(false);
  });

  it('does not answer one account with another account’s grant', () => {
    seedAccount(OTHER, 'second');
    grantGuildAccess(a, OTHER);
    grantAccountCapability(a, {
      accountId: OTHER,
      capability: 'killswitch.toggle',
      grantedBy: 'test',
      now: 1000,
    });
    expect(
      authzStoreFor(a).hasGrant('killswitch.toggle', [
        { principalType: 'account', principalId: ACCOUNT_ID },
      ]),
    ).toBe(false);
  });
});

describe('bootstrap tokens (docs/19 §6.10)', () => {
  it('reports none on a fresh database', () => {
    expect(hasUsableBootstrapToken(instance, 1000)).toBe(false);
  });

  it('reports one after issuance, and expires it on the injected clock', () => {
    issueBootstrapToken(instance, { tokenHash: 'h', now: 1000, ttlMs: 900_000 });
    expect(hasUsableBootstrapToken(instance, 1000 + 899_999)).toBe(true);
    expect(hasUsableBootstrapToken(instance, 1000 + 900_001)).toBe(false);
  });

  it('records the expiry the caller asked for', () => {
    const row = issueBootstrapToken(instance, { tokenHash: 'h', now: 1000, ttlMs: 900_000 });
    expect(row.expiresAt).toBe(901_000);
    expect(row.consumedAt).toBeNull();
  });

  it('replaces an earlier unconsumed token rather than adding a second', () => {
    issueBootstrapToken(instance, { tokenHash: 'first', now: 1000, ttlMs: 900_000 });
    issueBootstrapToken(instance, { tokenHash: 'second', now: 2000, ttlMs: 900_000 });
    expect(countUnconsumedBootstrapTokens(instance, 2000)).toBe(1);
    expect(consumeBootstrapToken(instance, { tokenHash: 'first', now: 2000 })).toBe(false);
    expect(consumeBootstrapToken(instance, { tokenHash: 'second', now: 2000 })).toBe(true);
  });

  it('consumes a valid token exactly once', () => {
    issueBootstrapToken(instance, { tokenHash: 'h', now: 1000, ttlMs: 900_000 });
    expect(consumeBootstrapToken(instance, { tokenHash: 'h', now: 2000 })).toBe(true);
    expect(consumeBootstrapToken(instance, { tokenHash: 'h', now: 2001 })).toBe(false);
  });

  it('refuses a token that has expired', () => {
    issueBootstrapToken(instance, { tokenHash: 'h', now: 1000, ttlMs: 900_000 });
    expect(consumeBootstrapToken(instance, { tokenHash: 'h', now: 1000 + 900_001 })).toBe(false);
  });

  it('refuses a hash that was never issued', () => {
    issueBootstrapToken(instance, { tokenHash: 'h', now: 1000, ttlMs: 900_000 });
    expect(consumeBootstrapToken(instance, { tokenHash: 'guessed', now: 2000 })).toBe(false);
  });

  it('stops reporting a usable token once one is consumed', () => {
    issueBootstrapToken(instance, { tokenHash: 'h', now: 1000, ttlMs: 900_000 });
    consumeBootstrapToken(instance, { tokenHash: 'h', now: 2000 });
    expect(hasUsableBootstrapToken(instance, 2000)).toBe(false);
  });
});

describe('setAccountDisabled (ADR 0045 Amendment 3, A3-1)', () => {
  it('flips disabled on and back off, as seen by findAccountById', () => {
    seedAccount();
    expect(setAccountDisabled(instance, { accountId: ACCOUNT, disabled: true })).toBe(true);
    expect(findAccountById(instance, ACCOUNT)?.disabled).toBe(true);
    expect(setAccountDisabled(instance, { accountId: ACCOUNT, disabled: false })).toBe(true);
    expect(findAccountById(instance, ACCOUNT)?.disabled).toBe(false);
  });

  it('returns false for an unknown id and writes nothing', () => {
    seedAccount();
    expect(setAccountDisabled(instance, { accountId: 'acct_missing', disabled: true })).toBe(false);
    expect(countAccounts(instance)).toBe(1);
    expect(findAccountById(instance, ACCOUNT)?.disabled).toBe(false);
  });

  it('leaves failedAttempts and lockedUntil exactly as the lockout left them', () => {
    seedAccount();
    recordFailedAttempt(instance, {
      accountId: ACCOUNT,
      now: 2000,
      maxAttempts: 5,
      lockoutMs: 900_000,
    });
    recordFailedAttempt(instance, {
      accountId: ACCOUNT,
      now: 2001,
      maxAttempts: 5,
      lockoutMs: 900_000,
    });
    const before = findAccountById(instance, ACCOUNT);
    setAccountDisabled(instance, { accountId: ACCOUNT, disabled: true });
    setAccountDisabled(instance, { accountId: ACCOUNT, disabled: false });
    const after = findAccountById(instance, ACCOUNT);
    expect(after?.failedAttempts).toBe(before?.failedAttempts);
    expect(after?.lockedUntil).toBe(before?.lockedUntil);
  });
});

describe('deleteAccount (ADR 0045 D6)', () => {
  const seedClient = (clientId = 'client-1'): void =>
    createClient(instance, {
      clientId,
      clientName: `name of ${clientId}`,
      redirectUris: ['https://example.test/cb'],
      createdAt: 1000,
      createdByAccountId: null,
      registrationSource: 'dynamic',
    });

  const seedToken = (
    tokenId: string,
    accountId: string,
    kind: 'access' | 'refresh' = 'access',
  ): void =>
    createToken(instance, {
      tokenId,
      tokenHash: `hash-${tokenId}`,
      kind,
      clientId: 'client-1',
      accountId,
      scopes: ['bananasaurs:read'],
      createdAt: 1000,
      expiresAt: 100_000,
      parentTokenId: null,
      issuedFromCodeHash: `code-for-${tokenId}`,
    });

  const seedCode = (codeHash: string, accountId: string): void =>
    createAuthorizationCode(instance, {
      codeHash,
      clientId: 'client-1',
      accountId,
      scopes: ['bananasaurs:read'],
      codeChallenge: 'challenge',
      redirectUri: 'https://example.test/cb',
      createdAt: 1000,
      expiresAt: 60_000,
    });

  it('removes the row, so findAccountById is undefined afterwards', () => {
    seedAccount();
    const result = deleteAccount(instance, { accountId: ACCOUNT, now: 5000 });
    expect(result.deleted).toBe(true);
    expect(findAccountById(instance, ACCOUNT)).toBeUndefined();
  });

  it('removes the sealed password with the row (ADR 0070)', () => {
    seedAccount();
    setPasswordSealed(instance, ACCOUNT, 'sealed-ciphertext');
    deleteAccount(instance, { accountId: ACCOUNT, now: 5000 });
    expect(findAccountById(instance, ACCOUNT)).toBeUndefined();
    expect(getPasswordSealed(instance, ACCOUNT)).toBeNull();
  });

  it('revokes live tokens, counts them, and never rewrites an earlier revocation', () => {
    seedAccount();
    seedClient();
    seedToken('live-access', ACCOUNT, 'access');
    seedToken('live-refresh', ACCOUNT, 'refresh');
    seedToken('already-revoked', ACCOUNT, 'access');
    revokeToken(instance, 'already-revoked', 2000);
    const result = deleteAccount(instance, { accountId: ACCOUNT, now: 5000 });
    expect(result.tokensRevoked).toBe(2);
    expect(findTokenById(instance, 'live-access')?.revokedAt).toBe(5000);
    expect(findTokenById(instance, 'live-refresh')?.revokedAt).toBe(5000);
    for (const tokenId of ['live-access', 'live-refresh', 'already-revoked']) {
      expect(findTokenById(instance, tokenId)?.revokedAt).not.toBeNull();
    }
    expect(findTokenById(instance, 'already-revoked')?.revokedAt).toBe(2000);
  });

  it('leaves another account’s tokens live', () => {
    seedAccount();
    seedAccount(OTHER, 'second');
    seedClient();
    seedToken('token-mine', ACCOUNT);
    seedToken('token-theirs', OTHER);
    deleteAccount(instance, { accountId: ACCOUNT, now: 5000 });
    expect(findTokenById(instance, 'token-mine')?.revokedAt).toBe(5000);
    expect(findTokenById(instance, 'token-theirs')?.revokedAt).toBeNull();
  });

  it('deletes the consenting account’s codes and keeps the other account’s', () => {
    seedAccount();
    seedAccount(OTHER, 'second');
    seedClient();
    seedCode('code-mine', ACCOUNT);
    seedCode('code-theirs', OTHER);
    const result = deleteAccount(instance, { accountId: ACCOUNT, now: 5000 });
    expect(result.codesDeleted).toBe(1);
    expect(findAuthorizationCode(instance, 'code-mine')).toBeUndefined();
    expect(findAuthorizationCode(instance, 'code-theirs')).not.toBeUndefined();
  });

  it('cascades guild access, capabilities and sessions but keeps the other account’s rows', () => {
    seedAccount();
    seedAccount(OTHER, 'second');
    for (const [scope, sessionHash] of [
      [a, 'sess-acct-a'],
      [b, 'sess-acct-b'],
    ] as const) {
      grantGuildAccess(scope, ACCOUNT);
      grantAccountCapability(scope, {
        accountId: ACCOUNT,
        capability: 'killswitch.toggle',
        grantedBy: 'test',
        now: 1000,
      });
      createSession(scope, {
        sessionIdHash: sessionHash,
        accountId: ACCOUNT,
        createdAt: 1000,
        expiresAt: 100_000,
        reauthAt: 1000,
        ip: '127.0.0.1',
      });
    }
    for (const [scope, sessionHash] of [
      [a, 'sess-other-a'],
      [b, 'sess-other-b'],
    ] as const) {
      grantGuildAccess(scope, OTHER);
      grantAccountCapability(scope, {
        accountId: OTHER,
        capability: 'killswitch.toggle',
        grantedBy: 'test',
        now: 1000,
      });
      createSession(scope, {
        sessionIdHash: sessionHash,
        accountId: OTHER,
        createdAt: 1000,
        expiresAt: 100_000,
        reauthAt: 1000,
        ip: '127.0.0.1',
      });
    }
    deleteAccount(instance, { accountId: ACCOUNT, now: 5000 });
    expect(listAccessibleGuilds(instance, ACCOUNT)).toEqual([]);
    expect(listAccountCapabilities(a, ACCOUNT)).toEqual([]);
    expect(listAccountCapabilities(b, ACCOUNT)).toEqual([]);
    expect(findSessionByHash(instance, 'sess-acct-a')).toBeUndefined();
    expect(findSessionByHash(instance, 'sess-acct-b')).toBeUndefined();
    expect(listAccessibleGuilds(instance, OTHER).sort()).toEqual([GUILD_A, GUILD_B].sort());
    expect(listAccountCapabilities(a, OTHER)).toEqual(['killswitch.toggle']);
    expect(listAccountCapabilities(b, OTHER)).toEqual(['killswitch.toggle']);
    expect(findSessionByHash(instance, 'sess-other-a')).not.toBeUndefined();
    expect(findSessionByHash(instance, 'sess-other-b')).not.toBeUndefined();
  });

  it('reports zeros for an unknown id', () => {
    expect(deleteAccount(instance, { accountId: 'acct_missing', now: 5000 })).toEqual({
      deleted: false,
      tokensRevoked: 0,
      codesDeleted: 0,
    });
  });

  it('keeps an OAuth client the account registered', () => {
    seedAccount();
    createClient(instance, {
      clientId: 'client-1',
      clientName: 'mine',
      redirectUris: ['https://example.test/cb'],
      createdAt: 1000,
      createdByAccountId: ACCOUNT,
      registrationSource: 'cli',
    });
    deleteAccount(instance, { accountId: ACCOUNT, now: 5000 });
    expect(findClient(instance, 'client-1')?.createdByAccountId).toBe(ACCOUNT);
  });
});

describe('countEnabledOwners', () => {
  const THIRD = 'acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  it('counts owners that are not disabled, ignoring disablement and deletion', () => {
    createAccount(instance, {
      accountId: ACCOUNT,
      username: 'owner-one',
      passwordHash: '$argon2id$fake',
      isOwner: true,
      now: 1000,
    });
    createAccount(instance, {
      accountId: OTHER,
      username: 'owner-two',
      passwordHash: '$argon2id$fake',
      isOwner: true,
      now: 1000,
    });
    createAccount(instance, {
      accountId: THIRD,
      username: 'not-owner',
      passwordHash: '$argon2id$fake',
      isOwner: false,
      now: 1000,
    });
    expect(countEnabledOwners(instance)).toBe(2);
    setAccountDisabled(instance, { accountId: ACCOUNT, disabled: true });
    expect(countEnabledOwners(instance)).toBe(1);
    deleteAccount(instance, { accountId: OTHER, now: 5000 });
    expect(countEnabledOwners(instance)).toBe(0);
  });
});

describe('listAccounts', () => {
  it('returns every account oldest first, carrying the hash and no plaintext', () => {
    createAccount(instance, {
      accountId: ACCOUNT,
      username: 'third-created',
      passwordHash: '$argon2id$third',
      isOwner: false,
      now: 3000,
    });
    createAccount(instance, {
      accountId: OTHER,
      username: 'first-created',
      passwordHash: '$argon2id$first',
      isOwner: true,
      now: 1000,
    });
    createAccount(instance, {
      accountId: 'acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      username: 'second-created',
      passwordHash: '$argon2id$second',
      isOwner: false,
      now: 2000,
    });
    const rows = listAccounts(instance);
    expect(rows.map((r) => r.username)).toEqual([
      'first-created',
      'second-created',
      'third-created',
    ]);
    expect(rows.map((r) => r.passwordHash)).toEqual([
      '$argon2id$first',
      '$argon2id$second',
      '$argon2id$third',
    ]);
    for (const row of rows) {
      expect(row).not.toHaveProperty('password');
    }
    expect(JSON.stringify(rows)).not.toContain('hunter2');
  });
});

describe('readonly mode refuses every account write (ADR 0029)', () => {
  it('refuses createAccount', () => {
    const ro = t.readonlyScopes.instance();
    expect(() =>
      createAccount(ro, {
        accountId: ACCOUNT,
        username: 'owner',
        passwordHash: 'x',
        isOwner: true,
        now: 1000,
      }),
    ).toThrow(ReadonlyError);
  });

  it('refuses issueBootstrapToken, which is what runs at startup', () => {
    // Slice 13d found the daemon could not start read-only. The bootstrap token
    // generator writes at startup, so it is the same class of bug: the caller
    // must skip issuance under readonly rather than let this throw upward.
    const ro = t.readonlyScopes.instance();
    expect(() => issueBootstrapToken(ro, { tokenHash: 'h', now: 1000, ttlMs: 1 })).toThrow(
      ReadonlyError,
    );
  });

  it('refuses recordFailedAttempt, which is why login is unavailable read-only', () => {
    seedAccount();
    const ro = t.readonlyScopes.instance();
    expect(() =>
      recordFailedAttempt(ro, {
        accountId: ACCOUNT,
        now: 1000,
        maxAttempts: 5,
        lockoutMs: 900_000,
      }),
    ).toThrow(ReadonlyError);
  });

  it('still allows every account read', () => {
    seedAccount();
    const ro = t.readonlyScopes.instance();
    expect(countAccounts(ro)).toBe(1);
    expect(findAccountByUsername(ro, 'owner')?.accountId).toBe(ACCOUNT);
  });
});
