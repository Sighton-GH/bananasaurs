import { describe, expect, it } from 'vitest';
import {
  buildDigestInput,
  DIGEST_DEFAULT_HOUR,
  DIGEST_DEFAULT_INPUT_CHARS,
  DIGEST_DEFAULT_MAX_PROPOSALS,
  digestOutputSchema,
  localDay,
  localDayBounds,
  localHour,
  MAX_DIGEST_SUMMARY_WORDS,
  normalizeProposalText,
  splitDigestInput,
  truncateWords,
} from './digest.js';

describe('local day (ADR 0150 decision 1)', () => {
  it('names the Vancouver day for instants near midnight', () => {
    expect(localDay('America/Vancouver', Date.parse('2026-10-10T07:30:00Z'))).toBe('2026-10-10');
    expect(localDay('America/Vancouver', Date.parse('2026-10-10T06:30:00Z'))).toBe('2026-10-09');
  });
  it('bounds one local day and reads its hour', () => {
    const { start, end } = localDayBounds('2026-10-09', 'America/Vancouver');
    expect(end).toBeGreaterThan(start);
    expect(end - start).toBeGreaterThanOrEqual(23 * 3_600_000);
    expect(end - start).toBeLessThanOrEqual(25 * 3_600_000);
    const noon = Date.parse('2026-10-09T19:00:00Z');
    expect(noon).toBeGreaterThanOrEqual(start);
    expect(noon).toBeLessThan(end);
    expect(localHour('America/Vancouver', Date.parse('2026-10-09T11:00:00Z'))).toBe(4);
  });
  it('exposes the spec defaults', () => {
    expect(DIGEST_DEFAULT_INPUT_CHARS).toBe(40_000);
    expect(DIGEST_DEFAULT_MAX_PROPOSALS).toBe(10);
    expect(DIGEST_DEFAULT_HOUR).toBe(4);
    expect(MAX_DIGEST_SUMMARY_WORDS).toBe(300);
  });
});

describe('digest output schema (ADR 0150 decision 3)', () => {
  const proposal = {
    text: 'The build night is every second Friday.',
    why: 'Mentioned twice today.',
    sourceConversationIds: ['conv-1'],
  };
  it('accepts a small valid reply', () => {
    expect(
      digestOutputSchema.safeParse({
        daySummary: 'Talked about the build night.',
        memoryProposals: [proposal],
      }).success,
    ).toBe(true);
  });
  it('rejects a summary over 300 words and more than 10 proposals', () => {
    const long = Array.from({ length: 301 }, () => 'word').join(' ');
    expect(digestOutputSchema.safeParse({ daySummary: long, memoryProposals: [] }).success).toBe(
      false,
    );
    expect(
      digestOutputSchema.safeParse({
        daySummary: 'Short.',
        memoryProposals: Array.from({ length: 11 }, () => proposal),
      }).success,
    ).toBe(false);
  });
  it('normalises proposal text for duplicate matching', () => {
    expect(normalizeProposalText('  Build-Night!! every Friday ')).toBe('build night every friday');
  });
  it('truncates joined summaries to the word cap', () => {
    expect(truncateWords('one two three four', 3)).toBe('one two three');
    expect(truncateWords('one two', 3)).toBe('one two');
  });
});

describe('digest input build (ADR 0150 decision 2)', () => {
  const conv = (id: string, lines: readonly string[]) => ({
    conversationId: id,
    title: `T ${id}`,
    summaryText: null as string | null,
    lines,
  });
  it('frames conversations with headers the model must cite', () => {
    const text = buildDigestInput([conv('conv-1', ['[Sam L, member] hi'])], 40_000);
    expect(text).toContain('[CONVERSATION conv-1 ');
    expect(text).toContain('[Sam L, member] hi');
  });
  it('drops the oldest blocks first when over the cap', () => {
    const text = buildDigestInput(
      [
        conv('conv-old', [`[Sam L, member] ${'x'.repeat(100)}`]),
        conv('conv-new', ['[Alex P, member] hi']),
      ],
      80,
    );
    expect(text).toContain('conv-new');
    expect(text).not.toContain('conv-old');
  });
  it('splits and rejoins without loss', () => {
    const text = buildDigestInput(
      [conv('a', ['[Sam L, member] one']), conv('b', ['[Alex P, member] two'])],
      40_000,
    );
    expect(splitDigestInput(text, 40_000)).toEqual([text]);
    expect(splitDigestInput(`${'y'.repeat(60)}\n${'z'.repeat(60)}`, 61).join('\n')).toContain(
      'z'.repeat(60),
    );
  });
});
