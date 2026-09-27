import { describe, expect, it } from 'vitest';
import { relativeAgo } from './relative-time.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('relativeAgo', () => {
  it('says "just now" for 0 ms', () => {
    expect(relativeAgo(1_000, 1_000)).toBe('just now');
  });

  it('says "just now" for 59,999 ms', () => {
    expect(relativeAgo(0, 59_999)).toBe('just now');
  });

  it('says "1 min ago" for 60,000 ms', () => {
    expect(relativeAgo(0, 60_000)).toBe('1 min ago');
  });

  it('says "59 min ago" for 59 min', () => {
    expect(relativeAgo(0, 59 * MIN)).toBe('59 min ago');
  });

  it('says "1 h ago" for 60 min', () => {
    expect(relativeAgo(0, 60 * MIN)).toBe('1 h ago');
  });

  it('says "23 h ago" for 23 h 59 min', () => {
    expect(relativeAgo(0, 23 * HOUR + 59 * MIN)).toBe('23 h ago');
  });

  it('says "1 day ago" for 24 h', () => {
    expect(relativeAgo(0, 24 * HOUR)).toBe('1 day ago');
  });

  it('says "3 days ago" for 72 h', () => {
    expect(relativeAgo(0, 72 * HOUR)).toBe('3 days ago');
  });

  it('says "just now" for a future atMs (clock skew)', () => {
    expect(relativeAgo(2_000, 1_000)).toBe('just now');
  });
});
