import { beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { parseGuildId, parseSnowflakeId } from '@bananasaurs/core';
import { upsertGuild } from './guilds.js';
import {
  listCaseEvents,
  listCasesForMember,
  listUnreviewedMatches,
  nextEscalationTier,
  openOrResolveCase,
  recordCaseEvent,
  type ModCaseActionTaken,
} from './mod-cases.js';
import { modCases } from '../schema.js';
import { captureObservedFixture, deleteObservedFixturesForMember } from './automod-fixtures.js';
import { recordVerdict } from './mod-match-reviews.js';
import type { GuildScope } from '../scope.js';

const GUILD = parseGuildId('111111111111111111');
const MEMBER = parseSnowflakeId('222222222222222222');

let t: MigratedTestDatabase;

// `mod_cases.guild_id` carries a real foreign key to `guilds`, like every
// guild-scoped table — so, as in `automod-rules.test.ts`, the guild must
// exist before a case can be opened in it.
beforeEach(() => {
  t = openMigratedTestDatabase();
  upsertGuild(t.scopes.forGuild(GUILD), { name: 'guild', now: 0 });
});

describe('mod cases repo', () => {
  it('opens a new case on first violation, violationCount 1', () => {
    const scope = t.scopes.forGuild(GUILD);
    const result = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });
    expect(result.violationCount).toBe(1);
  });

  it('resolves into the same open case on a second violation', () => {
    const scope = t.scopes.forGuild(GUILD);
    const first = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });
    const second = openOrResolveCase(scope, { memberId: MEMBER, now: 2000 });
    expect(second.caseId).toBe(first.caseId);
    expect(second.violationCount).toBe(2);
  });

  /**
   * The staged rollout (spec §8) only works if an observation is recorded
   * without moving the counter `nextEscalationTier` reads — otherwise the
   * first real match after an operator flips a rule to enforce inherits every
   * test-mode match and can go straight to a kick.
   */
  describe('countsAsViolation: false', () => {
    it('opens a case at zero rather than one', () => {
      const scope = t.scopes.forGuild(GUILD);
      const result = openOrResolveCase(scope, {
        memberId: MEMBER,
        now: 1000,
        countsAsViolation: false,
      });
      expect(result.violationCount).toBe(0);
    });

    it('leaves an existing case’s count exactly where it was', () => {
      const scope = t.scopes.forGuild(GUILD);
      const first = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });
      for (let i = 0; i < 5; i += 1) {
        openOrResolveCase(scope, { memberId: MEMBER, now: 2000, countsAsViolation: false });
      }
      const after = openOrResolveCase(scope, {
        memberId: MEMBER,
        now: 3000,
        countsAsViolation: false,
      });

      expect(after.caseId).toBe(first.caseId);
      expect(after.violationCount).toBe(1);
      // ...and a counting call still increments from there, not from six.
      expect(openOrResolveCase(scope, { memberId: MEMBER, now: 4000 }).violationCount).toBe(2);
    });
  });

  it('records a case event, including a refusal', () => {
    const scope = t.scopes.forGuild(GUILD);
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });
    recordCaseEvent(scope, {
      eventId: 'e1',
      caseId,
      ruleId: 'r1',
      memberId: MEMBER,
      at: 1000,
      matchedCategory: 'c1',
      matchedSnippet: 'badword',
      actionTaken: 'escalation_refused',
      escalationAction: 'timeout',
      refusalReason: 'discord-owner',
    });
    // asserted via a read helper this task also adds, listCaseEvents(scope, caseId)
    expect(listCaseEvents(scope, caseId)).toHaveLength(1);
  });

  /**
   * ADR 0037's purge job mints a *deterministic* `eventId` so a crash-and-
   * retry of the same job row writes the identical event twice rather than
   * two distinct ones (CLAUDE.md rule 6). The targeted `ON CONFLICT
   * (guild_id, event_id) DO NOTHING` this relies on must collapse a genuine
   * duplicate silently — proven here directly against the repo, independent
   * of the purge job's own tests.
   */
  it('a duplicate eventId is a silent no-op, not a duplicate row or a thrown error', () => {
    const scope = t.scopes.forGuild(GUILD);
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });
    const write = () =>
      recordCaseEvent(scope, {
        eventId: 'dup-1',
        caseId,
        ruleId: 'manual',
        memberId: MEMBER,
        at: 1000,
        matchedCategory: 'purge',
        matchedSnippet: 'first write',
        actionTaken: 'purged',
      });

    expect(write).not.toThrow();
    expect(() =>
      recordCaseEvent(scope, {
        eventId: 'dup-1',
        caseId,
        ruleId: 'manual',
        memberId: MEMBER,
        at: 2000,
        matchedCategory: 'purge',
        matchedSnippet: 'second write, should collapse',
        actionTaken: 'purged',
      }),
    ).not.toThrow();

    const events = listCaseEvents(scope, caseId);
    expect(events).toHaveLength(1);
    // The first write's content survives; the second was a no-op, not an
    // update — matching `jobRepo.enqueue`'s own dedupe semantics.
    expect(events[0]?.matchedSnippet).toBe('first write');
  });

  /**
   * That the `action_taken` CHECK still fires through the repository path,
   * conflict clause and all.
   *
   * **This comment used to claim more than the test proves**, and the
   * correction is worth keeping visible. It said a *targeted* conflict clause
   * was what kept the CHECK throwing, because an unqualified
   * `ON CONFLICT DO NOTHING` suppresses any constraint failure in SQLite.
   * That is false — measured against this repo's own better-sqlite3, plain,
   * unqualified and targeted inserts all three throw on a CHECK violation;
   * only the `INSERT OR IGNORE` statement prefix swallows one, and drizzle
   * does not emit it. So this test passes with either clause and could never
   * have caught the regression it named.
   *
   * It is kept because what it does prove is still worth pinning: an invalid
   * `action_taken` does not reach the database through this function. The
   * reasoning behind the clause itself now lives, corrected, on
   * `recordCaseEvent`.
   */
  it('still rejects an invalid action_taken even with the conflict clause present', () => {
    const scope = t.scopes.forGuild(GUILD);
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });
    expect(() =>
      recordCaseEvent(scope, {
        eventId: 'never-written',
        caseId,
        ruleId: 'r1',
        memberId: MEMBER,
        at: 1000,
        matchedCategory: 'c1',
        matchedSnippet: 'badword',
        actionTaken: 'invented' as ModCaseActionTaken,
      }),
    ).toThrow();
    expect(listCaseEvents(scope, caseId)).toHaveLength(0);
  });

  /**
   * The CHECK constraint is the real enforcement point for this vocabulary,
   * and a value the TypeScript union allows but the constraint rejects fails
   * only at runtime, in production, on the row that most needed writing.
   * Using Record<ModCaseActionTaken, true> makes exhaustiveness a compile-time
   * error rather than a forgotten assertion.
   */
  it('accepts every action_taken value the union names, and rejects one it does not', () => {
    const scope = t.scopes.forGuild(GUILD);
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });

    const all: Record<ModCaseActionTaken, true> = {
      deleted: true,
      deleted_and_escalated: true,
      escalation_refused: true,
      escalation_failed: true,
      escalation_dry_run: true,
      escalation_skipped: true,
      would_delete: true,
      delete_failed: true,
      delete_blocked_killswitch: true,
      delete_blocked_breaker: true,
      delete_blocked_dry_run: true,
      delete_blocked_guild_unknown: true,
      warned: true,
      note: true,
      evidence_added: true,
      purged: true,
      purge_refused: true,
      purge_failed: true,
      manual_applied: true,
      native_blocked: true,
      native_alerted: true,
      native_timeout: true,
      native_blocked_interaction: true,
    };
    const allKeys = Object.keys(all) as ModCaseActionTaken[];
    allKeys.forEach((actionTaken, index) => {
      recordCaseEvent(scope, {
        eventId: `e-${index}`,
        caseId,
        ruleId: 'r1',
        memberId: MEMBER,
        at: 1000,
        matchedCategory: 'c1',
        matchedSnippet: 'badword',
        actionTaken,
      });
    });
    expect(listCaseEvents(scope, caseId).map((e) => e.actionTaken)).toEqual(allKeys);

    expect(() =>
      recordCaseEvent(scope, {
        eventId: 'e-bogus',
        caseId,
        ruleId: 'r1',
        memberId: MEMBER,
        at: 1000,
        matchedCategory: 'c1',
        matchedSnippet: 'badword',
        actionTaken: 'invented' as ModCaseActionTaken,
      }),
    ).toThrow();
  });
});

