import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { InstanceScope } from '../scope.js';
import {
  consumePendingAuthorization,
  createAuthorizationCode,
  createClient,
  createPendingAuthorization,
  createToken,
  deleteClient,
  findAuthorizationCode,
  findClient,
  findTokenByHash,
  findTokenById,
  listClients,
  listTokens,
  markAuthorizationCodeUsed,
  purgeExpired,
  revokeToken,
  revokeTokenChain,
  revokeTokensForClient,
  revokeTokensFromCode,
  rotateRefreshToken,
  touchToken,
} from './oauth.js';

let t: MigratedTestDatabase;
let instance: InstanceScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  instance = t.scopes.instance();
});
afterEach(() => {
  t.close();
});

const seedClient = (clientId = 'client-1', createdAt = 1000): void =>
  createClient(instance, {
    clientId,
    clientName: `name of ${clientId}`,
    redirectUris: ['https://example.test/cb', 'http://127.0.0.1:8976/cb'],
    createdAt,
    createdByAccountId: null,
    registrationSource: 'dynamic',
  });

const seedCode = (codeHash = 'code-1', clientId = 'client-1', expiresAt = 60_000): void =>
  createAuthorizationCode(instance, {
    codeHash,
    clientId,
    accountId: 'acct-1',
    scopes: ['bananasaurs:read'],
    codeChallenge: 'challenge-1',
    redirectUri: 'https://example.test/cb',
    createdAt: 1000,
    expiresAt,
  });

/** One access + one refresh token minted from the same code. */
const mintPair = (
  codeHash: string,
  suffix: string,
  overrides?: { clientId?: string; createdAt?: number; expiresAt?: number },
): { accessId: string; refreshId: string } => {
  const accessId = `access-${suffix}`;
  const refreshId = `refresh-${suffix}`;
  const clientId = overrides?.clientId ?? 'client-1';
  const createdAt = overrides?.createdAt ?? 1000;
  const expiresAt = overrides?.expiresAt ?? 100_000;
  createToken(instance, {
    tokenId: accessId,
    tokenHash: `hash-${accessId}`,
    kind: 'access',
    clientId,
    accountId: 'acct-1',
    scopes: ['bananasaurs:read'],
    createdAt,
    expiresAt,
    parentTokenId: null,
    issuedFromCodeHash: codeHash,
  });
  createToken(instance, {
    tokenId: refreshId,
    tokenHash: `hash-${refreshId}`,
    kind: 'refresh',
    clientId,
    accountId: 'acct-1',
    scopes: ['bananasaurs:read'],
    createdAt,
    expiresAt,
    parentTokenId: null,
    issuedFromCodeHash: codeHash,
  });
  return { accessId, refreshId };
};

describe('clients', () => {
  it('round-trips a client with two redirect URIs', () => {
    seedClient();
    expect(findClient(instance, 'client-1')).toEqual({
      clientId: 'client-1',
      clientName: 'name of client-1',
      redirectUris: ['https://example.test/cb', 'http://127.0.0.1:8976/cb'],
      createdAt: 1000,
      createdByAccountId: null,
      registrationSource: 'dynamic',
    });
  });

  it('returns undefined for an unknown client', () => {
    expect(findClient(instance, 'nope')).toBeUndefined();
  });

  it('lists clients ordered by createdAt', () => {
    seedClient('client-b', 2000);
    seedClient('client-a', 1000);
    seedClient('client-c', 3000);
    expect(listClients(instance).map((c) => c.clientId)).toEqual([
      'client-a',
      'client-b',
      'client-c',
    ]);
  });

  it('throws on a malformed redirect_uris row instead of yielding it silently', () => {
    // Written through the raw handle: the repository never writes this shape.
    seedClient();
    t.raw
      .prepare(`UPDATE oauth_clients SET redirect_uris = 'not json' WHERE client_id = ?`)
      .run('client-1');
    expect(() => findClient(instance, 'client-1')).toThrow();
  });

  it('deleteClient revokes both tokens and removes the client, returning 2', () => {
    seedClient();
    const { accessId, refreshId } = mintPair('code-1', 'one');
    const now = 5000;
    expect(deleteClient(instance, 'client-1', now)).toBe(2);
    expect(findClient(instance, 'client-1')).toBeUndefined();
    expect(findTokenById(instance, accessId)?.revokedAt).toBe(now);
    expect(findTokenById(instance, refreshId)?.revokedAt).toBe(now);
  });

  it('deleteClient leaves another client and its tokens untouched', () => {
    seedClient('client-1');
    seedClient('client-2');
    mintPair('code-1', 'one', { clientId: 'client-1' });
    const other = mintPair('code-2', 'two', { clientId: 'client-2' });
    expect(deleteClient(instance, 'client-1', 5000)).toBe(2);
    expect(findClient(instance, 'client-2')?.clientId).toBe('client-2');
    expect(findTokenById(instance, other.accessId)?.revokedAt).toBeNull();
    expect(findTokenById(instance, other.refreshId)?.revokedAt).toBeNull();
  });

  it('deleteClient on an unknown client returns 0 and deletes nothing', () => {
    seedClient('client-1');
    mintPair('code-1', 'one', { clientId: 'client-1' });
    expect(deleteClient(instance, 'nope', 5000)).toBe(0);
    expect(findClient(instance, 'client-1')?.clientId).toBe('client-1');
    expect(listTokens(instance)).toHaveLength(2);
  });
});

