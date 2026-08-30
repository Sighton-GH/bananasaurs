// The restore drill (ADR 0034, docs/19 §6.12): stop the service, move the
// current database aside — never delete — copy a backup in, start, run
// `bananasaurs doctor`. This script is steps 2 and 3; a human does 1 and 4.
//
// Deliberately NOT reachable over the operator socket. `backup now` is safe
// to run against a live daemon because VACUUM INTO is; a restore is the
// opposite by construction — it replaces the file the daemon has open, which
// is exactly what the single-writer guard exists to make impossible. So this
// refuses to proceed at all while a daemon holds the database, using the same
// lock file the daemon itself claims at startup rather than reinventing a
// weaker check.
//
//   node scripts/restore.mjs <backup-file> --confirm
//
// <backup-file> may be a bare filename (resolved against BANANASAURS_BACKUP_DIR)
// or a path. Without --confirm, prints what would happen and changes nothing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { claimDatabaseLock, DatabaseLockedError } from '../packages/storage/dist/lock.js';

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const positional = args.filter((a) => a !== '--confirm');

if (positional.length !== 1) {
  console.error('usage: node scripts/restore.mjs <backup-file> [--confirm]');
  process.exit(2);
}

const dbPath = path.resolve(process.env.BANANASAURS_DB_PATH ?? './data/bananasaurs.db');
const backupDir = path.resolve(process.env.BANANASAURS_BACKUP_DIR ?? './backups');

const requested = positional[0];
const backupPath = path.isAbsolute(requested) ? requested : path.resolve(backupDir, requested);

if (!fs.existsSync(backupPath)) {
  console.error(`no such backup file: ${backupPath}`);
  process.exit(2);
}

// Verified when the sidecar exists; warned about, not refused, when it does
// not — an operator restoring from a manually copied file has already made
// the decision this check exists to inform, not to override.
const checksumPath = `${backupPath}.sha256`;
if (fs.existsSync(checksumPath)) {
  const recorded = fs.readFileSync(checksumPath, 'utf8').split(/\s+/, 1)[0];
  const actual = crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
  if (recorded !== actual) {
    console.error(
      `checksum mismatch for ${backupPath}\n` +
        `  recorded: ${recorded}\n` +
        `  actual:   ${actual}\n` +
        `This backup file does not match its checksum and will not be restored.`,
    );
    process.exit(1);
  }
  console.log(`checksum verified: ${actual}`);
} else {
  console.warn(`WARNING: no checksum sidecar at ${checksumPath} — proceeding unverified.`);
}

const asideBase = `${dbPath}.pre-restore-${new Date().toISOString().replace(/[-:]/g, '').replace('.', '')}`;

console.log(`Will restore ${backupPath}`);
console.log(`  into:  ${dbPath}`);
console.log(`  current database (and any -wal/-shm) moved aside to: ${asideBase}*`);
console.log('  the current database is moved, never deleted.');

if (!confirm) {
  console.log('\nDry run only — re-run with --confirm to actually restore.');
  process.exit(0);
}

// The same guard the daemon claims at startup (packages/storage/src/lock.ts),
// keyed to the same database path. A live daemon holds this, so claiming it
// here is the refusal this script needs — reusing the real mechanism rather
// than reimplementing a weaker version of "is the daemon running".
let lock;
try {
  lock = claimDatabaseLock(`${dbPath}.lock`, {
    onStaleReclaim: (reason) => console.warn(`reclaimed a stale lock: ${reason}`),
  });
} catch (err) {
  if (err instanceof DatabaseLockedError) {
    console.error(
      `Refusing to restore: ${err.message}\n\nStop the daemon first (systemctl stop bananasaurs), then re-run this command.`,
    );
    process.exit(1);
  }
  throw err;
}

try {
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${dbPath}${suffix}`;
    if (fs.existsSync(source)) {
      fs.renameSync(source, `${asideBase}${suffix}`);
    }
  }
  fs.copyFileSync(backupPath, dbPath);
  console.log(`\nRestored. Start the daemon, then run: bananasaurs doctor`);
} finally {
  lock.release();
}
