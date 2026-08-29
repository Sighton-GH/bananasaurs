# WP5 slice 6 — live test against the real test guild — 2026-08-29

Ran `docs/21_TESTING_THE_BOT.md` "Today's run," steps 0–9, against the real test
guild (`1540816150026518620`, "Bananasaurs dev") for the first time. This is the
run STATE.md and the WP5 slice 6 report both called "the highest-value next
step." It found four real defects that 834 tests and 78 mutations against
`FakeDiscord` did not, plus one already-known gap (deferred to slice 11)
manifesting for the first time against real Discord.

**Nothing pushed. No code changed — this is a test run and a report, not a
fix.** The bot never touched the club server; guild allowlist held to the test
guild throughout.

---

## 1. What passed

Steps 0–6 (Exercises 1–4) passed clean, including every "break it on purpose"
case: hierarchy refusal, deleted message, deleted role, the outage (a
reaction *withdrawn* while the daemon was down was correctly repaired on
reconnect), and the rate cap (tripped the breaker on the second action once
the cap was lowered to something a human can exceed by hand — the doc's
"30 in 10 seconds" is not achievable through Discord's own reaction UI at the
default 20/min cap; noted in `docs/21` now).

Step 5's three behaviours (`toggle`, `add_only`, `remove_only`) all matched
their spec exactly, verified against `role_effects` rows rather than log
lines.

Doctor was fully green throughout: partials, both privileged intents granted
at runtime, no missing-permissions line.

## 2. Finding 1 — unicode emoji reaction lookup is broken for the doc's own default emoji (HIGH)

**`packages/discord/src/rest/port.ts:343-351`, `restEmoji()`.**

`unicodeEmojiKey()` (`packages/core/src/discord/emoji.ts:19-30`) deliberately
strips U+FE0F (the variation selector) when it normalises an emoji into a
storage key — correct, and the comment there explains why. `restEmoji()`
reconstructs a REST query string from that stripped key and never adds the
selector back. For an emoji whose canonical, reaction-matching form on
Discord's side *includes* U+FE0F — 🅰️ and 🅱️, the two emoji
`scripts/seed-test-panel.mjs` defaults to — the reconstructed query does not
match Discord's reaction bucket.

**Verified live**, twice, mid-session:

```
$ node --env-file=.env <diagnostic script, same restEmoji() logic>
reactors for B emoji: []
alt member roleIds: []
```

at a moment the message's own reaction summary (`GET` the message directly)
reported:

```
"emoji": { "name": "🅱️" }, "count": 2, "count_details": { "burst": 0, "normal": 2 }
```

Two real, ordinary reactions existed; every per-emoji reactor query the bot's
own code can issue returned zero people, silently — no error, no log line, an
empty list indistinguishable from "nobody reacted."

**Why 834 tests and 78 mutations missed it:** every one of them either drove a
live gateway event (which carries the emoji straight from the dispatch, a
completely different code path — `emojiKeyFromGateway`,
`packages/core/src/discord/emoji.ts:41-45`) or ran against `FakeDiscord`,
which round-trips whatever key it is given and so cannot express a
real-Discord-only mismatch. This function's own comment already flagged it:
*"cannot be verified without a connection and is on the smoke-test list."*
This session is that smoke test, and it fails.

**Consequence for everything that reads "who is currently reacting" instead
of handling one live event** — `reconcileGuild`, `runAdoptionPass`, and the
drift-repair re-check in `createMemberUpdateSubscriber`
(`packages/core/src/panels/reconcile.ts:414-417`) — all three silently
under-count reactors for 🅰️/🅱️. It looked fine all session because most of
what got exercised only needed to detect *absence*, which a call that always
returns empty happens to get right. The one test that needed *presence*
(repairing a manually-removed role) is what exposed it.

### 2a. Compounding bug: the seed script's own default emoji beyond A/B are not valid reaction emoji at all

