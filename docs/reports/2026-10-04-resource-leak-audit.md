# Bananasaurs resource-leak audit (read-only)

Repo: /home/bryan/projects/bananasaurs, source in `apps/daemon/src` and `packages/*/src`.
Scope: classes A-H from the brief. The known bug (`resource_refresh:all:<hourBucket>` re-enqueued every
60 s because `jobs_dedupe` is partial over `queued`/`running`) is NOT re-reported, except where a
different code path shares the same root cause (L5, L6) or multiplies its cost (L14).

All timestamps in the schema are epoch milliseconds. All SQL below is read-only and uses the
snake_case names from `packages/storage/src/schema.ts`. Run with `sqlite3 -readonly <db>`.

Evidence labels: "confirmed in code" means I read the enclosing function and the only producer or
consumer; "suspected" means the mechanism is real but depends on live data or a rare condition.
I did not run anything and did not touch the live system, so no live check below has been executed.

## Summary table

| ID  | Class | Severity | Confidence | One line |
|-----|-------|----------|------------|----------|
| L1  | C, D  | high     | confirmed  | `jobs` is never pruned and its `payload`/`cursor` hold message and answer content forever |
| L2  | C, D  | medium   | confirmed  | `countByState` loads the whole `jobs` table (blobs included) on every health/status call |
| L3  | C     | medium   | confirmed  | `event_dedupe` is never swept: the sweep handler exists, nothing enqueues it |
| L4  | C     | medium   | confirmed  | `audit_events` is never pruned and stores deleted-message content, contradicting the 30-day promise |
| L5  | A, F  | medium   | confirmed  | Same dedupe gap on the `manual` and `assistant` resource-refresh buckets; the tool reply text is false |
| L6  | A     | medium   | confirmed  | Every restart re-runs reconcile, the resource sweep, and a backup (restart storms multiply work) |
| L7  | H, D  | medium   | confirmed  | Backup hashes the whole DB via `readFileSync`; count-based retention is displaced by restart backups |
| L8  | C     | low-med  | confirmed  | OAuth: expired-but-unrevoked access tokens and all registered clients are never purged |
| L9  | A, B  | low      | suspected  | `deliver_reminders` re-enqueues every 30 s forever if the handler fails persistently |
| L10 | F, G  | low-med  | confirmed  | Automod does one uncached REST member fetch per message when any rule has a role exemption |
| L11 | B, F  | low      | suspected  | Archive backfill has no pacing (up to 50 pages/s per drain); a rate-limit streak strands a channel |
| L12 | A, C  | low      | confirmed  | Task nudge pass runs a write per open task per minute; `club_tasks` and `task_nudge_*` never pruned |
| L13 | C     | low      | confirmed  | Bundle of small event-rate tables with no retention (list inside) |
| L14 | F     | medium   | confirmed  | GitHub refresh makes unconditional API calls per repo per sweep and refreshes disabled resources |

---

## Findings

### L1. `jobs` is never pruned, and its blobs hold member content (class C, D)

- Location: no `delete(jobs)` anywhere (searched every `.delete(` and `DELETE FROM` in `apps`, `packages`,
  `drizzle`, `scripts`). `packages/storage/src/repos/jobs.ts:131` (`completeJob` only flips state),
  `packages/storage/src/schema.ts:448`. Content in the blobs:
  - `packages/core/src/logging/subscriber.ts:351-361` and `packages/core/src/mod/purge.ts:398-414`:
    `log_message_delete` payload carries the deleted message `content`.
  - `apps/daemon/src/assistant/commands.ts:316-338`: `assistant_invoke` payload carries `input.question`.
  - `apps/daemon/src/jobs/assistant.ts:448-460, 919, 991, 1076, 1153, 1168`: `saveStaged` writes
    `jobs.cursor` = the full invocation `result`, which includes `detail` (prompt `sections[].text`,
    tool-call `history`, retrieved evidence), up to four times per job (overwritten, but the last one stays).
- Mechanism: every job ends as `done`/`failed`/`cancelled` and stays in the table. Rows are cheap for
  timers, but `assistant_invoke`, `log_message_delete` and `mod_purge` rows carry large text. The
  conversation prune job (`apps/daemon/src/jobs/conversation-prune.ts:39-40`) deletes conversations and
  traces but never touches `jobs`, and `forgetAuthor` does not either, so `PRIVACY.md:86` ("deleted with
  their conversation ... forgetting a member deletes the snapshots") and `PRIVACY.md:149/156` (deleted
  content kept 30 days) are false for the copy in `jobs`.
- Intended vs worst case: intended is a small working queue; worst case is monotonic growth of at least
  one row per timer tick, per backfill page (100 messages), per assistant answer, per deleted message,
  with an unbounded text blob on the last three. The known resource bug alone adds about 1,440 rows/day/guild.
  Every backup (14 retained) copies all of it.
- Severity/confidence: high (storage growth plus a privacy-policy contradiction), confirmed in code.
- Live check:
  ```sql
  SELECT kind, state, count(*) AS n,
         sum(length(payload)) AS payload_bytes,
         sum(length(coalesce(cursor,''))) AS cursor_bytes,
         datetime(min(created_at)/1000,'unixepoch') AS oldest
  FROM jobs GROUP BY kind, state ORDER BY payload_bytes + cursor_bytes DESC;

  -- deleted-message / question text still sitting in jobs
  SELECT count(*), datetime(min(created_at)/1000,'unixepoch') FROM jobs
   WHERE kind='log_message_delete' AND payload LIKE '%"content":"%';
  SELECT count(*), datetime(min(created_at)/1000,'unixepoch') FROM jobs
   WHERE kind='assistant_invoke' AND cursor LIKE '%"detail"%';
  ```
