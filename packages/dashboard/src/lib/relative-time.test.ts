// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { relativeTime } from './relative-time.js';

describe('relativeTime', () => {
  it('names just now, minutes, hours and days with singulars', () => {
    const now = 1_790_000_000_000;
    expect(relativeTime(now, now)).toBe('just now');
    expect(relativeTime(now - 20_000, now)).toBe('just now');
    expect(relativeTime(now - 60_000, now)).toBe('1 minute ago');
    expect(relativeTime(now - 12 * 60_000, now)).toBe('12 minutes ago');
    expect(relativeTime(now - 60 * 60_000, now)).toBe('1 hour ago');
    expect(relativeTime(now - 5 * 3_600_000, now)).toBe('5 hours ago');
    expect(relativeTime(now - 24 * 3_600_000, now)).toBe('1 day ago');
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe('3 days ago');
  });

  it('names future times with in N units and the same rounding as the past', () => {
    const now = 1_790_000_000_000;
    expect(relativeTime(now + 20_000, now)).toBe('just now');
    expect(relativeTime(now + 29_999, now)).toBe('just now');
    expect(relativeTime(now + 30_000, now)).toBe('in 1 minute');
    expect(relativeTime(now + 3 * 60_000, now)).toBe('in 3 minutes');
    expect(relativeTime(now + 59 * 60_000, now)).toBe('in 59 minutes');
    expect(relativeTime(now + 60 * 60_000, now)).toBe('in 1 hour');
    expect(relativeTime(now + 5 * 3_600_000, now)).toBe('in 5 hours');
    expect(relativeTime(now + 24 * 3_600_000, now)).toBe('in 1 day');
    expect(relativeTime(now + 2 * 86_400_000, now)).toBe('in 2 days');
    expect(relativeTime(now + 400 * 86_400_000, now)).toBe('in 400 days');
  });

  it('keeps past rounding thresholds', () => {
    const now = 1_790_000_000_000;
    expect(relativeTime(now - 29_999, now)).toBe('just now');
    expect(relativeTime(now - 30_000, now)).toBe('1 minute ago');
    expect(relativeTime(now - 89 * 60_000, now)).toBe('1 hour ago');
    expect(relativeTime(now - 400 * 86_400_000, now)).toBe('400 days ago');
  });

  it('handles epoch zero, negative epochs and large values without inventing text', () => {
    expect(relativeTime(0, 0)).toBe('just now');
    expect(relativeTime(-86_400_000, 0)).toBe('1 day ago');
    expect(relativeTime(86_400_000, 0)).toBe('in 1 day');
    expect(relativeTime(8.64e15, 0)).toBe('in 100000000 days');
  });

  it('returns unknown time for non-finite input', () => {
    const now = 1_790_000_000_000;
    expect(relativeTime(Number.NaN, now)).toBe('unknown time');
    expect(relativeTime(Infinity, now)).toBe('unknown time');
    expect(relativeTime(-Infinity, now)).toBe('unknown time');
    expect(relativeTime(now, Number.NaN)).toBe('unknown time');
  });
});
