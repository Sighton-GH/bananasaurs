import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Capability } from '@bananasaurs/core';
import type { GuildScope, InstanceScope } from '../scope.js';
import { read, readInstance, write, writeInstance } from '../write.js';
import {
  accountCapabilities,
  accountGuildAccess,
  bootstrapTokens,
  dashboardAccounts,
  oauthAuthorizationCodes,
  oauthTokens,
} from '../schema.js';

/**
 * Dashboard accounts, guild access, and the first-run bootstrap token.
 *
 * Instance-level throughout (ADR 0012, ADR 0027): an account exists before a
 * guild is chosen, and the bootstrap token exists before any account. The
 * `InstanceScope` first parameter is what says so — these functions cannot
 * accept a `GuildScope`, and a guild-partitioned repository cannot accept an
 * `InstanceScope`, so "is this query partitioned?" is answered by the signature.
 *
 * **No password hashing happens here.** Argon2id is async and `writeInstance`
 * makes an async transaction uncompilable, which is the correct shape rather
 * than an obstacle: hash outside, write the finished hash inside.
 */

export interface AccountRow {
  readonly accountId: string;
  readonly username: string;
  readonly passwordHash: string;
  /**
   * The sealed copy of the password, or `null` (ADR 0070). Present here (and
   * not just behind `getPasswordSealed` below) so `listAccounts` can compute
   * `revealable` without a second query per row — but never mapped onto
   * `OpsAccount` any more than `passwordHash` is: `ops/wiring.ts` derives the
   * boolean and drops the ciphertext at that boundary, field by field.
   */
  readonly passwordSealed: string | null;
  readonly isOwner: boolean;
  readonly disabled: boolean;
  readonly failedAttempts: number;
  readonly lockedUntil: number | null;
  readonly createdAt: number;
}

const toRow = (r: {
  accountId: string;
  username: string;
  passwordHash: string;
  passwordSealed: string | null;
  isOwner: number;
  disabled: number;
  failedAttempts: number;
  lockedUntil: number | null;
  createdAt: number;
}): AccountRow => ({
  accountId: r.accountId,
  username: r.username,
  passwordHash: r.passwordHash,
  passwordSealed: r.passwordSealed,
  isOwner: r.isOwner === 1,
  disabled: r.disabled === 1,
  failedAttempts: r.failedAttempts,
  lockedUntil: r.lockedUntil,
  createdAt: r.createdAt,
});

const SELECT = {
  accountId: dashboardAccounts.accountId,
  username: dashboardAccounts.username,
  passwordHash: dashboardAccounts.passwordHash,
  passwordSealed: dashboardAccounts.passwordSealed,
  isOwner: dashboardAccounts.isOwner,
  disabled: dashboardAccounts.disabled,
  failedAttempts: dashboardAccounts.failedAttempts,
  lockedUntil: dashboardAccounts.lockedUntil,
  createdAt: dashboardAccounts.createdAt,
};

/**
 * How many accounts exist.
 *
 * The bootstrap route's registration depends on this being zero (`docs/19`
 * §6.10 step 2), so it is a count rather than an `exists` — a count of one is a
 * different diagnosis from a count of forty when someone asks why `/bootstrap`
 * is a 404.
 */
export const countAccounts = (scope: InstanceScope): number =>
  readInstance(
    scope,
    (db) =>
      db
        .select({ n: sql<number>`count(*)` })
        .from(dashboardAccounts)
        .get()?.n ?? 0,
  );

export const findAccountByUsername = (
  scope: InstanceScope,
  username: string,
): AccountRow | undefined => {
  const row = readInstance(scope, (db) =>
    db.select(SELECT).from(dashboardAccounts).where(eq(dashboardAccounts.username, username)).get(),
  );
  return row === undefined ? undefined : toRow(row);
};

export const findAccountById = (
  scope: InstanceScope,
  accountId: string,
): AccountRow | undefined => {
  const row = readInstance(scope, (db) =>
    db
      .select(SELECT)
      .from(dashboardAccounts)
      .where(eq(dashboardAccounts.accountId, accountId))
      .get(),
  );
  return row === undefined ? undefined : toRow(row);
};

/**
 * Creates an account from an **already-hashed** password.
 *
 * The parameter is named `passwordHash` rather than `password` on purpose: a
 * function that took a plaintext password would have to hash it, hashing is
 * async, and an async callback cannot be passed to `writeInstance`. The name is
 * the reminder of why the split exists.
 */
export const createAccount = (
  scope: InstanceScope,
  input: {
    accountId: string;
    username: string;
    passwordHash: string;
    isOwner: boolean;
    now: number;
  },
): void =>
  writeInstance(scope, ({ db }) => {
    db.insert(dashboardAccounts)
      .values({
        accountId: input.accountId,
        username: input.username,
        passwordHash: input.passwordHash,
        isOwner: input.isOwner ? 1 : 0,
        createdAt: input.now,
      })
      .run();
  });