- Fix sketch: add a `jobs` retention sweep (daily, riding the existing `archive-expiry-timer` `runOnce`
  or a new job): delete terminal rows (`done`/`cancelled` older than about 7 days, `failed` older than
  about 30 days) in bounded batches, never `queued`/`running`. Separately, scrub content at completion
  rather than at retention: when a `log_message_delete` or `assistant_invoke` job completes, overwrite
  `payload` content fields and set `cursor` to NULL (or keep only stage and message ids), because the
  trace table already holds the diagnostic copy under the conversation retention. Add a regression test
  that `forgetAuthor` leaves no member text in `jobs`.

### L2. `countByState` loads the entire `jobs` table including blobs (class C, D)

- Location: `packages/storage/src/repos/jobs.ts:297-303`. It does
  `db.select(columns).from(jobs).where(scope.only(jobs)).all()` where `columns` (lines 30-41) includes
  `payload`, `cursor` and `last_error`, then tallies `state` in JS. Callers:
  `apps/daemon/src/ops/wiring.ts:116` (`jobCounts`), `packages/http/src/routes/read.ts:49` (`GET /api/health`,
  fetched once per dashboard shell mount, `packages/dashboard/src/app/health.tsx:43`),
  `packages/core/src/ops/commands/status.ts:122`, `apps/daemon/src/mcp/wiring.ts:206` (MCP health tool).
- Mechanism: better-sqlite3 is synchronous, so each call materialises every row (with L1's blobs) in
  memory and blocks the event loop, including the gateway handlers, for the duration.
- Intended vs worst case: intended is a `GROUP BY state` counting a few dozen rows; worst case is
  `O(rows x blob size)` heap and event-loop stall per dashboard load, `status`, or MCP health call.
  Not polled on a timer, so it scales with operator activity, not with time.
- Severity/confidence: medium, confirmed in code.
- Live check: the bytes one call would pull into memory:
  ```sql
  SELECT count(*) AS rows,
         sum(length(payload)+length(coalesce(cursor,''))+length(coalesce(last_error,''))) AS bytes
  FROM jobs;
  ```
- Fix sketch: replace the body with
  `SELECT state, count(*) FROM jobs WHERE guild_id=? GROUP BY state` via Drizzle's `count()` and
  `groupBy`; it is served by no dedicated index, so add one on `(guild_id, state)` only if the table
  stays large after L1's retention.

### L3. `event_dedupe` is never swept (class C)

- Location: producer is missing. Handler registered at `apps/daemon/src/runtime/guild.ts:1303-1306`
  (comment: "Registered although nothing enqueues one yet"); key helper `packages/core/src/jobs/kinds.ts:104`;
  `rg` over `apps` and `packages` finds `sweepDedupeKey`/`JOB_KINDS.sweepEventDedupe` only in the handler,
  kinds, and tests. Rows are written by `packages/core/src/pipeline/pipeline.ts:105` for every
  `interaction`, `slashCommand`, `messageCreate`, `messageUpdate`, `messageDelete`, `messageDeleteBulk`,
  `memberAdd`, `memberRemove`, `roleCreate`, `roleDelete`, `autoModerationAction`, `auditLogEntry`
  (`packages/core/src/pipeline/fingerprint.ts:81-158`), plus idempotency claims from logging
  (`guild.ts:374, 494`), automod (`apps/daemon/src/automod/wiring.ts:282`) and `/mod` (`guild.ts:577`).
- Mechanism: one row per chat message (fingerprint is a 64-char sha256 hex, PK
  `(guild_id,event_kind,fingerprint)` plus the `event_dedupe_sweep` index), forever. The comment at
  `schema.ts:404` says the table "grows without bound otherwise; the sweep job runs on this" but no
  scheduler enqueues it.
- Intended vs worst case: intended is a rolling window of hours to days; actual is unbounded, one row
  per message for the life of the database. At a few hundred messages/day that is tens of MB/year with a
  random-key B-tree, so it is slow growth rather than an emergency, but nothing ever bounds it.
- Severity/confidence: medium, confirmed in code.
- Live check:
  ```sql
  SELECT event_kind, count(*) AS n, datetime(min(first_seen_at)/1000,'unixepoch') AS oldest
  FROM event_dedupe GROUP BY event_kind ORDER BY n DESC;
  SELECT count(*) FROM jobs WHERE kind='sweep_event_dedupe';   -- expect 0
  ```
- Fix sketch: add a producer. Cheapest: call `pipelineRepo.sweepEventDedupe(scope, now - 7d)` directly from
  `archive-expiry-timer.ts`'s `runOnce` (it already runs once at start and every 24 h and holds guild
  scopes), or enqueue `sweep_event_dedupe` there under a day-bucket key like the other daily jobs. The
  window must exceed the longest replay window and the logging/automod claim lifetimes; 7 days is safe.
  Delete in batches (`LIMIT`) so a first sweep over a large table does not block the loop.

### L4. `audit_events` is never pruned and stores deleted-message content (class C)

- Location: no delete path for `audit_events`. Content written at `apps/daemon/src/runtime/guild.ts:469-493`
  (`deletionAttributionPorts.recordAudit`, `before: { channelId, authorId, content }`) and
  `guild.ts:528-539` (purge, same shape), driven by `packages/core/src/logging/attribute-deletion.ts:79-83`
  and `packages/core/src/mod/purge.ts:390-397`. Schema `schema.ts:509`.
- Mechanism: when a log route accepts `message_delete` with `include_content`, the deleted message text
  goes into `audit_events.before` and stays. The archive path correctly nulls deleted content after 30 days
  (`packages/storage/src/repos/archive.ts:773-815`); this copy is never purged. Rows are human-action-driven,
  so volume is modest, but retention is unbounded and contradicts `PRIVACY.md:149/156`.
