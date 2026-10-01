# Automod switch — Off / Watch / On (DRAFT)

**Status:** DRAFT, awaiting owner review. Date: 2026-09-30.
**Supersedes:** ADR 0042 (cutover state and the false-positive gate), the
fixture half of ADR 0041, S11-D6 in ADR 0051, and REVIEW §A4 / §E's per-rule
observe-and-cutover requirement, all by owner decision on 2026-09-30. The
decision will be recorded as ADR 0121 before any code changes.
**Replaces:** the unmerged Slice 11 branch (`worktree-slice-11-cutover`), which
will not be merged.

## 1. What the owner asked for

> "I need to be able to enable or disable automod in the dashboard. It should
> just be a simple toggle with confirmation in the automod tab. Have it off
> right now. I don't want remnants of the testing stage." Then: "include two
> stages, I like having both options; I still want to tune the automod
> algorithm by flagging false positives."

The owner then chose:

- **One server-wide switch, three positions: Off / Watch / On.** Every change
  is confirmed. It starts at **Off**.
- **Remove the testing process and per-rule modes:** test/observe/enforce, the
  cutover states, the 14-day floor, ready, sign-off, legacy ref, the
  false-positive gate, and the Cutover page.
- **Keep tuning:** false-positive / correct flags on matches (the Review page),
  plus "narrow this rule" (suppress) from a false positive.
- **Remove the saved-message corpus (fixtures) and dry-run replay.**

Success: the automod tab has a single Off/Watch/On control with a confirmation
dialog, and it reads Off after deploy. Nothing in the dashboard, CLI, `doctor`
or schema mentions observe windows, cutover, readiness, sign-off, legacy refs,
fixtures or per-rule modes. Flagging and suppress still work.

## 2. What each position means

| Position | Bananasaurs automod does | Recorded |
|---|---|---|
| **Off** | Nothing. Rules are not evaluated. | Nothing new. |
| **Watch** | Evaluates enabled rules; touches no one. | Each match as `would_delete`, `countsAsViolation: false` (ADR 0036). Matches appear on Review for flagging. |
| **On** | Deletes matching messages; escalates repeat offenders per `counts_as_violation`. | What actually happened (`deleted`, `delete_blocked_*`), as today. |

Unchanged, and outside the switch:

- **Kill switch, circuit breaker and guild dry run** still apply under **On**.
  They gate every side effect, not just automod (dry run also gates warns,
  timeouts, purges and MCP sends), so none of them is a testing remnant. With
  dry run on, **On** records `delete_blocked_dry_run` and acts on nothing. The
  switch's card and its On confirmation both say so whenever dry run is on.
- **Native Discord AutoMod hits** are still recorded in every position. They
  are Discord's actions, which we only log (ADR 0038).
- **Per-rule `enabled`** stays. It decides which rules the switch applies to.

## 3. Data

New migration (next free number on `main`, currently **0054**; check it isn't
taken on unmerged branches at plan time):

- `guilds.automod_state TEXT NOT NULL DEFAULT 'off' CHECK IN ('off','watch','on')`.
  Every existing guild gets `'off'`, which meets "have it off right now".
- Drop `guilds.automod_testing_mode`. It is read in one place and written in
  none, so it is dead.
- `mod_rules`: drop `mode`, `cutover_state`, `observe_started_at`,
  `legacy_rule_ref`, `enforce_signed_off_by`, `enforce_signed_off_at`,
  `max_false_positive_rate` and `min_reviewed_matches`, with their CHECKs (a
  table rebuild). `enabled`, `counts_as_violation` and config stay. Existing
  rules keep their `enabled` value.
- Drop `automod_fixtures` and `automod_fixture_attachments`, and drop
  `mod_case_events.fixture_id`. This deletes stored copies of members'
  messages, which shortens retention and is irreversible. The owner chose it.
- Keep `mod_case_events` (with `would_delete`, which Watch uses), `mod_cases`,
  `mod_match_reviews` (the flags), exemptions, and the invite and domain lists.

Guild scope (hard rule 2): the setter is
`setAutomodState(scope: GuildScope, state, actor)`, and the getter is part of
`readSafetyState(scope)`. Neither can be called without a scope.

## 4. Message path (`core/automod/subscriber.ts`)

1. Read `automodState` with the safety state at the top of `handle()`. If it is
   `off`, return before the rules are listed.
2. Replace both `rule.mode !== 'enforce'` branches and the dead
   `automodTestingMode` branch with one check: `watch` records `would_delete`
   and continues.
3. `on` falls through to the existing killswitch / breaker / dry-run / delete /
   escalation path, unchanged.
4. Delete `captureFixture` and everything it feeds.

The guild state is read once per message, never cached across messages, so a
switch to Off takes effect on the next message.

## 5. Surfaces

**HTTP:**

- Add `GET /api/automod/state`, which returns `{ state, dryRun, killswitch, enabledRuleCount }`.
- Add `PUT /api/automod/state { state }`. It requires a fresh password
  (`requireFresh`) and `config.write`, and writes an audit row
  `automod.state_set` with before and after values. Setting the current state
  again is a no-op and writes no row.
