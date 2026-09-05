import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { parseGuildId, parseMatchTrace, type MatchTrace } from '@bananasaurs/core';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { automodRuleRepo, guildRepo } from '@bananasaurs/storage';
import { toAutomodRule, traceJson } from './wiring.js';

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
    // A `detail` value that is not a scalar at all is the shape of bug this
    // guards against: type-correct as a `MatchTrace` from a predicate's
    // point of view (it built the object, TypeScript did not stop it), but
    // rejected by `matchTraceSchema` at the point `serialiseTrace` tries to
    // write it. An over-long `detail` *string* used to be this file's
    // example, but `trace.ts`'s IMPORTANT-3 fix (whole-branch review,
    // Slices 3-5) narrowed `serialiseTrace` to truncate an over-long string
    // rather than throw on it — a filename or a hostname is not a bug — so
    // that shape no longer reaches this fallback at all, and a genuinely
    // malformed value is needed to exercise it.
    const t = openMigratedTestDatabase();
    const scope = t.scopes.forGuild(GUILD);
    const invalid = {
      kind: 'keyword_filter',
      matchedOn: 'badword',
      span: undefined,
      normalisations: [],
      detail: { nested: { a: 1 } },
    } as unknown as MatchTrace;

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

  it('survives a trace whose own kind is the corrupted field', () => {
    // The first version of the placeholder reused `trace.kind` verbatim. When
    // `kind` is itself what the predicate corrupted, the placeholder failed
    // validation too and `traceJson` threw uncaught — losing the case event
    // outright, which is worse than the bug the placeholder was added to fix
    // and contradicts ADR 0036. Found by the fix wave's re-review.
    const t = openMigratedTestDatabase();
    const scope = t.scopes.forGuild(GUILD);
    const invalid = {
      kind: 'not-a-rule-kind',
      matchedOn: 'badword',
      span: undefined,
      normalisations: [],
      detail: {},
    } as unknown as MatchTrace;

    const json = traceJson(scope, logger, invalid);

    const parsed = parseMatchTrace(json);
    expect(parsed.ok).toBe(true);
    // The substitution is stated rather than silent: nothing here should read
    // as a claim about which predicate ran. The reviewer identifies the rule
    // from the case event's own rule_id, which `automod review` prints.
    expect(parsed.ok && parsed.trace.matchedOn).toContain('was replaced');
    expect(parsed.ok && parsed.trace.detail.kindReplaced).toBe(true);
    t.close();
  });

  it('never quotes the rejected value into the stored trace', () => {
    // A validator's message quotes what it rejected. If the field a predicate
    // corrupted holds message content, using that message as the failure
    // reason would carry member content into `mod_case_events.trace` — the
    // table ADR 0041 §4 says never holds it — and, through `Error.message`,
    // past the Pino allowlist into the logs (CLAUDE.md rule 4).
    const secret = 'MEMBERSECRETCONTENT';
    const t = openMigratedTestDatabase();
    const scope = t.scopes.forGuild(GUILD);
    const invalid = {
      kind: secret,
      matchedOn: 'badword',
      span: undefined,
      normalisations: [],
      detail: {},
    } as unknown as MatchTrace;

    const json = traceJson(scope, logger, invalid);

    expect(json).not.toContain(secret);
    t.close();
  });
});

/**
 * `toAutomodRule` (whole-branch review, IMPORTANT-5).
 *
 * `ruleFingerprint` hashes the rule object's own *runtime* keys — by design, so
 * a field added to `AutomodRule` is covered by default. That makes handing it a
 * repository row a silent bug rather than a harmless widening: every column ADR
 * 0042 added would be hashed, and flipping `cutover_state` from `ready` to
 * `cutover` on a successful enforce — flip day itself — would recompile every
 * matcher in the guild for a change that cannot affect what any of them match.
 *
 * TypeScript could not catch it. `StoredAutomodRule` is structurally assignable
 * to `AutomodRule`, so the pass-through compiled cleanly and the boundary was an
 * accident of shape rather than a decision. This asserts the key set exactly,
 * which is the only form that fails when a future column is added to the row and
 * quietly starts being hashed.
 */
describe('toAutomodRule', () => {
  it('narrows a stored rule to exactly the fields a predicate may see', () => {
    const t = openMigratedTestDatabase();
    const scope = t.scopes.forGuild(GUILD);
    guildRepo.upsertGuild(scope, { name: 'g', now: 0 });
    automodRuleRepo.createRule(scope, {
      ruleId: 'r1',
      kind: 'caps',
      name: 'shouting',
      config: '{}',
      now: 0,
    });

    const stored = automodRuleRepo.listEnabledRules(scope)[0]!;
    const narrowed = toAutomodRule(stored);

    // Sorted, so the assertion reads as a set rather than depending on the
    // order an object literal happens to be written in.
    expect(Object.keys(narrowed).sort()).toEqual([
      'allowlist',
      'config',
      'countsAsViolation',
      'inviteAllowlist',
      'kind',
      'linkDomains',
      'mode',
      'ruleId',
      'terms',
    ]);

    // The gate's own columns are present on the row and absent from the narrowed
    // rule — the specific leak this exists to prevent.
    expect('cutoverState' in stored).toBe(true);
    expect('cutoverState' in narrowed).toBe(false);
    expect('enforceSignedOffBy' in narrowed).toBe(false);
    expect('observeStartedAt' in narrowed).toBe(false);

    t.close();
  });
});