- Intended vs worst case: documented 30 days; actual forever. A 500-message `/mod purge`
  (`PURGE_MAX_MESSAGES`, `packages/core/src/effects/budget.ts:61`) writes 500 such rows plus 500 jobs (L1).
- Severity/confidence: medium (policy contradiction, low volume), confirmed in code.
- Live check:
  ```sql
  SELECT count(*), datetime(min(at)/1000,'unixepoch') FROM audit_events
   WHERE action='message_delete' AND before LIKE '%"content":"%';
  SELECT action, count(*) FROM audit_events GROUP BY action ORDER BY 2 DESC LIMIT 15;
  ```
- Fix sketch: in the archive expiry job (or the same daily timer as L3), rewrite
  `audit_events.before` for `action='message_delete'` rows older than 30 days to drop `content`
  (keep ids and actor, the "fact it existed"), matching the archive tier rules. Do not delete the rows;
  they are the audit trail. Decide whether a longer cap on the audit table itself is wanted and document it.

### L5. Same dedupe gap on the `manual` and `assistant` refresh buckets (class A, F)

- Location: `packages/core/src/jobs/kinds.ts:615-637` (`minuteBucket`, `tenMinuteBucket` keys);
  enqueue sites `apps/daemon/src/assistant/service.ts:770-783`, `packages/http/src/routes/assistant-resources-cache.ts:53, 80`,
  `apps/daemon/src/http/wiring.ts:246-253`. The model-driven callers are `apps/daemon/src/assistant/tools.ts:699-723`
  (`open_resource` on an uncached or chunk-less doc) and `tools.ts:1264-1274` (`refresh_source`).
- Mechanism: identical root cause to the known bug. The bucket only collapses while the earlier job is
  `queued`/`running`; a job finishes in seconds, so the next request in the same 10-minute (or 1-minute)
  bucket enqueues a fresh fetch. `refresh_source` answers "Already refreshed in the last 10 minutes" when
  `enqueue` returns false, which almost never happens, so the claim is wrong in both directions. Model output
  is untrusted (hard rule 3): a member can steer the model into calling `refresh_source`/`open_resource`
  repeatedly, bounded per question by `assistant.maxToolCalls` (default 12, max 30,
  `packages/core/src/settings/instance-settings.ts:85-94`) but not across questions. `open_resource` on a doc whose
  last fetch failed (status `error`, no chunks) enqueues a refresh on every open.
- Intended vs worst case: one fetch per resource per 10 minutes; actual is one fetch per question that asks
  for it (outbound HTTP to the resource host or GitHub, plus a jobs row, plus an info log line).
- Severity/confidence: medium, confirmed in code (the amplification magnitude depends on member behaviour).
- Live check:
  ```sql
  SELECT dedupe_key, count(*) AS n FROM jobs
   WHERE kind='resource_refresh' AND (dedupe_key LIKE '%:assistant:%' OR dedupe_key LIKE '%:manual:%')
   GROUP BY dedupe_key HAVING count(*) > 1 ORDER BY n DESC LIMIT 20;
  SELECT count(*) FROM jobs WHERE kind='resource_refresh'
   AND payload LIKE '%"reason":"assistant"%' AND created_at > (strftime('%s','now')-86400)*1000;
  ```
- Fix sketch: add a real "last refreshed" gate rather than relying on the partial index. Before
  enqueueing, check the resource's `last_fetched_at` (or `resource_documents.fetched_at`) and skip if it is
  newer than the bucket size; return `enqueued=false` in that case so the tool's message becomes true. The same
  helper should back the hourly timer fix so one rule governs all reasons. Also make `open_resource` stop
  enqueuing when the document row already has `status='error'` and was fetched within the bucket.

### L6. Every restart re-runs heavy work, and restarts are cheap to trigger here (class A)

- Location: `apps/daemon/src/runtime/daemon.ts:654-674` (`start()` runs `backupTimer.start()`,
  `archiveExpiryTimer.start()`, `conversationPruneTimer.start()`, `reminderDeliveryTimer.start()`,
  `resourceRefreshTimer.start()`, each doing `runOnce()` immediately); `daemon.ts:548-556`
  (`ClientReady` calls `connectionEvent(false)`), which feeds
  `packages/core/src/pipeline/connection-subscriber.ts:29-52` (records a `gateway_gaps` row and enqueues
  `reconcile_guild` under `reconcile_guild:gateway-gap` for each guild).
- Mechanism: a cold start is a fresh IDENTIFY by design (documented at `daemon.ts:506-515`), so each restart
  enqueues a full reconcile (per panel: fetch message, page reactors per emoji, per-member checks via REST),
  a resource sweep when that bucket's job is already `done` (the known bug's gap), a daily-key job for
  archive expiry/prune when the previous one is `done`, an OAuth purge, and a VACUUM INTO backup (L7). All of
  that is intentional once; the project memory notes "build is a deploy on this box", so dev iterations and
  any crash loop (`index.ts:396-398` exits on login failure, systemd restarts) repeat it.
- Intended vs worst case: once per deploy; worst case once per restart under a crash loop (each run is
  REST traffic against Discord and the resource hosts, one synchronous full-DB copy, and N new `jobs`/`gateway_gaps` rows).
- Severity/confidence: medium, confirmed in code; actual impact depends on restart frequency.
- Live check:
  ```sql
  SELECT date(created_at/1000,'unixepoch') AS day, count(*) FROM jobs
   WHERE kind='reconcile_guild' AND dedupe_key='reconcile_guild:gateway-gap' GROUP BY day ORDER BY day DESC LIMIT 14;
  SELECT resumed, count(*), datetime(min(reconnected_at)/1000,'unixepoch'), datetime(max(reconnected_at)/1000,'unixepoch')
   FROM gateway_gaps GROUP BY resumed;
  ```
  Logs: `journalctl -u bananasaurs | grep -c "bananasaurs starting"` per day, and
  `grep -c "reconciliation job finished"`.
