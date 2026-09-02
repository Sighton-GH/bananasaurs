import { describe, expect, it } from 'vitest';
import { createDispatcher, type RegisteredCommand } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsPorts } from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';
import type { AutomodRule, FixtureRecord } from '../../automod/predicates/types.js';
import { automodDryRunCommand } from './automod.js';

const NOW = 1_700_000_000_000;

const drive = (
  command: RegisteredCommand,
  ports: Partial<OpsPorts>,
  args: Record<string, unknown> = {},
) =>
  createDispatcher({
    commands: [command],
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => ({
      guildId: FIXTURE_GUILD_ID,
      now: () => NOW,
      ports: fakeOpsPorts(ports),
    }),
    instance: fakeOpsInstance(),
  }).dispatch({ v: 1, command: command.name, args });

/** A `keyword_filter` rule with one term per word, all in one category. */
const ruleWith = (words: readonly string[], over: Partial<AutomodRule> = {}): AutomodRule => ({
  ruleId: 'r1',
  kind: 'keyword_filter',
  mode: 'observe',
  config: '{}',
  terms: words.map((text) => ({ text, categoryId: 'c1' })),
  allowlist: [],
  ...over,
});

const fixture = (
  over: Partial<FixtureRecord> & { fixtureId: string; content: string },
): FixtureRecord => ({
  authorId: 'member-1',
  label: 'unlabelled',
  source: 'observed',
  createdAt: NOW,
  ...over,
});

describe('automod dryrun', () => {
  it('is registered, so the CLI can reach it', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('automod dryrun');
  });

  it('is a read, so it needs no --confirm and writes no audit row', () => {
    expect(automodDryRunCommand.write).toBe(false);
  });

  it('refuses a rule id that is not there, without pretending it matched nothing', async () => {
    const res = await drive(
      automodDryRunCommand,
      { findAutomodRule: () => undefined },
      { ruleId: 'no-such-rule' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('no rule');
    expect(res.data).toMatchObject({ ok: false });
  });

  it('reports matches, misses, and the label disagreements', async () => {
    const res = await drive(
      automodDryRunCommand,
      {
        findAutomodRule: () => ruleWith(['badword']),
        listAutomodFixtures: () => [
          fixture({ fixtureId: 'f1', content: 'hello badword', label: 'should_match' }),
          fixture({ fixtureId: 'f2', content: 'ordinary chat', label: 'should_not_match' }),
          fixture({ fixtureId: 'f3', content: 'badword again', label: 'should_not_match' }),
        ],
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ total: 3, matched: 2, falsePositives: 1, falseNegatives: 0 });
  });

  it('says the rule is unusable rather than reporting a clean zero', async () => {
    // ADR 0040 §4: a rule that cannot compile matches nothing, and "0
    // matches" reads exactly like a rule behaving perfectly.
    const res = await drive(
      automodDryRunCommand,
      {
        findAutomodRule: () => ruleWith([]),
        listAutomodFixtures: () => [fixture({ fixtureId: 'f1', content: 'anything' })],
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('cannot be compiled');
    expect(res.data).toMatchObject({ usable: false });
    // The rendering rule that matters most: no summary line, no count, once
    // the rule is unusable — a count here is noise at best and misleading
    // at worst.
    expect(res.text).not.toMatch(/matched/i);
  });

  it("renders each match's trace against the fixture's own message", async () => {
    const res = await drive(
      automodDryRunCommand,
      {
        findAutomodRule: () => ruleWith(['badword']),
        listAutomodFixtures: () => [
          fixture({ fixtureId: 'f1', content: 'hello badword there', label: 'should_match' }),
        ],
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('[badword]');
    expect(res.text).toContain('matched on');
  });

  it('prints the follow-up command under each match', async () => {
    const res = await drive(
      automodDryRunCommand,
      {
        findAutomodRule: () => ruleWith(['badword']),
        listAutomodFixtures: () => [
          fixture({ fixtureId: 'f1', content: 'hello badword there', label: 'should_match' }),
        ],
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('bananasaurs automod review --rule r1');
  });

  it('flags a should_match fixture the rule missed, without listing ordinary non-matches', async () => {
    const res = await drive(
      automodDryRunCommand,
      {
        findAutomodRule: () => ruleWith(['badword']),
        listAutomodFixtures: () => [
          fixture({ fixtureId: 'f1', content: 'no trigger here', label: 'should_match' }),
          fixture({ fixtureId: 'f2', content: 'also clean', label: 'unlabelled' }),
        ],
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('f1');
    expect(res.text).toContain('MISSED');
    expect(res.text).not.toContain('f2');
  });

  it('says so plainly when the corpus is empty', async () => {
    // The first day of the observe window has no fixtures, and a report of
    // "0 matches, 0 false positives" would read as a passing rule.
    const res = await drive(
      automodDryRunCommand,
      { findAutomodRule: () => ruleWith(['badword']), listAutomodFixtures: () => [] },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('corpus is empty');
  });
});
