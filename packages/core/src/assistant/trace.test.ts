import { describe, expect, it } from 'vitest';
import {
  assistantTraceSchema,
  capTrace,
  estimateTokens,
  summaryOfTrace,
  traceFailureCode,
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

  it('ADR 0129 §8: usage.costUsd parses and still parses without it', () => {
    const withCost = fixtureTrace({ usage: { costUsd: 0.0012 } });
    expect(assistantTraceSchema.parse(JSON.parse(JSON.stringify(withCost)))).toEqual(withCost);
    expect(assistantTraceSchema.parse(fixtureTrace()).usage).not.toHaveProperty('costUsd');
  });

  it('still parses an old trace without included', () => {
    const fullTrace = fixtureTrace({
      included: {
        toolsOffered: ['search_sources'],
        snippetChunkIds: ['chunk-1'],
        quote: false,
        historyTurns: 0,
      },
    });
    const oldTrace = Object.fromEntries(
      Object.entries(fullTrace).filter(([key]) => key !== 'included'),
    );
    expect(assistantTraceSchema.parse(oldTrace)).toEqual(oldTrace);
  });

  it('round-trips included channelMessages and still parses included without it', () => {
    const withCount = fixtureTrace({
      included: {
        toolsOffered: ['search_sources'],
        snippetChunkIds: ['chunk-1'],
        quote: false,
        historyTurns: 0,
        channelMessages: 3,
      },
    });
    expect(assistantTraceSchema.parse(JSON.parse(JSON.stringify(withCount)))).toEqual(withCount);
    const withoutCount = fixtureTrace({
      included: {
        toolsOffered: ['search_sources'],
        snippetChunkIds: ['chunk-1'],
        quote: false,
        historyTurns: 0,
      },
    });
    expect(assistantTraceSchema.parse(JSON.parse(JSON.stringify(withoutCount)))).toEqual(
      withoutCount,
    );
    expect(() =>
      assistantTraceSchema.parse(
        fixtureTrace({
          included: {
            toolsOffered: [],
            snippetChunkIds: [],
            quote: false,
            historyTurns: 0,
            channelMessages: -1,
          },
        }),
      ),
    ).toThrow();
  });

  it('round-trips included summaryVersion and still parses included without it', () => {
    const withVersion = fixtureTrace({
      included: {
        toolsOffered: [],
        snippetChunkIds: [],
        quote: false,
        historyTurns: 0,
        summaryVersion: 2,
      },
    });
    expect(assistantTraceSchema.parse(JSON.parse(JSON.stringify(withVersion)))).toEqual(
      withVersion,
    );
    expect(() =>
      assistantTraceSchema.parse(
        fixtureTrace({
          included: {
            toolsOffered: [],
            snippetChunkIds: [],
            quote: false,
            historyTurns: 0,
            summaryVersion: -1,
          },
        }),
      ),
    ).toThrow();
  });

  it('rejects an unknown outcome and a zero tool round', () => {
    expect(() => assistantTraceSchema.parse(fixtureTrace({ outcome: 'maybe' as never }))).toThrow();
    expect(() =>
      assistantTraceSchema.parse(
        fixtureTrace({
          toolCalls: [{ round: 0, name: 'search_sources', args: {}, ok: true, ms: 1, preview: '' }],
        }),
      ),
    ).toThrow();
  });

  it('round-trips an attempt key label and rejects an over-long one', () => {
    const trace = fixtureTrace({
      attempts: [{ provider: 'gemini', model: 'm', keyLabel: 'Main key', outcome: 'ok', ms: 1 }],
    });
    expect(assistantTraceSchema.parse(JSON.parse(JSON.stringify(trace)))).toEqual(trace);
    expect(() =>
      assistantTraceSchema.parse(
        fixtureTrace({
          attempts: [
            { provider: 'gemini', model: 'm', keyLabel: 'x'.repeat(61), outcome: 'ok', ms: 1 },
          ],
        }),
      ),
    ).toThrow();
  });

  it('round-trips an attempt with the classified failure fields', () => {
    const trace = fixtureTrace({
      attempts: [
        {
          provider: 'openrouter',
          model: 'm',
          outcome: 'error',
          reason: 'openrouter request failed',
          ms: 250,
          code: 'provider-connect-timeout',
          httpStatus: 503,
          netCode: 'UND_ERR_CONNECT_TIMEOUT',
          host: 'openrouter.ai',
          availableAt: 1_790_000_100_000,
        },
      ],
    });
    expect(assistantTraceSchema.parse(JSON.parse(JSON.stringify(trace)))).toEqual(trace);
  });

  it('still parses an attempt without the classified failure fields', () => {
    const trace = fixtureTrace({
      attempts: [{ provider: 'gemini', model: 'm', outcome: 'ok', ms: 1 }],
    });
    const parsed = assistantTraceSchema.parse(JSON.parse(JSON.stringify(trace)));
    expect(parsed.attempts[0]).toEqual({
      provider: 'gemini',
      model: 'm',
      outcome: 'ok',
      ms: 1,
    });
  });

  it('parses a trace with every new attempt field plus runId', () => {
    const trace = fixtureTrace({
      runId: 'run-1',
      attempts: [
        {
          provider: 'openrouter',
          model: 'm',
          outcome: 'error',
          reason: 'openrouter returned no text',
          ms: 250,
          code: 'provider-empty-answer',
          providerMessage: 'openrouter returned no text',
          finishReason: 'length',
          upstream: 'Nebius',
          completionTokens: 2048,
          reasoningTokens: 2048,
          costUsd: 0.001,
        },
      ],
    });
    expect(assistantTraceSchema.parse(JSON.parse(JSON.stringify(trace)))).toEqual(trace);
  });
});

