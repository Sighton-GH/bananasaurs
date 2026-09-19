import { accountRepo, guildRepo, sessionRepo, type GuildScope, type ScopeFactory } from '@bananasaurs/storage';
import {
  CAPABILITIES,
  parseAccountId,
  parseGuildId,
  type Actor,
  type GuildId,
} from '@bananasaurs/core';
import { randomBytes } from 'node:crypto';
import {
  csrfTokenFor,
  dummyPasswordHashPromise,
  generateToken,
  hashToken,
  hashPassword,
  verifyPassword,
} from './secrets.js';
import { POLICY } from './policy.js';

/**
 * Authentication: the decisions, with no Fastify anywhere in the file.
 *
 * Everything here is a function of its arguments and its ports, so "does
 * lockout actually lock" and "does an expired session authenticate" are unit
 * tests against a database, with no server listening and no cookie parser
 * involved. `server.ts` moves bytes; this decides what they mean — the same
 * split `ops/dispatch.ts` uses for the operator socket.
 */

export interface AuthDeps {
  readonly scopes: ScopeFactory;
  /** Injected, like every clock in this tree. Never `Date.now()` in this file. */
  readonly now: () => number;
  /** The guilds this instance serves, in configuration order. */
  readonly guildIds: readonly string[];
}

/**
 * An authenticated request's identity.
 *
 * `actor` is built here and nowhere else, so the one place a `dashboard` actor
 * comes into existence is the place that just verified a session. `scope` is
 * built from the `guild_id` the database returned, never from anything the
 * client sent (ADR 0027).
 */
export interface SessionContext {
  readonly accountId: string;
  readonly guildId: GuildId;
  readonly sessionIdHash: string;
  readonly scope: GuildScope;
  readonly actor: Actor;
  readonly csrfToken: string;
  /** `null` when the session has never been re-authenticated, which cannot happen. */
  readonly reauthAt: number | null;
  readonly expiresAt: number;
}

export type AuthFailure =
  | 'no-cookie'
  | 'unknown-session'
  | 'session-expired'
  | 'session-revoked'
  | 'account-gone'
  | 'account-disabled'
  /** The account's access to this session's guild was revoked mid-session. */
  | 'access-revoked';

export type AuthResult =
  | { readonly ok: true; readonly session: SessionContext }
  | { readonly ok: false; readonly reason: AuthFailure };

/**
 * Turns a cookie into a session, or says why it did not.
 *
 * The order is load-bearing. The token is hashed first, so the raw value is
 * used for exactly two things — the lookup key and the CSRF derivation — and
 * never reaches a query, a log line, or an error message.
 *
 * **The guild comes from the row, not from the request.** That is the whole
 * reason `findSessionByHash` is instance-scoped: guild-scoping the lookup would
 * mean trusting a client-supplied guild in order to authenticate the session.
 *
 * The last check is the one that is easy to leave out: an account whose access
 * to this guild has been revoked must stop being able to use a session it
 * already holds. Without it, revoking access would take effect only at the next
 * login, which on a twelve-hour session is not revocation.
 */
export const authenticate = (deps: AuthDeps, rawToken: string | undefined): AuthResult => {
  if (rawToken === undefined || rawToken.length === 0) return { ok: false, reason: 'no-cookie' };

  const instance = deps.scopes.instance();
  const sessionIdHash = hashToken(rawToken);
  const row = sessionRepo.findSessionByHash(instance, sessionIdHash);
  if (row === undefined) return { ok: false, reason: 'unknown-session' };

  if (row.revokedAt !== null) return { ok: false, reason: 'session-revoked' };
  if (row.expiresAt <= deps.now()) return { ok: false, reason: 'session-expired' };

  const account = accountRepo.findAccountById(instance, row.accountId);
  if (account === undefined) return { ok: false, reason: 'account-gone' };
  if (account.disabled) return { ok: false, reason: 'account-disabled' };

  const guildId = parseGuildId(row.guildId);
  const scope = deps.scopes.forGuild(guildId);
  if (!accountRepo.hasGuildAccess(scope, row.accountId)) {
    return { ok: false, reason: 'access-revoked' };
  }

  return {
    ok: true,
    session: {
      accountId: row.accountId,
      guildId,
      sessionIdHash,
      scope,
      actor: actorFor(row.accountId),
      csrfToken: csrfTokenFor(rawToken),
      reauthAt: row.reauthAt,
      expiresAt: row.expiresAt,
    },
  };
};

/**
 * The `Actor` for a dashboard account.
 *
 * `roleIds` is always empty and there is no parameter to make it otherwise.
 * ADR 0028's control lives in `principalsOf`, which ignores a dashboard actor's
 * roles; this is the second half of the same decision — the field is never
 * populated in the first place, so the two would have to be defeated together.
 */
