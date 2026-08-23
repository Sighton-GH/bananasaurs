# Bananasaurs plan review — 2026-08-22

Reviewed: `README.md`, `IMPLEMENTATION_BRIEF.md`, `AGENTS.md`, `CLAUDE.md`, `MANIFEST.json`, `docs/01`–`docs/15`, `docs/decisions/0001`–`0007`, `config/agent/bananasaurs.system.md`, `branding/BRAND.md`.

Reviewer context assumed from owner answers: all server members are 18+, Claude Code writes most code with the owner reviewing, no hard deadline, stack choice delegated.

---

## Verdict

The plan is feasible and the thinking behind it is unusually good for a project at this stage. The architectural invariants — AI outside the enforcement path, guild scope as a partition key, typed proposed-actions with validation and audit, observe-only defaults — are the decisions that normally get made too late and cost a rewrite. Those are already right.

Three things are wrong, in descending order of how much damage they will do:

1. **Scope.** The documents describe a product that would take a funded team years. Nothing in the plan says what to *not* build, and the milestone gates are written as if all ten will happen.
2. **Two retention/provider decisions are on the wrong side of Discord's Developer Policy** and of ordinary member expectations, and one of them (`free` routing) actively points at the riskiest providers.
3. **About sixteen concrete Discord API and runtime realities are unaccounted for**, several of which invalidate a stated design if discovered late.

Everything below is fixable now, cheaply, because no code exists yet. That is the best possible time to be reading this.

---

## A. Blocking issues — resolve before writing code

### A1. Indefinite retention of deleted messages is not defensible as a default

ADR 0007 and `docs/03` make permanent retention of Discord-deleted content the default, with an owner purge as the only exit.

The problem is [Discord Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy) rule 15: *"Do not use API Data for any purpose outside of what is necessary to provide your stated functionality."* Rule 3 requires respecting a user's decision to opt out of your app. Retaining, indefinitely and by default, content that its author affirmatively deleted, for a stated functionality of "club knowledge assistant," is a hard argument to win. It is a defensible argument for *moderation evidence*, for a *bounded* window, on messages *linked to an actual case*.

The plan already knows the difference — `docs/03` says moderation records are "authoritative operational records, not conversational memories" — it just doesn't apply that distinction to the retention default.

**Fix.** Replace the single "permanent" policy with three tiers:

| Class | Default | Rationale |
|---|---|---|
| Deleted message, no case attached | Tombstone kept forever; **content purged after 30 days** | Enough to investigate, not a shadow archive |
| Deleted message pinned to an open moderation case | Content retained until the case closes + 90 days | Actual evidentiary need |
| Deleted message, owner explicitly marked "preserve" | Indefinite | Deliberate act, audited |

Indefinite-for-everything becomes an explicit per-channel opt-in that requires a posted server notice. Rewrite ADR 0007 accordingly and supersede it (`Status: superseded by 0009`) rather than editing it in place — the plan's own ADR discipline is worth honouring.

### A2. The `free` routing profile points at the providers most likely to violate Policy 21

Developer Policy rule 21: *"Do not use message content obtained through the APIs to train machine learning or AI models (including large language models) unless express permission is granted by Discord."*

Inference is not training, so sending context to a provider is fine **as long as that provider does not train on it**. But most free tiers explicitly reserve the right to use inputs for model improvement. `docs/05` defines a `free` profile that will "use approved zero-cost/free-tier routes" and lists candidates without any no-training screen. As written, the cheapest route is the one that breaks Discord's rules and your own privacy posture simultaneously.

**Fix.** Add a first-class provider attribute, not a note in a doc:

```
trainsOnInput: "no" | "yes" | "unknown"
noTrainingEvidenceUrl: string      // link to the exact ToS/DPA clause
noTrainingReviewedAt: date         // when a human last checked it
```

