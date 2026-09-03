# Current state

**Living document.** Update it at the end of each working session so a fresh conversation can pick up without re-reading everything. Last updated 2026-09-02.

---

## Where the build is

**Release 1 is done — 2026-08-30.** All six work packages (`docs/20_AUTONOMOUS_EXECUTION.md`) and all sixteen slices are built, merged to `main`, and green: WP1 (skeleton, fake Discord harness), WP2 (schema, event pipeline, safety core), WP3 (role panels, adoption, reconciliation), WP4 (logging module), WP5 (Discord adapter, role panels live-tested, operator CLI, dashboard, slash commands), WP6 (backup, restore, doctor hardening). 1,638 tests, `typecheck` and `lint` clean. Every box in `docs/SMOKE_TESTS.md` is checked, including sections B and C which needed a live test guild and real data — see `docs/reports/release1-smoke-tests-live-run.md` for the full account (two real dashboard bugs found and fixed live, and a confirmed anti-nuke safety property). Detailed per-slice history lives in `docs/SESSION_LOG.md` (append-only) and `docs/reports/`; this file only tracks where things stand now.

**This host has no production systemd deployment yet.** The daemon has only ever run via `npm run start` or, as of the 2026-08-30 smoke test, `deploy/bananasaurs-test.service` — a unit that runs as the checkout's own owner directly against this repo, deliberately not the hardened `/opt` layout `deploy/bananasaurs.service` describes. Standing up the real production deployment (service account, `bananasaurs-ops` group, `/opt/bananasaurs`, `/etc/bananasaurs/env`) is a real-guild-cutover task per `docs/17_OPERATOR_ACCESS.md` §2, not something Release 1's testing needed.

**Nothing in the moderation path has ever run.** Confirmed by read-only inspection of `data/bananasaurs.db` on 2026-09-02: it stood at migration 5 with **no automod tables at all** until Release 2's migrations were applied. No rule has evaluated a message, no case event exists, no observe clock has started. Everything below describes code that is merged and green — not code that is running. Keep those two apart when you edit this file; see "How to update this file".

**Release 2 is in progress.** These slices are merged to `main` and green:

- **The automod rule engine foundation** (ADR 0035, amended by ADR 0036) — `mod_rules`, exemptions, word categories/terms/allowlist, `mod_cases`, `mod_case_events`, `test`/`observe`/`enforce` modes, the escalation ladder, the `MESSAGE_CREATE`/`MESSAGE_UPDATE` subscriber, and the twelve-value `action_taken` vocabulary. **One predicate: `keyword_filter`.**
- **The `/mod` command surface** (ADR 0037) — timeout, untimeout, kick, ban, unban, warn, purge, note, evidence, history; confirm-then-execute on ban and purge; the bounded `mod_purge` job; six more `action_taken` values.

**The Release 2 scope check is done.** Native AutoMod is configured in the guild with three defaults enabled: block mention spam, block suspected spam content, block commonly flagged words. It does not remove the need for the custom engine — ADR 0035 records why (members with `Administrator` or `Manage Server` are exempt from every native rule, unconditionally and unconfigurably), and the owner cannot inspect native's algorithms because Discord does not publish them.

**Slice 0 — native AutoMod observability — merged 2026-09-01.** ADR 0038 plus six tasks: the `autoModerationAction` domain event and its dedupe fingerprint, the `AutoModerationExecution` gateway intent and translator, four additive `native_*` `action_taken` values with migration 0009, a subscriber that records native's decisions without counting them toward escalation, the end-to-end wiring, and a test asserting native and Bananasaurs cannot double-punish. (An earlier version of this line said Slice 0 was "live". It was not, and is not — see the paragraph above.)

**Slice 1 — the predicate abstraction and `mod_rules.config` carrier — merged 2026-09-01** (ADR 0040). Two-stage `compile`/`evaluate` predicate interface, per-kind Zod config validated on write *and* read, a compiled-artifact cache keyed by a content fingerprint so a term edit takes effect on the next message with no restart, and `doctor` reporting any rule that cannot compile. Also fixed a migration that would have silently emptied every word list and exemption on a future table rebuild.