`scripts/seed-test-panel.mjs:49`, `DEFAULT_EMOJI = ['🅰️', '🅱️', '🅲', '🅳', '🅴', '🅵']`.
Only A, B, O and P have an emoji-qualified form in Unicode (the "button"
emoji used for blood types and parking); C–Z are plain enclosed-alphanumeric
characters with no emoji presentation. Discord's reaction endpoint does not
merely fail to find them — it rejects them outright:

```
DiscordApiError: Unknown Emoji
```

confirmed live by seeding a panel with `--emoji 🅲`.

### 2b. Compounding bug: one bad emoji throws out of the whole pass, for the whole guild

`packages/core/src/panels/reconcile.ts:150-162` (`reconcileGuild`) and
`packages/core/src/panels/adoption.ts:92-101` (`selectionsByMember`) call
`cache.reactors()` in a loop with **no try/catch**. When it throws "Unknown
Emoji" for one option on one panel, the exception propagates out of the
entire pass. Both `reconcile_guild` and `adopt_panel` jobs retried five times
and died — confirmed via `jobs.last_error` (see Finding 2 for why the *log*
did not show this). Nothing else in the guild — no other panel, no ordinary
drift repair — reconciles again until an operator notices the dead job and
fixes the panel by hand. One bad option silently takes every panel in the
guild out of reconciliation.

**Fix directions, not mandated — pick one and write the test first:**
`restEmoji()` needs to restore the variation selector for codepoints whose
fully-qualified emoji form requires one (a small, bounded Unicode dataset);
`DEFAULT_EMOJI` beyond the first two entries should either be replaced with
emoji that are actually valid reaction targets or removed so `--emoji` is
required past two options; and the reactor-fetch loops in both passes need
per-option error isolation (skip and log the option, do not fail the guild).

## 3. Finding 2 — job-failure log lines never show the real error (MEDIUM, observability)

`packages/core/src/jobs/worker.ts:91-92` stringifies a caught error
(`describeError`, e.g. `"DiscordApiError: Unknown Emoji"`) **before** passing
it to `safeLogFields` under the key `error` (`worker.ts:189-202`).
`safeLogFields`'s redaction for that key (`packages/core/src/obs/logger.ts:95-98`)
is `value instanceof Error ? {name, message} : '<non-error>'` — a plain
string is never `instanceof Error`, so it is *always* replaced with the
literal string `"<non-error>"`, for every job failure, regardless of what
actually failed.

This is how Finding 1 stayed hidden for five retries: the log said
`error: "<non-error>"` on every attempt. The real message
(`"DiscordApiError: Unknown Emoji"`) was only ever visible in
`jobs.last_error`, because `JobStore.fail()` is called with the raw
`describeError()` string *before* the redacted log line is written.

**Fix direction:** a value already narrowed to `describeError()`'s output is
a plain string that cannot carry a raw `Error`'s extra properties — the thing
the redaction exists to stop. Letting a string under `error`/`err` pass
through unredacted (rather than replacing it) fixes this without loosening
the redaction for an actual `Error` object. Grep for every other
`safeLogFields({ ..., error: ... })` / `err:` call site before changing the
rule, to confirm nothing else relies on the current stomping behaviour or
passes something less safe than a `describeError()` string under those keys.

## 4. Finding 3 — the adoption allowance gate is bypassed by ordinary reconciliation (HIGH, safety-relevant)

This is the one that matters most. `docs/21` exercise 5's own definition of
failure is *"it grants everyone their role without asking. That is a mass
role change nobody approved."* That is what happened, on this session's
first real attempt at the exercise.

**Sequence, from `role_effects` and the log, timestamps included:**

1. A panel is configured on a message with one pre-existing reaction.
   `node scripts/seed-test-panel.mjs --adopt` queues the adoption job.
