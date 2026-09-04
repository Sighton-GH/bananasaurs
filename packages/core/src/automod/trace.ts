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
 * `.strict()` throughout, and `detail`'s string values are bounded.
 *
 * These are two different guards for two different things, and the
 * distinction matters (IMPORTANT-2). `.strict()` closes the *top-level*
 * object: a trace carrying a field nothing declares was written by code that
 * disagrees with this schema, and it stops a new top-level field appearing
 * unnoticed. It does **not** bound `detail`, which is an open record — before
 * the `.max(120)` below, `detail: { message: input.content }` serialised,
 * stored and parsed cleanly, because nothing checked the *length* of a
 * `detail` value. `.strict()` alone was never the guard that kept
 * whole-message content out.
 *
 * ADR 0041 §4 says the trace never carries whole-message content — whole
 * messages live in `automod_fixtures` under the owner's explicit privacy
 * decision — and `detail`'s `.max(120)` is what makes that a rule rather than
 * a hope **for `detail`**: 120 characters is more than any predicate-specific
 * scalar needs, and well short of a message.
 *
 * **`matchedOn` is deliberately unbounded, and that is a producer's
 * responsibility rather than this schema's** (re-review of Slices 3+5, which
 * found this comment claiming more coverage than it has). A blanket
 * `.max()` here cannot work: `regex`'s `matchedOn` is the operator's
 * configured pattern, which `regexConfig` permits up to 1000 characters, and
 * truncating it would hand Slice 9's one-click suppression a pattern that is
 * not the rule's.
 *
 * What keeps `matchedOn` honest is that every predicate puts *the configured
 * thing that matched* there, never message text — a term, a pattern, a
 * threshold, a domain, an extension — and for the two predicates whose value
 * is derived from member input (`attachment_type`, `link_domain`) the derived
 * value is only ever reached by **set membership against configured
 * entries**, so it is bounded by whatever the config schema allows and a
 * member cannot lengthen it. A predicate that wanted to put matched *text* in
 * `matchedOn` would be violating ADR 0041 §4 directly, and no length cap
 * would save it; `attachment-type.test.ts` pins that reasoning with a test.
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
    detail: z.record(z.union([z.string().max(120), z.number(), z.boolean()])),
  })
  .strict();

export type StoredMatchTrace = z.infer<typeof matchTraceSchema>;

/**
 * `detail`'s per-value cap, exported so a predicate carrying member-controlled
 * text (a filename, a hostname) can truncate deliberately at the point of
 * construction, rather than relying on `serialiseTrace`'s truncation below to
 * salvage it after the fact (IMPORTANT-3).
 */
export const MAX_DETAIL_STRING_LENGTH = 120;
const DETAIL_ELLIPSIS = '…';

/** Truncates a `detail` string to fit `matchTraceSchema`'s `.max(120)`, with a trailing ellipsis. */
export const truncateDetailString = (value: string): string =>
  value.length <= MAX_DETAIL_STRING_LENGTH
    ? value
    : value.slice(0, MAX_DETAIL_STRING_LENGTH - DETAIL_ELLIPSIS.length) + DETAIL_ELLIPSIS;

/**
 * Validates on the way *in* as well as on the way out (ADR 0040 §2's
 * pattern).
 *
 * Throws, unlike `parseMatchTrace` — the asymmetry is intentional, but
 * narrower than it used to be (IMPORTANT-3). A trace built by a predicate in
 * this build can still be malformed in a way that is genuinely a bug in our
 * own code — an unknown `kind`, a `detail` value that is not a scalar — and
 * that must still stop the write loudly. But `detail`'s length cap exists to
 * keep whole-message content out of the trace, not to punish a predicate that
 * legitimately carries member-controlled text: a 255-character filename or a
 * 253-character hostname is not a bug, and throwing on it produced a
 * placeholder trace — `matchedOn` replaced by
 * `'(the predicate produced an invalid trace)'` — for every such match, on
 * every predicate that carries member text, forever. So an over-long
 * `detail` *string* is truncated here rather than rejected; every other
 * violation still throws.
 */
export const serialiseTrace = (trace: MatchTrace): string => {
  const detail = Object.fromEntries(
    Object.entries(trace.detail).map(([key, value]) => [
      key,
      typeof value === 'string' ? truncateDetailString(value) : value,
    ]),
  );
  return JSON.stringify(matchTraceSchema.parse({ ...trace, detail }));
};

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