**Slice 2 — fixtures, the dry-run evaluator, match traces, and a CLI review — merged 2026-09-02** (ADR 0041). `automod_fixtures`, `mod_match_reviews`, stored `MatchTrace`, the one-code-path invariant (the dry run and the live subscriber call the same two functions), and `bananasaurs automod dryrun` / `review` / `verdict`. `PRIVACY.md` gained a retention row in the same commit as the table. **2,148 tests**, typecheck and lint clean. Full record, including nine plan rulings and ten decorative guards found, in `docs/LEDGER_RELEASE2_SLICES_1_6.md`.

**The blocking permission decision is made — the owner granted `Manage Server` on 2026-09-01.** Discord dispatches `AUTO_MODERATION_ACTION_EXECUTION` only to a bot holding `ManageGuild` (confirmed in discord.js's own source); `docs/18` used to list it under "Deliberately absent," and now records the grant instead. `doctor`'s `REQUIRED_PERMISSIONS` includes it, so a bot missing it now fails `doctor` outright rather than merely being reported as inert. The grant also unlocks Discord's AutoMod REST endpoints, guild-settings edits, integration management, and viewing all invites — Bananasaurs uses none of that; ADR 0038 leaves managing native rules explicitly out of scope. The trade is written up in `docs/18` and in ADR 0038's Consequences, with the outcome appended there.

**Found and fixed: a live bug in the shipped keyword filter (ADR 0039, 2026-09-01).** `obscenity`'s `collapseDuplicatesTransformer` collapses doubled letters in the matched *input* but not in a `parseRawPattern`-compiled term, unless the letter is one of six custom-thresholded ones (b/e/o/l/s/g). So a configured keyword containing any other doubled letter — `spammer`, `forbidden`, `bitter` — sat in the database looking configured and **silently never matched**, in any mode. Fixed by deriving collapse thresholds from each rule's own word list (any letter doubled in a configured term gets threshold 2, unioned with obscenity's six) — see ADR 0039 for the full analysis, why the alternative (pre-collapsing the pattern) was rejected as a false-positive risk, and the resulting trade (adding a term with a new doubled letter slightly relaxes collapsing for that letter, rule-wide). **Consequence, now settled: none.** This would have made any affected rule's observe data worthless — the rule was not actually evaluating the affected term, so a clean-looking false-positive rate measured nothing real. But no rule has ever run (see the top of this section), so there is no data to discard and no clock to restart. The fix landed before the first observation, which is the only reason this cost nothing.

**Next action: Slice 3** — the precise tier (`regex`, `invite`, `link_domain`). No ADR is named for it. Slices 3–6 remain before flip day; the running record, the carried-forward obligations and every ruling made so far are in `docs/LEDGER_RELEASE2_SLICES_1_6.md`, which is where a new session should start. The whole remaining plan for Release 2, plus a Release 3 roadmap, is in `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`: twelve slices in five phases, seventeen recorded decisions, and the three findings that reorder the release (`mod_rules` has no config carrier, the subscriber has the keyword matcher hard-wired, and native AutoMod blocking before `MESSAGE_CREATE` both removes the double-punishment risk and biases the observe window). Its ADR table now runs 0038, 0039 (this bugfix, out of sequence), 0040–0045.

**The wall-clock critical path is the observe window, not the code.** Slices 0–6 exist to reach "flip day" — every rule into `observe` on the same day so their clocks overlap — after which the dashboard work (slices 7–10) happens *during* the two weeks.

`/privacy` was dropped from Release 1 scope (2026-08-30, WP5 slice 15): Discord requires a posted privacy policy only above 100 servers, and Bananasaurs runs on one. `docs/08_ROADMAP.md` and `docs/12_OPEN_QUESTIONS.md` are corrected to match.

## Environment as it actually is

| | |
|---|---|
| Host | Dell OptiPlex 5040, i7-6700, 19 GiB RAM, Linux Mint 22.3, dedicated to server work |
| Repo | `/home/bryan/projects/bananasaurs`, ext4, private GitHub remote, branch `main` |
| Editor | VS Code Remote over SSH; Claude Code (Opus) runs on the box |
| Discord | Bot created, both privileged intents enabled, invited to a **test guild** with permission integer 2416004320 |
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
5. ~~**Release 2 scope check**~~ — done 2026-09-01. Native AutoMod is configured with its three defaults; it does not replace the custom engine, because it exempts `Administrator`/`Manage Server` holders unconditionally (ADR 0035) and its decisions are otherwise unobservable. Slice 0 of the roadmap ingests `AUTO_MODERATION_ACTION_EXECUTION` so native's decisions become auditable and feed the same false-positive review as ours.
6. **Audit trail doesn't record refusals — answered for moderation, still open for role effects.** ADR 0035 made the deliberate decision for the new subsystem: a refused moderation action is written to `mod_case_events` with its reason, because "the bot tried to timeout the owner and correctly couldn't" is exactly what a human reading case history needs. The Release 1 behaviour is unchanged and still stands — a role-effect refusal is a `logger.warn` and nothing else (`packages/core/src/effects/gateway.ts:199-215`). That asymmetry is now a recorded choice rather than an oversight, but whether role effects should match moderation is still undecided.

7. **The false-positive thresholds are set but untested** — 5% of reviewed matches for delete-only rules, zero for rules that feed the escalation counter, a 20-match minimum sample, and a fixture-pass-plus-sign-off path below it (owner decision, 2026-09-01). These are defensible starting points, not measurements. If `caps` or `duplicate_message` fails its bar in the first observe window, the intended response is to narrow the rule or make it delete-only — **not** to move the bar.

## Decisions made in conversation, now recorded in the repo

Everything consequential from the planning conversation is written down. If a future conversation needs the reasoning, it is in these files rather than in chat history:

- `REVIEW.md` — the full plan review: blocking issues, scope cuts, sixteen Discord API realities, and an addendum recording Bryan's answers and what each one changed.
- `docs/08_ROADMAP.md` — three releases, replacing the original ten milestones.
- `docs/18_SAFETY_AND_BLAST_RADIUS.md` — the seven layers bounding what a bug can do, and the rollout sequence.
- `docs/17_OPERATOR_ACCESS.md` — SSH, the operator CLI, and the line Claude Code must not cross.
- ADRs 0008–0013 — stack, archive scope, provider gate, license, dashboard auth, operator access.
- `PRIVACY.md` — member-facing policy, needs placeholder fields filled before posting.
- `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md` — the rest of Release 2 (twelve slices, five phases) and a Release 3 roadmap, with seventeen recorded decisions and the assumptions worth challenging. Release 3's keystone is there too: the tool registry and proposed-action pipeline that let the AI reach every bot feature without ever being in the enforcement path.

## How to update this file

At the end of each **slice** (not each session), revise "Where the build is," add anything new to "Still open," and delete anything resolved. Keep it short. A state file nobody reads because it grew to ten pages is worse than none. Detailed history goes in `docs/SESSION_LOG.md` and `docs/reports/`; the running record for the current release goes in its ledger. This file says only where things stand now.

**Never write that something is "live" or "running" when you mean its code is merged.** For anything in the moderation path, say which of three states is true: *merged and green*, *migrated onto the live database*, or *actually evaluating traffic*. They are different, and the Release 2 gate depends on telling them apart — a false-positive rate can only be measured from rules that have really been observing. This file claimed Slice 0 was "live" for a day; it had never run, and a reader had no way to know. If you are unsure which state something is in, **inspect the database read-only and write down what you found**, rather than inferring it from the fact that the code exists.
