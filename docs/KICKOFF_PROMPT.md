# Release 0 + 1 kickoff prompt

Paste this into Claude Code, running in the repository root on the Mint box, with Opus selected. Use plan mode (Shift+Tab twice) if you want an extra layer of "don't touch anything yet."

Everything between the horizontal rules is the prompt.

---

You are starting implementation of Bananasaurs. Work in three phases and **stop at the end of each one for my approval.** Do not write application code in phase 1 or 2.

## Phase 1 — Verify my setup before anything else

I may have got something wrong. Check the following and report a pass/fail table. If anything fails, stop and tell me how to fix it — do not work around it, and do not proceed to phase 2.

**Environment**
- `node --version` is 22.x or newer. `npm --version` works.
- `git --version` works, we are inside a git repository, and `git status` is clean or has only expected untracked files.
- `git remote -v` shows a remote. Tell me if it does not — I intended to add one.
- Available disk on this filesystem is over 10 GB (`df -h .`).
- **`df -T .` reports a real Linux filesystem** — `ext4`, `xfs`, or `btrfs`. If it reports `fuseblk`, `ntfs`, `ntfs3`, `exfat`, `vfat`, or any network filesystem, **stop immediately**. SQLite WAL needs mmap-backed shared memory and POSIX advisory locking, which those do not provide; Unix permissions and Unix domain sockets do not work there either. The repository must be moved to the ext4 root filesystem before anything else happens. See `docs/15`.
- No path component contains a space (`pwd`). Spaces survive most tooling but complicate the systemd unit and shell scripts later.

**Repository hygiene**
- `.gitignore` exists and covers at minimum: `node_modules/`, `dist/`, `.env`, `*.db`, `*.db-wal`, `*.db-shm`, `data/`, `backups/`, `coverage/`.
- `.env.example` exists and contains **no real values** — every secret field must be empty.
- `.env` exists. Do not read it, do not print it, do not cat or grep it. Confirm only that the file is present and that its permissions are 600 (`stat -c '%a' .env`). If permissions are looser, tell me to run `chmod 600 .env`.
- `git ls-files` does **not** include `.env`. If it does, stop immediately and tell me — a token may have been committed and needs to be regenerated in the Discord Developer Portal.
- `git log --all -p -- .env` returns nothing, confirming no token was ever committed in history.
- `.claude/settings.json` exists and denies reading `.env`.
- `LICENSE` exists at the root and is Apache-2.0. If it is missing, add it — ADR 0011.

**Planning documents**
- These exist and are readable: `README.md`, `CLAUDE.md`, `AGENTS.md`, `IMPLEMENTATION_BRIEF.md`, `REVIEW.md`, `PRIVACY.md`, `docs/01` through `docs/18`, `docs/RELEASE1_CONFIG.md`, and `docs/decisions/0001` through `0013`.
- Report anything referenced by another document but missing from disk.

**Configuration sanity — without reading `.env`**
- Write a small script that loads `.env` and checks only for *presence and shape*, never printing values: is `DISCORD_BOT_TOKEN` non-empty; is `DISCORD_APPLICATION_ID` a numeric snowflake; is `BANANASAURS_GUILD_ALLOWLIST` non-empty and numeric; is `BANANASAURS_OWNER_USER_ID` a numeric snowflake; is `DASHBOARD_SESSION_SECRET` at least 32 characters; is `BANANASAURS_DRY_RUN` set to 1.
- Report pass/fail per field. Never echo a value, not even partially, not even a prefix.

Then stop and wait for me.

## Phase 2 — Plan, no code

Read `README.md`, `IMPLEMENTATION_BRIEF.md`, `CLAUDE.md`, `AGENTS.md`, `REVIEW.md`, everything in `docs/`, and every ADR in `docs/decisions/`. Where `REVIEW.md` or a later ADR contradicts an older document, the newer one wins.

We are building **Release 0 and Release 1 only**, as defined in `docs/08_ROADMAP.md`. No AI, no archive, no automod, no memory, no provider integration. One dashboard page.

The stack is decided in ADR 0008. Do not reconsider it.

Produce a plan covering:

1. **Repository layout** — a single npm workspace. Where the boundary sits between the Discord adapter, the application core, the module runtime, and storage. Justify each boundary in one sentence and delete any you cannot justify.
2. **Database schema for Release 1 only** — guild config, dashboard accounts and sessions, principals and capability grants, log routing, role panels and their emoji/component mappings, managed role assignments, the job table, and audit events. Show the guild-scope constraints and the idempotency constraints explicitly as SQL, not prose.
3. **The fake Discord harness** — which gateway events, button interactions, and REST calls it simulates, and how a test triggers: a duplicate event, a reconnect gap, a 429, a missing-permission error, a role-hierarchy failure, and a reaction on an uncached message. This gets built before the features that use it.
4. **Event pipeline and deduplication mechanism.**
5. **Permission model** — how a capability grant is checked, where the check happens, and why a new caller cannot bypass it.
6. **Ordered work plan** — numbered slices, each ending with the project compiling, tests passing, and something demonstrable.

Constraints to honour, and I want each one addressed explicitly in the plan rather than assumed:

