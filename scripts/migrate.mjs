// Applies pending migrations. Plain JS so it needs no build step of its own,
// but it imports the built storage package so migrations run against the same
// pragmas and the same single-writer guards the daemon uses.
//
//   npm run build && npm run db:migrate
import process from 'node:process';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from '../packages/storage/dist/db.js';

const dbPath = process.env.BANANASAURS_DB_PATH ?? './data/bananasaurs.db';

const opened = openDatabase({
  dbPath,
  onStaleReclaim: (reason) => console.warn(`reclaimed stale lock: ${reason}`),
});
try {
  migrate(opened.db, { migrationsFolder: './drizzle' });
  console.log(`migrations applied to ${dbPath}`);
} finally {
  opened.close();
}