- Fix sketch: gate each startup `runOnce` on durable "last ran" state instead of running unconditionally:
  skip the startup backup if the newest backup is younger than the configured interval, skip the startup
  refresh if every resource's `last_fetched_at` is inside the bucket, and let the daily jobs rely on the day
  key plus a "done today" check (query for a `done` row with the same key) rather than the partial index.
  Keep the startup reconcile (it recovers a real gap) but cap it with a minimum spacing, for example skip
  when a reconcile `done` row exists from the last 10 minutes.

### L7. Backup reads the whole DB into memory, and restart backups crowd out history (class H, D)

- Location: `packages/storage/src/backup.ts:130-132` (`sha256Of` = `crypto.createHash('sha256').update(fs.readFileSync(filePath))`),
  `backup.ts:53` (`VACUUM INTO`, synchronous), `backup.ts:87-99` (`pruneBackups` keeps the newest `retain` by name),
  `apps/daemon/src/runtime/backup-timer.ts:82` (runs once at every start), config defaults
  `packages/core/src/config/schema.ts:167-168` (interval 1440 min, retain 14).
- Mechanism: (a) the checksum reads the entire backup file into one Buffer, synchronously on the event loop;
  with L1/L3 growth the DB size, and so the heap spike and stall, grow without bound, and above 2 GiB
  `readFileSync` throws and the backup fails (logged at error, not fatal, `backup-timer.ts:66-73`). (b) Retention is by
  count, and a backup also runs at every start, so 14 restarts within a day or two evict every older
  backup, silently shrinking the recovery window from 14 days to hours.
- Intended vs worst case: 14 daily backups, about 14 days of history, bounded memory; actual is 14 most
  recent backups regardless of age, with a transient heap equal to DB size.
- Severity/confidence: medium (data-safety rather than resource exhaustion), confirmed in code.
- Live check: log `backup complete` lines carry `fileName` and `sizeBytes` fields:
  `journalctl -u bananasaurs | grep "backup complete"`; compare timestamps in the 14 retained file names
  (`ls -l --time-style=full-iso backups/` run by you, the path is deny-listed for me). Also
  `grep -c "backup failed"` for ERR_FS_FILE_TOO_LARGE style failures.
- Fix sketch: hash with a stream (`fs.createReadStream` piped into `createHash`) in a `await`ed helper so
  memory is constant and the loop yields; skip the startup backup when the newest file is younger than
  the interval; change `pruneBackups` to keep at least one backup per day for `retain` days (or keep N
  daily plus the newest M), so frequent restarts cannot evict the daily set.

### L8. OAuth: expired-but-unrevoked access tokens and all registered clients are never purged (class C)

- Location: `packages/storage/src/repos/oauth.ts:673-691` (`purgeExpired` deletes tokens only when
  `expires_at <= now AND revoked_at IS NOT NULL`), `oauth.ts:640-643` (`rotateRefreshToken` revokes only the
  old refresh token), `packages/http/src/oauth/provider.ts:12-13` (access TTL 1 h, refresh TTL 30 d),
  `packages/http/src/routes/oauth.ts:144-148` (`POST /oauth/register`: 20 per hour, one global bucket),
  no delete of `oauth_clients` except an explicit revoke (`oauth.ts:271`).
- Mechanism: each refresh rotation mints an access token that simply expires; it is never revoked, so the
  purge predicate never matches it. A connected MCP client therefore leaves about 24 permanent rows per day.
  The registration endpoint is unauthenticated (rate-limited globally, not per caller): up to 480 junk
  `oauth_clients` rows per day can accumulate and the code relies on the operator running `revoke-client`.
- Intended vs worst case: the purge comment says tokens accumulate "at a rate an unauthenticated stranger
  sets"; intended is bounded by TTL; actual is unbounded by TTL for access tokens and unbounded for clients.
- Severity/confidence: low-medium (rows are tiny), confirmed in code.
- Live check:
  ```sql
  SELECT kind, count(*) AS n,
         sum(revoked_at IS NULL AND expires_at < CAST(strftime('%s','now') AS INTEGER)*1000) AS dead_unrevoked
  FROM oauth_tokens GROUP BY kind;
  SELECT registration_source, count(*), datetime(min(created_at)/1000,'unixepoch') FROM oauth_clients GROUP BY 1;
  ```
- Fix sketch: change the purge predicate to `expires_at <= now - grace` regardless of `revoked_at` (an
  expired token is dead either way; keep a short grace such as 7 days only if `mcp tokens` needs to show recent
  history). Add an expiry for `dynamic` clients that never completed a consent (no token issued within, say, 24 h)
  and purge them in the same daily pass.

### L9. `deliver_reminders` can re-enqueue every 30 s if the handler fails persistently (class A, B)

- Location: `apps/daemon/src/runtime/reminder-timer.ts:56-75`, key `packages/core/src/jobs/kinds.ts:322`
  (constant per guild), guard `packages/storage/src/repos/assistant.ts:472-503` (`hasDeliverableReminders`),
  worker `packages/core/src/jobs/worker.ts:218-243`.
- Mechanism: the timer enqueues whenever a deliverable reminder exists. If the handler then throws on a store error
  (per-reminder Discord failures are caught inside `deliverDueReminders`, `packages/core/src/assistant/reminders.ts:211-240`,
  so only claim/DB errors escape), the job retries up to `max_attempts` (5, backoff 1/2/4/8 s) and ends `failed`. `failed`
  is outside `jobs_dedupe`, so the next tick 30 s later enqueues a new job. Net: up to 2,880 new failed jobs/day, each
  with five error log lines. Needs a persistent store-level fault, so this is rare.
