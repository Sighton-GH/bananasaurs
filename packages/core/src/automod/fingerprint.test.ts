import { describe, expect, it } from 'vitest';
import { ruleFingerprint } from './fingerprint.js';
import type { AutomodRule } from './predicates/types.js';

const rule = (over: Partial<AutomodRule> = {}): AutomodRule => ({
  ruleId: 'r1',
  kind: 'keyword_filter',
  config: '{}',
  terms: [{ text: 'badword', categoryId: 'slurs' }],
  allowlist: ['fine phrase'],
  inviteAllowlist: [],
  linkDomains: [],
  countsAsViolation: true,
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
    // The digest is built by iterating the rule's own keys, not by
    // hand-listing them, precisely so a field a later slice adds is hashed
    // without anyone having to remember to add it here.
    //
    // This test used to demonstrate that with `inviteAllowlist` as the
    // example field, because at the time `AutomodRule` did not have it yet —
    // ADR 0040 §3 had only committed a later slice to adding it. Task 6 has
    // since landed `inviteAllowlist` and `linkDomains` on `AutomodRule` for
    // real (see the "an invite allowlist edit changes the fingerprint" test
    // above, which is the obligation this slice actually carries), so that
    // field name no longer demonstrates "a field the digest was not taught
    // about" — it demonstrates a field it now knows by name. A genuinely
    // unnamed field is used here instead, hence the cast.
    const withExtraField = {
      ...rule(),
      aFieldNoVersionOfAutomodRuleHasEverNamed: ['discord.gg/legit'],
    } as AutomodRule;
    expect(ruleFingerprint(withExtraField)).not.toBe(ruleFingerprint(rule()));
  });

  it('does not hash ruleId', () => {
    // Already in the subscriber's cache key; hashing it too would be
    // redundant rather than wrong, but the exclusion is deliberate and this
    // pins it.
    expect(ruleFingerprint(rule({ ruleId: 'a-different-rule-id' }))).toBe(ruleFingerprint(rule()));
  });

  // ── Obligation 2 of the slices 3-5 handoff ──────────────────────────────
  // The digest is exclusion-based, so this should hold without anyone
  // editing fingerprint.ts — but "should" is what ADR 0039 was about. If this
  // ever goes green with the field excluded, an operator adding a partner
  // code sees the rule keep firing on it until the daemon restarts.

  it('an invite allowlist edit changes the fingerprint', () => {
    const base = rule({ inviteAllowlist: [{ code: 'clubhouse', label: 'our server' }] });
    const edited = rule({
      inviteAllowlist: [
        { code: 'clubhouse', label: 'our server' },
        { code: 'sisterclub', label: 'sister club, added 2026-09' },
      ],
    });
    expect(ruleFingerprint(edited)).not.toBe(ruleFingerprint(base));
  });

  it('a label edit changes the fingerprint too', () => {
    // The label does not change matching, so this over-invalidates by one
    // recompile. That asymmetry is deliberate: over-invalidation costs a
    // recompile and fails loudly, under-invalidation costs correctness and
    // fails silently.
    expect(ruleFingerprint(rule({ inviteAllowlist: [{ code: 'x', label: 'before' }] }))).not.toBe(
      ruleFingerprint(rule({ inviteAllowlist: [{ code: 'x', label: 'after' }] })),
    );
  });

  it('the order rows come back in does not change the fingerprint', () => {
    // Row order is the query planner's business, not a rule change — the same
    // reason `terms` and `allowlist` are sorted before hashing.
    const a = rule({
      linkDomains: [
        { domain: 'example.com', listType: 'deny' },
        { domain: 'club.org', listType: 'allow' },
      ],
    });
    const b = rule({
      linkDomains: [
        { domain: 'club.org', listType: 'allow' },
        { domain: 'example.com', listType: 'deny' },
      ],
    });
    expect(ruleFingerprint(a)).toBe(ruleFingerprint(b));
  });

  it('a domain moving from allow to deny changes the fingerprint', () => {
    // The ambiguity a sort-only test would miss: same domain, same position,
    // opposite meaning. An implementation that canonicalised to the domain
    // list alone and dropped listType would pass the previous test and fail
    // this one.
    expect(
      ruleFingerprint(rule({ linkDomains: [{ domain: 'example.com', listType: 'allow' }] })),
    ).not.toBe(
      ruleFingerprint(rule({ linkDomains: [{ domain: 'example.com', listType: 'deny' }] })),
    );
  });
});
