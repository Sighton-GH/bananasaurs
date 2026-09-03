import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { parseGuildId, parseMatchTrace, type MatchTrace } from '@bananasaurs/core';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { traceJson } from './wiring.js';

/**
 * `traceJson` (IMPORTANT-3, coordinator ruling).
 *
 * PR-7's plan ruling justified `listUnreviewedMatches`'s `trace IS NOT NULL`
 * filter by saying only pre-Slice-2 rows can lack a trace. That was false:
 * before this fix, a predicate that produced a trace its own schema rejected
 * made `traceJson` return `undefined`, and the case event was written with
 * no trace at all — silently and permanently excluding that match from
 * `automod review`, in exactly the class of case ("a predicate with a bug in
 * its trace construction") most likely to also be getting its matching
 * wrong. These tests prove the replacement: `traceJson` never returns
 * anything other than a string a validator accepts.
 */

const GUILD = parseGuildId('111111111111111111');
const logger = pino({ level: 'silent' });

describe('traceJson', () => {
  it('serialises a valid trace unchanged', () => {
    const t = openMigratedTestDatabase();
    const scope = t.scopes.forGuild(GUILD);
    const trace: MatchTrace = {
      kind: 'keyword_filter',
      matchedOn: 'badword',
      span: [0, 7],
      normalisations: [],
      detail: { categoryId: 'profanity' },
    };

    const json = traceJson(scope, logger, trace);

    expect(parseMatchTrace(json)).toEqual({ ok: true, trace });
    t.close();
  });

  it('writes a valid placeholder trace, never undefined, when the predicate’s own trace fails validation', () => {
    // A `detail` string past `trace.ts`'s 120-character bound (IMPORTANT-2)
    // is exactly the shape of bug this guards against: type-correct as a
    // `MatchTrace`, but rejected by `matchTraceSchema` at the point
    // `serialiseTrace` tries to write it.
    const t = openMigratedTestDatabase();
    const scope = t.scopes.forGuild(GUILD);
    const invalid: MatchTrace = {
      kind: 'keyword_filter',
      matchedOn: 'badword',
      span: undefined,
      normalisations: [],
      detail: { message: 'x'.repeat(200) },
    };

    const json = traceJson(scope, logger, invalid);

    // The whole point: this is a string, not undefined, and it is itself a
    // trace the same validator accepts — so the match stays reviewable.
    const parsed = parseMatchTrace(json);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.trace.kind).toBe('keyword_filter');
    expect(parsed.ok && parsed.trace.matchedOn).toContain('invalid trace');
    expect(parsed.ok && parsed.trace.span).toBeUndefined();
    expect(parsed.ok && typeof parsed.trace.detail.traceError).toBe('string');
    t.close();
  });

  it('truncates a long failure reason so the placeholder cannot itself fail the detail bound', () => {
    const t = openMigratedTestDatabase();
    const scope = t.scopes.forGuild(GUILD);
    // A pathologically long `matchedOn` produces a zod error message that is
    // itself well past 120 characters (it echoes the received value). The
    // placeholder must survive this rather than throwing a second time.
    const invalid: MatchTrace = {
      kind: 'keyword_filter',
      matchedOn: 'y'.repeat(500),
      span: undefined,
      normalisations: [],
      detail: { message: 'x'.repeat(500) },
    };

    const json = traceJson(scope, logger, invalid);

    const parsed = parseMatchTrace(json);
    expect(parsed.ok).toBe(true);
    t.close();
  });
});