Then a hard gate in the router: **no archive excerpt, memory capsule, or attachment text may be sent to a provider unless `trainsOnInput === "no"`.** Treat `"unknown"` as `"yes"`. `free` becomes "free **and** no-training," which is a much shorter list — and that is the correct outcome. Providers failing the gate can still serve requests that carry no server content (e.g. a general technical question with no retrieval), if you want that, but it must be an explicit disclosure class, not a fallback accident.

`docs/05`'s existing line "verify against current official documentation during implementation" is not a control. A dated field in the database that the dashboard shows as stale after N months is a control.

### A3. Members get no privacy surface at all

Across 27 documents there is no member-facing privacy notice, no `/forgetme`, no `/mydata`, no way for a member to see what is stored about them, and no opt-out from memory extraction. Every control is an owner control in the dashboard. Meanwhile the default is: archive every channel, keep attachments, keep deleted content forever, and send excerpts to a third-party AI provider.

Even with all-adult members and no strict legal trigger, this is the gap most likely to cause an actual problem in a small club — one member objects, and there is no mechanism and no prior notice to point at.

**Fix — make these Release 1 requirements, not Milestone 6:**

- A pinned notice in the server, generated from live config, stating what is archived, how long, what leaves the server and to whom.
- `/privacy` — prints that same notice on demand.
- `/mydata` — what Bananasaurs holds about the caller, counts and classes, not a dump.
- `/forgetme` — queues an owner-reviewed purge of the caller's conversational memory and non-moderation archive, with a stated turnaround. Moderation cases are explicitly out of scope and the command says so.
- A per-member opt-out from *memory extraction* (not from moderation, not from logging).

This is cheap to build, and it is the part that makes the whole design defensible if anyone asks.

### A4. Two automods enforcing at once will double-punish

`docs/10` says to keep Carl-bot/Dyno enabled until each Bananasaurs module passes its gate. Correct for reaction roles. Wrong for automod: two engines both deleting the same message and both issuing timeouts produces duplicate punishments, duplicate cases, and confused members.

**Fix.** State the rule explicitly: **while the old bot enforces, the new automod is observe-only; cutover is per-rule and atomic — disable the old rule, then enable the new one, never both.** Add a dashboard field per rule recording which legacy rule it replaces and its cutover status.

---

## B. Scope and sequencing — the most likely cause of failure

### B1. The plan describes two or three projects as one

Ten milestones, fifteen dashboard areas, a module runtime with dependencies and migrations, a retrieval evaluation harness, a capability-based permission system, and roughly forty candidate parity modules. Carl-bot and Dyno are the output of teams over years. "Mostly Claude Code" changes the code-writing rate; it does not change the rate at which you can review, test against a live Discord server, and make decisions. You are the bottleneck, and that is the correct place for the bottleneck to be.

`docs/13` is honest that it is "a product backlog, not a promise." The roadmap in `docs/08` is not — it reads as a plan of record.

**Fix.** Restructure as three releases with explicit stop lines, and delete Milestone 9 from the roadmap entirely (it can live in `docs/13` where it belongs). See §E.

### B2. The roadmap builds the least urgent thing first, and builds it without its foundations

Two contradictions:

- `IMPLEMENTATION_BRIEF.md` lists a nine-item first vertical slice that is mostly AI and dashboard, then immediately says automod and reaction roles "should follow immediately after" because they are the current dependency. `docs/12` confirms those two are the real need. The roadmap has AI at M1 and the actual dependency at M2.
- Worse, M1's `/ask` depends on archive (M4), context compilation (M4), memory (M7), and provider routing (M7). At M1, `/ask` will answer from recent channel scrollback and a hand-typed resource list. That is not a useful assistant, and shipping it first sets the tone that the project produces demos rather than working software.

**Fix — reorder so each step replaces something real:**

1. **Reaction/component roles.** Smallest useful module, zero AI, immediately retires a dependency, and it exercises the entire spine you need anyway: gateway events, idempotency, permission checks, role hierarchy, audit, config storage, and one dashboard page. If this works end to end, the architecture is proven.
2. **Logging.** Nearly free once the event pipeline exists, and it gives you observability for everything after.
3. **Automod, observe-only.** Runs for weeks against real traffic while the old bot enforces. You get a real false-positive rate before anything is at stake.
4. **Moderation cases and explicit commands.**
5. **Archive and retrieval.** Now there is history worth searching.
6. **AI on top of a real archive.** `/ask` is useful on day one because the archive exists.

