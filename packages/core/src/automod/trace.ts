import { z } from 'zod';
import { RULE_KINDS, type MatchTrace } from './predicates/types.js';

/**
 * The stored form of a `MatchTrace` (ADR 0041 §4), and how to read it back
 * safely.
 *
 * `mod_case_events.trace` is JSON text this process wrote, and that does not
 * make it trusted (CLAUDE.md rule 3): a row written by an older schema
 * version, or edited by hand in `sqlite3`, arrives here looking exactly like
 * one this build produced. So it meets a validator, not a cast — the same
 * treatment `mod_rules.config` gets in ADR 0040 and `jobs.payload` gets in
 * ADR 0037.
 *
 * Storage never validates it, because storage may not import `core`
 * (ADR 0014). The column comes back as raw text and this module is the only
 * place that turns it into a `MatchTrace`.
 */

/**
 * `.strict()` throughout, deliberately.
 *
 * A trace carrying a field nothing declares was written by code that
 * disagrees with this schema, and the review screen would render it as if it
 * were understood. The specific failure worth being loud about: a predicate
 * that put the whole message into its trace. ADR 0041 §4 says the trace
 * never carries whole-message content — whole messages live in
 * `automod_fixtures` under the owner's explicit privacy decision — and a
 * strict schema is what makes that a rule rather than a hope.
 */
export const matchTraceSchema = z
  .object({
    kind: z.enum(RULE_KINDS),
    matchedOn: z.string(),
    /**
     * Half-open `[start, end)` into the zero-width-stripped content — the
     * same string `automod_fixtures.content` holds, which is why a fixture
     * can be replayed against a stored span at all.
     *
     * `.optional()` rather than `.nullable()`: `JSON.stringify` drops an
     * `undefined` property rather than writing `null`, so absent is the
     * shape this actually has to accept.
     */
    span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
    normalisations: z.array(z.string()),
    detail: z.record(z.union([z.string(), z.number(), z.boolean()])),
  })
  .strict();

export type StoredMatchTrace = z.infer<typeof matchTraceSchema>;

/**
 * Validates on the way *in* as well as on the way out (ADR 0040 §2's
 * pattern).
 *
 * Throws, unlike `parseMatchTrace` — the asymmetry is intentional. A trace
 * that fails here was built by a predicate in this build, so it is a bug in
 * our own code and should stop the write loudly. A trace that fails on read
 * is a data problem and must not take the process down.
 */
export const serialiseTrace = (trace: MatchTrace): string =>
  JSON.stringify(matchTraceSchema.parse(trace));

export type ParseTraceResult =
  | { readonly ok: true; readonly trace: MatchTrace }
  | { readonly ok: false; readonly detail: string };

/**
 * Reads a stored trace. Never throws.
 *
 * A malformed trace must not stop a reviewer seeing the rest of a match's
 * record — it is one field of evidence, not the record itself — so the
 * caller gets a reason it can render in place of the trace.
 */
export const parseMatchTrace = (json: string): ParseTraceResult => {
  try {
    const parsed = matchTraceSchema.parse(JSON.parse(json));
    return {
      ok: true,
      // Rebuilt field by field rather than spread: `exactOptionalPropertyTypes`
      // distinguishes an absent `span` from one set to `undefined`, and
      // `MatchTrace` declares the property as present-and-possibly-undefined.
      trace: {
        kind: parsed.kind,
        matchedOn: parsed.matchedOn,
        span: parsed.span ?? undefined,
        normalisations: parsed.normalisations,
        detail: parsed.detail,
      },
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
};

/** How much of the message to show either side of the match. */
const EXCERPT_WINDOW = 60;

/**
 * A trace, as a human reads it (ADR 0041, and the spec's "human-readable
 * match traces").
 *
 * `content` is optional because the two callers have different evidence to
 * hand: the review listing has the fixture's whole message and should show
 * the match in place, while a context without the message still renders
 * everything else. When content *is* given, the span is checked against it
 * rather than trusted — a stored span was computed against the content as it
 * was when the match happened, and `String.prototype.slice` silently clamps
 * an out-of-range index, which would draw a highlight around text that is
 * not the match.
 */
export const renderTrace = (trace: MatchTrace, content?: string): string => {
  const lines = [
    `predicate       ${trace.kind}`,
    `matched on      ${trace.matchedOn}`,
    `normalisations  ${trace.normalisations.length === 0 ? '(none)' : trace.normalisations.join(' -> ')}`,
  ];

  if (trace.span !== undefined) {
    const [start, end] = trace.span;
    lines.push(`span            ${String(start)}..${String(end)} (half-open)`);
    if (content !== undefined) {
      if (end > content.length || start > end) {
        lines.push(
          'excerpt         (span does not fit this message; the rule or the message changed)',
        );
      } else {
        const before = content.slice(Math.max(0, start - EXCERPT_WINDOW), start);
        const matched = content.slice(start, end);
        const after = content.slice(end, end + EXCERPT_WINDOW);
        const lead = start - EXCERPT_WINDOW > 0 ? '...' : '';
        const tail = end + EXCERPT_WINDOW < content.length ? '...' : '';
        lines.push(`excerpt         ${lead}${before}[${matched}]${after}${tail}`);
      }
    }
  }

  for (const [key, value] of Object.entries(trace.detail)) {
    lines.push(`${key.padEnd(16)}${String(value)}`);
  }

  return lines.join('\n');
};
