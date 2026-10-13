import { expect, it } from 'vitest';
import { absoluteMoment, relativeMoment } from './time.js';
it('formats past/future/missing/invalid times', () => {
  const now = Date.UTC(2026, 9, 12, 17);
  expect(relativeMoment(now + 3_600_000, now)).toBe('in 1 hour');
  expect(relativeMoment(now - 120_000, now)).toBe('2 minutes ago');
  expect(relativeMoment(undefined, now)).toBe('Time unavailable');
  expect(relativeMoment(NaN, now)).toBe('Time unavailable');
});
it('absolute hover distinguishes the computed DST fold by offset', () => {
  const first = Date.UTC(2026, 10, 1, 8, 30);
  const second = first + 3_600_000;
  expect(absoluteMoment(first, 'America/Vancouver')).not.toBe(
    absoluteMoment(second, 'America/Vancouver'),
  );
});
