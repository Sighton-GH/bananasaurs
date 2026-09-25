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

/**
 * Generic name: this resolution shape and the logic below are not specific
 * to the provider secret any more (ADR 0070 generalised it for the password
 * vault's own key file). Kept as an alias of `ProviderSecretResolution`
 * rather than a rename, so every existing caller of that type keeps
 * compiling untouched.
 */
export type SecretFileResolution = ProviderSecretResolution;

const readKeyFile = (file: string): SecretFileResolution => {
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
 * The key-encryption secret behind a named 0600 key file in
 * `BANANASAURS_DATA_DIR` (ADR 0061 §3, generalised by ADR 0070). The env
 * value wins; otherwise the key file is read, or created with `O_EXCL` and
 * mode 0600 on first run. Read-only mode never creates it.
 *
 * Two independent callers share this: `resolveProviderSecret` below (file
 * `assistant-provider.key`) and the password vault's `createPasswordVault`
 * (file `account-password.key`) — different files, so a secret resolved for
 * one never doubles as the other's.
 */
export const resolveSecretFile = (input: {
  readonly fileName: string;
  readonly envSecret: string | undefined;
  readonly dataDir: string;
  readonly readonly: boolean;
}): SecretFileResolution => {
  if (input.envSecret !== undefined) return { source: 'env', secret: input.envSecret };
  const file = path.join(input.dataDir, input.fileName);
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

/** One-line wrapper over `resolveSecretFile` for the assistant provider key, so every existing caller keeps compiling. */
export const resolveProviderSecret = (input: {
  readonly envSecret: string | undefined;
  readonly dataDir: string;
  readonly readonly: boolean;
}): ProviderSecretResolution => resolveSecretFile({ ...input, fileName: PROVIDER_SECRET_FILE });
