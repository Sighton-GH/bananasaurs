# Current state

**Living document.** Update it at the end of each working session so a fresh conversation can pick up without re-reading everything. Last updated 2026-08-29.

---

## Where the build is

**Release 0/1, WP3 complete** (2026-08-23). Plan in `docs/19_RELEASE_0_1_PLAN.md`; work packages in `docs/20_AUTONOMOUS_EXECUTION.md`.

WP1 shipped the skeleton, database plumbing and the fake Discord harness. WP2 shipped the full Release 1 schema (20 tables, all STRICT), the guild-scoped repository layer, the event pipeline, the durable job table and worker, and the safety core — `authorize()`, the twelve-layer effect gateway, rate limiting, audit, batches, undo and the reconciliation budget. WP3 shipped role panels: adopted (reaction) and managed (button and select) panels, all four behaviours with limits and required/blocked roles, the adoption pass, and reconciliation for drift and downtime. `typecheck`, `lint` and **696 tests** are green. Eight WP3 commits, **none pushed**.

WP3 found two defects that were not in the plan. A job dedupe key was single-use for the life of the database, so **the second gateway gap ever would have enqueued no reconciliation** — silently, forever ([ADR 0016](decisions/0016-job-dedupe-collapses-pending-work.md)). And a reaction withdrawn during an outage was unrepairable, because the member is in no reaction set and there is no other record; the panel's provenance table now supplies reconciliation's *candidate list* while both sides of the diff stay live ([ADR 0017](decisions/0017-provenance-names-candidates-never-decides.md)). Amendment 5's self-mutation filter also needed a direction: our own grant made a *removal* of the same role look like ours too.

The harness was wrong about Discord twice, both found by mutation testing rather than by reading. That is the thing to watch: every WP3 conclusion is conditional on the fake being right. **The highest-value next step is running the WP5 smoke tests against the real test guild early**, rather than after WP4 — see `docs/reports/WP3.md` §6.

Settled at this boundary: **reconciliation covers adopted panels only**, and the `docs/19` §6.3 table cell is amended to match (Bryan, 2026-08-23). A managed panel has no independent record of member intent, so re-adding a hand-removed role would be the bot overruling a human on the strength of nothing.

Next action, superseded below: Bryan reads `docs/reports/WP3.md`, spot-checks the diff, pushes, then starts a fresh session with **`docs/reports/WP5-slice-6-handoff.md`** — the ordering changed at this boundary. Slice 6 (the real discord.js adapter) runs **before** WP4, because the fake harness was found wrong about Discord twice in one package and every WP1–WP3 conclusion is conditional on it being right. `docs/21_TESTING_THE_BOT.md` is what Bryan does with the result: the test-guild exercises from `docs/18` step 1, written before the code so the slice has something to be checked against. WP4 (the logging module) follows, using the prompt in `docs/reports/WP3.md` §8. WP4 is the **logging module**, and two of its requirements are already known to be hard: `MESSAGE_DELETE` carries no actor (attribution is inferred and must be labelled so everywhere), and the "miss no log events" gate is unachievable as written — the accepted restatement is an explicit gap marker in the log channel.

**2026-08-29 — slice 6 live-tested against the real test guild, and it found four things the fake and 834 tests could not.** `docs/21` "Today's run," steps 0–9, run in full for the first time — Exercises 1–4 passed clean, including the outage and the rate cap. Exercise 5 (adoption) did not: it reproduced the exact failure `docs/21` defines for that exercise — a mass role grant nobody approved — because `reconcileGuild` applies the same change `runAdoptionPass` had just correctly refused, two seconds later, on the same restart. Full findings, evidence and a fix-ordered handoff prompt: **`docs/reports/WP5-slice-6-live-test.md`**.

