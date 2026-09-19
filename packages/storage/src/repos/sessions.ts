import { and, eq, isNull } from 'drizzle-orm';
import type { GuildScope, InstanceScope } from '../scope.js';
import { read, readInstance, write } from '../write.js';
import { accountGuildAccess, dashboardSessions } from '../schema.js';

/**
 * Dashboard sessions.
 *
 * Guild-scoped rows. ADR 0012 put it as "a session is for one guild, so a
 * stolen cookie cannot be pointed at another"; slice 13 narrowed that, because
 * an instance serving two guilds has to let its operator move between them
 * without signing out. What still holds — and is what the sentence was
 * protecting — is that a session may only ever be pointed at a guild **the
 * account already has access to**, checked inside `setSessionGuild` below
 * rather than by its callers. A stolen cookie still reaches exactly the guilds
 * its account could reach.
 *
 * There is **one deliberately instance-scoped
 * function**: `findSessionByHash`. A session is looked up by its token before
 * the guild is known, so guild-scoping that lookup would mean trusting a
 * client-supplied guild in order to authenticate the session (ADR 0027, and the
 * `UNIQUE_BY_DESIGN` entry for this table's primary key).
 *
 * The split is visible in the signatures: exactly one function here takes an
 * `InstanceScope`, and it is the one that authenticates. Everything that acts
 * on an authenticated session takes a `GuildScope` built from the `guild_id`
 * the database returned.
 *
 * **The token itself never appears in this module.** Callers hash it; the
 * column is named `session_id` and holds `sha256(token)`.
 */

export interface SessionRow {
  /** `sha256(token)`. The token itself is not stored anywhere. */
  readonly sessionId: string;
  readonly accountId: string;
  readonly guildId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly reauthAt: number | null;
  readonly ip: string | null;
}

const SELECT = {
  sessionId: dashboardSessions.sessionId,
  accountId: dashboardSessions.accountId,
  guildId: dashboardSessions.guildId,
  createdAt: dashboardSessions.createdAt,
  expiresAt: dashboardSessions.expiresAt,
  revokedAt: dashboardSessions.revokedAt,
  reauthAt: dashboardSessions.reauthAt,
  ip: dashboardSessions.ip,
};

/**
 * Creates a session from an **already-hashed** token.
 *
 * `expiresAt` is passed in rather than computed here: the lifetime is policy
 * (ADR 0029, twelve hours absolute) and the clock is injected everywhere in
 * this tree, so a repository that reached for `Date.now()` and a constant would
 * put both beyond a test's reach.
 */
export const createSession = (
  scope: GuildScope,
  input: {
    sessionIdHash: string;
    accountId: string;
    createdAt: number;
    expiresAt: number;
    reauthAt: number | null;
    ip: string | null;
  },
): void =>
  write(scope, ({ db }) => {
    db.insert(dashboardSessions)
      .values({
        sessionId: input.sessionIdHash,
        accountId: input.accountId,
        guildId: scope.guildId,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        reauthAt: input.reauthAt,
        ip: input.ip,
      })
      .run();
  });

/**
 * The row for a token hash, whatever its state.
 *
 * Deliberately returns revoked and expired rows rather than filtering them.
 * The caller decides — and the caller is one function, `authenticate`, which
 * has to distinguish "no such session" from "your session ended" to answer
 * usefully. Filtering here would have made those indistinguishable and pushed
 * the distinction into a second query.
 */
export const findSessionByHash = (
  scope: InstanceScope,
  sessionIdHash: string,
): SessionRow | undefined =>
  readInstance(scope, (db) =>
    db
      .select(SELECT)
      .from(dashboardSessions)
      .where(eq(dashboardSessions.sessionId, sessionIdHash))
      .get(),
  );

/** Immediate revocation — the entire reason sessions are DB-backed (`docs/19` §6.10). */
export const revokeSession = (
  scope: GuildScope,
  input: { sessionIdHash: string; now: number },
): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .update(dashboardSessions)
      .set({ revokedAt: input.now })
      .where(scope.only(dashboardSessions, eq(dashboardSessions.sessionId, input.sessionIdHash)))
      .run();
    return result.changes === 1;
  });

