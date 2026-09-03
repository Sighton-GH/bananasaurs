import { describe, expect, it } from 'vitest';
import { parseMatchTrace, renderTrace, serialiseTrace } from './trace.js';
import type { MatchTrace } from './predicates/types.js';

const TRACE: MatchTrace = {
  kind: 'keyword_filter',
  matchedOn: 'badword',
  span: [6, 13],
  normalisations: ['zero-width stripped', 'lowercased'],
  detail: { categoryId: 'profanity', termCount: 14, allowlisted: false },
};

describe('serialiseTrace / parseMatchTrace', () => {
  it('round-trips a trace', () => {
    const result = parseMatchTrace(serialiseTrace(TRACE));
    expect(result).toEqual({ ok: true, trace: TRACE });
  });

  it('round-trips a trace with no span', () => {
    const spanless: MatchTrace = { ...TRACE, span: undefined };
    const result = parseMatchTrace(serialiseTrace(spanless));
    expect(result.ok).toBe(true);
    // `JSON.stringify` drops an `undefined` property entirely, so the parser
    // has to put the key back rather than leaving it missing — otherwise a
    // `MatchTrace` fails `exactOptionalPropertyTypes` on the way out.
    //
    // `toBeUndefined()` alone does not prove that: it reads the same on an
    // absent key as on one explicitly set to `undefined`, which are exactly
    // the two states this test exists to tell apart. So the key's *presence*
    // is asserted first, and the value second.
    expect(result.ok && 'span' in result.trace).toBe(true);
    expect(result.ok && result.trace.span).toBeUndefined();
  });

  it('refuses a trace whose kind is not a rule kind', () => {
    const result = parseMatchTrace(
      '{"kind":"telepathy","matchedOn":"x","normalisations":[],"detail":{}}',
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a trace with an unexpected extra field', () => {
    // `.strict()`, not a bare object: a trace carrying a field nothing
    // declares is a trace written by code that disagrees with this schema,
    // and the review screen would render it as if it were understood.
    const result = parseMatchTrace(
      '{"kind":"keyword_filter","matchedOn":"x","normalisations":[],"detail":{},"messageContent":"the whole message"}',
    );
    expect(result.ok).toBe(false);
  });

  it('refuses text that is not JSON at all, without throwing', () => {
    const result = parseMatchTrace('not json');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail.length).toBeGreaterThan(0);
  });

  it('refuses a detail value that is not a scalar', () => {
    const result = parseMatchTrace(
      '{"kind":"keyword_filter","matchedOn":"x","normalisations":[],"detail":{"nested":{"a":1}}}',
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a detail string long enough to smuggle whole-message content', () => {
    // IMPORTANT-2: `.strict()` only closes the top-level object. `detail` was
    // an open record accepting any string of any length, so a predicate
    // writing `detail: { message: input.content }` serialised, stored, and
    // parsed cleanly — putting whole member message text into
    // `mod_case_events.trace`, a column whose own comment says it never
    // holds that. A bound on `detail`'s string values is what actually keeps
    // content out; `.strict()` alone does not.
    const smuggled = {
      ...TRACE,
      detail: {
        message:
          'hey everyone here is my whole private message, all of it, ' +
          'padded well past a hundred and twenty characters so this can only ' +
          'be a smuggled whole message rather than a short predicate scalar',
      },
    };
    const result = parseMatchTrace(JSON.stringify(smuggled));
    expect(result.ok).toBe(false);
  });

  it('refuses to serialise a trace that would not parse back', () => {
    const broken = { ...TRACE, kind: 'telepathy' } as unknown as MatchTrace;
    expect(() => serialiseTrace(broken)).toThrow();
  });
});

describe('renderTrace', () => {
  it('names the predicate, what matched, and the normalisations that ran', () => {
    const text = renderTrace(TRACE);
    expect(text).toContain('keyword_filter');
    expect(text).toContain('badword');
    expect(text).toContain('zero-width stripped');
    expect(text).toContain('categoryId');
    expect(text).toContain('profanity');
  });

  it('marks the matched span inside the message when given the content', () => {
    const text = renderTrace(TRACE, 'hello badword everyone');
    expect(text).toContain('hello [badword] everyone');
  });

  it('says so rather than lying when the span does not fit the content', () => {
    // A stored trace is untrusted: its span was computed against the content
    // as it was two weeks ago, and the caller may hand over a different
    // string. Rendering `slice()`'s silent clamp as if it were the match
    // would show a reviewer a highlighted region that is not the match.
    const text = renderTrace(TRACE, 'hi');
    expect(text).not.toContain('[');
    expect(text).toContain('span does not fit');
  });

  it('renders a spanless trace without a message excerpt', () => {
    const text = renderTrace({ ...TRACE, span: undefined }, 'hello badword everyone');
    expect(text).not.toContain('[badword]');
  });

  it('marks a match at the very start and end of the message', () => {
    // The excerpt window's arithmetic (`start - WINDOW`, `end + WINDOW`) is
    // where an off-by-one would live, and every other test sits comfortably
    // inside the message. A truncated highlight is not a cosmetic bug here:
    // the excerpt is the evidence a reviewer judges a false positive from,
    // and one that clips the match shows them the wrong text.
    const atStart = renderTrace({ ...TRACE, matchedOn: 'bad', span: [0, 3] }, 'bad start');
    expect(atStart).toContain('[bad] start');

    const atEnd = renderTrace({ ...TRACE, matchedOn: 'end', span: [7, 10] }, 'at the end');
    expect(atEnd).toContain('at the [end]');
  });

  it('does not add ellipses when the whole message already fits', () => {
    const text = renderTrace(TRACE, 'hello badword everyone');
    expect(text).toContain('excerpt         hello [badword] everyone');
    expect(text).not.toContain('...');
  });

  it('elides with ellipses only on the side that is actually cut', () => {
    // 80 characters before the match, nothing after it: the lead is elided,
    // the tail is not. A renderer that printed both would tell a reviewer
    // there is more message to see when there is not.
    const lead = 'x'.repeat(80);
    const content = `${lead}badword`;
    const text = renderTrace({ ...TRACE, span: [80, 87] }, content);
    expect(text).toContain('...');
    expect(text).toContain('[badword]');
    expect(text.endsWith('...')).toBe(false);
  });
});
