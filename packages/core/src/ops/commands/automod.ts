import { z } from 'zod';
import { stripZeroWidth } from '../../automod/matcher.js';
import { parseMatchTrace, renderTrace } from '../../automod/trace.js';
import { runDryRun, type DryRunReport } from '../../automod/dry-run.js';
import {
  defineCommand,
  type OpsCommandResult,
  type OpsContext,
  type OpsWriteResult,
} from '../dispatch.js';
import type { OpsReviewableMatch } from '../ports.js';
import type { JsonValue } from '../protocol.js';
import type { FixtureRecord } from '../../automod/predicates/types.js';

/**
 * `automod dryrun <ruleId>` (ADR 0041 §7): replay one rule over the saved
 * fixture corpus and report what it would have matched.
 *
 * Same three-part shape every read command in `reads.ts` uses — a port call,
 * a projection, a rendering that produces both `text` and `data` — because
 * this is the fourth file to need it, not the first, and inventing a
 * different shape here would be the drift `reads.ts`'s own header comment
 * warns about.
 *
 * This ships ahead of Slice 9's dashboard on purpose: the observe window
 * starts before that screen exists, and a rule nobody can inspect from a
 * terminal for the first fortnight is a rule whose worst two weeks of
 * evidence go unreviewed (ADR 0041 §7).
 */

const automodDryRunArgs = z.object({
  ruleId: z.string().min(1),
  source: z.enum(['observed', 'handwritten']).optional(),
});

/** Fixtures nobody has ruled on yet — neither `should_match` nor `should_not_match`. */
const unlabelledCount = (report: DryRunReport): number =>
  report.results.filter((result) => result.label === 'unlabelled').length;

/** How much of the corpus a rule reading attachments actually has to work with (IMPORTANT-6). */
interface AttachmentAwareness {
  readonly withMetadata: number;
  readonly total: number;
}

/**
 * Why a windowed rule's (`rapid_spam`, `duplicate_message`) replay count is
 * not a rate over traffic in either direction (CRITICAL-3, whole-branch
 * review) — the caveat this command owes an operator beside the summary,
 * modelled on `AttachmentAwareness` above, which is a strictly weaker version
 * of the same problem (`attachment_type`'s denominator including fixtures
 * that could not possibly match).
 *
 * **Under-report.** `captureObservedFixture` records only a message that
 * already matched, so the events that *built* a windowed rule's count —
 * the messages before the "one too many" one — are absent from the corpus by
 * construction. A rule that fired correctly on a burst captures only the
 * message(s) that matched; replayed alone, they produce a lower count and
 * `MISSED` for a rule that is working perfectly.
 *
 * **Over-report.** PR-1 gives every *edit* of a message its own corpus row
 * (`<messageId>:<hash(content)>`), and `predicateInputFrom`'s fixture branch
 * hard-codes `eventKind: 'messageCreate'` for every row it builds. For a rate
 * predicate that is not conservative: one message edited three times, each
 * edit captured, becomes four corpus rows and therefore four counted events
 * in a replay, where the live rule counted one create and ignored the edits
 * (PR-23). `editedMessageRows` makes that term visible: how many rows in this
 * corpus share a message id with another row.
 */
interface WindowedCorpusCaveat {
  readonly editedMessageRows: number;
}

/** An observed fixture's message id is the text before PR-1's `:<hash>` suffix. */
const fixtureMessageId = (fixtureId: string): string => fixtureId.split(':')[0] ?? fixtureId;

/**
 * How many observed fixtures in `fixtures` share a message id with another
 * row — the corpus rows a single edited message produced (CRITICAL-3's
 * over-report term). Handwritten fixtures are excluded: they have no message
 * behind them (`predicateInputFrom` uses the fixture id itself), so they
 * cannot be an edit of anything.
 */
const countEditedMessageRows = (fixtures: readonly FixtureRecord[]): number => {
  const observed = fixtures.filter((f) => f.source === 'observed');
  const counts = new Map<string, number>();
  for (const f of observed) {
    const messageId = fixtureMessageId(f.fixtureId);
    counts.set(messageId, (counts.get(messageId) ?? 0) + 1);
  }
  return observed.filter((f) => (counts.get(fixtureMessageId(f.fixtureId)) ?? 0) > 1).length;
};

/** The two kinds `window.ts`-backed predicates compile to (CRITICAL-3). */
const isWindowedKind = (kind: string): boolean =>
  kind === 'rapid_spam' || kind === 'duplicate_message';

