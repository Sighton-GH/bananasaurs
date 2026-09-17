# Release 1 smoke tests

The checklist for calling Release 1 done, per `docs/08_ROADMAP.md`'s Release 1
gate and `docs/20_AUTONOMOUS_EXECUTION.md`'s WP6 done-when: "a restore has
actually been performed, not just written down." All feature slices (WP1–WP5,
1–15) and the backup/restore hardening (WP6, slice 16) are built and merged;
this document is what turns "the code exists" into "the release is done."

Written 2026-08-30, at the WP6 boundary. Run by a human with real access to
the production-adjacent `./data` and `./backups` directories — this repository's
own `.claude/settings.json` denies an agent read access to both, deliberately,
because they can hold real Discord content. Nothing in section C can be
rehearsed by an agent in this sandbox for that reason; it was rehearsed
instead against a synthetic database (see `docs/SESSION_LOG.md`, WP6 slice
16d) and is listed here as the real-data run that still has to happen.

---

## Section A — core mechanics (already run)

`docs/21_TESTING_THE_BOT.md`'s "Today's run" (steps 0–9) covers connection,
the guild allowlist, dry-run, role panels, reconciliation, and the adoption
pass. **Run 2026-08-29** against the real test guild; four findings, all
fixed and mutation-checked (`docs/reports/WP5-slice-6-live-test.md`,
`docs/SESSION_LOG.md`). Nothing here needs re-running for Release 1 unless a
later change touches the event pipeline, panels, or reconciliation.

- [x] Exercise 1 — connects, leaves an unconfigured guild
- [x] Exercise 2 — dry run performs zero writes
- [x] Exercise 3 — dry run off, a real reaction grants a real role
- [x] Exercise 4 — a deliberate outage repairs itself on reconnect
- [x] Exercise 5 — the adoption allowance actually gates a mass grant
- [x] Exercise 6 — the memory footprint is sane (`docs/15`)

## Section B — operator CLI, dashboard, `/status` (run 2026-08-30)

Built (WP5 slices 13–15) and covered by 1,638+ unit and integration tests
against the fake harness, but never exercised against the real test guild —
`docs/STATE.md`'s own next-action note flagged this as the highest-value
untested surface, precisely because slice 6 already found two things the fake
harness got wrong about Discord that only a live run caught. It found two
more: see `docs/reports/release1-smoke-tests-live-run.md`.

- [x] `bananasaurs status` over SSH reports the real gateway connection, job
      counts and scheduler lag
- [x] `bananasaurs doctor` over SSH matches what `--doctor` reported at
      startup (with a documented scope difference — the live command also
      checks panels/role hierarchy, which the startup check does not)
- [x] `bananasaurs panel sync <id> --confirm` against a real panel; confirm
      the message/reactions actually change on Discord
- [x] `bananasaurs log routing set <event> <channel> --confirm`, then trigger
      that event in the test guild and confirm it logs
- [x] `bananasaurs audit tail` shows the actions just taken, correctly
      attributed
- [x] `bananasaurs killswitch on --confirm` — perform an action in Discord
      that should now produce zero side effects; `killswitch off --confirm`
      restores normal operation
- [x] Dashboard: bootstrap from a printed token, log in, confirm the health
      page, panel config, audit table and kill switch all reflect the real
      instance (health page was missing dry run/breaker/guild identity —
      found live and fixed; see the report)
- [x] Dashboard: a second account cannot reach it (`docs/08`'s Release 1 gate,
      "verified by trying it from another club administrator's account")
- [x] `/status` in the test guild, from a non-owner member, returns an
      ephemeral reply with the real gateway/job state

## Section C — backup and restore (WP6, run 2026-08-30)

**This is the gate `docs/20`'s WP6 line names explicitly.** Everything below
was rehearsed against a synthetic database in WP6 slice 16d
(`docs/SESSION_LOG.md`) — dry run, lock refusal, checksum-mismatch refusal,
the real restore, "never delete," and the missing-checksum warning all
behaved as designed. What has not happened yet is the same sequence against
the actual running daemon and its actual `./data/bananasaurs.db`.

1. **Confirm the timer is running.** `bananasaurs doctor` should report at
   least one backup in `BANANASAURS_BACKUP_DIR`, taken at daemon startup
   (ADR 0034). If it reports none, the daemon has never started since this
   slice was deployed — start it once and re-check.
2. **Take one on demand.** `bananasaurs backup now --confirm`. Confirm the
   reported filename appears in `bananasaurs backup list`.
3. **Verify it by hand, with coreutils alone** — no code from this repository,
   proving the checksum sidecar is independently useful:
   ```bash
   cd <BANANASAURS_BACKUP_DIR>
   sha256sum -c <the-new-file>.db.sha256
   ```
