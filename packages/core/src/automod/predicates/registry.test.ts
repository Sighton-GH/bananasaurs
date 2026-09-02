import { describe, expect, it } from 'vitest';
import { compileRule, predicateFor, validateRuleConfig } from './registry.js';
import type { AutomodRule } from './types.js';

const rule = (over: Partial<AutomodRule> = {}): AutomodRule => ({
  ruleId: 'r1',
  kind: 'keyword_filter',
  mode: 'enforce',
  config: '{}',
  terms: [{ text: 'badword', categoryId: 'slurs' }],
  allowlist: [],
  ...over,
});

describe('predicateFor', () => {
  it('finds the keyword_filter predicate', () => {
    expect(predicateFor('keyword_filter')?.kind).toBe('keyword_filter');
  });

  it('returns undefined for a kind whose predicate has not shipped yet', () => {
    // The `kind` CHECK permits ten values from Slice 1; nine of them have no
    // predicate until Slices 3-5. That gap is handled, not prevented.
    expect(predicateFor('caps')).toBeUndefined();
  });
});

describe('compileRule', () => {
  it('compiles a valid rule', () => {
    const result = compileRule(rule());
    expect(result.ok).toBe(true);
  });

  it('reports an unknown kind rather than throwing', () => {
    const result = compileRule(rule({ kind: 'telepathy' }));
    expect(result).toEqual({ ok: false, reason: 'unknown-kind', detail: 'telepathy' });
  });

  it('reports a kind with no predicate registered yet', () => {
    const result = compileRule(rule({ kind: 'caps', terms: [], config: '{}' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-predicate');
  });

  it('reports malformed JSON rather than throwing', () => {
    const result = compileRule(rule({ config: '{not json' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-config');
  });

  it('reports a config that fails its kind’s schema', () => {
    const result = compileRule(rule({ config: '{"ratio":0.7}' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-config');
      // The operator has to be able to see *what* was wrong, not just that
      // something was. ADR 0040 §4: inert and loud.
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it('reports a keyword_filter rule with zero enabled terms rather than compiling it as a matcher that can never fire', () => {
    // `buildMatcher([], [])` compiles cleanly — this is not `compile-failed`.
    // An operator who deletes the last term, or disables the last category,
    // is left with a rule that looks configured and silently never matches:
    // exactly the ADR 0039 shape this ADR exists to keep out of `doctor`.
    const result = compileRule(rule({ terms: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no-terms');
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it('reports a predicate whose compile step throws', () => {
    // A word list obscenity cannot parse. An empty term does NOT actually
    // throw — verified directly against `parseRawPattern` before writing
    // this test (an empty pattern parses to zero nodes). An unclosed `[`
    // does: `node_modules/obscenity/dist/pattern/Parser.js`'s `parseOptional`
    // calls `reportError("Unexpected unclosed '['.")` when the input ends
    // before a matching `]`, which is exactly what a single `[` produces.
    const result = compileRule(rule({ terms: [{ text: '[', categoryId: 'c' }] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('compile-failed');
  });
});

describe('validateRuleConfig', () => {
  // The write-side half of ADR 0040 §2's "validated on write and on read":
  // storage cannot validate (ADR 0014 keeps the per-kind Zod schemas in
  // core), so a writer of mod_rules.config — createRule, setRuleConfig —
  // must call this first. It deliberately checks only kind + config, not the
  // word list `compileRule`'s 'no-terms' case reads, because a config write
  // does not touch word_terms.

  it('accepts a valid config for a registered kind', () => {
    expect(validateRuleConfig('keyword_filter', '{}')).toEqual({ ok: true });
  });

  it('reports an unknown kind rather than throwing', () => {
    expect(validateRuleConfig('telepathy', '{}')).toEqual({
      ok: false,
      reason: 'unknown-kind',
      detail: 'telepathy',
    });
  });

  it('reports a permitted kind with no predicate registered yet', () => {
    const result = validateRuleConfig('caps', '{}');
    expect(result).toEqual({ ok: false, reason: 'no-predicate', detail: 'caps' });
  });

  it('reports malformed JSON rather than throwing', () => {
    const result = validateRuleConfig('keyword_filter', '{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-config');
  });

  it("reports a config that fails its kind's schema", () => {
    // keyword_filter's config schema is `z.object({}).strict()` — any key is
    // rejected, which is exactly the "written against the wrong kind" case
    // ADR 0040 §2 exists to catch at the boundary that created it.
    const result = validateRuleConfig('keyword_filter', '{"ratio":0.7}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-config');
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });
});
