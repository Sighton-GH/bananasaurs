import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { automodFixtures, modCaseEvents, modCases, modMatchReviews } from '../schema.js';

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
  | 'manual_applied'
  /**
   * Native Discord AutoMod acted (ADR 0038). Recorded, never counted: these
   * carry `countsAsViolation: false`, because an algorithm nobody can inspect
   * must not increment the counter that drives our timeouts and bans.
   */
  | 'native_blocked'
  | 'native_alerted'
  | 'native_timeout'
  | 'native_blocked_interaction';
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
  /**
   * Why the rule matched, as JSON (ADR 0041 §4). Absent for a manual event
   * and for a native AutoMod event, neither of which came from a predicate.
   *
   * Deliberately a `string`, not a parsed object — and **not** because
   * storage cannot import core. It can, and does elsewhere (`scope.ts`,
   * `repos/authz.ts`). The reason is that validation belongs at the one
   * place that gives the text meaning: the Zod schema lives in
   * `packages/core/src/automod/trace.ts` beside the `MatchTrace` it
   * validates, and a repository that parsed it would be a second opinion
   * about a shape it does not own. The composition root serialises on the
   * way in and `core` validates on the way out — exactly the arrangement
   * `mod_rules.config` already has (ADR 0040).
   */
  readonly trace?: string;
  /**
   * The `automod_fixtures` row captured from the same message, if one was
   * (plan ruling PR-5). What lets a verdict recorded during the observe
   * window become a labelled regression fixture afterwards.
   */
  readonly fixtureId?: string;
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
        trace: input.trace ?? null,
        fixtureId: input.fixtureId ?? null,
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
  /**
   * Why the rule matched, as raw JSON (ADR 0041 §4). `undefined` for a
   * manual event, a native AutoMod event, and every row written before this
   * slice. `packages/core`'s `parseMatchTrace` is what reads it.
   */
  readonly trace: string | undefined;
  /** The `automod_fixtures` row captured from the same message, if one was. */
  readonly fixtureId: string | undefined;
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
        trace: row.trace ?? undefined,
        fixtureId: row.fixtureId ?? undefined,
      })),
  );

export interface ReviewableMatch {
  readonly eventId: string;
  readonly ruleId: string;
  readonly memberId: string;
  readonly at: number;
  readonly matchedCategory: string;
  readonly matchedSnippet: string;
  readonly actionTaken: ModCaseActionTaken;
  /** Raw JSON; `packages/core`'s `parseMatchTrace` is what reads it. */
  readonly trace: string | undefined;
  readonly fixtureId: string | undefined;
  /**
   * The whole message, when the corpus still holds it.
   *
   * `undefined` after a member's `/forgetme` removed the fixture, and for an
   * enforce-mode match, which captures nothing (plan ruling PR-2). A reviewer
   * then judges from the trace and the snippet alone, which is worse but
   * honest — it is the difference between having the evidence and pretending
   * to.
   */
  readonly fixtureContent: string | undefined;
}

/**
 * Matches nobody has ruled on yet, oldest first (ADR 0041 §5, §7).
 *
 * "A match" is defined as "an event with a trace" (plan ruling PR-7): only a
 * predicate match writes one, so this excludes manual `/mod` events and
 * native Discord AutoMod events without a hand-maintained list of
 * `action_taken` values to keep in step with the vocabulary.
 *
 * Two left joins, and both are left joins on purpose: an unreviewed match is
 * precisely one with no `mod_match_reviews` row, and a match whose fixture a
 * member has since deleted must still be reviewable. An inner join on either
 * would silently drop rows — reviewed matches would vanish with the wrong
 * one, and a `/forgetme`'d fixture would erase the match with the other. Both
 * are proven in `mod-cases.test.ts` by breaking each join in turn and
 * watching the matching test go red.
 *
 * The guild predicate lives on the driving table (`modCaseEvents`) via
 * `scope.only`, and both join conditions carry `guild_id` themselves, so a
 * join cannot cross guilds even before the WHERE clause is applied.
 *
 * Ordered like `listCaseEvents`: `at` can legitimately tie, and
 * `mod_case_events` has no autoincrement column of its own, so the table's
 * own implicit SQLite `rowid` — assigned once, in insertion order — is the
 * tiebreaker. Qualified with the table name (unlike `listCaseEvents`'s bare
 * `rowid`) because this query joins three tables and an unqualified `rowid`
 * would be ambiguous between them.
 */
