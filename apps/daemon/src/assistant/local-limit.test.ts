import { describe, expect, it } from 'vitest';
import { localLimitReply } from './local-limit.js';

const NOW = 1_800_000_000_000;

describe('localLimitReply', () => {
  it('30 s away reads as about 1 minute', () => {
    expect(localLimitReply(NOW + 30_000, NOW, 'UTC')).toBe(
      'All AI models have reached the limits set for them. The next one frees up in about 1 minute.',
    );
  });

  it('14 min 10 s away reads as about 15 minutes', () => {
    expect(localLimitReply(NOW + (14 * 60 + 10) * 1000, NOW, 'UTC')).toBe(
      'All AI models have reached the limits set for them. The next one frees up in about 15 minutes.',
    );
  });

  it('5 h away names a clock time in the given zone', () => {
    const text = localLimitReply(NOW + 5 * 3_600_000, NOW, 'America/Vancouver');
    expect(text).toContain('frees up at ');
    const time = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Vancouver',
      hour: 'numeric',
      minute: '2-digit',
    }).format(NOW + 5 * 3_600_000);
    expect(text).toBe(
      `All AI models have reached the limits set for them. The next one frees up at ${time}.`,
    );
  });
});
