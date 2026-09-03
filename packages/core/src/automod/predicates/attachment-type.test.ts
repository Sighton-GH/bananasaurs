import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '../../discord/events.js';
import { compileRule } from './registry.js';
import type { AutomodRule, CompiledPredicate, PredicateInput } from './types.js';

/**
 * Compiles an `attachment_type` rule, failing the test loudly if it does not
 * compile. A compile failure is never the thing under test in this file.
 */
const compile = (config: string): CompiledPredicate => {
  const rule: AutomodRule = {
    ruleId: 'r1',
    kind: 'attachment_type',
    mode: 'test',
    config,
    terms: [],
    allowlist: [],
    inviteAllowlist: [],
    linkDomains: [],
  };
  const result = compileRule(rule);
  if (!result.ok) throw new Error(`expected to compile, got ${result.reason}: ${result.detail}`);
  return result.compiled;
};

const withAttachments = (attachments: readonly MessageAttachment[]): PredicateInput => ({
  guildId: '100000000000000001',
  channelId: '200000000000000001',
  messageId: '300000000000000001',
  authorId: '400000000000000001',
  eventKind: 'messageCreate',
  content: 'have a look at this',
  rawContent: 'have a look at this',
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments,
  atMs: 1_000,
});

describe('the attachment_type predicate', () => {
  const config =
    '{"blockedExtensions":["exe","scr"],"blockedContentTypes":["application/x-msdownload"]}';

  it('matches on the extension when the content type is innocent', () => {
    // The spoof the spec names: a real executable declared as text/plain.
    const match = compile(config).evaluate(
      withAttachments([{ fileName: 'setup.exe', contentType: 'text/plain', sizeBytes: 10 }]),
    );
    expect(match?.trace.detail.matchedOn).toBe('extension');
  });

  it('matches on the content type when the extension is innocent', () => {
    // The other half of the same spoof, and the reason the spec says "and".
    const match = compile(config).evaluate(
      withAttachments([
        { fileName: 'holiday.jpg', contentType: 'application/x-msdownload', sizeBytes: 10 },
      ]),
    );
    expect(match?.trace.detail.matchedOn).toBe('contentType');
  });

  it('describes the offending file, not the first file', () => {
    // The ambiguity: three attachments and only the third is blocked, so an
    // implementation reporting attachments[0] goes red. A single-attachment
    // fixture could not tell the two apart. `sizeBytes` is the only field
    // that distinguishes the three redacted snippets, since (a) and (b) are
    // both innocent and never reach `redactedDescription`.
    const match = compile(config).evaluate(
      withAttachments([
        { fileName: 'a.png', contentType: 'image/png', sizeBytes: 1 },
        { fileName: 'b.txt', contentType: 'text/plain', sizeBytes: 2 },
        { fileName: 'c.scr', contentType: 'text/plain', sizeBytes: 3 },
      ]),
    );
    expect(match?.snippet).toBe('*.scr (text/plain, 3 bytes)');
  });

  it('redacts the snippet to extension, content type and size — never the filename (IMPORTANT-4)', () => {
    // A filename is not the decision basis this predicate matches on, and it
    // lands in a permanent moderation record (`mod_case_events`) that
    // `/forgetme` does not delete. The stem must not survive into either
    // `snippet` or `trace.detail`, even though the extension (which is not
    // personal information) legitimately does.
    const match = compile(config).evaluate(
      withAttachments([
        { fileName: 'medical_letter.exe', contentType: 'text/plain', sizeBytes: 4_096 },
      ]),
    );
    expect(match?.snippet).not.toContain('medical_letter');
    expect(match?.snippet).toBe('*.exe (text/plain, 4096 bytes)');
    expect(match?.trace.detail.fileName).toBeUndefined();
    expect(JSON.stringify(match?.trace.detail)).not.toContain('medical_letter');
  });

  it('is case-insensitive about both the extension and the content type', () => {
    const match = compile(config).evaluate(
      withAttachments([{ fileName: 'SETUP.EXE', contentType: 'TEXT/PLAIN', sizeBytes: 10 }]),
    );
    expect(match).toBeDefined();
  });

  it('ignores a content type parameter', () => {
    // Discord can declare 'application/x-msdownload; charset=binary'.
    const match = compile(config).evaluate(
      withAttachments([
        {
          fileName: 'x.bin',
          contentType: 'application/x-msdownload; charset=binary',
          sizeBytes: 1,
        },
      ]),
    );
    expect(match).toBeDefined();
  });

  it('does not match a file whose name merely contains the extension', () => {
    // 'exeter-notes.pdf' contains 'exe'. Matching on the final segment after
    // the last dot is what stops that.
    expect(
      compile(config).evaluate(
        withAttachments([
          { fileName: 'exeter-notes.pdf', contentType: 'application/pdf', sizeBytes: 1 },
        ]),
      ),
    ).toBeUndefined();
  });

  it('does not match a message with no attachments', () => {
    expect(compile(config).evaluate(withAttachments([]))).toBeUndefined();
  });

  it('handles a file with no extension and no declared type', () => {
    expect(
      compile(config).evaluate(
        withAttachments([{ fileName: 'README', contentType: undefined, sizeBytes: 1 }]),
      ),
    ).toBeUndefined();
  });
});
