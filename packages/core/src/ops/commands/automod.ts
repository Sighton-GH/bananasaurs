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

/** `DryRunReport`, projected to plain `JsonValue` — no readonly arrays, no `undefined`. */
const projectReport = (report: DryRunReport): JsonValue => ({
  ruleId: report.ruleId,
  kind: report.kind,
  usable: report.usable,
  failure:
    report.failure === undefined
      ? null
      : { reason: report.failure.reason, detail: report.failure.detail },
  total: report.total,
  matched: report.matched,
  falsePositives: report.falsePositives,
  falseNegatives: report.falseNegatives,
  // CRITICAL-1: the denominator behind `falsePositives`/`falseNegatives`
  // belongs beside them in `data`, not only worked out from `results` by
  // whoever reads it — see the summary line below for the reasoning.
  unlabelled: unlabelledCount(report),
  results: report.results.map((result) => ({
    fixtureId: result.fixtureId,
    label: result.label,
    matched: result.matched,
    agreement: result.agreement,
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
    const data = projectReport(report);

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

    const byFixtureId = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));

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
 *   PR-2, ADR 0041's consequences, `docs/LEDGER_RELEASE2_SLICES_1_6.md`
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
