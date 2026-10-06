> **STATUS: FINAL**: owner decisions recorded 2026-10-04 (§1).

# Resource leaks and repeated work: audit and fix plan

**Status:** FINAL
**Date:** 2026-10-04
**ADR:** 0127 · **Migration:** none (see §4)
**Evidence:** live checks against the running daemon (PID 972406) and `data/bananasaurs.db` (read-only),
plus a code audit. The full audit report, with SQL for every finding, is in §9.

## Contents

1. Decisions I need from you
2. What prompted this
3. What I found
4. The root cause behind the worst three
5. Slices
6. Tests to write first
7. How we'll know it worked (after deploy)
8. Out of scope / deferred
9. Audit detail and live checks

---

## 1. Decisions I need from you

**Owner's answers (2026-10-04)**, which override the recommendations in the table below:

- **D1:** delete finished **and failed** jobs after **14 days**. No early clearing of `cursor`; it goes with its row.
- **D2:** **no.** Keep deleted-message text in the audit log ("I want good logging and archiving").
  Update PRIVACY.md to disclose it.
- **D3:** **no**, except expired MCP/OAuth tokens: delete them **14 days** after expiry. `gateway_gaps`,
  `dashboard_sessions`, MCP ledgers and OAuth clients are kept.
- **D4:** sweep `event_dedupe` at **14 days**.
- **D5:** **yes**, defer Slice 4.

The original questions, kept for the record:

| # | Question | Recommendation |
|---|---|---|
| D1 | **Old jobs.** Finished jobs are never deleted (5,518 refresh jobs today, back to 2026-08-29). Assistant jobs keep the AI's full run detail (prompt sections, tool results, which can include Discord message text) in `jobs.cursor` forever. That breaks PRIVACY.md:86 ("snapshots… are deleted with their conversation"). Delete finished jobs after **7 days**, failed ones after **30 days**, and clear an assistant job's `cursor` as soon as it finishes? | **Yes.** The trace table already keeps the diagnostic copy under conversation retention. Nothing reads a finished job's cursor (verified: it is only read to resume a running job, `apps/daemon/src/jobs/assistant.ts:388`). |
| D2 | **Deleted-message text in the audit log.** When a log route copies a deleted message's text, it lands in `audit_events.before` and stays forever. PRIVACY.md:149 promises 30 days. Strip the text after 30 days and keep the row (who, when, which channel)? | **Yes.** Nothing affected today (0 such rows), so this fixes the promise before it's broken. |
| D3 | **Small tables with no cleanup.** Proposed windows: `gateway_gaps` 90 days; `dashboard_sessions` 30 days past expiry or revocation; `mcp_sends`/`mcp_actions`/`mcp_bulk_previews` 90 days; expired OAuth access tokens 7 days after expiry; dynamically registered OAuth clients that never got a token, 24 hours. | **Yes to all.** Tiny today (all under 1,100 rows), but none of them is bounded. |
| D4 | **Event replay memory (`event_dedupe`).** One row per Discord event, 10,940 rows since 2026-08-29. A sweep job exists but nothing ever schedules it. Keep **7 days**? | **Yes.** Gateway replays happen within minutes. 7 days is far beyond any replay or job retry window. This is a fingerprint, not content. |
| D5 | **Scope.** Ship Slices 1–3 now and defer Slice 4 (GitHub ETags, automod member cache, backfill pacing, task-nudge cost) until something actually needs it? | **Yes.** Slice 4's leaks are all dormant on this box today (§3). |

## 2. What prompted this

On 2026-10-03 the "hourly" resource refresh turned out to run **every minute**. That was 1,099
refreshes in 24 hours instead of 24, each one refetching all 13 club resources (1 GitHub org, 11 repos,
1 website). It has been happening since 2026-09-26. You asked for a full sweep for other leaks of
the same kind, and a plan to fix them.

## 3. What I found

"Live" means checked against the running daemon or the database today. "Code" means confirmed by
reading the enclosing code, but nothing on this box triggers it yet.

