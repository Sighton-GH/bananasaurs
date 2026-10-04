import { describe, expect, it } from 'vitest';
import { idsAreWellFormed } from './ids.js';

/** The shared id pre-check behind every tool's malformed-id refusal. */
describe('idsAreWellFormed', () => {
  it('accepts well-formed snowflakes and the empty list', () => {
    expect(idsAreWellFormed(['111111111111111111', '9223372036854775807'])).toBe(true);
    expect(idsAreWellFormed([])).toBe(true);
  });

  it('rejects when any entry is not an id, without throwing', () => {
    expect(idsAreWellFormed(['not-a-snowflake'])).toBe(false);
    expect(idsAreWellFormed(['111111111111111111', 'nope'])).toBe(false);
    expect(idsAreWellFormed([7])).toBe(false);
    expect(idsAreWellFormed([undefined])).toBe(false);
  });
});