/**
 * Records a failed login and applies the lockout when the threshold is reached.
 *
 * One function rather than an increment plus a caller-side comparison: the
 * threshold and the window are policy (ADR 0029), and a caller that incremented
 * and forgot to compare would leave an account with a rising counter and no
 * lockout at all — a control that looks present in the schema and is absent in
 * behaviour.
 */
export const recordFailedAttempt = (
  scope: InstanceScope,
  input: { accountId: string; now: number; maxAttempts: number; lockoutMs: number },
): { attempts: number; lockedUntil: number | null } =>
  writeInstance(scope, ({ db }) => {
    const current =
      db
        .select({ failedAttempts: dashboardAccounts.failedAttempts })
        .from(dashboardAccounts)
        .where(eq(dashboardAccounts.accountId, input.accountId))
        .get()?.failedAttempts ?? 0;

    const attempts = current + 1;
    const lockedUntil = attempts >= input.maxAttempts ? input.now + input.lockoutMs : null;

    db.update(dashboardAccounts)
      .set({ failedAttempts: attempts, lockedUntil })
      .where(eq(dashboardAccounts.accountId, input.accountId))
      .run();

    return { attempts, lockedUntil };
  });

/** Clears the counter and any lockout. Called only after a correct password. */
export const clearFailedAttempts = (scope: InstanceScope, accountId: string): void =>
  writeInstance(scope, ({ db }) => {
    db.update(dashboardAccounts)
      .set({ failedAttempts: 0, lockedUntil: null })
      .where(eq(dashboardAccounts.accountId, accountId))
      .run();
  });

export const setPasswordHash = (
  scope: InstanceScope,
  input: { accountId: string; passwordHash: string },
): void =>
  writeInstance(scope, ({ db }) => {
    db.update(dashboardAccounts)
      .set({ passwordHash: input.passwordHash })
      .where(eq(dashboardAccounts.accountId, input.accountId))
      .run();
  });

/**
 * Writes (or clears, with `null`) the sealed copy of an account's password
 * (ADR 0070). Called from `ops/wiring.ts`'s `accountCreate` and
 * `accountSetPassword`, alongside `setPasswordHash` above — never on its
 * own, so the sealed copy and the sign-in hash always change together.
 */
export const setPasswordSealed = (
  scope: InstanceScope,
  accountId: string,
  sealed: string | null,
): void =>
  writeInstance(scope, ({ db }) => {
    db.update(dashboardAccounts)
      .set({ passwordSealed: sealed })
      .where(eq(dashboardAccounts.accountId, accountId))
      .run();
  });

/** The sealed copy of an account's password, or `null` when none exists (ADR 0070). Never the plaintext. */
export const getPasswordSealed = (scope: InstanceScope, accountId: string): string | null =>
  readInstance(
    scope,
    (db) =>
      db
        .select({ passwordSealed: dashboardAccounts.passwordSealed })
        .from(dashboardAccounts)
        .where(eq(dashboardAccounts.accountId, accountId))
        .get()?.passwordSealed ?? null,
  );

/**
 * Disables or re-enables an account (ADR 0045 Amendment 3, A3-1).
 *
 * The lever ADR 0045 D6 promised and M3 did not have: `disabled` was read in
 * five places and written in none outside tests, so "revoking the account
 * revokes everything it approved" had no trigger at all. Returns `false` for
 * an unknown id, so the caller can tell "no such account" from "already in
 * the state you asked for" — both write nothing, and they are different
 * answers to an operator.
 *
 * It does NOT touch `failed_attempts` or `locked_until` (A3-4): a lockout
 * (ADR 0029) answers a different question from a disablement, and clearing
 * one as a side effect of undoing the other would make the login throttle
 * depend on an unrelated command.
 */
export const setAccountDisabled = (
  scope: InstanceScope,
  input: { accountId: string; disabled: boolean },
): boolean =>
  writeInstance(scope, ({ db }) => {
    const result = db
      .update(dashboardAccounts)
      .set({ disabled: input.disabled ? 1 : 0 })
      .where(eq(dashboardAccounts.accountId, input.accountId))
      .run();
    return result.changes === 1;
  });

export interface AccountDeletion {
  readonly deleted: boolean;
  /** OAuth tokens revoked in the same transaction. */
  readonly tokensRevoked: number;
  /** Unexchanged authorization codes deleted in the same transaction. */
  readonly codesDeleted: number;
}

