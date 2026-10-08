import { describe, expect, it } from 'vitest';
import { runEventSchema } from './run-events.js';

/** One valid event per kind (ADR 0129 §6): metadata only, no message text. */
const everyKind = [
  { kind: 'queued', via: 'mention' },
  { kind: 'started', attempt: 1, queueWaitMs: 12 },
  { kind: 'conversation', continued: false, historyTurns: 3 },
  {
    kind: 'context-built',
    sections: [{ name: 'system', chars: 12, estTokens: 3 }],
    snippetChunks: 1,
    memories: 0,
    channelMessages: 5,
    toolsOffered: ['search'],
  },
  {
    kind: 'model-call',
    position: 0,
    of: 1,
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    keyId: 'key-1',
    round: 0,
  },
  {
    kind: 'model-result',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    keyId: 'key-1',
    ok: true,
    ms: 900,
  },
  {
    kind: 'model-skipped',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    keyId: 'key-1',
    reason: 'rate-limit',
  },
  { kind: 'tool-call', round: 1, tool: 'search' },
  { kind: 'tool-result', round: 1, tool: 'search', ok: true, ms: 30, resultChars: 120 },
  { kind: 'guard', removed: 0 },
  { kind: 'retry-scheduled', code: 'provider-timeout', retryAt: 1_790_000_000_000, attempt: 2 },
  { kind: 'delivering', parts: 1 },
  { kind: 'delivered', messageIds: ['111111111111111111'] },
  { kind: 'finished', outcome: 'answered', durationMs: 1200 },
] as const;

describe('runEventSchema (ADR 0129 §6)', () => {
  it('round-trips every kind', () => {
    for (const event of everyKind) {
      expect(runEventSchema.parse(event)).toEqual(event);
    }
  });

  it('rejects a queued event carrying message text', () => {
    expect(
      runEventSchema.safeParse({ kind: 'queued', via: 'mention', question: 'hi' }).success,
    ).toBe(false);
  });

  it('rejects a tool-result carrying result text', () => {
    expect(
      runEventSchema.safeParse({
        kind: 'tool-result',
        round: 1,
        tool: 'x',
        ok: true,
        ms: 1,
        resultChars: 3,
        result: 'secret',
      }).success,
    ).toBe(false);
  });
});
