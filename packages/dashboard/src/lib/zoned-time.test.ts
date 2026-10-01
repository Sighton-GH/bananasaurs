// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { COMMON_TIME_ZONES, formatInZone, utcToZonedLocal, zonedLocalToUtc } from './zoned-time.js';

describe('zoned-time', () => {
  it('maps a DST gap forward to the first real wall time', () => {
    // 2026-03-08 is spring-forward day in America/Los_Angeles: 02:30 never happens.
    const ms = zonedLocalToUtc('2026-03-08T02:30', 'America/Los_Angeles');
    expect(Number.isFinite(ms)).toBe(true);
    expect(utcToZonedLocal(ms, 'America/Los_Angeles')).toBe('2026-03-08T03:30');
  });

  it('converts a fixed-offset zone exactly', () => {
    expect(zonedLocalToUtc('2026-10-01T09:00', 'Asia/Tokyo')).toBe(Date.UTC(2026, 9, 1, 0, 0));
  });

  it('round-trips winter and summer in a DST zone', () => {
    for (const local of ['2026-01-15T09:00', '2026-07-15T09:00']) {
      const ms = zonedLocalToUtc(local, 'America/New_York');
      expect(utcToZonedLocal(ms, 'America/New_York')).toBe(local);
    }
  });

  it('falls back to ISO text for an unknown zone', () => {
    expect(formatInZone(0, 'Pacific Time')).toBe('1970-01-01 00:00 UTC');
  });

  it('formats a due date in the task zone', () => {
    expect(formatInZone(Date.UTC(2026, 9, 3, 21, 0), 'UTC')).toBe('Oct 3, 9:00 PM');
  });

  it('lists common zones including the browser zone', () => {
    for (const zone of [
      'America/Los_Angeles',
      'America/Denver',
      'America/Chicago',
      'America/New_York',
      'UTC',
      'Europe/London',
      'Asia/Kolkata',
      'Asia/Tokyo',
      'Australia/Sydney',
    ]) {
      expect(COMMON_TIME_ZONES).toContain(zone);
    }
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browserZone) expect(COMMON_TIME_ZONES).toContain(browserZone);
  });
});
