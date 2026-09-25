import { createHash } from 'node:crypto';
import { resolveSecretFile } from '../assistant/provider-secret.js';
import { openWithKey, sealWithKey } from '../crypto/seal.js';

/** File name inside `BANANASAURS_DATA_DIR`; not inside the database, so never in a backup. */
export const ACCOUNT_PASSWORD_KEY_FILE = 'account-password.key';

const keyFrom = (secret: string): Buffer =>
  createHash('sha256').update(`bananasaurs:account-password:${secret}`, 'utf8').digest();

/**
 * The sealed copy of a non-owner dashboard account's password, so the owner
 * can reveal it after re-authenticating (ADR 0070, spec A4).
 *
 * The Argon2id hash on `dashboard_accounts.password_hash` stays the only
 * sign-in authority — this is a second, separate ciphertext kept only for
 * reveal, opened only by the owner, and only over HTTP with a fresh reauth.
 * `available: false` is a normal, expected state (no `ACCOUNT_PASSWORD_SECRET_KEY`
 * and no usable key file yet): `seal`/`open` are never called in that state
 * by the wiring that owns this vault, but `seal` still throws defensively
 * rather than silently discarding a password, and `open` returns `undefined`
 * rather than throwing, matching every other "does this open" answer in the
 * tree.
 */
export interface PasswordVault {
  seal(password: string): string;
  /** `undefined` when the key does not open it (wrong key, or not this vault's ciphertext). */
  open(sealed: string): string | undefined;
  readonly available: boolean;
  /**
   * Where the sealing key resolved from (`resolveSecretFile`'s answer), so
   * `doctor` can name it without re-stating the file. Absent on hand-built
   * test doubles, which predate the field and always mean "no opinion".
   */
  readonly source?: 'env' | 'file' | 'missing' | undefined;
}

/**
 * The vault for "no usable key": `seal` throws defensively rather than
 * silently discarding a password, `open` answers `undefined` rather than
 * throwing, matching every other "does this open" answer in the tree.
 * Shared by `createPasswordVault`'s `missing` branch and the daemon's
 * env-only fallback, so the two cannot drift apart again.
 */
export const unavailableVault = (reason: string): PasswordVault => ({
  available: false,
  source: 'missing',
  seal: () => {
    // Callers check `available` first (`accountCreate`/`accountSetPassword`
    // in `ops/wiring.ts` store `null` instead of calling this) — reaching
    // this is a caller bug, not a runtime condition to answer quietly.
    throw new Error(`password vault unavailable: ${reason}`);
  },
  open: () => undefined,
});

export const createPasswordVault = (input: {
  readonly envSecret: string | undefined;
  readonly dataDir: string;
  readonly readonly: boolean;
}): PasswordVault => {
  const resolution = resolveSecretFile({
    fileName: ACCOUNT_PASSWORD_KEY_FILE,
    envSecret: input.envSecret,
    dataDir: input.dataDir,
    readonly: input.readonly,
  });
  if (resolution.source === 'missing') {
    return unavailableVault(resolution.reason);
  }
  const key = keyFrom(resolution.secret);
  return {
    available: true,
    source: resolution.source,
    seal: (password) => sealWithKey(key, password),
    open: (sealed) => openWithKey(key, sealed),
  };
};
