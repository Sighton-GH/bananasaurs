import { z } from 'zod';

const localParts = (at: number, timeZone: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
      .formatToParts(at)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;

const recurrencePattern = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily') }),
  z.object({ kind: z.literal('weekdays') }),
  z.object({
    kind: z.literal('weekly'),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    everyWeeks: z.number().int().min(1).max(12).default(1),
  }),
  z.object({ kind: z.literal('monthly'), dayOfMonth: z.number().int().min(1).max(31) }),
]);

export const reminderRecurrence = z
  .object({
    pattern: recurrencePattern,
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .refine((timeZone) => {
        try {
          new Intl.DateTimeFormat('en-CA', { timeZone });
          return true;
        } catch {
          return false;
        }
      }, 'invalid time zone'),
    endAt: z.number().int().positive().optional(),
    maxCount: z.number().int().min(1).max(1000).optional(),
  })
  .strict();
export type ReminderRecurrence = z.infer<typeof reminderRecurrence>;

const utcForLocal = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number => {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  const target = guess;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const observed = localParts(guess, timeZone);
    const asUtc = Date.UTC(
      Number(observed.year),
      Number(observed.month) - 1,
      Number(observed.day),
      Number(observed.hour),
      Number(observed.minute),
    );
    guess = target - (asUtc - guess);
  }
  return guess;
};

const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

export const nextOccurrence = (
  recurrence: ReminderRecurrence,
  anchorAt: number,
  after: number,
  deliveredCount: number,
): number | undefined => {
  if (recurrence.endAt !== undefined && recurrence.endAt <= after) return undefined;
  if (recurrence.maxCount !== undefined && deliveredCount >= recurrence.maxCount) return undefined;
  const anchor = localParts(anchorAt, recurrence.timeZone);
  const anchorDate = Date.UTC(Number(anchor.year), Number(anchor.month) - 1, Number(anchor.day));
  const anchorDayNumber = Math.floor(anchorDate / 86_400_000);
  const anchorWeekday = new Date(anchorDate).getUTCDay();
  const anchorWeekStart = anchorDayNumber - anchorWeekday;
  for (let offset = 0; offset <= 800; offset += 1) {
    const date = new Date(anchorDate + offset * 86_400_000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const weekday = date.getUTCDay();
    const pattern = recurrence.pattern;
    const matches =
      pattern.kind === 'daily' ||
      (pattern.kind === 'weekdays' && weekday >= 1 && weekday <= 5) ||
      (pattern.kind === 'weekly' &&
        pattern.days.includes(weekday) &&
        Math.floor((anchorWeek + offset - anchorWeek) / 7) % pattern.everyWeeks === 0) ||
      (pattern.kind === 'monthly' &&
        day === Math.min(pattern.dayOfMonth, daysInMonth(year, month)));
    if (!matches) continue;
    const candidate = utcForLocal(
      year,
      month,
      day,
      Number(anchor.hour),
      Number(anchor.minute),
      recurrence.timeZone,
    );
    if (candidate <= after) continue;
    if (recurrence.endAt !== undefined && candidate > recurrence.endAt) return undefined;
    return candidate;
  }
  return undefined;
};