- Intended vs worst case: zero jobs when nothing is due; worst case about 2,880 jobs and 14,400 error logs per day.
- Severity/confidence: low, suspected (mechanism confirmed, trigger not observed).
- Live check:
  ```sql
  SELECT state, count(*) FROM jobs WHERE kind='deliver_reminders'
   AND created_at > (strftime('%s','now')-86400)*1000 GROUP BY state;
  SELECT status, count(*) FROM assistant_reminders GROUP BY status;
  ```
  Logs: `grep '"jobKind":"deliver_reminders"' | grep -c "job failed"` in the last day.
- Fix sketch: have the timer skip enqueueing when the most recent `deliver_reminders` job for the guild is
  `failed` and younger than a cool-down (for example 5 minutes), or use `runAfter` with the worker's backoff
  rather than a fresh row; same "done/failed in the last interval" check proposed in L6.

### L10. Automod fetches the author's member record over REST for every message when a rule has a role exemption (class F, G)

- Location: `packages/core/src/automod/subscriber.ts:276-292` (`roleIdsOnce`, per message, no cross-message cache),
  `apps/daemon/src/automod/wiring.ts:385` (`authorRoleIds: ... discord.fetchMember(...)`), REST options
  `packages/discord/src/client.ts:180-186` (`rejectOnRateLimit: () => true`, `retries: 0`).
- Mechanism: the subscriber already avoids the call when no rule has a role exemption
  (`hasRoleExemption`). When one does, every chat message in the guild issues `GET /guilds/{g}/members/{u}`
  on the latency path in front of any deletion. Under a burst, Discord's route limit makes the call throw
  (`rejectOnRateLimit`), which is caught, treated as "no roles", and logged at `warn` once per message
  ("could not read the author's roles"), which also evaluates the rule with no exemption applied.
- Intended vs worst case: only matched messages incur cost; actual is one REST call per message (and one warn
  per failed call) once any role exemption exists.
- Severity/confidence: low-medium, confirmed in code; conditional on a role exemption being configured.
- Live check:
  ```sql
  SELECT rule_id, count(*) FROM mod_rule_exemptions WHERE exempt_type='role' GROUP BY rule_id;
  ```
  Logs: `grep -c "could not read the author"`.
- Fix sketch: resolve the author's roles from the discord.js member cache first (the cache keeps the bot and
  recently active members; `GuildMemberManager` is capped at 50, so add a small TTL map keyed
  `guild:user` with a short lifetime and size cap), and only fall back to REST on a miss. If the fetch fails,
  prefer failing closed for exemption purposes only when the rule is in enforce mode.

### L11. Archive backfill has no pacing and can strand a channel (class B, F)

- Location: `packages/core/src/archive/backfill.ts:262-270` (continuation with `runAfter: ports.now()`),
  `packages/core/src/jobs/worker.ts:208-216` (`drain(limit = 50)`), `apps/daemon/src/runtime/daemon.ts:595-607`
  and `661-665` (drain every 1 s), `packages/storage/src/repos/jobs.ts:186-199` (give up at `max_attempts`).
- Mechanism: the code comment says "the job-poll interval is the throttle", but `drain` loops until idle or
  50 jobs, so a freshly enqueued continuation is claimed in the same drain: up to 50 pages (50 REST
  fetches of 100 messages) per second until Discord's limiter trips. With `rejectOnRateLimit` the fetch throws,
  the worker retries with 1/2/4/8 s backoff, and after five consecutive rate-limit failures the page job
  becomes `failed` with no successor enqueued, leaving `archive_channels.backfill_state='running'` forever. Stop
  condition itself is sound (`nextBefore` undefined on a short page, `rest/port.ts:539-546`); this is pacing, not a loop.
- Intended vs worst case: about one page per tick; actual is a burst of up to 50, then rate-limit errors.
- Severity/confidence: low, suspected (depends on archive being enabled and a large channel).
- Live check:
  ```sql
  SELECT state, count(*), max(attempts) FROM jobs WHERE kind='archive_backfill' GROUP BY state;
  SELECT backfill_state, count(*) FROM archive_channels GROUP BY backfill_state;
  SELECT substr(last_error,1,120), count(*) FROM jobs WHERE kind='archive_backfill' AND state='failed' GROUP BY 1;
  ```
- Fix sketch: set the continuation's `runAfter` to `now + spacing` (for example 1 s, like `PURGE_TICK_SPACING_MS`
  in `packages/core/src/mod/purge.ts:428`), and treat a rate-limit error as a `RetryAfterError` with the bucket's
  retry-after so it never burns attempts. Add a resume path (dashboard/CLI or doctor check) for channels stuck in `running`.

### L12. Task nudge pass writes per open task every minute; task tables never pruned (class A, C)

- Location: `apps/daemon/src/runtime/daemon.ts:562-591, 659` (every 60 s), `apps/daemon/src/jobs/task-nudges.ts:88-139`
  (`planTaskNudges` loops all open tasks calling `repo.schedule`, an `INSERT ... ON CONFLICT DO NOTHING` in its
  own `write()` transaction, on every pass), `packages/storage/src/repos/task-nudges.ts:30-60, 303-310`
  (`openTasks` loads every non-archived task including `done`), `task-nudges.ts:278-286` (`pruneReplyChoices` runs every minute).
- Mechanism: idempotent, so no duplicate rows, but it is N write transactions plus a full task scan per minute per
  guild forever, and `task_nudge_slots`/`task_nudge_deliveries`/`task_nudge_slot_tasks` and `club_tasks` (done
  tasks stay unless archived) have no retention. Growth is task-driven (small).
- Intended vs worst case: negligible for tens of tasks; scales linearly with the number of tasks and
  is wasted work after the first pass for each.
