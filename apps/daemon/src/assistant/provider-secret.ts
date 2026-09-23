import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

/** File name inside `BANANASAURS_DATA_DIR`; not inside the database, so never in a backup. */
export const PROVIDER_SECRET_FILE = 'assistant-provider.key';

export type ProviderSecretResolution =
  | { readonly source: 'env' | 'file'; readonly secret: string }
  | {
      readonly source: 'missing';
      readonly reason: 'key-file-permissions' | 'key-file-invalid' | 'readonly-no-key-file';
    };

const readKeyFile = (file: string): ProviderSecretResolution => {
  // Group- or world-readable means someone else on the host may already hold
  // it; refusing is louder than using a secret that is not one.
  if ((statSync(file).mode & 0o077) !== 0)
    return { source: 'missing', reason: 'key-file-permissions' };
  const secret = readFileSync(file, 'utf8').trim();
  if (Buffer.from(secret, 'base64url').length < 32)
    return { source: 'missing', reason: 'key-file-invalid' };
  return { source: 'file', secret };
};

/**
 * The key-encryption secret for dashboard-entered provider keys (ADR 0061 §3).
 * `ASSISTANT_PROVIDER_SECRET_KEY` wins; otherwise the key file is read, or
 * created with `O_EXCL` and mode 0600 on first run. Read-only mode never
 * creates it.
 */
export const resolveProviderSecret = (input: {
  readonly envSecret: string | undefined;
  readonly dataDir: string;
  readonly readonly: boolean;
}): ProviderSecretResolution => {
  if (input.envSecret !== undefined) return { source: 'env', secret: input.envSecret };
  const file = path.join(input.dataDir, PROVIDER_SECRET_FILE);
  try {
    return readKeyFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (input.readonly) return { source: 'missing', reason: 'readonly-no-key-file' };
  mkdirSync(input.dataDir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('base64url');
  let fd: number;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (err) {
    // Lost a race with another creator: theirs is the key.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return readKeyFile(file);
    throw err;
  }
  try {
    writeSync(fd, `${secret}\n`);
  } finally {
    closeSync(fd);
  }
  return { source: 'file', secret };
};