/** `DryRunReport`, projected to plain `JsonValue` — no readonly arrays, no `undefined`. */
const projectReport = (
  report: DryRunReport,
  attachmentAwareness: AttachmentAwareness | undefined,
  windowedCorpusCaveat: WindowedCorpusCaveat | undefined,
): JsonValue => ({
  ruleId: report.ruleId,
  kind: report.kind,
  usable: report.usable,
  failure:
    report.failure === undefined
      ? null
      : { reason: report.failure.reason, detail: report.failure.detail },
  // CRITICAL-1: a throw is not a plain non-match, and `data` must be able to
  // say so on its own — a consumer reading only `matched`/`total` must not be
  // able to reconstruct "clean" from a rule that mostly threw.
  threw: report.threw,
  corpusSize: report.corpusSize,
  total: report.total,
  matched: report.matched,
  falsePositives: report.falsePositives,
  falseNegatives: report.falseNegatives,
  // CRITICAL-1: the denominator behind `falsePositives`/`falseNegatives`
  // belongs beside them in `data`, not only worked out from `results` by
  // whoever reads it — see the summary line below for the reasoning.
  unlabelled: unlabelledCount(report),
  // IMPORTANT-6: null for every kind but `attachment_type`, whose real
  // denominator (fixtures that carry attachment metadata at all) is not the
  // same number as `total` once the corpus predates OD-3's migration.
  attachmentMetadata:
    attachmentAwareness === undefined
      ? null
      : { withMetadata: attachmentAwareness.withMetadata, total: attachmentAwareness.total },
  // CRITICAL-3: null for every kind but the two windowed ones, whose replay
  // count is not a rate over traffic in either direction — see
  // `WindowedCorpusCaveat`'s doc comment.
  windowedCorpusCaveat:
    windowedCorpusCaveat === undefined
      ? null
      : { editedMessageRows: windowedCorpusCaveat.editedMessageRows },
  results: report.results.map((result) => ({
    fixtureId: result.fixtureId,
    label: result.label,
    matched: result.matched,
    agreement: result.agreement,
    outcome: result.outcome,
    match:
      result.match === undefined
        ? null
        : {
            categoryId: result.match.categoryId,
            snippet: result.match.snippet,
            trace: {
              kind: result.match.trace.kind,
              matchedOn: result.match.trace.matchedOn,
              span: result.match.trace.span === undefined ? null : [...result.match.trace.span],
              normalisations: [...result.match.trace.normalisations],
              detail: { ...result.match.trace.detail },
            },
          },
  })),
});

/** Indents every line of a rendered trace so it reads as nested under its match. */
const indented = (text: string, by = 4): string =>
  text
    .split('\n')
    .map((line) => `${' '.repeat(by)}${line}`)
    .join('\n');

