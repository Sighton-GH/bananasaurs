import { createHash } from 'node:crypto';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { InstanceScope } from '../scope.js';
import { readInstance, writeInstance } from '../write.js';
import {
  oauthAuthorizationCodes,
  oauthClients,
  oauthPendingAuthorizations,
  oauthTokens,
} from '../schema.js';

/**
 * OAuth 2.1 clients, pending consent forms, authorization codes and tokens.
 *
 * Instance-level throughout (ADR 0045 D3, Amendment 1 PR-92): a client is
 * registered against the daemon, a token carries no guild, and the guilds a
 * token can reach are computed live per call from the approving account's
 * current grants. The `InstanceScope` first parameter is what says so.
 *
 * **No hashing happens here.** Every function takes an already-hashed value
 * (`tokenHash`, `codeHash`, `nonceHash`) — the caller in `packages/http`
 * hashes, and this module never sees a raw token. This is the same boundary
 * `auth.ts` keeps with `sessionRepo`: hash outside, write the hash inside.
 *
 * **No `guild_id` anywhere in this module**, and no clock: timestamps are
 * INTEGER epoch millis passed in as `now`, never `Date.now()`.
 */

export type OAuthRegistrationSource = 'dynamic' | 'cli';
export type OAuthTokenKind = 'access' | 'refresh';

export interface OAuthClientRow {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly createdAt: number;
  readonly createdByAccountId: string | null;
  readonly registrationSource: OAuthRegistrationSource;
}

export interface OAuthPendingRow {
  readonly requestId: string;
  readonly nonceHash: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly codeChallenge: string;
  readonly state: string | null;
  readonly expiresAt: number;
}

export interface OAuthCodeRow {
  readonly codeHash: string;
  readonly clientId: string;
  readonly accountId: string;
  readonly scopes: readonly string[];
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
  readonly usedAt: number | null;
}

export interface OAuthTokenRow {
  readonly tokenId: string;
  readonly kind: OAuthTokenKind;
  readonly clientId: string;
  readonly accountId: string;
  readonly scopes: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly lastUsedAt: number | null;
  readonly parentTokenId: string | null;
  readonly issuedFromCodeHash: string;
}

const stringArraySchema = z.array(z.string());

/**
 * Scopes and redirect URIs are stored as JSON text. A malformed row throws —
 * it never yields `undefined` or an empty array silently, because a token
 * whose scopes failed to parse would otherwise authorize with no scopes at
 * all, or with whatever the caller assumed.
 */
const parseStringArray = (raw: string): readonly string[] =>
  stringArraySchema.parse(JSON.parse(raw));

const CLIENT_SELECT = {
  clientId: oauthClients.clientId,
  clientName: oauthClients.clientName,
  redirectUris: oauthClients.redirectUris,
  createdAt: oauthClients.createdAt,
  createdByAccountId: oauthClients.createdByAccountId,
  registrationSource: oauthClients.registrationSource,
};

const toClientRow = (r: {
  clientId: string;
  clientName: string;
  redirectUris: string;
  createdAt: number;
  createdByAccountId: string | null;
  registrationSource: string;
}): OAuthClientRow => ({
  clientId: r.clientId,
  clientName: r.clientName,
  redirectUris: parseStringArray(r.redirectUris),
  createdAt: r.createdAt,
  createdByAccountId: r.createdByAccountId,
  registrationSource: r.registrationSource as OAuthRegistrationSource,
});

const PENDING_SELECT = {
  requestId: oauthPendingAuthorizations.requestId,
  nonceHash: oauthPendingAuthorizations.nonceHash,
  clientId: oauthPendingAuthorizations.clientId,
  redirectUri: oauthPendingAuthorizations.redirectUri,
  scopes: oauthPendingAuthorizations.scopes,
  codeChallenge: oauthPendingAuthorizations.codeChallenge,
  state: oauthPendingAuthorizations.state,
  expiresAt: oauthPendingAuthorizations.expiresAt,
};

