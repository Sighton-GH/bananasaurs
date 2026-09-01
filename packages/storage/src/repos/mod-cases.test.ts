import { beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { parseGuildId, parseSnowflakeId } from '@bananasaurs/core';
import { upsertGuild } from './guilds.js';
import {
  listCaseEvents,
  nextEscalationTier,
  openOrResolveCase,
  recordCaseEvent,
  type ModCaseActionTaken,
} from './mod-cases.js';

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
   * The CHECK constraint is the real enforcement point for this vocabulary,
   * and a value the TypeScript union allows but the constraint rejects fails
   * only at runtime, in production, on the row that most needed writing.
   */
  it('accepts every action_taken value the union names, and rejects one it does not', () => {
    const scope = t.scopes.forGuild(GUILD);
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: 1000 });

    const all: ModCaseActionTaken[] = [
      'deleted',
      'deleted_and_escalated',
      'escalation_refused',
      'escalation_failed',
      'escalation_dry_run',
      'escalation_skipped',
      'would_delete',
      'delete_failed',
      'delete_blocked_killswitch',
      'delete_blocked_breaker',
      'delete_blocked_dry_run',
      'delete_blocked_guild_unknown',
    ];
    all.forEach((actionTaken, index) => {
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
    expect(listCaseEvents(scope, caseId).map((e) => e.actionTaken)).toEqual(all);

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
