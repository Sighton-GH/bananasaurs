import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, oauthRepo } from '@bananasaurs/storage';
import { generateToken, hashPassword, hashToken } from '../secrets.js';
import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  beginAuthorization,
  completeAuthorization,
  exchangeCode,
  refreshTokens,
  revokeByValue,
  verifyAccessToken,
  type IssuedTokens,
  type OAuthDeps,
  type OAuthFailure,
} from './provider.js';

const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const CLIENT = 'client-1';
const OTHER_CLIENT = 'client-2';
const REDIRECT = 'https://example.test/cb';

let t: MigratedTestDatabase;
let clock: number;
let deps: OAuthDeps;

/** Every raw secret minted during the run, for the no-secrets test at the end. */
const seenSecrets: string[] = [];
/** Every failure description produced during the run. */
const seenDescriptions: string[] = [];

const trackSecrets = (...values: string[]): void => {
  seenSecrets.push(...values);
};
const trackFailure = (result: OAuthFailure): OAuthFailure => {
  seenDescriptions.push(result.description);
  return result;
};

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  deps = { scopes: t.scopes, now: () => clock, guildIds: [] };
  accountRepo.createAccount(t.scopes.instance(), {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
});
afterEach(() => {
  t.close();
});

const registerClient = (clientId = CLIENT, redirectUris: readonly string[] = [REDIRECT]): void => {
  oauthRepo.createClient(t.scopes.instance(), {
    clientId,
    clientName: `name of ${clientId}`,
    redirectUris,
    createdAt: clock,
    createdByAccountId: null,
    registrationSource: 'dynamic',
  });
};

/** Re-implemented here so the test does not import its own oracle. */
const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier, 'utf8').digest('base64url');

const newPkce = (): { verifier: string; challenge: string } => {
  const verifier = generateToken();
  trackSecrets(verifier);
  return { verifier, challenge: s256(verifier) };
};

const pendingRowCount = (): number =>
  (t.raw.prepare('SELECT COUNT(*) AS n FROM oauth_pending_authorizations').get() as { n: number })
    .n;

const disableAccount = (): void => {
  t.raw.prepare('UPDATE dashboard_accounts SET disabled = 1 WHERE account_id = ?').run(ACCOUNT);
};

/** begin -> complete -> exchange, all at the current clock. Returns every raw value. */
const fullFlow = (over?: {
  clientId?: string;
  redirectUri?: string;
  scope?: string;
  state?: string | null;
}): {
  requestId: string;
  nonce: string;
  code: string;
  issued: IssuedTokens;
  verifier: string;
} => {
  const clientId = over?.clientId ?? CLIENT;
  const redirectUri = over?.redirectUri ?? REDIRECT;
  const { verifier, challenge } = newPkce();
  const begun = beginAuthorization(deps, {
    clientId,
    redirectUri,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    scope: over?.scope ?? 'bananasaurs:read',
    state: over?.state === undefined ? 'st-1' : over.state,
  });
  if (!begun.ok) throw new Error(`begin failed: ${begun.error}`);
  trackSecrets(begun.nonce);
  const done = completeAuthorization(deps, {
    requestId: begun.requestId,
    nonce: begun.nonce,
    accountId: ACCOUNT,
  });
  if (!done.ok) throw new Error(`complete failed: ${done.error}`);
  trackSecrets(done.code);
  const issued = exchangeCode(deps, {
    code: done.code,
    clientId,
    redirectUri,
    codeVerifier: verifier,
  });
  if (!issued.ok) throw new Error(`exchange failed: ${issued.error}`);
  trackSecrets(issued.accessToken, issued.refreshToken);
  return { requestId: begun.requestId, nonce: begun.nonce, code: done.code, issued, verifier };
};

/** begin -> complete only, so the caller can exchange with its own parameters. */
const authorize = (
  clientId = CLIENT,
  redirectUri = REDIRECT,
): { code: string; verifier: string } => {
  const { verifier, challenge } = newPkce();
  const begun = beginAuthorization(deps, {
    clientId,
    redirectUri,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    scope: 'bananasaurs:read',
    state: 'st-1',
  });
  if (!begun.ok) throw new Error(`begin failed: ${begun.error}`);
  trackSecrets(begun.nonce);
  const done = completeAuthorization(deps, {
    requestId: begun.requestId,
    nonce: begun.nonce,
    accountId: ACCOUNT,
  });
  if (!done.ok) throw new Error(`complete failed: ${done.error}`);
  trackSecrets(done.code);
  return { code: done.code, verifier };
};

