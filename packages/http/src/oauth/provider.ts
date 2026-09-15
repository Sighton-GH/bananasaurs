import { createHash, randomBytes } from 'node:crypto';
import { accountRepo, oauthRepo, type ScopeFactory } from '@bananasaurs/storage';
import { generateToken, hashToken, secretsMatch } from '../secrets.js';

/**
 * Every lifetime ADR 0045 D4 settles, in one place.
 *
 * Constants rather than configuration, deliberately — each is a security
 * decision with a recorded reason, and changing one is an edit here and an
 * amendment there. Copied exactly from the ADR's table.
 */
export const ACCESS_TOKEN_TTL_MS = 3_600_000;
export const REFRESH_TOKEN_TTL_MS = 2_592_000_000;
export const AUTHORIZATION_CODE_TTL_MS = 300_000;
export const PENDING_AUTHORIZATION_TTL_MS = 600_000;

/** The scope vocabulary (ruling PR-103): exactly these two, not `write`. */
export const OAUTH_SCOPES = ['bananasaurs:read', 'bananasaurs:send'] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/** RFC 6749 §5.2 error codes this server emits. Task 4 maps them to HTTP. */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope';

export type OAuthFailure = {
  readonly ok: false;
  readonly error: OAuthErrorCode;
  readonly description: string;
};

export interface OAuthDeps {
  readonly scopes: ScopeFactory;
  /** Injected, like every clock in this tree. Never `Date.now()` in this file. */
  readonly now: () => number;
  /** The guilds this daemon serves (ruling PR-101). */
  readonly guildIds: readonly string[];
}

/**
 * OAuth 2.1 protocol logic with no Fastify in it.
 *
 * Every function takes plain inputs and returns plain results; Task 4 wraps
 * them in routes. Storage is reached only through Task 2's repository, and
 * every token, code and nonce is hashed with `hashToken` before it gets
 * there and compared with `secretsMatch` — never `===` on a secret. A raw
 * value never appears in an `Error`, a log call, or a result except the one
 * that mints it. There is deliberately no capability check here (PR-98):
 * the route does it, because the route can see the guilds and this layer
 * cannot.
 */

export interface BeginAuthorizationInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  /** Space-separated, per RFC 6749 §3.3. */
  readonly scope: string;
  readonly state: string | null;
}

export type BeginAuthorizationResult =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly nonce: string;
      readonly client: {
        readonly clientId: string;
        readonly clientName: string;
        readonly createdAt: number;
      };
      readonly redirectUriHost: string;
      readonly scopes: readonly OAuthScope[];
    }
  | OAuthFailure;

export const beginAuthorization = (
  deps: OAuthDeps,
  input: BeginAuthorizationInput,
): BeginAuthorizationResult => {
  const instance = deps.scopes.instance();
  const now = deps.now();
  const client = oauthRepo.findClient(instance, input.clientId);
  if (client === undefined) {
    return { ok: false, error: 'invalid_client', description: 'unknown client' };
  }
  if (!client.redirectUris.includes(input.redirectUri)) {
    return {
      ok: false,
      error: 'invalid_request',
      description: 'redirect_uri is not registered to this client',
    };
  }
  if (input.codeChallengeMethod !== 'S256') {
    return {
      ok: false,
      error: 'invalid_request',
      description: 'code_challenge_method must be S256',
    };
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
    return {
      ok: false,
      error: 'invalid_request',
      description: 'code_challenge must be 43 characters of base64url',
    };
  }
  const requested = input.scope.split(' ').filter((s) => s !== '');
  if (requested.length === 0) {
    return { ok: false, error: 'invalid_scope', description: 'scope must not be empty' };
  }
  const scopes: OAuthScope[] = [];
  for (const s of requested) {
    if ((OAUTH_SCOPES as readonly string[]).includes(s)) {
      scopes.push(s as OAuthScope);
    } else {
      return {
        ok: false,
        error: 'invalid_scope',
        description: 'scope includes a value this server does not issue',
      };
    }
  }
  const requestId = generateToken();
  const nonce = generateToken();
  oauthRepo.createPendingAuthorization(instance, {
    requestId,
    nonceHash: hashToken(nonce),
    clientId: client.clientId,
    redirectUri: input.redirectUri,
    scopes,
    codeChallenge: input.codeChallenge,
    state: input.state,
    createdAt: now,
    expiresAt: now + PENDING_AUTHORIZATION_TTL_MS,
  });
  return {
    ok: true,
    requestId,
    nonce,
    client: { clientId: client.clientId, clientName: client.clientName, createdAt: client.createdAt },
    redirectUriHost: new URL(input.redirectUri).host,
    scopes,
  };
};

