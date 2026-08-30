import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Backup and retention (ADR 0034, `docs/19` §6.12).
 *
 * `VACUUM INTO` rather than a file copy: it is safe while the daemon holds the
 * database open in WAL mode and produces one consistent file with no
 * `-wal`/`-shm` companions to forget. Measured directly against
 * better-sqlite3 13 before writing this: the destination directory is not
 * created for you (a missing parent fails with the same "unable to open
 * database" error as a permissions problem, so `mkdirSync` runs first), and
 * the statement refuses to overwrite an existing destination file rather than
 * replacing it — which is why a millisecond-precision filename is enough to
 * make collisions unreachable rather than merely unlikely.
 *
 * Instance-level, deliberately: this file is the whole process's database,
 * not any one guild's rows, so nothing here takes a `GuildScope` and nothing
 * here is a `jobs` row (see ADR 0034 for why a per-guild job would be wrong
 * even with one guild configured).
 */

/** `bananasaurs-20260830T153702123Z.db` — sorts lexically in creation order. */
export const BACKUP_FILENAME_PATTERN = /^bananasaurs-(\d{8}T\d{9}Z)\.db$/;

const checksumSuffix = '.sha256';

export interface BackupOptions {
  readonly destDir: string;
  /** Injectable for tests; defaults to the real clock. */
  readonly now?: () => Date;
}

export interface BackupResult {
  readonly fileName: string;
  readonly path: string;
  readonly checksumPath: string;
  readonly sizeBytes: number;
  /** Hex digest, also written to `checksumPath` in `sha256sum`-compatible form. */
  readonly sha256: string;
}

export function performBackup(raw: Database.Database, options: BackupOptions): BackupResult {
  const now = options.now ?? (() => new Date());
  const destDir = path.resolve(options.destDir);
  fs.mkdirSync(destDir, { recursive: true });

  const fileName = `bananasaurs-${formatBackupTimestamp(now())}.db`;
  const destPath = path.join(destDir, fileName);

  raw.prepare('VACUUM INTO ?').run(destPath);

  const sha256 = sha256Of(destPath);
  const checksumPath = `${destPath}${checksumSuffix}`;
  // The format `sha256sum` itself emits, so a human can verify with coreutils
  // alone on a box where nothing in this repository is importable — the exact
  // scenario a restore happens in.
  fs.writeFileSync(checksumPath, `${sha256}  ${fileName}\n`);

  return {
    fileName,
    path: destPath,
    checksumPath,
    sizeBytes: fs.statSync(destPath).size,
    sha256,
  };
}

export interface PruneOptions {
  readonly destDir: string;
  readonly retain: number;
}

export interface PrunedBackup {
  readonly fileName: string;
}

/**
 * Keeps the newest `retain` backups this scheme produced and deletes the rest,
 * checksum sidecar included. Anything in `destDir` that does not match
 * {@link BACKUP_FILENAME_PATTERN} — an operator's own copy, a stray file — is
 * never touched: a sweep that deleted by age over the whole directory would
 * eventually remove something a human put there on purpose.
 */
export function pruneBackups(options: PruneOptions): readonly PrunedBackup[] {
  const destDir = path.resolve(options.destDir);
  const files = listBackupFileNames(destDir);
  const excess = files.length - options.retain;
  if (excess <= 0) return [];

  const toRemove = files.slice(0, excess);
  for (const fileName of toRemove) {
    fs.rmSync(path.join(destDir, fileName), { force: true });
    fs.rmSync(path.join(destDir, `${fileName}${checksumSuffix}`), { force: true });
  }
  return toRemove.map((fileName) => ({ fileName }));
}

export interface BackupListing {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly createdAt: Date;
  readonly hasChecksum: boolean;
}

/** Every backup this scheme produced, oldest first. Used by `backup list` and `doctor`. */
export function listBackups(destDir: string): readonly BackupListing[] {
  const resolved = path.resolve(destDir);
  return listBackupFileNames(resolved).map((fileName) => {
    const full = path.join(resolved, fileName);
    return {
      fileName,
      sizeBytes: fs.statSync(full).size,
      createdAt: parseBackupTimestamp(fileName),
      hasChecksum: fs.existsSync(`${full}${checksumSuffix}`),
    };
  });
}

function listBackupFileNames(destDir: string): string[] {
  if (!fs.existsSync(destDir)) return [];
  return fs
    .readdirSync(destDir)
    .filter((name) => BACKUP_FILENAME_PATTERN.test(name))
    .sort();
}

function sha256Of(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function formatBackupTimestamp(date: Date): string {
  // "2026-08-30T15:37:02.123Z" -> "20260830T153702123Z"
  return date.toISOString().replace(/[-:]/g, '').replace('.', '');
}

const PREFIX = 'bananasaurs-';
const SUFFIX = '.db';

function parseBackupTimestamp(fileName: string): Date {
  if (!BACKUP_FILENAME_PATTERN.test(fileName)) {
    // Unreachable through listBackupFileNames, which already filtered on this
    // pattern. Thrown rather than returning an invalid Date so a future caller
    // that stops filtering first fails loudly instead of sorting nonsense.
    throw new Error(`not a backup filename: ${fileName}`);
  }
  // Fixed-width by construction (formatBackupTimestamp), so plain slicing is
  // exact and needs no capture-group indexing.
  const body = fileName.slice(PREFIX.length, fileName.length - SUFFIX.length);
  const datePart = body.slice(0, 8); // YYYYMMDD
  const timePart = body.slice(9, 18); // skip the literal "T"; HHMMSSmmm

  const iso =
    `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}T` +
    `${timePart.slice(0, 2)}:${timePart.slice(2, 4)}:${timePart.slice(4, 6)}.${timePart.slice(6, 9)}Z`;
  return new Date(iso);
}