/**
 * Deletes an account and, in the SAME transaction, revokes every live OAuth
 * token it approved and removes every authorization code it consented to.
 *
 * The revoke is belt as well as suspenders, deliberately: `verifyAccessToken`
 * already refuses a token whose account has vanished, so the 401 on the next
 * request does not depend on this write — but `oauth_tokens.account_id`
 * carries no foreign key, so without an explicit revoke the rows outlive the
 * account and `bananasaurs mcp tokens` would keep printing them as LIVE for
 * up to thirty days. That is wrong in exactly the direction an operator
 * auditing "what can still reach this daemon" cannot afford: a list that
 * understates access is a bug, a list that overstates it after a revocation
 * the operator just performed is a betrayal of the command. And a revocation
 * that depends on a second module's check holding is the shape that was
 * already found false twice here — the check can change, the row cannot
 * speak for itself.
 *
 * The cross-table writes live in this file rather than in `oauth.ts` because
 * they must share one transaction with the delete, and `writeInstance` does
 * not nest: calling an `oauth.ts` helper from here would open a second
 * transaction, leaving a crash between the two with the account gone and its
 * tokens still live.
 */
export const deleteAccount = (
  scope: InstanceScope,
  input: { accountId: string; now: number },
): AccountDeletion =>
  writeInstance(scope, ({ db }) => {
    const revoked = db
      .update(oauthTokens)
      .set({ revokedAt: input.now })
      .where(and(eq(oauthTokens.accountId, input.accountId), isNull(oauthTokens.revokedAt)))
      .run();
    const codes = db
      .delete(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.accountId, input.accountId))
      .run();
    const deleted = db
      .delete(dashboardAccounts)
      .where(eq(dashboardAccounts.accountId, input.accountId))
      .run();
    return {
      deleted: deleted.changes === 1,
      tokensRevoked: revoked.changes,
      codesDeleted: codes.changes,
    };
  });

/**
 * How many owners can still log in: `is_owner = 1 AND disabled = 0`.
 *
 * A disabled owner keeps the title but has lost the access, so counting the
 * title alone would answer a question nobody asked — the caller is deciding
 * whether revoking this account leaves the daemon ownerless, and an account
 * that cannot authenticate is already gone for that purpose.
 */
export const countEnabledOwners = (scope: InstanceScope): number =>
  readInstance(
    scope,
    (db) =>
      db
        .select({ n: sql<number>`count(*)` })
        .from(dashboardAccounts)
        .where(and(eq(dashboardAccounts.isOwner, 1), eq(dashboardAccounts.disabled, 0)))
        .get()?.n ?? 0,
  );

/**
 * The ids of the owners who can still log in, oldest first — the same
 * `is_owner = 1 AND disabled = 0` predicate as `countEnabledOwners` above.
 * ADR 0124: startup gives each of these access to every allowlisted guild.
 */
export const listEnabledOwnerIds = (scope: InstanceScope): string[] =>
  readInstance(scope, (db) =>
    db
      .select({ accountId: dashboardAccounts.accountId })
      .from(dashboardAccounts)
      .where(and(eq(dashboardAccounts.isOwner, 1), eq(dashboardAccounts.disabled, 0)))
      .orderBy(asc(dashboardAccounts.createdAt))
      .all()
      .map((row) => row.accountId),
  );

/**
 * Every account, oldest first (`created_at` ascending).
 *
 * An operator listing accounts is auditing provisioning order — "who was
 * here first" — so insertion order is the wrong answer and rowid order is an
 * accident; the clock the rows were written with is the ordering that means
 * something.
 */
export const listAccounts = (scope: InstanceScope): readonly AccountRow[] =>
  readInstance(scope, (db) =>
    db
      .select(SELECT)
      .from(dashboardAccounts)
      .orderBy(asc(dashboardAccounts.createdAt))
      .all()
      .map(toRow),
  );

// --- guild access -----------------------------------------------------------

/**
 * Which guilds an account may reach.
 *
 * Instance-scoped, because the answer spans guilds: this is the query that
 * decides which `GuildScope` a session may be issued for, so it necessarily
 * runs before one exists.
 */
export const listAccessibleGuilds = (scope: InstanceScope, accountId: string): string[] =>
  readInstance(scope, (db) =>
    db
      .select({ guildId: accountGuildAccess.guildId })
      .from(accountGuildAccess)
      .where(eq(accountGuildAccess.accountId, accountId))
      .all()
      .map((row) => row.guildId),
  );

/**
 * Grants an account access to this guild.
 *
 * Guild-scoped, unlike the read above: granting access names one guild, and the
 * partition key belongs in the signature wherever it can be.
 */
export const grantGuildAccess = (scope: GuildScope, accountId: string): void =>
  write(scope, ({ db }) => {
    db.insert(accountGuildAccess)
      .values({ guildId: scope.guildId, accountId })
      .onConflictDoNothing()
      .run();
  });