/**
 * Revokes every LIVE session for one account, for a password change or a lockout.
 *
 * Only rows with `revoked_at IS NULL` are touched (ADR 0045 Amendment 4 A3-7):
 * an already-revoked row keeps the timestamp recording when its session
 * actually ended, so re-running a revoke mid-incident neither rewrites the
 * timeline nor reports a session it did not end.
 */
export const revokeAllForAccount = (
  scope: GuildScope,
  input: { accountId: string; now: number },
): number =>
  write(scope, ({ db }) => {
    const result = db
      .update(dashboardSessions)
      .set({ revokedAt: input.now })
      .where(
        scope.only(
          dashboardSessions,
          and(
            eq(dashboardSessions.accountId, input.accountId),
            isNull(dashboardSessions.revokedAt),
          ),
        ),
      )
      .run();
    return result.changes;
  });

/**
 * Refreshes `reauth_at` after a successful re-authentication.
 *
 * It does **not** touch `expires_at` (ADR 0029). Re-authenticating to disable
 * the kill switch must not silently extend a session that was about to end;
 * absolute lifetime means absolute.
 */
export const touchReauth = (
  scope: GuildScope,
  input: { sessionIdHash: string; now: number },
): void =>
  write(scope, ({ db }) => {
    db.update(dashboardSessions)
      .set({ reauthAt: input.now })
      .where(scope.only(dashboardSessions, eq(dashboardSessions.sessionId, input.sessionIdHash)))
      .run();
  });

/** Live sessions for one account in this guild, for the dashboard's session list. */
export const listSessionsForAccount = (
  scope: GuildScope,
  accountId: string,
): readonly SessionRow[] =>
  read(scope, (db) =>
    db
      .select(SELECT)
      .from(dashboardSessions)
      .where(scope.only(dashboardSessions, eq(dashboardSessions.accountId, accountId)))
      .all(),
  );

/**
 * Re-scopes a live session to another guild (S13-D7: the row moves, so no new
 * session is issued and the cookie and CSRF derivation survive the switch).
 *
 * This is an UPDATE of `guild_id` under the CURRENT scope, not a
 * delete-and-insert. The `WHERE` still carries `scope.only(...)` for the
 * guild the row lives in now, so the read side stays governed exactly like
 * `revokeSession`'s; the `SET` moves the row into the target partition in the
 * same statement, preserving the primary key the token hash, the cookie and
 * every revocation query address the row by. A delete-and-insert would take
 * two statements to do what one does, and would briefly leave the session
 * addressed by nothing.
 *
 * False when the row is gone, already revoked, **or the account has no access
 * to the target guild** — the last is checked in this function rather than
 * left to the caller, so a future caller cannot forget it. `now` is accepted for
 * call-site symmetry but stamps nothing: the row carries no `updated_at`, and
 * touching `expires_at` would shift the absolute lifetime ADR 0029 forbids
 * shifting.
 */
export const setSessionGuild = (
  scope: GuildScope,
  input: { sessionIdHash: string; accountId: string; guildId: string; now: number },
): boolean =>
  write(scope, ({ db }) => {
    // The access check lives here, not only in the route (CLAUDE.md rule 2:
    // enforce guild scope in repository signatures, not in caller discipline).
    // Without it this is a bare partition-move primitive that will happily put
    // a session in a guild its account cannot reach — harmless today only
    // because `authenticate` re-checks on the next request, which is a backstop
    // and not a guard. Taking `accountId` is what makes the check possible at
    // all, so the signature is the enforcement.
    const target = db
      .select({ accountId: accountGuildAccess.accountId })
      .from(accountGuildAccess)
      .where(
        and(
          eq(accountGuildAccess.guildId, input.guildId),
          eq(accountGuildAccess.accountId, input.accountId),
        ),
      )
      .get();
    if (target === undefined) return false;

    const result = db
      .update(dashboardSessions)
      .set({ guildId: input.guildId })
      .where(
        scope.only(
          dashboardSessions,
          and(
            eq(dashboardSessions.sessionId, input.sessionIdHash),
            isNull(dashboardSessions.revokedAt),
          ),
        ),
      )
      .run();
    return result.changes === 1;
  });
