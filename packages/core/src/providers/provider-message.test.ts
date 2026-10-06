import { describe, expect, it } from 'vitest';
import { sanitizeProviderMessage } from './provider-message.js';

describe('sanitizeProviderMessage (ADR 0129 §3)', () => {
  it.each([
    ['sk-or-v1-0123456789abcdef0123456789abcdef'],
    ['AIzaSyA1234567890abcdefghijklmnopqrstuv'],
    ['Bearer abc.def.ghi'],
    ['nvapi-abcdefgh12345678'],
    ['tvly-abcdefgh1234'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ['github_pat_abcdefghijklmnopqrstuvwxyz0123'],
    ['0123456789abcdef0123456789abcdef01234567'],
  ])('replaces %s with [redacted]', (secret) => {
    const out = sanitizeProviderMessage(`request failed ${secret} boom`);
    expect(out).toContain('[redacted]');
    expect(out).not.toContain(secret);
  });

  it('leaves an ordinary provider message unchanged', () => {
    const message =
      'openrouter request failed with HTTP 404 (code 404: No endpoints found for stealth/space-bunny-alpha.)';
    expect(sanitizeProviderMessage(message)).toBe(message);
  });

  it('caps a long message at 160 characters ending in …', () => {
    const out = sanitizeProviderMessage(`word ${'word '.repeat(80)}`.trim());
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('…')).toBe(true);
  });

  it('collapses whitespace runs to one space', () => {
    expect(sanitizeProviderMessage('a\n\n  b')).toBe('a b');
  });
});
