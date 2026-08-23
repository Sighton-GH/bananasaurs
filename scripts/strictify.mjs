// Rewrites drizzle-kit's generated migrations so every CREATE TABLE is STRICT.
//
// drizzle-kit cannot emit STRICT and there is no configuration flag for it, but
// migrations are plain SQL and editing them is fine. Doing it here rather than
// by hand means a regenerated migration is correct by default instead of
// correct only when someone remembers. The backstop is the schema invariant
// test, which reads the live database and fails the build on any table that is
// not STRICT — so if this script is ever bypassed, the build says so.
//
// Why STRICT is worth the tooling: without it SQLite accepts 'lots' into an
// INTEGER column and stores it as text. It does NOT protect snowflakes, which
// is a common misreading — STRICT permits lossless INTEGER/REAL-to-TEXT
// conversion exactly as affinity does. Snowflakes are guarded at the parse
// boundary by parseSnowflakeId() and on the write path by the snowflake()
// column's toDriver.
//
// Runs as part of `npm run db:generate`. Idempotent.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const folder = process.argv[2] ?? './drizzle';
const journalPath = path.join(folder, 'meta', '_journal.json');

if (!fs.existsSync(journalPath)) {
  console.error(`strictify: no journal at ${journalPath}`);
  process.exit(1);
}

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));

// A CREATE TABLE we generated. Virtual tables (FTS5) cannot be STRICT, and
// drizzle's own __drizzle_migrations table is created by the migrator rather
// than by a file, so neither appears here.
const isPlainCreateTable = (statement) =>
  /^\s*CREATE\s+TABLE\b/i.test(statement) && !/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(statement);

const alreadyStrict = (statement) => /\bSTRICT\s*;?\s*$/i.test(statement);

// The final ')' of the statement is the table's closing paren; anything after
// it is only an optional ';' and whitespace.
const addStrict = (statement) => statement.replace(/\)(\s*);?(\s*)$/, ') STRICT;$2');

let changedFiles = 0;
let changedTables = 0;

for (const entry of journal.entries) {
  const file = path.join(folder, `${entry.tag}.sql`);
  if (!fs.existsSync(file)) {
    console.error(`strictify: journal names ${entry.tag} but ${file} is missing`);
    process.exit(1);
  }

  const original = fs.readFileSync(file, 'utf8');
  let tablesHere = 0;

  const rewritten = original
    .split('--> statement-breakpoint')
    .map((statement) => {
      if (!isPlainCreateTable(statement) || alreadyStrict(statement)) return statement;
      tablesHere += 1;
      return addStrict(statement);
    })
    .join('--> statement-breakpoint');

  if (rewritten !== original) {
    fs.writeFileSync(file, rewritten);
    changedFiles += 1;
    changedTables += tablesHere;
    console.log(`strictify: ${entry.tag}.sql — ${tablesHere} table(s) made STRICT`);
  }
}

console.log(
  changedFiles === 0
    ? 'strictify: every CREATE TABLE was already STRICT'
    : `strictify: rewrote ${changedFiles} file(s), ${changedTables} table(s)`,
);
