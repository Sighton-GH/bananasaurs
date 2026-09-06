import { describe, expect, it } from 'vitest';
import {
  compileRule,
  compileRuleWith,
  predicateFor,
  validateRuleConfig,
  validateRuleConfigWith,
} from './registry.js';
import type { AutomodRule } from './types.js';

const rule = (over: Partial<AutomodRule> = {}): AutomodRule => ({
  ruleId: 'r1',
  kind: 'keyword_filter',
  mode: 'enforce',
  config: '{}',
  terms: [{ text: 'badword', categoryId: 'slurs' }],
  allowlist: [],
  inviteAllowlist: [],
  linkDomains: [],
  countsAsViolation: true,
  ...over,
});

describe('predicateFor', () => {
  it('finds the keyword_filter predicate', () => {
    expect(predicateFor('keyword_filter')?.kind).toBe('keyword_filter');
  });

  it('returns undefined for a string that is not a real RuleKind at all', () => {
    // After Slice 4, all ten kinds `mod_rules_kind` permits have a predicate
    // in `PREDICATES` — there is no real, permitted `RuleKind` left to stand
    // in for "not shipped yet" (obligation 3, Task 5a). This test used to
    // borrow one (first 'caps', then 'mention_spam', then 'rapid_spam') and
    // was repointed three times as each shipped. `predicateFor`'s only
    // remaining `undefined` case is `isRuleKind` failing outright, which
    // `compileRuleWith`/`validateRuleConfigWith` below cover for the
    // "permitted but unregistered" case via an explicit empty registry —
    // `predicateFor` itself has no injectable form, because nothing calls it
    // needing one.
    expect(predicateFor('telepathy')).toBeUndefined();
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
    // Against an explicitly empty registry (Task 5a's seam), not a real kind
    // that happens to be unshipped today — see `resolveConfigWith`'s doc
    // comment in registry.ts for why: after this slice, no permitted kind is
    // unregistered in production, so this test would otherwise have nothing
    // left to borrow.
    const result = compileRuleWith({}, rule({ kind: 'rapid_spam', terms: [], config: '{}' }));
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
    // Same seam as the `compileRuleWith` test above, for the same reason.
    const result = validateRuleConfigWith({}, 'rapid_spam', '{}');
    expect(result).toEqual({ ok: false, reason: 'no-predicate', detail: 'rapid_spam' });
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
