import { describe, expect, it } from 'vitest';
import { sanitizeMentionsForProvider } from './mentions.js';

const U_SAM = '456789012345678901';
const U_UNKNOWN = '567890123456789012';
const R_CAR = '678901234567890123';
const R_UNKNOWN = '789012345678901234';
const names = {
  users: new Map([[U_SAM, 'Sam L']]),
  roles: new Map([[R_CAR, 'Car Team A']]),
};

describe('sanitizeMentionsForProvider (ADR 0145)', () => {
  it('renders known members and roles by display name', () => {
    expect(sanitizeMentionsForProvider(`remind <@${U_SAM}> and <@&${R_CAR}>`, names)).toBe(
      'remind @Sam L and @Car Team A',
    );
  });
  it('keeps @user and @role for unknown ids', () => {
    expect(sanitizeMentionsForProvider(`hi <@${U_UNKNOWN}> <@&${R_UNKNOWN}>`, names)).toBe(
      'hi @user @role',
    );
  });
  it('without names keeps today’s flattening byte-for-byte', () => {
    expect(sanitizeMentionsForProvider(`remind <@!${U_SAM}> in <#111111111111111111>`)).toBe(
      'remind @user in #channel',
    );
  });
  it('cleans member-controlled names through the display-name sanitiser', () => {
    const evil = { users: new Map([[U_SAM, '  Sam \n L]  ']]), roles: new Map() };
    expect(sanitizeMentionsForProvider(`<@${U_SAM}>`, evil)).toBe('@Sam L');
  });
  it('leaves bare numbers alone for the outbound scan', () => {
    expect(sanitizeMentionsForProvider('call 456789012345678901 now', names)).toBe(
      'call 456789012345678901 now',
    );
  });
});