describe('pending authorizations', () => {
  const seedPending = (requestId = 'req-1', expiresAt = 60_000): void =>
    createPendingAuthorization(instance, {
      requestId,
      nonceHash: 'nonce-hash-1',
      clientId: 'client-1',
      redirectUri: 'https://example.test/cb',
      scopes: ['bananasaurs:read', 'bananasaurs:send'],
      codeChallenge: 'challenge-1',
      state: 'state-1',
      createdAt: 1000,
      expiresAt,
    });

  it('consumes once: first call returns the row, second returns undefined', () => {
    seedPending();
    expect(consumePendingAuthorization(instance, 'req-1', 2000)).toEqual({
      requestId: 'req-1',
      nonceHash: 'nonce-hash-1',
      clientId: 'client-1',
      redirectUri: 'https://example.test/cb',
      scopes: ['bananasaurs:read', 'bananasaurs:send'],
      codeChallenge: 'challenge-1',
      state: 'state-1',
      expiresAt: 60_000,
    });
    expect(consumePendingAuthorization(instance, 'req-1', 2000)).toBeUndefined();
  });

  it('refuses an expired row and leaves consumed_at NULL', () => {
    seedPending('req-exp', 1000);
    expect(consumePendingAuthorization(instance, 'req-exp', 2000)).toBeUndefined();
    const row = t.raw
      .prepare(
        `SELECT consumed_at AS consumedAt FROM oauth_pending_authorizations WHERE request_id = ?`,
      )
      .get('req-exp') as { consumedAt: number | null } | undefined;
    expect(row?.consumedAt).toBeNull();
  });

  it('returns undefined for an unknown requestId', () => {
    expect(consumePendingAuthorization(instance, 'nope', 2000)).toBeUndefined();
  });
});

describe('authorization codes', () => {
  it('reads without consuming: a used code still reports usedAt', () => {
    seedClient();
    seedCode();
    expect(markAuthorizationCodeUsed(instance, 'code-1', 2000)).toBe(1);
    expect(findAuthorizationCode(instance, 'code-1')?.usedAt).toBe(2000);
  });

  it('markAuthorizationCodeUsed returns 1 then 0', () => {
    seedClient();
    seedCode();
    expect(markAuthorizationCodeUsed(instance, 'code-1', 2000)).toBe(1);
    expect(markAuthorizationCodeUsed(instance, 'code-1', 3000)).toBe(0);
    // The first mark wins: usedAt is untouched by the replay.
    expect(findAuthorizationCode(instance, 'code-1')?.usedAt).toBe(2000);
  });

  it('markAuthorizationCodeUsed on an unknown hash returns 0', () => {
    expect(markAuthorizationCodeUsed(instance, 'nope', 2000)).toBe(0);
  });

  it('findAuthorizationCode returns undefined for an unknown hash', () => {
    expect(findAuthorizationCode(instance, 'nope')).toBeUndefined();
  });
});