export const automodDryRunCommand = defineCommand<z.infer<typeof automodDryRunArgs>>({
  name: 'automod dryrun',
  write: false,
  summary: 'replay one rule over the fixture corpus and report what it would match',
  positional: [{ name: 'ruleId', required: true, describe: 'the rule to replay' }],
  flags: [{ name: 'source', kind: 'string', describe: 'observed | handwritten (default: both)' }],
  args: automodDryRunArgs,
  run(ctx: OpsContext, args): OpsCommandResult {
    const rule = ctx.ports.findAutomodRule(args.ruleId);
    if (rule === undefined) {
      return {
        // "no *enabled* rule", because the port is enabled-only: a rule that
        // exists but is disabled lands here too, and "there is no rule" would
        // send an operator looking for a typo in an id that is perfectly
        // correct.
        text: `there is no enabled rule ${args.ruleId} in this guild (a disabled rule is not replayed)`,
        data: { ok: false, reason: 'no-such-rule', ruleId: args.ruleId },
      };
    }

    const fixtures = ctx.ports.listAutomodFixtures(
      args.source === undefined ? {} : { source: args.source },
    );
    const report = runDryRun({ guildId: ctx.guildId, rule, fixtures });
    const byFixtureId = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));

    // IMPORTANT-6: `attachment_type` can only ever match a fixture that has
    // attachment rows, and every fixture captured before migration 0013 has
    // none (`types.ts`: "an empty list is the honest representation"). Over
    // a corpus captured early in the observe window this rule's summary
    // denominator is the fixture count, not the count that could possibly
    // match — "0/300 matched" then reads as "no bad files were posted" when
    // it is actually "no fixture in this corpus records a file either way".
    // Computed for every branch below (not only the final summary) so it
    // reaches `data` even when the run is abandoned or the corpus is empty.
    const attachmentAwareness: AttachmentAwareness | undefined =
      report.kind === 'attachment_type'
        ? {
            withMetadata: report.results.filter(
              (result) => (byFixtureId.get(result.fixtureId)?.attachments.length ?? 0) > 0,
            ).length,
            total: report.total,
          }
        : undefined;

    // CRITICAL-3: the same "computed for every branch" treatment as
    // attachmentAwareness above — a windowed rule's replay count is wrong in
    // both directions regardless of which branch below ends up printing, so
    // the caveat belongs in `data` even when the run is abandoned or the
    // corpus is empty.
    const windowedCorpusCaveat: WindowedCorpusCaveat | undefined = isWindowedKind(report.kind)
      ? { editedMessageRows: countEditedMessageRows(fixtures) }
      : undefined;
    const data = projectReport(report, attachmentAwareness, windowedCorpusCaveat);

    // Case 1: the rule cannot even compile. A match count under it is worse
    // than useless — "0 matches" reads exactly like a rule behaving
    // perfectly (ADR 0039's failure mode, in this slice's newest disguise) —
    // so nothing past this line is printed.
    if (!report.usable) {
      const failure = report.failure;
      return {
        text:
          `rule ${report.ruleId} (${report.kind}) cannot be compiled: ` +
          `${failure?.reason ?? 'unknown'} — ${failure?.detail ?? '(no detail recorded)'}`,
        data,
      };
    }

    // Case 2: the corpus is empty. "0 matches, 0 false positives" would read
    // as a passing rule; this is the first day of the observe window, not a
    // clean rule, so it must say so instead of printing a table of zeroes.
    if (report.total === 0) {
      return {
        text: 'the corpus is empty; there is nothing to replay this rule against',
        data,
      };
    }

    // Case 3 (CRITICAL-1, IMPORTANT-5): the predicate threw on at least one
    // fixture. Treated the way !usable is treated above: a match table under
    // a report where some fixtures never actually ran the predicate is worse
    // than useless, because "0/300 matched" is indistinguishable from a rule
    // that behaved perfectly. `runDryRun` abandons the replay after five
    // throws, so `report.total` (evaluated) can be well short of
    // `report.corpusSize` (what exists) — said explicitly, because the run
    // was abandoned, not completed.
    if (report.threw > 0) {
      const abandoned = report.total < report.corpusSize;
      return {
        text:
          `${report.threw} of ${report.total} evaluation(s) failed (the predicate threw)` +
          (abandoned
            ? `; the run was abandoned after evaluating ${report.total} of ` +
              `${report.corpusSize} fixtures in the corpus`
            : ''),
        data,
      };
    }

    // CRITICAL-1: "41/300 matched · 0 false positive(s) · 0 missed" is true
    // and unreadable — it is indistinguishable from a rule 296 humans
    // confirmed correct, when in fact nobody has labelled anything yet. This
    // is the same failure shape the two guards above already close (an
    // unusable rule, an empty corpus) and the only one that happens on an
    // ordinary day, so the denominator behind the numerator goes on the same
    // line as the numerator, always.
    const unlabelled = unlabelledCount(report);
    const labelled = report.total - unlabelled;
    const summary =
      labelled === 0
        ? `${report.matched}/${report.total} matched · ${unlabelled} of ${report.total} ` +
          `fixtures unlabelled — no false-positive rate can be computed from this corpus yet ` +
          `(the Release 2 gate is measured from \`automod review\` verdicts, not from a corpus ` +
          `replay — ADR 0041 §2)`
        : `${report.matched}/${report.total} matched · ${report.falsePositives} false ` +
          `positive(s) of ${labelled} labelled · ${report.falseNegatives} missed`;

    const lines = [summary];
    if (attachmentAwareness !== undefined) {
      lines.push(
        `${attachmentAwareness.withMetadata} of ${attachmentAwareness.total} fixtures carry ` +
          `attachment metadata (the rest predate it and cannot match this rule)`,
      );
    }
    if (windowedCorpusCaveat !== undefined) {
      // CRITICAL-3: said in both directions. The corpus holds only
      // previously-matched messages, so this rule's count is not a rate over
      // traffic — a MISSED result here is expected, not a defect — and the
      // named rows are the over-report term: PR-1 gives every edit of a
      // message its own row, which this replay counts once each where the
      // live rule counts only the original create (PR-23).
      lines.push(
        `note: this corpus holds only previously-matched messages, so this rule's count is not ` +
          `a rate over traffic — a MISSED result on a windowed rule is expected here, not a ` +
          `defect; ${windowedCorpusCaveat.editedMessageRows} of ${report.total} row(s) in this ` +
          `corpus are extra rows for an edited message, which this replay counts once each where ` +
          `the live rule counts only the original create`,
      );
    }

    for (const result of report.results) {
      // Narrowed on `result.match` itself, not on `result.matched`: the two
      // fields are independent in `DryRunFixtureResult`'s type even though
      // `runDryRun` only ever sets them together, and this is the module
      // whose job is to avoid casting past that instead of trusting it.
      if (result.match !== undefined) {
        const fixture = byFixtureId.get(result.fixtureId);
        // `renderTrace`'s span was computed against the zero-width-stripped
        // content `evaluateRule` actually matched on (`predicateInputFrom`),
        // not the fixture's raw text — stripped again here so the excerpt's
        // indices land on the same string the match happened against.
        const content = fixture === undefined ? undefined : stripZeroWidth(fixture.content);
        lines.push('');
        lines.push(`${result.fixtureId}  [${result.label}]`);
        lines.push(indented(renderTrace(result.match.trace, content)));
        // The whole reason this ships before the dashboard is that a human
        // reviews from a terminal on day one; printing the next command is
        // what keeps that a workflow rather than something the operator has
        // to compose by hand every time.
        lines.push(
          indented(
            `see it in the live review queue: bananasaurs automod review --rule ${report.ruleId}`,
          ),
        );
      } else if (result.label === 'should_match') {
        // A miss the operator needs to see. An unlabelled non-match is the
        // ordinary case, and printing thousands of them would bury this.
        lines.push('');
        lines.push(
          `${result.fixtureId}  [${result.label}]  MISSED — the rule did not match this fixture`,
        );
      }
    }

    return { text: lines.join('\n'), data };
  },
});