The AI is the part you want most. It is also the part that is worthless without the archive underneath it. Build the floor first.

### B3. The dashboard is specified as a product before anything works

`docs/06` is the longest document and describes an enterprise admin suite: fifteen areas, a command palette, a context simulator, a test console, a golden-question runner, an evaluation trend view. Its own closing line — "do not turn the first dashboard into a generic enterprise admin suite" — is contradicted by everything above it.

**Fix.** Release 1 dashboard is **one page**: health, the config editors for the two live modules, an audit log table, and a kill switch. Everything else in `docs/06` moves to a clearly-marked "later" section. Rename the doc `06_DASHBOARD_TARGET.md` so nobody, including Claude Code, mistakes it for a Release 1 spec.

### B4. `docs/12` still has three unanswered questions, one of which blocks the reuse plan

The license question blocks `docs/11` from being actionable at all — you cannot evaluate whether to borrow from YAGPDB until you know what you are releasing under. Decide it now (recommendation in §F), because the answer also constrains what Claude Code is allowed to look at.

---

## C. Technical realities the plan does not account for

These are the things that cause rework when found late. Each one is a small addition to the plan now.

**C1. Discord attachment URLs expire.** Since late 2023, attachment CDN links are signed (`ex`/`is`/`hm`) and expire in roughly 24 hours; expired links must be refreshed via the API (`/attachments/refresh-urls`) or by refetching the message. `docs/03`'s "metadata-only mode" therefore produces a **dead archive** — you keep a URL that stops working tomorrow. Decide per channel: download the bytes, or store nothing but a note that the file existed. There is no useful middle. Store a content hash for deduplication while you are there.

**C2. Bulk message deletion is limited to messages under 14 days old, 100 per call.** Older messages must be deleted one at a time under rate limits. `/mod purge` over a large range is a durable background job with progress reporting and a cancel button, not a slash command that returns. `docs/04` says "bounded cleanup with preview where practical" — make the bound explicit and make the job model explicit.

**C3. Timeouts cap at 28 days.** The duration parser must clamp or reject, and the dashboard must say so, or you will ship a `/mod timeout @user 60d` that silently fails.

**C4. `MESSAGE_DELETE` does not tell you who deleted the message or why.** Attribution requires polling the guild audit log and fuzzy-matching by target and timestamp; it is best-effort, delayed, and sometimes wrong (self-deletions produce no audit entry at all). ADR 0007's "known actor/reason metadata" must be labelled *inferred, frequently absent* everywhere it surfaces, or the moderation UI will lie.

**C5. Reconciling actions taken directly in Discord has the same problem, plus pagination and delay.** `docs/10` lists "reconciliation with actions taken directly in Discord" as a Priority A feature. Treat it as an eventually-consistent background reconciler that writes records flagged `source: discord_audit_log (inferred)`, never as authoritative case data.

**C6. Privileged intents.** You need `MESSAGE_CONTENT` (automod, archive) and `GUILD_MEMBERS` (reaction roles, join rules). As of June 2026, Discord's review threshold is based on unique users who can see the app — reported at around 10,000 — rather than the old 100-server line; a 30-member club is far below it and can self-enable in the Developer Portal. **Verify this yourself in the portal before building** — the threshold changed recently and blog coverage is not authoritative. The separate 100-server *verification* requirement is unchanged and irrelevant to you.

**C7. Interaction timing is a hard constraint on every AI command.** Three seconds to acknowledge an interaction, fifteen minutes for follow-ups. Every AI path must `deferReply()` immediately, then edit. "Streaming" to Discord means throttled message edits — realistically no more than about one edit per second, and each edit is a REST call against a rate limit. Resolve `IMPLEMENTATION_BRIEF.md` item 6 as: *defer, then progressive edits on a throttle, with a final edit carrying citations.* Not true token streaming.

