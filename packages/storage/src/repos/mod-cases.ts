import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { modCaseEvents, modCases } from '../schema.js';

/**
 * Per-member violation history, and the events recorded against it.
 *
 * `mod_cases` holds at most one `open` row per member — enforced by the
 * `mod_cases_open_per_member` partial unique index (Task 1's schema) — so a
 * second violation resolves into the same case rather than forking a new
 * one. `mod_case_events` is the append-only log of what happened on each
 * match, including a refusal: ADR 0035 requires a moderation-action refusal
 * (owner protection, role hierarchy) to be durably recorded here, unlike
 * Release 1's role-effect refusals, which are log-only.
 *
 * Every function takes a `GuildScope` first, like every repository here.
 * `mod_case_events` carries a composite foreign key back to
 * `mod_cases(guild_id, case_id)`, so an event cannot belong to another
 * guild's case even if a caller tried.
 */

export type ModCaseStatus = 'open' | 'closed';

/**
 * What actually happened on one match. Mirrors `mod_case_events`' CHECK
 * constraint exactly (`schema.ts`), which is the real enforcement point.
 *
 * Grouped by whether the offending message was really deleted:
 *
 * - **Really deleted, then**: `deleted` (no escalation tier crossed),
 *   `deleted_and_escalated` (`applied`), `escalation_refused` (`refused`, a
 *   safety layer said no), `escalation_failed` (`failed`, Discord errored),
 *   `escalation_dry_run` (`dry-run`), `escalation_skipped` (`skipped`, the
 *   identical action had already been applied). The last five map one-to-one
 *   onto `ModerationOutcome`'s five variants.
 * - **Not deleted**: `would_delete` (the rule is in `test`/`observe` mode, so
 *   nothing was ever going to be deleted), `delete_blocked_*` (the rule is in
 *   `enforce` mode but a docs/18 safety layer stopped every Discord side
 *   effect first), `delete_failed` (the delete was attempted and Discord
 *   refused it for a reason other than "the message is already gone", which
 *   the subscriber treats as success).
 */
export type ModCaseActionTaken =
  | 'deleted'
  | 'deleted_and_escalated'
  | 'escalation_refused'
  | 'escalation_failed'
  | 'escalation_dry_run'
  | 'escalation_skipped'
  | 'would_delete'
  | 'delete_failed'
  | 'delete_blocked_killswitch'
  | 'delete_blocked_breaker'
  | 'delete_blocked_dry_run'
  | 'delete_blocked_guild_unknown'
  /**
   * Manual events (ADR 0037): moderator commands share this append-only
   * stream. A manual member action (timeout/untimeout/kick/ban/unban) that
   * Discord really applied is `'manual_applied'` — NOT
   * `'deleted_and_escalated'`, whose name would claim the deletion the
   * automod vocabulary's meaning bundles in. The other four outcome states
   * reuse the `escalation_*` values (`escalation_refused`/`failed`/`dry_run`/
   * `skipped`): they describe an outcome uniformly, and `escalation_action`
   * names which action. `warned` is the event that increments the ladder the
   * member shares with automod strikes; `note`/`evidence_added` record text
   * and URLs; `purged`/`purge_refused`/`purge_failed` mark the job's outcome.
   */
  | 'warned'
  | 'note'
  | 'evidence_added'
  | 'purged'
  | 'purge_refused'
  | 'purge_failed'
  | 'manual_applied';
export type ModCaseEscalationAction = 'timeout' | 'kick' | 'ban' | 'unban';
export type ModCaseRefusalReason =
  | 'unauthorized'
  | 'guild-unknown'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap'
  | 'discord-owner'
  | 'role-above-bot';

export interface OpenOrResolveCaseInput {
  readonly memberId: string;
  readonly now: number;
  /**
   * Whether this violation moves the counter the escalation ladder reads.
   *
   * `false` still resolves (or opens) the member's case, so a case event has
   * something to hang off — a `test`/`observe` match and a match a safety
   * layer blocked are both real observations a moderator should be able to
   * read back — but leaves `violation_count` exactly where it was. A case
   * opened by a non-counting match starts at 0, which is what "we have seen
   * this, and nothing has been enforced" looks like.
   *
   * Defaults to `true` so an existing caller cannot silently stop counting.
   */
  readonly countsAsViolation?: boolean;
}

