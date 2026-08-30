# Autonomous execution protocol

How Claude Code runs Release 0 and 1 without needing approval on every file, and where it must stop regardless.

The goal is fewer, better review points — not zero. Bryan reviews at work-package boundaries, roughly six times across Releases 0 and 1, instead of twenty times at slice level.

---

## Why not full autonomy to the end

Worth stating plainly, because the instinct to just let it run is reasonable and the failure mode is not obvious.

**Foundations compound.** If the schema in package 2 is subtly wrong — a missing unique constraint, guild scope that's conventional rather than structural — packages 3 through 6 build on it. Finding that at the end means unwinding everything built on top. Finding it at the package-2 boundary costs an hour.

**A green test suite is not evidence.** Agent-written tests drift toward asserting that a mock was called rather than that behaviour is correct. Those pass forever regardless of whether the feature works. The mutation check below is the countermeasure, but it needs a human to notice when it stops being run honestly.

**Understanding is the deliverable too.** A working codebase you did not watch being built and cannot reason about is worse than a smaller one you understand, because every future change is guesswork and every bug is archaeology.

Six stop points is the compromise: enough autonomy that momentum is real, enough checkpoints that a wrong foundation cannot travel more than one package.

---

## Work packages

Each is a hard stop. Do not begin the next one in the same session.

| # | Package | Done when |
|---|---|---|
| **WP1** | **Skeleton + fake Discord harness.** Repo layout, npm workspace, TypeScript strict, Drizzle + migrations, Zod config, Pino with redaction, Vitest, CI, systemd unit. The in-memory Discord simulator: gateway events, button interactions, REST calls, and on-demand duplicate events, reconnect gaps, 429s, permission errors, hierarchy failures, uncached-message reactions. | `npm run typecheck && npm run lint && npm run test` green in CI, and the harness can drive a test that fails when the implementation is broken. |
| **WP2** | **Storage, event pipeline, safety core.** Full Release 1 schema with guild-scope and idempotency constraints as real SQL. Single-writer discipline. Job table with `dedupe_key`. Audit events with before/after and batch IDs. Rate limiter, circuit breaker, reconciliation budget, dry-run switch, kill switch — all sitting in the path every side effect must traverse. | Safety controls provably cannot be bypassed by a new caller. Tests demonstrate the breaker tripping and the budget refusing. |
| **WP3** | **Role panels.** Adopted (reaction, by message ID) and managed (buttons/selects, bot-posted). Toggle, add-only, remove-only, single-choice. Per-panel limits, required/blocked roles. Adoption pass. Hierarchy check immediately before every mutation. Reconciliation for drift and downtime. Partials configured. | A panel works end to end against the harness, including every failure case in `docs/REVIEWING_AGENT_OUTPUT.md`. |
| **WP4** | **Logging module.** Message edits and deletions, joins and leaves, role and channel changes, routed per event to configured channels. Deletion actor inferred from audit log and labelled inferred everywhere it surfaces. | Events route correctly; a missing actor degrades to "unknown," never to a guess presented as fact. |
| **WP5** | **Operator CLI + dashboard + `/privacy`.** CLI over the Unix socket per ADR 0013. One dashboard page with owner-provisioned local accounts per ADR 0012, including first-account bootstrap. `/privacy` rendering `PRIVACY.md` with live settings. | `bananasaurs status`, `doctor`, `audit tail`, `undo`, `killswitch` all work. A second account cannot reach the dashboard. |
| **WP6** | **Backup, restore, release hardening.** Backup job, documented restore, `doctor` covering every startup precondition, and the Release 1 gate in `docs/08_ROADMAP.md`. | A restore has actually been performed, not just written down. |

---

## Inside a package: full autonomy

Plan the package, implement it slice by slice, self-review, fix what you find, and keep going. Commit after each slice with a clear message. **Do not ask for approval between slices.** Do not narrate progress at length — the commits are the record.

Per slice, before moving on:

1. Run `npm run typecheck && npm run lint && npm run test`. All green, or fix and re-run.
2. **Mutation check.** Break the implementation the new tests cover — invert a condition, drop a guard, return early. Confirm the tests fail. Restore. Record what you broke and what failed. A test that passes against a broken implementation is decoration; delete or rewrite it.
3. Answer the four questions honestly:
   - Does every new query take a guild ID, structurally rather than by convention?
   - Does every new Discord side effect have a durable idempotency key and a unique constraint making double execution impossible?
   - Does any untrusted input reach an execution path without a Zod validator?
   - Would each new test fail if the implementation were broken?
4. Any "no" gets fixed before the next slice, not logged as debt.

