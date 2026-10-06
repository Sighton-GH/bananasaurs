import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { InstanceScope } from '../scope.js';
import {
  consumePendingAuthorization,
  createAuthorizationCode,
  createClient,
  createPendingAuthorization,
  cleanupDead,
  createToken,
  deleteClient,
  deleteConnection,
  deleteToken,
  deleteAuthorizationCodesForAccount,
  findAuthorizationCode,
  findClient,
  findTokenByHash,
  findTokenById,
  listClients,
  connectionIdFor,
  listConnections,
  listTokens,
  revokeConnection,
  markAuthorizationCodeUsed,
  purgeExpired,
  revokeAllTokensForAccount,
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

const seedCode = (
  codeHash = 'code-1',
  clientId = 'client-1',
  expiresAt = 60_000,
  accountId = 'acct-1',
): void =>
  createAuthorizationCode(instance, {
    codeHash,
    clientId,
    accountId,
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

  it('deleteClient leaves nothing exchangeable: pending rows and codes go too', () => {
    seedClient('client-1');
    seedClient('client-2');
    const pending = (requestId: string, clientId: string): void =>
      createPendingAuthorization(instance, {
        requestId,
        nonceHash: 'nonce-hash-1',
        clientId,
        redirectUri: 'https://example.test/cb',
        scopes: ['bananasaurs:read'],
        codeChallenge: 'challenge-1',
        state: null,
        createdAt: 1000,
        expiresAt: 60_000,
      });
    pending('req-1', 'client-1');
    pending('req-2', 'client-2');
    seedCode('code-1', 'client-1');
    seedCode('code-2', 'client-2');

    expect(deleteClient(instance, 'client-1', 5000)).toBe(0);

    expect(consumePendingAuthorization(instance, 'req-1', 5000)).toBeUndefined();
    expect(findAuthorizationCode(instance, 'code-1')).toBeUndefined();
    // The second client's rows are untouched: still consumable, still readable.
    expect(consumePendingAuthorization(instance, 'req-2', 5000)).toBeDefined();
    expect(findAuthorizationCode(instance, 'code-2')).toBeDefined();
  });
});

describe('malformed scopes rows throw on read', () => {
  // Written through the raw handle: the repository never writes this shape.
  it.each(['pending', 'code', 'token'] as const)('%s with malformed scopes throws', (kind) => {
    if (kind === 'pending') {
      createPendingAuthorization(instance, {
        requestId: 'req-bad',
        nonceHash: 'nonce-hash-1',
        clientId: 'client-1',
        redirectUri: 'https://example.test/cb',
        scopes: ['bananasaurs:read'],
        codeChallenge: 'challenge-1',
        state: null,
        createdAt: 1000,
        expiresAt: 60_000,
      });
      t.raw
        .prepare(`UPDATE oauth_pending_authorizations SET scopes = 'not json' WHERE request_id = ?`)
        .run('req-bad');
      expect(() => consumePendingAuthorization(instance, 'req-bad', 2000)).toThrow();
    } else if (kind === 'code') {
      createAuthorizationCode(instance, {
        codeHash: 'code-bad',
        clientId: 'client-1',
        accountId: 'acct-1',
        scopes: ['bananasaurs:read'],
        codeChallenge: 'challenge-1',
        redirectUri: 'https://example.test/cb',
        createdAt: 1000,
        expiresAt: 60_000,
      });
      t.raw
        .prepare(`UPDATE oauth_authorization_codes SET scopes = 'not json' WHERE code_hash = ?`)
        .run('code-bad');
      expect(() => findAuthorizationCode(instance, 'code-bad')).toThrow();
    } else {
      createToken(instance, {
        tokenId: 'token-bad',
        tokenHash: 'hash-token-bad',
        kind: 'access',
        clientId: 'client-1',
        accountId: 'acct-1',
        scopes: ['bananasaurs:read'],
        createdAt: 1000,
        expiresAt: 100_000,
        parentTokenId: null,
        issuedFromCodeHash: 'code-1',
      });
      t.raw
        .prepare(`UPDATE oauth_tokens SET scopes = 'not json' WHERE token_id = ?`)
        .run('token-bad');
      expect(() => findTokenById(instance, 'token-bad')).toThrow();
    }
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

  it('purgeExpired deletes tokens 14 days after expiry whether or not revoked (ADR 0127)', () => {
    const DAY = 86_400_000;
    const now = 30 * DAY;
    const longAgo = 1000;
    const recentExpiry = now - 7 * DAY;
    const liveExpiry = now + DAY;
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
      expiresAt: liveExpiry,
    });
    // Codes: one expired, one live.
    seedCode('code-old', 'client-1', 5000);
    seedCode('code-live', 'client-1', liveExpiry);
    // Tokens: expired >14d ago revoked (deleted) and unrevoked (deleted —
    // the rotated-access-token case), expired <14d ago revoked or not (kept),
    // revoked-but-unexpired (kept), live (kept).
    const oldRevoked = mintPair('code-old-rev', 'oldrev', { expiresAt: longAgo });
    revokeToken(instance, oldRevoked.accessId, 6000);
    revokeToken(instance, oldRevoked.refreshId, 6000);
    const oldUnrevoked = mintPair('code-old-unrev', 'oldunrev', { expiresAt: longAgo });
    const recentRevoked = mintPair('code-recent-rev', 'recentrev', { expiresAt: recentExpiry });
    revokeToken(instance, recentRevoked.accessId, 6000);
    revokeToken(instance, recentRevoked.refreshId, 6000);
    const recentUnrevoked = mintPair('code-recent-unrev', 'recentunrev', {
      expiresAt: recentExpiry,
    });
    const revokedLive = mintPair('code-revoked-live', 'revlive', { expiresAt: liveExpiry });
    revokeToken(instance, revokedLive.accessId, 6000);
    revokeToken(instance, revokedLive.refreshId, 6000);
    const live = mintPair('code-live-tok', 'livetok', { expiresAt: liveExpiry });

    expect(purgeExpired(instance, now)).toEqual({ pending: 1, codes: 1, tokens: 4 });

    expect(consumePendingAuthorization(instance, 'req-old', now)).toBeUndefined();
    expect(consumePendingAuthorization(instance, 'req-live', now)).toBeDefined();
    expect(findAuthorizationCode(instance, 'code-old')).toBeUndefined();
    expect(findAuthorizationCode(instance, 'code-live')).toBeDefined();
    // Both long-expired pairs are gone; every other token class is readable.
    expect(findTokenById(instance, oldRevoked.accessId)).toBeUndefined();
    expect(findTokenById(instance, oldRevoked.refreshId)).toBeUndefined();
    expect(findTokenById(instance, oldUnrevoked.accessId)).toBeUndefined();
    expect(findTokenById(instance, oldUnrevoked.refreshId)).toBeUndefined();
    expect(findTokenById(instance, recentRevoked.accessId)?.revokedAt).toBe(6000);
    expect(findTokenById(instance, recentRevoked.refreshId)?.revokedAt).toBe(6000);
    expect(findTokenById(instance, recentUnrevoked.accessId)?.revokedAt).toBeNull();
    expect(findTokenById(instance, recentUnrevoked.refreshId)?.revokedAt).toBeNull();
    expect(findTokenById(instance, revokedLive.accessId)?.revokedAt).toBe(6000);
    expect(findTokenById(instance, revokedLive.refreshId)?.revokedAt).toBe(6000);
    expect(findTokenById(instance, live.accessId)?.revokedAt).toBeNull();
    expect(findTokenById(instance, live.refreshId)?.revokedAt).toBeNull();
  });

  it('purgeExpired deletes a rotated access token 14 days after expiry without breaking reuse detection', () => {
    const DAY = 86_400_000;
    const accessExpiry = 1000;
    const refreshExpiry = 100 * DAY;
    // Split expiries so the old access token is long-expired while the old
    // refresh token (and the rotated pair) is still live: rotation never
    // revokes the old access token, so it is the leaf the old rule leaked.
    createToken(instance, {
      tokenId: 'access-old-rot',
      tokenHash: 'hash-access-old-rot',
      kind: 'access',
      clientId: 'client-1',
      accountId: 'acct-1',
      scopes: ['bananasaurs:read'],
      createdAt: 1000,
      expiresAt: accessExpiry,
      parentTokenId: null,
      issuedFromCodeHash: 'code-rot',
    });
    createToken(instance, {
      tokenId: 'refresh-old-rot',
      tokenHash: 'hash-refresh-old-rot',
      kind: 'refresh',
      clientId: 'client-1',
      accountId: 'acct-1',
      scopes: ['bananasaurs:read'],
      createdAt: 1000,
      expiresAt: refreshExpiry,
      parentTokenId: null,
      issuedFromCodeHash: 'code-rot',
    });
    rotateRefreshToken(instance, {
      oldRefreshTokenId: 'refresh-old-rot',
      newAccess: { tokenId: 'access-new', tokenHash: 'hash-access-new', expiresAt: refreshExpiry },
      newRefresh: {
        tokenId: 'refresh-new',
        tokenHash: 'hash-refresh-new',
        expiresAt: refreshExpiry,
      },
      now: 2000,
    });

    const purgeNow = accessExpiry + 14 * DAY + 1;
    expect(purgeExpired(instance, purgeNow)).toEqual({ pending: 0, codes: 0, tokens: 1 });

    expect(findTokenById(instance, 'access-old-rot')).toBeUndefined();
    expect(findTokenById(instance, 'refresh-old-rot')).toBeDefined();
    expect(findTokenById(instance, 'access-new')).toBeDefined();
    expect(findTokenById(instance, 'refresh-new')).toBeDefined();
    // The surviving old refresh token still reaches the new pair, so refresh
    // reuse detection is intact after the leaf is purged.
    expect(revokeTokenChain(instance, 'refresh-old-rot', purgeNow)).toBe(2);
    expect(findTokenById(instance, 'access-new')?.revokedAt).toBe(purgeNow);
    expect(findTokenById(instance, 'refresh-new')?.revokedAt).toBe(purgeNow);
  });
});

describe('revokeAllTokensForAccount (M3c)', () => {
  beforeEach(() => {
    seedClient();
  });

  const seedTokenFor = (tokenId: string, accountId: string, codeHash = `code-${tokenId}`): void =>
    createToken(instance, {
      tokenId,
      tokenHash: `hash-${tokenId}`,
      kind: 'access',
      clientId: 'client-1',
      accountId,
      scopes: ['bananasaurs:read'],
      createdAt: 1000,
      expiresAt: 100_000,
      parentTokenId: null,
      issuedFromCodeHash: codeHash,
    });

  it('revokes every live token of the account and leaves an already-revoked row timestamp untouched', () => {
    seedTokenFor('tok-a', 'acct-1');
    seedTokenFor('tok-b', 'acct-1');
    seedTokenFor('tok-c', 'acct-1');
    // Revoked earlier by another path: the bulk revoke must not rewrite it.
    expect(revokeToken(instance, 'tok-a', 4000)).toBe(1);

    expect(revokeAllTokensForAccount(instance, { accountId: 'acct-1', now: 5000 })).toBe(2);

    expect(findTokenById(instance, 'tok-a')?.revokedAt).toBe(4000);
    expect(findTokenById(instance, 'tok-b')?.revokedAt).toBe(5000);
    expect(findTokenById(instance, 'tok-c')?.revokedAt).toBe(5000);
    // A second sweep finds nothing live.
    expect(revokeAllTokensForAccount(instance, { accountId: 'acct-1', now: 6000 })).toBe(0);
  });

  it('does not touch another account tokens', () => {
    seedTokenFor('tok-mine', 'acct-1');
    seedTokenFor('tok-theirs', 'acct-2');

    expect(revokeAllTokensForAccount(instance, { accountId: 'acct-1', now: 5000 })).toBe(1);

    expect(findTokenById(instance, 'tok-mine')?.revokedAt).toBe(5000);
    expect(findTokenById(instance, 'tok-theirs')?.revokedAt).toBeNull();
  });
});

describe('deleteAuthorizationCodesForAccount (M3c fix wave)', () => {
  beforeEach(() => {
    seedClient();
  });

  it('deletes the account codes, counts them, and leaves another account codes alone', () => {
    seedCode('code-mine-1', 'client-1', 60_000, 'acct-1');
    seedCode('code-mine-2', 'client-1', 60_000, 'acct-1');
    seedCode('code-theirs', 'client-1', 60_000, 'acct-2');

    expect(deleteAuthorizationCodesForAccount(instance, 'acct-1')).toBe(2);

    expect(findAuthorizationCode(instance, 'code-mine-1')).toBeUndefined();
    expect(findAuthorizationCode(instance, 'code-mine-2')).toBeUndefined();
    expect(findAuthorizationCode(instance, 'code-theirs')).toBeDefined();
  });

  it('removes the row, so a later exchange finds no code to mint from', () => {
    // Repository-level proof of the finding: `exchangeCode`
    // (`packages/http/src/oauth/provider.ts`) reads the code row by hash first
    // and refuses an unknown code with `invalid_grant`, gating otherwise only
    // on expiry and `approver.disabled` — so a deleted row cannot mint. The
    // end-to-end version (exchange after revoke fails) belongs in
    // `bearer.test.ts` and was left for the controller.
    seedCode('code-doomed', 'client-1', 60_000, 'acct-1');

    expect(deleteAuthorizationCodesForAccount(instance, 'acct-1')).toBe(1);
    expect(findAuthorizationCode(instance, 'code-doomed')).toBeUndefined();
  });
});

describe('connections (ADR 0130)', () => {
  const rotate = (oldRefreshId: string, suffix: string, now: number, expiresAt = 500_000): void =>
    rotateRefreshToken(instance, {
      oldRefreshTokenId: oldRefreshId,
      newAccess: { tokenId: `access-${suffix}`, tokenHash: `hash-access-${suffix}`, expiresAt },
      newRefresh: { tokenId: `refresh-${suffix}`, tokenHash: `hash-refresh-${suffix}`, expiresAt },
      now,
    });

  const id = connectionIdFor;

  it('groups rotations with their sign-in, keyed by a stable id derived from the sign-in', () => {
    seedClient();
    mintPair('code-1', 'a', { createdAt: 1000, expiresAt: 100_000 });
    rotate('refresh-a', 'b', 2000);
    mintPair('code-2', 'c', { createdAt: 3000, expiresAt: 100_000 });
    touchToken(instance, 'access-b', 9000);

    const connections = listConnections(instance, 10_000);
    expect(connections).toHaveLength(2);
    const first = connections.find((c) => c.connectionId === id('code-1'));
    expect(first).toMatchObject({
      accountId: 'acct-1',
      clientId: 'client-1',
      scopes: ['bananasaurs:read'],
      createdAt: 1000,
      lastUsedAt: 9000,
      status: 'connected',
      tokenCount: 4,
    });
    expect(connections.find((c) => c.connectionId === id('code-2'))?.lastUsedAt).toBeNull();
    // The code hash is never exposed.
    expect(JSON.stringify(connections)).not.toContain('code-1');
    expect(id('code-1')).toMatch(/^conn_[0-9a-f]{24}$/);
  });

  it('a connection keeps its id when its oldest rows are deleted', () => {
    seedClient();
    mintPair('code-1', 'a', { createdAt: 1000, expiresAt: 100_000 });
    rotate('refresh-a', 'b', 2000);
    deleteToken(instance, 'access-a', 3000);
    expect(listConnections(instance, 10_000).map((c) => c.connectionId)).toEqual([id('code-1')]);
  });

  it('reports connected, revoked and expired', () => {
    seedClient();
    mintPair('code-live', 'live', { expiresAt: 100_000 });
    mintPair('code-rev', 'rev', { expiresAt: 100_000 });
    mintPair('code-exp', 'exp', { expiresAt: 5_000 });
    revokeTokensFromCode(instance, 'code-rev', 2000);
    const byId = new Map(listConnections(instance, 10_000).map((c) => [c.connectionId, c.status]));
    expect(byId.get(id('code-live'))).toBe('connected');
    expect(byId.get(id('code-rev'))).toBe('revoked');
    expect(byId.get(id('code-exp'))).toBe('expired');
  });

  it('revokeConnection revokes live rows and keeps them; unknown is undefined', () => {
    seedClient();
    mintPair('code-1', 'a');
    expect(revokeConnection(instance, id('code-1'), 2000)).toBe(2);
    expect(findTokenById(instance, 'refresh-a')?.revokedAt).toBe(2000);
    expect(revokeConnection(instance, 'nope', 2000)).toBeUndefined();
  });

  it('deleteConnection revokes live rows then deletes every row of that connection only', () => {
    seedClient();
    mintPair('code-1', 'a');
    rotate('refresh-a', 'b', 2000);
    mintPair('code-2', 'c');
    // access-a/refresh-a: refresh-a revoked by rotation; access-a, access-b, refresh-b live.
    expect(deleteConnection(instance, id('code-1'), 3000)).toEqual({ revoked: 3, deleted: 4 });
    expect(listTokens(instance).map((x) => x.tokenId)).toEqual(['access-c', 'refresh-c']);
    expect(deleteConnection(instance, id('code-1'), 3000)).toBeUndefined();
  });

  it('deleting a dead row of a live connection disconnects it, so a replay check is never weakened silently', () => {
    seedClient();
    mintPair('code-1', 'a');
    rotate('refresh-a', 'b', 2000);
    // refresh-a is revoked by rotation; the connection is still live.
    expect(deleteToken(instance, 'refresh-a', 3000)).toEqual({ revoked: 3, deleted: 1 });
    expect(findTokenById(instance, 'refresh-b')?.revokedAt).toBe(3000);
  });

  it('deleteToken revokes the lineage of a live row, deletes just that row', () => {
    seedClient();
    mintPair('code-1', 'a');
    expect(deleteToken(instance, 'access-a', 3000)).toEqual({ revoked: 2, deleted: 1 });
    expect(findTokenById(instance, 'access-a')).toBeUndefined();
    expect(findTokenById(instance, 'refresh-a')?.revokedAt).toBe(3000);
    // A dead row is deleted without a revoke.
    expect(deleteToken(instance, 'refresh-a', 4000)).toEqual({ revoked: 0, deleted: 1 });
    expect(deleteToken(instance, 'nope', 4000)).toBeUndefined();
  });

  it('cleanupDead deletes revoked and expired rows, keeps live rows, drops unused old clients only', () => {
    const now = 10_000_000;
    const hour = 60 * 60 * 1000;
    seedClient('client-live', 1000);
    seedClient('client-dead', 1000);
    seedClient('client-young', now - 1000);
    seedClient('client-midflow', 1000);
    seedClient('client-code', 1000);
    mintPair('code-live', 'live', { clientId: 'client-live', expiresAt: now + hour });
    mintPair('code-dead', 'dead', { clientId: 'client-dead', expiresAt: now + hour });
    mintPair('code-exp', 'exp', { clientId: 'client-dead', expiresAt: now - 1 });
    revokeTokensFromCode(instance, 'code-dead', now - 5);
    // A live connection's rotated-out refresh row stays: replaying it must
    // still revoke the connection (provider.ts checks revoked before expiry).
    rotate('refresh-live', 'live2', now - 2, now + hour);
    createPendingAuthorization(instance, {
      requestId: 'req-1',
      nonceHash: 'nonce-1',
      clientId: 'client-midflow',
      redirectUri: 'https://example.test/cb',
      scopes: ['bananasaurs:read'],
      codeChallenge: 'c',
      state: null,
      createdAt: now - 10,
      expiresAt: now + 60_000,
    });
    seedCode('code-open', 'client-code', now + 60_000);

    expect(cleanupDead(instance, now)).toEqual({ tokens: 4, clients: 1 });
    expect(
      listTokens(instance)
        .map((x) => x.tokenId)
        .sort(),
    ).toEqual(['access-live', 'access-live2', 'refresh-live', 'refresh-live2']);
    expect(
      listClients(instance)
        .map((c) => c.clientId)
        .sort(),
    ).toEqual(['client-code', 'client-live', 'client-midflow', 'client-young']);
  });
});