const toPendingRow = (r: {
  requestId: string;
  nonceHash: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  codeChallenge: string;
  state: string | null;
  expiresAt: number;
}): OAuthPendingRow => ({
  requestId: r.requestId,
  nonceHash: r.nonceHash,
  clientId: r.clientId,
  redirectUri: r.redirectUri,
  scopes: parseStringArray(r.scopes),
  codeChallenge: r.codeChallenge,
  state: r.state,
  expiresAt: r.expiresAt,
});

const CODE_SELECT = {
  codeHash: oauthAuthorizationCodes.codeHash,
  clientId: oauthAuthorizationCodes.clientId,
  accountId: oauthAuthorizationCodes.accountId,
  scopes: oauthAuthorizationCodes.scopes,
  codeChallenge: oauthAuthorizationCodes.codeChallenge,
  redirectUri: oauthAuthorizationCodes.redirectUri,
  expiresAt: oauthAuthorizationCodes.expiresAt,
  usedAt: oauthAuthorizationCodes.usedAt,
};

const toCodeRow = (r: {
  codeHash: string;
  clientId: string;
  accountId: string;
  scopes: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
  usedAt: number | null;
}): OAuthCodeRow => ({
  codeHash: r.codeHash,
  clientId: r.clientId,
  accountId: r.accountId,
  scopes: parseStringArray(r.scopes),
  codeChallenge: r.codeChallenge,
  redirectUri: r.redirectUri,
  expiresAt: r.expiresAt,
  usedAt: r.usedAt,
});

const TOKEN_SELECT = {
  tokenId: oauthTokens.tokenId,
  kind: oauthTokens.kind,
  clientId: oauthTokens.clientId,
  accountId: oauthTokens.accountId,
  scopes: oauthTokens.scopes,
  createdAt: oauthTokens.createdAt,
  expiresAt: oauthTokens.expiresAt,
  revokedAt: oauthTokens.revokedAt,
  lastUsedAt: oauthTokens.lastUsedAt,
  parentTokenId: oauthTokens.parentTokenId,
  issuedFromCodeHash: oauthTokens.issuedFromCodeHash,
};

const toTokenRow = (r: {
  tokenId: string;
  kind: string;
  clientId: string;
  accountId: string;
  scopes: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
  parentTokenId: string | null;
  issuedFromCodeHash: string;
}): OAuthTokenRow => ({
  tokenId: r.tokenId,
  kind: r.kind as OAuthTokenKind,
  clientId: r.clientId,
  accountId: r.accountId,
  scopes: parseStringArray(r.scopes),
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  revokedAt: r.revokedAt,
  lastUsedAt: r.lastUsedAt,
  parentTokenId: r.parentTokenId,
  issuedFromCodeHash: r.issuedFromCodeHash,
});

// --- clients ---------------------------------------------------------------

export const createClient = (
  scope: InstanceScope,
  input: {
    readonly clientId: string;
    readonly clientName: string;
    readonly redirectUris: readonly string[];
    readonly createdAt: number;
    readonly createdByAccountId: string | null;
    readonly registrationSource: OAuthRegistrationSource;
  },
): void =>
  writeInstance(scope, ({ db }) => {
    db.insert(oauthClients)
      .values({
        clientId: input.clientId,
        clientName: input.clientName,
        redirectUris: JSON.stringify(input.redirectUris),
        createdAt: input.createdAt,
        createdByAccountId: input.createdByAccountId,
        registrationSource: input.registrationSource,
      })
      .run();
  });

export const findClient = (scope: InstanceScope, clientId: string): OAuthClientRow | undefined => {
  const row = readInstance(scope, (db) =>
    db.select(CLIENT_SELECT).from(oauthClients).where(eq(oauthClients.clientId, clientId)).get(),
  );
  return row === undefined ? undefined : toClientRow(row);
};

export const listClients = (scope: InstanceScope): readonly OAuthClientRow[] =>
  readInstance(scope, (db) =>
    db
      .select(CLIENT_SELECT)
      .from(oauthClients)
      .orderBy(asc(oauthClients.createdAt), asc(oauthClients.clientId))
      .all()
      .map(toClientRow),
  );

