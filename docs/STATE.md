# Current state

**Living document.** Update it at the end of each working session so a fresh conversation can pick up without re-reading everything. Last updated 2026-10-11 (provider key pools and routing, ADRs 0143–0144; assistant new abilities, ADRs 0145–0147; assistant capability truth, ADRs 0136–0137).

---

**Assistant streaming (Slice 3, ADR 0148, no migration).**

- **Streaming:** OpenRouter/NIM send `stream: true` with usage; Gemini uses `:streamGenerateContent?alt=sse`. SSE comments ignored, tool args joined per index, thought parts kept apart, raw parts echoed for signatures.
- **Timeouts:** idle 45 s (`assistant.providerIdleTimeoutMs`) re-armed per byte, ceiling 300 s (`assistant.providerMaxCallMs`), first byte 60 s (`assistant.providerTimeoutMs`). `assistant.maxOutputTokens` default 4,096.
- **Finish reasons:** mid-stream `error` is retryable and its partial text is discarded; `length`/`MAX_TOKENS` with text adds a code-built cut-short marker after the guard; `length` empty keeps the empty-answer path.
- **Live dashboard:** per-run buffer (8,000 chars answer plus 8,000 thinking, dropped at finish), `GET /api/assistant/runs/:runId/live`, `model-progress` steps at most every 3 s on one run-shared throttle, thinking saved per round under trace `reasoning` (8,000 chars each; the 12-round limit is a schema contract that the T12 writer must enforce, not yet enforced by `capTrace`). On Discord only the typing indicator changes (kept alive to the ceiling).
- **Thinking gate:** a thinking parameter never goes out when the entry capabilities forbid it (unknown models get none); `ChainEntry.capabilities` is optional and store-populated (contracts §3 deviation noted).
- **Integration status:** the bullets above describe the Slice 3 contract, not a completed rollout. At base `59fe3e9e`, the shared SSE parser, settings, trace schema, Gemini adapter and live-buffer route are merged. OpenAI-compatible streaming (T6), tool-loop wiring (T8), dashboard live text (T10) and daemon wiring (T12) remain pending. In particular, live-buffer appends, saved trace reasoning, store-populated capabilities and the raised typing ceiling are not yet wired end to end. T12 is planned to persist reasoning with the existing trace retention rules; its implementation has not been verified here.

**Slice 6 — provider key pools, cooldowns, Gemini chain and routing (ADRs 0143–0144, migration `key_pools_routing`).**

- **Key pools:** a chain entry uses one key or every enabled key of its provider; the pick is deterministic (most daily requests left, then least-recent use, then key id). Keys sharing a project label share one daily ledger bucket, enforced across the bucket at reserve time. Bulk paste dedupes by SHA-256 fingerprint without exposing secrets.
- **Cooldowns:** a daily Gemini 429 cools until the next Pacific midnight, a minute 429 for the retry delay or 60 s, an invalid key until edit or re-test; rows survive restarts and fully spent pools fall through quietly.
- **Chain:** `gemini-3.8-flash` (5 RPM / 20 RPD) → `gemini-3.6-flash` (5 / 20) → `gemini-3.5-flash-lite` (15 / 500), each over the whole Gemini pool, then the owner's OpenRouter entries.
- **Routing:** short simple messages try the light tier first; attachments, quotes, long threads and full-model keywords use standard. It is one tool-loop run: a light entry's round-1 tool calls hand the same loop to standard entries from round 2 (`escalateAfterTools`, setting `routerEscalateOnTool`), so no acting tool runs twice. Every decision is a `routed` run event; a second `routed` event with reason `escalated-after-tool` marks the hand-over. The router sees only fixed reasons, never message text.
- **Check models:** capability fixtures run against one entry with stubbed tools on a reserved budget, recorded as `dashboard-test`. **Gemini may-train line (D12):** free keys may train on submitted input, paid keys are recorded no-training; both stay usable with warnings in logs, dashboard and doctor.
- **Known gaps:** the background-tier consumer (summaries, daily digest) is not wired yet (Slice 5 wires the digest). The Gemini free/paid eligibility rows follow decision D12 in the approved spec.

**Assistant new abilities (Slice 2 of `docs/superpowers/specs/2026-10-09-assistant-harness-capability-design.md`) (ADRs 0145–0147, migration `drizzle/0108_parallel_search_source.sql`).**

- **Names and lookup (ADR 0145):** the display-name sanitiser accepts a names map. Current-question names are wired by S2-T12 (merged on instinct/slice-2). `find_member` is read-only, available to any member who can ask the assistant, and returns up to 5 matches with display name, username and up to 10 role names, never ids. The owner may want to restrict this lookup disclosure.
- **Reply pings (ADR 0145, D3):** the model writes `@Name`; code pings only exact matches for members or roles the asker mentioned or named. Limits are at most 5 members and 3 roles, configurable downward. `@everyone`/`@here` never ping; inline and fenced code are skipped; roles pass ADR 0117 and non-mentionable roles need the asker's Mention Everyone permission. The ping skill and the asker's Send permission must pass. Only part 1 of a multi-part reply carries ping permissions; later parts do not ping. Delivery resumes from the durable posted-parts cursor on retry; the pings resolved at invoke are not re-checked when a retry reposts part 1 (known gap, accepted 2026-10-11). Names may contain underscores.
- **Scheduled messages (ADR 0145):** `set_reminder` `style: "message"` posts text without the reminder frame, using the same storage, delivery, ping checks, edit and cancel paths. Configured pings may precede the text; mass mentions are neutralised and text is capped to fit Discord. Style is fixed at creation.
- **Task tools (ADR 0146, D4a):** the tasks skill defaults to owner; the owner must grant other roles access. `TaskContextPort.access` also checks authority: `create_task` needs the team's lead or the president; `list_tasks` shows only the asker's teams; `task_progress` requires the asker to be assigned to the task and still on its team. Creation checks the current destination channel against the MCP-equivalent team/channel and Write rules and requires a future due date within two years. Task and progress-note keys are deterministic from the invocation key and content.
- **Parallel search (ADR 0147, D11):** third web-search source, REST fast mode behind the configured source, with sealed keys and reserve-before-send limits. The eligibility row discloses training. The POST search-keys route applies 4,500/month when a new Parallel key omits its limit, and the dashboard pre-fills 4,500; storage's generic default stays 1,000/month. Explicit limits, including no limit, are preserved.
- **Migration:** `drizzle/0108_parallel_search_source.sql` rebuilds `assistant_provider_config` and `assistant_search_keys` to widen the source checks, adds reminder style and seeds Parallel eligibility. Its live application has not been verified here.
- **Slice gate:** run by the Slice 2 lead, see `slice-2-REPORT.md`. This docs-only task did not run typecheck, lint or the full test suite.

---

**Assistant capability truth (Slice 1 of `docs/superpowers/specs/2026-10-09-assistant-harness-capability-design.md`) — built on `worktree-assistant-harness-capability-plan`, not yet merged (ADRs 0136–0137, no migration).**

- **One capability block (ADR 0136):** the prompt ends with WHAT YOU CAN DO RIGHT NOW, built from the exact tools declared on that turn, grouped (reminders, club knowledge, channel, web, server, time, proposals), then prose skills, then what is not available to this member and why. A NOW line gives the date and time. When history holds earlier bot replies, the user message says the listed abilities are exact for this member.
- **Later rounds (ADR 0137):** read-only tools run in any round, web search included; `read_chunk`, `open_resource`, `channel_history`, `edit_reminder` and `cancel_reminder` need an id an earlier result returned; acting tools run in round 1 only. Hard rule 3 reworded to match.
- **Tools speak plainly:** every tool description says what it does and when to use it; every refusal ends with what to do next.
- **Web search skill:** a non-acting `web-search` skill (default everyone) gates `web_search`; the owner can narrow it on the Skills page.
- **Helpful wizard:** the default boundary helps with any reasonable request; FOCUS replaces WHAT YOU HELP WITH; sources are club first, then the web. Prompts saved by the old wizard are rewritten when compiled.
- **AI setup page:** chain models OpenRouter no longer lists are flagged, and each OpenRouter model shows chips (reads images, reads PDFs, uses tools, thinks) from OpenRouter's public model list, refreshed hourly.
- **Fixtures:** capability fixtures from the live transcripts check that each failing conversation now gets a prompt that makes the right answer possible.