/**
 * Revokes access, and with it every capability in this guild.
 *
 * The cascade is the foreign key's, not this function's (ADR 0028). A capability
 * left behind by a revocation is the bug that design exists to make
 * unrepresentable.
 */
export const revokeGuildAccess = (scope: GuildScope, accountId: string): void =>
  write(scope, ({ db }) => {
    db.delete(accountGuildAccess)
      .where(scope.only(accountGuildAccess, eq(accountGuildAccess.accountId, accountId)))
      .run();
  });

export const hasGuildAccess = (scope: GuildScope, accountId: string): boolean =>
  read(scope, (db) => {
    const row = db
      .select({ accountId: accountGuildAccess.accountId })
      .from(accountGuildAccess)
      .where(scope.only(accountGuildAccess, eq(accountGuildAccess.accountId, accountId)))
      .get();
    return row !== undefined;
  });

/** Every capability the bootstrap owner is given, in one place (`docs/19` §6.10 step 3). */
export const grantAllCapabilities = (
  scope: GuildScope,
  input: { accountId: string; capabilities: readonly Capability[]; grantedBy: string; now: number },
): void =>
  write(scope, ({ db }) => {
    for (const capability of input.capabilities) {
      db.insert(accountCapabilities)
        .values({
          guildId: scope.guildId,
          accountId: input.accountId,
          capability,
          grantedAt: input.now,
          grantedBy: input.grantedBy,
        })
        .onConflictDoNothing()
        .run();
    }
  });

// --- bootstrap tokens -------------------------------------------------------

export interface BootstrapTokenRow {
  readonly tokenHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
}

/**
 * Stores the hash of a freshly issued bootstrap token.
 *
 * The plaintext never reaches this function, and there is no parameter through
 * which it could. `docs/19` §6.10 step 1: printed once, stored only as a hash.
 */
export const issueBootstrapToken = (
  scope: InstanceScope,
  input: { tokenHash: string; now: number; ttlMs: number },
): BootstrapTokenRow =>
  writeInstance(scope, ({ db }) => {
    const row = {
      tokenHash: input.tokenHash,
      createdAt: input.now,
      expiresAt: input.now + input.ttlMs,
      consumedAt: null,
    };
    // Every earlier unconsumed token is deleted, not left to expire. Reissuing
    // is a recovery action (ADR 0012); leaving the previous token live would
    // mean an operator who reissued because they lost the first one now has two
    // valid ways in and can only see one of them.
    db.delete(bootstrapTokens).where(isNull(bootstrapTokens.consumedAt)).run();
    db.insert(bootstrapTokens).values(row).run();
    return row;
  });

/**
 * Is there a token that is neither consumed nor expired?
 *
 * `nowMs` is a parameter rather than `Date.now()`, like every other clock in
 * this tree. Slice 13e found a real bug from exactly this shape: a port on the
 * wall clock produced a row nothing would ever pick up, with nothing saying why.
 */
export const hasUsableBootstrapToken = (scope: InstanceScope, nowMs: number): boolean =>
  readInstance(scope, (db) => {
    const row = db
      .select({ tokenHash: bootstrapTokens.tokenHash })
      .from(bootstrapTokens)
      .where(and(isNull(bootstrapTokens.consumedAt), sql`${bootstrapTokens.expiresAt} > ${nowMs}`))
      .get();
    return row !== undefined;
  });

/**
 * Consumes a token by its hash, returning whether it was usable.
 *
 * The check and the consumption are one statement inside one transaction, so
 * two simultaneous bootstrap submissions cannot both succeed: the second
 * `UPDATE` matches no rows because the first has already set `consumed_at`.
 * A read-then-write in the handler would have been a race, and the race would
 * have created two owner accounts.
 */
export const consumeBootstrapToken = (
  scope: InstanceScope,
  input: { tokenHash: string; now: number },
): boolean =>
  writeInstance(scope, ({ db }) => {
    const result = db
      .update(bootstrapTokens)
      .set({ consumedAt: input.now })
      .where(
        and(
          eq(bootstrapTokens.tokenHash, input.tokenHash),
          isNull(bootstrapTokens.consumedAt),
          sql`${bootstrapTokens.expiresAt} > ${input.now}`,
        ),
      )
      .run();
    return result.changes === 1;
  });

/** Housekeeping for tests and for `bootstrap reissue`'s report. */
export const countUnconsumedBootstrapTokens = (scope: InstanceScope, nowMs: number): number =>
  readInstance(
    scope,
    (db) =>
      db
        .select({ n: sql<number>`count(*)` })
        .from(bootstrapTokens)
        .where(
          and(isNull(bootstrapTokens.consumedAt), lt(sql`${nowMs}`, bootstrapTokens.expiresAt)),
        )
        .get()?.n ?? 0,
  );