describe('beginAuthorization', () => {
  it('returns the request id, nonce, client, redirect host and scopes on success', () => {
    registerClient();
    const { challenge } = newPkce();
    const result = beginAuthorization(deps, {
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'bananasaurs:read bananasaurs:send',
      state: 'st-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('begin failed');
    trackSecrets(result.nonce);
    expect(result.client).toEqual({
      clientId: CLIENT,
      clientName: `name of ${CLIENT}`,
      createdAt: clock,
    });
    expect(result.redirectUriHost).toBe('example.test');
    expect(result.scopes).toEqual(['bananasaurs:read', 'bananasaurs:send']);
  });

  it('refuses an unknown client', () => {
    const { challenge } = newPkce();
    const result = beginAuthorization(deps, {
      clientId: 'nope',
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'bananasaurs:read',
      state: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('begin unexpectedly succeeded');
    expect(trackFailure(result).error).toBe('invalid_client');
  });

  it("refuses scope 'bananasaurs:read bananasaurs:admin'", () => {
    registerClient();
    const { challenge } = newPkce();
    const result = beginAuthorization(deps, {
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'bananasaurs:read bananasaurs:admin',
      state: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('begin unexpectedly succeeded');
    expect(trackFailure(result).error).toBe('invalid_scope');
  });

  it("refuses scope ''", () => {
    registerClient();
    const { challenge } = newPkce();
    const result = beginAuthorization(deps, {
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: '',
      state: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('begin unexpectedly succeeded');
    expect(trackFailure(result).error).toBe('invalid_scope');
  });

  it('refusal (c) part 1: refuses codeChallengeMethod plain and writes no pending row', () => {
    registerClient();
    const { challenge } = newPkce();
    const result = beginAuthorization(deps, {
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: 'plain',
      scope: 'bananasaurs:read',
      state: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('begin unexpectedly succeeded');
    expect(trackFailure(result).error).toBe('invalid_request');
    expect(pendingRowCount()).toBe(0);
  });

  it('refusal (g): refuses a redirect URI differing by one path character, writing nothing', () => {
    registerClient();
    const { challenge } = newPkce();
    const result = beginAuthorization(deps, {
      clientId: CLIENT,
      redirectUri: 'https://example.test/cd',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'bananasaurs:read',
      state: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('begin unexpectedly succeeded');
    expect(trackFailure(result).error).toBe('invalid_request');
    expect(pendingRowCount()).toBe(0);
  });
});

describe('completeAuthorization', () => {
  it('refuses an unknown request id', () => {
    const result = completeAuthorization(deps, {
      requestId: 'req-nope',
      nonce: generateToken(),
      accountId: ACCOUNT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('complete unexpectedly succeeded');
    expect(trackFailure(result).error).toBe('invalid_grant');
  });

  it('a wrong nonce burns the request: the right nonce fails afterwards too', () => {
    registerClient();
    const { challenge } = newPkce();
    const begun = beginAuthorization(deps, {
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'bananasaurs:read',
      state: null,
    });
    if (!begun.ok) throw new Error('begin failed');
    trackSecrets(begun.nonce);
    const wrong = generateToken();
    trackSecrets(wrong);
    const first = completeAuthorization(deps, {
      requestId: begun.requestId,
      nonce: wrong,
      accountId: ACCOUNT,
    });
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error('complete unexpectedly succeeded');
    expect(trackFailure(first).error).toBe('invalid_grant');
    const second = completeAuthorization(deps, {
      requestId: begun.requestId,
      nonce: begun.nonce,
      accountId: ACCOUNT,
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('complete unexpectedly succeeded');
    expect(trackFailure(second).error).toBe('invalid_grant');
  });
});

describe('exchangeCode', () => {
  it('mints an access and refresh token with the code scopes and a 3600s expiry', () => {
    registerClient();
    const { issued } = fullFlow();
    expect(issued.expiresInSeconds).toBe(ACCESS_TOKEN_TTL_MS / 1000);
    expect(issued.scopes).toEqual(['bananasaurs:read']);
    expect(issued.accessToken).not.toBe(issued.refreshToken);
  });

  it('refusal (a): a code issued to X exchanged by Y is refused and stays usable by X', () => {
    registerClient(CLIENT);
    registerClient(OTHER_CLIENT);
    const { code, verifier } = authorize(CLIENT);
    const refused = exchangeCode(deps, {
      code,
      clientId: OTHER_CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('exchange unexpectedly succeeded');
    expect(trackFailure(refused).error).toBe('invalid_grant');
    expect(
      oauthRepo.findAuthorizationCode(t.scopes.instance(), hashToken(code))?.usedAt,
    ).toBeNull();
    const legitimate = exchangeCode(deps, {
      code,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
    expect(legitimate.ok).toBe(true);
    if (!legitimate.ok) throw new Error(`legitimate exchange failed: ${legitimate.error}`);
    trackSecrets(legitimate.accessToken, legitimate.refreshToken);
  });

  it('refusal (b): exchanging the same code twice revokes the first pair', () => {
    registerClient();
    const { code, verifier } = authorize();
    const first = exchangeCode(deps, {
      code,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('first exchange failed');
    trackSecrets(first.accessToken, first.refreshToken);
    const second = exchangeCode(deps, {
      code,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('replay unexpectedly succeeded');
    expect(trackFailure(second).error).toBe('invalid_grant');
    expect(
      oauthRepo.findTokenById(t.scopes.instance(), first.accessTokenId)?.revokedAt,
    ).not.toBeNull();
    expect(
      oauthRepo.findTokenById(t.scopes.instance(), first.refreshTokenId)?.revokedAt,
    ).not.toBeNull();
  });

  it('refusal (b) PR-94: exchange, refresh twice, replay the code revokes the newest pair', () => {
    registerClient();
    const { issued } = fullFlow();
    trackSecrets(issued.refreshToken);
    const second = refreshTokens(deps, { refreshToken: issued.refreshToken, clientId: CLIENT });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('first refresh failed');
    trackSecrets(second.accessToken, second.refreshToken);
    const third = refreshTokens(deps, { refreshToken: second.refreshToken, clientId: CLIENT });
    expect(third.ok).toBe(true);
    if (!third.ok) throw new Error('second refresh failed');
    trackSecrets(third.accessToken, third.refreshToken);
    // Replay needs the original code value; run a fresh flow and keep its code.
    const { code, verifier } = authorize();
    const firstUse = exchangeCode(deps, {
      code,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
    if (!firstUse.ok) throw new Error('exchange failed');
    trackSecrets(firstUse.accessToken, firstUse.refreshToken);
    const r1 = refreshTokens(deps, { refreshToken: firstUse.refreshToken, clientId: CLIENT });
    if (!r1.ok) throw new Error('refresh 1 failed');
    trackSecrets(r1.accessToken, r1.refreshToken);
    const r2 = refreshTokens(deps, { refreshToken: r1.refreshToken, clientId: CLIENT });
    if (!r2.ok) throw new Error('refresh 2 failed');
    trackSecrets(r2.accessToken, r2.refreshToken);
    const replay = exchangeCode(deps, {
      code,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error('replay unexpectedly succeeded');
    expect(trackFailure(replay).error).toBe('invalid_grant');
    expect(
      oauthRepo.findTokenById(t.scopes.instance(), r2.accessTokenId)?.revokedAt,
    ).not.toBeNull();
    expect(
      oauthRepo.findTokenById(t.scopes.instance(), r2.refreshTokenId)?.revokedAt,
    ).not.toBeNull();
  });

  it('refusal (c) part 2: a verifier equal to the challenge is refused', () => {
    registerClient();
    const { verifier, challenge } = newPkce();
    void verifier;
    const begun = beginAuthorization(deps, {
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'bananasaurs:read',
      state: null,
    });
    if (!begun.ok) throw new Error('begin failed');
    trackSecrets(begun.nonce);
    const done = completeAuthorization(deps, {
      requestId: begun.requestId,
      nonce: begun.nonce,
      accountId: ACCOUNT,
    });
    if (!done.ok) throw new Error('complete failed');
    trackSecrets(done.code, challenge);
    // What `plain` would accept — the challenge itself — must fail under S256.
    const result = exchangeCode(deps, {
      code: done.code,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: challenge,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('exchange unexpectedly succeeded');
    expect(trackFailure(result).error).toBe('invalid_grant');
  });

  it('refuses a mismatched redirect URI', () => {
    registerClient(CLIENT, [REDIRECT, 'https://example.test/other']);
    const { code, verifier } = authorize(CLIENT, REDIRECT);
    const result = exchangeCode(deps, {
      code,
      clientId: CLIENT,
      redirectUri: 'https://example.test/other',
      codeVerifier: verifier,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('exchange unexpectedly succeeded');
    expect(trackFailure(result).error).toBe('invalid_grant');
  });

  it('refuses an unknown code', () => {
    registerClient();
    const unknown = generateToken();
    trackSecrets(unknown);
    const result = exchangeCode(deps, {
      code: unknown,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: generateToken(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('exchange unexpectedly succeeded');
    expect(trackFailure(result).error).toBe('invalid_grant');
  });

  it('succeeds at clock + AUTHORIZATION_CODE_TTL_MS - 1', () => {
    registerClient();
    const { code, verifier } = authorize();
    clock += AUTHORIZATION_CODE_TTL_MS - 1;
    const result = exchangeCode(deps, {
      code,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`exchange failed: ${result.error}`);
    trackSecrets(result.accessToken, result.refreshToken);
  });

  it('refuses at clock + AUTHORIZATION_CODE_TTL_MS', () => {
    registerClient();
    const { code, verifier } = authorize();
    clock += AUTHORIZATION_CODE_TTL_MS;
    const result = exchangeCode(deps, {
      code,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('exchange unexpectedly succeeded');
    expect(trackFailure(result).error).toBe('invalid_grant');
  });

  it('exchange after the account is disabled is refused: D6 bites at mint too', () => {
    registerClient();
    const { code, verifier } = authorize();
    disableAccount();
    const result = exchangeCode(deps, {
      code,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('exchange unexpectedly succeeded');
    expect(trackFailure(result).error).toBe('invalid_grant');
    // Nothing was minted for `mcp tokens` to report as live.
    expect(oauthRepo.listTokens(t.scopes.instance())).toHaveLength(0);
  });
});

describe('refreshTokens', () => {
  it('rotates: the new pair verifies and the old refresh token is spent', () => {
    registerClient();
    const { issued } = fullFlow();
    const rotated = refreshTokens(deps, { refreshToken: issued.refreshToken, clientId: CLIENT });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) throw new Error('refresh failed');
    trackSecrets(rotated.accessToken, rotated.refreshToken);
    expect(verifyAccessToken(deps, rotated.accessToken)).toEqual({
      ok: true,
      accountId: ACCOUNT,
      clientId: CLIENT,
      tokenId: rotated.accessTokenId,
      scopes: ['bananasaurs:read'],
    });
  });

  it('refusal (d): presenting the old refresh token revokes the new pair', () => {
    registerClient();
    const { issued } = fullFlow();
    const rotated = refreshTokens(deps, { refreshToken: issued.refreshToken, clientId: CLIENT });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) throw new Error('refresh failed');
    trackSecrets(rotated.accessToken, rotated.refreshToken);
    const replay = refreshTokens(deps, { refreshToken: issued.refreshToken, clientId: CLIENT });
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error('refresh replay unexpectedly succeeded');
    expect(trackFailure(replay).error).toBe('invalid_grant');
    expect(
      oauthRepo.findTokenById(t.scopes.instance(), rotated.accessTokenId)?.revokedAt,
    ).not.toBeNull();
    expect(
      oauthRepo.findTokenById(t.scopes.instance(), rotated.refreshTokenId)?.revokedAt,
    ).not.toBeNull();
  });

  it('refusal (d) lineage: replaying the rotated refresh revokes all four rows, sibling included', () => {
    registerClient();
    const { issued } = fullFlow();
    const rotated = refreshTokens(deps, { refreshToken: issued.refreshToken, clientId: CLIENT });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) throw new Error('refresh failed');
    trackSecrets(rotated.accessToken, rotated.refreshToken);
    const replay = refreshTokens(deps, { refreshToken: issued.refreshToken, clientId: CLIENT });
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error('refresh replay unexpectedly succeeded');
    expect(trackFailure(replay).error).toBe('invalid_grant');
    // The sibling access token minted alongside the replayed refresh has
    // parentTokenId null, so a chain walk from the refresh never reaches it —
    // only the lineage (issuedFromCodeHash) kills the whole first pair.
    for (const tokenId of [
      issued.accessTokenId,
      issued.refreshTokenId,
      rotated.accessTokenId,
      rotated.refreshTokenId,
    ]) {
      expect(oauthRepo.findTokenById(t.scopes.instance(), tokenId)?.revokedAt).not.toBeNull();
    }
    expect(verifyAccessToken(deps, issued.accessToken)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('refuses an access token presented as a refresh token', () => {
    registerClient();
    const { issued } = fullFlow();
    const result = refreshTokens(deps, { refreshToken: issued.accessToken, clientId: CLIENT });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('refresh unexpectedly succeeded');
    expect(trackFailure(result).error).toBe('invalid_grant');
  });

  it('refuses the wrong client', () => {
    registerClient(CLIENT);
    registerClient(OTHER_CLIENT);
    const { issued } = fullFlow();
    const result = refreshTokens(deps, {
      refreshToken: issued.refreshToken,
      clientId: OTHER_CLIENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('refresh unexpectedly succeeded');
    expect(trackFailure(result).error).toBe('invalid_grant');
  });
});

describe('revokeByValue', () => {
  it('refusal (e): revoke at clock, verify at the same clock -> revoked, no grace', () => {
    registerClient();
    const { issued } = fullFlow();
    revokeByValue(deps, { token: issued.accessToken, clientId: CLIENT });
    expect(verifyAccessToken(deps, issued.accessToken)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('revoking a refresh token kills the access token minted alongside it', () => {
    registerClient();
    const { issued } = fullFlow();
    revokeByValue(deps, { token: issued.refreshToken, clientId: CLIENT });
    expect(verifyAccessToken(deps, issued.accessToken)).toEqual({ ok: false, reason: 'revoked' });
    const again = refreshTokens(deps, { refreshToken: issued.refreshToken, clientId: CLIENT });
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('refresh unexpectedly succeeded');
    expect(trackFailure(again).error).toBe('invalid_grant');
  });

  it('an unknown token and a client mismatch revoke nothing and reveal nothing', () => {
    registerClient();
    const { issued } = fullFlow();
    const unknown = generateToken();
    trackSecrets(unknown);
    expect(() => revokeByValue(deps, { token: unknown, clientId: CLIENT })).not.toThrow();
    revokeByValue(deps, { token: issued.accessToken, clientId: OTHER_CLIENT });
    expect(verifyAccessToken(deps, issued.accessToken).ok).toBe(true);
  });
});

describe('verifyAccessToken', () => {
  it('verifies a live token and records last use', () => {
    registerClient();
    const { issued } = fullFlow();
    expect(verifyAccessToken(deps, issued.accessToken)).toEqual({
      ok: true,
      accountId: ACCOUNT,
      clientId: CLIENT,
      tokenId: issued.accessTokenId,
      scopes: ['bananasaurs:read'],
    });
    expect(oauthRepo.findTokenById(t.scopes.instance(), issued.accessTokenId)?.lastUsedAt).toBe(
      clock,
    );
  });

  it('verifies a valid token under a read-only scope, leaving lastUsedAt untouched', () => {
    registerClient();
    const { issued } = fullFlow();
    // `t.readonlyScopes` is how `packages/http/src/test-support.ts` builds a
    // read-only scope: every write throws `ReadonlyError`
    // (`packages/storage/src/write.ts`).
    const roDeps: OAuthDeps = { scopes: t.readonlyScopes, now: () => clock, guildIds: [] };
    expect(verifyAccessToken(roDeps, issued.accessToken)).toEqual({
      ok: true,
      accountId: ACCOUNT,
      clientId: CLIENT,
      tokenId: issued.accessTokenId,
      scopes: ['bananasaurs:read'],
    });
    expect(oauthRepo.findTokenById(t.scopes.instance(), issued.accessTokenId)?.lastUsedAt).toBeNull();
  });

  it('reports unknown for a token that was never minted', () => {
    registerClient();
    const unknown = generateToken();
    trackSecrets(unknown);
    expect(verifyAccessToken(deps, unknown)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('reports not-access for a refresh token value', () => {
    registerClient();
    const { issued } = fullFlow();
    expect(verifyAccessToken(deps, issued.refreshToken)).toEqual({
      ok: false,
      reason: 'not-access',
    });
  });

  it('reports expired at clock + ACCESS_TOKEN_TTL_MS', () => {
    registerClient();
    const { issued } = fullFlow();
    clock += ACCESS_TOKEN_TTL_MS;
    expect(verifyAccessToken(deps, issued.accessToken)).toEqual({ ok: false, reason: 'expired' });
  });

  it('reports account-disabled after the owner is disabled', () => {
    registerClient();
    const { issued } = fullFlow();
    disableAccount();
    expect(verifyAccessToken(deps, issued.accessToken)).toEqual({
      ok: false,
      reason: 'account-disabled',
    });
  });

  it('reports account-gone after the account row is deleted', () => {
    registerClient();
    const { issued } = fullFlow();
    t.raw.prepare('DELETE FROM dashboard_accounts WHERE account_id = ?').run(ACCOUNT);
    expect(verifyAccessToken(deps, issued.accessToken)).toEqual({
      ok: false,
      reason: 'account-gone',
    });
  });

  it('no failure description contains a raw secret minted during this run', () => {
    expect(seenDescriptions.length).toBeGreaterThan(0);
    expect(seenSecrets.length).toBeGreaterThan(0);
    for (const description of seenDescriptions) {
      for (const secret of seenSecrets) {
        expect(description).not.toContain(secret);
      }
    }
  });
});