/**
 * `automod review` / `automod verdict` (ADR 0041 §7, plan ruling PR-6): the
 * headless review path the observe window's first fortnight runs on, before
 * Slice 9's dashboard screen exists.
 */

const iso = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

const DEFAULT_REVIEW_LIMIT = 20;
const MAX_REVIEW_LIMIT = 200;

const automodReviewArgs = z.object({
  rule: z.string().min(1).optional(),
  limit: z.number().int().positive().max(MAX_REVIEW_LIMIT).optional(),
});

/** `OpsReviewableMatch`, projected to plain `JsonValue`. */
const projectReviewableMatch = (match: OpsReviewableMatch): JsonValue => ({
  eventId: match.eventId,
  ruleId: match.ruleId,
  memberId: match.memberId,
  at: match.at,
  matchedCategory: match.matchedCategory,
  matchedSnippet: match.matchedSnippet,
  actionTaken: match.actionTaken,
  trace: match.trace ?? null,
  fixtureContent: match.fixtureContent ?? null,
});

/**
 * Renders one match for a human to rule on.
 *
 * CRITICAL-2: the message and the matched snippet are their own lines,
 * printed unconditionally, independent of whether a trace is present, parses,
 * or carries a span. Before this fix both were fetched, carried through
 * `OpsReviewableMatch`, projected into `data` — and only ever reached `text`
 * as a side effect of `renderTrace`'s excerpt line, which is gated on
 * `trace.span !== undefined`. That meant a malformed trace (case 1 below)
 * rendered with no evidence at all, and the first predicate with no natural
 * span — `rapid_spam`, `duplicate_message`, `mention_spam`, `attachment_type`,
 * all landing during this same observe window — would have produced a review
 * queue where no message was ever shown.
 *
 * Rendering rules, neither decorative:
 *
 * - `message` prints whenever `fixtureContent` is present; otherwise "message
 *   no longer stored" — never the matched snippet standing in for the whole
 *   message, because a reviewer judging a false positive from a fragment they
 *   think is the full text would judge wrong.
 * - `matched` prints unconditionally, from `matchedSnippet`/`matchedCategory`
 *   — the documented post-flip and post-`/forgetme` fallback (plan ruling
 *   PR-2, ADR 0041's consequences, `docs/reports/release2-slices-1-6-ledger.md`
 *   handoff item 5) — labelled distinctly from `message` so the two are never
 *   mistaken for each other.
 * - A trace `parseMatchTrace` rejects still renders — as a reason, under the
 *   message and the snippet, not instead of them — because stored JSON is
 *   untrusted input (CLAUDE.md rule 3) and a trace this build cannot parse is
 *   still a match a human must rule on.
 * - `renderTrace`'s excerpt (when a span exists) stays as an *addition* on
 *   top of `message`, highlighting where in it the rule matched — not the
 *   only route to the text itself.
 *
 * The follow-up `automod verdict` command is printed under every match: the
 * whole point of shipping this before the dashboard is that a human reviews
 * from a terminal, and making them compose that command by hand is where a
 * review workflow stops being used.
 */
const renderReviewableMatch = (match: OpsReviewableMatch): string => {
  const lines = [
    `${match.eventId}  rule ${match.ruleId}  member ${match.memberId}  ` +
      `${iso(match.at)}  ${match.actionTaken}`,
  ];

  if (match.fixtureContent === undefined) {
    lines.push(
      indented(
        'message no longer stored (removed at the member’s request, or the rule was enforcing)',
      ),
    );
  } else {
    // Padded to 16 columns, the same convention `renderTrace` uses for its
    // own field labels, so the two blend into one reading rather than two
    // inconsistently-aligned ones.
    lines.push(indented(`${'message'.padEnd(16)}${match.fixtureContent}`));
  }

  // Always shown, and always distinct from `message` above: this is the
  // substring the rule matched on, not the whole message (CRITICAL-2).
  lines.push(
    indented(`${'matched'.padEnd(16)}"${match.matchedSnippet}"  (${match.matchedCategory})`),
  );

  if (match.trace === undefined) {
    // Not reachable through `listUnreviewedMatches`'s own filter (plan
    // ruling PR-7), but the port's type does not promise it, so this is
    // handled rather than assumed away.
    lines.push(indented('trace could not be read: no trace was recorded for this match'));
  } else {
    const parsed = parseMatchTrace(match.trace);
    if (!parsed.ok) {
      lines.push(indented(`trace could not be read: ${parsed.detail}`));
    } else {
      lines.push(indented(renderTrace(parsed.trace, match.fixtureContent)));
    }
  }

  lines.push(
    indented(
      `bananasaurs automod verdict ${match.eventId} <false_positive|true_positive|unclear> --confirm`,
    ),
  );

  return lines.join('\n');
};

