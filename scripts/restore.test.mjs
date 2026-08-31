// Automated regression coverage for the restore drill (ADR 0034). A one-off
// manual rehearsal proved the mechanism works once; this is what keeps it
// working. Runs `scripts/restore.mjs` as a real child process against a
// synthetic database — never against `./data` or `./backups`, which this
// repository's own `.claude/settings.json` denies reading, deliberately,
// because they can hold real Discord content.
//
// Depends on `packages/storage/dist/` existing, exactly as `scripts/migrate.mjs`
// does — `npm run typecheck`'s `tsc --build` emits it, and CI runs typecheck
// before test.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from '../packages/storage/dist/db.js';
import { performBackup } from '../packages/storage/dist/backup.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const RESTORE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'restore.mjs');
const MIGRATIONS = path.join(REPO_ROOT, 'drizzle');

let root;
let dbPath;
let backupDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bnn-restore-drill-'));
  dbPath = path.join(root, 'db-dir', 'drill.db');
  backupDir = path.join(root, 'backups');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const seed = (opened, guildId, name) => {
  opened.raw
    .prepare(`INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, ?, 0, 0)`)
    .run(guildId, name);
};

/** An external, readonly observer — never `openDatabase`, so it cannot itself
 * trip the single-writer-per-process guard the lock-refusal test exercises. */
const readGuildNames = (path_) => {
  const db = new Database(path_, { readonly: true });
  try {
    return db
      .prepare('SELECT name FROM guilds ORDER BY guild_id')
      .all()
      .map((r) => r.name);
  } finally {
    db.close();
  }
};

const seedAndBackup = () => {
  const opened = openDatabase({ dbPath });
  migrate(opened.db, { migrationsFolder: MIGRATIONS });
  seed(opened, '111111111111111111', 'content-A');
  opened.close();

  const held = openDatabase({ dbPath });
  const backup = performBackup(held.raw, { destDir: backupDir });
  held.close();
  return backup;
};

const mutate = () => {
  const opened = openDatabase({ dbPath });
  seed(opened, '222222222222222222', 'content-A-plus');
  opened.close();
};

const run = (args, env = {}) => {
  const result = spawnSync('node', [RESTORE_SCRIPT, ...args], {
    env: {
      ...process.env,
      BANANASAURS_DB_PATH: dbPath,
      BANANASAURS_BACKUP_DIR: backupDir,
      ...env,
    },
    encoding: 'utf8',
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
};

describe('scripts/restore.mjs', () => {
  it('without --confirm, changes nothing', () => {
    const backup = seedAndBackup();
    mutate();

    const result = run([backup.fileName]);

    expect(result.code).toBe(0);
    expect(result.out).toContain('Dry run only');
    expect(readGuildNames(dbPath)).toEqual(['content-A', 'content-A-plus']);
  });

  it('refuses while another process holds the database lock, and changes nothing', () => {
    const backup = seedAndBackup();
    mutate();
    const held = openDatabase({ dbPath }); // stands in for a running daemon

    const result = run([backup.fileName, '--confirm']);

    expect(result.code).toBe(1);
    expect(result.out).toMatch(/already open by another Bananasaurs process/);
    expect(readGuildNames(dbPath)).toEqual(['content-A', 'content-A-plus']);
    held.close();
  });

  it('refuses a backup whose checksum does not match, and changes nothing', () => {
    const backup = seedAndBackup();
    mutate();
    const sidecar = `${path.join(backupDir, backup.fileName)}.sha256`;
    const original = fs.readFileSync(sidecar, 'utf8');
    fs.writeFileSync(
      sidecar,
      original.replace(/^[0-9a-f]/, (c) => (c === '0' ? '1' : '0')),
    );

    const result = run([backup.fileName, '--confirm']);

    expect(result.code).toBe(1);
    expect(result.out).toMatch(/checksum mismatch/);
    expect(readGuildNames(dbPath)).toEqual(['content-A', 'content-A-plus']);
  });

  it('restores the backup content when the lock is free and the checksum matches', () => {
    const backup = seedAndBackup();
    mutate();

    const result = run([backup.fileName, '--confirm']);

    expect(result.code).toBe(0);
    expect(result.out).toContain('Restored.');
    expect(readGuildNames(dbPath)).toEqual(['content-A']);
  });

  it('moves the pre-restore database aside rather than deleting it', () => {
    const backup = seedAndBackup();
    mutate();
    const beforeRestore = readGuildNames(dbPath);

    run([backup.fileName, '--confirm']);

    const asideFiles = fs
      .readdirSync(path.dirname(dbPath))
      .filter((f) => f.includes('pre-restore') && !f.endsWith('-wal') && !f.endsWith('-shm'));
    expect(asideFiles).toHaveLength(1);
    expect(readGuildNames(path.join(path.dirname(dbPath), asideFiles[0]))).toEqual(beforeRestore);
  });

  it('warns but proceeds when the checksum sidecar is missing', () => {
    const backup = seedAndBackup();
    fs.rmSync(`${path.join(backupDir, backup.fileName)}.sha256`);

    const result = run([backup.fileName, '--confirm']);

    expect(result.code).toBe(0);
    expect(result.out).toMatch(/WARNING: no checksum sidecar/);
    expect(readGuildNames(dbPath)).toEqual(['content-A']);
  });

  it('resolves a bare filename against BANANASAURS_BACKUP_DIR', () => {
    const backup = seedAndBackup();
    // No directory separator in the argument — proves it isn't just accepting
    // a path relative to the current working directory by accident.
    expect(backup.fileName).not.toContain('/');
    const result = run([backup.fileName, '--confirm']);
    expect(result.code).toBe(0);
  });

  it('refuses a nonexistent backup file rather than doing anything', () => {
    seedAndBackup();
    const result = run(['does-not-exist.db', '--confirm']);
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/no such backup file/);
  });

  it('requires exactly one positional argument', () => {
    const result = run([]);
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/usage:/);
  });
});