describe('nextEscalationTier', () => {
  it('is log-only below the first threshold', () => {
    expect(nextEscalationTier(1)).toEqual({ tier: 0, action: undefined, timeoutMs: undefined });
  });

  it('times out at the configured threshold', () => {
    expect(nextEscalationTier(3)).toEqual({ tier: 1, action: 'timeout', timeoutMs: 600_000 });
  });

  it('kicks at the top tier', () => {
    expect(nextEscalationTier(6)).toEqual({ tier: 2, action: 'kick', timeoutMs: undefined });
  });
});

/**
 * ADR 0037's manual-action vocabulary (seven additive values, plus the
 * widened escalation_action). The CHECK constraint is the real
 * enforcement point (the test above established the idiom), so each new
 * value must be accepted by the migrated schema, not merely by the
 * TypeScript union — and `escalation_action` must widen to `ban`/`unban`
 * for the `/mod` commands that reuse the escalation-outcome mapping.
 */
describe('mod case events — the manual-action vocabulary (ADR 0037)', () => {
  it('accepts every manual-action value the widened union names', () => {
    const scope = t.scopes.forGuild(GUILD);
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });

    const manual: ModCaseActionTaken[] = [
      'warned',
      'note',
      'evidence_added',
      'purged',
      'purge_refused',
      'purge_failed',
      'manual_applied',
    ];
    manual.forEach((actionTaken, index) => {
      recordCaseEvent(scope, {
        eventId: `m-${index}`,
        caseId,
        ruleId: 'manual',
        memberId: MEMBER,
        at: 1000,
        matchedCategory: 'manual',
        matchedSnippet: 'reason text',
        actionTaken,
      });
    });
    expect(listCaseEvents(scope, caseId).map((e) => e.actionTaken)).toEqual(manual);
  });

  it('accepts escalation_action ban and unban', () => {
    const scope = t.scopes.forGuild(GUILD);
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });
    recordCaseEvent(scope, {
      eventId: 'b-1',
      caseId,
      ruleId: 'manual',
      memberId: MEMBER,
      at: 1000,
      matchedCategory: 'manual',
      matchedSnippet: 'reason',
      actionTaken: 'escalation_refused',
      escalationAction: 'ban',
      refusalReason: 'discord-owner',
    });
    const events = listCaseEvents(scope, caseId);
    expect(events[0]?.escalationAction).toBe('ban');
  });

  /**
   * "Every action records actor" (Release 2 gate): a manual event carries
   * the moderator's id; an automod event leaves it null and keeps meaning.
   */
  it('round-trips actor_id, null when absent', () => {
    const scope = t.scopes.forGuild(GUILD);
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });
    recordCaseEvent(scope, {
      eventId: 'a-1',
      caseId,
      ruleId: 'manual',
      memberId: MEMBER,
      at: 1000,
      matchedCategory: 'manual',
      matchedSnippet: 'strike one',
      actionTaken: 'warned',
      actorId: MEMBER,
    });
    recordCaseEvent(scope, {
      eventId: 'a-2',
      caseId,
      ruleId: 'r1',
      memberId: MEMBER,
      at: 2000,
      matchedCategory: 'c1',
      matchedSnippet: 'badword',
      actionTaken: 'deleted',
    });
    const events = listCaseEvents(scope, caseId);
    expect(events[0]?.actorId).toBe(MEMBER);
    expect(events[1]?.actorId).toBeUndefined();
  });
});

