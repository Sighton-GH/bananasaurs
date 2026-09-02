import { beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { parseGuildId } from '@bananasaurs/core';
import { upsertGuild } from './guilds.js';
import type { GuildScope } from '../scope.js';
import {
  addHandwrittenFixture,
  captureObservedFixture,
  deleteObservedFixturesForMember,
  listFixtures,
  setFixtureLabel,
} from './automod-fixtures.js';

const GUILD = parseGuildId('111111111111111111');
const GUILD_A = parseGuildId('222222222222222222');
const GUILD_B = parseGuildId('333333333333333333');

let t: MigratedTestDatabase;
let scope: GuildScope;
let scopeA: GuildScope;
let scopeB: GuildScope;

// `automod_fixtures.guild_id` carries a real foreign key to `guilds`, like
// every guild-scoped table — so, as in `automod-rules.test.ts`, the guild
// must exist before a fixture can be captured in it.
beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  scopeA = t.scopes.forGuild(GUILD_A);
  scopeB = t.scopes.forGuild(GUILD_B);
  upsertGuild(scope, { name: 'guild', now: 0 });
  upsertGuild(scopeA, { name: 'guild A', now: 0 });
  upsertGuild(scopeB, { name: 'guild B', now: 0 });
});

describe('captureObservedFixture', () => {
  it('is idempotent for a replayed identical message', () => {
    const first = captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'hello badword',
      authorId: '800000000000000001',
      createdAt: 1_000,
    });
    const second = captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'hello badword',
      authorId: '800000000000000001',
      createdAt: 2_000,
    });

    expect(second).toBe(first);
    const rows = listFixtures(scope);
    expect(rows).toHaveLength(1);
    // The first capture wins: the row records when the message was first
    // seen, not when a gateway replay re-delivered it.
    expect(rows[0]?.createdAt).toBe(1_000);
  });

  it('captures an edit of the same message as separate evidence', () => {
    const before = captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'hello badword',
      authorId: '800000000000000001',
      createdAt: 1_000,
    });
    const after = captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'hello worseword',
      authorId: '800000000000000001',
      createdAt: 2_000,
    });

    expect(after).not.toBe(before);
    expect(listFixtures(scope).map((f) => f.content)).toEqual(['hello badword', 'hello worseword']);
  });

  it('does not leak fixtures between guilds', () => {
    captureObservedFixture(scopeA, {
      messageId: '900000000000000001',
      content: 'guild A only',
      authorId: '800000000000000001',
      createdAt: 1_000,
    });
    expect(listFixtures(scopeB)).toEqual([]);
  });
});

describe('deleteObservedFixturesForMember', () => {
  it('removes that member’s observed rows, and leaves handwritten ones and other members alone', () => {
    captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'mine',
      authorId: '800000000000000001',
      createdAt: 1_000,
    });
    captureObservedFixture(scope, {
      messageId: '900000000000000002',
      content: 'someone else’s',
      authorId: '800000000000000002',
      createdAt: 2_000,
    });
    addHandwrittenFixture(scope, {
      fixtureId: 'adversarial-1',
      content: 'b@dw0rd',
      label: 'should_match',
      note: 'leetspeak evasion',
      createdAt: 3_000,
    });

    const deleted = deleteObservedFixturesForMember(scope, '800000000000000001');

    expect(deleted).toBe(1);
    expect(listFixtures(scope).map((f) => f.content)).toEqual(['someone else’s', 'b@dw0rd']);
  });

  it('does not reach another guild’s rows', () => {
    captureObservedFixture(scopeA, {
      messageId: '900000000000000001',
      content: 'guild A',
      authorId: '800000000000000001',
      createdAt: 1_000,
    });
    captureObservedFixture(scopeB, {
      messageId: '900000000000000002',
      content: 'guild B',
      authorId: '800000000000000001',
      createdAt: 1_000,
    });

    expect(deleteObservedFixturesForMember(scopeA, '800000000000000001')).toBe(1);
    expect(listFixtures(scopeB)).toHaveLength(1);
  });
});

describe('setFixtureLabel', () => {
  it('labels a fixture and reports that it did', () => {
    addHandwrittenFixture(scope, {
      fixtureId: 'f1',
      content: 'ordinary sentence',
      label: 'unlabelled',
      createdAt: 1_000,
    });
    expect(setFixtureLabel(scope, 'f1', 'should_not_match', 'reviewed: false positive')).toBe(true);
    expect(listFixtures(scope)[0]?.label).toBe('should_not_match');
  });

  it('reports false for a fixture that is not there', () => {
    expect(setFixtureLabel(scope, 'no-such-fixture', 'should_match')).toBe(false);
  });

  it('cannot label another guild’s fixture', () => {
    addHandwrittenFixture(scopeA, {
      fixtureId: 'f1',
      content: 'guild A',
      label: 'unlabelled',
      createdAt: 1_000,
    });
    expect(setFixtureLabel(scopeB, 'f1', 'should_match')).toBe(false);
    expect(listFixtures(scopeA)[0]?.label).toBe('unlabelled');
  });
});

describe('listFixtures', () => {
  it('returns rows oldest first, so a replay is deterministic', () => {
    addHandwrittenFixture(scope, {
      fixtureId: 'b',
      content: 'second',
      label: 'unlabelled',
      createdAt: 2_000,
    });
    addHandwrittenFixture(scope, {
      fixtureId: 'a',
      content: 'first',
      label: 'unlabelled',
      createdAt: 1_000,
    });
    expect(listFixtures(scope).map((f) => f.content)).toEqual(['first', 'second']);
  });

  it('orders ties by fixture id rather than leaving them to the planner', () => {
    addHandwrittenFixture(scope, {
      fixtureId: 'b',
      content: 'bee',
      label: 'unlabelled',
      createdAt: 1_000,
    });
    addHandwrittenFixture(scope, {
      fixtureId: 'a',
      content: 'ay',
      label: 'unlabelled',
      createdAt: 1_000,
    });
    expect(listFixtures(scope).map((f) => f.content)).toEqual(['ay', 'bee']);
  });

  it('filters by source', () => {
    captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'observed one',
      authorId: '800000000000000001',
      createdAt: 1_000,
    });
    addHandwrittenFixture(scope, {
      fixtureId: 'h1',
      content: 'handwritten one',
      label: 'should_match',
      createdAt: 2_000,
    });
    expect(listFixtures(scope, { source: 'handwritten' }).map((f) => f.content)).toEqual([
      'handwritten one',
    ]);
  });
});