export interface OpenOrResolveCaseResult {
  readonly caseId: string;
  readonly violationCount: number;
}

/**
 * Opens a case for `memberId`'s first violation, or resolves a further
 * violation into the member's existing open case.
 *
 * Select-then-branch inside one `write()`: the partial unique index makes
 * "at most one open case per member" true at the database level, and
 * single-writer discipline (ADR 0008, `write.ts`) is what makes the read and
 * the branch atomic here — better-sqlite3 is synchronous and this transaction
 * never awaits, so no other write can interleave between the select and the
 * insert/update. A caller producing a `caseId` up front would let two
 * concurrent transactions both see "no open case" and both attempt an
 * insert; that path is deliberately not offered.
 */
export const openOrResolveCase = (
  scope: GuildScope,
  input: OpenOrResolveCaseInput,
): OpenOrResolveCaseResult =>
  write(scope, ({ db }) => {
    const existing = db
      .select({ caseId: modCases.caseId, violationCount: modCases.violationCount })
      .from(modCases)
      .where(
        scope.only(modCases, eq(modCases.memberId, input.memberId), eq(modCases.status, 'open')),
      )
      .get();

    const counts = input.countsAsViolation ?? true;

    if (existing) {
      if (!counts) return { caseId: existing.caseId, violationCount: existing.violationCount };
      const violationCount = existing.violationCount + 1;
      db.update(modCases)
        .set({ violationCount })
        .where(scope.only(modCases, eq(modCases.caseId, existing.caseId)))
        .run();
      return { caseId: existing.caseId, violationCount };
    }

    const caseId = randomUUID();
    const violationCount = counts ? 1 : 0;
    db.insert(modCases)
      .values({
        guildId: scope.guildId,
        caseId,
        memberId: input.memberId,
        openedAt: input.now,
        violationCount,
        escalationTier: 0,
        status: 'open',
      })
      .run();
    return { caseId, violationCount };
  });

export interface RecordCaseEventInput {
  readonly eventId: string;
  readonly caseId: string;
  readonly ruleId: string;
  readonly memberId: string;
  readonly at: number;
  readonly matchedCategory: string;
  readonly matchedSnippet: string;
  readonly actionTaken: ModCaseActionTaken;
  /** Set only when `actionTaken` involves an escalation attempt. */
  readonly escalationAction?: ModCaseEscalationAction;
  /**
   * Set only when `actionTaken` is `'escalation_refused'`. The durable record
   * ADR 0035 asks for: a refused escalation is not merely logged, it is a
   * case event a moderator can see against the member's history.
   */
  readonly refusalReason?: ModCaseRefusalReason;
  /**
   * Who acted, for manual events (ADR 0037). Absent for automod/system
   * events — their actor is implicitly the bot — and required for the
   * manual vocabulary, where "every action records actor" is the gate.
   */
  readonly actorId?: string;
}

/**
 * Appends one event to a case's history.
 *
 * `onConflictDoNothing` is targeted at exactly the primary key
 * `(guild_id, event_id)` — not the unqualified form other repos use for a
 * whole-row dedupe — so it only ever suppresses a genuine duplicate
 * `event_id`. Most callers mint a fresh `crypto.randomUUID()` per call, for
 * which a collision is not a real possibility either way; the purge job
 * (`packages/core/src/mod/purge.ts`, ADR 0037) is the caller this exists
 * for — it mints a *deterministic* id (`<intentId>:<jobId>:<actionTaken>`)
 * so a crash-and-retry of the same job row writes the identical event twice
 * rather than two distinct ones, and this collapses the second write into a
 * no-op instead of a duplicate row or a thrown constraint error. A targeted
 * conflict clause matters here specifically because `action_taken` also
 * carries a CHECK constraint (`schema.ts`) that must keep throwing on a
 * genuinely invalid value — an unqualified `ON CONFLICT DO NOTHING` in
 * SQLite (unlike Postgres) suppresses *any* constraint violation on the
 * statement, CHECK included, which would have silently swallowed that
 * failure too.
 */