export const actorFor = (accountId: string): Actor => ({
  type: 'dashboard',
  id: parseAccountId(accountId),
  roleIds: [],
});

/** Whether a destructive action may proceed without asking for the password again. */
export const reauthIsFresh = (session: SessionContext, now: number): boolean =>
  session.reauthAt !== null && now - session.reauthAt <= POLICY.reauthWindowMs;

export type CredentialFailure = 'invalid-credentials' | 'locked-out';
export type CredentialResult =
  | { readonly ok: true; readonly account: accountRepo.AccountRow }
  | { readonly ok: false; readonly reason: CredentialFailure };

/**
 * The credential check `login` performs, on its own, so a second caller
 * (the OAuth consent page, ADR 0045 D6) inherits every control — dummy-hash
 * timing, lockout-without-verify, disabled-as-invalid, failed-attempt
 * accounting — rather than re-implementing a subset. Issues no session.
 */
export const verifyAccountCredentials = async (
  deps: AuthDeps,
  input: { readonly username: string; readonly password: string; readonly ip: string | null },
): Promise<CredentialResult> => {
  const instance = deps.scopes.instance();
  const now = deps.now();
  const account = accountRepo.findAccountByUsername(instance, input.username);

  if (account === undefined) {
    // Not an early return. The verification is the point: it makes "no such
    // account" cost what "wrong password" costs.
    await verifyPassword(await dummyPasswordHashPromise, input.password);
    return { ok: false, reason: 'invalid-credentials' };
  }

  if (account.lockedUntil !== null && account.lockedUntil > now) {
    // The password is deliberately not checked. A lockout that still verified
    // would let an attacker keep testing guesses through it, and would tell
    // them when they got one right.
    return { ok: false, reason: 'locked-out' };
  }

  if (account.disabled) {
    await verifyPassword(await dummyPasswordHashPromise, input.password);
    return { ok: false, reason: 'invalid-credentials' };
  }

  const correct = await verifyPassword(account.passwordHash, input.password);
  if (!correct) {
    const outcome = accountRepo.recordFailedAttempt(instance, {
      accountId: account.accountId,
      now,
      maxAttempts: POLICY.maxFailedAttempts,
      lockoutMs: POLICY.lockoutMs,
    });
    return {
      ok: false,
      reason: outcome.lockedUntil === null ? 'invalid-credentials' : 'locked-out',
    };
  }

  accountRepo.clearFailedAttempts(instance, account.accountId);
  return { ok: true, account };
};

export type LoginFailure =
  /** The single answer for a wrong username, a wrong password, or a disabled account. */
  | 'invalid-credentials'
  | 'locked-out'
  /** The account can reach no guild this instance serves. */
  | 'no-guild-access'
  /** More than one guild is reachable and the request named none, or named a bad one. */
  | 'guild-required';

export interface GuildChoice {
  readonly guildId: string;
  readonly name: string | undefined;
}

/**
 * The guilds an account can reach on this instance, with display names, in
 * configuration order.
 *
 * The one place that pairs the access rows with names, so `login`'s refusal
 * and `GET /api/session` cannot disagree about what the account reaches. It
 * costs no new query beyond what `login` already ran: the access list plus one
 * guild-row read per reachable guild, all after the password verified.
 */
export const listGuildChoices = (deps: AuthDeps, accountId: string): GuildChoice[] => {
  const accessible = new Set(
    accountRepo.listAccessibleGuilds(deps.scopes.instance(), accountId),
  );
  const out: GuildChoice[] = [];
  for (const id of deps.guildIds) {
    if (!accessible.has(id)) continue;
    out.push({ guildId: id, name: guildNameOf(deps, id) });
  }
  return out;
};

/**
 * A guild's display name, or undefined when the guild row was never written.
 *
 * Never throws: a configured guild id that fails to parse must not turn a
 * login into a 500. The worst case is a choice without a name, which the
 * dashboard renders as the id.
 */
const guildNameOf = (deps: AuthDeps, guildId: string): string | undefined => {
  try {
    return guildRepo.findGuild(deps.scopes.forGuild(parseGuildId(guildId)))?.name;
  } catch {
    return undefined;
  }
};

export type LoginResult =
  | {
      readonly ok: true;
      /** The value for the cookie. Never stored, never logged. */
      readonly token: string;
      readonly csrfToken: string;
      readonly accountId: string;
      readonly guildId: GuildId;
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly reason: 'invalid-credentials' | 'locked-out' | 'no-guild-access' }
  | {
      readonly ok: false;
      readonly reason: 'guild-required';
      /** Only on this reason, only after the password verified. */
      readonly choices: readonly GuildChoice[];
    };