export const automodReviewCommand = defineCommand<z.infer<typeof automodReviewArgs>>({
  name: 'automod review',
  write: false,
  summary: 'list automod matches nobody has ruled on yet, with the evidence',
  flags: [
    { name: 'rule', kind: 'string', describe: 'only matches from this rule' },
    {
      name: 'limit',
      kind: 'number',
      describe: `how many rows (default ${String(DEFAULT_REVIEW_LIMIT)}, max ${String(MAX_REVIEW_LIMIT)})`,
    },
  ],
  args: automodReviewArgs,
  run(ctx: OpsContext, args): OpsCommandResult {
    const matches = ctx.ports.listUnreviewedMatches({
      ...(args.rule === undefined ? {} : { ruleId: args.rule }),
      limit: args.limit ?? DEFAULT_REVIEW_LIMIT,
    });

    if (matches.length === 0) {
      return { text: 'nothing to review', data: [] };
    }

    return {
      text: matches.map(renderReviewableMatch).join('\n\n'),
      data: matches.map(projectReviewableMatch),
    };
  },
});

const automodVerdictArgs = z.object({
  eventId: z.string().min(1),
  verdict: z.enum(['false_positive', 'true_positive', 'unclear']),
  note: z.string().max(1000).optional(),
});

/**
 * Records whether a recorded match was right (ADR 0041 §5, §7).
 *
 * A write command, so `--confirm` and an audit record are enforced by the
 * dispatcher rather than remembered by this handler (`dispatch.ts`).
 *
 * `reviewedBy` is provenance, not authorisation (plan ruling PR-9): the
 * socket's group permissions are the access control (ADR 0024), and the
 * audit row the dispatcher writes below is the authoritative record of who
 * ran this command. `ctx.actor.unixUserClaimed` is a claim, never verified
 * (ADR 0024 amendment 2, `authz.ts`), which is exactly why it is recorded
 * with the `cli:` prefix rather than laundered into a bare username.
 */
export const automodVerdictCommand = defineCommand<z.infer<typeof automodVerdictArgs>>({
  name: 'automod verdict',
  write: true,
  summary: 'record whether a recorded match was right',
  positional: [
    { name: 'eventId', required: true, describe: 'the match to rule on (from `automod review`)' },
    { name: 'verdict', required: true, describe: 'false_positive | true_positive | unclear' },
  ],
  flags: [{ name: 'note', kind: 'string', describe: 'why — shown to whoever reads this later' }],
  args: automodVerdictArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const reviewedBy = `cli:${ctx.actor.unixUserClaimed ?? 'unknown'}`;
    const outcome = ctx.ports.recordMatchVerdict({
      eventId: args.eventId,
      verdict: args.verdict,
      reviewedBy,
      ...(args.note === undefined ? {} : { note: args.note }),
    });

    if (outcome === 'no-such-event') {
      // Not thrown: an operator typing an event id at a terminal will
      // mistype one, and that is a usage answer, not a fault. An audit row
      // is still owed — "an operator tried to rule on a match that does not
      // exist" is a fact worth having (Task 9 brief, Step 3).
      return {
        text: `no match ${args.eventId} in this guild's review queue`,
        data: { ok: false, reason: 'no-such-event', eventId: args.eventId },
        audit: {
          action: 'automod.verdict_recorded',
          subjectType: 'mod_case_event',
          subjectId: args.eventId,
          after: { outcome: 'no-such-event' },
        },
      };
    }

    const conflicted = outcome === 'recorded-with-label-conflict';

    return {
      // The verdict is stored either way — this is a success line, not a
      // warning about a failure. But the reviewer has to be told when the
      // regression corpus gained nothing from their work, because from their
      // side the two cases look identical: they ruled on one match and
      // pressed on. A fixture's label has no rule dimension, so when another
      // rule's verdict on the same message implies the opposite label there
      // is no honest single answer and the label resets to unlabelled
      // (IMPORTANT-1). Saying so here is what stops that being invisible.
      text: conflicted
        ? `recorded ${args.verdict} for ${args.eventId} (${reviewedBy})\n` +
          `note: another rule’s verdict on this same message disagrees, so the saved ` +
          `example was reset to unlabelled rather than one verdict overwriting the ` +
          `other — your verdict still counts toward the rule’s false-positive rate, ` +
          `but this message is no longer part of the regression corpus`
        : `recorded ${args.verdict} for ${args.eventId} (${reviewedBy})`,
      data: {
        ok: true,
        eventId: args.eventId,
        verdict: args.verdict,
        fixtureLabelConflict: conflicted,
      },
      audit: {
        action: 'automod.verdict_recorded',
        subjectType: 'mod_case_event',
        subjectId: args.eventId,
        // The conflict goes in the audit row too: it is a change to the
        // corpus (a label removed) made as a side effect of this command,
        // and an audit trail that recorded only the verdict would not show
        // where the label went.
        after: { verdict: args.verdict, fixtureLabelConflict: conflicted },
      },
    };
  },
});

