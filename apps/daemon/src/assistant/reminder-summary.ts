import type { ReminderRecurrence } from '@bananasaurs/core';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const joinNames = (names: readonly string[]): string => {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

const endDate = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).format(at);

/** Short English phrase for a stored recurrence, e.g. `every Tuesday and Thursday`. */
export const describeRecurrence = (recurrence: ReminderRecurrence): string => {
  const pattern = recurrence.pattern;
  let base: string;
  if (pattern.kind === 'daily') base = 'every day';
  else if (pattern.kind === 'weekdays') base = 'every weekday';
  else if (pattern.kind === 'monthly') base = `monthly on day ${pattern.dayOfMonth}`;
  else {
    const days = [...pattern.days].sort((a, b) => a - b).map((day) => DAY_NAMES[day] ?? '');
    const names = joinNames(days);
    base =
      pattern.everyWeeks > 1 ? `every ${pattern.everyWeeks} weeks on ${names}` : `every ${names}`;
  }
  if (recurrence.endAt !== undefined)
    base += ` until ${endDate(recurrence.endAt, recurrence.timeZone)}`;
  else if (recurrence.maxCount !== undefined)
    base += ` for ${recurrence.maxCount} time${recurrence.maxCount === 1 ? '' : 's'}`;
  return base;
};

export interface ReminderSummaryInput {
  readonly text: string;
  readonly dueAt: number;
  readonly timeZone: string;
  readonly recurrence?: ReminderRecurrence | undefined;
  readonly context?: string | undefined;
  readonly channelName: string;
  readonly memberNames: readonly string[];
  readonly roleNames: readonly string[];
  readonly everyone: boolean;
  readonly here: boolean;
}

const formatWhen = (dueAt: number, timeZone: string): string => {
  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).format(dueAt);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
    timeZoneName: 'short',
  }).format(dueAt);
  return `${date}, ${time}`;
};

const formatPings = (input: ReminderSummaryInput): string => {
  const parts: string[] = [];
  if (input.everyone) parts.push('@everyone');
  if (input.here) parts.push('@here');
  for (const role of input.roleNames) parts.push(`@${role}`);
  for (const member of input.memberNames) parts.push(`@${member}`);
  return parts.length === 0 ? 'nobody' : parts.join(', ');
};

/**
 * The code-written confirmation after a reminder is set, changed or
 * cancelled (ADR 0086 decision 7). The model returns it verbatim; it is
 * built from the stored row, never from model text.
 */
export const reminderSummary = (
  action: 'set' | 'updated' | 'cancelled',
  input: ReminderSummaryInput,
): string => {
  const when =
    input.recurrence === undefined
      ? formatWhen(input.dueAt, input.timeZone)
      : `${formatWhen(input.dueAt, input.timeZone)}, repeats ${describeRecurrence(input.recurrence)}`;
  if (action === 'cancelled') return `🗑️ Reminder cancelled: **${input.text}** (${when})`;
  const head =
    action === 'set'
      ? `✅ Reminder set: **${input.text.slice(0, 200)}**`
      : `✏️ Reminder updated: **${input.text.slice(0, 200)}**`;
  const lines = [
    head,
    `• When: ${when}`,
    `• Where: #${input.channelName}`,
    `• Pings: ${formatPings(input)}`,
  ];
  if (input.context !== undefined && input.context.length > 0)
    lines.push(`• Why: ${input.context}`);
  return lines.join('\n');
};