/**
 * Verifies a password and issues a session.
 *
 * Async, and it has to be — Argon2id is async, and `write()` forbids an async
 * transaction by making one uncompilable. So the shape is forced and is the
 * right one: verify outside, write the finished result inside. Every write here
 * is its own transaction and none of them spans the hash.
 *
 * **Every failure returns the same shape and takes roughly the same time.** An
 * unknown username still costs one Argon2id verification, against a hash of a
 * value nobody knows. On a loopback-bound control plane username enumeration is
 * a modest threat; the defence is four lines, so it is not worth reasoning
 * about whether it matters.
 */
export const login = async (
  deps: AuthDeps,
  input: {
    username: string;
    password: string;
    /** May be omitted when the account can reach exactly one guild. */
    guildId?: string | undefined;
    ip: string | null;
  },
): Promise<LoginResult> => {
  const now = deps.now();
  const checked = await verifyAccountCredentials(deps, {
    username: input.username,
    password: input.password,
    ip: input.ip,
  });
  if (!checked.ok) return checked;
  const account = checked.account;

  // Computed after `checkPassword` succeeded, so carrying it on the refusal
  // below costs no new query and leaks nothing new (S13-D6): an account holder
  // learning which guilds their own account reaches is not a disclosure.
  const reachable = listGuildChoices(deps, account.accountId);

  if (reachable.length === 0) return { ok: false, reason: 'no-guild-access' };

  // Named explicitly, or inferred only when there is nothing to infer wrongly.
  // Picking the first of several would silently log someone into the wrong
  // server, which is the same refusal `resolveGuild` makes on the operator
  // socket.
  const first = reachable[0];
  const inferred = reachable.length === 1 && first !== undefined ? first.guildId : undefined;
  const chosen = input.guildId ?? inferred;
  if (chosen === undefined || !reachable.some((guild) => guild.guildId === chosen)) {
    return { ok: false, reason: 'guild-required', choices: reachable };
  }

  const guildId = parseGuildId(chosen);
  const token = generateToken();
  const expiresAt = now + POLICY.sessionTtlMs;
  sessionRepo.createSession(deps.scopes.forGuild(guildId), {
    sessionIdHash: hashToken(token),
    accountId: account.accountId,
    createdAt: now,
    expiresAt,
    // A fresh login counts as a re-authentication: the password was just
    // entered. Leaving this null would mean the first destructive action after
    // logging in always asked for the password a second time.
    reauthAt: now,
    ip: input.ip,
  });

  return {
    ok: true,
    token,
    csrfToken: csrfTokenFor(token),
    accountId: account.accountId,
    guildId,
    expiresAt,
  };
};

/**
 * Re-authenticates an existing session for a destructive action (ADR 0029).
 *
 * Failures count towards the same lockout as a login. They have to: a
 * re-authentication prompt is a password field on an authenticated page, and
 * leaving it uncounted would make it the cheapest place in the system to guess.
 */
export const reauthenticate = async (
  deps: AuthDeps,
  session: SessionContext,
  password: string,
): Promise<boolean> => {
  const instance = deps.scopes.instance();
  const now = deps.now();
  const account = accountRepo.findAccountById(instance, session.accountId);
  if (account === undefined) return false;
  if (account.lockedUntil !== null && account.lockedUntil > now) return false;

  const correct = await verifyPassword(account.passwordHash, password);
  if (!correct) {
    accountRepo.recordFailedAttempt(instance, {
      accountId: account.accountId,
      now,
      maxAttempts: POLICY.maxFailedAttempts,
      lockoutMs: POLICY.lockoutMs,
    });
    return false;
  }

  accountRepo.clearFailedAttempts(instance, account.accountId);
  sessionRepo.touchReauth(session.scope, { sessionIdHash: session.sessionIdHash, now });
  return true;
};

export const logout = (deps: AuthDeps, session: SessionContext): void => {
  sessionRepo.revokeSession(session.scope, {
    sessionIdHash: session.sessionIdHash,
    now: deps.now(),
  });
};

// --- first-run bootstrap (docs/19 §6.10) ------------------------------------