- `POST /rules/:id/mode` becomes `POST /rules/:id/enabled { enabled }`.
- Remove the `ready`, `signoff` and `dry-run` routes and the `use-cli` slug.
- Config save no longer withdraws a sign-off.

**Dashboard, automod tab (`/automod`):**

- A card at the top with a three-segment control (Off · Watch · On), a
  one-line meaning for the current position, and a dry-run note when it
  applies. Choosing a position opens `ConfirmDialog`, the same pattern as the
  kill switch:
  - **Off:** "Automod stops checking messages. Nothing new is recorded."
  - **Watch:** "Automod records matches for review and deletes nothing."
  - **On** (danger): "N enabled rules will delete matching messages and
    escalate repeat offenders: <rule names>. Turn off the matching Carl-bot or
    Dyno automod first, so two bots don't act on the same message." The last
    sentence keeps REVIEW §A4's no-overlap rule as a human check.
- **Rules list:** drop the Mode, Stage and Observed columns. Keep Enabled,
  matches, and the false-positive / reviewed counts that link to Review.
- **Rule page:** drop the mode radios, the stage / observed-since / sign-off
  block, "mark ready", "sign off", and the Dry run card. Keep the config
  editor, the Enabled checkbox, exemptions and lists.
- **Nav:** remove "Turn on moderation" (`/cutover`) and its page.
- **Review:** stays as it is: flags, native hits, suppress. Copy that refers to
  the observe window, cutover or the gate is reworded around tuning.
- **Overview pulse and docs page:** reword the observe and cutover text.
- **CLI-web parity:** update the table for the removed commands.

**CLI:**

- Remove `automod dryrun`, `ready` and `signoff`. (`cutover`, `rollback`,
  `observe` and `legacy-ref` never reached main.)
- Keep `review`, `verdict`, `invite-allow`, `invite-deny`, `domain-add` and
  `domain-rm`.
- Add no new CLI command for the switch. The kill switch is the terminal's
  emergency stop.

**`doctor`:**

- Remove the bad-cutover-state and observe-past-window findings, and the
  "drop the rule back to observe" sentence.
- Add a line `automod  off|watch|on`.
- Warn on **On** with dry run on.
- Re-base the Manage Messages check: it fires when the state is `on` and an
  enabled keyword rule exists.

**MCP `health` tool:** add the read-only `automodState` field.

**Seeded default rule** (`daemon.ts`): created `enabled` with no mode. It is
harmless because the guild starts Off.

## 6. Docs

- ADR 0121 records the decision and what it supersedes.
- In REVIEW.md, mark §A4's cutover tracking and §E's automod done-when clause
  as superseded by ADR 0121. The text stays; the note says why.
- Rewrite `docs/08_ROADMAP.md`'s Release 2 automod gate lines.
- Rewrite `docs/17` (the automod command list).
- Delete `docs/SMOKE_TESTS.md` Section E and replace it with a short switch
  check.
- `docs/reports/release2-gate-signoff.md`: replace the automod rows with "On
  reached via the switch (audit row)".
- Update `docs/STATE.md`.
- Keep historical reports and plans; they are records.
- PRIVACY.md: drop the fixture-retention paragraph, if it has one.

## 7. Tests (written first where they touch scope, permissions or retention)

- **Subscriber matrix:** off means `evaluateRule` is never called and no event
  is written. Watch means `would_delete`, no delete, no escalation. On means a
  delete happens, and killswitch, breaker and dry run each block it with their
  existing reasons.
- **Repo:** `setAutomodState` is guild-scoped (a write in guild A does not
  change guild B), and the CHECK rejects other values.
- **Migration:** on a database at 0053 with an observing rule, fixtures and
  flags, the guild becomes `off`, the rule keeps `enabled` and its config, the
  flags survive, and the fixtures tables are gone.
- **Route:** a stale session gets 401/403, a missing capability is refused, a
  change writes one audit row, a same-state write writes none, and the write is
  guild-scoped.
- **Dashboard:** the control renders the current state, each choice opens its
  confirmation, cancel changes nothing, the On dialog lists the enabled rules,
  and the dry-run note appears when dry run is on.
- **"No remnants" guard:** a test that walks the dashboard, CLI-command and
  doctor source for `observe window|cutover|sign-off|legacy ref|fixture`
  outside comments and the Review page's history wording, and fails on a hit.
  We must watch it fail before the removals land.
- Delete the tests of removed code.

## 8. Rollout

Steps:

1. Merge.
2. **stop → migrate → start**. There is a migration, and the build is the
   deploy on this box.
3. Confirm `doctor` shows `automod  off`.
4. The owner switches to Watch or On from the dashboard when ready.

Before choosing On, the owner turns off the overlapping Carl-bot or Dyno
automod.

## 9. Out of scope

- Per-rule watch/on.
- Scheduling the switch.
- A CLI setter.
- Changes to dry run or the kill switch.
- Native AutoMod management.
