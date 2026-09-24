import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM seal/open over an already-derived key.
 *
 * Moved out of `assistant/provider-config.ts` (ADR 0070) so the password
 * vault (`ops/password-vault.ts`) can share the same primitive without
 * either module depending on the other. Each caller derives its own key
 * from its own label (`provider-config.ts`'s `keyFrom` uses
 * `bananasaurs:assistant-provider:`, the vault's uses
 * `bananasaurs:account-password:`) — this module knows nothing about
 * labels, so a value sealed under one key never opens under another, even
 * if the two ever shared a master secret.
 *
 * Wire format: 12-byte nonce + 16-byte auth tag + ciphertext, base64.
 */
export const sealWithKey = (key: Buffer, value: string): string => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
};

/** Returns `undefined` for a malformed value or one that does not open under `key` — never throws. */
export const openWithKey = (key: Buffer, value: string): string | undefined => {
  try {
    const raw = Buffer.from(value, 'base64');
    if (raw.length < 29) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
};
