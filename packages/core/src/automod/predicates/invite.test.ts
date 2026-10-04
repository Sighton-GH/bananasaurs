import { describe, expect, it } from 'vitest';
import { compileRule } from './registry.js';
import type { AutomodRule, CompiledPredicate, PredicateInput } from './types.js';

/**
 * Compiles an `invite` rule, failing the test loudly if it does not compile.
 * A compile failure is never the thing under test in this file.
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

describe('the invite predicate', () => {
  const rule = (allowlist: { code: string; label: string }[] = []): AutomodRule => ({
    ruleId: 'r1',
    kind: 'invite',
    config: '{}',
    terms: [],
    allowlist: [],
    inviteAllowlist: allowlist,
    linkDomains: [],
    countsAsViolation: true,
  });

  it.each([
    ['discord.gg/abc123', 'abc123'],
    ['https://discord.gg/abc123', 'abc123'],
    ['http://www.discord.gg/abc123', 'abc123'],
    ['https://discord.com/invite/abc123', 'abc123'],
    ['https://discordapp.com/invite/abc123', 'abc123'],
    ['https://discord.com/invite/a-vanity-name', 'a-vanity-name'],
  ])('detects %s', (text, code) => {
    const match = compile(rule()).evaluate(message(`join us at ${text} today`));
    expect(match?.snippet).toContain(code);
  });

  it('does not fire on an allowlisted code', () => {
    const match = compile(rule([{ code: 'clubhouse', label: 'our own server' }])).evaluate(
      message('come to discord.gg/clubhouse'),
    );
    expect(match).toBeUndefined();
  });

  it('fires on the one code that is not allowlisted', () => {
    // The ambiguity: two invites in one message, one allowlisted. An
    // implementation that checked only the first invite, or that allowlisted
    // the whole message when any code matched, goes red here. A
    // single-invite fixture could not tell those apart.
    const match = compile(rule([{ code: 'clubhouse', label: 'our own server' }])).evaluate(
      message('ours is discord.gg/clubhouse but also try discord.gg/spamserver'),
    );
    expect(match?.trace.matchedOn).toBe('spamserver');
  });

  it('matches an allowlisted code case-insensitively', () => {
    expect(
      compile(rule([{ code: 'ClubHouse', label: 'ours' }])).evaluate(
        message('discord.gg/clubhouse'),
      ),
    ).toBeUndefined();
  });

  it('does not fire on ordinary text mentioning discord', () => {
    expect(compile(rule()).evaluate(message('we use discord for meetings'))).toBeUndefined();
  });

  it('reports how many codes were allowlisted, so a reviewer can see the list worked', () => {
    const match = compile(rule([{ code: 'clubhouse', label: 'ours' }])).evaluate(
      message('discord.gg/clubhouse and discord.gg/other'),
    );
    expect(match?.trace.detail.allowlistSize).toBe(1);
  });
});
