# Current state

**Living document.** Update it at the end of each working session so a fresh conversation can pick up without re-reading everything. Last updated 2026-08-22.

---

## Where the build is

**Release 0, WP1 complete** (2026-08-23). Plan accepted and recorded in `docs/19_RELEASE_0_1_PLAN.md`. Work packages defined in `docs/20_AUTONOMOUS_EXECUTION.md`.

WP1 shipped: npm workspace, Zod config, Pino allowlist logging, CI, systemd unit, SQLite in WAL with two single-writer guards, drizzle-kit migrations, and the fake Discord harness. `typecheck`, `lint`, and 81 tests are green. Six commits, **none pushed**.

Next action: Bryan reviews the WP1 diff, pushes, then starts a fresh session with the WP2 handoff prompt. WP2 is the full Release 1 schema, the event pipeline, and the safety core.

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
4. **Anti-nuke posture** — other members hold Discord Administrator. Decide whether Bananasaurs detects and alerts on privileged-account abuse or stays out of it. Detection is tractable; prevention is not and should not be promised.
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
