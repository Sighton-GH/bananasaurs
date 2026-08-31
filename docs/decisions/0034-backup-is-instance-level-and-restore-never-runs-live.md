# 0034 — Backup is an instance-level timer, not a guild job; restore never runs against a live daemon

Status: accepted
Date: 2026-08-30
Depends on `docs/19` §6.12 (mechanism and destination already decided: `VACUUM
INTO`, local path, decision 4), ADR 0020 (composition root owns the database
handle), ADR 0027 (instance-level storage scope), ADR 0026 (unbounded work is a
job, not a socket-blocking call).
Constrained by `CLAUDE.md` rules 2 (guild scope), 4 (no secrets in diagnostics)
and `docs/20`'s WP6 gate: "a restore has actually been performed, not just
written down."

## Context

`docs/19` §6.12 already settled *what* backup and restore are: `VACUUM INTO` on
a timer, local path, checksummed, retained N deep; restore is a documented drill
that stops the service, moves the current file aside, copies the backup in,
starts, and runs `doctor`. What it left open is *where this code lives* and
*how it is triggered* — WP6 is the slice that has to answer that, and the
answer is not obvious by analogy to anything else in the codebase, because
nothing else in Release 1 acts on the database file as a whole rather than on
guild-scoped rows inside it.

Two measurements shaped this decision, done before writing any code:

1. **`VACUUM INTO` does not create its destination directory.** Pointing it at
   a path whose parent does not exist fails with `unable to open database:
   <path>` — the same error SQLite gives for a permissions problem, so the
   backup code has to `mkdir(dirname, { recursive: true })` itself and cannot
   rely on the statement to do it, the way `openDatabase` already does for the
   main database path.
