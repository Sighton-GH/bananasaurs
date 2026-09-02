import { describe, expect, it } from 'vitest';
import { createDispatcher, type RegisteredCommand } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsPorts, OpsReviewableMatch } from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';
import type { AutomodRule, FixtureRecord } from '../../automod/predicates/types.js';
import { automodDryRunCommand, automodReviewCommand, automodVerdictCommand } from './automod.js';

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

/**
 * Like `drive`, but for a write command: carries `--confirm` and the
 * claimed Unix user through to the dispatcher, the way `writes.test.ts`'s
 * harness does — so a test also exercises the machinery's own guarantees
 * (`--confirm` required, an audit record filled by the dispatcher) rather
 * than calling `run` directly and bypassing them.
 */
const driveWrite = (
  command: RegisteredCommand,
  ports: Partial<OpsPorts>,
  args: Record<string, unknown> = {},
  options: { readonly confirm?: boolean; readonly unixUserClaimed?: string } = {},
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
  }).dispatch({
    v: 1,
    command: command.name,
    args,
    confirm: options.confirm ?? true,
    unixUserClaimed: options.unixUserClaimed ?? 'bryan',
  });

/** A reviewable match, with a trace and a fixture message present by default. */
const reviewableMatch = (
  over: Partial<OpsReviewableMatch> & { eventId: string },
): OpsReviewableMatch => ({
  ruleId: 'r1',
  memberId: '800000000000000001',
  at: NOW,
  matchedCategory: 'profanity',
  matchedSnippet: 'badword',
  actionTaken: 'would_delete',
  trace:
    '{"kind":"keyword_filter","matchedOn":"badword","span":[6,13],' +
    '"normalisations":["lowercased"],"detail":{}}',
  fixtureContent: 'hello badword everyone',
  ...over,
});

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
    // "no *enabled* rule": the port is enabled-only, so a disabled rule lands
    // here too, and an operator told "there is no rule" would go hunting for a
    // typo in an id that is correct.
    expect(res.text).toContain('no enabled rule');
    expect(res.text).toContain('disabled rule is not replayed');
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

describe('automod review', () => {
  it('is registered as a read, so it needs no --confirm and writes no audit row', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('automod review');
    expect(automodReviewCommand.write).toBe(false);
  });

  it('lists unreviewed matches with the message and the rendered trace', async () => {
    const res = await drive(automodReviewCommand, {
      listUnreviewedMatches: () => [reviewableMatch({ eventId: 'e1' })],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('e1');
    expect(res.text).toContain('hello [badword] everyone');
    expect(res.text).toContain('bananasaurs automod verdict e1');
  });

  it('renders a match whose trace is malformed without hiding the match', async () => {
    // A trace read back from the database is untrusted (CLAUDE.md rule 3).
    // A row this build cannot parse is still a match a human must rule on,
    // so the trace is replaced by a reason, not the row by nothing.
    const res = await drive(automodReviewCommand, {
      listUnreviewedMatches: () => [reviewableMatch({ eventId: 'e1', trace: 'not json' })],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('e1');
    expect(res.text).toContain('trace could not be read');
  });

  it('renders a match whose fixture has been forgotten', async () => {
    // /forgetme removed the message. The match is still reviewable from the
    // trace and the snippet — worse evidence, honestly labelled.
    const res = await drive(automodReviewCommand, {
      listUnreviewedMatches: () => [reviewableMatch({ eventId: 'e1', fixtureContent: undefined })],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('message no longer stored');
  });

  it('says so when there is nothing to review', async () => {
    const res = await drive(automodReviewCommand, { listUnreviewedMatches: () => [] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('nothing to review');
  });

  it('threads --rule and --limit through to the query, so the dry-run forward reference resolves', async () => {
    let seen: { ruleId?: string; limit: number } | undefined;
    const res = await drive(
      automodReviewCommand,
      {
        listUnreviewedMatches: (query) => {
          seen = query;
          return [];
        },
      },
      { rule: 'r5', limit: 7 },
    );
    expect(res.ok).toBe(true);
    expect(seen).toEqual({ ruleId: 'r5', limit: 7 });
  });

  it('defaults the limit to 20 when --limit is not given', async () => {
    let seen: { ruleId?: string; limit: number } | undefined;
    await drive(automodReviewCommand, {
      listUnreviewedMatches: (query) => {
        seen = query;
        return [];
      },
    });
    expect(seen).toEqual({ limit: 20 });
  });
});

describe('automod verdict', () => {
  it('is registered as a write', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('automod verdict');
    expect(automodVerdictCommand.write).toBe(true);
  });

  it('refuses without --confirm', async () => {
    const res = await driveWrite(
      automodVerdictCommand,
      { recordMatchVerdict: () => 'recorded' },
      { eventId: 'e1', verdict: 'false_positive' },
      { confirm: false },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('needs-confirm');
  });

  it('records a verdict and returns an audit record naming the event', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodVerdictCommand,
      {
        recordMatchVerdict: () => 'recorded',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { eventId: 'e1', verdict: 'false_positive', note: 'ordinary club chat' },
    );
    expect(res.ok).toBe(true);
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.verdict_recorded',
        subjectType: 'mod_case_event',
        subjectId: 'e1',
        after: { verdict: 'false_positive' },
      }),
    ]);
  });

  it('attributes the verdict to the Unix user the invocation claimed', async () => {
    // Provenance, not authorisation (plan ruling PR-9, ADR 0024): the
    // socket's group permissions are the control, and the dispatcher's audit
    // row is the authoritative record of who ran this.
    let seen: string | undefined;
    await driveWrite(
      automodVerdictCommand,
      {
        recordMatchVerdict: (input) => {
          seen = input.reviewedBy;
          return 'recorded';
        },
        recordAudit: () => {},
      },
      { eventId: 'e1', verdict: 'true_positive' },
      { unixUserClaimed: 'bryan' },
    );
    expect(seen).toBe('cli:bryan');
  });

  it('refuses an event id that is not there, but still writes an audit row', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodVerdictCommand,
      {
        recordMatchVerdict: () => 'no-such-event',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { eventId: 'nope', verdict: 'unclear' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('no match');
    // An audit row is owed even for a refusal: "an operator tried to rule
    // on a match that does not exist" is a fact worth having.
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.verdict_recorded',
        subjectType: 'mod_case_event',
        subjectId: 'nope',
        after: { outcome: 'no-such-event' },
      }),
    ]);
  });

  it('refuses a verdict outside the vocabulary at the validator', async () => {
    // Untrusted input meets Zod here, same as a form submission.
    const res = await driveWrite(
      automodVerdictCommand,
      { recordMatchVerdict: () => 'recorded' },
      { eventId: 'e1', verdict: 'maybe' },
    );
    expect(res.ok).toBe(false);
  });
});