2. The daemon restarts (as it does after every seed, and as it would after
   any deploy or crash). Two jobs run back to back on the same gateway-gap:
   - `adopt_panel` (job 19) correctly computes the change list and refuses:
     `"adoption pass computed its change list and is waiting for an
     owner-sized allowance"`, `count: 1, limit: 0`
     (`packages/core/src/panels/adoption.ts:191-215`). Nothing applied.
     `panels.adoption_pass_state` stays `'pending'`.
   - Two seconds later, `reconcile_guild` (job 20) — the same gateway-gap
     reconnect — visits the same panel, computes the same missing grant as
     ordinary drift, checks it against `checkReconcileBudget`
     (a plain count ceiling, unrelated to the adoption allowance), and
     **applies it**: `"reconciliation complete", count: 1, applied: 1`.
     `role_effects` row 32: `state=applied, action=grant`.

**Why:** `runAdoptionPass` and `reconcileGuild` are two separate functions
with two separate gates. `packages/core/src/panels/adoption.ts:191-193`'s
own header comment states the intent plainly — *"there is deliberately no
Discord-side confirmation: a mass-role-grant trigger reachable from Discord
is exactly the surface `docs/18` wants smallest"* — but `reconcileGuild`
(`packages/core/src/panels/reconcile.ts:97`) selects every `status ===
'enabled'` adopted panel with no check on `adoptionPassState` at all. A panel
sitting at `adoptionPassState: 'pending'` — explicitly awaiting a human
decision — is invisible to the one gate meant to protect it and fully
visible to the other.

