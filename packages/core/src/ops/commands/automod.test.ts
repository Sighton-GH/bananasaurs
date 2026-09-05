import { describe, expect, it, vi } from 'vitest';
import { createDispatcher, type RegisteredCommand } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsPorts, OpsReviewableMatch } from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';
// Namespace import so `compileRule` can be spied on the same module object
// `evaluate.ts` calls through — the same pattern `dry-run.test.ts` uses to
// force a predicate throw without an actual multi-second ReDoS timeout.
import * as automodRegistry from '../../automod/predicates/registry.js';
import type { AutomodRule, FixtureRecord } from '../../automod/predicates/types.js';
import {
  automodDomainAddCommand,
  automodDomainRmCommand,
  automodDryRunCommand,
  automodInviteAllowCommand,
  automodInviteDenyCommand,
  automodReadyCommand,
  automodReviewCommand,
  automodSignoffCommand,
  automodVerdictCommand,
} from './automod.js';

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
  inviteAllowlist: [],
  linkDomains: [],
  countsAsViolation: true,
  ...over,
});

const fixture = (
  over: Partial<FixtureRecord> & { fixtureId: string; content: string },
): FixtureRecord => ({
  authorId: 'member-1',
  label: 'unlabelled',
  source: 'observed',
  createdAt: NOW,
  attachments: [],
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

  it('refuses to print a false-positive rate when nothing in the corpus is labelled', async () => {
    // CRITICAL-1: "41/300 matched · 0 false positive(s) · 0 missed" reads
    // exactly like a rule 296 humans confirmed correct, when in fact nobody
    // has labelled anything — the same failure shape the unusable-rule and
    // empty-corpus guards above already close, and the only one of the three
    // that happens on an ordinary day.
    const res = await drive(
      automodDryRunCommand,
      {
        findAutomodRule: () => ruleWith(['badword']),
        listAutomodFixtures: () => [
          fixture({ fixtureId: 'f1', content: 'hello badword', label: 'unlabelled' }),
          fixture({ fixtureId: 'f2', content: 'ordinary chat', label: 'unlabelled' }),
        ],
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('2 of 2 fixtures unlabelled');
    expect(res.text).toContain('ADR 0041');
    // Hyphenated "false-positive" (the refusal sentence) is fine; the
    // numeric "false positive(s)" count must not appear when the rate was
    // refused, or a reader skimming for a count finds the misleading one.
    expect(res.text).not.toMatch(/\d+ false positive\(s\)/);
    expect(res.data).toMatchObject({ unlabelled: 2 });
  });

  it('prints the false-positive rate with its labelled denominator once some fixtures are labelled', async () => {
    const res = await drive(
      automodDryRunCommand,
      {
        findAutomodRule: () => ruleWith(['badword']),
        listAutomodFixtures: () => [
          fixture({ fixtureId: 'f1', content: 'hello badword', label: 'should_match' }),
          fixture({ fixtureId: 'f2', content: 'badword again', label: 'should_not_match' }),
          fixture({ fixtureId: 'f3', content: 'nothing here', label: 'unlabelled' }),
        ],
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('1 false positive(s) of 2 labelled');
    expect(res.data).toMatchObject({ unlabelled: 1 });
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

  it('reports a throw rather than a clean summary, and abandons after five throws (CRITICAL-1, IMPORTANT-5)', async () => {
    // Forced through a `compileRule` spy rather than an actual
    // catastrophic-backtracking `regex` pattern, to keep this test fast —
    // `regex.test.ts`'s Obligation 1 gate already proves the real timeout
    // takes multiple seconds. Before this fix, this exact scenario rendered
    // as "0/20 matched · 0 false positive(s) of ... labelled · 0 missed" —
    // indistinguishable from a rule that behaved perfectly.
    const spy = vi.spyOn(automodRegistry, 'compileRule').mockReturnValue({
      ok: true,
      compiled: {
        evaluate: () => {
          throw new Error('boom');
        },
      },
    });
    try {
      const res = await drive(
        automodDryRunCommand,
        {
          findAutomodRule: () => ruleWith(['badword']),
          listAutomodFixtures: () =>
            Array.from({ length: 20 }, (_, i) =>
              fixture({ fixtureId: `f${String(i)}`, content: `fixture ${String(i)}` }),
            ),
        },
        { ruleId: 'r1' },
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.text).toContain('5 of 5 evaluation(s) failed');
      expect(res.text).toContain('abandoned');
      expect(res.text).toContain('5 of 20 fixtures');
      // The rendering rule that matters most: no match table, no per-fixture
      // trace, once the predicate threw — a table under a report where most
      // fixtures never actually ran is worse than useless.
      expect(res.text).not.toContain('matched on');
      expect(res.data).toMatchObject({ threw: 5, total: 5, corpusSize: 20 });
    } finally {
      spy.mockRestore();
    }
  });

  it('says how many fixtures carry attachment metadata, for an attachment_type rule (IMPORTANT-6)', async () => {
    // `attachment_type` can only ever match a fixture with attachment rows,
    // and a fixture captured before migration 0013 has none. Over a corpus
    // where most fixtures predate that migration, "0/3 matched" reads as
    // "no bad files were posted" when it is actually "no fixture here
    // records a file either way".
    const res = await drive(
      automodDryRunCommand,
      {
        findAutomodRule: () =>
          ruleWith([], { kind: 'attachment_type', config: '{"blockedExtensions":["exe"]}' }),
        listAutomodFixtures: () => [
          fixture({ fixtureId: 'f1', content: 'no file here' }),
          fixture({ fixtureId: 'f2', content: 'no file here either' }),
          fixture({
            fixtureId: 'f3',
            content: 'has a file',
            attachments: [{ fileName: 'x.txt', contentType: 'text/plain', sizeBytes: 1 }],
          }),
        ],
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('1 of 3 fixtures carry attachment metadata');
    expect(res.data).toMatchObject({ attachmentMetadata: { withMetadata: 1, total: 3 } });
  });

  it('does not mention attachment metadata for a rule kind that does not read attachments', async () => {
    const res = await drive(
      automodDryRunCommand,
      {
        findAutomodRule: () => ruleWith(['badword']),
        listAutomodFixtures: () => [fixture({ fixtureId: 'f1', content: 'hello badword' })],
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).not.toContain('attachment metadata');
    expect(res.data).toMatchObject({ attachmentMetadata: null });
  });

  it('caveats a windowed rule’s replay: the corpus under-counts and PR-1’s edit rows over-count (CRITICAL-3)', async () => {
    // The corpus (`captureObservedFixture`) records only messages that
    // already matched, so the events that *built* a window count are absent
    // from it by construction — a genuinely working rule reports MISSED over
    // this corpus. And PR-1 gives every edit of the same message its own
    // fixture row, which the fixture replay treats as a separate
    // `messageCreate` each — two rows here share the message id `abc`, which
    // is the over-report term made visible. Without the caveat, both facts
    // are invisible to whoever reads this command's output.
    const res = await drive(
      automodDryRunCommand,
      {
        findAutomodRule: () =>
          ruleWith([], { kind: 'rapid_spam', config: '{"maxMessages":100,"windowMs":10000}' }),
        listAutomodFixtures: () => [
          fixture({ fixtureId: 'abc:hash1', content: 'first version', label: 'should_match' }),
          fixture({ fixtureId: 'abc:hash2', content: 'edited version', label: 'should_match' }),
          fixture({ fixtureId: 'xyz:hash3', content: 'unrelated message' }),
        ],
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('holds only previously-matched messages');
    expect(res.text).toContain('not a rate over traffic');
    expect(res.text).toContain('2 of 3');
    expect(res.data).toMatchObject({ windowedCorpusCaveat: { editedMessageRows: 2 } });
  });

  it('warns that a handwritten replay cannot test whether a windowed rule keeps members apart', async () => {
    // `predicateInputFrom` maps every handwritten fixture's null author to the
    // same literal `'fixture'`, so a windowed rule replayed over handwritten
    // fixtures sees ONE member's burst whatever the operator wrote. The
    // scenario that makes this bite is the natural pre-flip check —
    // "three different members each post this phrase once, which must not trip
    // duplicate_message" — which collapses to one member repeating itself and
    // matches, answering the opposite of the truth about the one property it
    // was used to check.
    //
    // The ambiguity that makes this non-decorative: the corpus is ALL
    // handwritten and the rule IS windowed, which is the only combination that
    // warrants the warning. The two neighbouring tests cover a windowed rule
    // over observed rows (no warning) and a non-windowed rule (no caveat at
    // all), so a warning printed unconditionally would redden one of them.
    const res = await drive(
      automodDryRunCommand,
      {
        findAutomodRule: () =>
          ruleWith([], {
            kind: 'duplicate_message',
            config: '{"maxRepeats":1,"windowMs":30000,"minLength":1}',
          }),
        listAutomodFixtures: () => [
          fixture({ fixtureId: 'hw-1', content: 'same phrase', source: 'handwritten' }),
          fixture({ fixtureId: 'hw-2', content: 'same phrase', source: 'handwritten' }),
        ],
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('same synthetic author');
    expect(res.text).toContain('cannot test whether this rule keeps members apart');
    expect(res.data).toMatchObject({ windowedCorpusCaveat: { handwrittenRows: 2 } });
  });

  it('does not caveat a non-windowed rule’s replay', async () => {
    const res = await drive(
      automodDryRunCommand,
      {
        findAutomodRule: () => ruleWith(['badword']),
        listAutomodFixtures: () => [fixture({ fixtureId: 'f1', content: 'hello badword' })],
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).not.toContain('not a rate over traffic');
    expect(res.data).toMatchObject({ windowedCorpusCaveat: null });
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

  it('shows the message and the matched snippet as their own lines, unconditionally', async () => {
    // CRITICAL-2: before this fix, `matchedSnippet`/`matchedCategory` were
    // fetched and projected into `data` but never printed in `text` at all —
    // the excerpt inside `renderTrace` was the only route to the message, and
    // that route is gated on a span existing.
    const res = await drive(automodReviewCommand, {
      listUnreviewedMatches: () => [
        reviewableMatch({
          eventId: 'e1',
          fixtureContent: 'hello badword everyone',
          matchedSnippet: 'badword',
          matchedCategory: 'profanity',
        }),
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('message');
    expect(res.text).toContain('hello badword everyone');
    expect(res.text).toContain('matched');
    expect(res.text).toContain('"badword"');
    expect(res.text).toContain('profanity');
  });

  it('shows the message even when the trace has no span', async () => {
    // `span` is `.optional()` on `MatchTrace`. `keyword_filter` always sets
    // one; Slices 3-5 land predicates during this same observe window
    // (`rapid_spam`, `duplicate_message`, `mention_spam`, `attachment_type`)
    // that judge the whole message rather than a substring of it and so have
    // no span. Before this fix, a spanless trace meant `renderTrace` never
    // printed the excerpt line, and nothing else printed the message either
    // — the review queue would show no message at all.
    const res = await drive(automodReviewCommand, {
      listUnreviewedMatches: () => [
        reviewableMatch({
          eventId: 'e1',
          trace: '{"kind":"keyword_filter","matchedOn":"badword","normalisations":[],"detail":{}}',
          fixtureContent: 'hello badword everyone',
        }),
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('hello badword everyone');
  });

  it('renders a match whose trace is malformed without hiding the message or the snippet', async () => {
    // A trace read back from the database is untrusted (CLAUDE.md rule 3).
    // A row this build cannot parse is still a match a human must rule on,
    // so the trace is replaced by a reason — but the message and the
    // snippet, which do not come from the trace, must still appear. Before
    // this fix `match.fixtureContent` sat in scope, unprinted, whenever the
    // trace failed to parse: an event id, a rule id, a member id, a
    // timestamp, an error, and then a command inviting a verdict.
    const res = await drive(automodReviewCommand, {
      listUnreviewedMatches: () => [
        reviewableMatch({
          eventId: 'e1',
          trace: 'not json',
          fixtureContent: 'hello badword everyone',
          matchedSnippet: 'badword',
          matchedCategory: 'profanity',
        }),
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('e1');
    expect(res.text).toContain('trace could not be read');
    expect(res.text).toContain('hello badword everyone');
    expect(res.text).toContain('"badword"');
    expect(res.text).toContain('profanity');
  });

  it('renders a match whose fixture has been forgotten, still showing the matched snippet', async () => {
    // /forgetme removed the message. The match is still reviewable from the
    // trace and the snippet — worse evidence, honestly labelled, and never
    // printed as though the snippet were the whole message.
    const res = await drive(automodReviewCommand, {
      listUnreviewedMatches: () => [
        reviewableMatch({
          eventId: 'e1',
          fixtureContent: undefined,
          matchedSnippet: 'badword',
          matchedCategory: 'profanity',
        }),
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('message no longer stored');
    expect(res.text).toContain('"badword"');
    expect(res.text).toContain('profanity');
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

  it('tells the reviewer when their verdict cost the corpus its label', async () => {
    // IMPORTANT-1: one message matching two rules shares one fixture, and a
    // fixture's label has no rule dimension — so when a second rule's verdict
    // disagrees, the label resets to unlabelled rather than one verdict
    // silently overwriting the other. From the reviewer's side that is
    // invisible: they ruled on a match and moved on. If the command does not
    // say so, the regression corpus quietly stops growing and nobody knows
    // why. The verdict itself is still recorded — this is a success line.
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodVerdictCommand,
      {
        recordMatchVerdict: () => 'recorded-with-label-conflict',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { eventId: 'e1', verdict: 'true_positive' },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('recorded true_positive for e1');
    expect(res.text).toContain('another rule');
    expect(res.text).toContain('reset to unlabelled');
    // The verdict still counts toward the gate — say so, or a reviewer reads
    // this as "my verdict was thrown away".
    expect(res.text).toContain('your verdict still counts');
    expect(res.data).toMatchObject({ ok: true, fixtureLabelConflict: true });
    // The corpus lost a label as a side effect of this command, so the audit
    // trail has to show where it went.
    expect(audit).toEqual([
      expect.objectContaining({
        after: expect.objectContaining({ fixtureLabelConflict: true }),
      }),
    ]);
  });

  it('says nothing about conflicts on an ordinary verdict', async () => {
    const res = await driveWrite(
      automodVerdictCommand,
      {
        recordMatchVerdict: () => 'recorded',
        recordAudit: () => {
          /* a write command's audit row is written by the dispatcher */
        },
      },
      { eventId: 'e1', verdict: 'true_positive' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).not.toContain('another rule');
    expect(res.data).toMatchObject({ fixtureLabelConflict: false });
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
        // `fixtureLabelConflict` is part of the audited `after` because a
        // conflict removes a label from the corpus as a side effect of this
        // command, and a trail recording only the verdict would not show
        // where the label went.
        after: { verdict: 'false_positive', fixtureLabelConflict: false },
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

describe('automod ready', () => {
  it('is registered as a write', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('automod ready');
    expect(automodReadyCommand.write).toBe(true);
  });

  it('refuses without --confirm', async () => {
    const res = await driveWrite(
      automodReadyCommand,
      { setAutomodRuleReady: () => ({ ok: true }) },
      { ruleId: 'r1' },
      { confirm: false },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('needs-confirm');
  });

  it('marks the rule ready and writes an audit row', async () => {
    const audit: unknown[] = [];
    let seenRuleId: string | undefined;
    const res = await driveWrite(
      automodReadyCommand,
      {
        setAutomodRuleReady: (ruleId) => {
          seenRuleId = ruleId;
          return { ok: true };
        },
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(seenRuleId).toBe('r1');
    expect(res.text).toContain('r1');
    expect(res.text).toContain('ready for enforcement');
    expect(res.data).toMatchObject({ ok: true, ruleId: 'r1' });
    expect(audit).toEqual([
      expect.objectContaining({ action: 'automod.cutover_ready', subjectId: 'r1' }),
    ]);
  });

  it('refuses from rolled_back, naming the state — the test that matters (ADR 0042, PR-27)', async () => {
    // Without this precondition surfacing correctly, a rollback could be
    // undone by `ready` then `enforce` without ever revisiting `observing`.
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodReadyCommand,
      {
        setAutomodRuleReady: () => ({ ok: false, reason: 'not-observing', state: 'rolled_back' }),
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('rolled_back');
    expect(res.text).toContain('must be observing');
    expect(res.data).toMatchObject({ ok: false, reason: 'not-observing', state: 'rolled_back' });
    // A refusal is still a fact worth having in the audit trail (the same
    // treatment `automod verdict`'s `'no-such-event'` gets).
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.cutover_ready',
        after: expect.objectContaining({ state: 'rolled_back' }),
      }),
    ]);
  });

  it.each(['not_started', 'cutover'] as const)(
    'refuses from %s, naming the state',
    async (state) => {
      const res = await driveWrite(
        automodReadyCommand,
        {
          setAutomodRuleReady: () => ({ ok: false, reason: 'not-observing', state }),
          recordAudit: () => {},
        },
        { ruleId: 'r1' },
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.text).toContain(state);
      expect(res.data).toMatchObject({ ok: false, state });
    },
  );
});

describe('automod signoff', () => {
  it('is registered as a write', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('automod signoff');
    expect(automodSignoffCommand.write).toBe(true);
  });

  it('refuses without --confirm', async () => {
    const res = await driveWrite(
      automodSignoffCommand,
      { findAutomodRule: () => ruleWith(['badword']), listAutomodFixtures: () => [] },
      { ruleId: 'r1' },
      { confirm: false },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('needs-confirm');
  });

  it('refuses a rule id that is not there, but still writes an audit row', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodSignoffCommand,
      {
        findAutomodRule: () => undefined,
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'nope' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('no enabled rule');
    expect(res.data).toMatchObject({ ok: false, reason: 'no-such-rule' });
    expect(audit).toEqual([
      expect.objectContaining({ after: expect.objectContaining({ outcome: 'no-such-rule' }) }),
    ]);
  });

  /**
   * PR-29's three conditions, each its own test — the brief's own warning: a
   * single "not clean" test would pass an implementation that checks only
   * one of the three fields.
   */
  it('refuses when the rule cannot be compiled (usable: false)', async () => {
    const res = await driveWrite(
      automodSignoffCommand,
      {
        findAutomodRule: () => ruleWith([]), // no terms: keyword_filter cannot compile
        listAutomodFixtures: () => [fixture({ fixtureId: 'f1', content: 'anything' })],
        recordAudit: () => {},
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('cannot be signed off');
    expect(res.text).toContain('usable=false');
    expect(res.data).toMatchObject({ ok: false, reason: 'dry-run-not-clean', usable: false });
  });

  it('refuses when the predicate threw (threw > 0), even with usable: true and no false positives', async () => {
    const spy = vi.spyOn(automodRegistry, 'compileRule').mockReturnValue({
      ok: true,
      compiled: {
        evaluate: () => {
          throw new Error('boom');
        },
      },
    });
    try {
      const res = await driveWrite(
        automodSignoffCommand,
        {
          findAutomodRule: () => ruleWith(['badword']),
          listAutomodFixtures: () => [fixture({ fixtureId: 'f1', content: 'hello' })],
          recordAudit: () => {},
        },
        { ruleId: 'r1' },
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.text).toContain('cannot be signed off');
      expect(res.text).toContain('threw=1');
      expect(res.data).toMatchObject({ ok: false, reason: 'dry-run-not-clean', threw: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses when there is a false positive (falsePositives > 0), even with usable: true and threw: 0', async () => {
    const res = await driveWrite(
      automodSignoffCommand,
      {
        findAutomodRule: () => ruleWith(['badword']),
        listAutomodFixtures: () => [
          fixture({ fixtureId: 'f1', content: 'badword here', label: 'should_not_match' }),
        ],
        recordAudit: () => {},
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('cannot be signed off');
    expect(res.text).toContain('falsePositives=1');
    expect(res.data).toMatchObject({
      ok: false,
      reason: 'dry-run-not-clean',
      falsePositives: 1,
    });
  });

  /**
   * The three conditions above are all *absences* — nothing failed to compile,
   * nothing threw, nothing was a false positive — and an empty corpus satisfies
   * every one of them vacuously. That makes the sign-off, which is the only
   * thing that clears the low-volume floor, grantable on no evidence at all:
   * observe → ready → signoff → enforce with zero reviewed matches and zero
   * labelled fixtures, and the operator is told the corpus pass was clean.
   *
   * `DryRunFixtureResult.agreement`'s own comment already names this failure:
   * "counting an unlabelled non-match as a success would make every rule look
   * perfect on the day it shipped." `automod dryrun` refuses to print a rate
   * for an unlabelled corpus for exactly that reason — the human-facing guard
   * existed and the machine-facing one did not.
   *
   * A clean pass presupposes something was judged, so the check now also
   * requires at least one fixture the rule actually agreed with.
   */
  it('refuses on an empty corpus rather than calling nothing a clean pass', async () => {
    const res = await driveWrite(
      automodSignoffCommand,
      {
        findAutomodRule: () => ruleWith(['badword']),
        listAutomodFixtures: () => [],
        recordAudit: () => {},
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('cannot be signed off');
    expect(res.data).toMatchObject({ ok: false, reason: 'no-corpus-evidence', agreed: 0 });
  });

  it('refuses a corpus the rule matches but nobody has labelled', async () => {
    // Deliberately a corpus the rule *does* match: `matched > 0` while
    // `agreed === 0`, so an implementation that mistook "the rule fired" for
    // "the rule was judged correct" would pass this and still be wrong.
    const res = await driveWrite(
      automodSignoffCommand,
      {
        findAutomodRule: () => ruleWith(['badword']),
        listAutomodFixtures: () => [
          fixture({ fixtureId: 'f1', content: 'hello badword' }),
          fixture({ fixtureId: 'f2', content: 'badword again' }),
        ],
        recordAudit: () => {},
      },
      { ruleId: 'r1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('cannot be signed off');
    expect(res.data).toMatchObject({ ok: false, reason: 'no-corpus-evidence', agreed: 0 });
  });

  it('records the sign-off and writes an audit row once the dry run is clean', async () => {
    const audit: unknown[] = [];
    let seen: { ruleId: string; signedOffBy: string } | undefined;
    const res = await driveWrite(
      automodSignoffCommand,
      {
        findAutomodRule: () => ruleWith(['badword']),
        listAutomodFixtures: () => [
          fixture({ fixtureId: 'f1', content: 'hello badword', label: 'should_match' }),
        ],
        recordAutomodSignOff: (input) => {
          seen = input;
        },
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'r1' },
      { unixUserClaimed: 'bryan' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('signed off by cli:bryan');
    expect(res.data).toMatchObject({ ok: true, ruleId: 'r1', signedOffBy: 'cli:bryan' });
    expect(seen).toEqual({ ruleId: 'r1', signedOffBy: 'cli:bryan' });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.enforce_signed_off',
        after: expect.objectContaining({ outcome: 'recorded', signedOffBy: 'cli:bryan' }),
      }),
    ]);
  });
});

/**
 * These four suites drive `fakeOpsPorts` with canned outcomes and assert on
 * rendered text — they test the renderer, not the repository, so they
 * cannot by themselves catch IMPORTANT-1 (the wrong `listType` printed),
 * IMPORTANT-2 (canonicalisation asymmetry between add and remove) or
 * IMPORTANT-7 (no kind check) — the fake never disagrees with what the
 * command asks it to say (decorative guard 1, review of Slices 3+5). Real
 * round-trip coverage against a migrated database and the real repository
 * lives in `packages/storage/src/repos/automod-rule-lists.test.ts`, which is
 * the one place that can reach both (`core` may not import `@bananasaurs/
 * storage`, ADR 0014).
 */

describe('automod invite-allow', () => {
  it('is registered as a write', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('automod invite-allow');
    expect(automodInviteAllowCommand.write).toBe(true);
  });

  it('adds an invite allowlist entry and audits it', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodInviteAllowCommand,
      {
        addInviteAllowlistEntry: () => 'added',
        listInviteAllowlist: () => [{ code: 'clubhouse', label: 'our own server' }],
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'invite-rule', code: 'clubhouse', label: 'our own server' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, code: 'clubhouse', alreadyPresent: false });
    expect(res.text).toContain('added clubhouse');
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.invite_allowlist_added',
        subjectType: 'mod_rule',
        subjectId: 'invite-rule',
      }),
    ]);
  });

  it('says a code is already allowed rather than erroring on a repeat add', async () => {
    const res = await driveWrite(
      automodInviteAllowCommand,
      {
        addInviteAllowlistEntry: () => 'already-present',
        listInviteAllowlist: () => [{ code: 'clubhouse', label: 'our own server' }],
        recordAudit: () => {},
      },
      { ruleId: 'invite-rule', code: 'clubhouse', label: 'our own server' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, alreadyPresent: true });
    expect(res.text).toContain('already on');
  });

  it('refuses to add an entry to a rule that does not exist, but still audits it', async () => {
    // A usage answer, not a fault — the same treatment `automod verdict`
    // gives a mistyped event id, and for the same reason: an operator at a
    // terminal will mistype a rule id. An audit row is still owed.
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodInviteAllowCommand,
      {
        addInviteAllowlistEntry: () => 'no-such-rule',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'no-such-rule', code: 'x', label: 'y' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'no-such-rule' });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.invite_allowlist_added',
        subjectType: 'mod_rule',
        subjectId: 'no-such-rule',
        after: expect.objectContaining({ outcome: 'no-such-rule' }),
      }),
    ]);
  });

  it('refuses a rule id that names a rule of the wrong kind, but still audits it (IMPORTANT-7)', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodInviteAllowCommand,
      {
        addInviteAllowlistEntry: () => 'wrong-kind',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'default-word-filter', code: 'clubhouse', label: 'our own server' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'wrong-kind' });
    expect(res.text).toContain('not an invite rule');
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.invite_allowlist_added',
        after: expect.objectContaining({ outcome: 'wrong-kind' }),
      }),
    ]);
  });

  it('refuses without --confirm', async () => {
    const res = await driveWrite(
      automodInviteAllowCommand,
      { addInviteAllowlistEntry: () => 'added', listInviteAllowlist: () => [] },
      { ruleId: 'r1', code: 'x', label: 'y' },
      { confirm: false },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('needs-confirm');
  });
});

describe('automod invite-deny', () => {
  it('is registered as a write', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('automod invite-deny');
    expect(automodInviteDenyCommand.write).toBe(true);
  });

  it('removes an invite allowlist entry', async () => {
    const res = await driveWrite(
      automodInviteDenyCommand,
      {
        removeInviteAllowlistEntry: () => 'removed',
        listInviteAllowlist: () => [],
        recordAudit: () => {},
      },
      { ruleId: 'invite-rule', code: 'clubhouse' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, removed: true });
    expect(res.text).toContain('removed clubhouse');
  });

  it('says a code was not on the list rather than erroring', async () => {
    const res = await driveWrite(
      automodInviteDenyCommand,
      {
        removeInviteAllowlistEntry: () => 'not-present',
        listInviteAllowlist: () => [],
        recordAudit: () => {},
      },
      { ruleId: 'invite-rule', code: 'ghost' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, removed: false });
    expect(res.text).toContain('was not on');
  });

  it('refuses a rule that does not exist, but still audits it', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodInviteDenyCommand,
      {
        removeInviteAllowlistEntry: () => 'no-such-rule',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'no-such-rule', code: 'x' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'no-such-rule' });
    expect(audit).toEqual([
      expect.objectContaining({ action: 'automod.invite_allowlist_removed' }),
    ]);
  });

  it('refuses a rule id that names a rule of the wrong kind, but still audits it (IMPORTANT-7)', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodInviteDenyCommand,
      {
        removeInviteAllowlistEntry: () => 'wrong-kind',
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'default-word-filter', code: 'clubhouse' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'wrong-kind' });
    expect(res.text).toContain('not an invite rule');
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.invite_allowlist_removed',
        after: expect.objectContaining({ outcome: 'wrong-kind' }),
      }),
    ]);
  });
});

describe('automod domain-add', () => {
  it('is registered as a write', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('automod domain-add');
    expect(automodDomainAddCommand.write).toBe(true);
  });

  it('adds a domain and audits it', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodDomainAddCommand,
      {
        addLinkDomain: () => ({ outcome: 'added', mode: 'deny' }),
        listLinkDomains: () => [{ domain: 'example.com', listType: 'deny' }],
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'domain-rule', domain: 'example.com', listType: 'deny' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, domain: 'example.com', listType: 'deny' });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.link_domain_added',
        subjectType: 'mod_rule',
        subjectId: 'domain-rule',
      }),
    ]);
  });

  it("names the domain's stored listType, not the operator's requested one, on a repeat add under the other list (IMPORTANT-1)", async () => {
    // The primary key is (guild, rule, domain), so re-adding under the
    // *other* listType is a no-op the port reports as `already-present`
    // with the listType actually stored — here, `allow`, even though the
    // operator asked for `deny`.
    const res = await driveWrite(
      automodDomainAddCommand,
      {
        addLinkDomain: () => ({ outcome: 'already-present', listType: 'allow', mode: 'allow' }),
        listLinkDomains: () => [{ domain: 'example.com', listType: 'allow' }],
        recordAudit: () => {},
      },
      { ruleId: 'domain-rule', domain: 'example.com', listType: 'deny' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, alreadyPresent: true, listType: 'allow' });
    expect(res.text).toContain("already on rule domain-rule's allow list");
    expect(res.text).not.toContain("already on rule domain-rule's deny list");
    expect(res.text).toContain('move it to deny');
  });

  it('warns when the add leaves the rule matching every link — an allow-mode rule with nothing on its allow list (CRITICAL-2)', async () => {
    // Adding a deny-listType domain to an allow-mode rule does not touch the
    // active (allow) list, so it can still be empty after the write.
    const res = await driveWrite(
      automodDomainAddCommand,
      {
        addLinkDomain: () => ({ outcome: 'added', mode: 'allow' }),
        listLinkDomains: () => [{ domain: 'example.com', listType: 'deny' }],
        recordAudit: () => {},
      },
      { ruleId: 'domain-rule', domain: 'example.com', listType: 'deny' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('matches every link');
  });

  it('refuses a listType outside allow|deny at the validator', async () => {
    const res = await driveWrite(
      automodDomainAddCommand,
      { addLinkDomain: () => ({ outcome: 'added', mode: 'allow' }), listLinkDomains: () => [] },
      { ruleId: 'r1', domain: 'example.com', listType: 'block' },
    );
    expect(res.ok).toBe(false);
  });

  it('refuses a rule that does not exist, but still audits it', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodDomainAddCommand,
      {
        addLinkDomain: () => ({ outcome: 'no-such-rule' }),
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'no-such-rule', domain: 'example.com', listType: 'allow' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'no-such-rule' });
    expect(audit).toEqual([expect.objectContaining({ action: 'automod.link_domain_added' })]);
  });

  it('refuses a rule id that names a rule of the wrong kind, but still audits it (IMPORTANT-7)', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodDomainAddCommand,
      {
        addLinkDomain: () => ({ outcome: 'wrong-kind' }),
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'default-word-filter', domain: 'example.com', listType: 'allow' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'wrong-kind' });
    expect(res.text).toContain('not a link_domain rule');
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.link_domain_added',
        after: expect.objectContaining({ outcome: 'wrong-kind' }),
      }),
    ]);
  });
});

describe('automod domain-rm', () => {
  it('is registered as a write', () => {
    const names = OPERATOR_COMMANDS.map((c) => c.name);
    expect(names).toContain('automod domain-rm');
    expect(automodDomainRmCommand.write).toBe(true);
  });

  it('removes a domain', async () => {
    const res = await driveWrite(
      automodDomainRmCommand,
      {
        removeLinkDomain: () => ({ outcome: 'removed', mode: 'deny' }),
        listLinkDomains: () => [{ domain: 'other.example', listType: 'deny' }],
        recordAudit: () => {},
      },
      { ruleId: 'domain-rule', domain: 'example.com' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, removed: true });
  });

  it('says a domain was not on the list rather than erroring', async () => {
    const res = await driveWrite(
      automodDomainRmCommand,
      {
        removeLinkDomain: () => ({ outcome: 'not-present', mode: 'deny' }),
        listLinkDomains: () => [{ domain: 'other.example', listType: 'deny' }],
        recordAudit: () => {},
      },
      { ruleId: 'domain-rule', domain: 'ghost.example' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: true, removed: false });
  });

  it('warns that the rule is now inert when the last deny row is removed (CRITICAL-2)', async () => {
    const res = await driveWrite(
      automodDomainRmCommand,
      {
        removeLinkDomain: () => ({ outcome: 'removed', mode: 'deny' }),
        listLinkDomains: () => [],
        recordAudit: () => {},
      },
      { ruleId: 'domain-rule', domain: 'example.com' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('can never match');
  });

  it('warns that the rule now matches every link when the last allow row is removed (CRITICAL-2)', async () => {
    // The dangerous direction, not just the inert one: "the domain lists are
    // now empty" used to read as a tidy-up regardless of which one this is.
    const res = await driveWrite(
      automodDomainRmCommand,
      {
        removeLinkDomain: () => ({ outcome: 'removed', mode: 'allow' }),
        listLinkDomains: () => [],
        recordAudit: () => {},
      },
      { ruleId: 'domain-rule', domain: 'club.org' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('matches every link');
    expect(res.text).toContain('add a domain or disable the rule');
  });

  it('refuses a rule that does not exist, but still audits it', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodDomainRmCommand,
      {
        removeLinkDomain: () => ({ outcome: 'no-such-rule' }),
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'no-such-rule', domain: 'example.com' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'no-such-rule' });
    expect(audit).toEqual([expect.objectContaining({ action: 'automod.link_domain_removed' })]);
  });

  it('refuses a rule id that names a rule of the wrong kind, but still audits it (IMPORTANT-7)', async () => {
    const audit: unknown[] = [];
    const res = await driveWrite(
      automodDomainRmCommand,
      {
        removeLinkDomain: () => ({ outcome: 'wrong-kind' }),
        recordAudit: (input) => {
          audit.push(input);
        },
      },
      { ruleId: 'default-word-filter', domain: 'example.com' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ ok: false, reason: 'wrong-kind' });
    expect(res.text).toContain('not a link_domain rule');
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'automod.link_domain_removed',
        after: expect.objectContaining({ outcome: 'wrong-kind' }),
      }),
    ]);
  });
});
