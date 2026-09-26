import { describe, expect, it } from 'vitest';
import { nextProviderDayStart, providerDayStart } from './provider-day.js';

describe('providerDayStart', () => {
  it('openrouter follows UTC', () => {
    const at = Date.parse('2026-09-25T15:00:00Z');
    expect(providerDayStart('openrouter', at)).toBe(Date.parse('2026-09-25T00:00:00Z'));
    expect(nextProviderDayStart('openrouter', at)).toBe(Date.parse('2026-09-26T00:00:00Z'));
  });

  it('gemini follows America/Los_Angeles in PDT', () => {
    const at = Date.parse('2026-09-25T06:00:00Z');
    expect(providerDayStart('gemini', at)).toBe(Date.parse('2026-09-24T07:00:00Z'));
    expect(nextProviderDayStart('gemini', at)).toBe(Date.parse('2026-09-25T07:00:00Z'));
  });

  it('gemini handles the autumn DST change', () => {
    const at = Date.parse('2026-11-01T12:00:00Z');
    expect(providerDayStart('gemini', at)).toBe(Date.parse('2026-11-01T07:00:00Z'));
    expect(nextProviderDayStart('gemini', at)).toBe(Date.parse('2026-11-02T08:00:00Z'));
  });

  it('gemini handles the spring DST change', () => {
    const at = Date.parse('2026-03-08T12:00:00Z');
    expect(providerDayStart('gemini', at)).toBe(Date.parse('2026-03-08T08:00:00Z'));
    expect(nextProviderDayStart('gemini', at)).toBe(Date.parse('2026-03-09T07:00:00Z'));
  });

  it('nvidia-nim follows UTC', () => {
    const at = Date.parse('2026-09-25T15:00:00Z');
    expect(providerDayStart('nvidia-nim', at)).toBe(Date.parse('2026-09-25T00:00:00Z'));
    expect(nextProviderDayStart('nvidia-nim', at)).toBe(Date.parse('2026-09-26T00:00:00Z'));
  });
});
