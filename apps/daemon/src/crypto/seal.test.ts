import { createHash, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { openWithKey, sealWithKey } from './seal.js';

const key = (label: string): Buffer => createHash('sha256').update(label, 'utf8').digest();

it('opens exactly what it sealed', () => {
  const k = key('test-key');
  expect(openWithKey(k, sealWithKey(k, 'a plaintext value'))).toBe('a plaintext value');
});

it('refuses to open under a different key', () => {
  const sealed = sealWithKey(key('key-one'), 'secret');
  expect(openWithKey(key('key-two'), sealed)).toBeUndefined();
});

it('refuses a value that is not valid base64-wrapped ciphertext', () => {
  expect(openWithKey(key('test-key'), 'not base64 ciphertext')).toBeUndefined();
});

it('refuses a value too short to carry a nonce and tag', () => {
  expect(openWithKey(key('test-key'), Buffer.alloc(10).toString('base64'))).toBeUndefined();
});

it('refuses a tampered ciphertext (authentication fails)', () => {
  const k = key('test-key');
  const sealed = Buffer.from(sealWithKey(k, 'secret'), 'base64');
  sealed[sealed.length - 1] = (sealed[sealed.length - 1]! ^ 0xff) & 0xff;
  expect(openWithKey(k, sealed.toString('base64'))).toBeUndefined();
});

it('produces a different ciphertext each time (random nonce)', () => {
  const k = key('test-key');
  expect(sealWithKey(k, 'same value')).not.toBe(sealWithKey(k, 'same value'));
});

// Unchanged from the original `provider-config.ts` implementation this was
// moved from (behaviour must stay identical, ADR 0070): an empty plaintext
// seals to exactly 28 bytes (12 nonce + 16 tag + 0 ciphertext), one short of
// the `< 29` floor `openWithKey` checks, so it is refused rather than opened.
// Not a case either caller produces — a password or provider key is never
// the empty string — so this documents the boundary rather than fixing it.
it('a sealed empty string is one byte short of the length floor and refuses to open', () => {
  const k = key('test-key');
  const sealed = sealWithKey(k, '');
  expect(Buffer.from(sealed, 'base64')).toHaveLength(28);
  expect(openWithKey(k, sealed)).toBeUndefined();
});

it('sanity: keys derived from distinct labels for the same secret differ', () => {
  const secret = randomBytes(32).toString('base64url');
  const a = key(`bananasaurs:assistant-provider:${secret}`);
  const b = key(`bananasaurs:account-password:${secret}`);
  expect(a.equals(b)).toBe(false);
});