**C8. Duplicate gateway events are guaranteed, not hypothetical.** Reconnects replay. The plan says "idempotent" in six places without a mechanism. Make it concrete: a unique index on `(guild_id, discord_event_id)` for ingestion, and a `dedupe_key` column with a unique constraint on every side-effecting job row. Write it into the architecture doc so Claude Code implements it once rather than five inconsistent times.

**C9. Role hierarchy will silently break your reaction roles.** The bot can only manage roles below its own highest role and can never act on the guild owner. Someone reorders roles in the UI six months from now and every panel stops working with a confusing error. Add a periodic self-check that verifies, per managed role, that the bot can still assign it, and surfaces a dashboard alert plus a log line when it cannot.

**C10. Backfill must be a single throttled resumable worker.** Global limit around 50 requests/second with per-route buckets; 100 messages per history request. Two dozen channels of history is very achievable — but only as one worker with a persisted cursor per channel, not parallel fetches. Store the cursor so a restart resumes rather than restarting.

**C11. The 512 MB budget and local embeddings contradict each other.** `docs/15` targets ~512 MB steady state; `docs/03` and `docs/14` prefer local embeddings. A MiniLM-class ONNX model plus runtime is typically 150–400 MB resident. Both cannot be true on the old Mint box. **Recommendation:** ship lexical search (SQLite FTS5) only in Release 1 and 2; make embeddings an explicitly optional, off-by-default module with its own documented memory cost, added only after you have measured that lexical search is insufficient on real club data. Update `docs/15` to say this rather than leaving the conflict for the implementer to discover.

**C12. The plan never names a database, and the concurrency model matters.** SQLite is the right answer (see ADR 0008). But with a background ingestion writer plus interactive reads you must run in WAL mode with a single-writer discipline and a busy timeout, or backfill will throw `SQLITE_BUSY` at your slash commands. That is a one-line config decision that is very expensive to retrofit as a concurrency bug.

**C13. Prompt injection has a policy and no mechanism.** `docs/07` and the system prompt both say retrieved text is untrusted evidence. Nothing says how. Add three concrete controls: (a) all retrieved content is wrapped in a delimited, labelled envelope with a fixed preamble; (b) a turn whose only new input is retrieved text may not emit a tool call — tool calls require user intent in the current turn; (c) at least three injection cases in the golden question set, with a cross-guild disclosure or unauthorised retrieval treated as release-blocking, which `docs/14` already says.

**C14. Secrets handling is unspecified in practice.** On one Mint box: a root-owned `.env` at mode 0600 loaded via systemd `EnvironmentFile=`, never in the repo, never in the config export, never in a diagnostics bundle. Add the redaction requirement to the diagnostics bundle spec in `docs/08` M10 — it is mentioned there but not defined.

**C15. Dashboard authentication is not specified anywhere.** Recommendation: Discord OAuth2 (`identify` + `guilds`) with the owner's user ID allowlisted at first. It gives you login, identity, and live role membership from one integration, which is exactly what the capability-mapping model in `docs/06` needs.

**C16. Citations can leak the existence of hidden content.** `/find` and `/ask` return Discord message links (`https://discord.com/channels/{guild}/{channel}/{message}`). If the archive contains a channel the *asker* cannot see, a citation reveals that the message exists even if the content is withheld. Permission-filter citations and source lists, not just content. `docs/14` implies this; make it an explicit test case.

---

## D. What is good — protect these through any rewrite

Listing these because a scope cut is where good decisions usually get thrown out with the bad ones:

