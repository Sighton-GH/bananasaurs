import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { openTestDatabase } from './db.js';
import { BACKUP_FILENAME_PATTERN, listBackups, performBackup, pruneBackups, sha256OfFile } from './backup.js';

let dir: string;
let db: ReturnType<typeof openTestDatabase>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnn-backup-'));
  db = openTestDatabase();
  db.raw.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT)');
  db.raw.prepare('INSERT INTO probe (v) VALUES (?)').run('hello');
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('performBackup', () => {
  it('produces a standalone, readable copy of the database', () => {
    const result = performBackup(db.raw, { destDir: dir });

    expect(fs.existsSync(result.path)).toBe(true);
    expect(BACKUP_FILENAME_PATTERN.test(result.fileName)).toBe(true);

    // Real proof, not a mock agreeing with itself: open the file independently
    // and read the row back.
    const reopened = new Database(result.path, { readonly: true });
    expect(reopened.prepare('SELECT v FROM probe').get()).toEqual({ v: 'hello' });
    reopened.close();

    // No -wal/-shm companions — the whole reason VACUUM INTO was chosen.
    expect(fs.readdirSync(dir).some((f) => f.endsWith('-wal') || f.endsWith('-shm'))).toBe(false);
  });

  it('writes a checksum sidecar that actually matches the file', () => {
    const result = performBackup(db.raw, { destDir: dir });

    const sidecar = fs.readFileSync(result.checksumPath, 'utf8');
    expect(sidecar).toBe(`${result.sha256}  ${result.fileName}\n`);

    const real = crypto.createHash('sha256').update(fs.readFileSync(result.path)).digest('hex');
    expect(result.sha256).toBe(real);
  });

  it('creates the destination directory when it does not exist yet', () => {
    const nested = path.join(dir, 'a', 'b', 'backups');
    const result = performBackup(db.raw, { destDir: nested });
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('names two backups in the same run distinctly and both survive', () => {
    const first = performBackup(db.raw, {
      destDir: dir,
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    });
    const second = performBackup(db.raw, {
      destDir: dir,
      now: () => new Date('2026-08-30T00:00:00.001Z'),
    });
    expect(first.fileName).not.toBe(second.fileName);
    expect(fs.existsSync(first.path)).toBe(true);
    expect(fs.existsSync(second.path)).toBe(true);
  });
});

describe('sha256OfFile', () => {
  it('matches a whole-file hash for a multi-chunk file', () => {
    // 2.5 MiB of random bytes: larger than one 1 MiB chunk, so the loop must
    // run more than once, and incompressible, so no shortcut hides a bug.
    const filePath = path.join(dir, 'big.bin');
    fs.writeFileSync(filePath, crypto.randomBytes(Math.floor(2.5 * 1024 * 1024)));

    const expected = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    expect(sha256OfFile(filePath)).toBe(expected);
  });

  it('matches a whole-file hash for an empty file', () => {
    const filePath = path.join(dir, 'empty.bin');
    fs.writeFileSync(filePath, Buffer.alloc(0));

    const expected = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    expect(sha256OfFile(filePath)).toBe(expected);
  });
});

describe('pruneBackups', () => {
  const at = (ms: number) => () => new Date(1_800_000_000_000 + ms);

  it('keeps the newest N and deletes the rest, checksum included', () => {
    const kept: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = performBackup(db.raw, { destDir: dir, now: at(i) });
      if (i >= 2) kept.push(r.fileName);
    }

    const removed = pruneBackups({ destDir: dir, retain: 3 });
    expect(removed).toHaveLength(2);

    const remaining = listBackups(dir).map((b) => b.fileName);
    expect(remaining.sort()).toEqual(kept.sort());
    for (const fileName of removed.map((r) => r.fileName)) {
      expect(fs.existsSync(path.join(dir, `${fileName}.sha256`))).toBe(false);
    }
  });

  it('does nothing when the count is at or under the retention limit', () => {
    performBackup(db.raw, { destDir: dir, now: at(0) });
    performBackup(db.raw, { destDir: dir, now: at(1) });
    const removed = pruneBackups({ destDir: dir, retain: 5 });
    expect(removed).toHaveLength(0);
    expect(listBackups(dir)).toHaveLength(2);
  });

  it('never touches a file that is not one of this scheme’s backups', () => {
    performBackup(db.raw, { destDir: dir, now: at(0) });
    performBackup(db.raw, { destDir: dir, now: at(1) });
    const strayPath = path.join(dir, 'operators-own-copy.db');
    fs.writeFileSync(strayPath, 'not managed by this scheme');

    pruneBackups({ destDir: dir, retain: 0 });

    expect(fs.existsSync(strayPath)).toBe(true);
    expect(listBackups(dir)).toHaveLength(0);
  });

  it('is a no-op against a destination directory that does not exist yet', () => {
    expect(pruneBackups({ destDir: path.join(dir, 'never-created'), retain: 3 })).toEqual([]);
  });
});

describe('listBackups', () => {
  it('is empty for a fresh directory and reports checksums honestly', () => {
    expect(listBackups(dir)).toEqual([]);

    const result = performBackup(db.raw, { destDir: dir });
    fs.rmSync(result.checksumPath);

    const [entry] = listBackups(dir);
    expect(entry?.hasChecksum).toBe(false);
    expect(entry?.sizeBytes).toBeGreaterThan(0);
  });

  it('parses the filename timestamp back into the moment it was taken', () => {
    const when = new Date('2026-08-30T15:37:02.123Z');
    performBackup(db.raw, { destDir: dir, now: () => when });
    const [entry] = listBackups(dir);
    expect(entry?.createdAt.toISOString()).toBe(when.toISOString());
  });
});
