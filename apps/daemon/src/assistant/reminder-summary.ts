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
  /** Unused by the `cancelled` summary; omit it there instead of passing ids. */
  readonly channelName?: string | undefined;
  readonly memberNames?: readonly string[] | undefined;
  readonly roleNames?: readonly string[] | undefined;
  readonly everyone?: boolean | undefined;
  readonly here?: boolean | undefined;
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

const formatPings = (input: {
  readonly memberNames: readonly string[];
  readonly roleNames: readonly string[];
  readonly everyone: boolean;
  readonly here: boolean;
}): string => {
  const parts: string[] = [];
  if (input.everyone) parts.push('@everyone');
  if (input.here) parts.push('@here');
  for (const role of input.roleNames) parts.push(`@${summaryField(role)}`);
  for (const member of input.memberNames) parts.push(`@${summaryField(member)}`);
  return parts.length === 0 ? 'nobody' : parts.join(', ');
};

/**
 * Neutralises `@everyone`/`@here` (any case) by inserting U+200B after `@`,
 * so the text can never ping even when `parse: ['everyone']` is set for a
 * stored `@here`. Shared with reminder delivery: only the code-built pings
 * line may carry live ping tokens.
 */
export const neutraliseMassMentions = (value: string): string =>
  value.replace(/@(?=everyone|here)/gi, '@\u200b');

/**
 * Makes free text safe to interpolate into a summary line, which the reply
 * posts verbatim: collapses every whitespace run (no smuggled newlines),
 * escapes Discord markdown, and neutralises mass mentions and mention
 * syntax so model text or a member nickname cannot ping or reformat the
 * summary. The `@everyone`/`@here` in `formatPings` stay literal: those
 * come from boolean flags, never from interpolated text.
 */
export const summaryField = (value: string): string =>
  neutraliseMassMentions(
    value
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\\/g, '\\\\')
      .replace(/([*_~`|>])/g, '\\$1'),
  ).replace(/<(?=[@#/])/g, '<\u200b');

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
  if (action === 'cancelled')
    return `🗑️ Reminder cancelled: **${summaryField(input.text)}** (${when})`;
  // Truncate the raw value before escaping: slicing after escaping can
  // leave a trailing `\` that escapes the closing `**` and breaks the bold.
  const head =
    action === 'set'
      ? `✅ Reminder set: **${summaryField(input.text.slice(0, 200))}**`
      : `✏️ Reminder updated: **${summaryField(input.text.slice(0, 200))}**`;
  // An edit that left the targets alone omits Where and Pings: the caller
  // passes no channel name then, and raw ids must never print.
  const lines = [
    head,
    `• When: ${when}`,
    ...(action === 'updated' && input.channelName === undefined
      ? []
      : [
          `• Where: #${summaryField(input.channelName ?? '')}`,
          `• Pings: ${formatPings({
            memberNames: input.memberNames ?? [],
            roleNames: input.roleNames ?? [],
            everyone: input.everyone ?? false,
            here: input.here ?? false,
          })}`,
        ]),
  ];
  const why = input.context === undefined ? '' : summaryField(input.context);
  if (why.length > 0) lines.push(`• Why: ${why}`);
  return lines.join('\n');
};