- **ADR 0002 (AI never in the enforcement path).** The single most important decision in the plan. Never soften it, no matter how convenient a "just let the model decide" shortcut looks at 1am.
- **Guild scope as a mandatory partition key enforced at the repository layer**, not a filter callers remember to add.
- **Catalogue → capsule → evidence progressive disclosure** (ADR 0003). This is the right shape for a memory system and most projects get it wrong by stuffing everything in the prompt.
- **Observe-only defaults, per-rule states, global testing mode, and a kill switch separate from testing mode.** The distinction between "testing" and "emergency disable" is subtle and correct.
- **The typed proposed-action pipeline** in `docs/10`: resolve → authorise → validate → preview → idempotency key → execute → record → audit. Eight steps, each necessary.
- **Recording routing reason and disclosure classes per provider call** without duplicating sensitive prompt bodies into logs.
- **`config/agent/bananasaurs.system.md`** is a genuinely good system prompt — specific, negative-constrained, no persona padding.
- **The ADR habit.** Keep writing them. They are why this review could be specific.

---

## E. Revised release plan

Replaces `docs/08`. Three releases, each ending in something the club actually uses.

### Release 1 — "Bananasaurs replaces the reaction roles" (no AI whatsoever)

- Repo, migrations, config validation, structured logging, CI, test harness, systemd unit.
- Discord connection, one-guild allowlist, `GUILD_CREATE` on any unconfigured guild → log and leave.
- Event pipeline with the dedupe mechanism from C8.
- Reaction/button/select role panels, with hierarchy validation and the C9 self-check.
- Reconciliation after downtime: missed reaction events, deleted panel messages, renamed/deleted roles.
- Audit log for every role mutation, with before/after state.
- One dashboard page: health, panel config, audit table, kill switch. Discord OAuth2 login, owner allowlisted.
- Privacy surface from A3: pinned notice, `/privacy`.
- Backup and a **tested restore**.

**Done when:** every Carl-bot/Dyno reaction-role panel has been migrated, the old bot's role module is disabled, and a restart plus a deliberate 30-minute outage leaves role state correct.

### Release 2 — "Bananasaurs replaces the automod"

- Rule model, predicates (keyword, regex, invite, link/domain, mention spam, duplicate, rapid spam, caps, attachment type, account age, join age), exemptions, sliding-window counters, escalation.
- Saved-message fixtures and a dry-run evaluator. Human-readable match traces.
- Per-rule `test`/`observe`/`enforce` plus global testing mode plus a separate emergency disable.
- **A mandatory observe-only period per rule** against real traffic, with a false-positive review screen, before enforcement is even offerable.
- Native Discord AutoMod integration where it blocks earlier — do not duplicate it blindly.
- Moderation cases, notes, warnings, timeout/untimeout, kick, ban/unban, bounded purge (as the C2 background job), protected roles, hierarchy checks, mod log.
- Per-rule cutover tracking from A4.
- Message/member/role logging.

**Done when:** every legacy automod rule has a Bananasaurs equivalent that ran observe-only for at least two weeks with an acceptable false-positive rate, cutover happened one rule at a time, and the whole thing works with every AI provider unreachable — because there is no AI yet.

### Release 3 — "Bananasaurs remembers"

- Archive ingestion with the C1 attachment decision, C10 resumable backfill, tiered retention from A1.
- SQLite FTS5 search. `/find` with permission-filtered citations (C16).
- Resource registry.
- Provider abstraction with the A2 no-training gate, one adapter, explicit routing, hard monthly cost ceiling.
- Context compiler with per-section budgets and a recorded disclosure plan.
- `/ask` with citations. Defer-and-edit per C7.
- `/remind`, `/decision`, `/review-plan`.
- Server card and a small reviewed memory set — **hand-curated at first**, no automatic extraction.
- Golden question set including the C13 injection cases and the C16 leak cases.
- Rest of the privacy surface: `/mydata`, `/forgetme`, memory opt-out.

**Done when:** you use `/ask` weekly and it saves you a search.

### After Release 3

Everything else — memory extraction automation, the full dashboard, embeddings, tickets, levels, feeds, public release packaging — is a backlog in `docs/13`, prioritised only when Release 3 has been running for a month. Delete Milestone 9 from the roadmap.

---

## F. Answers to your open questions, and new ones

### `docs/12` "still needed" — recommendations

