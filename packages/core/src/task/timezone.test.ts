import { describe, expect, it } from 'vitest';
import { isValidTimeZone, timeZoneSchema } from './timezone.js';

describe('timezone', () => {
  it('accepts a valid IANA time zone', () => {
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
    expect(timeZoneSchema.safeParse('America/Los_Angeles').success).toBe(true);
  });
  it('rejects a non-IANA display name', () => {
    expect(isValidTimeZone('Pacific Time')).toBe(false);
    expect(timeZoneSchema.safeParse('Pacific Time').success).toBe(false);
  });
  it('rejects an empty string', () => {
    expect(isValidTimeZone('')).toBe(false);
    expect(timeZoneSchema.safeParse('').success).toBe(false);
  });
});