- Severity/confidence: low, confirmed in code.
- Live check:
  ```sql
  SELECT count(*) AS open_tasks FROM club_tasks WHERE archived_at IS NULL;
  SELECT state, count(*) FROM task_nudge_slots GROUP BY state;
  SELECT count(*) FROM task_nudge_deliveries;
  ```
- Fix sketch: only plan for tasks whose `updated_at` changed since the last pass or whose due time crossed a
  threshold (keep an in-memory `lastPlannedVersion` per task, which is safe because the insert is idempotent
  anyway), restrict `openTasks` to non-`done` rows for planning, and prune terminal slots and deliveries older
  than a retention window in the same pass.

### L13. Small event-rate tables with no retention (class C)

Confirmed in code, each is low volume and driven by human or connection events, listed so none is forgotten:

- `gateway_gaps` (`schema.ts:421`): one row per connection event per guild, including every restart (L6). No prune.
- `message_delete_runs` (`schema.ts:677`): one row per (actor, author, channel) combination. No prune.
- `dashboard_sessions` (`schema.ts:1605`): expired and revoked sessions stay. No prune.
- `mcp_sends`, `mcp_actions`, `mcp_bulk_previews`, `mcp_private_threads` (`schema.ts:1816-1973`): idempotency
  ledgers, no prune (reads in `repos/mcp-*.ts` never delete).
- `assistant_reminders` (`schema.ts:2372`): done, failed and cancelled reminders stay.
- `assistant_skill_activity`, `assistant_tickets`, `assistant_decisions` (`schema.ts:2417, 2459, 2483`): no prune.
- `role_effects`, `effect_batches` (`schema.ts:253, 289`): effect ledgers, no prune.
- `automod_fixtures`, `automod_fixture_attachments` (`schema.ts:1293, 1373`): observed fixtures capture matched
  message text (`packages/storage/src/repos/automod-fixtures.ts:84-136`) with no cap and no expiry; only
  `deleteObservedFixturesForMember` removes them. The default rule ships in test mode, so every match is captured.
- `mod_pending_actions` (`schema.ts:1472`): expired intents are deleted only when taken; the sweep
  `sweepExpiredPendingActions` (`repos/mod-pending.ts:136`) has no scheduler (note at `core/src/mod/confirmations.ts:744`).
- `assistant_traces` rows with `conversation_id IS NULL` (chain-failure traces,
  `apps/daemon/src/jobs/assistant.ts:821-846`, when no conversation exists) are not reached by
  `deleteTracesForConversations`.
- `archive_messages` live rows and `archive_message_edits` for live messages are kept indefinitely by design
  (`repos/archive.ts:817-825`); the expiry job also loads every deleted-but-unpurged row each day, including
  `preserve` and open-case rows that never purge (`archive.ts:775-785`).
- Live check (one query):
  ```sql
  SELECT 'gateway_gaps', count(*) FROM gateway_gaps UNION ALL
  SELECT 'message_delete_runs', count(*) FROM message_delete_runs UNION ALL
  SELECT 'dashboard_sessions', count(*) FROM dashboard_sessions UNION ALL
  SELECT 'mcp_actions', count(*) FROM mcp_actions UNION ALL
  SELECT 'mcp_sends', count(*) FROM mcp_sends UNION ALL
  SELECT 'assistant_reminders_terminal', count(*) FROM assistant_reminders WHERE status NOT IN ('scheduled','delivering') UNION ALL
  SELECT 'assistant_skill_activity', count(*) FROM assistant_skill_activity UNION ALL
  SELECT 'automod_fixtures_observed', count(*) FROM automod_fixtures WHERE source='observed' UNION ALL
  SELECT 'mod_pending_expired', count(*) FROM mod_pending_actions WHERE expires_at < CAST(strftime('%s','now') AS INTEGER)*1000 UNION ALL
  SELECT 'traces_no_conversation', count(*) FROM assistant_traces WHERE conversation_id IS NULL;
  ```
- Fix sketch: one generic `housekeeping` daily pass (same timer as L3/L4) with a small table of
  `(table, timestamp column, retention)` entries and bounded `DELETE ... LIMIT` batches; decide per table, in an ADR,
  which are audit-grade (keep) and which are operational (prune). Wire `sweepExpiredPendingActions` into it.

### L14. GitHub refresh calls are unconditional per sweep and cover disabled resources (class F)