**Host profile.** Still needed from you. Run this on the Mint box and paste the output into `docs/15`:
```bash
lscpu | head -20; free -h; df -h /; uname -a; lsb_release -a
```

**Public license — recommendation: Apache-2.0.** You want a self-hosted product other clubs can run, you want to be able to accept contributions, and you do not want the copyleft conversation. Apache-2.0 also gives explicit patent grants and is the safest default for a project that will be read by school and university people. **Consequence to write down now:** you may borrow from YAGPDB (MIT, with attribution and license notice), and you may **not** copy from Red-DiscordBot (GPL-3.0) or Zeppelin (ELv2). Read their behaviour, write your own code. Put this rule in `CLAUDE.md` so Claude Code cannot violate it by pasting.

**Backup destination — recommendation: local second disk first, then an encrypted off-host copy.** `restic` or `borg` to a local path, plus a documented (not necessarily implemented) rclone target. Restore drill in Release 1, not Release 10 — an untested backup is not a backup.

### Questions I need answered

1. **Does anyone else have Administrator on the server?** The anti-nuke and protected-principal design depends on the answer, and so does your risk if a privileged account is compromised.
2. **How much Discord history exists?** Rough message count and total attachment size. It changes the backfill design and tells you whether the disk forecast in `docs/15` matters at all.
3. **What exactly is Carl-bot/Dyno doing today?** The parity worksheet in `docs/10` is the right idea but does not exist yet. Screenshot every enabled module and its config before you touch anything — this is the single highest-value hour you can spend, and it is the input to Releases 1 and 2.
4. **Is there a second machine, or is the Mint box also your daily driver?** Affects whether "always-on" is real and whether the restore drill can be practised safely.
5. **What is your hard monthly ceiling for AI provider spend?** A number, not "cheap." It becomes a config value that fails closed.
6. **Do you want members to be able to use the assistant, or is owner-only the long-term state?** `docs/01` says owner-first with later expansion, but the answer changes how much of the capability system is real versus theoretical.

---

## G. Summary of changes to make to the plan documents

| Document | Change |
|---|---|
| `docs/decisions/0007` | Mark superseded; write ADR 0009 with the tiered retention from A1 |
| `docs/decisions/` | Add ADR 0008 (stack — written, see file), ADR 0010 (no-training provider gate), ADR 0011 (license: Apache-2.0) |
| `docs/05_PROVIDERS.md` | Add the `trainsOnInput` gate from A2; redefine `free` as free-and-no-training |
| `docs/03_CONTEXT_MEMORY.md` | Tiered retention; attachment URL expiry (C1); drop embeddings from the default path (C11) |
| `docs/01_PRODUCT.md` | Add the member privacy surface from A3 to first-release scope |
| `docs/02_ARCHITECTURE.md` | Name SQLite + WAL + single-writer (C12); concrete idempotency mechanism (C8) |
| `docs/04_CLUB_BEHAVIOR.md` | Add `/privacy`, `/mydata`, `/forgetme`; note the 14-day/28-day/3-second constraints (C2, C3, C7) |
| `docs/06_DASHBOARD.md` | **Done 2026-08-22.** Renamed to `docs/06_DASHBOARD_TARGET.md`, with the Release 1 one-page scope in a blockquote at the top. The path in the left column no longer exists on disk; it is retained here as the record of what was renamed. |
| `docs/07_SECURITY_OPERATIONS.md` | Concrete injection controls (C13); secrets on disk (C14); dashboard auth (C15) |
| `docs/08_ROADMAP.md` | Replace with the three releases in §E; delete Milestone 9 |
| `docs/10_MODERATION_AUTOMATION.md` | Add the no-overlapping-enforcement rule (A4); label audit-log attribution as inferred (C4, C5) |
| `docs/11_OPEN_SOURCE_REUSE.md` | Record the Apache-2.0 decision and the resulting hard rule: YAGPDB yes, Red no, Zeppelin no |
| `docs/15_LINUX_RESOURCE_BUDGETS.md` | Resolve the embeddings-vs-512MB contradiction (C11); add host profile once measured |
| `CLAUDE.md` | **Done 2026-08-22.** Replaced with the proposed version. `CLAUDE.proposed.md` was the staging filename and no longer exists; the superseded original is kept at `docs/archive/CLAUDE.original.md`. |

