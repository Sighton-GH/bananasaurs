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

## Section B — operator CLI, dashboard (run 2026-08-30)

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
- [x] Bot status is available on the dashboard and through `npm run doctor`.
      `/mod` and its subcommands are the only Discord slash commands.

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

## Section D — the MCP connector over the tunnel (slice M6, run 2026-09-20)

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

- [x] Steps 1–10 recorded with timestamps in `docs/reports/mcp-m6-live-run.md` (all pass; six findings, one needing a ruling).

## Section E — the automod switch (dev guild)

**Dev guild only. Never the club.** This checks the Off / Watch / On switch
(ADR 0121) end to end before it is used on the club. Record the run in
`docs/reports/release2-gate-signoff.md` Section E, with timestamps.

Preconditions: the daemon is up on a build with migrations 0100 and 0101
applied; the dev guild has an enabled `keyword_filter` rule with a harmless
term.

1. **Off to start.** `bananasaurs doctor` over SSH shows
   `automod           off`.
2. **Off records nothing.** Post the term in the dev guild. Confirm the
   Review page shows no new match and the message is untouched.
3. **Watch.** On the dashboard's Automod tab, choose Watch and confirm. The
   password is asked for. Post the term again: one match appears on Review
   and the message is untouched. Choose “Should be allowed” on it.
4. **On.** Choose On. Confirm the dialog lists the enabled rules and says to
   turn off the matching Carl-bot or Dyno automod first. With dry run on
   (`bananasaurs config set dry_run true --confirm`), post the term: the
   case history records `delete_blocked_dry_run` and the message stays.
   With dry run off (`config set dry_run false --confirm`), post it again:
   the message is deleted.
5. **Off, without a password.** Choose Off. Confirm no password prompt
   appears. Post the term: nothing is recorded.
6. **The audit trail.** The Audit page shows three `automod.state_set`
   rows — off → watch, watch → on, on → off — each with its before and
   after state.

- [ ] Steps 1–6 recorded with timestamps in the sign-off document.

## Section F — assistant harness v2 on the test guild (not yet run)

**Test guild only. Nothing here deletes anything.** Run signed in as the owner, with the daemon up on a build that includes ADRs 0069–0077 (migrations 0037–0046 applied) and a reviewed, enabled behaviour on the test guild. Record the run with timestamps.

Preconditions: `bananasaurs doctor` is clean; the AI setup page shows the model chain with at least one Ready entry; the test guild has an enabled behaviour whose tag (for example `@bananasaurs`) members may use. Before starting a build without slash commands, make sure one behaviour answers the bot tag.

1. **Tag the bot.** Post a question in a visible channel tagging the bot (for example `@bananasaurs when is the next meeting?`).
   What you should see: the bot posts its answer as a Discord reply to your message, and if the answer uses a club source, it ends with a short `-# Sources:` line naming only that source; an answer that cites nothing has no Sources line.
