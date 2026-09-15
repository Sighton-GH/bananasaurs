import { describe, expect, it } from 'vitest';
import { isAllowedRedirectUri } from './redirect-uri.js';

describe('isAllowedRedirectUri', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'http://127.0.0.1:8976/cb',
    'http://[::1]:1/cb',
    'http://localhost:3000/cb',
    'HTTPS://example.test/cb',
  ])('accepts %s', (raw) => {
    expect(isAllowedRedirectUri(raw)).toBe(true);
  });

  it.each([
    'http://evil.test/cb',
    'https://example.test/cb#frag',
    '/relative',
    'javascript:alert(1)',
    'https:///nohost',
    'http://localhost.evil.test/cb',
  ])('refuses %s', (raw) => {
    expect(isAllowedRedirectUri(raw)).toBe(false);
  });

  it('compares the whole hostname, not a prefix: localhost.evil.test is not loopback', () => {
    expect(isAllowedRedirectUri('http://localhost.evil.test/cb')).toBe(false);
    expect(isAllowedRedirectUri('http://localhost:3000/cb')).toBe(true);
  });

  it('treats the scheme case-insensitively: the URL parser lowercases protocol', () => {
    expect(new URL('HTTPS://example.test/cb').protocol).toBe('https:');
    expect(isAllowedRedirectUri('HTTPS://example.test/cb')).toBe(true);
  });
});