/**
 * Deletes the client, revokes every unrevoked token it holds, AND deletes its
 * pending authorizations and authorization codes — all in ONE write
 * transaction (ruling PR-109: the tables have no foreign keys by design, so
 * this is where the orphan is prevented). A deleted client must leave nothing
 * exchangeable: an unconsumed pending row or an unused code would otherwise
 * survive the client they were issued for. All codes go, used or not — a used
 * code for a deleted client has no audit value the token rows do not already
 * carry. Returns the number of tokens revoked. Deleting an unknown client
 * returns 0 and deletes nothing.
 */
export const deleteClient = (scope: InstanceScope, clientId: string, now: number): number =>
  writeInstance(scope, ({ db }) => {
    const deleted = db.delete(oauthClients).where(eq(oauthClients.clientId, clientId)).run();
    if (deleted.changes === 0) return 0;
    const revoked = db
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.clientId, clientId), isNull(oauthTokens.revokedAt)))
      .run();
    db.delete(oauthPendingAuthorizations)
      .where(eq(oauthPendingAuthorizations.clientId, clientId))
      .run();
    db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.clientId, clientId)).run();
    return revoked.changes;
  });

// --- pending authorizations --------------------------------------------------

export const createPendingAuthorization = (
  scope: InstanceScope,
  input: {
    readonly requestId: string;
    readonly nonceHash: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly scopes: readonly string[];
    readonly codeChallenge: string;
    readonly state: string | null;
    readonly createdAt: number;
    readonly expiresAt: number;
  },
): void =>
  writeInstance(scope, ({ db }) => {
    db.insert(oauthPendingAuthorizations)
      .values({
        requestId: input.requestId,
        nonceHash: input.nonceHash,
        clientId: input.clientId,
        redirectUri: input.redirectUri,
        scopes: JSON.stringify(input.scopes),
        codeChallenge: input.codeChallenge,
        state: input.state,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      })
      .run();
  });

/**
 * Single-use. Marks the row consumed and returns it ONLY if it was unconsumed
 * and unexpired at `now`. Atomic: the UPDATE carries
 * `consumed_at IS NULL AND expires_at > ?` in its WHERE and the row is
 * returned only when `changes === 1`.
 */
export const consumePendingAuthorization = (
  scope: InstanceScope,
  requestId: string,
  now: number,
): OAuthPendingRow | undefined =>
  writeInstance(scope, ({ db }) => {
    const result = db
      .update(oauthPendingAuthorizations)
      .set({ consumedAt: now })
      .where(
        and(
          eq(oauthPendingAuthorizations.requestId, requestId),
          isNull(oauthPendingAuthorizations.consumedAt),
          sql`${oauthPendingAuthorizations.expiresAt} > ${now}`,
        ),
      )
      .run();
    if (result.changes !== 1) return undefined;
    // The UPDATE matched exactly one row by primary key, so the row below
    // exists; the guard is for the typechecker, not for a case that happens.
    const row = db
      .select(PENDING_SELECT)
      .from(oauthPendingAuthorizations)
      .where(eq(oauthPendingAuthorizations.requestId, requestId))
      .get();
    return row === undefined ? undefined : toPendingRow(row);
  });

// --- authorization codes -----------------------------------------------------

export const createAuthorizationCode = (
  scope: InstanceScope,
  input: {
    readonly codeHash: string;
    readonly clientId: string;
    readonly accountId: string;
    readonly scopes: readonly string[];
    readonly codeChallenge: string;
    readonly redirectUri: string;
    readonly createdAt: number;
    readonly expiresAt: number;
  },
): void =>
  writeInstance(scope, ({ db }) => {
    db.insert(oauthAuthorizationCodes)
      .values({
        codeHash: input.codeHash,
        clientId: input.clientId,
        accountId: input.accountId,
        scopes: JSON.stringify(input.scopes),
        codeChallenge: input.codeChallenge,
        redirectUri: input.redirectUri,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      })
      .run();
  });

