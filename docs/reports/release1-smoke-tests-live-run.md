# Release 1 smoke tests — live run against the real test guild — 2026-08-30

Ran `docs/SMOKE_TESTS.md` sections B and C — the two items left after the
2026-08-29 live test (`docs/reports/WP5-slice-6-live-test.md`) covered
section A — against the real test guild (`1540816150026518620`, "Bananasaurs
dev") and the real daemon. Every box in both sections is now checked.
`docs/08_ROADMAP.md`'s Release 1 gate is met without qualification.

**Two real bugs found and fixed live**, both in the dashboard, both small.
**One real safety property confirmed working** that no unit test exercises
end to end: the live Discord guild owner cannot have roles mutated by the
bot, independent of and in addition to the `principals` table.

---

## 0. What this session had to build first

Section C's instructions (`sudo systemctl stop/start bananasaurs`) assume a
systemd-managed daemon. This host had never gone through `docs/17`'s
deployment steps — the daemon had only ever run via `npm run start`. Rather
than stand up the full hardened `/opt` production layout (a real-guild
cutover task, not a test-guild smoke test), this session added
`deploy/bananasaurs-test.service`: a unit that runs as the checkout's own
owner and points at this repo directly, so `./data` and `./backups` are the
real ones `SMOKE_TESTS.md` means. It's intentionally separate from
`deploy/bananasaurs.service` (the hardened template) — see the comment at the
top of the file for the reasoning and the teardown command if it's not
wanted going forward.

## 1. Section B — operator CLI, dashboard, `/status`

All nine checklist items pass. Two things found along the way:

### 1a. Dashboard health page silently dropped `dryRun` and `breakerOpen` (fixed)

`/api/health` (`packages/http/src/routes/read.ts:36-49`) has always returned
`safety.dryRun` and `safety.breakerOpen`, and the frontend even declared them
in `HealthInfo` (`packages/dashboard/src/App.tsx:145`) and fetched them into
state — but the render block only ever displayed `killswitch`
(`App.tsx:266-267`, before the fix). An operator on the health page had no
way to see whether the instance was in dry run, which is exactly the
confusion `docs/21`'s own exercises 2–3 walk through. Fixed by rendering the
two missing fields (`App.tsx:266-269`).

### 1b. Dashboard health page had no guild identity at all (fixed)

Separately, `/api/health` never returned a guild id or name — `HealthInfo`
had no field for it. For a single-guild deployment this is lower severity
than 1a, but the checklist item is literally "confirm the health page ...
reflects the real instance," and a page that cannot say which guild it is
looking at cannot be told apart from any other instance's. Fixed by adding
`guildId`/`guildName` to the `/api/health` response (`read.ts:41-48`, reusing
`session.scope.guildId` and `ports.guildName()` — the same source
`bananasaurs status` already uses, `packages/core/src/ops/commands/
status.ts:111-112`) and rendering them (`App.tsx:266-268`). A regression
assertion was added to the existing `/api/health` test
(`packages/http/src/routes/read.test.ts`, `GET /api/health` describe block).

Both fixes: full `npm run typecheck && npm run lint && npm run test`
(1,638 tests) green before being built and deployed to the live instance for
re-verification (dashboard static files re-served with no restart needed;
the `/api/health` change needed one, since it lives in code the daemon had
already loaded).

### 1c. `doctor` over the socket has a wider scope than `--doctor` at startup (not a bug)

The checklist's "matches what `--doctor` reported at startup" doesn't hold
literally: the live `bananasaurs doctor` command
(`packages/core/src/ops/commands/reads.ts:37-83`) additionally checks panel
status and role hierarchy (`ctx.ports.listPanels()`,
`ctx.ports.listUnassignableRoles()`), which the boot-time check
(`apps/daemon/src/runtime/doctor.ts`) does not. This is documented in the
live command's own `summary` field ("intents, permissions, role hierarchy,
stale panels") — by design, not drift. No code change.

### 1d. Killswitch confirmed as an independent control, not just cosmetic under dry run

Testing this properly needed `BANANASAURS_DRY_RUN=0` temporarily (Bryan
edited `.env` himself, never this session) — otherwise the checklist item is
unfalsifiable, since dry run alone already guarantees zero side effects.
With dry run off and killswitch on, a real member reaction to the seeded test
role produced two `effect refused / reason: killswitch` journal lines
(`packages/core/src/effects/gateway.ts:230`) and zero role change. Killswitch
off, `panel sync --confirm` again, and the role granted for real. `.env` was
returned to `BANANASAURS_DRY_RUN=1` and the daemon restarted before the
session continued, per this project's own testing-session rule.

One observation, not fixed: a refusal (killswitch, protected-target, or any
other `RefusalReason`) only ever produces a `logger.warn` line
(`gateway.ts:199-215`) — never a `role_effects` or `audit_events` row. So
`bananasaurs audit tail` cannot show "N actions were refused while the kill
switch was on"; only `journalctl` can. Plausibly deliberate (avoiding
audit-table noise from routine refusals like `role-not-allowlisted`), but
worth a deliberate decision rather than an accident if an operator ever
needs "prove the kill switch worked" from the audit trail alone.