---

## Addendum — owner answers, 2026-08-22

Answers received after the review was written, and what changed as a result. Where this addendum differs from the sections above, the addendum is current.

| Answer | Effect |
|---|---|
| Other members hold Discord Administrator | Dashboard auth is **owner-provisioned local accounts**, not Discord OAuth (ADR 0012). Discord permission bits grant nothing in Bananasaurs. Reversed §C15. |
| Owner wants to choose which channels and forums are pulled from | Archive scope is **default-deny** (ADR 0009). ADR 0005 superseded. This also shrinks §A1 and §A3 considerably — a narrow, opt-in archive is far easier to publish and defend. |
| Discord history is small | Backfill is cheap. Storage forecasting in `docs/15` drops in priority. |
| Carl-bot does logging, reaction roles, and some automod; not vital, removable instantly | **Logging joins Release 1.** Cutover risk is low for logging and roles, still real for automod — the no-overlapping-enforcement rule in §A4 stands. |
| Mint box is server-dev only, not a daily driver | Always-on and restore drills are both realistic. |
| Wants free NVIDIA NIM | Clears Discord Policy 21 (reportedly no training on prompts), but the free tier appears limited to development, testing, research, and evaluation. **Development only**, flagged `productionUseAllowed: false` (ADR 0010). Verify against NVIDIA's own terms before relying on it. |
| Wants to use a Claude CLI subscription | **Not available as a runtime provider.** Anthropic's Consumer Terms restrict automated access to API keys; subscriptions grant usage rights to Claude Code and Claude.ai as products, and third-party harness use was enforced against in 2026. The subscription builds the bot; an API key would serve it. The experimental agent-runtime adapter in `docs/05` is cancelled, not deferred. Your original `CLAUDE.md` flagged this exact risk — it was right. |
| Members should get limited features later | Kept as a post-Release-3 tier: search and questions within what the member can already read. Capability model stays, stays simple. |
| Privacy should be proportionate, `/privacy` shows the policy, reference Discord's own terms | `PRIVACY.md` drafted on that basis — plain language, honest about what is stored, points at Discord's Terms and Privacy Policy so members can see the bot is not an outlier. `/mydata` and `/forgetme` kept because they cost little and are the part that makes the rest credible. |

**One thing worth not losing.** "It's not like Discord and other bots don't retain your information either" is true, and the policy says so. It is also the argument every bot operator makes right before they turn out to be the one storing something nobody expected. The reason the policy is worth publishing is not that members will demand it — in a 30-person club they probably won't — it is that writing down what you store forces you to notice when the answer stops matching the code. Keep `PRIVACY.md` and the actual config in sync, and treat a drift between them as a bug.

## Addendum — remaining questions

1. **Anti-nuke posture.** Other members hold Administrator. Should Bananasaurs *detect and alert* on privileged-account abuse — mass bans, mass role deletion, mass channel deletion — or stay out of it entirely? Detection and alerting is tractable. Prevention is not, and should never be promised.
2. **What is your Discord user ID, guild ID, and the intended log channel?** Needed for `docs/09_OWNER_SETUP.md` and the first config file.
3. **Is the Mint box reachable from where you code**, and how — LAN, Tailscale, or neither yet? Determines whether the dev loop runs on Windows against a test guild and deploys to Mint, or runs on Mint directly.
4. **Do the reaction-role panels need to survive as the same messages**, or is it acceptable for Bananasaurs to post new panels and have members re-click? Reusing Carl-bot's existing messages is possible but adds reconciliation work; new panels are much simpler if members will tolerate it.
5. **Monthly AI spend ceiling** — a number.
6. **Backup destination** — second local disk, NAS, or encrypted remote.