/**
 * The owner's ladder-feeding decision (ADR 0037 §Warnings feed the ladder):
 * a mod warning increments the SAME per-member counter automod violations
 * use, with the same semantics. These tests pin the equality at the storage
 * layer — where the two sources meet — so that an implementation detail
 * (which call site increments) can never make them diverge.
 */
describe('moderator warnings share the escalation counter (ADR 0037)', () => {
  it('mixed automod strikes and mod warnings are one counter, order-independent', () => {
    const scope = t.scopes.forGuild(GUILD);
    const OTHER = parseSnowflakeId('666666666666666666');

    // Automod → warn → automod: one member, one counter.
    const a1 = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });
    const w1 = openOrResolveCase(scope, { memberId: MEMBER, now: 2000 });
    const a2 = openOrResolveCase(scope, { memberId: MEMBER, now: 3000 });
    expect(a1.violationCount).toBe(1);
    expect(w1.violationCount).toBe(2);
    expect(a2.violationCount).toBe(3);

    // Three automod strikes alone: the identical sequence.
    const b1 = openOrResolveCase(scope, { memberId: OTHER, now: 1000 });
    const b2 = openOrResolveCase(scope, { memberId: OTHER, now: 2000 });
    const b3 = openOrResolveCase(scope, { memberId: OTHER, now: 3000 });
    expect([b1.violationCount, b2.violationCount, b3.violationCount]).toEqual([1, 2, 3]);

    // `nextEscalationTier` cannot tell the sources apart — that is the point:
    // the mixed sequence (automod, warn, automod) and the pure-automod
    // sequence both reach a count of 3, and the tier decision agrees.
    expect(nextEscalationTier(a2.violationCount)).toEqual(nextEscalationTier(b3.violationCount));
    expect(nextEscalationTier(6)).toEqual({ tier: 2, action: 'kick', timeoutMs: undefined });
  });

  it('a warn resolves into the case an automod strike opened', () => {
    const scope = t.scopes.forGuild(GUILD);
    const automod = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });
    const warn = openOrResolveCase(scope, { memberId: MEMBER, now: 2000 });
    expect(warn.caseId).toBe(automod.caseId);
    expect(warn.violationCount).toBe(2);
  });

  it('has no expiry for either source — the counter is monotonic over the open case', () => {
    const scope = t.scopes.forGuild(GUILD);
    const first = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });
    // A violation 90 days later still resolves into the same open case and
    // still increments — nothing here resets or decays the count with the
    // passage of time. If the counter expired, this would come back at 1
    // (reset) or some smaller/artificial value; instead it keeps counting
    // exactly as an immediate second violation would.
    const later = openOrResolveCase(scope, {
      memberId: MEMBER,
      now: 1000 + 90 * 24 * 60 * 60 * 1000,
    });
    expect(later.caseId).toBe(first.caseId);
    expect(later.violationCount).toBe(2);
  });
});

