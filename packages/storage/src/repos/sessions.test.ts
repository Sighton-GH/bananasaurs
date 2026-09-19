import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope, InstanceScope } from '../scope.js';
import { ReadonlyError } from '../write.js';
import { upsertGuild } from './guilds.js';
import { createAccount, grantGuildAccess } from './accounts.js';
import {
  createSession,
  findSessionByHash,
  listSessionsForAccount,
  revokeAllForAccount,
  revokeSession,
  setSessionGuild,
  touchReauth,
} from './sessions.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const OTHER = 'acct_fedcba9876543210fedcba9876543210';
const HASH = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const HOUR = 3_600_000;

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
  for (const accountId of [ACCOUNT, OTHER]) {
    createAccount(instance, {
      accountId,
      username: accountId,
      passwordHash: 'x',
      isOwner: false,
      now: 1000,
    });
  }
});
afterEach(() => {
  t.close();
});

const open = (scope: GuildScope, hash = HASH, accountId = ACCOUNT, now = 1000): void =>
  createSession(scope, {
    sessionIdHash: hash,
    accountId,
    createdAt: now,
    expiresAt: now + 12 * HOUR,
    reauthAt: now,
    ip: '127.0.0.1',
  });

describe('a session is looked up by its token before the guild is known', () => {
  it('finds the row from an instance scope, and it carries the guild', () => {
    // ADR 0027 and the UNIQUE_BY_DESIGN entry: guild-scoping this lookup would
    // mean trusting a client-supplied guild in order to authenticate.
    open(a);
    expect(findSessionByHash(instance, HASH)?.guildId).toBe(GUILD_A);
  });

  it('returns undefined for a hash that was never issued', () => {
    expect(findSessionByHash(instance, HASH)).toBeUndefined();
  });

  it('stores only the hash — the token never reaches the row', () => {
    open(a);
    const row = findSessionByHash(instance, HASH);
    expect(row?.sessionId).toBe(HASH);
    expect(JSON.stringify(row)).not.toContain('token');
  });

  it('records the absolute expiry the caller computed', () => {
    open(a, HASH, ACCOUNT, 5000);
    const row = findSessionByHash(instance, HASH);
    expect(row?.createdAt).toBe(5000);
    expect(row?.expiresAt).toBe(5000 + 12 * HOUR);
  });

  it('refuses two sessions with the same token hash', () => {
    open(a);
    expect(() => open(a)).toThrow();
  });

  it('refuses a session for an account that does not exist', () => {
    expect(() => open(a, HASH, 'acct_00000000000000000000000000000000')).toThrow();
  });
});

