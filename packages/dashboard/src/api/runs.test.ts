import { describe, expect, it } from 'vitest';
import { describeRunEvent } from './runs.js';

describe('run event text (Slice 6)', () => {
  it.each(['light', 'standard'] as const)('renders %s routing in plain words', (tier) => {
    expect(describeRunEvent({ kind: 'routed', tier, reason: 'greeting' })).toBe(
      `Tried the ${tier} model first (greeting)`,
    );
  });
  it.each([
    ['daily-quota', 'daily limit'],
    ['minute-quota', 'minute limit'],
    ['invalid-key', 'key needs attention'],
  ])('renders %s skips in plain words', (reason, text) => {
    expect(
      describeRunEvent({
        kind: 'model-skipped',
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        keyId: 'key_a',
        reason,
      }),
    ).toBe(`Skipped gemini-3.8-flash: ${text}`);
  });
  it('preserves other skip reasons', () => {
    expect(
      describeRunEvent({
        kind: 'model-skipped',
        provider: 'gemini',
        model: 'model-a',
        keyId: 'key_a',
        reason: 'disabled',
      }),
    ).toBe('Skipped model-a: disabled');
  });
});