| ID | Problem | Evidence | Impact today | Slice |
|---|---|---|---|---|
| **R1** | Hourly resource refresh runs every minute | Live: 55–60 done jobs per hour bucket; 1,099 in 24 h | ~780 outbound fetches/hour instead of ~13; 99% of all log lines; ~2.5% of a CPU core | 1 |
| **R2** | Daily jobs (archive expiry, conversation prune) re-run on every restart | Live: day key `archive_expiry:2026-10-02` ran 7 times (3 guilds × restarts) | Small: one extra sweep per restart | 1 |
| **R3** | "Update now" and the assistant's refresh have the same gap. `refresh_source` tells the member "Already refreshed in the last 10 minutes", but that's almost never true | Code: `kinds.ts:615`, `tools.ts:1268–1273` | Dormant (0 repeats), but a member can steer the AI into refetching on every question | 1 |
| **L1** | Finished jobs are never deleted, and assistant jobs keep full run detail | Live: 417 assistant jobs, 3.6 MB of run detail in `cursor` back to 2026-09-26 | Privacy-policy contradiction (D1); unbounded growth; copied into every backup | 2 |
| **L3** | `event_dedupe` never swept: the handler is registered but nothing enqueues it | Live: 10,940 rows, oldest 2026-08-29, 0 sweep jobs ever | Slow unbounded growth | 2 |
| **L4** | Deleted-message text in `audit_events` kept forever | Code: `guild.ts:469–493` | Dormant (0 rows); contradicted PRIVACY.md:149 | Kept (D2); PRIVACY.md now discloses it |
| **L8** | Expired OAuth access tokens can never be purged (purge needs "expired **and** revoked"; access tokens are never revoked) | Live: 62 dead access tokens, purge reports 0 | ~20 rows/day | 2 |
| **L13** | `gateway_gaps`, `dashboard_sessions`, MCP ledgers, unconsented OAuth clients: no cleanup. `sweepExpiredPendingActions` exists but is never scheduled | Live: counts all < 1,100 | Tiny, unbounded | Kept (D3) |
| **L2** | `countByState` loads **every** job row, blobs included, to count states in JavaScript, on every `/status`, dashboard health load and MCP health call | Code: `repos/jobs.ts:297–303` | Grows with L1; blocks the event loop | 3 |
| **L7** | Backup hashes the whole DB with one `readFileSync`. Every restart also makes a backup, so 14 restarts push out the 14-day history (a deploy day can do that) | Code: `backup.ts:131`; live: always exactly 14 backups | Startup took ~95 s on 2026-10-03 under disk pressure; recovery window shrinks to hours on deploy-heavy days | 3 |
| **L9** | If reminder delivery fails persistently, a new failing job is enqueued every 30 s | Code: `reminder-timer.ts:56–75` | Not observed (needs a DB fault) | 3 |
| **G1** | Every gateway resume is recorded as a zero-length gap. The daemon only stamps the disconnect on `ShardDisconnect`, which discord.js v14 emits only for **unrecoverable** closes. Recoverable drops emit `ShardReconnecting` | Code: `daemon.ts:518`; `node_modules/discord.js/src/client/websocket/WebSocketManager.js:249–268`; live: avg duration 0.0 s | Gap length lost (diagnostics only; no missed events, since resumes replay) | 3 |
| L14 | GitHub refresh: no ETag on `getRepo`/`listTree`, and the sweep refreshes disabled resources too | Code: `github-refresh.ts:296–323` | Fine once R1 is fixed (~23 calls/hour); all 13 resources enabled | 4 |
| L10 | Automod fetches the author over REST per message once any rule has a role exemption | Code: `automod/subscriber.ts:276` | Dormant: 0 role exemptions | 4 |
| L11 | Archive backfill has no pacing between pages | Code: `archive/backfill.ts:262` | Not observed | 4 |
| L12 | Task-nudge pass does one write per open task per minute | Code: `jobs/task-nudges.ts:88` | Dormant: 0 open tasks | 4 |

