import { describe, expect, it } from 'vitest';
import { describeRecurrence, reminderSummary } from './reminder-summary.js';

const recurrence = (
  pattern: { kind: string; days?: number[]; everyWeeks?: number; dayOfMonth?: number },
  extra: { endAt?: number; maxCount?: number } = {},
) =>
  describeRecurrence({
    pattern: { everyWeeks: 1, ...pattern } as never,
    timeZone: 'America/Vancouver',
    ...extra,
  });

describe('describeRecurrence', () => {
  it('phrases daily and weekdays', () => {
    expect(recurrence({ kind: 'daily' })).toBe('every day');
    expect(recurrence({ kind: 'weekdays' })).toBe('every weekday');
  });

  it('lists weekly days by name', () => {
    expect(recurrence({ kind: 'weekly', days: [2, 4] })).toBe('every Tuesday and Thursday');
  });

  it('phrases every-N-weeks with its day', () => {
    expect(recurrence({ kind: 'weekly', days: [1], everyWeeks: 2 })).toBe(
      'every 2 weeks on Monday',
    );
  });

  it('phrases monthly by day of month', () => {
    expect(recurrence({ kind: 'monthly', dayOfMonth: 31 })).toBe('monthly on day 31');
  });

  it('appends an end date or a count', () => {
    const until = Date.UTC(2026, 9, 30, 16, 0);
    expect(recurrence({ kind: 'daily' }, { endAt: until })).toBe('every day until Oct 30, 2026');
    expect(recurrence({ kind: 'daily' }, { maxCount: 5 })).toBe('every day for 5 times');
  });
});

describe('reminderSummary', () => {
  const base = {
    text: 'Bring the charger',
    dueAt: Date.UTC(2026, 9, 29, 16, 0),
    timeZone: 'America/Vancouver',
    channelName: 'general',
    memberNames: ['Ava'] as readonly string[],
    roleNames: ['Mods'] as readonly string[],
    everyone: false,
    here: false,
  };

  it('summarises a set reminder with every line', () => {
    const text = reminderSummary('set', { ...base, context: 'for the race' });
    const lines = text.split('\n');
    expect(lines[0]).toBe('✅ Reminder set: **Bring the charger**');
    expect(lines[1]).toMatch(/^• When: /);
    expect(lines[1]).toContain('2026');
    expect(lines[2]).toBe('• Where: #general');
    expect(lines[3]).toBe('• Pings: @Mods, @Ava');
    expect(lines[4]).toBe('• Why: for the race');
    expect(lines).toHaveLength(5);
  });

  it('omits the why line without context and pings nobody when empty', () => {
    const text = reminderSummary('set', { ...base, memberNames: [], roleNames: [] });
    const lines = text.split('\n');
    expect(lines[0]).toBe('✅ Reminder set: **Bring the charger**');
    expect(lines[3]).toBe('• Pings: nobody');
    expect(text).not.toContain('• Why:');
    expect(lines).toHaveLength(4);
  });

  it('names everyone and here first', () => {
    const text = reminderSummary('set', {
      ...base,
      memberNames: [],
      roleNames: [],
      everyone: true,
      here: true,
    });
    expect(text.split('\n')[3]).toBe('• Pings: @everyone, @here');
  });

  it('marks an update with the pencil and clips long text', () => {
    const text = reminderSummary('updated', { ...base, text: 'x'.repeat(300) });
    expect(text.split('\n')[0]).toBe(`✏️ Reminder updated: **${'x'.repeat(200)}**`);
  });

  it('adds the repeat phrase to the when line', () => {
    const text = reminderSummary('set', {
      ...base,
      recurrence: {
        pattern: { kind: 'daily' },
        timeZone: 'America/Vancouver',
      },
    });
    expect(text.split('\n')[1]).toContain(', repeats every day');
  });

  it('cancels in one line with the when value', () => {
    const text = reminderSummary('cancelled', base);
    const when = reminderSummary('set', base).split('\n')[1]?.replace('• When: ', '');
    expect(text).toBe(`🗑️ Reminder cancelled: **Bring the charger** (${when})`);
    expect(text.split('\n')).toHaveLength(1);
  });
});