/**
 * `automod invite-allow` / `automod invite-deny` / `automod domain-add` /
 * `automod domain-rm` (plan ruling PR-19, Task 9 of the slices 3-5 plan).
 *
 * Task 6 built `invite`'s labelled code allowlist and `link_domain`'s
 * allow/deny lists in storage, and shipped no caller — nothing outside a test
 * could add the club's own invite code to the allowlist. That is not merely
 * untidy: `observe` mode never touches Discord, so an empty allowlist harms
 * nobody during the observe window, but an `invite` rule with an empty
 * allowlist fires on the club's own invite links every time a member posts
 * one, and Slice 6's release gate demands zero false positives for a rule
 * that feeds the escalation counter. That rule cannot pass its gate until an
 * operator can populate the list, so this is in Release 2 even though the
 * dashboard screen (Slice 8/9) is not.
 *
 * Four commands under the existing `automod` namespace (plan ruling PR-6
 * named the precedent). Reads are not separate commands: this build has no
 * `automod rules` command to list a rule's own configuration, so each write
 * prints the resulting list itself — a list nobody can see is worse than one
 * nobody can edit, and inventing a fifth command to do only that would be
 * scope this task does not need.
 */

/** One line per invite allowlist entry, in the order the port already sorted them. */
const renderInviteAllowlist = (
  ruleId: string,
  entries: readonly { readonly code: string; readonly label: string }[],
): string =>
  entries.length === 0
    ? `rule ${ruleId}'s invite allowlist is now empty`
    : `rule ${ruleId}'s invite allowlist:\n` +
      entries.map((entry) => `  ${entry.code}  (${entry.label})`).join('\n');

const projectInviteAllowlist = (
  entries: readonly { readonly code: string; readonly label: string }[],
): JsonValue => entries.map((entry) => ({ code: entry.code, label: entry.label }));

/** One line per domain, in the order the port already sorted them. */
const renderLinkDomains = (
  ruleId: string,
  entries: readonly { readonly domain: string; readonly listType: 'allow' | 'deny' }[],
): string =>
  entries.length === 0
    ? `rule ${ruleId}'s domain lists are now empty`
    : `rule ${ruleId}'s domain lists:\n` +
      entries.map((entry) => `  ${entry.listType.padEnd(5)} ${entry.domain}`).join('\n');

const projectLinkDomains = (
  entries: readonly { readonly domain: string; readonly listType: 'allow' | 'deny' }[],
): JsonValue => entries.map((entry) => ({ domain: entry.domain, listType: entry.listType }));

/**
 * Says what an empty *active* list means for this rule, or `undefined` when
 * the active list — the one `config.mode` names — has at least one domain
 * (CRITICAL-2, review of Slices 3+5).
 *
 * "The domain lists are now empty" used to read as a completed tidy-up
 * regardless of which direction it failed in. It is either "this rule is now
 * inert" (`deny` with nothing on the deny list — ADR 0039's silent
 * non-matching) or "this rule now matches every link" (`allow` with nothing
 * on the allow list — the dangerous direction, since in `enforce` mode that
 * deletes every message containing a link). The command has the rule id and
 * now the port hands back `config.mode`, so it can say which.
 *
 * `mode` is `undefined` only if the rule's stored config failed to parse as
 * `{mode: 'allow' | 'deny'}` — a state `compileRule`/`doctor` already report
 * on their own path; this degrades to silence rather than guessing.
 */
const linkDomainStatusLine = (
  ruleId: string,
  mode: 'allow' | 'deny' | undefined,
  entries: readonly { readonly domain: string; readonly listType: 'allow' | 'deny' }[],
): string | undefined => {
  if (mode === undefined) return undefined;
  const activeCount = entries.filter((entry) => entry.listType === mode).length;
  if (activeCount > 0) return undefined;
  return mode === 'allow'
    ? `rule ${ruleId} is a whitelist (mode allow) and its allow list is empty, so it matches every link; add a domain or disable the rule`
    : `rule ${ruleId} is a blocklist (mode deny) and its deny list is empty, so it can never match; add a domain or disable the rule`;
};

/** Appends a status line, when there is one, on its own line. */
const withStatusLine = (text: string, statusLine: string | undefined): string =>
  statusLine === undefined ? text : `${text}\n${statusLine}`;

const automodInviteAllowArgs = z
  .object({
    ruleId: z.string().min(1),
    code: z.string().min(1).max(64),
    label: z.string().min(1).max(200),
  })
  .strict();

