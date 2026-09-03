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
      attachments: [],
    });
    const second = captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'hello badword',
      authorId: '800000000000000001',
      createdAt: 2_000,
      attachments: [],
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
      attachments: [],
    });
    const after = captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'hello worseword',
      authorId: '800000000000000001',
      createdAt: 2_000,
      attachments: [],
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
      attachments: [],
    });
    expect(listFixtures(scopeB)).toEqual([]);
  });
});

/**
 * The invariant `/forgetme` actually rests on.
 *
 * `deleteObservedFixturesForMember` filters on both `author_id` and
 * `source = 'observed'`, and the second predicate is *provably unreachable*:
 * the `automod_fixtures_observed_has_author` CHECK makes a non-null
 * `author_id` imply `source = 'observed'`, so a handwritten row can never be
 * selected by the author predicate in the first place. Removing the `source`
 * filter therefore does not change the deletion's behaviour, and a test that
 * seeds a handwritten row and watches it survive cannot fail — it is
 * decorative, correct about an input where the bug cannot occur.
 *
 * The falsifiable guard is this one: the CHECK is what keeps handwritten
 * fixtures out of a member's deletion, so the CHECK is what gets tested.
 * Written with raw SQL deliberately — `addHandwrittenFixture` always passes
 * `author_id = null`, so going through the repository could only ever
 * demonstrate that the repository is consistent with itself.
 */
describe('the automod_fixtures CHECK that makes /forgetme safe', () => {
  it('refuses a handwritten fixture that carries an author id', () => {
    expect(() =>
      t.raw
        .prepare(
          `INSERT INTO automod_fixtures
             (guild_id, fixture_id, content, author_id, label, source, note, created_at)
           VALUES (?, 'smuggled', 'x', ?, 'unlabelled', 'handwritten', NULL, 0)`,
        )
        .run(GUILD, '800000000000000001'),
    ).toThrow();
  });

  it('refuses an observed fixture with no author id', () => {
    // The other half of the same CHECK. Without it, a captured message could
    // exist that `/forgetme` has no way to find — the corpus would hold
    // member content nobody could ask to have removed.
    expect(() =>
      t.raw
        .prepare(
          `INSERT INTO automod_fixtures
             (guild_id, fixture_id, content, author_id, label, source, note, created_at)
           VALUES (?, 'orphan', 'x', NULL, 'unlabelled', 'observed', NULL, 0)`,
        )
        .run(GUILD),
    ).toThrow();
  });
});

describe('deleteObservedFixturesForMember', () => {
  it('removes that member’s observed rows, and leaves handwritten ones and other members alone', () => {
    captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'mine',
      authorId: '800000000000000001',
      createdAt: 1_000,
      attachments: [],
    });
    captureObservedFixture(scope, {
      messageId: '900000000000000002',
      content: 'someone else’s',
      authorId: '800000000000000002',
      createdAt: 2_000,
      attachments: [],
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
      attachments: [],
    });
    captureObservedFixture(scopeB, {
      messageId: '900000000000000002',
      content: 'guild B',
      authorId: '800000000000000001',
      createdAt: 1_000,
      attachments: [],
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

describe('attachments (OD-3)', () => {
  it('round-trips an observed fixture with several attachments', () => {
    captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'here you go',
      authorId: '800000000000000001',
      createdAt: 1_000,
      attachments: [
        { fileName: 'payload.exe', contentType: 'application/x-msdownload', sizeBytes: 4096 },
        { fileName: 'notes.txt', contentType: undefined, sizeBytes: 12 },
      ],
    });

    const [fixture] = listFixtures(scope);
    // Two attachments, in a deterministic order, with `undefined` preserved
    // rather than flattened to '' — MessageAttachment.contentType is
    // `string | undefined` and "Discord declared none" is a real, different
    // fact from "Discord declared the empty string".
    expect(fixture?.attachments).toEqual([
      { fileName: 'payload.exe', contentType: 'application/x-msdownload', sizeBytes: 4096 },
      { fileName: 'notes.txt', contentType: undefined, sizeBytes: 12 },
    ]);
  });

  it('keeps each fixture’s attachments to itself', () => {
    // NOT decorative: two fixtures, each WITH attachments, so an
    // implementation that joined without the fixture_id predicate would hand
    // both lists to both rows and this goes red. One fixture with attachments
    // and one without would pass under that bug.
    captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'first',
      authorId: '800000000000000001',
      createdAt: 1_000,
      attachments: [{ fileName: 'a.png', contentType: 'image/png', sizeBytes: 1 }],
    });
    captureObservedFixture(scope, {
      messageId: '900000000000000002',
      content: 'second',
      authorId: '800000000000000002',
      createdAt: 2_000,
      attachments: [{ fileName: 'b.pdf', contentType: 'application/pdf', sizeBytes: 2 }],
    });

    const fixtures = listFixtures(scope);
    expect(fixtures.map((f) => f.attachments.map((a) => a.fileName))).toEqual([
      ['a.png'],
      ['b.pdf'],
    ]);
  });

  it('deleteObservedFixturesForMember removes the member’s attachments too', () => {
    // OD-3 obligation 3, and the ledger says verify rather than assume: the
    // whole point of shipping deleteObservedFixturesForMember two releases
    // early was that the corpus stays un-makeable.
    captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'mine',
      authorId: '800000000000000001',
      createdAt: 1_000,
      attachments: [
        { fileName: 'Bryan_resume_2026.pdf', contentType: 'application/pdf', sizeBytes: 9 },
      ],
    });

    expect(deleteObservedFixturesForMember(scope, '800000000000000001')).toBe(1);

    // Asserted against the raw table, not through listFixtures: the parent
    // row is gone either way, so reading through the repository could not
    // tell an orphaned child row from a deleted one. This is the assertion
    // that fails if the cascade is missing.
    const orphans = t.raw
      .prepare('SELECT COUNT(*) AS n FROM automod_fixture_attachments')
      .get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it('another member’s attachments survive a deletion', () => {
    // The ambiguity the previous test lacks: proves the cascade is scoped to
    // the deleted rows rather than emptying the table.
    captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'mine',
      authorId: '800000000000000001',
      createdAt: 1_000,
      attachments: [{ fileName: 'mine.pdf', contentType: undefined, sizeBytes: 1 }],
    });
    captureObservedFixture(scope, {
      messageId: '900000000000000002',
      content: 'theirs',
      authorId: '800000000000000002',
      createdAt: 2_000,
      attachments: [{ fileName: 'theirs.pdf', contentType: undefined, sizeBytes: 2 }],
    });

    deleteObservedFixturesForMember(scope, '800000000000000001');

    const rows = t.raw.prepare('SELECT file_name FROM automod_fixture_attachments').all() as {
      file_name: string;
    }[];
    expect(rows.map((r) => r.file_name)).toEqual(['theirs.pdf']);
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
      attachments: [],
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