**Checked and clean** (live or in code): event listeners and intervals (each registered once, cleared on
stop); discord.js cache limits (applied and checked at startup); every other in-memory map (bounded or TTL'd);
log volume once R1 is fixed; backups capped at 14; WAL (391 KB); outbound timeouts on every path; daemon
memory flat (219 → 218 MB over 11 min, 33 FDs both times); gateway reconnects all match restarts (no
flapping); resource chunks are not rewritten when content is unchanged.

## 4. The root cause behind the worst three

The job table's dedupe index (`jobs_dedupe`, ADR 0016) is **partial**: it is unique only while a job is
`queued` or `running`. That's deliberate. It collapses a double-tap into the one pending job without
blocking the same work forever. But three timers and two request paths assumed a time-bucketed key
means "once per bucket". It doesn't. Once the bucket's job finishes, the next tick or request in the
same bucket enqueues again.

**The fix is not to make the index total.** ADR 0016 rejected that for good reason. Some keys have
**no time bucket** on purpose:

- `resource_refresh:<id>:added` collapses edits; it must refresh again on the next edit.
- `reconcile_guild:gateway-gap` must run on every fresh IDENTIFY.
- `deliver_reminders` is a constant per-guild key.

A blanket "key already ran, skip it" check would silently stop those forever.

**Fix:** add an explicit, opt-in rule for time-bucketed work. A new repo function
`jobRepo.enqueueOncePerBucket(scope, input)` refuses when **any** row in that guild (any state) already
has the key. It is used only by callers whose key ends in a time bucket. A failed bucket waits for the
next bucket (the worker already retries 5 times with backoff), which also stops failure storms.
**Implemented as an opt-in `oncePerBucket: true` field on `jobRepo.EnqueueInput`**, so the timers'
injected `enqueue` carries it without rewiring. **No migration:** the lookup scans one guild's rows,
which 14-day retention bounds to hundreds once R1 is fixed. That avoids a stop → migrate → start deploy.
ADR 0127 records this as an amendment to ADR 0016.

Callers that switch to it: the resource refresh timer (`hourly`), the archive-expiry and
conversation-prune timers (day keys), `manual` and `assistant` refreshes (minute and ten-minute keys).
Callers that must **not** switch: `added`, `reconcile_guild:*`, `deliver_reminders`, purge, backfill,
`log_message_delete`, `assistant_invoke`.

Retention (Slice 2) deletes finished jobs after 7 days. That's safe for this check, because a bucket
key never recurs once its time window has passed.

## 5. Slices

Each slice is one branch-ready unit with its own tests, gates and deploy. Slice 1 is urgent and
independent. Ship it first.

### Slice 1: a time bucket runs once (R1, R2, R3)

- `packages/storage/src/repos/jobs.ts`: `oncePerBucket?: boolean` on `EnqueueInput`, checked inside
  `enqueue`'s existing `write()`.
- Switch the five bucketed callers above.
- `refresh_source` reply: "Already refreshed in the last 10 minutes" becomes true, because a refused
  enqueue now really means the bucket already ran or is running.
- ADR 0127 (written).
- Startup side-effect: a restart inside a bucket no longer re-sweeps (R2's restart re-runs disappear).

### Slice 2: housekeeping (L1, L3, L8), narrowed to the owner's decisions

A new daily `housekeeping-timer.ts` (own timer; not behind archive-expiry's `hasArchiveChannels`
check) enqueues two jobs per guild, both day-keyed with `oncePerBucket`:

- `prune_jobs` (new kind): delete `done`/`failed`/`cancelled` rows with `updated_at` older than 14 days.
  **Never** `queued`/`running`. Batched: `DELETE … WHERE job_id IN (SELECT … LIMIT 500)`, looped
  (better-sqlite3's SQLite has no `DELETE … LIMIT`). The first run deletes the backlog older than 14 days.
- `sweep_event_dedupe` (existing handler, finally enqueued): cutoff `now − 14 days`. Its dedupe key
  gains a day suffix.
- OAuth (instance-level, in the archive-expiry timer's existing `purgeOAuth` call): `purgeExpired` deletes
  tokens with `expires_at <= now − 14 days`, regardless of `revoked_at`. Safe: rotated access tokens are leaves
  of the refresh chain (`oauth.ts:580–601`), and an expired token can't authenticate.
- PRIVACY.md (written): job-record retention row, the snapshot line, and the audit log's indefinite copy
  of deleted-message text.

Nothing else is pruned (D2/D3).

### Slice 3: cheaper paths and honest diagnostics (L2, L7, L9, G1)

- `countByState`: `SELECT state, count(*) … WHERE guild_id = ? GROUP BY state`. Same fix for
  `pipelineRepo.countEventDedupe`, which also loads every row to count them.
- Backup: hash in fixed-size chunks (`fs.readSync` with a 1 MiB buffer). That keeps memory constant
  without making `performBackup` async, so its other callers don't change. Skip the **startup** backup when
  the newest backup is younger than the configured interval, and schedule the first one for when it falls
  due, so restarts stop evicting history.
- Reminder timer: don't enqueue while the newest `deliver_reminders` job is `failed` and younger than 5 minutes.
- Gateway gaps: also stamp `disconnectedAtMs` on `Events.ShardReconnecting`, keeping the
  first stamp if several fire.

### Slice 4: deferred (D5)

L14 (ETags on `getRepo`/`listTree`, skip disabled resources in the sweep), L10 (member cache before REST),
L11 (page spacing for backfill continuations), L12 (plan nudges only for changed tasks). Each is dormant
today. Revisit when its trigger appears: more GitHub repos, a role exemption, a large archive backfill,
or real task volume.

## 6. Tests to write first

CLAUDE.md requires test-first for idempotency, retention and guild scope. Each must be watched failing
against today's code before the fix lands.

**Slice 1**
- Timer: tick → job runs to `done` → tick again in the same bucket → **still one job** (fails today:
  two jobs). Next bucket → two jobs.
- Same for a day-keyed timer across a simulated restart (new timer instance, same DB).
- `added` refresh: enqueue → done → enqueue again → **two jobs** (guards against over-applying the rule).
- `reconcile_guild:gateway-gap`: two fresh IDENTIFYs → two reconciles (same guard).
- Guild scope: the same bucket key in guild A does not block guild B.
- `refresh_source` within a bucket after a completed refresh → "Already refreshed" and **no** new job.

**Slice 2**
- Retention never deletes `queued`/`running` rows, whatever their age.
- Retention deletes `done`, `failed` and `cancelled` rows older than 14 days and keeps younger ones.
- Retention in guild A never touches guild B's rows.
- The `event_dedupe` sweep keeps rows newer than 14 days. A replayed event inside the window is still
  refused.
- A token expired more than 14 days ago is purged, revoked or not. A token expired less than 14 days ago, a
  live token, and a revoked-unexpired refresh token are kept. Refresh-token reuse detection still revokes the chain.
- The housekeeping timer enqueues for a guild with no archive channels, and a second `runOnce` the same
  UTC day (including after a restart) enqueues nothing.
- Batching: 1,200 deletable rows → all deleted, and the returned count is 1,200.

**Slice 3**
- `countByState` returns the same counts as today on a seeded table.
- Startup backup skipped when the newest is younger than the interval, made when older.
- Gap recorded with non-zero duration after `ShardReconnecting` → `ShardResume`.
- Reminder timer: a fresh `failed` job blocks enqueue for the cool-down, then allows it.

Gates per slice: `npm run typecheck`, `npm run lint`, `npm run test`, each run on its own with its exit
status checked. Two traps on this box decide **where**:

- In the main checkout, `typecheck`/`build` rewrite the `dist/` that systemd runs, so a gate run there
  deploys unmigrated code.
- In an oc worktree with linked `node_modules`, `@bananasaurs/*` resolves to the main checkout, so typecheck
  checks the wrong packages.

Run the gates in a throwaway worktree with its **own** `npm install` (the `verify-main` recipe), at the
branch's commit.

## 7. How we'll know it worked (after deploy)

There's no migration, so the deploy is: merge → build → restart. On this box a build is the deploy
(systemd runs the checkout's `dist/`). Then:

```sql
-- R1/R2: one sweep per bucket per guild (expect n = 1 for buckets after deploy)
SELECT dedupe_key, COUNT(*) n FROM jobs WHERE kind='resource_refresh'
  AND dedupe_key LIKE 'resource_refresh:all:%' GROUP BY dedupe_key ORDER BY MAX(created_at) DESC LIMIT 5;
-- L1: nothing finished older than 14 days
SELECT COUNT(*) FROM jobs WHERE state IN ('done','failed','cancelled') AND updated_at < (strftime('%s','now')-14*86400)*1000;
-- L3: oldest replay fingerprint inside 14 days
SELECT datetime(MIN(first_seen_at)/1000,'unixepoch') FROM event_dedupe;
-- L8: no token more than 14 days past expiry
SELECT COUNT(*) FROM oauth_tokens WHERE expires_at < (strftime('%s','now')-14*86400)*1000;
```

And in the journal: "resource cache: refreshed" about once per hour, not once per minute. After Slice 2's
first pass, an optional `VACUUM` with the daemon stopped returns the ~15 MB of free pages. Not needed for
correctness, since SQLite reuses free pages.

## 8. Out of scope / deferred

- Slice 4 (D5).
- **The host, not the bot:** during the 2026-10-03 restart the box had swap full (2,044 / 2,047 MB). Two
  VS Code server processes sat at ~4.5 GB each, and VS Code had crashed and dumped core 7 times since
  2026-10-02. That, not the daemon, is why startup took ~2m45s. Worth a look, but nothing in this repo
  changes it.
- Doctor's standing permission warnings (`BanMembers`/`ManageMessages` in two guilds, `UseApplicationCommands`
  in SFU Racerbot Club). Unchanged across runs, and not a leak.
- Making `jobs_dedupe` non-partial (rejected in §4).

## 9. Audit detail and live checks

Code-audit report (14 findings, each with a live-check query and fix sketch), produced read-only by a
subagent and then verified here against the code and the live database:
`docs/reports/2026-10-04-resource-leak-audit.md` (its IDs L1–L14 match §3). Corrections made on
verification, which the report itself does not carry:

- L13's automod test examples are disclosed in PRIVACY.md:151 ("kept until the owner removes them"). Not a
  policy breach, so dropped from the retention list.
- L4, R3, L10 and L12 are dormant on this box (0 matching rows), so they're downgraded from "medium" in the
  report to "dormant" here.
- L14's ~2,400 calls/hour estimate assumed 20 repos. This org has 11, and once R1 is fixed it's ~23 calls/hour.
- G1 (zero-length gaps) is mine, not the agent's; verified against discord.js in `node_modules`.