/** Reads WITHOUT consuming: the exchange must tell "already used" from "unknown". */
export const findAuthorizationCode = (
  scope: InstanceScope,
  codeHash: string,
): OAuthCodeRow | undefined => {
  const row = readInstance(scope, (db) =>
    db
      .select(CODE_SELECT)
      .from(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.codeHash, codeHash))
      .get(),
  );
  return row === undefined ? undefined : toCodeRow(row);
};

/**
 * Ruling PR-100: `UPDATE … SET used_at = ? WHERE code_hash = ? AND used_at IS
 * NULL`. Returns the number of rows changed — 1 on the first call, 0 on every
 * later one. The CALLER checks the count; 0 means a concurrent or repeated
 * exchange won, and is treated as a replay.
 */
export const markAuthorizationCodeUsed = (
  scope: InstanceScope,
  codeHash: string,
  now: number,
): number =>
  writeInstance(scope, ({ db }) => {
    const result = db
      .update(oauthAuthorizationCodes)
      .set({ usedAt: now })
      .where(
        and(eq(oauthAuthorizationCodes.codeHash, codeHash), isNull(oauthAuthorizationCodes.usedAt)),
      )
      .run();
    return result.changes;
  });

// --- tokens ------------------------------------------------------------------

export const createToken = (
  scope: InstanceScope,
  input: {
    readonly tokenId: string;
    readonly tokenHash: string;
    readonly kind: OAuthTokenKind;
    readonly clientId: string;
    readonly accountId: string;
    readonly scopes: readonly string[];
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly parentTokenId: string | null;
    readonly issuedFromCodeHash: string;
  },
): void =>
  writeInstance(scope, ({ db }) => {
    db.insert(oauthTokens)
      .values({
        tokenId: input.tokenId,
        tokenHash: input.tokenHash,
        kind: input.kind,
        clientId: input.clientId,
        accountId: input.accountId,
        scopes: JSON.stringify(input.scopes),
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        parentTokenId: input.parentTokenId,
        issuedFromCodeHash: input.issuedFromCodeHash,
      })
      .run();
  });

/**
 * The row for a token hash, whatever its state. Deliberately returns revoked
 * rows rather than hiding them — deciding is the caller's job, and the
 * caller has to distinguish "no such token" from "your token was revoked".
 */
export const findTokenByHash = (
  scope: InstanceScope,
  tokenHash: string,
): OAuthTokenRow | undefined => {
  const row = readInstance(scope, (db) =>
    db.select(TOKEN_SELECT).from(oauthTokens).where(eq(oauthTokens.tokenHash, tokenHash)).get(),
  );
  return row === undefined ? undefined : toTokenRow(row);
};

export const findTokenById = (scope: InstanceScope, tokenId: string): OAuthTokenRow | undefined => {
  const row = readInstance(scope, (db) =>
    db.select(TOKEN_SELECT).from(oauthTokens).where(eq(oauthTokens.tokenId, tokenId)).get(),
  );
  return row === undefined ? undefined : toTokenRow(row);
};

export const listTokens = (scope: InstanceScope): readonly OAuthTokenRow[] =>
  readInstance(scope, (db) =>
    db
      .select(TOKEN_SELECT)
      .from(oauthTokens)
      .orderBy(asc(oauthTokens.createdAt), asc(oauthTokens.tokenId))
      .all()
      .map(toTokenRow),
  );

export const touchToken = (scope: InstanceScope, tokenId: string, now: number): void =>
  writeInstance(scope, ({ db }) => {
    db.update(oauthTokens).set({ lastUsedAt: now }).where(eq(oauthTokens.tokenId, tokenId)).run();
  });

/** Returns 1 if the token was live and is now revoked; 0 if unknown or already revoked. */
export const revokeToken = (scope: InstanceScope, tokenId: string, now: number): number =>
  writeInstance(scope, ({ db }) => {
    const result = db
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.tokenId, tokenId), isNull(oauthTokens.revokedAt)))
      .run();
    return result.changes;
  });

