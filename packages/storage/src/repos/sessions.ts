import { and, eq, isNull } from 'drizzle-orm';
import type { GuildScope, InstanceScope } from '../scope.js';
import { read, readInstance, write } from '../write.js';
import { dashboardSessions } from '../schema.js';

/**
 * Dashboard sessions.
 *
 * Guild-scoped rows (ADR 0012: a session is for one guild, so a stolen cookie
 * cannot be pointed at another), with **one deliberately instance-scoped
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