export const automodInviteAllowCommand = defineCommand<z.infer<typeof automodInviteAllowArgs>>({
  name: 'automod invite-allow',
  write: true,
  summary: "add a code to a rule's invite allowlist",
  positional: [
    { name: 'ruleId', required: true, describe: 'the invite rule to edit' },
    { name: 'code', required: true, describe: 'the invite code, e.g. clubhouse' },
    {
      name: 'label',
      required: true,
      describe: 'what this code is, for whoever reads the list later',
    },
  ],
  args: automodInviteAllowArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.addInviteAllowlistEntry({
      ruleId: args.ruleId,
      code: args.code,
      label: args.label,
    });

    if (outcome === 'no-such-rule') {
      // A usage answer, not a fault: an operator at a terminal will mistype
      // a rule id, and the composite foreign key would otherwise surface an
      // opaque `FOREIGN KEY constraint failed`. An audit row is still owed —
      // "an operator tried to edit a rule that does not exist" is a fact
      // worth having, the same treatment `automod verdict` gives a mistyped
      // event id.
      return {
        text: `no rule ${args.ruleId} in this guild`,
        data: { ok: false, reason: 'no-such-rule', ruleId: args.ruleId, code: args.code },
        audit: {
          action: 'automod.invite_allowlist_added',
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'no-such-rule', code: args.code },
        },
      };
    }

    if (outcome === 'wrong-kind') {
      // IMPORTANT-7: `ruleExists` alone cannot tell a real-but-wrong-kind
      // rule id from the operator's intended one — without this, the write
      // below would succeed against e.g. a `keyword_filter` rule, whose
      // `compile` never reads `inviteAllowlist`. A usage answer, the same
      // treatment as `no-such-rule`, and an audit row for the same reason.
      return {
        text: `rule ${args.ruleId} is not an invite rule; invite-allow only edits invite rules`,
        data: { ok: false, reason: 'wrong-kind', ruleId: args.ruleId, code: args.code },
        audit: {
          action: 'automod.invite_allowlist_added',
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'wrong-kind', code: args.code },
        },
      };
    }

    const list = ctx.ports.listInviteAllowlist(args.ruleId);
    const alreadyPresent = outcome === 'already-present';

    return {
      text:
        (alreadyPresent
          ? `${args.code} was already on rule ${args.ruleId}'s invite allowlist`
          : `added ${args.code} (${args.label}) to rule ${args.ruleId}'s invite allowlist`) +
        '\n' +
        renderInviteAllowlist(args.ruleId, list),
      data: {
        ok: true,
        code: args.code,
        alreadyPresent,
        allowlist: projectInviteAllowlist(list),
      },
      audit: {
        action: 'automod.invite_allowlist_added',
        subjectType: 'mod_rule',
        subjectId: args.ruleId,
        after: { code: args.code, label: args.label, alreadyPresent },
      },
    };
  },
});

const automodInviteDenyArgs = z
  .object({
    ruleId: z.string().min(1),
    code: z.string().min(1),
  })
  .strict();

export const automodInviteDenyCommand = defineCommand<z.infer<typeof automodInviteDenyArgs>>({
  name: 'automod invite-deny',
  write: true,
  summary: "remove a code from a rule's invite allowlist",
  positional: [
    { name: 'ruleId', required: true, describe: 'the invite rule to edit' },
    { name: 'code', required: true, describe: 'the invite code to remove' },
  ],
  args: automodInviteDenyArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.removeInviteAllowlistEntry({ ruleId: args.ruleId, code: args.code });

    if (outcome === 'no-such-rule') {
      return {
        text: `no rule ${args.ruleId} in this guild`,
        data: { ok: false, reason: 'no-such-rule', ruleId: args.ruleId, code: args.code },
        audit: {
          action: 'automod.invite_allowlist_removed',
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'no-such-rule', code: args.code },
        },
      };
    }

    if (outcome === 'wrong-kind') {
      return {
        text: `rule ${args.ruleId} is not an invite rule; invite-deny only edits invite rules`,
        data: { ok: false, reason: 'wrong-kind', ruleId: args.ruleId, code: args.code },
        audit: {
          action: 'automod.invite_allowlist_removed',
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'wrong-kind', code: args.code },
        },
      };
    }

    const list = ctx.ports.listInviteAllowlist(args.ruleId);
    const removed = outcome === 'removed';

    return {
      text:
        (removed
          ? `removed ${args.code} from rule ${args.ruleId}'s invite allowlist`
          : `${args.code} was not on rule ${args.ruleId}'s invite allowlist`) +
        '\n' +
        renderInviteAllowlist(args.ruleId, list),
      data: { ok: true, code: args.code, removed, allowlist: projectInviteAllowlist(list) },
      audit: {
        action: 'automod.invite_allowlist_removed',
        subjectType: 'mod_rule',
        subjectId: args.ruleId,
        after: { code: args.code, removed },
      },
    };
  },
});

const automodDomainAddArgs = z
  .object({
    ruleId: z.string().min(1),
    domain: z.string().min(1),
    listType: z.enum(['allow', 'deny']),
  })
  .strict();