/**
 * `/mod history` (Task 9) reads through this. There is no code path in the
 * product today that ever sets `status = 'closed'` — `openOrResolveCase`
 * only ever opens or resolves into an existing open case — so a closed row
 * below is seeded directly against `modCases` (bypassing the repo, which
 * offers no close operation) purely to exercise the ordering the schema's
 * `status` column anticipates. Building a case-closing feature is out of
 * scope for this task.
 */
describe('listCasesForMember', () => {
  const seedClosedCase = (
    scope: ReturnType<MigratedTestDatabase['scopes']['forGuild']>,
    input: { caseId: string; memberId: string; openedAt: number; violationCount?: number },
  ): void => {
    t.db
      .insert(modCases)
      .values({
        guildId: scope.guildId,
        caseId: input.caseId,
        memberId: input.memberId,
        openedAt: input.openedAt,
        violationCount: input.violationCount ?? 1,
        escalationTier: 0,
        status: 'closed',
      })
      .run();
  };

  it('is guild-scoped: another guild’s member with the identical id returns nothing', () => {
    const scope = t.scopes.forGuild(GUILD);
    openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });

    const otherGuild = parseGuildId('999999999999999999');
    upsertGuild(t.scopes.forGuild(otherGuild), { name: 'other guild', now: 0 });
    const otherScope = t.scopes.forGuild(otherGuild);

    expect(listCasesForMember(otherScope, MEMBER)).toEqual([]);
    // Sanity: the case really exists, just not reachable through the wrong scope.
    expect(listCasesForMember(scope, MEMBER)).toHaveLength(1);
  });

  it('returns nothing for a member who has never had a case', () => {
    const scope = t.scopes.forGuild(GUILD);
    expect(listCasesForMember(scope, MEMBER)).toEqual([]);
  });

  it('open sorts before closed even when the closed case is more recently opened', () => {
    const scope = t.scopes.forGuild(GUILD);
    seedClosedCase(scope, { caseId: 'closed-newer', memberId: MEMBER, openedAt: 5000 });
    const open = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });

    const cases = listCasesForMember(scope, MEMBER);
    expect(cases.map((c) => c.caseId)).toEqual([open.caseId, 'closed-newer']);
    expect(cases[0]?.status).toBe('open');
    expect(cases[1]?.status).toBe('closed');
  });

  it('within the same status, newest opened_at sorts first', () => {
    const scope = t.scopes.forGuild(GUILD);
    seedClosedCase(scope, { caseId: 'closed-old', memberId: MEMBER, openedAt: 1000 });
    seedClosedCase(scope, { caseId: 'closed-new', memberId: MEMBER, openedAt: 2000 });

    const cases = listCasesForMember(scope, MEMBER);
    expect(cases.map((c) => c.caseId)).toEqual(['closed-new', 'closed-old']);
  });

  it('returns the full row shape: caseId, memberId, openedAt, violationCount, escalationTier, status', () => {
    const scope = t.scopes.forGuild(GUILD);
    openOrResolveCase(scope, { memberId: MEMBER, now: 1234 });
    openOrResolveCase(scope, { memberId: MEMBER, now: 2345 });

    const cases = listCasesForMember(scope, MEMBER);
    expect(cases).toEqual([
      {
        caseId: cases[0]?.caseId,
        memberId: MEMBER,
        openedAt: 1234,
        violationCount: 2,
        escalationTier: 0,
        status: 'open',
      },
    ]);
  });

  it('once a case is found, listCaseEvents(caseId) gives the full per-case picture', () => {
    const scope = t.scopes.forGuild(GUILD);
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });
    recordCaseEvent(scope, {
      eventId: 'evt-1',
      caseId,
      ruleId: 'manual',
      memberId: MEMBER,
      at: 1000,
      matchedCategory: 'note',
      matchedSnippet: 'first contact',
      actionTaken: 'note',
      actorId: '777777777777777777',
    });
    recordCaseEvent(scope, {
      eventId: 'evt-2',
      caseId,
      ruleId: 'manual',
      memberId: MEMBER,
      at: 2000,
      matchedCategory: 'timeout',
      matchedSnippet: 'being disruptive',
      actionTaken: 'manual_applied',
      escalationAction: 'timeout',
      actorId: '777777777777777777',
    });

    const [foundCase] = listCasesForMember(scope, MEMBER);
    expect(foundCase?.caseId).toBe(caseId);
    const events = listCaseEvents(scope, foundCase!.caseId);
    expect(events.map((e) => e.eventId)).toEqual(['evt-1', 'evt-2']);
    expect(events.map((e) => e.actionTaken)).toEqual(['note', 'manual_applied']);
  });

  /**
   * The union, the CHECK and core's mirror are three hand-maintained copies
   * (ADR 0014 forbids the shared import that would remove the duplication).
   * A value added to two of the three fails at runtime, not at compile time
   * — so this test walks every member of the union through a real insert.
   * Using Record<ModCaseActionTaken, true> makes exhaustiveness a compile-time
   * error rather than a forgotten assertion.
   */
  it('every action_taken value the union names is accepted by the CHECK', () => {
    const scope = t.scopes.forGuild(GUILD);
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: 1 });

    const all: Record<ModCaseActionTaken, true> = {
      deleted: true,
      deleted_and_escalated: true,
      escalation_refused: true,
      escalation_failed: true,
      escalation_dry_run: true,
      escalation_skipped: true,
      would_delete: true,
      delete_failed: true,
      delete_blocked_killswitch: true,
      delete_blocked_breaker: true,
      delete_blocked_dry_run: true,
      delete_blocked_guild_unknown: true,
      warned: true,
      note: true,
      evidence_added: true,
      purged: true,
      purge_refused: true,
      purge_failed: true,
      manual_applied: true,
      native_blocked: true,
      native_alerted: true,
      native_timeout: true,
      native_blocked_interaction: true,
    };

    for (const actionTaken of Object.keys(all) as ModCaseActionTaken[]) {
      expect(() =>
        recordCaseEvent(scope, {
          eventId: `evt-${actionTaken}`,
          caseId,
          ruleId: 'native:222222222222222222',
          memberId: MEMBER,
          at: 1,
          matchedCategory: 'keyword',
          matchedSnippet: 'x',
          actionTaken,
        }),
      ).not.toThrow();
    }
  });
});

