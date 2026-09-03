import { describe, expect, it } from 'vitest';
import { ruleFingerprint } from './fingerprint.js';
import type { AutomodRule } from './predicates/types.js';

const rule = (over: Partial<AutomodRule> = {}): AutomodRule => ({
  ruleId: 'r1',
  kind: 'keyword_filter',
  mode: 'enforce',
  config: '{}',
  terms: [{ text: 'badword', categoryId: 'slurs' }],
  allowlist: ['fine phrase'],
  ...over,
});

describe('ruleFingerprint', () => {
  it('is stable for an unchanged rule', () => {
    expect(ruleFingerprint(rule())).toBe(ruleFingerprint(rule()));
  });

  it('ignores the order terms and allowlist entries arrive in', () => {
    // `hydrate` queries per category, so term order tracks category order,
    // which no caller controls. An order change is not a rule change and must
    // not force a recompile.
    const a = rule({
      terms: [
        { text: 'a', categoryId: 'c1' },
        { text: 'b', categoryId: 'c2' },
      ],
    });
    const b = rule({
      terms: [
        { text: 'b', categoryId: 'c2' },
        { text: 'a', categoryId: 'c1' },
      ],
    });
    expect(ruleFingerprint(a)).toBe(ruleFingerprint(b));
  });

  it('changes when a term is added', () => {
    const more = rule({
      terms: [
        { text: 'badword', categoryId: 'slurs' },
        { text: 'spammer', categoryId: 'spam' },
      ],
    });
    expect(ruleFingerprint(more)).not.toBe(ruleFingerprint(rule()));
  });

  it('changes when a term is removed', () => {
    expect(ruleFingerprint(rule({ terms: [] }))).not.toBe(ruleFingerprint(rule()));
  });

  it('changes when a term moves category', () => {
    const moved = rule({ terms: [{ text: 'badword', categoryId: 'other' }] });
    expect(ruleFingerprint(moved)).not.toBe(ruleFingerprint(rule()));
  });

  it('changes when the allowlist changes', () => {
    expect(ruleFingerprint(rule({ allowlist: [] }))).not.toBe(ruleFingerprint(rule()));
  });

  it('changes when the config changes', () => {
    expect(ruleFingerprint(rule({ config: '{"ratio":0.5}' }))).not.toBe(ruleFingerprint(rule()));
  });

  it('changes when the kind changes', () => {
    expect(ruleFingerprint(rule({ kind: 'caps' }))).not.toBe(ruleFingerprint(rule()));
  });

  it('does NOT change when only the mode changes', () => {
    // Mode decides what the subscriber *does* with a match, not what the
    // predicate matches. A mode flip must not throw away a compiled matcher —
    // flip day flips every rule at once, and rebuilding every matcher in the
    // guild at that moment is exactly the wrong time to do it.
    expect(ruleFingerprint(rule({ mode: 'observe' }))).toBe(ruleFingerprint(rule()));
  });

  it('cannot be confused by a separator appearing inside a term', () => {
    // The failure a naive `join(' ')` has: two different rules hashing to
    // the same digest because a term contains the separator. docs/22 records a
    // test that could not detect what it guarded; this one can.
    const a = rule({
      terms: [
        { text: 'ab', categoryId: 'c' },
        { text: 'cd', categoryId: 'c' },
      ],
    });
    const b = rule({ terms: [{ text: 'ab cd', categoryId: 'c' }] });
    expect(ruleFingerprint(a)).not.toBe(ruleFingerprint(b));
  });

  it('is a 64-character lowercase hex digest', () => {
    expect(ruleFingerprint(rule())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a field is added to the rule that the digest does not name', () => {
    // The digest is built by iterating the rule's own keys, not by hand-listing
    // them, precisely so a field a later slice adds — ADR 0040 §3's relational
    // `invite`/`link_domain` allowlist — is hashed without anyone having to
    // remember to add it here. `AutomodRule`'s type does not have this field
    // yet, hence the cast: the point is what `ruleFingerprint` does at
    // runtime with a rule shape it has not been specifically taught about.
    const withExtraField = {
      ...rule(),
      inviteAllowlist: ['discord.gg/legit'],
    } as AutomodRule;
    expect(ruleFingerprint(withExtraField)).not.toBe(ruleFingerprint(rule()));
  });

  it('does not hash ruleId', () => {
    // Already in the subscriber's cache key; hashing it too would be
    // redundant rather than wrong, but the exclusion is deliberate and this
    // pins it the same way the `mode` exclusion above is pinned.
    expect(ruleFingerprint(rule({ ruleId: 'a-different-rule-id' }))).toBe(ruleFingerprint(rule()));
  });
});