Four findings, in fix order: (1) `restEmoji()` never restores the variation selector U+FE0F, so reactor lookups for 🅰️/🅱️ — the seed script's own defaults — silently return nobody, and the seed script's C-through-F defaults aren't valid reaction emoji at all and hard-error, which an unguarded loop turns into a dead job for the whole guild's reconciliation; (2) job-failure logs always read `error: "<non-error>"` regardless of what failed, because the redaction rule only preserves an `instanceof Error` and the error was already stringified before it got there; (3) the adoption allowance gate above; (4) not a bug — manual role removal on an uncached member doesn't repair promptly, which is slice 11's periodic timer pass, already known and now documented in `docs/21`.

**Next action:** fix findings 1–3 (a new session, prompt in `docs/reports/WP5-slice-6-live-test.md` §7) before starting WP4 — WP4 builds on `reconcileGuild` and inherits finding 3's bypass otherwise. Only after that does WP4 (the logging module) begin, using the still-accurate handoff in `docs/reports/WP5-slice-6.md` §8.

## Environment as it actually is

| | |
|---|---|
| Host | Dell OptiPlex 5040, i7-6700, 19 GiB RAM, Linux Mint 22.3, dedicated to server work |
| Repo | `/home/bryan/projects/bananasaurs`, ext4, private GitHub remote, branch `main` |
| Editor | VS Code Remote over SSH; Claude Code (Opus) runs on the box |
| Discord | Bot created, both privileged intents enabled, invited to a **test guild** with permission integer 2416004288 |
| Secrets | `.env` at mode 600, gitignored, never committed. `.claude/settings.json` denies reading it |
| Mode | `BANANASAURS_DRY_RUN=1`; guild allowlist contains the test guild only |

**Do not put anything belonging to this project on `/media/bryan/OptiData1`.** It is NTFS via ntfs-3g: SQLite WAL cannot work there, `chmod` is a no-op, and Unix sockets are unsupported. This was found and fixed on 2026-08-22; `docs/15` has the detail.

## Setup history worth remembering

- The first `git init` accidentally committed `.env` because `.gitignore` didn't exist yet. Caught before any push; history was wiped and the repo re-initialised. No token ever reached GitHub.
- The repo initially lived on the NTFS drive. Moved to ext4 after `df -T` revealed `fuseblk`.
- `LICENSE` (Apache-2.0) was added by Claude Code during Phase 1 and committed.

## Still open

1. ~~**Backup destination**~~ — decided 2026-08-23: local path only in Release 1; encrypted off-host documented but not implemented.
2. **Monthly AI spend ceiling** — a number, becomes a config value that fails closed. Not needed until Release 3.
3. **`docs/RELEASE1_CONFIG.md`** — which panels, which roles, which log events, which destinations. Blank slate; nothing imported from Carl-bot. Does not block coding but must exist before cutover.
4. **Anti-nuke posture** — other members hold Discord Administrator. Partly answered by WP2: ADR 0012 is enforced (Administrator grants nothing; capability comes only from `capability_grants`), and a `protected` principal holds no capability. Whether Bananasaurs *alerts* on privileged-account abuse is still open. Detection is tractable; prevention is not and should not be promised.
5. **Release 2 scope check** — the club's automod is Carl-bot defaults. Configure Discord's native AutoMod first and see what's left; the custom rule engine may not need to exist.

## Decisions made in conversation, now recorded in the repo

Everything consequential from the planning conversation is written down. If a future conversation needs the reasoning, it is in these files rather than in chat history:

- `REVIEW.md` — the full plan review: blocking issues, scope cuts, sixteen Discord API realities, and an addendum recording Bryan's answers and what each one changed.
- `docs/08_ROADMAP.md` — three releases, replacing the original ten milestones.
- `docs/18_SAFETY_AND_BLAST_RADIUS.md` — the seven layers bounding what a bug can do, and the rollout sequence.
- `docs/17_OPERATOR_ACCESS.md` — SSH, the operator CLI, and the line Claude Code must not cross.
- ADRs 0008–0013 — stack, archive scope, provider gate, license, dashboard auth, operator access.
- `PRIVACY.md` — member-facing policy, needs placeholder fields filled before posting.

## How to update this file

At the end of a session, revise "Where the build is," add anything new to "Still open," and delete anything resolved. Keep it short. A state file nobody reads because it grew to ten pages is worse than none.