export interface CompleteAuthorizationInput {
  readonly requestId: string;
  readonly nonce: string;
  /** The account the ROUTE has already authenticated and capability-checked (ruling PR-98). */
  readonly accountId: string;
}

export type CompleteAuthorizationResult =
  | {
      readonly ok: true;
      readonly code: string;
      readonly redirectUri: string;
      readonly state: string | null;
    }
  | OAuthFailure;

export const completeAuthorization = (
  deps: OAuthDeps,
  input: CompleteAuthorizationInput,
): CompleteAuthorizationResult => {
  const instance = deps.scopes.instance();
  const now = deps.now();
  const row = oauthRepo.consumePendingAuthorization(instance, input.requestId, now);
  if (row === undefined) {
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'authorization request is unknown, consumed or expired',
    };
  }
  if (!secretsMatch(hashToken(input.nonce), row.nonceHash)) {
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'authorization request nonce does not match',
    };
  }
  const code = generateToken();
  oauthRepo.createAuthorizationCode(instance, {
    codeHash: hashToken(code),
    clientId: row.clientId,
    accountId: input.accountId,
    scopes: [...row.scopes],
    codeChallenge: row.codeChallenge,
    redirectUri: row.redirectUri,
    createdAt: now,
    expiresAt: now + AUTHORIZATION_CODE_TTL_MS,
  });
  return { ok: true, code, redirectUri: row.redirectUri, state: row.state };
};

export interface ExchangeCodeInput {
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}

export interface IssuedTokens {
  readonly ok: true;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenId: string;
  readonly refreshTokenId: string;
  readonly expiresInSeconds: number;
  readonly scopes: readonly OAuthScope[];
}

const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier, 'utf8').digest('base64url');

const newTokenId = (): string => `tok_${randomBytes(16).toString('hex')}`;