describe('revocation is immediate, which is why sessions are DB-backed', () => {
  it('marks the row revoked and says it did', () => {
    open(a);
    expect(revokeSession(a, { sessionIdHash: HASH, now: 2000 })).toBe(true);
    expect(findSessionByHash(instance, HASH)?.revokedAt).toBe(2000);
  });

  it('reports false for a hash it did not revoke', () => {
    expect(revokeSession(a, { sessionIdHash: HASH, now: 2000 })).toBe(false);
  });

  it('leaves the row readable, so the trail of when someone was logged in survives', () => {
    open(a);
    revokeSession(a, { sessionIdHash: HASH, now: 2000 });
    expect(findSessionByHash(instance, HASH)?.createdAt).toBe(1000);
  });

  it('cannot revoke a session belonging to another guild', () => {
    // The guild predicate, not a check in the handler. A session issued for
    // guild A must not be reachable through a scope for guild B.
    open(a);
    expect(revokeSession(b, { sessionIdHash: HASH, now: 2000 })).toBe(false);
    expect(findSessionByHash(instance, HASH)?.revokedAt).toBeNull();
  });

  it('revokes every session for one account in one call', () => {
    open(a, HASH);
    open(a, HASH_B);
    expect(revokeAllForAccount(a, { accountId: ACCOUNT, now: 2000 })).toBe(2);
    expect(findSessionByHash(instance, HASH)?.revokedAt).toBe(2000);
    expect(findSessionByHash(instance, HASH_B)?.revokedAt).toBe(2000);
  });

  it('does not revoke another account’s sessions', () => {
    open(a, HASH, ACCOUNT);
    open(a, HASH_B, OTHER);
    revokeAllForAccount(a, { accountId: ACCOUNT, now: 2000 });
    expect(findSessionByHash(instance, HASH_B)?.revokedAt).toBeNull();
  });

  it('does not revoke sessions in another guild', () => {
    open(a, HASH, ACCOUNT);
    open(b, HASH_B, ACCOUNT);
    expect(revokeAllForAccount(a, { accountId: ACCOUNT, now: 2000 })).toBe(1);
    expect(findSessionByHash(instance, HASH_B)?.revokedAt).toBeNull();
  });

  it('revokes only live sessions: an already-revoked row keeps its timestamp and is not counted', () => {
    // ADR 0045 Amendment 4 A3-7: a revoke must not rewrite history. The first
    // session ended at 2000 (an ordinary logout); the sweep at 9000 must leave
    // that timestamp alone and report only the session it actually ended.
    open(a, HASH);
    open(a, HASH_B);
    expect(revokeSession(a, { sessionIdHash: HASH, now: 2000 })).toBe(true);
    expect(revokeAllForAccount(a, { accountId: ACCOUNT, now: 9000 })).toBe(1);
    expect(findSessionByHash(instance, HASH)?.revokedAt).toBe(2000);
    expect(findSessionByHash(instance, HASH_B)?.revokedAt).toBe(9000);
  });
});

describe('re-authentication refreshes reauth_at and nothing else (ADR 0029)', () => {
  it('moves reauth_at forward', () => {
    open(a);
    touchReauth(a, { sessionIdHash: HASH, now: 9000 });
    expect(findSessionByHash(instance, HASH)?.reauthAt).toBe(9000);
  });

  it('does not extend the absolute lifetime', () => {
    // The failure this guards: re-authenticating to disable the kill switch
    // silently renewing a session that was about to end. Absolute means
    // absolute (ADR 0029).
    open(a, HASH, ACCOUNT, 1000);
    touchReauth(a, { sessionIdHash: HASH, now: 9000 });
    expect(findSessionByHash(instance, HASH)?.expiresAt).toBe(1000 + 12 * HOUR);
  });

  it('cannot touch a session in another guild', () => {
    open(a);
    touchReauth(b, { sessionIdHash: HASH, now: 9000 });
    expect(findSessionByHash(instance, HASH)?.reauthAt).toBe(1000);
  });
});

describe('listing is guild-scoped', () => {
  it('returns this guild’s sessions only', () => {
    open(a, HASH, ACCOUNT);
    open(b, HASH_B, ACCOUNT);
    expect(listSessionsForAccount(a, ACCOUNT).map((s) => s.sessionId)).toEqual([HASH]);
  });
});

