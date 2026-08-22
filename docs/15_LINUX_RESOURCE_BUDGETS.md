# Host, resource budgets, and degraded modes

Revised 2026-08-22 with measured host specifications. The earlier "older consumer PC that cannot run useful models" assumption turned out to be wrong, and several constraints derived from it are relaxed accordingly.

## Measured host

```
Dell OptiPlex 5040
Intel Core i7-6700 @ 3.40GHz — 4 cores / 8 threads, boost 4.0GHz
19 GiB RAM (≈16 GiB available at idle)
117 GB root filesystem, 45 GB free
Linux Mint 22.3 "zena" (Ubuntu 24.04 base), kernel 6.17
Dedicated to server development; not a daily driver
```

This is a capable machine. Skylake is old but it is a real desktop i7 with AVX2, and 19 GB is a great deal of headroom for a bot serving 30 people.

## The repository and data must live on ext4

Measured 2026-08-22: the secondary drive `/media/bryan/OptiData1` is **NTFS mounted through ntfs-3g** (`df -T` reports `fuseblk`). Nothing belonging to this project may live there.

- **SQLite WAL cannot work on it.** WAL requires a shared-memory `-shm` file backed by real mmap and POSIX advisory locking. FUSE-mounted NTFS provides neither reliably. The result is not a clean error — it is intermittent locking failures and, eventually, a corrupt database.
- **Unix permissions do not exist.** `chmod 600 .env` silently succeeds and changes nothing; ntfs-3g applies mount-wide permissions to every file. Secret-file protection is unenforceable.
- **Unix domain sockets are unsupported**, which the operator CLI depends on (ADR 0013).
- **Case-insensitive**, which confuses git and can silently merge two distinct source files.
- **FUSE is slow** on many small files, which is exactly what `node_modules` is.
- **`/media` mounts attach at login, not at boot**, so a systemd unit pointing there fails on restart — the one moment it most needs to work.

The repository, the database, attachments, and backups all live on the ext4 root filesystem, which has 45 GB free. `~/projects/bananasaurs` — no spaces in the path either, which saves quoting problems in the systemd unit and in scripts.

The NTFS drive is fine for what it is good at: a copy of finished artifacts, media, or an extra backup destination. It is not a place to run a database.

## What this changes

The 512 MB steady-state target was written to protect a machine we assumed was constrained. Against 19 GB it is not a meaningful ceiling, and treating it as one would distort the design for no benefit.

**Relaxed:**

- **Memory target is now roughly 1 GB steady state** for the whole application — bot, API, dashboard backend, scheduler, and SQLite. Still small, still worth measuring, no longer a constraint that forbids anything.
- **Local embeddings are viable.** A MiniLM-class ONNX embedder at 150–400 MB resident is comfortable here. It stays off by default and behind a measurement — lexical FTS5 search must be shown insufficient on real club data first — but the memory objection is gone. Notably it also removes the need to disclose message content to a provider for embedding, which is a privacy win, not just a cost one.
- **A small local generation model is now on the table** for Release 3. A 7–8B model quantized to 4-bit runs in about 5 GB with AVX2, at maybe 3–8 tokens/second on this CPU. Slow, but `/ask` already defers and edits progressively, so a 30-second answer is tolerable. It would be genuinely free, permanently, with zero terms to comply with and nothing leaving the machine — which sidesteps ADR 0010's whole provider problem. Quality is well below a hosted frontier model. Worth benchmarking against NIM before committing either way.

**Unchanged, because they were never about memory:**

- One process, one SQLite file, no Redis, no broker, no cluster (ADR 0006).
- Interactive commands, moderation, heartbeats, and rule evaluation take priority over indexing, summaries, parsing, and backups.
- Background work is batched, deduplicated, concurrency-capped, and pausable.
- Never call a model for every message.
- The application stays functional with embeddings, parsing, AI, and nonessential modules all disabled.
- Startup and migrations are bounded and never load the whole archive into memory.

**Storage** is the resource that actually matters: 45 GB free, and the archive is bounded by the channel allowlist (ADR 0009) rather than by server activity. Track database, index, attachment, log, and backup sizes separately, warn on growth, and forecast exhaustion. This is comfortable but not unlimited, and attachments are what will consume it.

## Efficiency strategy

- Modular monolith, in-process calls, no network hops.
- SQLite with WAL, migrations, FTS5, proper indexes, and a database-backed job table.
- Batch archive inserts and index updates; deduplicate events and attachments by stable ID and content hash.
- Search metadata and full text first; reach for vectors or reranking only when it measurably helps.
- Cap attachment download and parser concurrency, CPU time, memory, expanded size, and file count. A 10 MB input limit does not imply unlimited decompression work.
- Cache only guild-scoped, permission-scoped data with explicit invalidation and bounded size.
- Stream provider responses and large exports; paginate dashboard tables and archive operations.
- Schedule backups, compaction, and bulk indexing for owner-selected maintenance windows.

The discipline stays even though the budget loosened. Restraint here is not about fitting in RAM — it is about a system whose behaviour stays predictable and debuggable, which matters more on a machine nobody is watching.

## Development and production on the same host

The Mint box is both the development machine (VS Code Remote) and the eventual production host. That is fine and convenient, but it needs a hard separation or a dev run will one day connect to the club guild.

- **Separate data directories** and separate config files per instance: `~/bananasaurs-dev/` and `/opt/bananasaurs/`.
- **Separate `.env`** files with different bot tokens if possible, and definitely different guild allowlists. The dev instance's allowlist contains the test guild ID and nothing else.
- **Different socket paths** so the operator CLI cannot address the wrong instance: `/run/bananasaurs/admin.sock` for production, a path under the dev directory for development.
- **The guild allowlist is the backstop.** A dev instance that somehow starts with production config still refuses to act on any guild not in its own allowlist, and logs and leaves.
- Production runs under systemd as the service user. Development runs as `bryan` from VS Code. They never share a database file.

## Degraded modes

- **Low disk:** pause new attachment bodies and derived indexes before risking database corruption; retain metadata and events, alert the owner.
- **High CPU or load:** pause background workers, keep gateway, role panels, logging, and health responsive.
- **Provider outage:** every deterministic module keeps working; AI requests queue or fail visibly per policy.
- **Parser failure:** preserve the opaque attachment and an error record; never block ingestion.
- **Database problem:** fail closed for AI retrieval and any automated action, preserve diagnostics, surface recovery guidance.

## Verification

Benchmark idle behaviour, normal chat, message bursts, reaction and button storms, history backfill, attachment bursts, indexing, dashboard use, backup and restore, provider streaming, and restart recovery. Record CPU, peak and steady RAM, disk growth, queue lag, heartbeat health, command latency, and any dropped or duplicated actions.

Because the host is known and dedicated, these numbers are real measurements rather than estimates. Record them here as they land, and publish a sizing guide from measured profiles before any public release.
