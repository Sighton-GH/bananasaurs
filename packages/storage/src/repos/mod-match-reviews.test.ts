import { beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { parseGuildId } from '@bananasaurs/core';
import { upsertGuild } from './guilds.js';
import type { GuildScope } from '../scope.js';
import { openOrResolveCase, recordCaseEvent } from './mod-cases.js';
import {
  captureObservedFixture,
  deleteObservedFixturesForMember,
  listFixtures,
} from './automod-fixtures.js';
import { findVerdict, recordVerdict, type MatchVerdict } from './mod-match-reviews.js';

const GUILD = parseGuildId('111111111111111111');
const GUILD_A = parseGuildId('222222222222222222');
const GUILD_B = parseGuildId('333333333333333333');
const MEMBER = '800000000000000001';
const REVIEWER = '700000000000000001';

let t: MigratedTestDatabase;
let scope: GuildScope;

/**
 * Seeds a case and one predicate-match event against it, the shape
 * `recordVerdict`/`listUnreviewedMatches` operate over. Mirrors what the
 * automod subscriber really writes for a `test`/`observe`-mode match: a case
 * event carrying a trace and, when a fixture was captured from the same
 * message, the fixture's id.
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
    actionTaken: 'would_delete',
    ...(input.trace === undefined ? {} : { trace: input.trace }),
    ...(input.fixtureId === undefined ? {} : { fixtureId: input.fixtureId }),
  });
};

// `mod_match_reviews.guild_id` carries a real foreign key to `guilds`, and
// `mod_case_events` does too by way of `mod_cases` — the guild must exist
// before either can be written.
beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  upsertGuild(scope, { name: 'guild', now: 0 });
});

describe('recordVerdict', () => {
  it('records a verdict and labels the fixture it came from', () => {
    const fixtureId = captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'perfectly ordinary sentence',
      authorId: MEMBER,
      createdAt: 1_000,
    });
    seedMatchEvent(scope, { eventId: 'e1', fixtureId, trace: '{"kind":"keyword_filter"}' });

    expect(
      recordVerdict(scope, {
        eventId: 'e1',
        verdict: 'false_positive',
        reviewedBy: REVIEWER,
        reviewedAt: 5_000,
        note: 'ordinary club chat',
      }),
    ).toBe('recorded');

    expect(listFixtures(scope)[0]?.label).toBe('should_not_match');
    expect(findVerdict(scope, 'e1')).toEqual({
      verdict: 'false_positive',
      reviewedBy: REVIEWER,
      reviewedAt: 5_000,
      note: 'ordinary club chat',
    });
  });

  it('labels a true positive the other way', () => {
    const fixtureId = captureObservedFixture(scope, {
      messageId: '900000000000000002',
      content: 'a genuinely bad message',
      authorId: MEMBER,
      createdAt: 1_000,
    });
    seedMatchEvent(scope, { eventId: 'e1', fixtureId, trace: '{"kind":"keyword_filter"}' });

    expect(
      recordVerdict(scope, {
        eventId: 'e1',
        verdict: 'true_positive',
        reviewedBy: REVIEWER,
        reviewedAt: 5_000,
      }),
    ).toBe('recorded');

    expect(listFixtures(scope)[0]?.label).toBe('should_match');
  });

  it('leaves the fixture unlabelled for an unclear verdict', () => {
    // A reviewer who could not decide has not told us the right answer;
    // writing a label from a non-decision would poison the regression suite.
    const fixtureId = captureObservedFixture(scope, {
      messageId: '900000000000000003',
      content: 'ambiguous message',
      authorId: MEMBER,
      createdAt: 1_000,
    });
    seedMatchEvent(scope, { eventId: 'e1', fixtureId, trace: '{"kind":"keyword_filter"}' });

    expect(
      recordVerdict(scope, {
        eventId: 'e1',
        verdict: 'unclear',
        reviewedBy: REVIEWER,
        reviewedAt: 5_000,
      }),
    ).toBe('recorded');

    expect(listFixtures(scope)[0]?.label).toBe('unlabelled');
    expect(findVerdict(scope, 'e1')?.verdict).toBe('unclear');
  });

  it('replaces a revised verdict rather than appending a second', () => {
    seedMatchEvent(scope, { eventId: 'e1', trace: '{}' });

    recordVerdict(scope, {
      eventId: 'e1',
      verdict: 'unclear',
      reviewedBy: REVIEWER,
      reviewedAt: 1_000,
    });
    recordVerdict(scope, {
      eventId: 'e1',
      verdict: 'true_positive',
      reviewedBy: REVIEWER,
      reviewedAt: 2_000,
      note: 'reconsidered',
    });

    expect(findVerdict(scope, 'e1')).toEqual({
      verdict: 'true_positive',
      reviewedBy: REVIEWER,
      reviewedAt: 2_000,
      note: 'reconsidered',
    });
  });

  it('records the verdict even when the fixture has been forgotten', () => {
    const fixtureId = captureObservedFixture(scope, {
      messageId: '900000000000000004',
      content: 'a message that will be forgotten',
      authorId: MEMBER,
      createdAt: 1_000,
    });
    seedMatchEvent(scope, { eventId: 'e1', fixtureId, trace: '{}' });
    deleteObservedFixturesForMember(scope, MEMBER);
    expect(listFixtures(scope)).toHaveLength(0);

    expect(
      recordVerdict(scope, {
        eventId: 'e1',
        verdict: 'true_positive',
        reviewedBy: REVIEWER,
        reviewedAt: 5_000,
      }),
    ).toBe('recorded');
    expect(findVerdict(scope, 'e1')?.verdict).toBe('true_positive');
  });

  it('resets the fixture to unlabelled when two rules disagree about the same message, rather than letting either verdict silently win', () => {
    // IMPORTANT-1 (coordinator ruling): one message matching two rules
    // produces two case events but one fixture. A fixture's label has no
    // rule dimension, so when a verdict on one rule's event implies a
    // different label than a verdict already recorded (on a different
    // rule's event) implied, there is no honest single answer — the label
    // must reset to unlabelled rather than let last-write-wins pick a side.
    const fixtureId = captureObservedFixture(scope, {
      messageId: '900000000000000005',
      content: 'a message two different rules both matched',
      authorId: MEMBER,
      createdAt: 1_000,
    });
    seedMatchEvent(scope, {
      eventId: 'e1',
      fixtureId,
      ruleId: 'rule-a',
      trace: '{"kind":"keyword_filter"}',
    });
    seedMatchEvent(scope, {
      eventId: 'e2',
      fixtureId,
      ruleId: 'rule-b',
      trace: '{"kind":"keyword_filter"}',
    });

    // Rule A's event is confirmed a genuine true positive.
    expect(
      recordVerdict(scope, {
        eventId: 'e1',
        verdict: 'true_positive',
        reviewedBy: REVIEWER,
        reviewedAt: 1_000,
      }),
    ).toBe('recorded');
    expect(listFixtures(scope)[0]?.label).toBe('should_match');

    // Rule B's event on the *same fixture* is correctly ruled a false
    // positive for rule B. This is not "recorded" — it conflicts with the
    // should_match label rule A's verdict already set.
    const result = recordVerdict(scope, {
      eventId: 'e2',
      verdict: 'false_positive',
      reviewedBy: REVIEWER,
      reviewedAt: 2_000,
    });
    expect(result).toBe('recorded-with-label-conflict');

    const fixture = listFixtures(scope)[0];
    expect(fixture?.label).toBe('unlabelled');
    expect(fixture?.note).toContain('rule-a');
    expect(fixture?.note).toContain('rule-b');

    // Both verdicts are still recorded faithfully — only the fixture label
    // (the regression-corpus expectation) was withdrawn.
    expect(findVerdict(scope, 'e1')?.verdict).toBe('true_positive');
    expect(findVerdict(scope, 'e2')?.verdict).toBe('false_positive');
  });

  it('does not treat a reviewer revising their own verdict on the same event as a conflict', () => {
    // One rule, one event, one reviewer changing their mind — not a
    // disagreement between two rules, so this must overwrite normally.
    const fixtureId = captureObservedFixture(scope, {
      messageId: '900000000000000006',
      content: 'a message one rule matched, reviewed twice',
      authorId: MEMBER,
      createdAt: 1_000,
    });
    seedMatchEvent(scope, { eventId: 'e1', fixtureId, ruleId: 'rule-a', trace: '{}' });

    recordVerdict(scope, {
      eventId: 'e1',
      verdict: 'true_positive',
      reviewedBy: REVIEWER,
      reviewedAt: 1_000,
    });
    expect(listFixtures(scope)[0]?.label).toBe('should_match');

    const result = recordVerdict(scope, {
      eventId: 'e1',
      verdict: 'false_positive',
      reviewedBy: REVIEWER,
      reviewedAt: 2_000,
      note: 'reconsidered',
    });

    expect(result).toBe('recorded');
    expect(listFixtures(scope)[0]?.label).toBe('should_not_match');
  });

  it('reports no-such-event for an id that is not there', () => {
    expect(
      recordVerdict(scope, {
        eventId: 'nope',
        verdict: 'unclear',
        reviewedBy: REVIEWER,
        reviewedAt: 1,
      }),
    ).toBe('no-such-event');
  });

  it('cannot record a verdict against another guild’s event', () => {
    const scopeA = t.scopes.forGuild(GUILD_A);
    const scopeB = t.scopes.forGuild(GUILD_B);
    upsertGuild(scopeA, { name: 'guild A', now: 0 });
    upsertGuild(scopeB, { name: 'guild B', now: 0 });
    seedMatchEvent(scopeA, { eventId: 'e1', trace: '{}' });

    expect(
      recordVerdict(scopeB, {
        eventId: 'e1',
        verdict: 'true_positive',
        reviewedBy: REVIEWER,
        reviewedAt: 1,
      }),
    ).toBe('no-such-event');
    // Sanity: it really is there, just not reachable through the wrong scope.
    expect(
      recordVerdict(scopeA, {
        eventId: 'e1',
        verdict: 'true_positive',
        reviewedBy: REVIEWER,
        reviewedAt: 1,
      }),
    ).toBe('recorded');
  });

  it('refuses a verdict value the vocabulary does not have', () => {
    // The CHECK constraint is the real enforcement point; this proves it
    // fires rather than being swallowed by the conflict clause.
    seedMatchEvent(scope, { eventId: 'e1', trace: '{}' });
    expect(() =>
      recordVerdict(scope, {
        eventId: 'e1',
        verdict: 'maybe' as MatchVerdict,
        reviewedBy: REVIEWER,
        reviewedAt: 1,
      }),
    ).toThrow();
  });
});

describe('findVerdict', () => {
  it('returns undefined when nobody has reviewed the event', () => {
    seedMatchEvent(scope, { eventId: 'e1', trace: '{}' });
    expect(findVerdict(scope, 'e1')).toBeUndefined();
  });
});