2. **Reply to its answer.** Use Discord's Reply on the bot's answer message and ask a follow-up (for example `and where?`).
   What you should see: the bot answers as a reply again, and the answer shows it continued the same conversation (it uses your first question's context without being told).
3. **Quoted context from another member.** Have a second member post an ordinary message (for example `the lake meet moved to Sunday`). Reply to *that* message, tag the bot in the reply, and ask about it (for example `@bananasaurs what moved?`).
   What you should see: the bot's answer draws on the replied-to member message as quoted context.
4. **Import a GitHub organisation.** On the Resources page, open "Add from GitHub", paste a small public organisation URL, and confirm the preview lists its repositories.
   What you should see: the preview shows repo names with fork/archived toggles and per-repo checkboxes; adding creates one parent resource plus one child resource per selected repo.
5. **"Update now".** On the Resources page, press "Update now" on one imported resource.
   What you should see: the resource refreshes (freshness timestamp advances, or a fetch error is recorded against that resource only) while the other resources are untouched.
6. **Ask what the cache answers.** Back in Discord, tag the bot with a question the imported repository answers.
   What you should see: the answer arrives as a reply and its `-# Sources:` line names the imported repository when the answer drew on it; an answer that cites nothing has no Sources line.
7. **"Try it" on the behaviour.** On the Behaviours page, open the behaviour, type a question into "Try it" and submit; then submit a follow-up with the conversation continued.
   What you should see: the answer appears on the page with its trace id, and nothing is posted to Discord.
8. **Conversations page and History trace.** Open the Conversations page and find the Discord conversation from steps 1–3; open its transcript, then follow the link to one of its traces on History.
   What you should see: the transcript shows each turn with links to Discord and to the History trace; the trace shows the model attempts, the tool calls with their results, and the prompt sections.
9. **Feedback reaction.** In Discord, add a 👍 reaction to one of the bot's answers, then remove it.
   What you should see: the reaction is accepted as feedback on that answer (its History trace gains a `feedback:up` flag); removing the reaction clears the feedback record, while the trace keeps the flag as history.
10. **Prune retention setting.** On the Conversations page, read the auto-delete retention control and confirm it shows the current setting (2 / 6 / 12 months or Keep forever). Change nothing.
    What you should see: the setting is displayed with its current value; no conversation is deleted, ended, or otherwise touched.

- [ ] Steps 1–10 recorded with timestamps (no destructive step taken).

## Section G — MCP message writes on the test guild (slice 3, not yet run)

**Test guild only.** The unit and composition suites prove the ledger, the
target checks and the inverses against fakes; what they cannot prove is the
live Discord behaviour — permission errors, mention rendering, thread
visibility — so each write tool below runs once against the real test
guild, from the owner's Claude client through the tunnel connector.
Preconditions: `bananasaurs doctor` is clean; one text channel allowlisted
for sends; the connector authorised with `bananasaurs:read` **and**
`bananasaurs:send`. Record the run with timestamps.

1. **`send_message` with a reply and an embed.** Post content with
   `@everyone` in the text plus one embed, as a reply without
   `pingReplyAuthor`. Confirm in Discord: the message is there as a reply,
   **nobody was pinged**, and the embed renders.
2. **`send_message` pings only through `pingRoles`/`pingUsers`.** Post
   naming one low role in `pingRoles` and one member in `pingUsers`.
   Confirm only those two notify, and the audit row carries ids, never the
   text.
3. **`create_thread` (private) then `send_message` into it.** Create a
   private thread with a first message. Confirm `read_thread` reads it and
   a follow-up `send_message` with `threadId` posts into it.
4. **`add_thread_members` / `remove_thread_members`.** Add a member, confirm
   they see the thread; remove them, confirm they no longer do.
5. **`create_forum_post`.** Post with a title and one tag. Confirm the post
   appears in the forum with the tag applied; an unknown tag refuses
   listing the available names.
6. **`archive_thread` / `lock_thread`.** Archive the thread from step 3,
   confirm it archives; unarchive it. Lock it, confirm posting is refused
   to non-moderators; unlock it.
7. **`edit_message` then `undo_action`.** Edit a bot message, confirm the
   new text; call `undo_action` with the edit's action id, confirm the
   previous text returns and a second undo answers "already undone".
8. **`pin_message` / `unpin_message`.** Pin a message, confirm it pins;
   unpin it. A channel where the bot lacks the pin permission refuses
   naming it.
9. **`add_reaction` / `remove_reaction`.** Add a unicode reaction to a bot
   message, confirm it appears; remove it. A foreign guild's custom emoji
   refuses.
10. **`delete_message`.** Delete a bot message, confirm it disappears, and
    confirm `undo_action` on the delete answers that it cannot be undone.
11. **`list_actions`.** Confirm it lists the actions above newest-first with
    kind, status, target ids and `undoable` flags — and no message content
    anywhere in the output.
12. **The retry.** Repeat step 1's call with the **same** `idempotencyKey`.
    Confirm it answers as a replay and Discord has exactly one message.

- [ ] Steps 1–12 recorded with timestamps.

## Section H — MCP roles and panels on the test guild (slice 4, not yet run)

**Test guild only.** The unit suites prove the grant policy, the preview→confirm
hashing, the inverses and the panel validation against fakes; what they cannot
prove is the live Discord behaviour — hierarchy enforcement, dangerous-permission
refusals, job application, panel message ownership — so each roles-scope tool
below runs once against the real test guild, from the owner's Claude client
through the tunnel connector.
Preconditions: `bananasaurs doctor` is clean; one low test role is on the
operator's managed-roles allowlist and below the bot; the connector is
authorised with `bananasaurs:read`, `bananasaurs:send` **and**
`bananasaurs:roles` — re-authorise the MCP client to add the `roles` scope
before starting, and confirm the roles tools appear in the tool list.
Record the run with timestamps.

1. **`grant_role`.** Grant the allowlisted low role to a test member.
   Confirm in Discord the member has the role, and `list_actions` shows the
   grant with its action id.
2. **`remove_role`.** Remove the same role from the same member. Confirm in
   Discord the role is gone.
3. **`undo_action` of a grant.** Grant the role again, then call
   `undo_action` with the grant's action id. Confirm the member loses the
   role, and a second undo of the same action answers "already undone".
4. **A dangerous role refused.** Call `grant_role` for a role holding a
   dangerous permission. Confirm the refusal names the dangerous-permission
   reason and nothing changed in Discord.
5. **An above-bot role refused.** Call `grant_role` for a role above the
   bot's highest role. Confirm the refusal names the hierarchy reason and
   nothing changed in Discord.
6. **`create_role`.** Create a role with a distinctive test name. Confirm in
   Discord it exists with no permissions just below the bot — and that
   granting it refuses as not allowlisted until an operator allowlists it.
7. **`edit_role`.** Rename the role from step 6 and set a colour. Confirm
   the new name and colour in Discord.
8. **`bulk_role_change` preview.** Preview adding the low role to two or
   three test members. Confirm the answer names the count and returns a
   single-use token.
9. **Bulk confirm, then the job, then the members changed.** Confirm with
   the same arguments plus the token and a fresh `idempotencyKey`. Watch
   the job with `get_job` until it completes, then confirm in Discord every
   previewed member gained the role.
10. **A reused token refused.** Repeat the step 9 confirm with the same
    token and new arguments otherwise unchanged. Confirm it refuses as
    already used and nothing new changed.
11. **`create_panel`.** Create a button panel in the allowlisted channel
    with the low role as its option. Confirm the panel message posts in
    Discord.
12. **`edit_panel`.** Change the panel's title and reorder its options.
    Confirm the panel message republishes with the new title and order.
13. **`edit_message` on a panel message refused.** Call `edit_message` on
    the panel message from step 11. Confirm it refuses as a role-panel
    message and the message is unchanged.
14. **`delete_panel`.** Delete the panel. Confirm its message is removed,
    `list_panels` no longer shows it, and members keep whatever roles they
    hold.
15. **The kill switch refuses every roles write.** `bananasaurs killswitch on
    --confirm`, then attempt `grant_role`, `create_role` and `create_panel`:
    all three must refuse naming the kill switch with nothing changed.
    `killswitch off --confirm` restores normal operation.

- [ ] Steps 1–15 recorded with timestamps.

## Section I — MCP schedules, events, polls, caps and policy controls on the test guild (slice 5, not yet run)

**Test guild only.** The unit suites prove the schedule-time and send-time
checks, the undo arms and the cap reads against fakes and a real database;
what they cannot prove is the live path — the reminder worker posting an
`origin='mcp'` row, a ping dropped at send time, Discord's event and poll
behaviour, and a settings edit reaching the next call — so each step below
runs once against the real test guild from the owner's Claude client through
the tunnel connector.
Preconditions: `bananasaurs doctor` is clean; one text channel and one voice
channel are allowlisted for sends; one low test role sits below the bot; the
bot holds ManageEvents on the voice channel; the connector is authorised with
`bananasaurs:read` and `bananasaurs:send`. Record the run with timestamps.

1. **A one-shot `schedule_message`.** Schedule a short text three minutes
   ahead that mentions the low role (`<@&id>`) with the role also in
   `pingRoles`. Confirm `list_scheduled` shows it as scheduled; at the due
   time confirm it posts in the channel exactly as written (no reminder
   framing), the role is notified, and `list_scheduled` now shows it
   delivered.
2. **A recurring schedule, cancelled and undone.** Schedule a daily send.
   Confirm `list_scheduled` shows its first occurrence. `cancel_scheduled`
   it, then `undo_action` the cancel: it is scheduled again. Cancel it once
   more to leave nothing behind.
3. **`edit_scheduled`, then undo.** Schedule a one-shot an hour ahead, edit
   its content and re-time it with `at`. Confirm the listing shows the new
   text and time; `undo_action` the edit and confirm the old text and time
   are back. Cancel it.
4. **A ping dropped at send time.** Schedule a send three minutes ahead
   pinging the low role as in step 1, then switch `bananasaurs mcp role-policy --ping
   allowlist` with the role not allowlisted. At the due time confirm the
   message posts with the role mention rendered but nobody notified, and the
   journal has one `mcp reminder ping dropped` line carrying only ids.
   Switch the ping mode back.
5. **A destination that left scope.** Schedule a send three minutes ahead,
   then `bananasaurs mcp disallow-channel` the channel. At the due time
   confirm nothing posts, `list_scheduled` shows it failed, and the journal
   has one `mcp reminder target out of scope` line carrying only ids.
   Allowlist the channel again.
6. **Assistant reminders unchanged.** Ask the in-Discord assistant for a
   reminder two minutes out. Confirm it delivers exactly as before and never
   appears in `list_scheduled`.
7. **Events.** `create_event` a voice event on the allowlisted voice
   channel; confirm it appears in Discord. `edit_event` its name, then
   `undo_action` the edit and confirm the old name returns. `cancel_event`
   it and confirm Discord shows it cancelled.
8. **An external event without an end time refused.** Call `create_event`
   for an external event with a place and no end time. Confirm the refusal
   and that no event was created.
9. **`create_poll`.** Post a two-answer poll to the allowlisted channel.
   Confirm the native poll renders and nobody was pinged.
10. **A cap edit takes effect with no restart.** On the dashboard AI tuning
    page set `mcp.cap.message` to the count of posts already made this hour
    plus one. Post once (it succeeds), then once more: the second refuses
    naming `mcp.cap.message`. Restore the default (300).
11. **Role-policy controls.** `bananasaurs mcp role-policy` shows both modes
    and the allowlist; `bananasaurs mcp allow-role <low role id> --purpose
    ping` adds a row the dashboard MCP page also shows; `bananasaurs mcp
    allow-role` of `@everyone` or a role with a dangerous permission refuses.
    `bananasaurs mcp disallow-role <low role id> --purpose ping` removes the
    row.
12. **The kill switch refuses the slice 5 writes.** `bananasaurs killswitch
    on --confirm`, then attempt `schedule_message`, `create_event` and
    `create_poll`: all three refuse naming the kill switch with nothing
    changed. `killswitch off --confirm` restores normal operation.

- [ ] Steps 1–12 recorded with timestamps.

## Sign-off

**Release 1 is done — 2026-08-30.** Every box above is checked, run against
the real test guild and the real daemon (`docs/reports/
release1-smoke-tests-live-run.md` has the full account, including two real
dashboard bugs found and fixed live and a confirmed anti-nuke safety
property). `docs/08_ROADMAP.md`'s Release 1 gate paragraph is true without
qualification.
