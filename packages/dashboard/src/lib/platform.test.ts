import { describe, expect, it } from 'vitest';
import { isMac } from './platform.js';

describe('isMac', () => {
  it.each([
    ['MacIntel', '', true],
    ['iPhone', '', true],
    ['iPad', '', true],
    ['Win32', 'Mozilla/5.0 (Windows NT 10.0)', false],
    ['Linux x86_64', '', false],
    ['', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', true],
    ['', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17)', true],
    ['', 'Mozilla/5.0 (iPad; CPU OS 17)', true],
    ['', 'Mozilla/5.0 (X11; Linux x86_64)', false],
  ])('platform %j userAgent %j -> %j', (platform, userAgent, expected) => {
    expect(isMac({ platform, userAgent })).toBe(expected);
  });
  it('reads the global navigator by default', () => {
    expect(typeof isMac()).toBe('boolean');
  });
});
