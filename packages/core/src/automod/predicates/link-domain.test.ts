import { describe, expect, it } from 'vitest';
import { compileRule } from './registry.js';
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
    mode: 'test' as const,
    config: '{"mode":"deny"}',
    terms: [],
    allowlist: [],
    inviteAllowlist: [],
    linkDomains: domains,
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
