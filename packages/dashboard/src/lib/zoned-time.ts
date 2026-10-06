/**
 * Wall-clock conversion between `<input type="datetime-local">` values and
 * UTC milliseconds, in the task's own time zone.
 *
 * No imports from other packages: the dashboard builds to static assets and
 * must not pull in server code.
 */

const wallPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const partsInZone = (at: number, timeZone: string): Record<string, string> =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(at)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

const partsToUtc = (parts: Record<string, string>): number =>
  Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']),
    Number(parts['minute']),
  );

/**
 * 'YYYY-MM-DDTHH:mm' wall-clock time in timeZone → UTC ms. Two-pass offset
 * correction (same algorithm as packages/core/src/assistant/recurrence.ts,
 * reimplemented here): guess the instant, observe what wall clock that guess
 * shows in the zone, and shift the guess by the difference, twice.
 *
 * A wall time that never exists (a DST gap such as 02:30 on spring-forward
 * day) cannot round-trip, so after the two passes the result is nudged
 * forward by the remaining gap and lands on the first real wall time after
 * it (03:30 in the example above).
 */
export const zonedLocalToUtc = (local: string, timeZone: string): number => {
  const match = wallPattern.exec(local);
  if (match === null) throw new RangeError(`Invalid local time: ${local}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  const target = guess;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const observed = partsInZone(guess, timeZone);
    guess = target - (partsToUtc(observed) - guess);
  }
  const roundTrip = utcToZonedLocal(guess, timeZone);
  if (roundTrip !== local) {
    // DST gap: shift forward by the leftover difference so the stored
    // instant shows the first real wall time after the gap.
    const gapMinutes =
      Math.round(
        (Date.UTC(year, month - 1, day, hour, minute) -
          Date.UTC(
            Number(roundTrip.slice(0, 4)),
            Number(roundTrip.slice(5, 7)) - 1,
            Number(roundTrip.slice(8, 10)),
            Number(roundTrip.slice(11, 13)),
            Number(roundTrip.slice(14, 16)),
          )) /
          60000,
      ) || 60;
    guess += gapMinutes * 60000;
  }
  return guess;
};

/** UTC ms → 'YYYY-MM-DDTHH:mm' wall-clock in timeZone (for `<input type="datetime-local">`). */
export const utcToZonedLocal = (ms: number, timeZone: string): string => {
  const parts = partsInZone(ms, timeZone);
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}`;
};

/** 'Oct 3, 5:00 PM' style; RangeError → ISO 'YYYY-MM-DD HH:mm UTC'. */
export const formatInZone = (ms: number, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(ms);
  } catch (err) {
    if (err instanceof RangeError) {
      return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    }
    throw err;
  }
};

const BASE_ZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'UTC',
  'Europe/London',
  'Asia/Kolkata',
  'Asia/Tokyo',
  'Australia/Sydney',
] as const;

/** Common zones, plus the browser's zone when it is not already listed. */
export const COMMON_TIME_ZONES: readonly string[] = (() => {
  let browserZone: string;
  try {
    browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    browserZone = '';
  }
  if (browserZone && !(BASE_ZONES as readonly string[]).includes(browserZone)) {
    return [...BASE_ZONES, browserZone];
  }
  return [...BASE_ZONES];
})();