- **discord.js caches restricted** per ADR 0008, and `partials` enabled for Message, Channel, Reaction, and User. Show me the client construction. Without partials, reactions on uncached messages vanish silently, which is the single most likely cause of a panel appearing dead.
- **SQLite in WAL with a single writer.** Say how you enforce one writer, given a background worker and interactive reads share the process.
- **Role panels in two kinds.** *Adopted* panels attach an emoji-to-role mapping to any existing message by ID, including messages I posted — this is the Carl-bot behaviour and it is the primary thing I want. The bot seeds the mapped reactions and watches reaction add/remove; it cannot edit that message or attach buttons to it. *Managed* panels are posted by the bot, so buttons, select menus, editable text, and ephemeral confirmations are available. Both support toggle, add-only, remove-only, and single-choice, with per-panel limits and required/blocked role checks.
- **Adoption pass**: on adopting a panel, fetch everyone who already reacted with each mapped emoji and grant the roles. The existing reaction state is the intended role state.
- **Reaction drift**: reactions added while the bot is offline produce no event on reconnect, so adopted panels need periodic reconciliation against live reaction state, bounded by the reconciliation budget.
- **Hierarchy checked immediately before every role mutation**, plus a periodic self-check that each managed role is still assignable.
- **Logging module**: message edits and deletions, member joins and leaves, role and channel changes, routed to configured log channels. Deletion actor is inferred from the audit log and must be labelled inferred, since `MESSAGE_DELETE` does not carry it.
- **Every safety control in `docs/18`**, in Release 1, not deferred: role allowlist, rate cap with circuit breaker, reconciliation budget, `BANANASAURS_DRY_RUN`, batch-ID undo, kill switch, and a `doctor` that disables a failing panel rather than the whole bot. Show me where each is enforced in the architecture — I do not want them sprinkled as guard clauses at call sites.
- **Operator CLI** per ADR 0013 and `docs/17`: talks to the daemon over a Unix socket, never to the database file, because SQLite is single-writer. Guild-scoped, `--json`, `--confirm` on writes, an audit row per write, secrets never printed, `BANANASAURS_READONLY` honoured.
- **Dashboard is one page**: health, log routing, panel config, audit table, kill switch. Authentication is owner-provisioned local accounts per ADR 0012 — **not** Discord OAuth. Other members of my server hold Discord Administrator and must not be able to reach it. Show me the first-account bootstrap flow.
- **`/privacy`** renders `PRIVACY.md` with live settings substituted.
- **Backup and a restore I can actually run.**

State back to me, in your own words, the hard rule from ADR 0013: no application code ever spawns the `claude` binary or touches Claude subscription credentials — not from a Discord handler, not from a job, not through a queue.

Then stop and wait for me. Flag anything in the planning documents you think is wrong, underspecified, or contradictory. I would rather argue about the plan than about the code.

## Phase 3 — Build, with self-validation

Once I approve the plan, implement it slice by slice. For every slice:

**Before you call it done, you run it.** `npm run typecheck && npm run lint && npm run test` must all pass, and you must show me the actual output. Do not report completion on the basis of code you have not executed.

**Prove the tests are real.** After writing tests for a slice, deliberately break the implementation they cover — invert a condition, drop a guard, return early — confirm the tests fail, then restore it. Tell me what you broke and what failed. A test that passes when the implementation is broken is decoration, and agent-written tests drift toward asserting that a mock was called rather than that behaviour is correct.

**Self-review each slice against these four before showing me the diff:**
1. Does every new query take a guild ID? A query that *can* omit guild scope is a bug even if every current caller passes it.
2. Does every new Discord side effect have a durable idempotency key and a unique constraint making double execution impossible?
3. Does any untrusted input reach an execution path without passing a Zod validator?
4. Would each new test fail if the implementation were broken?

Report the answers. If any is "no," fix it before showing me.

**Do not commit.** Show me the diff summary and let me review and commit.

**Do not build ahead.** Release 0 and 1 only. If you find yourself scaffolding a provider router, a module runtime, or a second dashboard page, stop — those are guesses about requirements I have not discovered yet.

If you get stuck or a requirement turns out to be wrong, say so rather than working around it quietly.

---

## After phase 1

If the setup check surfaces problems, fix them and re-run phase 1 before moving on. It is a cheap check and it is the only one that happens before there is any code to hide behind.

## Prompt for later slices

```
Read CLAUDE.md and docs/08_ROADMAP.md.

We are on Release <N>, slice <M>: <one-line description>.

Prior slices are committed and green. Do not modify <stable areas> unless this
slice requires it, and tell me first if it does.

Requirements:
- <specific, testable requirement>

Tests I expect to exist when this is done:
- <behaviour>, including the failure case where <X>
- <behaviour> is idempotent when the event is delivered twice

Plan first. Then implement. Then run typecheck, lint, and tests and show me the
output. Break the implementation to prove the tests catch it, then restore it.
Answer the four self-review questions. Show me the diff summary. Do not commit.
```

Naming the tests you expect matters — an agent writes the tests you ask for and skips the ones you don't. Forbidding the commit matters because it is what makes you actually read the diff.