2. **`VACUUM INTO` refuses to overwrite an existing file** ("output file
   already exists") rather than silently replacing it. This is a gift, not an
   obstacle: it means the filename scheme is itself a guard against a second
   backup clobbering the first, provided names do not collide, and it means
   the failure mode of a naming bug is a loud error rather than quiet data
   loss.

## Decision

### Backup is instance-level, not a guild-partitioned job

`jobs` is guild-scoped by construction (WP2 slice 4b: the claim index is
`(guild_id, state, run_after)`, and every handler runs inside one guild's
`GuildScope`). A backup is not a fact about any guild — it is a copy of the one
SQLite file the whole process shares, `guilds` table and all. Enqueuing it as a
per-guild job would mean either running it once per allowlisted guild (running
the same `VACUUM INTO` against the same file N times because N guilds happen to
be configured — the exact kind of latent multiplication the job-dedupe defect in
`docs/decisions/0016` already burned this project once) or picking one guild
arbitrarily to "own" it, which is a fiction with no referent.

So the backup timer is a second `setInterval` in `apps/daemon`'s composition
layer, sibling to the existing job-poll timer in `daemon.ts` rather than nested
inside it, unref'd the same way so it cannot by itself keep the process alive,
and constructed once per process regardless of how many guilds are allowlisted.
It is given the raw `better-sqlite3` handle directly — not a `GuildScope` — for
the same reason `redactedConfig()` and `reissueBootstrapToken()` sit on
`OpsInstance` rather than `OpsPorts` (ADR 0027): there is no guild in the
question.

### The backup module lives in `packages/storage`, not `apps/daemon`

`performBackup` needs the raw `Database` handle, which `packages/core` and
`apps/daemon` are not supposed to reach directly (ADR 0014's boundary is "the
handle is unreachable outside the storage package"; `apps/daemon` is the
exception for construction, not for reaching into SQLite internals it doesn't
own). Backup is a storage-layer operation on the storage-layer's own resource,
so `performBackup` and `pruneBackups` are exported from `@bananasaurs/storage`
and the daemon only calls them on a timer — it does not touch `raw` itself.

### Filename is the sort key; checksum is a sidecar, not a database row

`bananasaurs-<UTC-ISO-basic-with-ms>.db`, e.g.
`bananasaurs-20260830T153702123Z.db`. Millisecond precision makes a same-tick
collision unreachable at any interval this system would ever configure, and
lexical sort on the filename equals chronological order — retention ("keep the
newest N") is `readdir` + `sort` + slice, with no `stat` call and no parsing.

The checksum is a sibling `<name>.db.sha256` file holding the plain hex digest
in the format `sha256sum` itself emits (`<hex>  <filename>`), not a row in any
table. A backup must be verifiable by a human with coreutils alone, on a box
where the daemon is not running and nothing in this codebase is importable —
that is the whole scenario restore exists for. Storing the checksum in SQLite
would make verifying a backup depend on trusting the file being verified.

### Retention deletes files, and only files this scheme produced

`pruneBackups` lists `BANANASAURS_BACKUP_DIR`, filters to names matching the
`bananasaurs-<timestamp>.db` pattern exactly (its `.sha256` sidecar is deleted
alongside its `.db`, never independently), sorts, and removes everything past
the newest `BANANASAURS_BACKUP_RETAIN`. Anything else in that directory — an
operator's manual copy, a stray file — is left alone. A retention sweep that
deleted-by-age over the whole directory would eventually delete something a
human put there on purpose because it looked old enough.

### Defaults: daily, keep fourteen

`BANANASAURS_BACKUP_INTERVAL_MIN` defaults to `1440` (daily) and
`BANANASAURS_BACKUP_RETAIN` to `14` (two weeks of dailies). Release 1 runs one
guild's reaction-role and logging data on a database that is bytes, not
gigabytes, so `VACUUM INTO`'s cost is not a reason to back up less often — the
reason for daily rather than hourly is that the restore drill bounds data loss
to "how much has anyone done since local midnight," which is the granularity
the club actually cares about, and a slower default is one an owner can lower
without a code change if that stops being true. `BANANASAURS_BACKUP_DIR`
defaults to `./backups`, a sibling of `./data` — matching
`deploy/bananasaurs.service`'s `ReadWritePaths=/opt/bananasaurs/data
/opt/bananasaurs/backups`, which already anticipated this layout.

### A failed backup is logged, not fatal — and doctor is what surfaces silence

Same posture as ADR 0032's registration failure: a bot that stops moderating
because a backup write failed once is a worse outcome than a missed backup.
The timer catches, logs at `error`, and tries again next interval. What closes
the loop is `doctor`'s new backup-health section (slice 16e): it reads
`BANANASAURS_BACKUP_DIR` from the filesystem alone — no database handle, so it
does not disturb `doctor`'s existing "does not open the database" property —
and reports whether the directory exists and is writable, how many backups are
present, and the age of the newest one. A backup job silently failing every
night for a month is now something `doctor` says out loud instead of something
nobody notices until the restore that needed it.

### `backup now` and `backup list` are operator commands; restore is never one

Taking a backup is safe while the daemon runs — that is `docs/19`'s own
argument for choosing `VACUUM INTO` over a file copy, and this measurement
confirmed it produces a complete, standalone file with no `-wal`/`-shm`
companions. So `backup now` (write, `OpsInstance`, mirrors
`reissueBootstrapToken`'s shape) and `backup list` (read) are ordinary operator
commands over the socket.

Restore is the opposite case by construction: `docs/19`'s own drill begins
"stop the service." A restore reachable from the operator socket would be a
restore reachable only while the one thing it needs to not be running is
running — the daemon holds the single-writer lock and the live database handle
for as long as it is up, and swapping the file out from under an open
connection is exactly the failure mode the single-writer guard exists to make
impossible. Restore is therefore a standalone script
(`scripts/restore.mjs`, alongside `scripts/migrate.mjs`, outside the TypeScript
project for the same reason that one is), run by a human over SSH with the
daemon stopped, that refuses to proceed if it can see the daemon is still up —
checked the same way the daemon's own single-writer guard is: the lock file at
`<db-path>.lock` and the admin socket. It moves the current database aside
(timestamped, never deleted) before copying the backup in, so a bad restore is
itself recoverable.

## Consequences

- Two new exports from `@bananasaurs/storage`: `performBackup`,
  `pruneBackups`. Both take the raw handle and plain options, no `GuildScope`.
- Three new config keys: `BANANASAURS_BACKUP_DIR`, `_INTERVAL_MIN`, `_RETAIN`.
  None are secrets.
- One new instance-level timer in `apps/daemon`, independent of the per-guild
  job workers and of guild count.
- `OpsInstance` grows `backupNow()` and `backupList()`; `OpsInstance` does not
  grow a restore method, and never should — the shape of the interface itself
  is a check.
- `scripts/restore.mjs` and a documented drill are the only path to a restore,
  matching `docs/19`'s "an untested restore is not a restore": the drill in
  this slice is rehearsed against a real backup in this environment, not
  merely written down.