export interface IssuedBootstrapToken {
  /** Printed once, to stdout or the journal, and never stored. */
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * Issues a bootstrap token, or explains why it did not.
 *
 * Returns `undefined` when an account already exists — `docs/19` §6.10 arms
 * this only on a first start, and an instance with accounts must not print a
 * way past them into the journal.
 *
 * **This runs at startup and therefore must not throw under
 * `BANANASAURS_READONLY`.** Slice 13d found the daemon could not start
 * read-only until that class of bug was fixed; a token generator that writes on
 * boot is the same shape. The `readonly` flag is a parameter rather than
 * something inferred by catching `ReadonlyError`, so the skip is a decision in
 * the caller and not an exception swallowed here.
 */
export const issueBootstrapTokenIfNeeded = (
  deps: AuthDeps,
  options: { readonly: boolean },
): IssuedBootstrapToken | undefined => {
  const instance = deps.scopes.instance();
  if (accountRepo.countAccounts(instance) > 0) return undefined;
  if (options.readonly) return undefined;

  const token = generateToken();
  const row = accountRepo.issueBootstrapToken(instance, {
    tokenHash: hashToken(token),
    now: deps.now(),
    ttlMs: POLICY.bootstrapTtlMs,
  });
  return { token, expiresAt: row.expiresAt };
};

/**
 * Whether `/bootstrap` should be **registered at all** (`docs/19` §6.10 step 2).
 *
 * Zero accounts *and* an unconsumed, unexpired token. Otherwise the route does
 * not exist — a 404, not a 403, so its absence leaks nothing about whether this
 * instance has been set up.
 *
 * Registration-time, not a guard inside a handler: a handler that returns 404
 * still exists, still parses a body, and is one refactor away from returning
 * 403 or from someone deciding the check is redundant.
 */
export const bootstrapIsArmed = (deps: AuthDeps): boolean => {
  const instance = deps.scopes.instance();
  return (
    accountRepo.countAccounts(instance) === 0 &&
    accountRepo.hasUsableBootstrapToken(instance, deps.now())
  );
};

export type BootstrapFailure = 'bad-token' | 'already-provisioned' | 'no-guild';

export type BootstrapResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly csrfToken: string;
      readonly accountId: string;
      readonly guildId: GuildId;
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly reason: BootstrapFailure };

/**
 * Creates the first owner account and issues its session (`docs/19` §6.10 step 3).
 *
 * The order matters and is not the obvious one: **the token is consumed
 * first.** `consumeBootstrapToken` is a conditional `UPDATE` in its own
 * transaction, so two simultaneous submissions cannot both pass it — the second
 * matches no rows. Hashing the password first and consuming afterwards would
 * have left a window between the check and the consumption, and the thing that
 * fits in that window is a second owner account.
 *
 * The password hash is computed between the two writes rather than inside
 * either, because Argon2id is async and `writeInstance` will not take an async
 * callback.
 */
export const bootstrap = async (
  deps: AuthDeps,
  input: { token: string; username: string; password: string; ip: string | null },
): Promise<BootstrapResult> => {
  const instance = deps.scopes.instance();
  const now = deps.now();

  if (accountRepo.countAccounts(instance) > 0) {
    return { ok: false, reason: 'already-provisioned' };
  }
  if (!accountRepo.consumeBootstrapToken(instance, { tokenHash: hashToken(input.token), now })) {
    return { ok: false, reason: 'bad-token' };
  }

  const firstGuild = deps.guildIds[0];
  if (firstGuild === undefined) return { ok: false, reason: 'no-guild' };
  const guildId = parseGuildId(firstGuild);

  const passwordHash = await hashPassword(input.password);
  const accountId = `acct_${randomBytes(16).toString('hex')}`;

  accountRepo.createAccount(instance, {
    accountId,
    username: input.username,
    passwordHash,
    isOwner: true,
    now,
  });

  // Access to every guild this instance serves, then every capability in each.
  // `docs/19` §6.10 step 3 says "is_owner=1 and every capability" — issued as
  // real grants, not as an `is_owner` branch inside `authorize()`. A superuser
  // bit that short-circuits the capability check is the pattern ADR 0012
  // rejected when it rejected Discord Administrator.
  for (const id of deps.guildIds) {
    const scope = deps.scopes.forGuild(parseGuildId(id));
    accountRepo.grantGuildAccess(scope, accountId);
    accountRepo.grantAllCapabilities(scope, {
      accountId,
      capabilities: CAPABILITIES,
      grantedBy: 'bootstrap',
      now,
    });
  }

  const token = generateToken();
  const expiresAt = now + POLICY.sessionTtlMs;
  sessionRepo.createSession(deps.scopes.forGuild(guildId), {
    sessionIdHash: hashToken(token),
    accountId,
    createdAt: now,
    expiresAt,
    reauthAt: now,
    ip: input.ip,
  });

  return { ok: true, token, csrfToken: csrfTokenFor(token), accountId, guildId, expiresAt };
};
