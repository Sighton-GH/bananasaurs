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

  it('clamps a future timestamp to just now', () => {
    const now = 1_790_000_000_000;
    expect(relativeTime(now + 60_000, now)).toBe('just now');
  });
});
