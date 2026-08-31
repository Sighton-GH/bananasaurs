# Current state

**Living document.** Update it at the end of each working session so a fresh conversation can pick up without re-reading everything. Last updated 2026-08-30.

---

## Where the build is

**Release 1 is done — 2026-08-30.** All six work packages (`docs/20_AUTONOMOUS_EXECUTION.md`) and all sixteen slices are built, merged to `main`, and green: WP1 (skeleton, fake Discord harness), WP2 (schema, event pipeline, safety core), WP3 (role panels, adoption, reconciliation), WP4 (logging module), WP5 (Discord adapter, role panels live-tested, operator CLI, dashboard, slash commands), WP6 (backup, restore, doctor hardening). 1,638 tests, `typecheck` and `lint` clean. Every box in `docs/SMOKE_TESTS.md` is checked, including sections B and C which needed a live test guild and real data — see `docs/reports/release1-smoke-tests-live-run.md` for the full account (two real dashboard bugs found and fixed live, and a confirmed anti-nuke safety property). Detailed per-slice history lives in `docs/SESSION_LOG.md` (append-only) and `docs/reports/`; this file only tracks where things stand now.

**This host has no production systemd deployment yet.** The daemon has only ever run via `npm run start` or, as of the 2026-08-30 smoke test, `deploy/bananasaurs-test.service` — a unit that runs as the checkout's own owner directly against this repo, deliberately not the hardened `/opt` layout `deploy/bananasaurs.service` describes. Standing up the real production deployment (service account, `bananasaurs-ops` group, `/opt/bananasaurs`, `/etc/bananasaurs/env`) is a real-guild-cutover task per `docs/17_OPERATOR_ACCESS.md` §2, not something Release 1's testing needed.

**Next action: Release 2 — replace automod, add moderation** (`docs/08_ROADMAP.md`, `REVIEW.md` §E). Per the roadmap's own instruction, the first move is a scope check, not code: configure Discord's native AutoMod (Server Settings → AutoMod) against the club's actual current rules before writing any of the custom rule engine. If native AutoMod covers what Carl-bot's defaults were doing, Release 2 shrinks to moderation commands and cases; build the custom engine only for rules that survive that filter.

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
4. **Anti-nuke posture** — other members hold Discord Administrator. Partly answered by WP2: ADR 0012 is enforced (Administrator grants nothing; capability comes only from `capability_grants`), and a `protected` principal holds no capability. Prevention for the literal guild owner is confirmed live and unconditional (`packages/core/src/effects/gateway.ts:266`, `docs/reports/release1-smoke-tests-live-run.md` §1e) — the bot cannot mutate the owner's roles regardless of `principals` table state. Whether Bananasaurs *alerts* on privileged-account abuse from *other* Administrator-holding members is still open. Detection there is tractable; prevention is not and should not be promised.
5. **Release 2 scope check** — the club's automod is Carl-bot defaults. Configure Discord's native AutoMod first and see what's left; the custom rule engine may not need to exist. **This is the next action.**
6. **Audit trail doesn't record refusals** — a killswitch/protected-target/etc. refusal is logged (journal) but never written to `role_effects` or `audit_events` (`packages/core/src/effects/gateway.ts:199-215`, found 2026-08-30). Plausibly deliberate, to avoid audit-table noise from routine refusals — but worth a deliberate decision before Release 2 adds moderation actions with their own refusal paths.

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