---

**Assistant harness v2 — built on `worktree-assistant-harness-v2-docs`, not yet merged to `main` (pending owner review).** The member-facing assistant layer from the Release 3 scope now runs end to end on the test guild path, behind the existing provider-eligibility gate. One line per area:

- **Accounts (ADRs 0069, 0070):** the owner account is protected — every dashboard account route refuses delete, disable, access-removal and permission changes on an owner row with `403 owner-protected`, enforced server-side; the owner can still change their own password, and host CLI recovery is untouched. Accounts pages: list (`/accounts`) with role badges, add (`/accounts/new`) with role presets (Viewer, Moderator, Server manager, Custom) and a chosen-or-generated password, edit (`/accounts/:username`) with Summary, Permissions, Password, Sessions and Danger zone plus a revoke-one-permission route. The owner may reveal a non-owner account's sealed password copy (AES-256-GCM in `account-password.key`, re-authentication required, audited without the password); owner passwords are never sealed, and `doctor` reports vault-key state and the revealable count.
- **Providers and model chain (ADRs 0075, 0077):** several labelled keys per provider (Gemini, OpenRouter, NVIDIA NIM) with sealed values, cost class and enabled flag; one ordered model chain of up to 6 key-plus-model entries with a Test button per row; one process-wide free-allowance ledger keyed by key id, so a spent `:free` daily allowance stays spent across guilds until its reset. AI setup page (`/assistant/setup`, `/providers` alias, owner-only routes): model order, provider cards, Brave web search, GitHub token, each with a Ready / Needs attention / Off pill. A daily-free quota error skips to the next non-`:free` entry or answers the daily-cap reply at once — no 10s/30s/90s retry, no `BUSY_REPLY`.
- **Tool calls and thinking:** OpenAI-compatible adapters send native structured tool calls (Zod-validated, never executed from text); Gemini (before Slice 3) always sent `thinkingConfig.thinkingBudget` (512 for tool rounds, 1,024 for the answer); with Slice 3 it sends `thinkingLevel` only for `levels` models, a budget only for `budget` models, and neither for `none`.
- **Skills:** each skill has a detail page (`/assistant/skills/:skillId`) with its instruction, tools, behaviour allowlist and recent runs.
- **Traces and History (ADR 0076):** every run writes one guild-scoped trace (capped at 200 KB); History page (`/assistant/history`) with outcome/behaviour/member filters and a 14-day usage strip; detail (`/assistant/history/:traceId`) with Summary, Model attempts, Prompt sections, Tool calls, Timeline and Errors. Prompt text needs `config.read`.
- **Safety and prompts (ADR 0074):** a locked, versioned safety suffix is appended after every behaviour prompt and shown read-only; the output guard strips tool-call-shaped text (re-asking once with no tools before failing), refuses prompt-leak answers, and neutralises mentions; long answers are split for Discord; each behaviour has a deterministic per-behaviour prompt wizard (`/assistant/behaviours/:id/wizard`, answers stored as JSON, 4,000-character prompt limit).
- **Tool loop (ADR 0071):** round 1 offers every allowed read-only tool (up to 6 parallel calls); rounds 2–4 offer only `read_chunk`, `outline` and `open_resource`, and only with IDs an earlier result in the same request returned (anything else is refused as unknown id). Budgets: 4 rounds, 6 calls per round, 12 calls total, 24,000 characters of results, 2,048 max output tokens; then one final no-tools answer pass.
- **Conversations (ADR 0072):** reply-to-bot-answer continues, reply-to-turn plus tag continues, reply-to-a-third-party plus tag starts a quoted-evidence conversation, same-author tag within 30 minutes continues, `new topic`/`new question` starts fresh; answers post as Discord replies. Conversations page (`/assistant/conversations`) with channel/member/behaviour filters, title search, transcripts linking History traces and Discord, End and Delete buttons. Auto-delete after 2/6/12 months (61/182/365 days, default 182) or keep forever, via a daily durable prune job with a count-only audit row.
- **Resource cache and GitHub import (ADR 0073):** persistent `resource_documents`/`resource_chunks` with a hand-written FTS5 index (`bm25`); heading-aware Markdown chunking, 60-line/10-overlap windows otherwise; an hourly durable refresh (conditional requests, re-chunk on hash change) plus per-resource Update now and Update all — the request path reads the cache, never the live web. GitHub import from Resources ("Add from GitHub"): org, repo or file/folder URLs, repo preview with file checkboxes, org listing with fork/archived toggles, parent-plus-child resources on `raw.githubusercontent.com`, hourly org re-listing. Cache tools: `list_sources`, `search_sources`, `read_chunk`, `outline`, `open_resource`, `refresh_source` (round 1 only, once per 10 minutes per resource), each result bounded and redacted.
- **Try it, feedback, sources line:** Try it on a behaviour (`POST /api/assistant/behaviours/:id/try`, `config.write`-gated, 20 tries per account per hour in memory so it resets on restart, never posts to Discord); 👍/👎 reactions on bot answers record feedback and removing the reaction clears it (the trace keeps its append-only `feedback:` flag as history); answers that cite a club source end with a short `-# Sources:` line listing only the cited sources (at most five); answers that cite nothing have no Sources line.

**Migrations added: 0037–0046** (account roles and sealed passwords, providers/keys/model chain, conversations and message map, resource cache documents/chunks plus the hand-written FTS5 table, traces).

**On deploy, an operator must:** stop the daemon → build → `db:migrate` → start; then, on the AI setup page, set a GitHub token if imports should reach past READMEs.

**Known limits:** a note resource cannot hold free text — URL validation applies to every resource kind, notes included. Without a GitHub token the unauthenticated rate limit is 60 requests an hour, organisations refresh once a day, and only README files are read. OpenRouter/Gemini free allowances are per provider account, so a second key on the same account is not a real backup.

---

**Web UI overhaul (ADR 0051) — built on `oc/webui-overhaul`, unmerged pending owner review and Claude audit.**
The dashboard is now the full operator surface: shell (ADR-aligned rail: Operate / Moderation / Archive /
Instance / Release 3, "Bananasaurs by Sighton Media" attribution), five Release 1 page rewrites, and nine new
operator pages (Jobs, Doctor, Backups, Configuration, Accounts, MCP connector, Archive, Search, Providers)
backed by new `packages/http` routes — `ops-read.ts` (18 GET routes) and `ops-write.ts` (40 write routes,
audited, refusal unions as 4xx answers). Writes confirm through a scope-quoting dialog; password resets print
once and are never audited; `bootstrap reissue` stays CLI-only; the seven account lifecycle routes are gated on the
new `accounts.manage` capability rather than `config.write` (ADR 0056), with migration 0027 granting it to existing
owners — **run `db:migrate` before starting the daemon**. Archive, Search and Providers are built pages
now (D7 supersedes S10-D3); the Release 3 stubs are Resources, Memory, AI workspace and Proposals. The
observe-phase freeze held: no route reaches `mode='enforce'`, and the automod mode gate is ADR 0042's existing
one. Threads-and-forums compatibility is on `oc/threads-and-forums` (also unmerged); new channel fields accept
any snowflake.

**Slice M5 — `send_message`, the allowlist and audit — built 2026-09-16**, on
`oc/m5-send-message`. The MCP connector can post to allowlisted channels
only, ten per guild per rolling hour, mentions suppressed, idempotent, every
send in `mcp_sends` and in the audit trail as `actor_type='mcp_operator'`.
`packages/core/src/effects/gateway.ts` is byte-identical to its pre-slice
state: the send path is a sibling module (`message-gateway.ts`), which is
ruling M5-D1 and exists so the moderation chokepoint cannot regress while the
observe window runs.

