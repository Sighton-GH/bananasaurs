import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
export type ModCaseActionTaken = 'deleted' | 'deleted_and_escalated' | 'escalation_refused';
export type ModCaseEscalationAction = 'timeout' | 'kick';
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

    if (existing) {
      const violationCount = existing.violationCount + 1;
      db.update(modCases)
        .set({ violationCount })
        .where(scope.only(modCases, eq(modCases.caseId, existing.caseId)))
        .run();
      return { caseId: existing.caseId, violationCount };
    }

    const caseId = randomUUID();
    db.insert(modCases)
      .values({
        guildId: scope.guildId,
        caseId,
        memberId: input.memberId,
        openedAt: input.now,
        violationCount: 1,
        escalationTier: 0,
        status: 'open',
      })
      .run();
    return { caseId, violationCount: 1 };
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
}

/** Appends one event to a case's history. Plain guild-scoped insert. */
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
      })
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
}

/** Every event recorded against `caseId`, guild-scoped. */
export const listCaseEvents = (scope: GuildScope, caseId: string): ModCaseEvent[] =>
  read(scope, (db) =>
    db
      .select()
      .from(modCaseEvents)
      .where(scope.only(modCaseEvents, eq(modCaseEvents.caseId, caseId)))
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
      })),
  );

export interface EscalationTier {
  readonly tier: number;
  readonly action: ModCaseEscalationAction | undefined;
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