**Blast radius:** any newly-configured panel on a message with existing
reactions is one restart away from having its bulk grant applied without
anyone approving it. A restart is not a rare event — it happens on every
deploy, every crash recovery, and (once slice 11's periodic timer exists)
on a schedule, with no human action at all.

**Fix direction, not mandated:** the natural fix is for `reconcileGuild`'s
panel selection (`reconcile.ts:97`) to exclude panels whose
`adoptionPassState` is `'pending'` — a panel awaiting adoption approval is
not "drift to repair," it is a decision not yet made, and reconciliation
should leave it alone until the CLI (slice 13) grants an allowance or the
adoption pass itself completes. This is a consequential change to what
reconciliation covers and belongs behind an ADR (next free number: verify
against `docs/decisions/`, was **0021** as of this report) and a test
proving the exact sequence above no longer applies the grant. Write the
failing test first, against `FakeDiscord` — this does not need a live
connection to reproduce, since it is a pure logic gap between two functions
that both fetch the same data through the port.

## 5. Not a bug — known, documented, deferred to slice 11

**Manual role removal on a member outside the bot's small member cache does
not repair promptly**, only on the next full reconciliation (a restart, at
this slice). Traced to `packages/discord/src/events.ts:161-180`:
`GUILD_MEMBER_UPDATE`'s `previousRoleIds` is `undefined` when the "before"
member was not cache-resident, and
`createMemberUpdateSubscriber` (`packages/core/src/panels/reconcile.ts:359-360`)
correctly declines to guess rather than risk repairing a change nobody made.
The periodic `reconcileGuild` timer pass that would cover this for *any*
member regardless of cache state already exists as code
(`docs/reports/WP5-slice-6.md`'s deferred table) and is deliberately
unscheduled until slice 11. Now documented in `docs/21` §"Manual removal" so
the next person testing this does not mistake it for a new bug. **No action
needed beyond slice 11 landing.**

## 6. Recommended order

1. Fix Finding 1 (emoji round-trip + error isolation) and Finding 2 (log
   redaction) — self-contained, no live connection strictly required to fix
   or unit-test the logic, though the emoji fix should be re-verified live
   once slice 13 or a smoke-test script can seed a panel without a restart
   cycle burning Discord API calls the way this session did.
2. Fix Finding 3 — write the ADR, write the failing test against
   `FakeDiscord`, fix `reconcileGuild`'s panel selection, confirm the test
   catches a regression with a mutation.
3. Update `docs/STATE.md` and append a `docs/SESSION_LOG.md` entry (numbered
   divergence 16 for Finding 1, since it is a real-Discord-only behaviour the
   fake does not model — the other findings are pure logic bugs, not
   fake-vs-real gaps, and belong in the log's prose rather than the
   numbered list).
4. Only then start WP4 (the handoff already written in
   `docs/reports/WP5-slice-6.md` §8 is still accurate for that). WP4 builds
   directly on `reconcileGuild` and the audit log; starting it on top of an
   unfixed Finding 3 means the logging module's own drift-repair path
   inherits the same bypass.

---

## 7. Handoff prompt for a fresh session

```
Fix three defects found live-testing Bananasaurs against the real test guild
(docs/reports/WP5-slice-6-live-test.md, 2026-08-29). Do not start WP4 until
all three are fixed, tested, and committed — WP4 builds on reconcileGuild and
the second defect below is a safety-relevant bypass in exactly that code.

START HERE — BRANCH

Call EnterWorktree with the name `wp5-live-test-fixes`. Do NOT work on
`worktree-wp3-role-panels` (stale, already merged) or
`worktree-clarify-doc21` / `worktree-wp5-live-test-report` (doc-only branches
from the same session as this report, unrelated to these fixes). Commit on
`wp5-live-test-fixes` only. Never push.

STATE OF THE REPO

`main` carries WP5 slice 6 (the real Discord adapter, doctor, the seed
script) plus doc-only fixes to docs/21. 834 tests pass;
`npm run typecheck && npm run lint && npm run test` is green. Confirm the
834 before touching anything — if it differs, stop and find out why.

  npm install && npm run build && npm run db:migrate

READ FIRST, IN THIS ORDER

1. docs/reports/WP5-slice-6-live-test.md — this report, in full. It has
   exact file:line locations, live evidence, and fix directions (not
   mandates) for all three defects.
2. docs/reports/WP5-slice-6.md §5 ("What I am least confident about") and
   §6 (deferred items) — the emoji defect below is the thing that section
   named as "the single thing most likely to go wrong on the first live
   run," and it was right.
3. docs/decisions/0018-rest-port-refuses-rather-than-waits.md and
   ADR 0020 — the composition-root and REST-port design constraints the
   fixes below must not violate (the port stays narrow; no retries hidden
   in the adapter).
4. packages/core/src/panels/adoption.ts, full file, and
   packages/core/src/panels/reconcile.ts's `reconcileGuild` function — read
   both before touching either. The third defect is that they disagree
   about what "safe to apply" means for the same data.

THE THREE DEFECTS, IN FIX ORDER

1. **Emoji reaction round-trip is broken for the doc's own default emoji.**
   `packages/discord/src/rest/port.ts:343-351` (`restEmoji`) never restores
   U+FE0F for emoji whose canonical form needs it (🅰️/🅱️), so every
   per-emoji reactor query for them silently returns zero people — confirmed
   live, the message's own reaction summary showed real reactions the query
   could not see. Separately, `scripts/seed-test-panel.mjs:49`'s
   `DEFAULT_EMOJI` beyond A/B (🅲🅳🅴🅵) are not valid Discord reaction emoji
   at all and produce a hard `DiscordApiError: Unknown Emoji` — and because
   `reconcile.ts:150-162` / `adoption.ts:92-101` fetch reactors in a loop
   with no try/catch, that one bad emoji throws out of the *entire*
   reconciliation or adoption pass for the *whole guild*, five retries and
   dead. Fix the round-trip, fix or remove the bad defaults, and add
   per-option error isolation so one broken panel cannot take every panel
   in a guild out of reconciliation. This one specifically needs live
   verification eventually (the report's diagnostic script pattern is
   reusable) but the round-trip logic and the error isolation can and
   should be unit- and mutation-tested against `FakeDiscord` first.

2. **Job-failure logs always say `"<non-error>"`.**
   `packages/core/src/jobs/worker.ts:91-92` stringifies the error before
   `packages/core/src/obs/logger.ts:95-98`'s redaction ever sees it, and
   that redaction only preserves an `instanceof Error`, so a string is
   always stomped. This is why defect 1 took a live diagnostic script to
   find instead of a log line. Before changing the redaction rule, grep
   every `safeLogFields({ ..., error: ... })` / `err:` call site in the
   repo and confirm none of them currently rely on a string being hidden,
   or pass something under those keys that is less safe than a
   `describeError()` output.

3. **Adoption's allowance gate does not apply once reconciliation runs.**
   `runAdoptionPass` (adoption.ts) refuses correctly with no standing
   allowance. `reconcileGuild` (reconcile.ts:97) selects every enabled
   adopted panel with no check on `adoptionPassState`, computes the exact
   same missing grant as ordinary drift, and applies it under
   `checkReconcileBudget` — a different, much more permissive gate.
   Reproduced live: the mass grant this exercise exists to prevent happened
   two seconds after the correct refusal, via the daemon's own restart.
   This is the safety-relevant one — `docs/18`'s whole point is that no
   surface reachable without a human decision performs a bulk role change.
   Write an ADR before implementing (check `docs/decisions/` for the
   current next-free number; this report assumed 0021 but verify). Write
   the failing test first, against `FakeDiscord` — no live connection
   needed, this is a pure gap between two in-process functions reading the
   same store. The natural fix is excluding `adoptionPassState: 'pending'`
   panels from `reconcileGuild`'s selection, but decide that in the ADR,
   not by assumption.

PROTOCOL

  - Write the test first for anything touching permissions, hierarchy,
    idempotency, retention, or guild scope — all three defects qualify.
  - Run `npm run typecheck && npm run lint && npm run test` and PASTE THE
    REAL OUTPUT. Do not report completion on code you have not run.
  - After each defect is fixed, BREAK the fix deliberately to prove the new
    test catches it. Continue the mutation numbering from 78 (the last
    number in docs/reports/WP5-slice-6.md). Restore with a FILE COPY, never
    `git checkout <file>`.
  - Append to docs/SESSION_LOG.md. Defect 1 is a real-Discord-only
    behaviour `FakeDiscord` does not model — number it as divergence 16 in
    the numbered list. Defects 2 and 3 are pure logic bugs, not
    fake-vs-real gaps; describe them in prose rather than the numbered
    list, the way earlier entries do for non-divergence findings.
  - Update docs/STATE.md "Where the build is" when done: these three fixes,
    then WP4 (already handed off in docs/reports/WP5-slice-6.md §8) is next.
  - Commit after each defect, on `wp5-live-test-fixes`. NEVER `git push`.

SETTLED — DO NOT RE-LITIGATE

  - The port stays narrow. Fixing defect 1 must not turn `restEmoji` into a
    general emoji-metadata lookup; a small, bounded table or a minimal
    Unicode data reference for "does this codepoint's emoji form need
    U+FE0F" is in scope, a new dependency pulling in full emoji metadata is
    not proportionate. Justify whatever you pick in one line in the PR.
  - Reconciliation still covers adopted panels only (STATE.md, 2026-08-23).
    Defect 3's fix changes *which* adopted panels it covers, not that
    scope.
  - One process. No new services. No AI anywhere in this work.

SECURITY

You cannot connect to Discord and must not attempt to; where defect 1's fix
would ideally be re-verified live, say so in the report instead of
attempting a connection. Never read, print, or copy `.env`. Never spawn the
`claude` binary from application code.

FINISH BY

All three defects fixed, tested, mutation-checked, and committed; SESSION_LOG
and STATE.md updated; then either stop and report, or — only if time and
context remain — begin WP4 per the existing handoff in
docs/reports/WP5-slice-6.md §8.
```