export const recordCaseEvent = (scope: GuildScope, input: RecordCaseEventInput): void =>
  write(scope, ({ db }) => {
    db.insert(modCaseEvents)
      .values({
        guildId: scope.guildId,
        eventId: input.eventId,
        caseId: input.caseId,
        ruleId: input.ruleId,
        memberId: input.memberId,
        at: input.at,
        matchedCategory: input.matchedCategory,
        matchedSnippet: input.matchedSnippet,
        actionTaken: input.actionTaken,
        escalationAction: input.escalationAction ?? null,
        refusalReason: input.refusalReason ?? null,
        actorId: input.actorId ?? null,
      })
      .onConflictDoNothing({ target: [modCaseEvents.guildId, modCaseEvents.eventId] })
      .run();
  });

export interface ModCaseEvent {
  readonly eventId: string;
  readonly caseId: string;
  readonly ruleId: string;
  readonly memberId: string;
  readonly at: number;
  readonly matchedCategory: string;
  readonly matchedSnippet: string;
  readonly actionTaken: ModCaseActionTaken;
  readonly escalationAction: ModCaseEscalationAction | undefined;
  readonly refusalReason: ModCaseRefusalReason | undefined;
  /** The moderator who acted, for manual events (ADR 0037). */
  readonly actorId: string | undefined;
}

/**
 * Every event recorded against `caseId`, guild-scoped, oldest first.
 *
 * Ordered by the table's own implicit SQLite `rowid` rather than `at`:
 * `mod_case_events` carries no autoincrement column of its own (unlike
 * `audit_events.audit_id`, which exists exactly to break ties the same way),
 * and `at` can legitimately tie — several violations processed against the
 * same message-handling tick share a clock reading in production and always
 * do in a test using a fake clock that does not auto-advance. Without an
 * `ORDER BY` at all, this query has no defined order — the planner is free to
 * satisfy `WHERE guild_id = ?` via the `(guild_id, event_id)` primary key
 * index, which sorts by `event_id` (a random UUID), so two events from the
 * very same case could come back in either order depending on which UUIDs
 * happened to sort where. `recordCaseEvent` only ever inserts, never updates,
 * so `rowid` — assigned once, in insertion order, and never reused for a
 * still-live row — is a correct, always-available substitute for a real
 * sequence column here. Found by Task 12's end-to-end escalation test, which
 * drives several events into one case and asserts a specific one is last.
 */
export const listCaseEvents = (scope: GuildScope, caseId: string): ModCaseEvent[] =>
  read(scope, (db) =>
    db
      .select()
      .from(modCaseEvents)
      .where(scope.only(modCaseEvents, eq(modCaseEvents.caseId, caseId)))
      .orderBy(sql`rowid`)
      .all()
      .map((row) => ({
        eventId: row.eventId,
        caseId: row.caseId,
        ruleId: row.ruleId,
        memberId: row.memberId,
        at: row.at,
        matchedCategory: row.matchedCategory,
        matchedSnippet: row.matchedSnippet,
        actionTaken: row.actionTaken as ModCaseActionTaken,
        escalationAction: (row.escalationAction ?? undefined) as
          ModCaseEscalationAction | undefined,
        refusalReason: (row.refusalReason ?? undefined) as ModCaseRefusalReason | undefined,
        actorId: row.actorId ?? undefined,
      })),
  );

export interface EscalationTier {
  readonly tier: number;
  /**
   * The automod ladder only ever times out or kicks (ADR 0035); the manual
   * actions `ban`/`unban` exist in `ModCaseEscalationAction` for `/mod`
   * commands, never for an automatic consequence.
   */
  readonly action: 'timeout' | 'kick' | undefined;
  readonly timeoutMs: number | undefined;
}

/**
 * The Release 2 default escalation ladder: log-only below 3 violations, a
 * 10-minute timeout at 3, a kick at 6. A future slice makes this
 * guild-configurable (out of scope here per the spec).
 *
 * Pure — no `GuildScope` — because the subscriber (Task 9) calls it once per
 * violation count with no need to touch the database, and a pure function is
 * trivially testable without a fixture.
 */
export const nextEscalationTier = (violationCount: number): EscalationTier => {
  if (violationCount >= 6) {
    return { tier: 2, action: 'kick', timeoutMs: undefined };
  }
  if (violationCount >= 3) {
    return { tier: 1, action: 'timeout', timeoutMs: 600_000 };
  }
  return { tier: 0, action: undefined, timeoutMs: undefined };
};