/** ADR 0045 D5's replay cascade: every UNREVOKED token whose issued_from_code_hash matches. */
export const revokeTokensFromCode = (scope: InstanceScope, codeHash: string, now: number): number =>
  writeInstance(scope, ({ db }) => {
    const result = db
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.issuedFromCodeHash, codeHash), isNull(oauthTokens.revokedAt)))
      .run();
    return result.changes;
  });

/** Every unrevoked token of this client. Returns the count. */
export const revokeTokensForClient = (
  scope: InstanceScope,
  clientId: string,
  now: number,
): number =>
  writeInstance(scope, ({ db }) => {
    const result = db
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.clientId, clientId), isNull(oauthTokens.revokedAt)))
      .run();
    return result.changes;
  });

/**
 * Revokes every live token of one account (ADR 0045 Amendment 4 A3-5).
 *
 * The predicate is the ACCOUNT, which is a strict superset of both lineage
 * and chain, so the "choose lineage over descent" obligation ADR 0044 places
 * on a new revocation surface does not arise — the hazard PR-127 names, a
 * walk that spares the sibling token minted beside the one you revoked,
 * cannot happen when every token the account owns is in scope. An
 * already-revoked row keeps its earlier `revokedAt`: the `isNull` guard means
 * a second sweep reports only what was still live.
 *
 * `deleteAccount` in `accounts.ts` runs the same statement inline and must
 * NOT be changed to call this: it needs the write inside its own transaction
 * and `writeInstance` does not nest.
 */
export const revokeAllTokensForAccount = (
  scope: InstanceScope,
  input: { accountId: string; now: number },
): number =>
  writeInstance(scope, ({ db }) => {
    const result = db
      .update(oauthTokens)
      .set({ revokedAt: input.now })
      .where(and(eq(oauthTokens.accountId, input.accountId), isNull(oauthTokens.revokedAt)))
      .run();
    return result.changes;
  });

/**
 * Deletes every authorization code one account consented to (ADR 0045 Amendment 4 A3-6).
 *
 * A code is an unminted token: `exchangeCode` gates only on the code's own
 * expiry and on `approver.disabled`, so revoking the account's live tokens
 * cannot stop a leaked code from minting a fresh pair. The sweep that ends
 * "every credential the account owns" must therefore delete its codes too.
 *
 * `deleteAccount` in `accounts.ts` runs the same statement inline and must
 * NOT be changed to call this: it needs the delete inside its own transaction
 * and `writeInstance` does not nest.
 */
export const deleteAuthorizationCodesForAccount = (
  scope: InstanceScope,
  accountId: string,
): number =>
  writeInstance(scope, ({ db }) => {
    const result = db
      .delete(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.accountId, accountId))
      .run();
    return result.changes;
  });

/**
 * Ruling PR-99: revokes `rootTokenId` and every unrevoked descendant reached
 * by following `parent_token_id` downward. Returns the count. A recursive
 * CTE is the right tool; the chain is short.
 */
export const revokeTokenChain = (scope: InstanceScope, rootTokenId: string, now: number): number =>
  writeInstance(scope, ({ db }) => {
    const result = db.run(sql`
      WITH RECURSIVE chain(token_id) AS (
        SELECT ${rootTokenId}
        UNION ALL
        SELECT t.token_id FROM oauth_tokens AS t JOIN chain AS c ON t.parent_token_id = c.token_id
      )
      UPDATE oauth_tokens SET revoked_at = ${now}
      WHERE revoked_at IS NULL AND token_id IN (SELECT token_id FROM chain)
    `);
    return result.changes;
  });

/**
 * Ruling PR-99: ONE write transaction that (1) revokes `oldRefreshTokenId` —
 * refusing with a thrown Error if it is not a live refresh token — and (2)
 * inserts the new access and refresh rows, both with
 * `parentTokenId = oldRefreshTokenId` and `issuedFromCodeHash` COPIED FROM
 * THE OLD ROW (ruling PR-94 — never from the caller). Returns nothing; the
 * caller already holds the new ids.
 */