describe('setSessionGuild re-scopes a live session in place (S13-D7)', () => {
  it('moves a live session to the new guild and says it did', () => {
    open(a);
    grantGuildAccess(b, ACCOUNT);
    expect(
      setSessionGuild(a, { sessionIdHash: HASH, accountId: ACCOUNT, guildId: GUILD_B, now: 2000 }),
    ).toBe(true);
    expect(findSessionByHash(instance, HASH)?.guildId).toBe(GUILD_B);
  });

  it('refuses a revoked session, leaving the row where it was', () => {
    open(a);
    grantGuildAccess(b, ACCOUNT);
    revokeSession(a, { sessionIdHash: HASH, now: 2000 });
    expect(
      setSessionGuild(a, { sessionIdHash: HASH, accountId: ACCOUNT, guildId: GUILD_B, now: 3000 }),
    ).toBe(false);
    expect(findSessionByHash(instance, HASH)?.guildId).toBe(GUILD_A);
  });

  it('reports false for a hash that was never issued', () => {
    expect(
      setSessionGuild(a, { sessionIdHash: HASH, accountId: ACCOUNT, guildId: GUILD_B, now: 2000 }),
    ).toBe(false);
  });

  it('refuses a target guild the account cannot reach, in the repository (review I-2)', () => {
    // The route checks this too, but the check belongs here: CLAUDE.md rule 2
    // says enforce guild scope in repository signatures rather than caller
    // discipline. Without it this is a bare partition-move primitive, and the
    // only thing catching a misuse would be `authenticate` re-checking on the
    // next request — a backstop, not a guard.
    open(a);
    // No grantGuildAccess for B at all.
    expect(
      setSessionGuild(a, { sessionIdHash: HASH, accountId: ACCOUNT, guildId: GUILD_B, now: 2000 }),
    ).toBe(false);
    expect(findSessionByHash(instance, HASH)?.guildId).toBe(GUILD_A);
  });

  it('is governed by the current scope in the read direction too', () => {
    // The row lives in guild A, so a scope for guild B must not move it — the
    // same partition rule `revokeSession`'s cross-guild test pins.
    open(a);
    grantGuildAccess(b, ACCOUNT);
    expect(
      setSessionGuild(b, { sessionIdHash: HASH, accountId: ACCOUNT, guildId: GUILD_B, now: 2000 }),
    ).toBe(false);
    expect(findSessionByHash(instance, HASH)?.guildId).toBe(GUILD_A);
  });

  it('after the move the row answers in the new partition and not the old one', () => {
    open(a);
    grantGuildAccess(b, ACCOUNT);
    expect(
      setSessionGuild(a, { sessionIdHash: HASH, accountId: ACCOUNT, guildId: GUILD_B, now: 2000 }),
    ).toBe(true);
    expect(listSessionsForAccount(b, ACCOUNT).map((s) => s.sessionId)).toEqual([HASH]);
    expect(listSessionsForAccount(a, ACCOUNT)).toEqual([]);
  });

  it('moves back just as well — both directions of the partition boundary', () => {
    open(a);
    grantGuildAccess(a, ACCOUNT);
    grantGuildAccess(b, ACCOUNT);
    expect(
      setSessionGuild(a, { sessionIdHash: HASH, accountId: ACCOUNT, guildId: GUILD_B, now: 2000 }),
    ).toBe(true);
    expect(
      setSessionGuild(b, { sessionIdHash: HASH, accountId: ACCOUNT, guildId: GUILD_A, now: 3000 }),
    ).toBe(true);
    expect(findSessionByHash(instance, HASH)?.guildId).toBe(GUILD_A);
  });

  it('keeps the token hash, so the cookie and CSRF derivation survive the move', () => {
    open(a);
    grantGuildAccess(b, ACCOUNT);
    setSessionGuild(a, { sessionIdHash: HASH, accountId: ACCOUNT, guildId: GUILD_B, now: 2000 });
    expect(findSessionByHash(instance, HASH)?.sessionId).toBe(HASH);
  });
});

describe('readonly mode refuses every session write (ADR 0029)', () => {
  it('refuses createSession, which is why login is unavailable read-only', () => {
    const ro = t.readonlyScopes.forGuild(GUILD_A);
    expect(() => open(ro)).toThrow(ReadonlyError);
  });

  it('refuses revokeSession', () => {
    open(a);
    const ro = t.readonlyScopes.forGuild(GUILD_A);
    expect(() => revokeSession(ro, { sessionIdHash: HASH, now: 2000 })).toThrow(ReadonlyError);
  });

  it('refuses setSessionGuild — moving a session is a write', () => {
    open(a);
    const ro = t.readonlyScopes.forGuild(GUILD_A);
    expect(() =>
      setSessionGuild(ro, { sessionIdHash: HASH, accountId: ACCOUNT, guildId: GUILD_B, now: 2000 }),
    ).toThrow(ReadonlyError);
  });
  it('still allows the lookup, so an existing session can still read', () => {
    open(a);
    expect(findSessionByHash(t.readonlyScopes.instance(), HASH)?.guildId).toBe(GUILD_A);
  });
});