### 1e. A real anti-nuke property, confirmed live

While chasing why a role grant worked on alt accounts but not the main
(owner) account during the killswitch test: the `principals` table is
completely empty in this guild, so the DB-configured protection
(`packages/storage/src/repos/authz.ts:217-237`) played no part. The actual
refusal came from `packages/core/src/effects/gateway.ts:266`:
`if (member.isGuildOwner) return refuse('protected-target')`, fed by a
**live** Discord API check (`packages/discord/src/rest/port.ts:171`,
`isGuildOwner: (member.user?.id ?? userId) === ownerId`) against the guild's
actual `owner_id`. The literal Discord server owner cannot have roles
mutated by the bot, unconditionally, independent of and in addition to the
`principals` table — exactly the anti-nuke property `docs/STATE.md`'s
"still open" list and ADR 0012 describe, and confirmed working end to end
for the first time. No test in the suite exercises this specific path
(`isGuildOwner` combined with an otherwise-empty `principals` table); worth
a unit test in a follow-up, not urgent since the live behavior is now
verified directly.

## 2. Section C — backup and restore

All six checklist items pass against the real, running daemon and its real
database.

- **Step 1 (timer):** confirmed via every `doctor` output this session — a
  backup is taken at every daemon startup, retention holding the count at a
  steady 14.
- **Step 2 (on-demand backup):** `backup now --confirm` wrote
  `bananasaurs-20260831T015621853Z.db`, retention pruned exactly one older
  file, and it appeared in `backup list`.
- **Step 3 (hand verification):** `sha256sum -c` against the printed
  checksum, run by Bryan directly with coreutils alone — `OK`.
- **Step 4 (the actual drill):** `sudo systemctl stop bananasaurs`,
  `npm run restore -- <file> --confirm`, start, `doctor`. Restore completed
  cleanly; `doctor` reported `ok` (aside from the same pre-existing "deleted
  role" residue from the 2026-08-29 session, unrelated); `test-panel`'s
  option and the full audit trail were intact and continuous across the
  restore.
- **Step 5 (pre-restore file):** confirmed present
  (`data/bananasaurs.db.pre-restore-20260831T015844748Z`), then removed by
  hand once satisfied.
- **Step 6 (refusal path):** with the daemon running, `npm run restore`
  refused, naming the daemon's real pid and the lock file path, and
  performed zero file operations.

### 2a. `restore.mjs`'s console output reads as if it already acted, before it checks (not a bug, worth a polish)

`scripts/restore.mjs:66-69` prints "current database ... moved aside to: X"
and "the current database is moved, never deleted" **before** attempting the
lock claim at line 82 — those lines describe the plan, not a completed
action. Reading the transcript live, this looked exactly like the script had
renamed the live database out from under the running daemon before refusing,
which would have been a serious ordering bug. It is not: `fs.renameSync` /
`fs.copyFileSync` (lines 96-102) are strictly inside the `try` block that
only runs after `claimDatabaseLock` succeeds, and the lock claim threw and
exited (lines 85-93) before reaching them. Confirmed by reading the code, not
by re-running the destructive path. Worth reordering the print statements
after the lock claim in a future pass, purely for operator clarity — not
release-blocking.

---

## 3. Sign-off

`docs/SMOKE_TESTS.md` sections A (2026-08-29), B, and C (both 2026-08-30) are
all fully checked. `docs/08_ROADMAP.md`'s Release 1 gate paragraph is true
without qualification. Release 1 is done.

## 4. Handoff for whoever picks up Release 2

Branch: this report, the two dashboard fixes, the `SMOKE_TESTS.md` checkbox
updates, and `deploy/bananasaurs-test.service` are on
`worktree-smoke-test-systemd-unit`, ready to merge to `main`.

**Read first:** `docs/08_ROADMAP.md`'s Release 2 section, `docs/STATE.md`'s
"still open" item 5.

**First move, per the roadmap's own instruction:** configure Discord's
native AutoMod (Server Settings → AutoMod) against the club's actual current
rules before writing a line of the custom rule engine. If native AutoMod
covers everything Carl-bot's defaults were doing, Release 2 shrinks to just
moderation commands and cases (`/mod timeout/kick/ban/purge`, cases, notes,
protected users, hierarchy checks) — build the custom engine only for the
rules that survive that filter. Two things left over from this session, in
priority order if picked up:

1. `docs/STATE.md` "still open" item 4 (anti-nuke alerting) is partly
   informed by finding 1e above — prevention already works for the literal
   guild owner; whether Bananasaurs should also *alert* on other
   Administrator-holding accounts is still an open call for the owner.
2. Finding 1d's audit-trail gap (refusals aren't durably recorded) is worth
   a deliberate decision before Release 2 adds moderation actions with their
   own refusal paths, so the pattern is decided once rather than per-action.

Not urgent, explicitly out of scope until well past Release 3: the dashboard
is visually minimal by design (`docs/08_ROADMAP.md` puts "the full
dashboard" in the post-Release-3 backlog, `docs/06_DASHBOARD_TARGET.md`).
Noted here only because it came up in this session; do not build it now.