export const rotateRefreshToken = (
  scope: InstanceScope,
  input: {
    readonly oldRefreshTokenId: string;
    readonly newAccess: {
      readonly tokenId: string;
      readonly tokenHash: string;
      readonly expiresAt: number;
    };
    readonly newRefresh: {
      readonly tokenId: string;
      readonly tokenHash: string;
      readonly expiresAt: number;
    };
    readonly now: number;
  },
): void =>
  writeInstance(scope, ({ db }) => {
    const old = db
      .select({
        kind: oauthTokens.kind,
        revokedAt: oauthTokens.revokedAt,
        clientId: oauthTokens.clientId,
        accountId: oauthTokens.accountId,
        scopes: oauthTokens.scopes,
        issuedFromCodeHash: oauthTokens.issuedFromCodeHash,
      })
      .from(oauthTokens)
      .where(eq(oauthTokens.tokenId, input.oldRefreshTokenId))
      .get();
    if (old === undefined || old.kind !== 'refresh' || old.revokedAt !== null) {
      throw new Error(
        `refusing to rotate a token that is not a live refresh token: ${input.oldRefreshTokenId}`,
      );
    }
    db.update(oauthTokens)
      .set({ revokedAt: input.now })
      .where(eq(oauthTokens.tokenId, input.oldRefreshTokenId))
      .run();
    // Parsed, not copied raw: a malformed scopes row throws here rather than
    // propagating into two new rows.
    const scopes = parseStringArray(old.scopes);
    for (const [next, kind] of [
      [input.newAccess, 'access'],
      [input.newRefresh, 'refresh'],
    ] as const) {
      db.insert(oauthTokens)
        .values({
          tokenId: next.tokenId,
          tokenHash: next.tokenHash,
          kind,
          clientId: old.clientId,
          accountId: old.accountId,
          scopes: JSON.stringify(scopes),
          createdAt: input.now,
          expiresAt: next.expiresAt,
          parentTokenId: input.oldRefreshTokenId,
          issuedFromCodeHash: old.issuedFromCodeHash,
        })
        .run();
    }
  });

/** ADR 0127: a token is deleted this long after it expires, revoked or not. */
export const OAUTH_TOKEN_RETENTION_AFTER_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Ruling PR-108: deletes expired pending rows and expired codes at expiry;
 * tokens are deleted 14 days after expiry whether or not they were revoked
 * (ADR 0127), because rotation never revokes the old access token, so the
 * old "expired AND revoked" rule left those forever. Safe: an expired token
 * can't authenticate, rotated access tokens are leaves of the refresh chain
 * (`parent_token_id` points at a refresh token, see `revokeTokenChain`) so
 * deleting them can't weaken reuse detection, and a revoked-but-unexpired
 * token is still kept so `mcp tokens` can show what was revoked and when.
 * Returns counts.
 */
export const purgeExpired = (
  scope: InstanceScope,
  now: number,
): { readonly pending: number; readonly codes: number; readonly tokens: number } =>
  writeInstance(scope, ({ db }) => {
    const pending = db
      .delete(oauthPendingAuthorizations)
      .where(lte(oauthPendingAuthorizations.expiresAt, now))
      .run();
    const codes = db
      .delete(oauthAuthorizationCodes)
      .where(lte(oauthAuthorizationCodes.expiresAt, now))
      .run();
    const tokens = db
      .delete(oauthTokens)
      .where(lte(oauthTokens.expiresAt, now - OAUTH_TOKEN_RETENTION_AFTER_EXPIRY_MS))
      .run();
    return { pending: pending.changes, codes: codes.changes, tokens: tokens.changes };
  });

// --- connections (ADR 0130) ---------------------------------------------------

export type OAuthConnectionStatus = 'connected' | 'expired' | 'revoked';

/**
 * One sign-in: every token row sharing an `issued_from_code_hash`. The public
 * id is `connectionIdFor` of that hash — stable for the connection's whole
 * life, whichever of its rows cleanup or the 14-day purge removes — and never
 * the code hash itself.
 */
export interface OAuthConnectionRow {
  readonly connectionId: string;
  readonly accountId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly status: OAuthConnectionStatus;
  readonly tokenCount: number;
}

/**
 * The public id of the connection minted from `codeHash`. A digest of a digest
 * of a single-use, already-spent code: it names the connection and unlocks
 * nothing.
 */
