import { z } from 'zod';
import { stripZeroWidth } from '../../automod/matcher.js';
import { renderTrace } from '../../automod/trace.js';
import { runDryRun, type DryRunReport } from '../../automod/dry-run.js';
import { defineCommand, type OpsCommandResult, type OpsContext } from '../dispatch.js';
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
        text: `there is no rule ${args.ruleId} in this guild`,
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

    const lines = [
      `${report.matched}/${report.total} matched · ${report.falsePositives} false ` +
        `positive(s) · ${report.falseNegatives} missed`,
    ];

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