export const exchangeCode = (
  deps: OAuthDeps,
  input: ExchangeCodeInput,
): IssuedTokens | OAuthFailure => {
  const instance = deps.scopes.instance();
  const now = deps.now();
  const codeHash = hashToken(input.code);
  const row = oauthRepo.findAuthorizationCode(instance, codeHash);
  if (row === undefined) {
    return { ok: false, error: 'invalid_grant', description: 'unknown authorization code' };
  }
  if (row.usedAt !== null) {
    oauthRepo.revokeTokensFromCode(instance, codeHash, now);
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'authorization code was already used',
    };
  }
  if (row.expiresAt <= now) {
    return { ok: false, error: 'invalid_grant', description: 'authorization code is expired' };
  }
  if (row.clientId !== input.clientId) {
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'authorization code was issued to a different client',
    };
  }
  const client = oauthRepo.findClient(instance, row.clientId);
  if (client === undefined) {
    return {
      ok: false,
      error: 'invalid_client',
      description: 'client for this authorization code no longer exists',
    };
  }
  if (row.redirectUri !== input.redirectUri) {
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'redirect_uri does not match the authorization request',
    };
  }
  if (!secretsMatch(s256(input.codeVerifier), row.codeChallenge)) {
    return { ok: false, error: 'invalid_grant', description: 'PKCE verification failed' };
  }
  // A code approved before the account was disabled must not mint: the tokens
  // would be inert (bearer and refresh both refuse), but `mcp tokens` would
  // report them live — the one column an operator triaging a compromise
  // reads. The same `findAccountById` + `disabled` check `refreshTokens`
  // already carries, before the code is consumed.
  const approver = accountRepo.findAccountById(instance, row.accountId);
  if (approver === undefined) {
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'account that approved this token no longer exists',
    };
  }
  if (approver.disabled) {
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'account that approved this token is disabled',
    };
  }
  const marked = oauthRepo.markAuthorizationCodeUsed(instance, codeHash, now);
  if (marked === 0) {
    oauthRepo.revokeTokensFromCode(instance, codeHash, now);
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'authorization code was already used',
    };
  }
  const accessToken = generateToken();
  const refreshToken = generateToken();
  const accessTokenId = newTokenId();
  const refreshTokenId = newTokenId();
  const scopes = [...row.scopes] as OAuthScope[];
  oauthRepo.createToken(instance, {
    tokenId: accessTokenId,
    tokenHash: hashToken(accessToken),
    kind: 'access',
    clientId: row.clientId,
    accountId: row.accountId,
    scopes,
    createdAt: now,
    expiresAt: now + ACCESS_TOKEN_TTL_MS,
    parentTokenId: null,
    issuedFromCodeHash: codeHash,
  });
  oauthRepo.createToken(instance, {
    tokenId: refreshTokenId,
    tokenHash: hashToken(refreshToken),
    kind: 'refresh',
    clientId: row.clientId,
    accountId: row.accountId,
    scopes,
    createdAt: now,
    expiresAt: now + REFRESH_TOKEN_TTL_MS,
    parentTokenId: null,
    issuedFromCodeHash: codeHash,
  });
  return {
    ok: true,
    accessToken,
    refreshToken,
    accessTokenId,
    refreshTokenId,
    expiresInSeconds: ACCESS_TOKEN_TTL_MS / 1000,
    scopes,
  };
};

export interface RefreshInput {
  readonly refreshToken: string;
  readonly clientId: string;
}

/**
 * The account behind a presented refresh token, for the route's PR-92
 * re-check. Returns `row.accountId` only when the row exists and
 * `kind === 'refresh'` — deliberately NO other checks (not revoked, not
 * expired, not this client, not the account): those stay `refreshTokens`'
 * job, so this cannot become a second, divergent copy of its logic. When
 * this returns `undefined` the route falls through to `refreshTokens`, which
 * owns the unknown-token wording and status.
 */
export const accountForRefreshToken = (
  deps: OAuthDeps,
  rawRefreshToken: string,
): string | undefined => {
  const row = oauthRepo.findTokenByHash(deps.scopes.instance(), hashToken(rawRefreshToken));
  if (row === undefined || row.kind !== 'refresh') return undefined;
  return row.accountId;
};

