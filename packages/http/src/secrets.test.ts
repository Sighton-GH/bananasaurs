import { describe, expect, it } from 'vitest';
import {
  csrfTokenFor,
  generateToken,
  hashPassword,
  hashToken,
  secretsMatch,
  verifyPassword,
} from './secrets.js';

describe('password hashing is Argon2id', () => {
  it('produces an argon2id hash, not a bare digest', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('salts, so the same password twice gives different hashes', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
  });

  it('verifies the right password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery stapl')).toBe(false);
  });

  it('returns false rather than throwing on a corrupted hash', async () => {
    // A row that will not parse is a corrupted row, not a correct password, and
    // it must not escape the login handler as a 500 that distinguishes it from
    // a wrong password.
    expect(await verifyPassword('not a hash', 'anything')).toBe(false);
  });
});

describe('tokens', () => {
  it('generates 256 bits, base64url', () => {
    const token = generateToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateToken()));
    expect(seen.size).toBe(200);
  });

  it('contains no character that would need escaping in a cookie', () => {
    // base64url is `A-Za-z0-9-_`. A `;` or `=` in the value would truncate the
    // cookie at the delimiter and produce a token that is silently the wrong
    // length.
    for (let i = 0; i < 50; i++) expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes to a hex sha256, which is what the database stores', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is not recoverable from its hash', () => {
    const token = generateToken();
    expect(hashToken(token)).not.toBe(token);
  });
});

describe('the CSRF token derives from the session token (ADR 0029)', () => {
  it('is stable for one token', () => {
    const token = generateToken();
    expect(csrfTokenFor(token)).toBe(csrfTokenFor(token));
  });

  it('differs between tokens, so it is per-session without a column', () => {
    expect(csrfTokenFor(generateToken())).not.toBe(csrfTokenFor(generateToken()));
  });

  it('is not the session id hash, so the two are not interchangeable', () => {
    // Both are sha256 of the same input; the domain separator is what keeps a
    // leaked CSRF token from being a session lookup key.
    const token = generateToken();
    expect(csrfTokenFor(token)).not.toBe(hashToken(token));
  });

  it('does not reveal the session token', () => {
    const token = generateToken();
    expect(csrfTokenFor(token)).not.toContain(token);
  });
});

describe('secretsMatch', () => {
  it('accepts equal strings', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
  });

  it('rejects different strings of the same length', () => {
    expect(secretsMatch('abc', 'abd')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    // timingSafeEqual throws on a length mismatch; letting that escape would
    // turn a wrong token into a 500.
    expect(secretsMatch('abc', 'abcd')).toBe(false);
  });

  it('rejects an empty string against a real token', () => {
    expect(secretsMatch('', 'abc')).toBe(false);
  });
});