4. **Perform the actual restore drill.**
   ```bash
   sudo systemctl stop bananasaurs
   npm run build   # if not already built — populates packages/storage/dist
   npm run restore -- <the-new-file>.db --confirm
   sudo systemctl start bananasaurs
   bananasaurs doctor
   ```
    Confirm: the daemon starts cleanly, `doctor` reports `ok`, every panel and
    role from before the restore is still correct (the backup was taken
    *after* those changes, so nothing should be lost), and the audit trail is
    continuous up to the restore point. After `npm run restore`, run
    `bananasaurs archive reindex --confirm` for each archive-enabled guild. A
    restored database's FTS index is rebuilt from the restored rows, so
    `doctor` will say `ARCHIVE INDEX STALE` until it is. If `doctor` instead
    fails with `no such table: provider_eligibility`, the restored database
    predates that table's migration — the startup check only verifies the
    `guilds` table exists, so a restored-but-unmigrated database still starts.
    The answer is `npm run db:migrate`, then `doctor` again.
5. **Confirm the pre-restore file survived.** `<db-path>.pre-restore-<ts>`
   should exist next to the live database — the restore moves the old file
   aside rather than deleting it, so it is recoverable if step 4 itself goes
   wrong. Delete it by hand once satisfied; nothing in this codebase ever
   will.
6. **Confirm the refusal path once, deliberately**, so the safety net is
   trusted rather than assumed: with the daemon *running*, attempt
   `npm run restore -- <any-backup> --confirm` and confirm it refuses,
   naming the daemon's pid, rather than doing anything.

- [x] Step 1 — timer confirmed running
- [x] Step 2 — `backup now` taken and listed
- [x] Step 3 — checksum verified with `sha256sum -c`
- [x] Step 4 — full restore drill performed; `doctor` reports `ok` afterward
- [x] Step 5 — pre-restore file confirmed present, then removed
- [x] Step 6 — restore refuses against a running daemon

---

## Section D — the MCP connector over the tunnel (slice M6, not yet run)

Run from a client **off the LAN** — a laptop on mobile data, or the desktop
app somewhere else — so the tunnel and Access are actually in the path.
Record the run in `docs/reports/mcp-m6-live-run.md` in the style of
`release1-smoke-tests-live-run.md`, including what `Host` and `Origin`
arrived as on the consent POST (`docs/17` §2.4 says why).

1. **`doctor` first.** `bananasaurs doctor` over SSH. The `public surface`
   block must be `ok` on all five rows before anything else is attempted —
   if `/mcp` or the well-known document shows `blocked-by-access`, the
   Bypass application is missing and nothing below can work.
2. **Allowlist one test channel.** `bananasaurs mcp allow-channel <id>
   --confirm` on the dev guild, then `mcp allowlist` shows it.
3. **Add the connector** in the Claude desktop app:
   `https://bananasaurs.sighton.ca/mcp`. The browser opens on
   `/oauth/authorize`; Access asks for the owner's identity first, then the
   consent page asks for the dashboard password. Approve
   `bananasaurs:read` **and** `bananasaurs:send`.
4. **Every read tool, once.** `get_health`, `list_channels`, `list_roles`,
   `list_members` (paginate past 100), `search_messages`,
   `read_channel_history`, `get_message`, `list_mod_cases`, `get_mod_case`,
   `list_audit_events`, and the overview resource. Each answer arrives
   inside the evidence envelope.
5. **One send that works.** `send_message` to the allowlisted channel with
   content containing `@everyone`. Confirm in Discord: the message is there,
   **nobody was pinged**, and `bananasaurs mcp sends` lists it with a message
   id.
6. **One send that is refused.** The same call to a channel that is not
   allowlisted. Confirm the refusal names the allowlist, nothing was posted,
   and `mcp sends` did not gain a row.
7. **The retry.** Repeat step 5's call with the **same** `idempotencyKey`.
   Confirm it answers as a replay and Discord has exactly one message.
8. **Revoke and watch it fail.** `bananasaurs mcp tokens`, then
   `mcp revoke <token-id> --confirm`. The very next tool call from the
   connector must fail with a `401`.
9. **claude.ai connector**, one read tool. **Claude Code**,
   `claude mcp add --transport http bananasaurs https://bananasaurs.sighton.ca/mcp`,
   one read tool.
10. **`doctor` again.** Still `ok` on the public surface; the eligibility row
    still fresh.

- [ ] Steps 1–10 recorded with timestamps in `docs/reports/mcp-m6-live-run.md`.

## Sign-off

**Release 1 is done — 2026-08-30.** Every box above is checked, run against
the real test guild and the real daemon (`docs/reports/
release1-smoke-tests-live-run.md` has the full account, including two real
dashboard bugs found and fixed live and a confirmed anti-nuke safety
property). `docs/08_ROADMAP.md`'s Release 1 gate paragraph is true without
qualification.