export const refreshTokens = (
  deps: OAuthDeps,
  input: RefreshInput,
): IssuedTokens | OAuthFailure => {
  const instance = deps.scopes.instance();
  const now = deps.now();
  const row = oauthRepo.findTokenByHash(instance, hashToken(input.refreshToken));
  if (row === undefined) {
    return { ok: false, error: 'invalid_grant', description: 'unknown refresh token' };
  }
  if (row.kind !== 'refresh') {
    return { ok: false, error: 'invalid_grant', description: 'not a refresh token' };
  }
  if (row.revokedAt !== null) {
    // Ruling PR-118: a replay kills the LINEAGE, not the chain. The sibling
    // access token minted alongside this refresh by `exchangeCode` has
    // `parentTokenId: null`, so it is not a descendant and a chain walk from
    // the presented token leaves it live — the token a leak most likely
    // exposed outliving the leak signal. Every row carries the inherited
    // `issuedFromCodeHash` (PR-94), so revoking by code reaches the whole
    // lineage from any member of it — the same choice `revokeByValue` makes.
    oauthRepo.revokeTokensFromCode(instance, row.issuedFromCodeHash, now);
    return { ok: false, error: 'invalid_grant', description: 'refresh token was already used' };
  }
  if (row.expiresAt <= now) {
    return { ok: false, error: 'invalid_grant', description: 'refresh token is expired' };
  }
  if (row.clientId !== input.clientId) {
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'refresh token was issued to a different client',
    };
  }
  const account = accountRepo.findAccountById(instance, row.accountId);
  if (account === undefined) {
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'account that approved this token no longer exists',
    };
  }
  if (account.disabled) {
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'account that approved this token is disabled',
    };
  }
  const accessToken = generateToken();
  const refreshToken = generateToken();
  const accessTokenId = newTokenId();
  const refreshTokenId = newTokenId();
  oauthRepo.rotateRefreshToken(instance, {
    oldRefreshTokenId: row.tokenId,
    newAccess: {
      tokenId: accessTokenId,
      tokenHash: hashToken(accessToken),
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
    },
    newRefresh: {
      tokenId: refreshTokenId,
      tokenHash: hashToken(refreshToken),
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
    },
    now,
  });
  const scopes = [...row.scopes] as OAuthScope[];
  return {
    ok: true,
    accessToken,
    refreshToken,
    accessTokenId,
    refreshTokenId,
    expiresInSeconds: ACCESS_TOKEN_TTL_MS / 1000,
    scopes,
  };
};

export const revokeByValue = (
  deps: OAuthDeps,
  input: { readonly token: string; readonly clientId: string },
): void => {
  const instance = deps.scopes.instance();
  const now = deps.now();
  const row = oauthRepo.findTokenByHash(instance, hashToken(input.token));
  if (row === undefined) return;
  if (row.clientId !== input.clientId) return;
  if (row.kind === 'refresh') {
    // A refresh revocation kills the access token minted alongside it and
    // everything after: the whole lineage shares one issuedFromCodeHash
    // (ruling PR-94), so revoking by code reaches the sibling — which has
    // parentTokenId null and is therefore NOT a chain descendant — as well
    // as every rotation. An access revocation kills just it.
    oauthRepo.revokeTokensFromCode(instance, row.issuedFromCodeHash, now);
  } else {
    oauthRepo.revokeTokenChain(instance, row.tokenId, now);
  }
};

export interface VerifiedToken {
  readonly ok: true;
  readonly accountId: string;
  readonly clientId: string;
  readonly tokenId: string;
  readonly scopes: readonly OAuthScope[];
}

export type VerifyFailure = {
  readonly ok: false;
  readonly reason:
    'unknown' | 'not-access' | 'revoked' | 'expired' | 'account-gone' | 'account-disabled';
};

export const verifyAccessToken = (
  deps: OAuthDeps,
  rawToken: string,
): VerifiedToken | VerifyFailure => {
  const instance = deps.scopes.instance();
  const now = deps.now();
  const row = oauthRepo.findTokenByHash(instance, hashToken(rawToken));
  if (row === undefined) return { ok: false, reason: 'unknown' };
  if (row.kind !== 'access') return { ok: false, reason: 'not-access' };
  if (row.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (row.expiresAt <= now) return { ok: false, reason: 'expired' };
  const account = accountRepo.findAccountById(instance, row.accountId);
  if (account === undefined) return { ok: false, reason: 'account-gone' };
  if (account.disabled) return { ok: false, reason: 'account-disabled' };
  try {
    oauthRepo.touchToken(instance, row.tokenId, now);
  } catch {
    // `lastUsedAt` is telemetry for `mcp tokens`; it must never gate
    // authentication. Under BANANASAURS_READONLY every write throws
    // (packages/storage/src/write.ts), and a read-only daemon must still
    // be able to verify a token — that is precisely what read-only mode
    // is for. Swallowed deliberately, and only here.
  }
  return {
    ok: true,
    accountId: row.accountId,
    clientId: row.clientId,
    tokenId: row.tokenId,
    scopes: [...row.scopes] as OAuthScope[],
  };
};