describe('tokens', () => {
  beforeEach(() => {
    seedClient();
  });

  it('findTokenByHash returns a revoked row with revokedAt set, not hidden', () => {
    const { accessId } = mintPair('code-1', 'one');
    const row = findTokenById(instance, accessId);
    expect(row).toBeDefined();
    expect(revokeToken(instance, accessId, 5000)).toBe(1);
    const byHash = findTokenByHash(instance, `hash-${accessId}`);
    expect(byHash?.tokenId).toBe(accessId);
    expect(byHash?.revokedAt).toBe(5000);
  });

  it('revokeToken returns 1, then 0, and 0 for unknown', () => {
    const { accessId } = mintPair('code-1', 'one');
    expect(revokeToken(instance, accessId, 5000)).toBe(1);
    expect(revokeToken(instance, accessId, 6000)).toBe(0);
    expect(revokeToken(instance, 'nope', 5000)).toBe(0);
  });

  it('revokeTokensFromCode revokes the access and refresh minted from one code', () => {
    const { accessId, refreshId } = mintPair('code-1', 'one');
    expect(revokeTokensFromCode(instance, 'code-1', 5000)).toBe(2);
    expect(findTokenById(instance, accessId)?.revokedAt).toBe(5000);
    expect(findTokenById(instance, refreshId)?.revokedAt).toBe(5000);
    expect(revokeTokensFromCode(instance, 'code-1', 6000)).toBe(0);
  });

  it('revokeTokensForClient revokes every token of the client and leaves others alone', () => {
    seedClient('client-2');
    mintPair('code-1', 'one', { clientId: 'client-1' });
    const other = mintPair('code-2', 'two', { clientId: 'client-2' });
    expect(revokeTokensForClient(instance, 'client-1', 5000)).toBe(2);
    expect(findTokenById(instance, other.accessId)?.revokedAt).toBeNull();
    expect(findTokenById(instance, other.refreshId)?.revokedAt).toBeNull();
    expect(revokeTokensForClient(instance, 'client-1', 6000)).toBe(0);
  });

  it('touchToken sets lastUsedAt and changes nothing else', () => {
    const { accessId } = mintPair('code-1', 'one');
    const before = findTokenById(instance, accessId);
    expect(before?.lastUsedAt).toBeNull();
    touchToken(instance, accessId, 7000);
    const after = findTokenById(instance, accessId);
    expect(after?.lastUsedAt).toBe(7000);
    expect(after).toEqual(before === undefined ? undefined : { ...before, lastUsedAt: 7000 });
  });

  it('rotated pairs inherit issuedFromCodeHash, so a code replay kills the live pair (PR-94)', () => {
    const first = mintPair('code-C', 'gen0');
    rotateRefreshToken(instance, {
      oldRefreshTokenId: first.refreshId,
      newAccess: { tokenId: 'access-gen1', tokenHash: 'hash-access-gen1', expiresAt: 100_000 },
      newRefresh: { tokenId: 'refresh-gen1', tokenHash: 'hash-refresh-gen1', expiresAt: 200_000 },
      now: 2000,
    });
    rotateRefreshToken(instance, {
      oldRefreshTokenId: 'refresh-gen1',
      newAccess: { tokenId: 'access-gen2', tokenHash: 'hash-access-gen2', expiresAt: 100_000 },
      newRefresh: { tokenId: 'refresh-gen2', tokenHash: 'hash-refresh-gen2', expiresAt: 200_000 },
      now: 3000,
    });
    const newestAccess = findTokenById(instance, 'access-gen2');
    const newestRefresh = findTokenById(instance, 'refresh-gen2');
    // The inheritance: two rotations later the code hash is still code-C.
    expect(newestAccess?.issuedFromCodeHash).toBe('code-C');
    expect(newestRefresh?.issuedFromCodeHash).toBe('code-C');
    expect(newestAccess?.parentTokenId).toBe('refresh-gen1');
    expect(newestRefresh?.parentTokenId).toBe('refresh-gen1');
    // The replay cascade reaches every live token from code-C: gen0's access
    // (never rotated), gen1's access, and the live gen2 pair.
    expect(revokeTokensFromCode(instance, 'code-C', 4000)).toBe(4);
    expect(findTokenById(instance, 'access-gen2')?.revokedAt).toBe(4000);
    expect(findTokenById(instance, 'refresh-gen2')?.revokedAt).toBe(4000);
  });

  it('rotateRefreshToken on an access token throws and inserts nothing', () => {
    const { accessId } = mintPair('code-1', 'one');
    expect(listTokens(instance)).toHaveLength(2);
    expect(() =>
      rotateRefreshToken(instance, {
        oldRefreshTokenId: accessId,
        newAccess: { tokenId: 'access-x', tokenHash: 'hash-access-x', expiresAt: 100_000 },
        newRefresh: { tokenId: 'refresh-x', tokenHash: 'hash-refresh-x', expiresAt: 200_000 },
        now: 2000,
      }),
    ).toThrow();
    expect(listTokens(instance)).toHaveLength(2);
  });

  it('rotateRefreshToken on a revoked refresh token throws and inserts nothing', () => {
    const { refreshId } = mintPair('code-1', 'one');
    expect(revokeToken(instance, refreshId, 2000)).toBe(1);
    expect(listTokens(instance)).toHaveLength(2);
    expect(() =>
      rotateRefreshToken(instance, {
        oldRefreshTokenId: refreshId,
        newAccess: { tokenId: 'access-x', tokenHash: 'hash-access-x', expiresAt: 100_000 },
        newRefresh: { tokenId: 'refresh-x', tokenHash: 'hash-refresh-x', expiresAt: 200_000 },
        now: 3000,
      }),
    ).toThrow();
    expect(listTokens(instance)).toHaveLength(2);
  });

  it('rotateRefreshToken on an unknown token throws and inserts nothing', () => {
    mintPair('code-1', 'one');
    expect(() =>
      rotateRefreshToken(instance, {
        oldRefreshTokenId: 'nope',
        newAccess: { tokenId: 'access-x', tokenHash: 'hash-access-x', expiresAt: 100_000 },
        newRefresh: { tokenId: 'refresh-x', tokenHash: 'hash-refresh-x', expiresAt: 200_000 },
        now: 2000,
      }),
    ).toThrow();
    expect(listTokens(instance)).toHaveLength(2);
  });

  it('revokeTokenChain revokes three generations and leaves a sibling chain alone', () => {
    // Built directly so every generation is live: rotating would revoke the
    // intermediates before the chain is even walked.
    const chain = (root: string, code: string): string[] => {
      const ids = [`${root}-r0`, `${root}-a1`, `${root}-r1`, `${root}-a2`, `${root}-r2`];
      const [r0, a1, r1, a2, r2] = ids as [string, string, string, string, string];
      const parents: Record<string, string | null> = {
        [r0]: null,
        [a1]: r0,
        [r1]: r0,
        [a2]: r1,
        [r2]: r1,
      };
      for (const tokenId of ids) {
        const kind = tokenId.includes('-a') ? 'access' : 'refresh';
        createToken(instance, {
          tokenId,
          tokenHash: `hash-${tokenId}`,
          kind,
          clientId: 'client-1',
          accountId: 'acct-1',
          scopes: ['bananasaurs:read'],
          createdAt: 1000,
          expiresAt: 100_000,
          parentTokenId: parents[tokenId] ?? null,
          issuedFromCodeHash: code,
        });
      }
      return ids;
    };
    const ids = chain('main', 'code-main');
    const sibling = chain('sib', 'code-sib');
    expect(revokeTokenChain(instance, 'main-r0', 5000)).toBe(5);
    for (const tokenId of ids) {
      expect(findTokenById(instance, tokenId)?.revokedAt).toBe(5000);
    }
    for (const tokenId of sibling) {
      expect(findTokenById(instance, tokenId)?.revokedAt).toBeNull();
    }
    expect(revokeTokenChain(instance, 'main-r0', 6000)).toBe(0);
  });

  it('purgeExpired deletes expired pending rows, expired codes, and expired+revoked tokens only', () => {
    const now = 10_000;
    // Pending: one expired, one live.
    createPendingAuthorization(instance, {
      requestId: 'req-old',
      nonceHash: 'n',
      clientId: 'client-1',
      redirectUri: 'https://example.test/cb',
      scopes: [],
      codeChallenge: 'c',
      state: null,
      createdAt: 1000,
      expiresAt: 5000,
    });
    createPendingAuthorization(instance, {
      requestId: 'req-live',
      nonceHash: 'n',
      clientId: 'client-1',
      redirectUri: 'https://example.test/cb',
      scopes: [],
      codeChallenge: 'c',
      state: null,
      createdAt: 1000,
      expiresAt: 50_000,
    });
    // Codes: one expired, one live.
    seedCode('code-old', 'client-1', 5000);
    seedCode('code-live', 'client-1', 50_000);
    // Tokens: expired+revoked (deleted), revoked-but-unexpired (kept),
    // expired-but-unrevoked (kept).
    const gone = mintPair('code-gone', 'gone', { expiresAt: 5000 });
    revokeToken(instance, gone.accessId, 6000);
    revokeToken(instance, gone.refreshId, 6000);
    const revokedLive = mintPair('code-revoked-live', 'revlive', { expiresAt: 50_000 });
    revokeToken(instance, revokedLive.accessId, 6000);
    revokeToken(instance, revokedLive.refreshId, 6000);
    const expiredLive = mintPair('code-exp-live', 'explive', { expiresAt: 5000 });

    expect(purgeExpired(instance, now)).toEqual({ pending: 1, codes: 1, tokens: 2 });

    expect(consumePendingAuthorization(instance, 'req-old', now)).toBeUndefined();
    expect(consumePendingAuthorization(instance, 'req-live', now)).toBeDefined();
    expect(findAuthorizationCode(instance, 'code-old')).toBeUndefined();
    expect(findAuthorizationCode(instance, 'code-live')).toBeDefined();
    // The expired+revoked pair is gone; both kept classes are still readable.
    expect(findTokenById(instance, gone.accessId)).toBeUndefined();
    expect(findTokenById(instance, gone.refreshId)).toBeUndefined();
    expect(findTokenById(instance, revokedLive.accessId)?.revokedAt).toBe(6000);
    expect(findTokenById(instance, expiredLive.accessId)?.revokedAt).toBeNull();
  });
});
