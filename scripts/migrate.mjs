// Applies pending migrations. Plain JS so it needs no build step of its own,
// but it imports the built storage package so migrations run against the same
// pragmas and the same single-writer guards the daemon uses.
//
//   npm run build && npm run db:migrate
import process from 'node:process';
import { openDatabase, runMigrations } from '../packages/storage/dist/db.js';

const dbPath = process.env.BANANASAURS_DB_PATH ?? './data/bananasaurs.db';

const opened = openDatabase({
  dbPath,
  onStaleReclaim: (reason) => console.warn(`reclaimed stale lock: ${reason}`),
});
try {
  runMigrations(opened.raw, opened.db, './drizzle');
  console.log(`migrations applied to ${dbPath}`);
} finally {
  opened.close();
}
