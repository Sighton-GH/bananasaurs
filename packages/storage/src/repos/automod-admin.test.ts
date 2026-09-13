import { beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { parseGuildId, parseSnowflakeId } from '@bananasaurs/core';
import { upsertGuild } from './guilds.js';
import { addChannelExemption, addRoleExemption, createRule, setRuleMode } from './automod-rules.js';
import { openOrResolveCase, recordCaseEvent } from './mod-cases.js';
import { recordVerdict } from './mod-match-reviews.js';
import {
  countMatchesByRule,
  countReviewedByRule,
  findCase,
  findRule,
  listExemptions,
  listRecentCases,
  listRules,
  removeExemption,
} from './automod-admin.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const ROLE = parseSnowflakeId('333333333333333333');
const CHANNEL_LO = parseSnowflakeId('444444444444444444');
const CHANNEL_HI = parseSnowflakeId('445555555555555555');
const MEMBER_1 = parseSnowflakeId('555555555555555555');
const MEMBER_2 = parseSnowflakeId('666666666666666666');
const MEMBER_3 = parseSnowflakeId('777777777777777777');

let t: MigratedTestDatabase;

// `mod_rules.guild_id` carries a real foreign key to `guilds`, like every
// guild-scoped table — so, as in `automod-rules.test.ts`, each guild must
// exist before anything can be seeded in it.
beforeEach(() => {
  t = openMigratedTestDatabase();
  upsertGuild(t.scopes.forGuild(GUILD_A), { name: 'guild-a', now: 0 });
  upsertGuild(t.scopes.forGuild(GUILD_B), { name: 'guild-b', now: 0 });
});

describe('automod admin repo', () => {
  it('listRules returns enabled and disabled rules ordered by ruleId, and nothing from the other guild', () => {
    const scopeA = t.scopes.forGuild(GUILD_A);
    createRule(scopeA, {
      ruleId: 'b-rule',
      kind: 'caps',
      name: 'shouting',
      config: '{}',
      now: 1000,
    });
    createRule(scopeA, {
      ruleId: 'a-rule',
      kind: 'keyword_filter',
      name: 'filter',
      config: '{}',
      now: 1000,
    });
    setRuleMode(scopeA, { ruleId: 'b-rule', enabled: false, now: 2000 });

    // A rule in the other guild must not leak across, in either direction.
    createRule(t.scopes.forGuild(GUILD_B), {
      ruleId: 'other-rule',
      kind: 'caps',
      name: 'elsewhere',
      config: '{}',
      now: 1000,
    });

    const rules = listRules(scopeA);
    expect(rules.map((r) => r.ruleId)).toEqual(['a-rule', 'b-rule']);
    expect(rules[0]).toMatchObject({
      ruleId: 'a-rule',
      kind: 'keyword_filter',
      name: 'filter',
      mode: 'test',
      enabled: true,
      config: '{}',
      cutoverState: 'not_started',
      observeStartedAt: null,
      legacyRuleRef: null,
      countsAsViolation: true,
      maxFalsePositiveRate: 0.05,
      minReviewedMatches: 20,
      enforceSignedOffBy: null,
      enforceSignedOffAt: null,
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(typeof rules[0]!.enabled).toBe('boolean');
    expect(rules[1]).toMatchObject({ ruleId: 'b-rule', enabled: false });
    expect(typeof rules[1]!.enabled).toBe('boolean');

    expect(listRules(t.scopes.forGuild(GUILD_B)).map((r) => r.ruleId)).toEqual(['other-rule']);
  });

  it('findRule returns the row for its guild and undefined under the other guild', () => {
    createRule(t.scopes.forGuild(GUILD_A), {
      ruleId: 'shared',
      kind: 'caps',
      name: 'in-a',
      config: '{}',
      now: 1000,
    });

    expect(findRule(t.scopes.forGuild(GUILD_A), 'shared')).toMatchObject({
      ruleId: 'shared',
      name: 'in-a',
    });
    expect(findRule(t.scopes.forGuild(GUILD_B), 'shared')).toBeUndefined();
    expect(findRule(t.scopes.forGuild(GUILD_A), 'missing')).toBeUndefined();
  });

  it('listExemptions orders by type then id; removeExemption deletes once; the other guild is untouched', () => {
    const scopeA = t.scopes.forGuild(GUILD_A);
    const scopeB = t.scopes.forGuild(GUILD_B);
    for (const scope of [scopeA, scopeB]) {
      createRule(scope, { ruleId: 'r1', kind: 'caps', name: 'x', config: '{}', now: 1000 });
      addRoleExemption(scope, { ruleId: 'r1', roleId: ROLE });
    }
    addChannelExemption(scopeA, { ruleId: 'r1', channelId: CHANNEL_HI });
    addChannelExemption(scopeA, { ruleId: 'r1', channelId: CHANNEL_LO });

    // 'channel' sorts before 'role', and ids sort within a type.
    expect(listExemptions(scopeA, 'r1')).toEqual([
      { exemptType: 'channel', exemptId: CHANNEL_LO },
      { exemptType: 'channel', exemptId: CHANNEL_HI },
      { exemptType: 'role', exemptId: ROLE },
    ]);

    expect(removeExemption(scopeA, { ruleId: 'r1', exemptType: 'role', exemptId: ROLE })).toBe(
      true,
    );
    expect(removeExemption(scopeA, { ruleId: 'r1', exemptType: 'role', exemptId: ROLE })).toBe(
      false,
    );
    expect(listExemptions(scopeA, 'r1')).toEqual([
      { exemptType: 'channel', exemptId: CHANNEL_LO },
      { exemptType: 'channel', exemptId: CHANNEL_HI },
    ]);

    // The identical exemption in the other guild survives the removal here.
    expect(listExemptions(scopeB, 'r1')).toEqual([{ exemptType: 'role', exemptId: ROLE }]);
  });

  it('countMatchesByRule counts events per ruleId for this guild only', () => {
    const scopeA = t.scopes.forGuild(GUILD_A);
    const scopeB = t.scopes.forGuild(GUILD_B);
    const { caseId: caseA } = openOrResolveCase(scopeA, { memberId: MEMBER_1, now: 1000 });
    const seed = (eventId: string, ruleId: string): void => {
      recordCaseEvent(scopeA, {
        eventId,
        caseId: caseA,
        ruleId,
        memberId: MEMBER_1,
        at: 1000,
        matchedCategory: 'c',
        matchedSnippet: 's',
        actionTaken: 'would_delete',
      });
    };
    seed('e1', 'rule-a');
    seed('e2', 'rule-a');
    seed('e3', 'rule-b');

    const { caseId: caseB } = openOrResolveCase(scopeB, { memberId: MEMBER_1, now: 1000 });
    recordCaseEvent(scopeB, {
      eventId: 'e4',
      caseId: caseB,
      ruleId: 'rule-a',
      memberId: MEMBER_1,
      at: 1000,
      matchedCategory: 'c',
      matchedSnippet: 's',
      actionTaken: 'would_delete',
    });

    expect(countMatchesByRule(scopeA)).toEqual({ 'rule-a': 2, 'rule-b': 1 });
    expect(countMatchesByRule(scopeB)).toEqual({ 'rule-a': 1 });
  });

  it('countReviewedByRule counts only events that have a verdict, attributed to the event rule', () => {
    const scopeA = t.scopes.forGuild(GUILD_A);
    const { caseId } = openOrResolveCase(scopeA, { memberId: MEMBER_1, now: 1000 });
    for (const [eventId, ruleId] of [
      ['e1', 'rule-a'],
      ['e2', 'rule-a'],
      ['e3', 'rule-b'],
    ] as const) {
      recordCaseEvent(scopeA, {
        eventId,
        caseId,
        ruleId,
        memberId: MEMBER_1,
        at: 1000,
        matchedCategory: 'c',
        matchedSnippet: 's',
        actionTaken: 'would_delete',
      });
    }
    recordVerdict(scopeA, {
      eventId: 'e1',
      verdict: 'true_positive',
      reviewedBy: 'cli:bryan',
      reviewedAt: 2000,
    });
    recordVerdict(scopeA, {
      eventId: 'e2',
      verdict: 'false_positive',
      reviewedBy: 'cli:bryan',
      reviewedAt: 2000,
    });

    // rule-b has an event but no verdict, so it has no key at all.
    // The other guild reuses eventId e1: the join is on (guildId, eventId),
    // so its verdict must attribute to its own rule, not leak into this guild.
    const scopeB = t.scopes.forGuild(GUILD_B);
    const { caseId: caseB } = openOrResolveCase(scopeB, { memberId: MEMBER_1, now: 1000 });
    recordCaseEvent(scopeB, {
      eventId: 'e1',
      caseId: caseB,
      ruleId: 'rule-b-other',
      memberId: MEMBER_1,
      at: 1000,
      matchedCategory: 'c',
      matchedSnippet: 's',
      actionTaken: 'would_delete',
    });
    recordVerdict(scopeB, {
      eventId: 'e1',
      verdict: 'true_positive',
      reviewedBy: 'cli:bryan',
      reviewedAt: 2000,
    });

    expect(countReviewedByRule(scopeA)).toEqual({ 'rule-a': 2 });
    expect(countReviewedByRule(scopeB)).toEqual({ 'rule-b-other': 1 });
  });

  it('listRecentCases orders newest openedAt first and honours limit; findCase is guild-scoped', () => {
    const scopeA = t.scopes.forGuild(GUILD_A);
    const scopeB = t.scopes.forGuild(GUILD_B);
    const first = openOrResolveCase(scopeA, { memberId: MEMBER_1, now: 1000 });
    const second = openOrResolveCase(scopeA, { memberId: MEMBER_2, now: 2000 });
    const third = openOrResolveCase(scopeA, { memberId: MEMBER_3, now: 3000 });
    openOrResolveCase(scopeB, { memberId: MEMBER_1, now: 5000 });

    expect(listRecentCases(scopeA, { limit: 2 }).map((c) => c.caseId)).toEqual([
      third.caseId,
      second.caseId,
    ]);
    expect(listRecentCases(scopeA, { limit: 10 }).map((c) => c.caseId)).toEqual([
      third.caseId,
      second.caseId,
      first.caseId,
    ]);
    expect(listRecentCases(scopeB, { limit: 10 })).toHaveLength(1);

    expect(findCase(scopeA, first.caseId)).toMatchObject({
      caseId: first.caseId,
      memberId: MEMBER_1,
      openedAt: 1000,
      violationCount: 1,
      escalationTier: 0,
      status: 'open',
    });
    expect(findCase(scopeB, first.caseId)).toBeUndefined();
  });
});