/**
 * `listUnreviewedMatches` (ADR 0041 §5, §7, plan ruling PR-7): matches
 * reviewable exactly when they carry a trace, oldest first, excluding
 * anything already reviewed. Two left joins bring in the review state and
 * the captured fixture without ever losing a row that has neither.
 */
describe('listUnreviewedMatches', () => {
  /**
   * Seeds a case and one predicate-match event against it — the shape a
   * `test`/`observe`-mode automod match really writes: a case event carrying
   * a trace and, when a fixture was captured from the same message, the
   * fixture's id.
   */
  const seedMatchEvent = (
    s: GuildScope,
    input: {
      readonly eventId: string;
      readonly fixtureId?: string;
      readonly trace: string | undefined;
      readonly ruleId?: string;
      readonly memberId?: string;
      readonly at?: number;
    },
  ): void => {
    const memberId = input.memberId ?? MEMBER;
    const at = input.at ?? 1_000;
    const { caseId } = openOrResolveCase(s, { memberId, now: at });
    recordCaseEvent(s, {
      eventId: input.eventId,
      caseId,
      ruleId: input.ruleId ?? 'r1',
      memberId,
      at,
      matchedCategory: 'keyword_filter',
      matchedSnippet: 'snippet',
      actionTaken: input.trace === undefined ? 'manual_applied' : 'would_delete',
      ...(input.trace === undefined ? {} : { trace: input.trace }),
      ...(input.fixtureId === undefined ? {} : { fixtureId: input.fixtureId }),
    });
  };

  it('lists only matches with a trace, and only unreviewed ones', () => {
    const scope = t.scopes.forGuild(GUILD);
    seedMatchEvent(scope, { eventId: 'traced', trace: '{"kind":"keyword_filter"}', at: 1_000 });
    seedMatchEvent(scope, { eventId: 'manual', trace: undefined, at: 2_000 }); // a /mod warn
    seedMatchEvent(scope, { eventId: 'reviewed', trace: '{"kind":"keyword_filter"}', at: 3_000 });
    recordVerdict(scope, {
      eventId: 'reviewed',
      verdict: 'true_positive',
      reviewedBy: '777777777777777777',
      reviewedAt: 1,
    });

    expect(listUnreviewedMatches(scope, { limit: 50 }).map((m) => m.eventId)).toEqual(['traced']);
  });

  it('brings the whole message along when the corpus still has it', () => {
    const scope = t.scopes.forGuild(GUILD);
    const fixtureId = captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'the whole matched message',
      authorId: MEMBER,
      createdAt: 500,
    });
    seedMatchEvent(scope, { eventId: 'e1', fixtureId, trace: '{"kind":"keyword_filter"}' });

    const [match] = listUnreviewedMatches(scope, { limit: 50 });
    expect(match?.fixtureId).toBe(fixtureId);
    expect(match?.fixtureContent).toBe('the whole matched message');
  });

  it('still lists a match whose fixture was forgotten', () => {
    const scope = t.scopes.forGuild(GUILD);
    const fixtureId = captureObservedFixture(scope, {
      messageId: '900000000000000002',
      content: 'a message someone later forgot',
      authorId: MEMBER,
      createdAt: 500,
    });
    seedMatchEvent(scope, { eventId: 'e1', fixtureId, trace: '{"kind":"keyword_filter"}' });
    deleteObservedFixturesForMember(scope, MEMBER);

    const matches = listUnreviewedMatches(scope, { limit: 50 });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.eventId).toBe('e1');
    expect(matches[0]?.fixtureContent).toBeUndefined();
  });

  it('does not list another guild’s matches', () => {
    const otherGuild = parseGuildId('999999999999999999');
    upsertGuild(t.scopes.forGuild(otherGuild), { name: 'other guild', now: 0 });
    const otherScope = t.scopes.forGuild(otherGuild);
    seedMatchEvent(otherScope, { eventId: 'e1', trace: '{}' });

    const scope = t.scopes.forGuild(GUILD);
    expect(listUnreviewedMatches(scope, { limit: 50 })).toEqual([]);
    expect(listUnreviewedMatches(otherScope, { limit: 50 })).toHaveLength(1);
  });

  it('filters by rule id', () => {
    const scope = t.scopes.forGuild(GUILD);
    seedMatchEvent(scope, { eventId: 'e1', trace: '{}', ruleId: 'r1', at: 1_000 });
    seedMatchEvent(scope, { eventId: 'e2', trace: '{}', ruleId: 'r2', at: 2_000 });

    expect(listUnreviewedMatches(scope, { ruleId: 'r1', limit: 50 }).map((m) => m.eventId)).toEqual(
      ['e1'],
    );
  });

  it('orders oldest first, breaking ties in insertion order', () => {
    const scope = t.scopes.forGuild(GUILD);
    // Same `at`: only insertion order (rowid) can break the tie.
    //
    // The ids are deliberately reverse-alphabetical to insertion order. With
    // 'first'/'second' this test passed with the rowid tiebreaker deleted
    // outright — the primary-key index happens to return them in id order,
    // which for those two names is also insertion order, so the assertion was
    // correct about an input where the bug cannot occur. 'zzz' inserted before
    // 'aaa' separates the two orderings, so only a real tiebreaker satisfies
    // it. Found by Task 5's reviewer.
    seedMatchEvent(scope, { eventId: 'zzz', trace: '{}', at: 1_000 });
    seedMatchEvent(scope, { eventId: 'aaa', trace: '{}', at: 1_000 });

    expect(listUnreviewedMatches(scope, { limit: 50 }).map((m) => m.eventId)).toEqual([
      'zzz',
      'aaa',
    ]);
  });

  it('returns no more than the limit asks for', () => {
    const scope = t.scopes.forGuild(GUILD);
    seedMatchEvent(scope, { eventId: 'e1', trace: '{}', at: 1_000 });
    seedMatchEvent(scope, { eventId: 'e2', trace: '{}', at: 2_000 });
    seedMatchEvent(scope, { eventId: 'e3', trace: '{}', at: 3_000 });

    // The CLI pages through the review queue, so a limit that is accepted and
    // ignored would hand an operator the whole window's matches at once.
    expect(listUnreviewedMatches(scope, { limit: 2 }).map((m) => m.eventId)).toEqual(['e1', 'e2']);
  });
});