export const connectionIdFor = (codeHash: string): string =>
  `conn_${createHash('sha256').update(codeHash).digest('hex').slice(0, 24)}`;

type Db = Parameters<Parameters<typeof writeInstance>[1]>[0]['db'];

/** The code hash behind a public connection id, or `undefined` when no row carries it. */
const codeHashOfConnection = (db: Db, connectionId: string): string | undefined =>
  db
    .selectDistinct({ code: oauthTokens.issuedFromCodeHash })
    .from(oauthTokens)
    .all()
    .find((row) => connectionIdFor(row.code) === connectionId)?.code;

/** Whether any row of the connection can still authenticate. */
const connectionIsLive = (db: Db, codeHash: string, now: number): boolean =>
  db
    .select({ tokenId: oauthTokens.tokenId })
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.issuedFromCodeHash, codeHash),
        isNull(oauthTokens.revokedAt),
        sql`${oauthTokens.expiresAt} > ${now}`,
      ),
    )
    .get() !== undefined;

/** tokenId -> connectionId for every token row, so a raw token can be filtered by connection. */
export const tokenConnectionIds = (scope: InstanceScope): ReadonlyMap<string, string> => {
  const rows = readInstance(scope, (db) =>
    db
      .select({ tokenId: oauthTokens.tokenId, code: oauthTokens.issuedFromCodeHash })
      .from(oauthTokens)
      .all(),
  );
  return new Map(rows.map((row) => [row.tokenId, connectionIdFor(row.code)]));
};

/**
 * Connections, connected first then newest. Grouped in memory: the table is
 * bounded by the 14-day purge, and a group needs the min/max/newest-row
 * aggregates the status rule reads.
 */
export const listConnections = (
  scope: InstanceScope,
  now: number,
): readonly OAuthConnectionRow[] => {
  const rows = readInstance(scope, (db) => db.select(TOKEN_SELECT).from(oauthTokens).all());
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = groups.get(row.issuedFromCodeHash);
    if (group === undefined) groups.set(row.issuedFromCodeHash, [row]);
    else group.push(row);
  }
  const byCreated = (a: { createdAt: number; tokenId: string }, b: typeof a): number =>
    a.createdAt - b.createdAt || (a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0);
  const out: OAuthConnectionRow[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort(byCreated);
    const root = ordered[0];
    const newest = ordered[ordered.length - 1];
    if (root === undefined || newest === undefined) continue;
    let lastUsedAt: number | null = null;
    for (const r of group) {
      if (r.lastUsedAt !== null && (lastUsedAt === null || r.lastUsedAt > lastUsedAt)) {
        lastUsedAt = r.lastUsedAt;
      }
    }
    const live = group.some((r) => r.revokedAt === null && r.expiresAt > now);
    const allRevoked = group.every((r) => r.revokedAt !== null);
    out.push({
      connectionId: connectionIdFor(root.issuedFromCodeHash),
      accountId: root.accountId,
      clientId: root.clientId,
      scopes: parseStringArray(newest.scopes),
      createdAt: root.createdAt,
      lastUsedAt,
      status: live ? 'connected' : allRevoked ? 'revoked' : 'expired',
      tokenCount: group.length,
    });
  }
  return out.sort((a, b) => {
    const ca = a.status === 'connected' ? 0 : 1;
    const cb = b.status === 'connected' ? 0 : 1;
    return ca - cb || b.createdAt - a.createdAt || (a.connectionId < b.connectionId ? -1 : 1);
  });
};

/**
 * Revokes every live row of the connection and keeps the rows. Returns the
 * number revoked, or `undefined` for an unknown id.
 */
export const revokeConnection = (
  scope: InstanceScope,
  connectionId: string,
  now: number,
): number | undefined =>
  writeInstance(scope, ({ db }) => {
    const code = codeHashOfConnection(db, connectionId);
    if (code === undefined) return undefined;
    return db
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.issuedFromCodeHash, code), isNull(oauthTokens.revokedAt)))
      .run().changes;
  });