export const automodDomainAddCommand = defineCommand<z.infer<typeof automodDomainAddArgs>>({
  name: 'automod domain-add',
  write: true,
  summary: "add a domain to a rule's allow or deny list",
  positional: [
    { name: 'ruleId', required: true, describe: 'the link_domain rule to edit' },
    { name: 'domain', required: true, describe: 'the domain, e.g. example.com' },
    { name: 'listType', required: true, describe: 'allow | deny' },
  ],
  args: automodDomainAddArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.addLinkDomain({
      ruleId: args.ruleId,
      domain: args.domain,
      listType: args.listType,
    });

    if (outcome.outcome === 'no-such-rule') {
      return {
        text: `no rule ${args.ruleId} in this guild`,
        data: { ok: false, reason: 'no-such-rule', ruleId: args.ruleId, domain: args.domain },
        audit: {
          action: 'automod.link_domain_added',
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'no-such-rule', domain: args.domain },
        },
      };
    }

    if (outcome.outcome === 'wrong-kind') {
      // IMPORTANT-7, same reasoning as invite-allow above: a rule id that
      // exists but is not a `link_domain` rule would otherwise accept a
      // write its own `compile` never reads.
      return {
        text: `rule ${args.ruleId} is not a link_domain rule; domain-add only edits link_domain rules`,
        data: { ok: false, reason: 'wrong-kind', ruleId: args.ruleId, domain: args.domain },
        audit: {
          action: 'automod.link_domain_added',
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'wrong-kind', domain: args.domain },
        },
      };
    }

    const list = ctx.ports.listLinkDomains(args.ruleId);
    const alreadyPresent = outcome.outcome === 'already-present';
    // IMPORTANT-1: the primary key is (guild, rule, domain), so re-adding a
    // domain under the *other* listType is a no-op — the port reports the
    // listType actually stored, which may differ from what the operator
    // asked for. Naming the requested one here would assert a state that is
    // false, with the real state printed right below it in `renderLinkDomains`.
    const storedListType = alreadyPresent ? outcome.listType : args.listType;
    const mainLine = alreadyPresent
      ? `${args.domain} is already on rule ${args.ruleId}'s ${storedListType} list; nothing changed` +
        (storedListType === args.listType
          ? ''
          : ` (remove it first to move it to ${args.listType})`)
      : `added ${args.domain} to rule ${args.ruleId}'s ${args.listType} list`;

    return {
      text: withStatusLine(
        `${mainLine}\n${renderLinkDomains(args.ruleId, list)}`,
        linkDomainStatusLine(args.ruleId, outcome.mode, list),
      ),
      data: {
        ok: true,
        domain: args.domain,
        listType: storedListType,
        alreadyPresent,
        domains: projectLinkDomains(list),
      },
      audit: {
        action: 'automod.link_domain_added',
        subjectType: 'mod_rule',
        subjectId: args.ruleId,
        after: { domain: args.domain, listType: storedListType, alreadyPresent },
      },
    };
  },
});

const automodDomainRmArgs = z
  .object({
    ruleId: z.string().min(1),
    domain: z.string().min(1),
  })
  .strict();

export const automodDomainRmCommand = defineCommand<z.infer<typeof automodDomainRmArgs>>({
  name: 'automod domain-rm',
  write: true,
  summary: "remove a domain from a rule's allow or deny list",
  positional: [
    { name: 'ruleId', required: true, describe: 'the link_domain rule to edit' },
    { name: 'domain', required: true, describe: 'the domain to remove' },
  ],
  args: automodDomainRmArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.removeLinkDomain({ ruleId: args.ruleId, domain: args.domain });

    if (outcome.outcome === 'no-such-rule') {
      return {
        text: `no rule ${args.ruleId} in this guild`,
        data: { ok: false, reason: 'no-such-rule', ruleId: args.ruleId, domain: args.domain },
        audit: {
          action: 'automod.link_domain_removed',
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'no-such-rule', domain: args.domain },
        },
      };
    }

    if (outcome.outcome === 'wrong-kind') {
      return {
        text: `rule ${args.ruleId} is not a link_domain rule; domain-rm only edits link_domain rules`,
        data: { ok: false, reason: 'wrong-kind', ruleId: args.ruleId, domain: args.domain },
        audit: {
          action: 'automod.link_domain_removed',
          subjectType: 'mod_rule',
          subjectId: args.ruleId,
          after: { outcome: 'wrong-kind', domain: args.domain },
        },
      };
    }

    const list = ctx.ports.listLinkDomains(args.ruleId);
    const removed = outcome.outcome === 'removed';
    // CRITICAL-2: "the domain lists are now empty" used to read as a
    // completed tidy-up regardless of which direction it failed in.
    // `linkDomainStatusLine` says which, using the rule's own `config.mode`.
    const mainLine = removed
      ? `removed ${args.domain} from rule ${args.ruleId}'s domain lists`
      : `${args.domain} was not on rule ${args.ruleId}'s domain lists`;

    return {
      text: withStatusLine(
        `${mainLine}\n${renderLinkDomains(args.ruleId, list)}`,
        linkDomainStatusLine(args.ruleId, outcome.mode, list),
      ),
      data: { ok: true, domain: args.domain, removed, domains: projectLinkDomains(list) },
      audit: {
        action: 'automod.link_domain_removed',
        subjectType: 'mod_rule',
        subjectId: args.ruleId,
        after: { domain: args.domain, removed },
      },
    };
  },
});
