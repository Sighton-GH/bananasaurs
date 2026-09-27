import { describe, expect, it } from 'vitest';
import { nextOccurrence, reminderRecurrence } from './recurrence.js';

const at = (value: string) => Date.parse(value);
const recurrence = (pattern: object, extra: object = {}) =>
  reminderRecurrence.parse({ pattern, timeZone: 'America/Vancouver', ...extra });

describe('nextOccurrence', () => {
  it('finds the next daily occurrence', () => {
    const anchor = at('2026-01-05T17:00:00Z');
    expect(nextOccurrence(recurrence({ kind: 'daily' }), anchor, anchor, 0)).toBe(
      at('2026-01-06T17:00:00Z'),
    );
  });
  it('skips missed daily occurrences', () => {
    const anchor = at('2026-01-05T17:00:00Z');
    expect(nextOccurrence(recurrence({ kind: 'daily' }), anchor, at('2026-01-10T18:00:00Z'), 0)).toBe(
      at('2026-01-11T17:00:00Z'),
    );
  });
  it('skips weekends', () => {
    const anchor = at('2026-01-09T17:00:00Z');
    expect(nextOccurrence(recurrence({ kind: 'weekdays' }), anchor, anchor, 0)).toBe(
      at('2026-01-12T17:00:00Z'),
    );
  });
  it('supports selected weekdays and week intervals', () => {
    const anchor = at('2026-01-05T17:00:00Z');
    expect(nextOccurrence(recurrence({ kind: 'weekly', days: [2, 4] }), anchor, anchor, 0)).toBe(
      at('2026-01-06T17:00:00Z'),
    );
    expect(nextOccurrence(recurrence({ kind: 'weekly', days: [1], everyWeeks: 2 }), anchor, anchor, 0)).toBe(
      at('2026-01-19T17:00:00Z'),
    );
  });
  it('clamps monthly dates', () => {
    const anchor = at('2026-01-31T17:00:00Z');
    const monthly = recurrence({ kind: 'monthly', dayOfMonth: 31 });
    expect(nextOccurrence(monthly, anchor, anchor, 0)).toBe(at('2026-02-28T17:00:00Z'));
    expect(nextOccurrence(monthly, at('2026-03-31T16:00:00Z'), at('2026-03-31T17:00:00Z'), 0)).toBe(
      at('2026-04-30T16:00:00Z'),
    );
  });
  it('honours end and count limits', () => {
    const anchor = at('2026-01-05T17:00:00Z');
    expect(nextOccurrence(recurrence({ kind: 'daily' }, { endAt: anchor + 1 }), anchor, anchor, 0)).toBeUndefined();
    expect(nextOccurrence(recurrence({ kind: 'daily' }, { maxCount: 1 }), anchor, anchor, 1)).toBeUndefined();
  });
  it('keeps the local wall time over DST', () => {
    const anchor = at('2026-03-07T17:00:00Z');
    const next = nextOccurrence(recurrence({ kind: 'daily' }), anchor, anchor, 0);
    expect(next).toBe(at('2026-03-08T16:00:00Z'));
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(next)).toBe('09:00');
  });
  it('rejects invalid time zones', () => {
    expect(reminderRecurrence.safeParse({ pattern: { kind: 'daily' }, timeZone: 'Not/AZone' }).success).toBe(false);
  });
});
