import { describe, expect, it } from 'vitest';
import { compileRule } from './registry.js';
import { linkDomainPredicate } from './link-domain.js';
import type { AutomodRule, CompiledPredicate, PredicateInput } from './types.js';

/**
 * Compiles a `link_domain` rule, failing the test loudly if it does not
 * compile. A compile failure is never the thing under test in this file.
 */
const compile = (rule: AutomodRule): CompiledPredicate => {
  const result = compileRule(rule);
  if (!result.ok) throw new Error(`expected to compile, got ${result.reason}: ${result.detail}`);
  return result.compiled;
};

const message = (content: string): PredicateInput => ({
  guildId: '100000000000000001',
  channelId: '200000000000000001',
  messageId: '300000000000000001',
  authorId: '400000000000000001',
  eventKind: 'messageCreate',
  content,
  rawContent: content,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  atMs: 1_000,
});

describe('the link_domain predicate', () => {
  const rule = (domains: { domain: string; listType: 'allow' | 'deny' }[]): AutomodRule => ({
    ruleId: 'r1',
    kind: 'link_domain',
    config: '{"mode":"deny"}',
    terms: [],
    allowlist: [],
    inviteAllowlist: [],
    linkDomains: domains,
    countsAsViolation: true,
  });

  it('fires on a denied domain', () => {
    const match = compile(rule([{ domain: 'example.com', listType: 'deny' }])).evaluate(
      message('look at https://example.com/thing'),
    );
    expect(match?.trace.matchedOn).toBe('example.com');
  });

  it('fires on a subdomain of a denied domain', () => {
    expect(
      compile(rule([{ domain: 'example.com', listType: 'deny' }])).evaluate(
        message('https://tracking.example.com/x'),
      ),
    ).toBeDefined();
  });

  it('does not fire on a domain that merely ends with the same letters', () => {
    // The ambiguity plan ruling PR-15 turns on: 'notexample.com' ends with
    // 'example.com' as a STRING. A suffix check on raw text passes the two
    // tests above and fails this one, which is why all three are here.
    expect(
      compile(rule([{ domain: 'example.com', listType: 'deny' }])).evaluate(
        message('https://notexample.com/x'),
      ),
    ).toBeUndefined();
  });

  it('ignores port, credentials and case', () => {
    expect(
      compile(rule([{ domain: 'example.com', listType: 'deny' }])).evaluate(
        message('https://user:pw@EXAMPLE.com:8443/x'),
      ),
    ).toBeDefined();
  });

  it('in allow mode, fires on anything not on the list', () => {
    const allowOnly: AutomodRule = {
      ...rule([{ domain: 'club.org', listType: 'allow' }]),
      config: '{"mode":"allow"}',
    };
    expect(compile(allowOnly).evaluate(message('https://club.org/notes'))).toBeUndefined();
    expect(compile(allowOnly).evaluate(message('https://elsewhere.net/x'))).toBeDefined();
  });

  it('does not fire on a message with no links', () => {
    expect(
      compile(rule([{ domain: 'example.com', listType: 'deny' }])).evaluate(
        message('no links here, just talk about example.com in passing'),
      ),
    ).toBeUndefined();
  });

  it('still matches when the URL ends a sentence', () => {
    // Without trailing-punctuation stripping, `new URL` reports the hostname
    // as 'example.com.' — which equals neither 'example.com' nor '.example.com'
    // under hostMatches, so the deny list is bypassed by a full stop. A silent
    // false negative: nothing in the output would say so.
    expect(
      compile(rule([{ domain: 'example.com', listType: 'deny' }])).evaluate(
        message('blocked at https://example.com.'),
      ),
    ).toBeDefined();
  });

  it('excludes the trailing punctuation from the span', () => {
    // The span is evidence a reviewer reads against the message text, so it
    // must cover the URL and not the full stop after it.
    const content = 'blocked at https://example.com.';
    const match = compile(rule([{ domain: 'example.com', listType: 'deny' }])).evaluate(
      message(content),
    );
    expect(match?.snippet).toBe('https://example.com');
    const [start, end] = match?.trace.span ?? [0, 0];
    expect(content.slice(start, end)).toBe('https://example.com');
  });

  it('truncates a very long host in the trace detail rather than a value serialiseTrace would reject (IMPORTANT-3)', () => {
    // In `allow` mode any host matches, so a member picks the value — and
    // hostnames run to 253 characters against `detail`'s 120-character cap.
    // Node's `URL` does not enforce DNS label lengths, so this is a value a
    // real message can produce.
    const host = `${'x'.repeat(200)}.com`;
    const allowOnly: AutomodRule = {
      ...rule([{ domain: 'club.org', listType: 'allow' }]),
      config: '{"mode":"allow"}',
    };
    const match = compile(allowOnly).evaluate(message(`https://${host}/path`));
    expect(match).toBeDefined();
    const detailHost = match?.trace.detail.host;
    expect(typeof detailHost).toBe('string');
    expect((detailHost as string).length).toBeLessThanOrEqual(120);
  });

  it('refuses to compile a deny-mode rule with no deny rows, rather than a rule that silently never matches (CRITICAL-2)', () => {
    const emptyDeny: AutomodRule = { ...rule([]), config: '{"mode":"deny"}' };
    const result = compileRule(emptyDeny);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-terms');
    expect(result.detail).toContain('deny');
  });

  it('refuses to compile an allow-mode rule with no allow rows, rather than a rule that matches every link (CRITICAL-2)', () => {
    // The dangerous direction: "on neither list" is true of every link once
    // the allow list is empty, so an unguarded compile would make this rule
    // fire on everything rather than nothing.
    const emptyAllow: AutomodRule = { ...rule([]), config: '{"mode":"allow"}' };
    const result = compileRule(emptyAllow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-terms');
    expect(result.detail).toContain('allow');
  });

  it('a deny row on the other list does not satisfy the allow-mode guard', () => {
    // Rows of the *other* listType exist in the table (Task 6's schema keeps
    // both on one table) but are not what config.mode names as active, so
    // they must not count toward "this rule has something on its list".
    const mismatched: AutomodRule = {
      ...rule([{ domain: 'example.com', listType: 'deny' }]),
      config: '{"mode":"allow"}',
    };
    const result = compileRule(mismatched);
    expect(result.ok).toBe(false);
  });

  it('the predicate itself would match everything if an allow-mode rule with no rows were ever compiled — documenting the hazard compileRule now refuses (CRITICAL-2)', () => {
    // Bypasses compileRule's guard on purpose, calling the predicate's own
    // `compile` directly, to keep the hazard visible in the suite rather
    // than only in a comment: if this guard is ever removed or narrowed,
    // this is what comes back.
    const emptyAllowRule: AutomodRule = { ...rule([]), config: '{"mode":"allow"}' };
    const compiled = linkDomainPredicate.compile(emptyAllowRule, { mode: 'allow' });
    expect(compiled.evaluate(message('nothing link-shaped in sight'))).toBeUndefined();
    expect(compiled.evaluate(message('see https://anything-at-all.example/x'))).toBeDefined();
  });

  it('finds the denied link when an allowed one comes first', () => {
    // Two links, only the second denied: an implementation checking only the
    // first link goes red.
    expect(
      compile(rule([{ domain: 'bad.example', listType: 'deny' }])).evaluate(
        message('https://club.org/a and https://bad.example/b'),
      ),
    ).toBeDefined();
  });
});
