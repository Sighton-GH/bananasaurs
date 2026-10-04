import { beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { parseGuildId } from '@bananasaurs/core';
import { upsertGuild } from './guilds.js';
import type { GuildScope } from '../scope.js';
import { openOrResolveCase, recordCaseEvent } from './mod-cases.js';
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
 * automod subscriber really writes for a match on Watch: a case event
 * carrying a trace.
 */
const seedMatchEvent = (
  s: GuildScope,
  input: {
    readonly eventId: string;
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
  it('records a flag with who set it, when, and why', () => {
    seedMatchEvent(scope, { eventId: 'e1', trace: '{"kind":"keyword_filter"}' });

    expect(
      recordVerdict(scope, {
        eventId: 'e1',
        verdict: 'false_positive',
        reviewedBy: REVIEWER,
        reviewedAt: 5_000,
        note: 'ordinary club chat',
      }),
    ).toBe('recorded');

    expect(findVerdict(scope, 'e1')).toEqual({
      verdict: 'false_positive',
      reviewedBy: REVIEWER,
      reviewedAt: 5_000,
      note: 'ordinary club chat',
    });
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