Two findings worth carrying forward:

- **`allowedMentions` is set in exactly one place in the tree** — the MCP send
  path. Every other message the bot sends (panels, log messages) still goes
  out with Discord's default, which parses every mention in the content.
  Nothing currently posts member-supplied text through those paths, so this is
  a latent gap rather than a live bug, and closing it means changing what
  panel posts do — which is why M5 did not (ruling M5-D2). Worth doing once
  the observe window closes.
- **drizzle-kit 0.31.10 emits an invalid `CREATE INDEX` when it rebuilds a
  table carrying a sort-ordered index** (ruling M5-D7). It bit the
  `audit_events` rebuild in migration 0023 and will bite every future one.
  The correction is one line, and the schema-invariants proof now asserts the
  index survives the rebuild, not only the rows.


**Incident 2026-09-17 — the daemon crash-looped for about a day, and the
observe window collected nothing while it did.** `SqliteError: no such table:
archive_channels`, thrown by the archive expiry timer, 15,234 restarts. The
database was simply behind the code. Three things are worth keeping:

- **`assertMigrated` was too weak and is now fixed.** It asked only whether
  `guilds` existed, which proves the database has *a* schema and never that
  the schema matches this build — so the process started cleanly and died
  later at whatever query first touched a missing table. The M4 whole-branch
  review predicted this exact failure and it was recorded as "worth a line in
  the restore runbook"; it was worth a fix. It now compares
  `drizzle/meta/_journal.json` against `__drizzle_migrations` and refuses to
  start with the number of missing migrations and the command to run.
- **The systemd unit runs this checkout's `dist/`.** `npm run typecheck` and
  `npm run build` both run `tsc --build`, which rewrites `dist/` — so routine
  verification updates the code a live service executes. The unit calls
  itself a test unit on a dev checkout, so the coupling is deliberate, but it
  means *the gates are a deployment*. Until that is separated, treat any
  build on this box as a deploy: migrate before restarting.
- **A no-emit typecheck is not a valid gate after a merge that adds
  cross-package exports.** `tsc -p tsconfig.all.json` checks sources against
  sibling packages' built `.d.ts`, so with a stale `dist/` it reported 38
  phantom errors for symbols that exist in source. Same root as D58: the
  gates depend on build state on disk, not only on the repository.

Also found by `doctor` on recovery, unrelated to the crash: both guilds are
missing `BanMembers` and `ManageMessages`, and the club guild is also missing
`UseApplicationCommands` (so slash commands do not work there). Not urgent
under observe + dry run; `ManageMessages` is needed before enforce. The club
guild is now **246 members**, not the 210 the design documents quote.

**Slice 10 — seven Release 3 route stubs — landed 2026-09-17** on `oc/slice-10-stubs` (Archive, Search, Resources, Providers, Memory, AI workspace, Proposals — each a `StubPage` stating the feature does not exist yet; Archive and Search remain stubs by the 2026-09-12 amendment, CLI/MCP-only in Release 2).


## Where the build is

**Release 1 is done — 2026-08-30.** All six work packages (`docs/20_AUTONOMOUS_EXECUTION.md`) and all sixteen slices are built, merged to `main`, and green: WP1 (skeleton, fake Discord harness), WP2 (schema, event pipeline, safety core), WP3 (role panels, adoption, reconciliation), WP4 (logging module), WP5 (Discord adapter, role panels live-tested, operator CLI, dashboard, slash commands), WP6 (backup, restore, doctor hardening). 1,638 tests, `typecheck` and `lint` clean. Every box in `docs/SMOKE_TESTS.md` is checked, including sections B and C which needed a live test guild and real data — see `docs/reports/release1-smoke-tests-live-run.md` for the full account (two real dashboard bugs found and fixed live, and a confirmed anti-nuke safety property). Detailed per-slice history lives in `docs/SESSION_LOG.md` (append-only) and `docs/reports/`; this file only tracks where things stand now.

**This host has no production systemd deployment yet.** The daemon has only ever run via `npm run start` or, as of the 2026-08-30 smoke test, `deploy/bananasaurs-test.service` — a unit that runs as the checkout's own owner directly against this repo, deliberately not the hardened `/opt` layout `deploy/bananasaurs.service` describes. Standing up the real production deployment (service account, `bananasaurs-ops` group, `/opt/bananasaurs`, `/etc/bananasaurs/env`) is a real-guild-cutover task per `docs/17_OPERATOR_ACCESS.md` §2, not something Release 1's testing needed.

**The moderation path first ran on 2026-09-12 — on the test guild only.** Read-only inspection of `data/bananasaurs.db` that evening found it still at **migration 5 (`0000`–`0004`) with no automod tables at all** — an earlier version of this paragraph said Release 2's migrations had been applied on 2026-09-02; they had not, and the daemon (pid 2399827, up since 2026-08-30) was still running Release 1 code. All thirteen pending migrations `0005`–`0017` were applied in one `db:migrate` run that evening, after a backup and a restore rehearsal (details in "Release 2 observe window" below). Before that run: no rule existed, no case event existed, no fixture existed, no clock had started — the window starts from zero, verified rather than inferred. Everything below describes code in one of three states; the section on the observe window says which. Keep them apart when you edit this file; see "How to update this file".

**Release 2 is in progress.** These slices are merged to `main` and green:

- **The automod rule engine foundation** (ADR 0035, amended by ADR 0036) — `mod_rules`, exemptions, word categories/terms/allowlist, `mod_cases`, `mod_case_events`, `test`/`observe`/`enforce` modes, the escalation ladder, the `MESSAGE_CREATE`/`MESSAGE_UPDATE` subscriber, and the twelve-value `action_taken` vocabulary. **One predicate: `keyword_filter`.**
- **The `/mod` command surface** (ADR 0037) — timeout, untimeout, kick, ban, unban, warn, purge, note, evidence, history; confirm-then-execute on ban and purge; the bounded `mod_purge` job; six more `action_taken` values.

**The Release 2 scope check is done.** Native AutoMod is configured in the guild with three defaults enabled: block mention spam, block suspected spam content, block commonly flagged words. It does not remove the need for the custom engine — ADR 0035 records why (members with `Administrator` or `Manage Server` are exempt from every native rule, unconditionally and unconfigurably), and the owner cannot inspect native's algorithms because Discord does not publish them.

**Slice 0 — native AutoMod observability — merged 2026-09-01.** ADR 0038 plus six tasks: the `autoModerationAction` domain event and its dedupe fingerprint, the `AutoModerationExecution` gateway intent and translator, four additive `native_*` `action_taken` values with migration 0009, a subscriber that records native's decisions without counting them toward escalation, the end-to-end wiring, and a test asserting native and Bananasaurs cannot double-punish. (An earlier version of this line said Slice 0 was "live". It was not, and is not — see the paragraph above.)

**Slice 1 — the predicate abstraction and `mod_rules.config` carrier — merged 2026-09-01** (ADR 0040). Two-stage `compile`/`evaluate` predicate interface, per-kind Zod config validated on write *and* read, a compiled-artifact cache keyed by a content fingerprint so a term edit takes effect on the next message with no restart, and `doctor` reporting any rule that cannot compile. Also fixed a migration that would have silently emptied every word list and exemption on a future table rebuild.

**Slice 2 — fixtures, the dry-run evaluator, match traces, and a CLI review — merged 2026-09-02** (ADR 0041). `automod_fixtures`, `mod_match_reviews`, stored `MatchTrace`, the one-code-path invariant (the dry run and the live subscriber call the same two functions), and `bananasaurs automod dryrun` / `review` / `verdict`. `PRIVACY.md` gained a retention row in the same commit as the table. **2,148 tests**, typecheck and lint clean. Full record, including nine plan rulings and ten decorative guards found, in `docs/reports/release2-slices-1-6-ledger.md`.