describe('traceFailureCode', () => {
  it('prefers failed, skipped, then trace error codes', () => {
    expect(
      traceFailureCode(
        fixtureTrace({
          attempts: [
            { provider: 'p', model: 'm', outcome: 'error', code: 'first', ms: 1 },
            { provider: 'p', model: 'm', outcome: 'skipped', code: 'skip', ms: 1 },
            { provider: 'p', model: 'm', outcome: 'error', code: 'last', ms: 1 },
          ] as AssistantTrace['attempts'],
        }),
      ),
    ).toBe('last');
    expect(
      traceFailureCode(
        fixtureTrace({
          attempts: [{ provider: 'p', model: 'm', outcome: 'skipped', code: 'quota', ms: 1 }],
        }),
      ),
    ).toBe('quota');
    expect(
      traceFailureCode(fixtureTrace({ attempts: [], error: { kind: 'internal', message: 'x' } })),
    ).toBe('internal');
  });
});

describe('summaryOfTrace errorCode (ADR 0129 §5)', () => {
  it('reports the last non-ok non-skipped attempt code', () => {
    const summary = summaryOfTrace(
      fixtureTrace({
        attempts: [
          { provider: 'p', model: 'a', outcome: 'error', ms: 1, code: 'provider-invalid-response' },
          { provider: 'p', model: 'b', outcome: 'skipped', ms: 0 },
          { provider: 'p', model: 'c', outcome: 'error', ms: 1, code: 'provider-bad-model' },
        ],
      }),
    );
    expect(summary.errorCode).toBe('provider-bad-model');
  });

  it('omits errorCode when only ok attempts exist', () => {
    const summary = summaryOfTrace(
      fixtureTrace({ attempts: [{ provider: 'p', model: 'm', outcome: 'ok', ms: 1 }] }),
    );
    expect(summary).not.toHaveProperty('errorCode');
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
      toolCalls: [{ round: 1, name: 'search_sources', args: {}, ok: true, ms: 1, preview: big }],
    });
    const capped = capTrace(trace);
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThanOrEqual(200_000);
    expect(capped.sections[0]?.text).toBe('Be helpful.');
    expect(capped.toolCalls[0]?.preview.endsWith('… [truncated]')).toBe(true);
  });

  it('caps six full tool results along with large prompt sections', () => {
    const big = 'z'.repeat(6_000);
    const trace = fixtureTrace({
      sections: [{ name: 'system', chars: 180_000, estTokens: 45_000, text: 's'.repeat(180_000) }],
      toolCalls: Array.from({ length: 6 }, (_, index) => ({
        round: index + 1,
        name: 'search_sources',
        args: {},
        ok: true,
        ms: 1,
        preview: big,
      })),
    });
    const capped = capTrace(trace);
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThanOrEqual(200_000);
    // Sections shrink first, so the six full results survive whole.
    expect(capped.sections[0]?.text.endsWith('… [truncated]')).toBe(true);
    expect(capped.toolCalls.every((call) => call.preview === big)).toBe(true);
  });
});
