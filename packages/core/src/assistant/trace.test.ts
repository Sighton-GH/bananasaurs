import { describe, expect, it } from 'vitest';
import {
  assistantTraceSchema,
  capTrace,
  estimateTokens,
  type AssistantTrace,
} from './trace.js';

/**
 * A fixture trace as stored data: fixed ids and timestamps, no narrative
 * about anyone having acted. Shared shape for the storage and route tests.
 */
export const fixtureTrace = (over: Partial<AssistantTrace> = {}): AssistantTrace => ({
  traceId: 'trace-1',
  at: 1_790_000_000_000,
  userId: '100000000000000001',
  channelId: '333333333333333333',
  behaviourId: 'club',
  command: 'ask',
  source: 'mention',
  conversationId: 'conv-1',
  turnId: 'turn-1',
  question: 'When is the next club meeting?',
  answer: 'Thursday at 6 pm.',
  outcome: 'answered',
  durationMs: 1200,
  attempts: [{ provider: 'gemini', model: 'gemini-2.5-flash', outcome: 'ok', ms: 900 }],
  finishReason: 'stop',
  usage: { promptTokens: 100, completionTokens: 20, thinkingTokens: 10 },
  sections: [{ name: 'system', chars: 12, estTokens: 3, text: 'Be helpful.' }],
  toolCalls: [
    {
      round: 1,
      name: 'search_sources',
      args: { query: 'meeting' },
      ok: true,
      ms: 100,
      preview: 'Thursday 6 pm',
    },
  ],
  guard: { removed: [] },
  timeline: [
    { label: 'queued', atMs: 0 },
    { label: 'posted', atMs: 1200 },
  ],
  discordMessageIds: ['900000000000000002'],
  sources: [{ title: 'Meetings', url: 'https://example.com/meetings' }],
  flags: [],
  ...over,
});

describe('assistantTraceSchema', () => {
  it('round-trips a complete trace through JSON', () => {
    const trace = fixtureTrace();
    expect(assistantTraceSchema.parse(JSON.parse(JSON.stringify(trace)))).toEqual(trace);
  });

  it('accepts a minimal trace with every optional field absent', () => {
    const trace = fixtureTrace({
      channelId: undefined,
      conversationId: undefined,
      turnId: undefined,
      answer: undefined,
      finishReason: undefined,
      error: undefined,
    });
    expect(assistantTraceSchema.parse(JSON.parse(JSON.stringify(trace)))).toEqual(trace);
  });

  it('rejects an unknown outcome and a zero tool round', () => {
    expect(() =>
      assistantTraceSchema.parse(fixtureTrace({ outcome: 'maybe' as never })),
    ).toThrow();
    expect(() =>
      assistantTraceSchema.parse(
        fixtureTrace({
          toolCalls: [
            { round: 0, name: 'search_sources', args: {}, ok: true, ms: 1, preview: '' },
          ],
        }),
      ),
    ).toThrow();
  });
});

describe('estimateTokens', () => {
  it('counts one token per four characters, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('capTrace', () => {
  it('leaves a small trace untouched', () => {
    const trace = fixtureTrace();
    expect(capTrace(trace)).toEqual(trace);
  });

  it('shrinks a 1 MB sections payload under 200 KB and marks the truncation', () => {
    const big = 'x'.repeat(1_000_000);
    const trace = fixtureTrace({
      sections: [{ name: 'system', chars: big.length, estTokens: 250_000, text: big }],
    });
    const capped = capTrace(trace);
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThanOrEqual(200_000);
    expect(capped.sections[0]?.text.endsWith('… [truncated]')).toBe(true);
    expect(capped.sections[0]?.chars).toBe(capped.sections[0]?.text.length);
  });

  it('truncates tool previews only after sections are already minimal', () => {
    const big = 'y'.repeat(500_000);
    const trace = fixtureTrace({
      sections: [{ name: 'system', chars: 12, estTokens: 3, text: 'Be helpful.' }],
      toolCalls: [
        { round: 1, name: 'search_sources', args: {}, ok: true, ms: 1, preview: big },
      ],
    });
    const capped = capTrace(trace);
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThanOrEqual(200_000);
    expect(capped.sections[0]?.text).toBe('Be helpful.');
    expect(capped.toolCalls[0]?.preview.endsWith('… [truncated]')).toBe(true);
  });
});