**The blocking permission decision is made — the owner granted `Manage Server` on 2026-09-01.** Discord dispatches `AUTO_MODERATION_ACTION_EXECUTION` only to a bot holding `ManageGuild` (confirmed in discord.js's own source); `docs/18` used to list it under "Deliberately absent," and now records the grant instead. `doctor`'s `REQUIRED_PERMISSIONS` includes it, so a bot missing it now fails `doctor` outright rather than merely being reported as inert. The grant also unlocks Discord's AutoMod REST endpoints, guild-settings edits, integration management, and viewing all invites — Bananasaurs uses none of that; ADR 0038 leaves managing native rules explicitly out of scope. The trade is written up in `docs/18` and in ADR 0038's Consequences, with the outcome appended there.

**Found and fixed: a live bug in the shipped keyword filter (ADR 0039, 2026-09-01).** `obscenity`'s `collapseDuplicatesTransformer` collapses doubled letters in the matched *input* but not in a `parseRawPattern`-compiled term, unless the letter is one of six custom-thresholded ones (b/e/o/l/s/g). So a configured keyword containing any other doubled letter — `spammer`, `forbidden`, `bitter` — sat in the database looking configured and **silently never matched**, in any mode. Fixed by deriving collapse thresholds from each rule's own word list (any letter doubled in a configured term gets threshold 2, unioned with obscenity's six) — see ADR 0039 for the full analysis, why the alternative (pre-collapsing the pattern) was rejected as a false-positive risk, and the resulting trade (adding a term with a new doubled letter slightly relaxes collapsing for that letter, rule-wide). **Consequence, now settled: none.** This would have made any affected rule's observe data worthless — the rule was not actually evaluating the affected term, so a clean-looking false-positive rate measured nothing real. But no rule has ever run (see the top of this section), so there is no data to discard and no clock to restart. The fix landed before the first observation, which is the only reason this cost nothing.

**Slices 3 + 5 — the six stateless predicates — merged 2026-09-03.** No ADR was named for either (spec §9). `regex` (with a hard 25 ms per-evaluation timeout via `node:vm`, because catastrophic backtracking is synchronous and *nothing else in JavaScript can interrupt it* — not `setTimeout`, not an `AbortSignal`, not even vitest's own per-test timeout, all of which lose to the blocked event loop), `invite` and `link_domain` (pattern matching only, relational lists, no outbound resolution), `caps`, `emoji` and `attachment_type`. Also OD-3's attachment corpus (`automod_fixture_attachments`, with `PRIVACY.md` updated in the same commit as the migration), two relational list tables, and four CLI commands so an operator can actually populate them. **Seven of the ten predicate kinds now have an implementation**; the three absent are the window tier. **2,267 tests**, typecheck and lint clean. Whole-branch reviewed (SHIP-WITH-FIXES: 2 CRITICAL, 8 IMPORTANT), two fix waves, and the re-review's two residuals fixed. Full record — nineteen commits, ten plan rulings PR-10…PR-19, four more decorative guards, and both CRITICALs traced to the coordinator's own errors — in `docs/reports/release2-slices-1-6-ledger.md`.

**None of this has evaluated a message.** The six predicates are merged and green. **No rule of any of the six new kinds exists anywhere** — `createRule` still has exactly one production caller, the seeded `keyword_filter`, and `setRuleMode` has none. So these predicates are code that compiles and is tested, not code that has judged a real message; the creation surface arrives with the dashboard (Slice 8) and flip day is what starts any clock.

**Slice 4 — the window tier — merged 2026-09-04.** No ADR named (spec §9). `mention_spam` (stateless, despite the tier grouping), `rapid_spam` and `duplicate_message`, plus `window.ts` — a bounded, guild-scoped sliding-window store, **the first state any predicate on this project has carried**. In-memory by owner decision: a restart resets the window and that is accepted and documented, because the escalation counter is durable in `mod_cases` either way and the alternative costs a write per evaluated message per windowed rule on a single-writer SQLite database. **All ten predicate kinds `mod_rules_kind` permits now have an implementation.** Also closed the one-code-path gate's last two blind spots — a wrong replay clock and a bypassed predicate cache were both invisible to it until window state existed. **2,312 tests**, all gates green by exit code.

**Slice 6 — cutover tracking, observe-window gating, automod testing mode — merged 2026-09-06** (ADR 0042, plus two amendments). Nine additive columns across three migrations — the split is load-bearing and ruling PR-32 records why: SQLite cannot add a CHECK to an existing table at all, so 0015 and 0016 add the columns plain and 0017 rebuilds `guilds` and `mod_rules` to attach the CHECKs, whose `INSERT … SELECT` is valid only because the earlier two put every column there first. `enforcementEligibility` is now the single gate in front of `mode = 'enforce'`, checking state, then the low-volume floor, then a zero bar for counter-feeding rules, then the 5% rate for delete-only ones; `setRuleMode` owns four of PR-27's five state transitions and returns a refusal rather than `void`. Plus `counts_as_violation` reaching the subscriber, `automod_testing_mode` as a third lever deliberately kept **off** `ModerationSafetyState` so it cannot gate moderation (PR-33), two new `doctor` checks, and `automod ready` / `automod signoff`. **2,388 tests**, all gates green by exit code.

Two things a reader should not have to dig for. **A delete-only rule could time out or kick a member**: `counts_as_violation: false` stopped the counter advancing but the subscriber still read it, so a rule matching someone already on a tier earned by other rules escalated anyway — which falsified the premise ADR 0042 §4 grants the 5% tolerance on, since that tolerance exists *because* removing the message is the rule's only consequence. And **`automod signoff` called an empty corpus a clean pass**, because its three conditions are all absences that an unlabelled corpus satisfies vacuously; the sign-off is the only thing that clears the low-volume floor, so a rule could have reached enforcement having been judged against nothing. Both were caught by the whole-branch review, not by the gates. Full record — ten plan rulings PR-26…PR-35, two decorative guards (running total eighteen), and a re-review whose four findings were three-quarters defects in the fix wave itself — in `docs/reports/release2-slices-1-6-ledger.md`.

**Release 2 observe window — started by hand on both guilds, 2026-09-12.** The owner chose the by-hand route over building Slice 11 first (the alternative in `docs/reports/release2-slice-6-handoff.md`). What was done, in order, with the daemon stopped for every database write: on-demand backup `backups/bananasaurs-20260913T022534283Z.db` (sha256 `0c578b7c…46d2`, sidecar verified, `integrity_check` ok); `restore` and `db:migrate` both confirmed to *refuse* while the daemon held the lock; a restore drill into a scratch path with all thirteen migrations rehearsed against the restored copy (5 → 18, no FK violations); then the live database migrated 5 → 18, `integrity_check` ok, existing rows intact. The daemon was restarted on the freshly built `a25a5b2` so it would seed the default rule, stopped again, and one statement run against the guild-scoped row: `UPDATE mod_rules SET mode='observe', cutover_state='observing', observe_started_at=1789266853841, updated_at=1789266853841 WHERE guild_id='1540816150026518620' AND rule_id='default-word-filter' AND cutover_state='not_started'` — the same four columns `setRuleMode` writes for this transition, which writes no audit row either, so the hand-set row is indistinguishable from the function's. **`observe_started_at = 1789266853841` = 2026-09-13T02:34:13.841Z (2026-09-12 19:34 PDT). The two-week floor (`OBSERVE_WINDOW_FLOOR_MS`) elapses 2026-09-27T02:34:13.841Z.**

The three states, rule by rule, as the database shows them after the restart:

- `default-word-filter` (`keyword_filter`) on guild `1540816150026518620` (Bananasaurs dev): **actually evaluating traffic** in `mode='observe'`, `cutover_state='observing'`, `enabled=1`, clock as above. Zero case events and zero fixtures at the time of writing — nothing has matched yet.
- Every other predicate kind (the nine from Slices 1–5): **migrated onto the live database** — the tables and CHECK constraints exist — but **no rule of any of those kinds exists**, so none is evaluating anything. `createRule` still has exactly one production caller.
- `automod_testing_mode` on the guild row: `0`. Nothing sets it.
- `default-word-filter` (`keyword_filter`) on guild `1430056096722194577` (SFU Racerbot Club, 210 members): **actually evaluating traffic** in `mode='observe'`, `cutover_state='observing'`, `enabled=1`. **This is the window the Release 2 gate is written against.** The owner added the guild ID to `BANANASAURS_GUILD_ALLOWLIST` and invited the bot the same evening; the daemon seeded the rule at the 02:47Z restart (while still `allowlisted-but-absent` — seeding keys off the allowlist, not membership), the bot joined, and with the daemon stopped the same one statement was run for this guild: **`observe_started_at = 1789267797656` = 2026-09-13T02:49:57.656Z (2026-09-12 19:49 PDT). Floor elapses 2026-09-27T02:49:57.656Z.** Guild row `dry_run=1`, `automod_testing_mode=0`. Zero case events and zero fixtures at the time of writing.
- `/mydata` and `/forgetme` were recorded as a precondition on pointing the allowlist at the real server (Phase 4b paragraph below). The owner pointed it there anyway on 2026-09-12; they are now **owed**, not deferred — real members' messages that match will be captured as fixtures from tonight on.

Both doctors after the restarts report `PROBLEMS FOUND` for one reason unrelated to the window: **`MISSING PERMISSIONS: BanMembers, ManageMessages`** on the dev guild and **`BanMembers, ManageMessages, UseApplicationCommands`** on the club guild — Release 2's `REQUIRED_PERMISSIONS` grew and the bot's role was never updated. Observe mode never touches Discord (`subscriber.ts` records `would_delete` only), so the window runs regardless, but the socket doctor's four automod lines were all green: every enabled rule compiles, every enforcing rule's `cutover_state` permits it (none enforce), and no observing rule is past its window with a backlog. Also pre-existing: one deleted role `1543350960577974323` reported unassignable.

**The gate is still undriveable from the CLI, and that is not an oversight.** Nothing in code writes `cutover_state = 'observing'` or `automod_testing_mode`: `setRuleMode` still has no production caller and there is no `automod mode` command. The spec assigns driving the state machine to Slice 11 ("under owner decision, not a timer") and displaying it to Slice 8's cutover board. **Nothing can reach `mode = 'enforce'` at all this release**, which is the safest state available — but a cutover cannot be completed from the CLI, and flip day needs Slice 11 before it can finish. `automod ready` *can* now succeed for either rule once its floor elapses, since the row is in `observing` with a non-null clock.

Whole-branch reviewed **SHIP-WITH-FIXES with 3 CRITICALs, all confirmed by running the built code** and all traceable to the plan: `duplicate_message` never fired if the member said anything between repeats (a false analogy with `rapid_spam`'s buffer sizing, asserted as settled in a comment); its default configuration made two captionless image posts a match; and a windowed rule's dry-run count is wrong in both directions. The re-review then found a **new** CRITICAL in the fix itself — the fix made every `maxRepeats ≥ 50` unreachable, the same failure at the other end. All fixed. Full record in `docs/reports/release2-slices-1-6-ledger.md`, including what this slice teaches that the earlier ones did not.

**None of this has evaluated a message.** All ten predicates are merged and green. **No rule of any of the nine new kinds exists anywhere** — `createRule` still has exactly one production caller, the seeded `keyword_filter`, and `setRuleMode` has none. The creation surface arrives with the dashboard (Slice 8); flip day is what starts any clock.

**Slice 7 — the application shell — merged to the working branch 2026-09-12** (ADR 0043). Tailwind v4 tokens, `wouter` routing, a left rail with the guild identity, the amber **state strip** that names every active hold (dry run, kill switch, breaker, gateway, read-only, health unknown) and is silent otherwise, and a shared component set (`DataState` with explicit loading/empty/error/degraded, `DataTable`, `Field`, dialogs on Radix, hand-written toasts). The five Release 1 sections migrated with no behaviour change — every request, body and header identical, proven by `pages.test.tsx` and the untouched HTTP route tests. **2,439 tests** (51 new, the dashboard's first), typecheck and lint clean. Built through the `opencode-delegate` plugin with muse-spark-1.3 as implementer and task reviewer; the Opus whole-branch review then found three Important defects all four task reviews had passed (a retained password in the re-auth dialog, cancel surfacing as a failure, the strip silent when health fails), all fixed and re-reviewed. Record: `docs/reports/release2-slices-7-12-ledger.md`, `docs/reports/slice-7-whole-branch-review.md`; plugin findings in `docs/reports/opencode-plugin-evaluation.md`.

**Slice 8 — the Release 2 pages — merged to the working branch 2026-09-13** (no ADR; rulings PR-44..PR-52). Automod rules list with creation, rule detail (status with the enforcement-eligibility sentence, mode with a confirmation that states the state-machine consequence of every transition before it happens, configuration as schema-validated JSON, exemptions, read-only lists, dry run against fixtures), cases and member history, and the cutover board. Underneath: `automod-admin.ts` (guild-scoped admin queries, two-guild tests first), eleven `OpsPorts` members implemented four times, `registerAutomodRoutes` (eight routes; create and mode need a fresh password) and `registerCaseRoutes`. **`setRuleMode`, `setRuleConfig`, `createRule` and the schema are unchanged** — the dashboard wires their first production callers, and the observe clock is untouched. **2,548 tests**, gates clean. The Opus whole-branch review found three Important defects the seven task reviews had passed (the mode dialog silent about `enabled` when both changed — the worthless-window shape; `writeOrThrow` bypassing the 401 mapping; one of seven sentences tested), all fixed and re-reviewed. Record: `docs/reports/release2-slices-7-12-ledger.md`, `docs/reports/slice-8-whole-branch-review.md`.

**Slice 9 — the false-positive review screen — merged to the working branch 2026-09-13** (no ADR; rulings PR-53..PR-65). `/review`: the unreviewed queue oldest first with the fixture's content (or the snippet and an honest note when the message is not held), a native `<details>` trace, three verdict buttons, and a one-click suppression per predicate kind — allow this phrase / invite code / domain, exempt a channel, or "narrow the pattern" for `regex` — each through `ConfirmDialog` with the exact scope stated and an editable value. The tally per rule (false positive / true positive / unclear / reviewed) with ADR 0042 §4's thresholds in one sentence above it; the F3.2 bias warning when native AutoMod has blocked messages and an overlapping rule kind is in view; a separate native-hits table. Underneath: three guild-scoped storage queries, three `OpsPorts` members implemented four times, `GET /api/automod/review`, the verdict route and the suppress route. **A suppression writes nothing to `mod_rules` and preserves the sign-off (PR-59, now asserted per kind); `recordVerdict`, `setRuleMode`, the schema and the observe clock are untouched.** **2,602 tests**, gates clean. The Opus whole-branch review found three Important defects the four task reviews had passed, each needing a read outside the diff: a domain "allowed" on a deny-mode rule wrote a row the predicate never reads (now removed from the deny list instead, PR-62); the prefill was the matched span, not the value the route accepts (now the trace's `matchedOn`, PR-63); allowlist phrases stored with any uppercase letter could never match, because obscenity lower-cases the input (now canonicalised, PR-64). One Minor deferred (PR-65: a verdict can be recorded on a `manual` event id). Record: `docs/reports/release2-slices-7-12-ledger.md`, `docs/reports/slice-9-whole-branch-review.md`. Tooling: the opencode free tier ran out for ~9 hours mid-slice; Task 2's tail and Task 3 ran on sonnet with the same briefs, everything else on muse-spark-1.3 — `docs/reports/opencode-plugin-evaluation.md` D34–D38.

**Slice M1 — archive schema, ingestion, retention — merged to the working branch 2026-09-13** (ADR 0046 with Amendment 1; rulings PR-66..PR-79). Four `archive_*` tables under the guild partition key; a live subscriber after automod that records creates, edits, deletes and bulk deletes; a resumable backfill job (one page per run, cursor persisted before the successor is enqueued); a three-tier expiry job produced by a daily timer; five `archive …` operator commands; two `doctor` checks; five new `PRIVACY.md` rows in the migration commit. **Nothing is archived by default and the club guild cannot be enabled at all**: a row is written only if the guild is in `BANANASAURS_ARCHIVE_GUILDS` (empty by default — the `/mydata`/`/forgetme` precondition, enforced by absence), the channel is in `archive_channels`, and the channel is not in `log_excluded_channels`. All three vetoes are checked on both write paths and tested in both directions. **No attachment bytes are fetched anywhere (PR-67)** — the policy column and CHECK ship, `--attachments bytes` is refused until a later slice builds the fetcher behind a host allowlist. `mod_rules`, `mod_cases`, the automod subscribers and the effect gateway are untouched; the archive reads `mod_cases` for the case-retention tier and writes nothing there. **2,717 tests across 144 files**, gates clean. The Opus whole-branch review found a **Critical** the six task reviews passed: the backfill's continuation was keyed the same as its own still-running job row, so `jobs_dedupe` silently refused it and a channel over 100 messages would have backfilled one page and stopped — the exact hazard `packages/core/src/mod/purge.ts` documents and avoids. Fixed with purge's two-shape key and a real-queue test, plus three Important (the backfill honoured one veto of three; a deleted row with NULL content never purged, keeping attachment filenames; a closed case with no events never expired). Record: `docs/reports/release2-slices-7-12-ledger.md`, `docs/reports/m1-whole-branch-review.md`.

**Slice M2 — FTS5 search and permission-filtered citations — merged to the working branch 2026-09-13** (ADR 0049 with Amendment 1; rulings PR-80..PR-89). `archive_messages_fts`, an external-content FTS5 index over `archive_messages` kept in sync by three triggers, created by **the project's first hand-written migration** — drizzle-kit cannot generate a virtual table and an FTS5 table cannot be `STRICT`, so ADR 0049 records the bounded exception and what replaces the schema-level guard. `searchMessages(scope, …)` is the project's only raw-SQL repository function: its hits and count queries share one `WHERE`, so a channel outside the caller's visibility set contributes to neither the citations nor the total; the visibility set is built from the guild's archive-enabled channels and never from caller input. Plus `findMessage` (the tombstone reader ADR 0046 D6 promised), `archive search` and `archive reindex --confirm`, an `archiveIndexHealth` check in `doctor`, and a restore note in `docs/SMOKE_TESTS.md`. **2,755 tests across 145 files**, gates clean.

Two findings worth remembering. The plan review asked whether `PRAGMA table_list` even reports a virtual table as a `table` — it does not (`virtual`/`shadow`), so the exemption ADR 0049 originally designed would have been dead code guarding nothing, and Amendment 1 replaced it with three positive tests. And the Opus whole-branch review found a **merge blocker**: the migration created the index but never populated it, so on a database that already held rows — a restored backup — search returned nothing *and* the triggers then raised `database disk image is malformed`, which would have aborted every retention purge from then on. Reproduced independently before fixing; one `'rebuild'` statement closes all three failure modes, and a migration test seeded at 0019 pins it. Record: `docs/reports/release2-slices-7-12-ledger.md`, `docs/reports/m2-whole-branch-review.md`.

**Slice M3 — the OAuth 2.1 authorization server — merged to the working branch 2026-09-14** (ADR 0045 with Amendments 1 and 2; rulings PR-90..PR-134). Four instance-level tables, an OAuth 2.1 provider with PKCE S256, six Fastify routes, a server-rendered consent page, a bearer guard with the RFC 9728 challenge, five operator commands, and a conformance test driven by the MCP SDK's own client — the SDK is a **devDependency only**, with zero non-test imports. **157 files / 2,949 tests**, gates clean on the merge. **`MCP_PUBLIC_URL` is unset by default and the OAuth routes are not mounted without it**, so the observe-window guilds are untouched until the owner opts in.

Three findings worth carrying. ADR 0045's D6 promised that revoking a dashboard account revokes every token it approved; the whole-branch review found it **false in two directions at once** — nothing in the tree can disable or delete an account (no route, no CLI, no repo function), and the one lever that does exist, revoking `mcp.authorize`, did not stop a **refresh rotation**, so a session renewed itself for thirty rolling days. Second, a replayed refresh token revoked its descendants but not the sibling access token minted beside it, sparing exactly the token a leak exposes; revocation is now by lineage (`issued_from_code_hash`, inherited on every rotation), never by descent. Third, `touchToken` on the bearer success path made the guard return 503 under `BANANASAURS_READONLY` while an invalid token got 401 — an oracle, and unusable in the mode M4's read tools need. Record: `docs/reports/release2-slices-7-12-ledger.md`, `docs/reports/m3-whole-branch-review.md`.

**Slice M3b — dashboard account disable, enable, delete — merged to the working branch 2026-09-15** (no ADR; ADR 0045 Amendment 3). Four operator commands — `account list`, `account disable`, `account enable`, `account delete` — over four repository functions — `setAccountDisabled`, `deleteAccount`, `countEnabledOwners`, `listAccounts` — wired through `OpsAccount` with the writes behind `--confirm`. `deleteAccount` revokes the account's live OAuth tokens and deletes its unexchanged authorization codes in the **same transaction** as the account row delete. That revoke is not a redundant belt over `verifyAccessToken`'s `account-gone` check — it is what actually refuses the next request, because it lands first and the account-lookup branch never executes. Two things fell out of breaking the guards rather than reading them, and A3-2 was corrected to match: the `account-gone` branch is unreachable through `deleteAccount` and is pinned instead by a test that deletes the row with raw SQL, and removing that branch is a **500, not a bypass** — `verifyAccessToken` reads `.disabled` off `undefined` and throws. The in-transaction revoke earns its place for the reason A3-2 always gave: `oauth_tokens.account_id` carries no foreign key, so without it `mcp tokens` would keep printing dead tokens as live for up to thirty days. Neither `disable` nor `delete` guards the last owner (A3-3): a disable is undone with `enable`, and deleting the last account is the recovery path `bootstrap reissue` documents, so a guard would make that recovery unreachable — both warn instead. **3,001 tests across 157 files**, gates clean. **ADR 0045 D6 now has a trigger at both ends** — revoking the capability stops the next mint, disabling or deleting the account stops the current one on the very next request, proven by five tests driving the real OAuth routes — while the obligation M3 handed M4 is **unchanged**: `requireBearer` still returns 200 with an empty reachable guild set for an account that merely lost its capability, so every M4 tool must refuse on empty and intersect against it. Known gap, with the owner: `disable` is a pause, not a rotation — re-enabling restores every session and token intact, and no command in this release rotates a password or ends sessions without deleting the account. Merged and green; nothing in this slice has run against the live daemon.

**Slice M3c — `account revoke-credentials` — merged to `main` 2026-09-16**
(no ADR; ADR 0045 **Amendment 4**, A3-5/A3-6/A3-7). The rotation M3b's review
showed was missing: `disable` writes one column and both guards are live
re-reads, so everything stops *while* an account is disabled and `enable`
hands every credential back intact — correct, and what proves nothing is
cached, but not a rotation. `bananasaurs account revoke-credentials
<username> --confirm` ends every live dashboard session across every guild
the daemon serves, revokes every live OAuth token, and deletes every
unexchanged authorization code, leaving `disabled` alone. So disable pauses,
revoke-credentials rotates, both together mean locked out *and* rotated.
**3,018 tests across 157 files**, gates clean on the merge.

The finding worth carrying forward, because it corrected a ruling made in
this repository three days earlier: **"every token the account owns" is not
"every credential the account owns."** Ruling M3c-R2 said revoking by
`account_id` covers every lineage, which is true of tokens and was applied to
a credential class it never considered. An unexchanged authorization code is
a token that has not been minted yet, and `exchangeCode` gates on the code's
expiry and on `approver.disabled` — the one column this command deliberately
does not touch — so for up to the 300 s TTL after the operator was told every
credential was gone, a leaked code still minted a fresh pair. Reproduced by
running the real `exchangeCode` after a real revoke, and now pinned by an
end-to-end test through the real OAuth routes with the clock unmoved, so its
refusal proves the revoke and not expiry. Gutting the code deletion makes
that test fail with `expected 200 to be 400`. Two more Important findings
went with it: a session sweep with no `revoked_at IS NULL` guard, which
**overwrote the timestamp recording when an attacker's session actually
ended** with the time of the operator's own second command; and `docs/17`
saying "four `account` commands" when there are five — the M3b finding
replayed for the command added after it was fixed.

**Still not rotated: the password.** `accountRepo.setPasswordHash` has no
production caller, so an attacker who knows the password signs in again after
a revoke and gets fresh credentials; `account disable` or `account delete` is
the answer, and `docs/17` says so. And the sweep is over the guild allowlist,
so a dashboard session in a guild since dropped from
`BANANASAURS_GUILD_ALLOWLIST` is not swept, though every data route then
fails closed.

**Slice M4 in progress — Tasks 1–6 and 7a done, on the branch, not merged;
one task left.** `oc/m4-mcp-read-tools` is fifty-two commits and green
(typecheck 0, lint 0, 167 files / **3,139 tests**, verified green with
`packages/mcp/dist` absent). It now holds the whole read surface: the server
at `/mcp` behind the bearer guard; `get_health`; the three archive tools
(`search_messages`, `read_channel_history`, `get_message`) with a visibility
set built from archive-enabled channels that a caller argument can narrow but
never widen, and purged content returned as tombstones; the three
Discord-cache tools (`list_channels`, `list_roles`, `list_members` — the last
a REST fetch, never the 50-entry member cache, which would have silently
truncated the club guild); the four records tools and the overview resource,
sharing one card builder and guarded independently; and the
`provider_eligibility` table with its seeded row — `trains_on_input: 'no'`,
reviewed 2026-09-14, the date the owner confirmed it — and the `PRIVACY.md`
row in the same commit as the migration. **What remains is Task 7b**: the
`doctor` warning past 90 days as an `OpsInstance` member, plus two Minors.
Then the whole-branch review and the merge.

Paused because the opencode provider **stalled** — 500 s of silence with a
155-byte log, the shape that has preceded each `FreeUsageLimitError` — after
the host's memory watchdog had killed Task 7 four times at `tsc --build
--force`. Nothing was lost to any of them; every step commits.

Two findings from this stretch worth carrying. **Three "works in tests,
broken in the daemon" defects shared one cause**: the tests construct the
composition themselves and can supply what production does not — the
git-ignored `dist/` a fresh clone lacks, an archive port made optional, a
discord.js client made optional. Each was caught by an implementer stopping
at its file boundary and flagging, not by a gate; the fixes made each thing
**required** so the compiler refuses the daemon without it, and each
proof-test goes through the real `buildDashboardApp`. And **`message_id` is
TEXT**, so `ORDER BY message_id` was a string sort — chronological only for
equal-length snowflakes, which Discord crossed in mid-2022 and the backfill
reaches; now ordered by digit count then value (ruling M4-D9), pinned by a
mixed-length test watched failing first.

**ADR 0044 was corrected three times during Task 1 alone, all from one root
cause, and the implementer found two of them.** The SDK promotion was
recorded as "six packages", then measured at 84, then measured properly at
**82**; the "zero heavy packages load into the daemon" headline turned out to
be **false for `ajv`**, which loads 126 modules from the SDK's own nested
`node_modules`; and the guard written to defend that claim could not fire for
`ajv` at all. Every one of the three came from asking
`require.resolve('ajv')` at the repo root, which finds the **hoisted ajv 6**
that eslint brings in and that nothing ever loads, rather than the nested
**ajv 8** the SDK actually loads. **A package name is not an identity; a path
is.** The seven that matter — `express`, `hono`, `cors`,
`express-rate-limit`, `cross-spawn`, `eventsource`, `jose` — do stay out, and
that is the property the guard exists for; `ajv` is accepted, because it is
pure computation and our own boundaries are still Zod, including every
incoming tool call's arguments. The test now asserts `ajv` **is** loaded and
that it comes from the SDK's nested copy, so the exception is pinned by the
suite rather than by a paragraph.

**Slice M6's live run is done — `docs/SMOKE_TESTS.md` Section D, run
2026-09-20, all ten steps pass.** The record with timestamps and evidence is
`docs/reports/mcp-m6-live-run.md`. The connector works end to end over the
real tunnel and real Cloudflare Access from the Claude desktop app, claude.ai
and Claude Code. Four things were confirmed from the server side rather than a
client's rendering: `@everyone` in a sent message produced
`mention_everyone: false` in Discord's own message object, so the
`allowedMentions` fix survives the REST adapter; the consent POST arrived with
`Host` and `Origin` both `bananasaurs.sighton.ca`, so no Host rewrite is set
on the tunnel route; a replayed idempotency key produced exactly one Discord
message, checked against the archive; and the call after `mcp revoke` was
refused with the daemon naming the token id and `reason: "revoked"`.

**Two configuration facts blocked the run and are worth carrying.**
`BANANASAURS_ARCHIVE_GUILDS` was **empty** — no guild in archive scope,
including the club — so the archive subsystem was entirely inert and
`search_messages`, `read_channel_history` and `get_message` had never been
exercised against real data; their empty results were correct-by-construction
and proved nothing. That is config drift against ADR 0046 Amendment 2 as
recorded here and in `packages/core/src/config/schema.ts:55-62`, not a bug.
A contributing cause: the variable **appeared nowhere in `.env.example`**,
which this run fixed. The dev guild is now in archive scope by owner decision
(two channels, 75 messages, FTS in sync); **the club deliberately is not** —
that ingests 269 real members' messages and should be its own act. And
`BANANASAURS_DRY_RUN=1` makes the MCP send path record `outcome: 'dry_run'`
and post nothing (`message-gateway.ts:299`), so steps 5–7 required dry run
off; the club was covered by its per-guild killswitch meanwhile, and both were
restored at the end.

**Four findings remain open**, in fix order: the refusal text at
`packages/mcp/src/tools/send.ts:171` suggests `mcp allow-channel` without
`--guild` and so fails verbatim on this two-guild instance (Minor, one
interpolation); **MCP read tools write no audit row and emit no log line**, so
a connector that can read archived member messages, moderation cases and the
audit trail leaves no server-side trace of what was read, and no ruling exists
either way — this is the one worth a decision rather than a patch; OAuth
client registrations accumulate with only `mcp revoke-client` to prune them;
and the club guild's archive scope question is still open.

**Next action: deploy the automod switch (ADR 0121) — see below.**
As of 2026-09-19 `main` is `1b8d579`, 175 files / 3,414 tests, with M4, M5,
M6's code, Slice 10 and Slice 13 all merged. The daemon is up on both guilds
but running a build from 2026-09-17, so **the next `npm run build && sudo
systemctl restart bananasaurs` deploys M6's `doctor` probe, the `Secure`
cookie and all of Slice 13.** No migration is pending; see the 2026-09-17
incident above for why the order matters when one is.

Cloudflare is fully configured: an identity policy on the hostname and a
Bypass application on the six machine paths, with `MCP_PUBLIC_URL` set. The
origin answers `401` with the bearer challenge on `/mcp` and `200` on the
authorization-server document, so **M6's live run (`docs/SMOKE_TESTS.md`
Section D) is unblocked** and is the next thing to do after deploying.

**ADR 0121 — the automod switch replaces Slice 11, 2026-09-30.** After 17
days of reviewing and flagging matches, the owner replaced the staged rollout
with one guild-wide Off / Watch / On switch on the dashboard's Automod tab.
Slice 11 (`worktree-slice-11-cutover`) is abandoned and must not be merged.
Per-rule modes, the observe window, readiness, sign-off, fixtures and dry-run
replay are gone; flagging false positives and "narrow this rule" stay. The
switch starts Off on every guild. Migrations `0100_automod_state` (the column)
and `0101_automod_cleanup` (its CHECK and the removals). Next: deploy in the
order stop → migrate → start, then run `SMOKE_TESTS.md` Section E on the dev
guild, then switch the club to Watch or On.

Slice 13 was not in the original plan. It exists because the owner tried to
log in on 2026-09-19 and found three gaps nothing had caught: no password
reset, a `doctor` silent about whether anyone could sign in, and — the real
one — a dashboard that could not serve a two-guild instance at all, because
`login` correctly refuses `guild-required` while the login page never sent a
guild. The owner was signed in only because `bootstrap` bypasses `login`.

**M6 owes nothing further — the live run happened 2026-09-20 and passed;
see above.** The Cloudflare Access **Bypass** application on the six machine
paths (`docs/17` §2.4) that this paragraph previously recorded as the
blocking owner action is in place and was verified from the wire during the
run: `/mcp`, `/oauth/token`, `/oauth/register` and both `.well-known`
documents arrive at the origin with no `Cf-Access-*` headers, while
`/oauth/authorize` arrives carrying `Cf-Access-Authenticated-User-Email`.
Both applications are scoped correctly.

**Phase 4b — the MCP operator server — decided 2026-09-12, not yet started.** The owner wants his own Claude clients (Claude Code, the desktop app, claude.ai) to read the club server — channels, roles, members, archived messages, cases, audit — and post to allowlisted channels, over a Cloudflare Tunnel at `bananasaurs.sighton.ca` with OAuth 2.1. That needs an archive, so **R3-1 archive ingestion and R3-2 FTS5 search are pulled forward** from Release 3 into the observe window. Six slices M1–M6, **after Slices 7–9 and before 10–12**; three ADRs 0044–0046; one new dependency (`@modelcontextprotocol/sdk` 1.30.0, MIT). Read-mostly with one write tool; no moderation tools. Design: `docs/superpowers/specs/2026-09-12-mcp-operator-server-design.md` (DRAFT — the owner's six decisions are its §2, the five still open are its §11). Slice plan: `docs/superpowers/plans/2026-09-12-mcp-operator-server-plan.md` (DRAFT). ADR 0046 (accepted 2026-09-13) records the pull-forward and turns the `/mydata`/`/forgetme` precondition into a check: the club guild may not be added to `BANANASAURS_ARCHIVE_GUILDS` until they ship.

**Answered, 2026-09-15 — the rotation command shipped as Slice M3c.** M3b's
whole-branch review found that `account disable` is a **pause, not a
rotation**: both guards are live re-reads, so everything stops while the
account is disabled and `account enable` hands every credential back intact.
The owner's call was to ship the rotation, and
`bananasaurs account revoke-credentials <username> --confirm` now revokes
every live dashboard session, every live OAuth token and every unexchanged
authorization code for one account while leaving `disabled` alone — so
`disable` pauses, `revoke-credentials` rotates, and both together mean locked
out *and* rotated. ADR 0045 **Amendment 4** records it (A3-5, A3-6, A3-7).
`sessionRepo.revokeAllForAccount` now has its first production caller;
**`accountRepo.setPasswordHash` still has none**, so there is still no
password rotation — an attacker who knows the password signs in again after a
revoke and gets fresh credentials, and `account disable` or `account delete`
is the answer to that. A password-reset command needs a delivery story for
the new secret and is not taken here. One more limit worth knowing: the sweep
is over the **guild allowlist**, so a dashboard session in a guild since
dropped from `BANANASAURS_GUILD_ALLOWLIST` is not swept and still
authenticates, though every data route then fails closed.

**Owner decisions — 2026-09-14, at M3's close.** Four answers given at the end of the M3 session, recorded here so they are not re-asked.

1. **Design §11 Q5 is answered: training is disabled** on the Anthropic account that will hold these connectors. §8.4's eligibility row can be recorded truthfully, and M4's first real read is unblocked. The row still has to be *written* in M4 — the answer is not the control.
2. **The MCP SDK becomes a runtime dependency at M4, accepted and documented.** The owner chose the simpler path over the spec's approach B or vendoring the transport. **ADR 0044 says what that buys and what it costs** — the one-line dependency justification `CLAUDE.md` requires is not enough here. **Corrected 2026-09-15, before M4 began: the number in this decision was wrong.** It was recorded as "six transitive HTTP packages" (Express 5, Hono, `cors`, `express-rate-limit`, `ajv`, `eventsource`) — those are the six *direct* dependencies worth naming, not the closure. Measured with `npm ls`, the SDK's transitive closure is **91 packages, 84 of them new here**: the production closure goes from **172 to 256**, up about half, to add one server. One of the 84 is `cross-spawn`, a process spawner, in a project whose hard rule 9 is that nothing may spawn `claude` — it arrives for the SDK's *client* stdio transport, which this code never imports, and confers no capability Node's built-in `child_process` did not already have, but it is audit surface and ADR 0044 now names it. **The kind of trade is unchanged and the decision stands unless the owner says otherwise; only its size was misreported, by more than an order of magnitude.**
3. **`/mydata` and `/forgetme` are on hiatus, and the club guild IS added to archive scope** (revised later the same day; ADR 0046 Amendment 2, ruling PR-135). The owner first said to stop building the commands, then directed that the club guild be archived anyway, on the grounds that another bot in the same server (Carlbot) already retains the same messages — so Bananasaurs adds no new category of exposure, and a local 30-day archive is arguably better than a third party's. D1's precondition is therefore withdrawn. **Everything else in ADR 0046 stands**: the 30-day content purge, the three vetoes, no attachment bytes, and the rule that listing a guild is necessary but never sufficient — a channel must still be enabled one at a time. **`PRIVACY.md` was corrected in the same commit**: it listed both commands in the present tense and said they "exist because they should", which was already untrue and would have been actively misleading about a real archive of members' messages. It now marks them **not built yet**, names the owner as the working route, and says an earlier version claimed otherwise. What reopens this: the club outgrowing "ask the owner", a member asking and not being served, or the archive widening much beyond the first channels.
4. **Account deletion is in scope as its own small slice (M3b), before M4.** The M3 whole-branch review established that nothing in the tree can disable or delete a dashboard account — no route, no CLI command, no repository function; `disabled` is read in four places and written in none outside tests. ADR 0045 D6 promises that revoking an account revokes every token it approved, so until this ships **D6 is a promise with no trigger**. M3b closes that loop: repo functions, `bananasaurs account disable|enable|delete --confirm`, and a test proving a deleted account's live tokens stop verifying on the next request.

**Still owner-side, deferred to M6 by agreement:** the Cloudflare Tunnel, the Access policy in front of the consent page only, and setting `MCP_PUBLIC_URL`. Until `MCP_PUBLIC_URL` is set the OAuth routes do not mount at all, so M3 is inert on the live daemon by construction.

**The wall-clock critical path is the observe window, not the code.** Slices 0–6 exist to reach "flip day" — every rule into `observe` on the same day so their clocks overlap — after which the dashboard work (slices 7–10) and Phase 4b happen *during* the two weeks.

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

8. **Training-eligibility review due 2026-12-13 (noted 2026-09-16).** The `provider_eligibility` row was reviewed 2026-09-14; `doctor` warns once that check is more than 90 days old, so the first re-verification falls due 2026-12-13 — cleared with `bananasaurs provider review anthropic-consumer-mcp --confirm`, which writes the review date, not the row's claims.

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
