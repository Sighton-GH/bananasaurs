import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sealWithKey } from '../crypto/seal.js';
import { ACCOUNT_PASSWORD_KEY_FILE, createPasswordVault } from './password-vault.js';

/**
 * Mirrors `apps/daemon/src/assistant/provider-secret.test.ts`: same key-file
 * behaviour (0600, O_EXCL, refuse loose permissions, env wins, read-only
 * never creates), because `createPasswordVault` is built on the same
 * `resolveSecretFile`. Plus the vault's own contract: seal/open round-trip,
 * a wrong secret cannot open a sealed value, and the key derivation label is
 * distinct from `provider-config.ts`'s (ADR 0070).
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bananasaurs-vault-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('prefers the environment value and never touches the file', () => {
  const vault = createPasswordVault({ envSecret: 'e'.repeat(32), dataDir: dir, readonly: false });
  expect(vault.available).toBe(true);
  expect(() => statSync(path.join(dir, ACCOUNT_PASSWORD_KEY_FILE))).toThrow();
});

it('creates a 0600 key file on first run and reuses it after', () => {
  const first = createPasswordVault({ envSecret: undefined, dataDir: dir, readonly: false });
  expect(first.available).toBe(true);
  const file = path.join(dir, ACCOUNT_PASSWORD_KEY_FILE);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url')).toHaveLength(32);

  // A second vault built afterward reuses the same key file, so a value
  // sealed by the first opens under the second.
  const second = createPasswordVault({ envSecret: undefined, dataDir: dir, readonly: false });
  expect(second.available).toBe(true);
  expect(second.open(first.seal('hunter2'))).toBe('hunter2');
});

it('refuses a key file other users can read', () => {
  const file = path.join(dir, ACCOUNT_PASSWORD_KEY_FILE);
  writeFileSync(file, Buffer.alloc(32, 1).toString('base64url'));
  chmodSync(file, 0o644);
  const vault = createPasswordVault({ envSecret: undefined, dataDir: dir, readonly: false });
  expect(vault.available).toBe(false);
  expect(vault.open('anything')).toBeUndefined();
});

it('refuses a key file that is too short', () => {
  const file = path.join(dir, ACCOUNT_PASSWORD_KEY_FILE);
  writeFileSync(file, 'short', { mode: 0o600 });
  expect(
    createPasswordVault({ envSecret: undefined, dataDir: dir, readonly: false }).available,
  ).toBe(false);
});

it('reads but never creates the file in read-only mode', () => {
  const vault = createPasswordVault({ envSecret: undefined, dataDir: dir, readonly: true });
  expect(vault.available).toBe(false);
  expect(() => statSync(path.join(dir, ACCOUNT_PASSWORD_KEY_FILE))).toThrow();
});

it('creates the data directory when it does not exist yet', () => {
  const nested = path.join(dir, 'not', 'yet');
  expect(
    createPasswordVault({ envSecret: undefined, dataDir: nested, readonly: false }).available,
  ).toBe(true);
});

it('unavailable vault: seal throws, open always returns undefined', () => {
  const vault = createPasswordVault({ envSecret: undefined, dataDir: dir, readonly: true });
  expect(vault.available).toBe(false);
  expect(() => vault.seal('pw')).toThrow();
  expect(vault.open('anything')).toBeUndefined();
});

it('opens exactly what it sealed', () => {
  const vault = createPasswordVault({ envSecret: 's'.repeat(32), dataDir: dir, readonly: false });
  expect(vault.open(vault.seal('correct horse battery staple'))).toBe(
    'correct horse battery staple',
  );
});

it('a vault built from a different secret cannot open a value this one sealed', () => {
  const a = createPasswordVault({ envSecret: 'a'.repeat(32), dataDir: dir, readonly: false });
  const b = createPasswordVault({ envSecret: 'b'.repeat(32), dataDir: dir, readonly: false });
  expect(b.open(a.seal('pw'))).toBeUndefined();
});

it("the key derivation label is bananasaurs:account-password:, distinct from provider-config.ts's bananasaurs:assistant-provider: label", () => {
  const secret = 's'.repeat(32);
  const vault = createPasswordVault({ envSecret: secret, dataDir: dir, readonly: false });
  // The same value, sealed under the provider-config key derived from the
  // SAME secret string, must not open under the vault: the labels differ, so
  // the derived keys differ even when the underlying secret is identical.
  const providerKey = createHash('sha256')
    .update(`bananasaurs:assistant-provider:${secret}`, 'utf8')
    .digest();
  const sealedUnderProviderKey = sealWithKey(providerKey, 'not for the vault');
  expect(vault.open(sealedUnderProviderKey)).toBeUndefined();
});
