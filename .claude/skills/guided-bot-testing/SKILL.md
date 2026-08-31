---
name: guided-bot-testing
description: Run a live testing session of Bananasaurs against the real Discord test guild, together with the user - Claude drives the terminal (build, migrate, doctor, start/stop the daemon, seed fixtures, query the database) while the user performs the Discord-side actions (reacting, deleting things, dragging roles) that only a human in Discord can do. Use this whenever the user wants to test the bot, run through docs/21 (or whatever the current testing runbook is), verify a live behavior against real Discord, or work through a testing checklist together. This is specific to the Bananasaurs project and assumes its stack, safety rules, and docs/ conventions.
---

# Guided live testing of Bananasaurs

This project's tests against `FakeDiscord` are thorough, but a live testing
session in the actual test guild has found real bugs that hundreds of tests
and dozens of mutations missed — because some things (an emoji's exact
identity on Discord's wire format, a REST endpoint's real error, the ordering
of two jobs that both wake up on the same reconnect) simply cannot be observed
any other way. That is the whole point of this exercise, and it only works if
the division of labor is right: **you drive everything that's a terminal
command or a database query; the user does everything that's a click in
Discord.** Neither of you should be doing the other's job.

The current runbook is `docs/21_TESTING_THE_BOT.md` (check `docs/STATE.md`
first in case that's been superseded or renumbered). Read it before starting a
session — it has the exact checklist, what failure looks like for each step,
and known gaps already found by previous sessions. Don't re-discover something
it already documents as expected.

## The safety rules that don't bend

These come straight from `CLAUDE.md` and are non-negotiable regardless of how
the session is going:

- **Never read, cat, or print `.env`.** When a config value needs to change —
  `BANANASAURS_DRY_RUN`, the rate limit, anything — tell the user exactly what
  to set it to and let them edit it. This holds even when you're confident
  editing it yourself would be harmless; the boundary is the point.
- **The guild allowlist is the one backstop.** Before anything else, confirm
  it contains the test guild only. If you ever have reason to believe the
  club server's ID could be in scope, stop and say so before proceeding.
- **File edits need a worktree.** If a step in this skill leads to editing
  project files (fixing something you found, updating a doc), call
  `EnterWorktree` first — testing itself (running commands, querying the
  database) does not need one.
- **Never push, merge, or touch `main` without asking**, even at the end of a
  session that went well.

## Setting up

Check state before assuming anything — a previous session may have left the
daemon running, dry run off, or a panel already seeded:

```bash
git status                                            # clean working tree?
test -f .env && echo present                          # exists, don't read it
pgrep -fa "apps/daemon/dist/index.js"                  # already running?
```

If the daemon is already up, read its recent behavior from the database
before restarting it for no reason — a restart is not free, it burns a
gateway reconnect and re-triggers reconciliation.

## Running the daemon: the part that bit a previous session

**Do not background the daemon with a shell trick like `(npm run start | tee
log &)`.** It looks like it works — the process starts, doctor reports green
— but the `tee` pipeline can silently stop flushing to the log file after a
few minutes while the daemon keeps running and working correctly underneath.
A previous session lost real evidence this way and only caught it because the
database kept telling a story the log had stopped telling. Use the Bash
tool's own `run_in_background: true` on `npm run start 2>&1 | tee -a
/tmp/bananasaurs.log` instead — it's tracked properly and its output stays
readable.

**To stop the daemon, signal the actual `node` process, not the `sh -c`
wrapper `npm run start` spawns.** `pgrep -f "apps/daemon/dist/index.js"`
often returns both; sending `SIGINT` to the wrapper does not reliably
propagate. Find the real one:

```bash
pgrep -f "node --env-file=.env apps/daemon/dist/index.js"   # or ps -o pid,ppid,cmd -p <pids>
kill -INT <the node pid, not the sh -c pid>
sleep 2 && ps -p <pid>                                       # confirm it actually stopped
```

Confirm both the stop and the restart from the log (`shutting down`, then
`bananasaurs starting` / `doctor: ok`) before telling the user to do anything
that depends on the daemon being in a particular state.

## Verifying: the database is ground truth, the log is a convenience

Trust `role_effects`, `panels`, `guilds`, `jobs`, and `gateway_gaps` over log
lines whenever the two could conflict — the log staleness issue above means
they sometimes will, silently. Query readonly, since the daemon holds the
single SQLite writer:

```bash
node -e "
const db = require('better-sqlite3')('data/bananasaurs.db', { readonly: true });
console.table(db.prepare('SELECT rowid, state, action, role_id, had_role_before, attempted_at FROM role_effects ORDER BY rowid DESC LIMIT 5').all());
"
```

**Order by `rowid` or a timestamp column, never by `effect_id` or another id
that happens to be a UUID.** A UUID's lexicographic order has no relationship
to when the row was written — this produced a genuinely confusing false lead
in an earlier session before the mistake was caught. `attempted_at` /
`created_at` (Unix ms) or plain `rowid` are the columns that are actually
chronological.

When the database and your expectation disagree, that disagreement is real
information — don't paper over it by re-running the same step and hoping.

## Working with the user: one concrete thing at a time

For every step that needs a human hand in Discord, state exactly what to do —
which account, which exact action, on which message or role — as its own
short instruction, then stop and wait for confirmation before moving on.
Resist the urge to batch three Discord actions into one message: the more
steps you ask for blind, the more likely something drifts from what you
assumed (a role got created in the wrong position, a reaction landed on the
wrong emoji), and untangling that after the fact costs more than asking
would have. If a step's outcome is ambiguous or surprising, ask the user to
confirm the actual current state in Discord directly rather than assuming
your model of it is still right — this has caught real problems before
(a reaction that looked normal in Discord's UI turned out to be invisible to
the bot's own API calls).

## When something doesn't match the doc

This is where the real value of a live session is, and it deserves patience,
not a quick verdict either way.

1. **Don't assume it's a bug, and don't assume the user did something wrong.**
   Both happen. Check which.
2. **Read the actual code path** the failing behavior runs through before
   guessing. This project's source is organized so the decision logic lives
   in `packages/core`, with thin adapters around it — that's usually the
   right place to start reading.
3. **Check `docs/reports/` and `docs/SESSION_LOG.md` for whether this is
   already a known, documented gap** before reporting it as new. Several
   things look like bugs and are actually deferred, named capabilities
   (search for the behavior's name — "periodic," "burst reaction," etc.).
4. **Form a specific hypothesis and check it with the smallest safe probe
   available** — a database query first, a live read-only Discord API call
   if genuinely needed (a short one-off script using the bot's own REST
   client pattern, run via `node --env-file=.env`, never printing the
   token). Don't write to Discord or the database to test a hypothesis; only
   read.
5. **Say plainly when a step you already called "passed" turns out not to
   have been**, once contradicting evidence shows up — don't let an earlier
   verdict quietly stand. This happened in a previous session (an adoption
   refusal that looked like a pass was actually a safety bypass caught two
   log lines later) and correcting it in the moment was the right call.

## Finishing a session

Before wrapping up:

- Confirm `BANANASAURS_DRY_RUN` is back to `1` (ask the user to set it; don't
  touch `.env`), restart, and confirm the log says dry run is on.
- Stop the daemon cleanly and confirm it actually stopped.
- If real findings came out of the session (not just checklist pass/fail),
  this project's convention is to write them up properly rather than leave
  them in chat: a report under `docs/reports/` (see
  `docs/reports/WP5-slice-6-live-test.md` for the shape — evidence, file:line
  citations, a fix-ordered handoff prompt as the final section), plus a short
  update to `docs/STATE.md`'s "Where the build is" and an entry in
  `docs/SESSION_LOG.md`. Do this in a worktree, and offer the user the merge
  commands rather than merging into `main` yourself.
- If the user wants a prompt to hand to a fresh session for fixing what was
  found, model it on the handoff-prompt convention already in this repo
  (`docs/reports/WP5-slice-6.md` §8 and `docs/reports/WP5-slice-6-live-test.md`
  §7 are both good examples of the shape: branch instructions, state of the
  repo, what to read first, the defects in fix order with file:line evidence,
  protocol, and a finish condition).