Append a short entry to `docs/SESSION_LOG.md`: package, slice, what changed, what you broke to verify the tests, anything you deferred and why.

---

## Stop immediately, mid-package, for any of these

Autonomy ends where a decision belongs to the owner. These are not failures — surfacing them early is the point.

- **Ambiguity that affects privacy, authorisation, retention, cost, or an external side effect.** `AGENTS.md` already says this; it holds during autonomous work too.
- **A planning document contradicts another** in a way that changes what you build.
- **You want to add a dependency** beyond what ADR 0008 names.
- **You want to change or supersede an ADR.**
- **You need `sudo`.** You should never need it for Releases 0 and 1.
- **A slice needs more than roughly 400 lines of new implementation.** That means the slice was mis-sized; stop and re-plan rather than writing a large unreviewable change.
- **You have fixed the same failing test three times.** Something is wrong upstream of the test.

Say what you hit, what the options are, and what you'd choose. Then wait.

---

## Absolute limits, autonomous or not

- **Never `git push`.** Commit freely; pushing is Bryan's.
- **Never read, print, or copy `.env`.**
- **Never spawn the `claude` binary from application code**, or read Claude subscription credentials — not from a handler, a job, or a queue (ADR 0013).
- **Never work ahead of the current release.** No provider router, no module runtime, no second dashboard page. Planning is not "ahead": ADRs, design docs, and research spikes for a later release are fine at any time. The limit is on implementation and wiring into the running daemon, not on thinking about it on paper. *(Clarified 2026-08-29, for the Release 2 observe-only window — see `docs/08_ROADMAP.md` Release 2's gate.)*
- **Never grant the bot Discord permissions beyond the Release 1 set** in `docs/18`.
- **Never disable, weaken, or route around a safety control** to make a test pass. If a control blocks something legitimate, that is a design problem to raise, not an obstacle to remove.

---

## At every package boundary

Stop and produce exactly this, in this order.

**1. What was built.** One paragraph per slice, plain language. What it does, not how clever it is.

**2. Verification evidence.** The actual output of typecheck, lint, and tests. The mutation checks: what you broke, what failed, that it was restored. Test count and coverage if available.

**3. The four questions**, answered for the package as a whole, with the specific file and line where each is enforced. "Guild scope is enforced in `src/db/repo.ts:44` where every repository function takes `guildId` as its first parameter and the type system rejects calls without it" — not "guild scope is enforced throughout."

**4. Decisions you made that I did not specify.** Every fork where two reasonable designs existed, which you chose, and why. This is the part Bryan most needs, because these are the choices that are invisible in a diff and expensive to reverse later.

**5. What you are least confident about.** Name it. "The reconciliation budget interacts with the circuit breaker in a way I have not tested under concurrent load" is worth more than a clean summary.

**6. Deferred items**, with the reason and the package where they belong.

**7. A handoff prompt for a fresh session**, in a fenced code block, ready to paste with nothing to edit. It must be self-contained: which package is next, what state the repo is in, which commit, what to read first, and anything a fresh session would otherwise have to rediscover. Assume the next session knows nothing except what is in the repo and in that prompt.

Then stop. Do not begin the next package.

---

## Bryan's side of the loop

**Revised 2026-08-29, after WP4: manual diff review is no longer the checkpoint, because it was never the thing catching bugs.** WP3's job-dedupe and reaction-provenance bugs (ADR 0016, ADR 0017) were found by mutation testing. WP5 slice 6's four real findings were found by running the real adapter against the real test guild. Neither was found by reading a diff, so reading the diff is no longer what happens at the boundary.

At each boundary:

1. **Read the seven-part report.** Cheap, and it is where "decisions you made that I did not specify" and "what you are least confident about" surface — a code-review agent reviews the code, not whether the right thing was built.
2. **Run an agent review in place of a manual diff read** — `/code-review`, `ultra` for anything safety-critical (authorization, idempotency, moderation actions, anything touching the effect gateway).
3. **Live-test against the real test guild periodically, not only once per adapter slice.** This is the one thing nothing else in this loop substitutes for — it is what actually found bugs 834 tests and 78 mutations could not.

Then `git push` and start a fresh session with the handoff prompt.

This does not relax the package-boundary stops themselves — six stop points, one package at a time, per "Why not full autonomy to the end" above, is still the pacing. What changed is what happens at the stop, not whether it happens. Applies from this point forward, across every remaining release, not only for the rest of Release 1.

`/clear` between packages is not optional. A session carrying six packages of context contradicts its own earlier decisions and burns tokens re-reading files it already read.