export const listUnreviewedMatches = (
  scope: GuildScope,
  query: { readonly ruleId?: string; readonly limit: number },
): readonly ReviewableMatch[] =>
  read(scope, (db) =>
    db
      .select({
        eventId: modCaseEvents.eventId,
        ruleId: modCaseEvents.ruleId,
        memberId: modCaseEvents.memberId,
        at: modCaseEvents.at,
        matchedCategory: modCaseEvents.matchedCategory,
        matchedSnippet: modCaseEvents.matchedSnippet,
        actionTaken: modCaseEvents.actionTaken,
        trace: modCaseEvents.trace,
        fixtureId: modCaseEvents.fixtureId,
        fixtureContent: automodFixtures.content,
      })
      .from(modCaseEvents)
      .leftJoin(
        modMatchReviews,
        and(
          eq(modMatchReviews.guildId, modCaseEvents.guildId),
          eq(modMatchReviews.eventId, modCaseEvents.eventId),
        ),
      )
      .leftJoin(
        automodFixtures,
        and(
          eq(automodFixtures.guildId, modCaseEvents.guildId),
          eq(automodFixtures.fixtureId, modCaseEvents.fixtureId),
        ),
      )
      .where(
        scope.only(
          modCaseEvents,
          isNotNull(modCaseEvents.trace),
          isNull(modMatchReviews.eventId),
          ...(query.ruleId === undefined ? [] : [eq(modCaseEvents.ruleId, query.ruleId)]),
        ),
      )
      .orderBy(asc(modCaseEvents.at), sql`mod_case_events.rowid`)
      .limit(query.limit)
      .all()
      .map((row) => ({
        eventId: row.eventId,
        ruleId: row.ruleId,
        memberId: row.memberId,
        at: row.at,
        matchedCategory: row.matchedCategory,
        matchedSnippet: row.matchedSnippet,
        actionTaken: row.actionTaken as ModCaseActionTaken,
        trace: row.trace ?? undefined,
        fixtureId: row.fixtureId ?? undefined,
        fixtureContent: row.fixtureContent ?? undefined,
      })),
  );

export interface ModCase {
  readonly caseId: string;
  readonly memberId: string;
  readonly openedAt: number;
  readonly violationCount: number;
  readonly escalationTier: number;
  readonly status: ModCaseStatus;
}

/**
 * Every case ever opened for `memberId`, guild-scoped — `/mod history`
 * (Task 9), the last `/mod` subcommand.
 *
 * Ordered open-first, then newest-opened-first. In production today
 * `mod_cases_open_per_member`'s partial unique index and the absence of any
 * code path that ever sets `status = 'closed'` mean a member has at most one
 * row, so this ordering is untested by production traffic — but the schema
 * already carries a `status` column and this function is written for the
 * general case the schema anticipates (multiple historical cases per
 * member), not for today's single-row reality. "Open first" beats
 * "newest first" deliberately: an operator running `/mod history` wants the
 * live case at the top even if, hypothetically, a closed case were reopened
 * more recently in wall-clock terms than the member's current open case —
 * there is no such path today, but the ordering still encodes the right
 * priority rather than a coincidentally-correct one.
 *
 * `ORDER BY` needs two tiebreakers beyond `status`/`openedAt`: `openedAt` can
 * tie the same way `listCaseEvents`' docstring explains `at` can (a fake
 * clock in a test, or two rows landing in the same production millisecond),
 * and `case_id` is a random UUID with no useful sort order of its own. Like
 * `listCaseEvents`, this falls back to the table's own implicit SQLite
 * `rowid` — insertion order, newest last — so `rowid DESC` is a stable,
 * always-available "most recently inserted" tiebreaker within a tied
 * `(status, openedAt)` group.
 */
export const listCasesForMember = (scope: GuildScope, memberId: string): ModCase[] =>
  read(scope, (db) =>
    db
      .select()
      .from(modCases)
      .where(scope.only(modCases, eq(modCases.memberId, memberId)))
      .orderBy(
        sql`CASE WHEN ${modCases.status} = 'open' THEN 0 ELSE 1 END`,
        desc(modCases.openedAt),
        sql`rowid DESC`,
      )
      .all()
      .map((row) => ({
        caseId: row.caseId,
        memberId: row.memberId,
        openedAt: row.openedAt,
        violationCount: row.violationCount,
        escalationTier: row.escalationTier,
        status: row.status as ModCaseStatus,
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
