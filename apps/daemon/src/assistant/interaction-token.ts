import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Seals Discord interaction tokens before they touch the durable job table
 * (independent audit, SECURITY).
 *
 * An interaction token is a bearer credential: anyone holding it can answer
 * the deferred interaction. The B2 job split needs it across an enqueue, but
 * `jobs.payload` is durable, listed by the ops ports, and visible on the
 * dashboard Jobs page - so the token itself must never be stored there.
 *
 * The key is random per process and lives only in memory. Consequences,
 * deliberately accepted:
 *
 * - a queue row holds ciphertext, useless to anyone reading the database;
 * - after a restart the key is gone, so a stranded assistant job cannot be
 *   answered through the old interaction - the handler fails it closed with
 *   a log line. The token would have expired 15 minutes after the defer
 *   anyway, so durability beyond the process buys nothing;
 * - no key material is configured, persisted, backed up, or rotated.
 */
export interface InteractionTokenSealer {
  seal(token: string): string;
  /** `undefined` when the ciphertext is not this process's - fail closed. */
  open(sealed: string): string | undefined;
}

export const createInteractionTokenSealer = (
  key: Buffer = randomBytes(32),
): InteractionTokenSealer => ({
  seal(token) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
  },
  open(sealed) {
    try {
      const raw = Buffer.from(sealed, 'base64');
      if (raw.length < 12 + 16 + 1) return undefined;
      const nonce = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const ciphertext = raw.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      return undefined;
    }
  },
});
