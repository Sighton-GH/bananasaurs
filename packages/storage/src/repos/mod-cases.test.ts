import { beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { parseGuildId, parseSnowflakeId } from '@bananasaurs/core';
import { upsertGuild } from './guilds.js';
import {
  listCaseEvents,
  nextEscalationTier,
  openOrResolveCase,
  recordCaseEvent,
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
