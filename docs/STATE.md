# Current state

**Living document.** Update it at the end of each working session so a fresh conversation can pick up without re-reading everything. Last updated 2026-08-30.

---

## Where the build is

**Release 1 is feature-complete.** All six work packages (`docs/20_AUTONOMOUS_EXECUTION.md`) and all sixteen slices are built, merged to `main`, and green: WP1 (skeleton, fake Discord harness), WP2 (schema, event pipeline, safety core), WP3 (role panels, adoption, reconciliation), WP4 (logging module), WP5 (Discord adapter, role panels live-tested, operator CLI, dashboard, slash commands), WP6 (backup, restore, doctor hardening). 1,638 tests, `typecheck` and `lint` clean. Detailed per-slice history lives in `docs/SESSION_LOG.md` (append-only) and `docs/reports/`; this file only tracks where things stand now.

**What is not yet done is testing, not building.** Two things stand between here and calling Release 1 done, both tracked in **`docs/SMOKE_TESTS.md`**:

- The operator CLI, dashboard, and `/status` slash command (WP5 slices 13–15) have never been exercised against the real test guild — only against the fake harness. Slice 6 (the core Discord adapter) already found two real bugs the fake got wrong that 834 tests didn't catch (2026-08-29, `docs/reports/WP5-slice-6-live-test.md`), so this is not a formality.
- The backup/restore drill (WP6) was rehearsed against a synthetic database in this sandbox — `./data` and `./backups` are read-denied here deliberately (`.claude/settings.json`), since they can hold real Discord content — and still needs one run against the actual running daemon and its real database. `docs/20`'s WP6 gate is explicit: "a restore has actually been performed, not just written down."

**Next action:** run `docs/SMOKE_TESTS.md` end to end against the real test guild and real data. Record findings in `docs/SESSION_LOG.md` the way every prior live test has. When every box is checked, Release 1 is done and Release 2 (automod — `REVIEW.md` §E, `docs/08_ROADMAP.md`) can start.

`/privacy` was dropped from Release 1 scope (2026-08-30, WP5 slice 15): Discord requires a posted privacy policy only above 100 servers, and Bananasaurs runs on one. `docs/08_ROADMAP.md` and `docs/12_OPEN_QUESTIONS.md` are corrected to match.

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

1. ~~**Backup destination**~~ — decided 2026-08-23, implemented 2026-08-30 (ADR 0034, WP6). Local path only in Release 1; encrypted off-host documented but not implemented.
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