- Location: `apps/daemon/src/assistant/github-refresh.ts:157-162` (the org re-list throttle applies only when
  `!deps.client.authenticated`), `github-refresh.ts:296-323` (authenticated path: `getRepo` + recursive `listTree` per
  repo every refresh, no ETag; ETag is used only for file content at `:366`), `apps/daemon/src/jobs/resource-refresh.ts:49-87`
  (the sweep refreshes every resource, "not only enabled ones", plus each org's new children),
  `apps/daemon/src/assistant/github-client.ts:186-233` (org listing pages up to `MAX_PAGES`).
- Mechanism: independent of the hourly-bucket bug, a single correct sweep spends about `1 + 2R` API calls for an
  org with R repos (list, then `getRepo` and `listTree` each) plus one conditional request per file, and it does so
  for disabled repos too. With the known bug (about 60 sweeps/hour) an org of 20 repos is around 2,400
  GitHub API calls/hour against a 5,000/hour authenticated budget, which also starves interactive GitHub
  imports from the dashboard (`packages/http/src/routes/assistant-github.ts`, which surfaces the 429).
- Intended vs worst case: about 41 calls/hour for 20 repos; worst case about 2,460 with the known bug,
  and still O(R) per sweep without it.
- Severity/confidence: medium, confirmed in code.
- Live check:
  ```sql
  SELECT kind, enabled, count(*) FROM assistant_resources GROUP BY kind, enabled;
  ```
  Logs: `grep -c "resource cache: refreshed"` per hour; the stored fetch detail rows carry the
  "rate limit" sentence when GitHub throttles: `grep -i "rate limit" ` on the resource fetch status in the dashboard.
- Fix sketch: skip disabled resources in the all-resource sweep (the handler comment already calls it "a wasted
  fetch"), send `If-None-Match` on `getRepo` and `listTree` (store the ETags beside the document rows), apply
  a per-repo minimum interval equal to the bucket regardless of caller, and honour `X-RateLimit-Remaining` by
  deferring the rest of the sweep with a `RetryAfterError` once it falls below a floor.

---

## Class-by-class notes that did not become findings

- A (timers), full inventory: see the table in "Checked and clean". Besides L5, L6, L9 the only other timer gap is
  the daily keys (`archive_expiry:<day>`, `conversation_prune:<day>`), which re-enqueue on each restart once the
  day's job is `done`: bounded by restart count (L6).
- B (self-perpetuating jobs): `mod_purge` is bounded by `PURGE_MAX_MESSAGES = 500`
  (`core/src/mod/purge.ts:466, 536`); `archive_backfill` terminates (L11 is pacing only); `assistant_summarise` skips
  rather than retries (`runtime/guild.ts:1149-1183`); `log_message_delete` retries are capped by `max_attempts = 5`
  with capped exponential backoff (`repos/jobs.ts:140-200`); `adopt_panel` has no producer at all (handler only,
  `jobs/adopt.ts:24`), so it cannot loop.
- E (listener/interval leaks): none. `buildGuildRuntime` and `createDaemon` are each called once
  (`index.ts:295`, `daemon.ts:292`); every `client.on` is at composition time (`daemon.ts:518-558`,
  `discord/src/events.ts`); `instanceSettings.onChange` is registered once (`daemon.ts:212`); `process.on` only
  for SIGINT/SIGTERM (`index.ts:383-385`); MCP creates a stateless server per request and closes it on the reply
  `close` event (`mcp/wiring.ts:6914-6920`).
- G (log volume): after the known bug is fixed there is no per-minute steady-state info/warn line. Per-event
  `info` exists only for jobs (`worker.ts:188-197`, one `job completed` per job, so it scales with L1's row rate),
  `archive: expiry enqueued for the day` (daily, unconditional, `archive-expiry-timer.ts:80-83`), and
  connection events. Fastify request logging is off (`packages/http/src/server.ts:485`). The one per-message
  `warn` risk is L10.
- H (files): only `backups/*.db` and `.sha256` are written (L7), plus the single-writer lock file
  (`storage/src/lock.ts:123`) and key files at first run. No attachment bytes, exports or temp files exist in
  source (`rg` for `writeFileSync|createWriteStream|mkdtemp|tmpdir` finds only backup and lock). WAL: autocheckpoint
  default only, `wal_checkpoint(TRUNCATE)` at close (`storage/src/db.ts:69-71`), no `journal_size_limit`; with a
  single connection there are no long readers pinning the WAL, so growth is bounded by the largest write burst
  (low).

## Checked and clean

Timers and schedulers

- Job poll (`daemon.ts:661`, 1 s): non-reentrant (`draining` flag, `daemon.ts:595-607`), `drain(50)` cap, unref'd, cleared in `stop()`.
- Task nudge timer (`daemon.ts:659`, 60 s): guarded by `taskNudgeRunning`, skipped in readonly, cleared in `stop()`; see L12 for cost.
- Reminder timer (`reminder-timer.ts`, 30 s): peek-before-enqueue (`hasDeliverableReminders`) means no empty jobs; only L9 failure case.
- Archive-expiry timer (`archive-expiry-timer.ts`, 24 h, day key, skipped when no archive channels): fine apart from L6 restarts.
- Conversation-prune timer (`conversation-prune-timer.ts`, 24 h, day key, `hasConversations` peek): fine apart from L6.
- Backup timer (`backup-timer.ts`, default 1440 min): fine apart from L7; failure is caught and logged.
- Typing keepalive (`assistant/typing.ts:45-63`): hard `maxMs` (180 s), cleared on every path, unref'd.
- Resource fetch timeout timer (`resource-fetcher.ts:213-222`): cleared on end, close, error and discard.
- `startTyping`, `setTimeout` in `cli/src/client.ts:67`: per-invocation, process exits.

Tables with retention found (and the file that does it)

- `event_dedupe`: handler exists (`repos/pipeline.ts:83`) but unscheduled, see L3.
- `assistant_conversations`, `assistant_conversation_turns`, `assistant_conversation_messages`, `assistant_conversation_links`
  and the conversation FTS: daily `conversation_prune` (`jobs/conversation-prune.ts`, retention default 182 d,
  `repos/assistant.ts:215`), cascade deletes (`repos/conversations.ts:703-722`).
- `assistant_traces`: deleted with their conversation (`repos/traces.ts:138-148`) and on forget (`traces.ts:124-132`).
- `assistant_model_calls`: pruned to 48 h on every reserve (`repos/model-calls.ts:55-63`).
- `assistant_search_calls`: pruned to 32 days on reserve (`repos/search-keys.ts:270-295`).
- `task_reply_choices`: pruned at 7 days on every nudge pass (`repos/task-nudges.ts:278-286`, `daemon.ts:572`).
- `oauth_pending_authorizations`, `oauth_authorization_codes`: purged daily at expiry (`repos/oauth.ts:677-685`); `oauth_tokens` partially, see L8.
- `bootstrap_tokens`: unconsumed rows replaced on re-issue (`repos/accounts.ts:479`); one consumed row remains.
- `archive_messages` content, `archive_message_edits`, `archive_attachments` for deleted messages: daily `archive_expiry`
  (`repos/archive.ts:773-815`), three tiers; live-message rows kept by design.
- `resource_documents`, `resource_chunks` and the resource FTS: replaced on refresh, stale docs deleted
  (`repos/resource-cache.ts:297-361`), cascade on resource delete.
- `log_member_snapshots`: deleted on member leave (`core/src/logging/subscriber.ts:380, 409, 421`); at most one row per member.
- `panels`, `panel_options`, `panel_blocked_roles`, `managed_role_assignments`: deleted by their own commands (`repos/panels.ts`, `repos/effects.ts:314`).

Tables that are configuration, bounded by admin action (no retention needed)

`guilds`, `managed_roles`, `mod_rules`, `mod_rule_exemptions`, `word_categories`, `word_terms`, `word_allowlist`,
`automod_invite_allowlist`, `automod_link_domains`, `archive_channels`, `log_routes`, `log_route_events`,
`log_route_exclusions`, `log_excluded_channels`, `dashboard_accounts`, `account_guild_access`, `account_capabilities`,
`principals`, `capability_grants`, `mcp_send_allowlist`, `mcp_role_policy`, `mcp_role_allowlist`, `provider_eligibility`,
`assistant_provider_config`, `assistant_provider_keys`, `assistant_model_chain`, `instance_settings`, `assistant_search_keys`,
`assistant_server_cards`, `assistant_memories`, `assistant_memory_preferences`, `assistant_behaviours`, `assistant_settings`,
`assistant_resources`, `assistant_skill_grants`, `task_teams`, `task_team_members`, `task_guild_roles`, `task_quiet_hours`,
`task_assignees`, `task_message_anchors`, `task_children`, `task_reports`, `mod_cases`, `mod_case_events`, `mod_match_reviews`
(moderation history, kept on purpose; the archive reads them for its case tier).

In-memory structures

- discord.js cache config is applied: `createDiscordClient` (`discord/src/client.ts:260-264`) is the only constructor
  and `index.ts:252` uses it; `assertClientOptions` reads each limit back through the factory and refuses to start on a
  mismatch (`client.ts:220-257`). Limits: `MessageManager` 25, `GuildMemberManager` 50 with the bot kept, reactions,
  presences, voice states, stickers, scheduled events and thread members 0; sweepers: messages every 300 s with 900 s
  lifetime, users hourly (all but the bot), threads (discord.js default, confirmed in `node_modules/discord.js/src/util/Options.js:209-216`).
- `daemon.ts` `chains` and `inFlight` (`:439-491`): entries removed when the chain tail settles.
- `Pipeline.#departed` (`core/src/pipeline/pipeline.ts:67`): keyed by unlisted guild id, bounded by guilds the bot is invited to.
- `RestPort.deferred` (`discord/src/rest/port.ts:130-138`): pruned on every write against a 15-minute window.
- `createRateLimiter` (`http/src/oauth/rate-limit.ts`): prunes expired keys on every `check`.
- `triedAtByAccount` (`http/src/routes/assistant-try.ts:39`): keyed by dashboard account, filtered to the one-hour window on use.
- `assistantMemberCache` (`apps/daemon/src/http/wiring.ts:180`): keyed by allowlisted guild, 5-minute TTL (not coalesced,
  so concurrent dashboard calls after expiry each page the member list; low).
- `mcpLimiterRegistry` (`mcp/roles-gateway.ts:81`): one limiter per guild.
- `QuotaLedger.resets` (`assistant/quota-ledger.ts`): keyed by provider key id, entries removed on expiry.
- `createWindowStore` (`core/src/automod/window.ts:140-186`): hard caps `maxEventsPerMember` and `maxMembers` (500) with LRU eviction.
- Automod `PredicateCache` (`core/src/automod/evaluate.ts:56`): keyed `guild:rule`, bounded by rule count.
- `ReactionStateCache` (`core/src/panels/reactions.ts:58`): constructed per panel per pass, not shared across events.
- `instance-settings-store` `cache`, `warned`, `listeners` (`settings/instance-settings-store.ts:57-60`): bounded by the fixed set of setting keys.
- `ReviewedResourceFetcher.#cache` (`assistant/resource-fetcher.ts:237`): an unbounded URL-keyed map that is never evicted,
  but it is only populated when `fetch` is called without a conditional, and both production callers pass one
  (`resource-refresh.ts:204`, `github-refresh.ts:362`), and the assistant's live fetch is hard-disabled
  (`assistant/service.ts:350-354`). Dormant. Becomes a leak if a no-conditional caller is added.
- Per-request MCP `enabledCache` (`mcp/wiring.ts:979`): lives for one request.

Network and sockets

- Timeouts exist on every outbound path: GitHub 10 s (`github-client.ts:17,153`, `github-fetch.ts:21`), Brave and Tavily
  10 s, resource fetch 5 s default and owner-tunable, provider calls via the provider layer's `timeoutMs`,
  public-surface probe 5 s with a total budget.
- Discord REST: `retries: 0` and `rejectOnRateLimit` so nothing retries behind the budget (`discord/src/client.ts:180-186`).
- Ops socket buffer is capped (`ops/socket.ts:178-194`), reads stop after the cap.
- Assistant tool loop is bounded per question (`maxToolRounds` 4 default, max 8; `maxToolCalls` 12 default, max 30).
- Purge, backfill and reconcile loops terminate (B above).

## Not verified

- No live data was read (the DB and backups are deny-listed and no commands were run against the running system), so
  every "live check" above is a proposal. The sizes and row counts that decide L1, L2, L3 and L13 severity are unknown to me.
- `BANANASAURS_READONLY` mode: `daemon.start()` runs the job poll and the timers unconditionally
  (`daemon.ts:654-674`), and `write()` throws `ReadonlyError` in read-only mode (`storage/src/write.ts`), so a read-only
  process would error from timer callbacks. I did not trace what happens (the nudge pass and claim reconcile are the only
  guarded paths) because it is not the production configuration; worth a test if read-only is ever used with `start`.