/**
 * ONE transaction: revoke every live row of the connection, then delete all
 * its rows. `undefined` for an unknown id.
 */
export const deleteConnection = (
  scope: InstanceScope,
  connectionId: string,
  now: number,
): { readonly revoked: number; readonly deleted: number } | undefined =>
  writeInstance(scope, ({ db }) => {
    const code = codeHashOfConnection(db, connectionId);
    if (code === undefined) return undefined;
    const revoked = db
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.issuedFromCodeHash, code), isNull(oauthTokens.revokedAt)))
      .run().changes;
    const deleted = db.delete(oauthTokens).where(eq(oauthTokens.issuedFromCodeHash, code)).run();
    return { revoked, deleted: deleted.changes };
  });

/**
 * ONE transaction: when the row's connection can still authenticate, the
 * whole connection is revoked first, then that one row is deleted.
 * `undefined` for an unknown id.
 *
 * Revoking even for a dead row of a live connection is deliberate: a revoked
 * refresh row is what lets `refreshTokens` spot a replay and revoke the
 * lineage (it checks `revokedAt` before expiry), so deleting one from a live
 * connection would silently disarm that check. Deleting it disconnects
 * instead.
 */
export const deleteToken = (
  scope: InstanceScope,
  tokenId: string,
  now: number,
): { readonly revoked: number; readonly deleted: number } | undefined =>
  writeInstance(scope, ({ db }) => {
    const row = db
      .select({
        code: oauthTokens.issuedFromCodeHash,
        revokedAt: oauthTokens.revokedAt,
        expiresAt: oauthTokens.expiresAt,
      })
      .from(oauthTokens)
      .where(eq(oauthTokens.tokenId, tokenId))
      .get();
    if (row === undefined) return undefined;
    let revoked = 0;
    if (connectionIsLive(db, row.code, now)) {
      revoked = db
        .update(oauthTokens)
        .set({ revokedAt: now })
        .where(and(eq(oauthTokens.issuedFromCodeHash, row.code), isNull(oauthTokens.revokedAt)))
        .run().changes;
    }
    const deleted = db.delete(oauthTokens).where(eq(oauthTokens.tokenId, tokenId)).run();
    return { revoked, deleted: deleted.changes };
  });

/** An app registered less than this long ago may be mid-sign-in; cleanup spares it. */
export const OAUTH_CLIENT_CLEANUP_GRACE_MS = 60 * 60 * 1000;

/**
 * ONE transaction: delete every token row of every connection that can no
 * longer authenticate — no unrevoked, unexpired row left — then every
 * client left with no token row, no unexpired pending authorization and no
 * unexpired authorization code that was registered over an hour ago. The
 * tables have no foreign keys (ruling PR-109), so the NOT EXISTS checks here
 * are the whole safeguard.
 */
export const cleanupDead = (
  scope: InstanceScope,
  now: number,
): { readonly tokens: number; readonly clients: number } =>
  writeInstance(scope, ({ db }) => {
    // A live connection keeps its revoked rotated-out rows until the 14-day
    // purge: replaying one must still revoke the connection (`deleteToken`).
    const tokens = db
      .delete(oauthTokens)
      .where(
        sql`${oauthTokens.issuedFromCodeHash} NOT IN (SELECT live.issued_from_code_hash
          FROM oauth_tokens live WHERE live.revoked_at IS NULL AND live.expires_at > ${now})`,
      )
      .run();
    const clients = db
      .delete(oauthClients)
      .where(
        sql`${oauthClients.createdAt} < ${now - OAUTH_CLIENT_CLEANUP_GRACE_MS}
          AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = ${oauthClients.clientId})
          AND NOT EXISTS (SELECT 1 FROM oauth_pending_authorizations p
            WHERE p.client_id = ${oauthClients.clientId} AND p.expires_at > ${now})
          AND NOT EXISTS (SELECT 1 FROM oauth_authorization_codes c
            WHERE c.client_id = ${oauthClients.clientId} AND c.expires_at > ${now})`,
      )
      .run();
    return { tokens: tokens.changes, clients: clients.changes };
  });
