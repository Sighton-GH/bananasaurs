import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resolveProviderSecret, PROVIDER_SECRET_FILE } from './provider-secret.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bananasaurs-secret-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('prefers the environment value and never touches the file', () => {
  const result = resolveProviderSecret({
    envSecret: 'e'.repeat(32),
    dataDir: dir,
    readonly: false,
  });
  expect(result).toEqual({ secret: 'e'.repeat(32), source: 'env' });
  expect(() => statSync(path.join(dir, PROVIDER_SECRET_FILE))).toThrow();
});

it('creates a 0600 key file on first run and reuses it after', () => {
  const first = resolveProviderSecret({ envSecret: undefined, dataDir: dir, readonly: false });
  expect(first.source).toBe('file');
  const file = path.join(dir, PROVIDER_SECRET_FILE);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url')).toHaveLength(32);
  const second = resolveProviderSecret({ envSecret: undefined, dataDir: dir, readonly: false });
  expect(second).toEqual(first);
  expect(first.source === 'file' && first.secret.length).toBeGreaterThanOrEqual(32);
});

it('refuses a key file other users can read', () => {
  const file = path.join(dir, PROVIDER_SECRET_FILE);
  writeFileSync(file, Buffer.alloc(32, 1).toString('base64url'));
  chmodSync(file, 0o644);
  expect(resolveProviderSecret({ envSecret: undefined, dataDir: dir, readonly: false })).toEqual({
    source: 'missing',
    reason: 'key-file-permissions',
  });
});

it('refuses a key file that is too short', () => {
  const file = path.join(dir, PROVIDER_SECRET_FILE);
  writeFileSync(file, 'short', { mode: 0o600 });
  expect(resolveProviderSecret({ envSecret: undefined, dataDir: dir, readonly: false })).toEqual({
    source: 'missing',
    reason: 'key-file-invalid',
  });
});

it('reads but never creates the file in read-only mode', () => {
  expect(resolveProviderSecret({ envSecret: undefined, dataDir: dir, readonly: true })).toEqual({
    source: 'missing',
    reason: 'readonly-no-key-file',
  });
  expect(() => statSync(path.join(dir, PROVIDER_SECRET_FILE))).toThrow();
});

it('creates the data directory when it does not exist yet', () => {
  const nested = path.join(dir, 'not', 'yet');
  expect(
    resolveProviderSecret({ envSecret: undefined, dataDir: nested, readonly: false }).source,
  ).toBe('file');
});
