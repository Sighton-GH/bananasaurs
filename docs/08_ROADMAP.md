# Roadmap and acceptance gates

Revised 2026-08-22. Replaces the previous ten-milestone plan, which described more work than one owner-reviewed, agent-written project can finish. Rationale in `REVIEW.md` §B.

Three releases. Each ends with the club actually using something. Work only on the current release.

---

## Release 0 — skeleton

Stack per ADR 0008. Repository layout, migrations, config validation with Zod, structured logging with redaction, CI, systemd unit, and `LICENSE` (Apache-2.0, ADR 0011).

**The fake Discord harness is built here, before any feature.** In-memory gateway and REST simulation covering duplicate events, reconnect gaps, 429s, missing permissions, and role-hierarchy failures. Without it, the owner is the test suite and progress stops. See `docs/16`.

**Gate:** the application starts from documented setup, health is observable, secrets are untracked, `npm run typecheck && npm run lint && npm run test` is green in CI, and the harness can drive a test that fails when the implementation is broken.

---

## Release 1 — replace reaction roles and logging

The two Carl-bot modules the club depends on that carry no enforcement risk. Both are removable at a moment's notice, so cutover is low-stakes.

- Discord connection, single-guild allowlist, restricted discord.js caches per ADR 0008. `GUILD_CREATE` for any unconfigured guild logs and leaves.
- Event pipeline with the deduplication mechanism: unique index on `(guild_id, discord_event_id)`, `dedupe_key` on every side-effecting job.
- **Logging module.** Message edits and deletions, member joins and leaves, role and channel changes, forwarded to owner-configured log channels with per-event routing. Server-wide by configuration, independent of the archive (ADR 0009). Deletion attribution is best-effort and labelled inferred (`REVIEW.md` §C4).
- **Role panels in two kinds**, both in Release 1:
  - **Adopted panels** — attach an emoji-to-role mapping to *any existing message*, including one the owner posted, by message ID. This is how Carl-bot works and it is the primary requested behaviour. Bananasaurs seeds the mapped reactions and watches `MESSAGE_REACTION_ADD` / `MESSAGE_REACTION_REMOVE` on that message. It cannot edit the message text and cannot attach buttons to it, because a bot may only edit and add components to its own messages.
  - **Managed panels** — Bananasaurs posts the message itself, so buttons and select menus are available, along with editable text and ephemeral click confirmations.

  Both support toggle, add-only, remove-only, and single-choice behaviour, with per-panel role limits and required/blocked role checks.
- **Adoption pass.** When a panel is adopted, fetch everyone who has already reacted with each mapped emoji and grant the corresponding roles. The existing reaction state on that message *is* the intended role state; adopting without this pass leaves the two silently out of sync.
- **Partials are mandatory** for reaction panels. Reaction events arrive for messages that are not in the client cache, and ADR 0008 deliberately keeps that cache tiny. Without `partials` for Message, Channel, Reaction, and User, every reaction on an older panel is dropped silently. This is the single most likely cause of "the bot just doesn't respond to my panel," and `doctor` checks for it explicitly.
- **Reaction events can be missed**; button interactions cannot. A reaction added while the bot is offline produces no event on reconnect. Every adopted panel therefore gets a periodic reconciliation that compares live reaction state against granted roles and repairs the difference, bounded by the reconciliation budget.
- Hierarchy validated immediately before every mutation, plus a periodic self-check that each managed role is still assignable.
- Reconciliation after downtime: missed reaction events, deleted panel messages, renamed and deleted roles, and roles removed manually in Discord.
- Audit event with before/after state for every role mutation, batched under a shared batch ID so `bananasaurs undo <batch-id>` can reverse an operation wholesale.
- **Safety controls per `docs/18`**, all of them Release 1, not later: minimum Discord permissions (no Manage Messages, Kick, Ban, or Administrator); a role allowlist so only panel-registered roles can ever be mutated; a global role-mutation rate cap with a circuit breaker that stops and alerts rather than retrying; a reconciliation budget that refuses an oversized change set instead of applying it; `BANANASAURS_DRY_RUN=1` turning every side effect into a log line; and `doctor` refusing to enable a panel whose preconditions fail.
- **Operator CLI** (`bananasaurs`), talking to the daemon over a Unix socket, guild-scoped, `--json` output, `--confirm` on writes, secrets never printed, `BANANASAURS_READONLY` honoured (ADR 0013). `status`, `doctor`, `config get/set`, `panel list/show/sync`, `log routing`, `audit tail`, `jobs`, `killswitch`. This is the debugging surface and the thing Claude Code drives over SSH; see `docs/17`.
- **Dashboard, one page.** Health, log routing config, panel config, audit table, kill switch. Owner-provisioned local login per ADR 0012.
- ~~`/privacy` renders `PRIVACY.md` with live settings substituted.~~ **Dropped from Release 1** (recorded 2026-08-30, WP5 slice 15): Discord requires a posted privacy policy only above 100 servers, and Bananasaurs runs on one. Revisit if that changes; `docs/13` is where it would land as a backlog item until then.
- Backup, and a restore the owner has actually performed.

**Gate:** the safety controls in `docs/18` are demonstrated, not merely present — the circuit breaker trips under deliberate abuse, the reconciliation budget refuses an oversized change set, dry-run performs zero writes, and `undo` restores prior role state. The operator CLI can report status, tail the audit log, and reconcile a panel over SSH. The panels in `docs/RELEASE1_CONFIG.md` are live and clicking a button adds and removes the right role, and Carl-bot's role and logging modules are off. A deliberate 30-minute outage followed by restart leaves role state correct and misses no log events. Duplicate gateway events produce exactly one role change and one audit row. Nobody but the owner can reach the dashboard, verified by trying it from another club administrator's account.

---

## Release 2 — replace automod, add moderation

**Scope check before starting.** The club's automod is Carl-bot defaults, lightly used. Discord's own native AutoMod is free, built in, blocks content before it posts, and covers keyword lists, spam, mention spam, and regex/wildcard patterns without any bot at all. Since the setup is a blank slate, configure native AutoMod directly in Server Settings → AutoMod first and see what is left over.

If that covers all of it — which is plausible — the custom rule engine below is not needed, and Release 2 shrinks to moderation commands and cases. Build the engine only for rules native AutoMod genuinely cannot express. A rule that has never fired does not need reimplementing at all.

What follows is the full engine, for the rules that survive that filter.

- Rule model and predicates: keyword, wildcard, regex, invite, link/domain, mention spam, duplicate message, rapid spam, caps, emoji, attachment type, account age, join age.
- Role, channel, and user exemptions. Sliding-window counters, violation expiry, progressive escalation, per-rule rate limits.
- Human-readable match traces, false-positive flags that narrow a rule from the Review queue page, rule versioning and rollback.
- **One guild-wide automod switch: Off, Watch, or On** (ADR 0121, replacing per-rule modes and observe windows). Off checks nothing. Watch records matches for review and touches no one. On deletes and escalates. Each rule can be enabled or disabled on its own. Every change is confirmed on the dashboard's Automod tab; turning automod up asks for the password again, turning it down never does. The kill switch, dry run and the breaker stay as separate emergency controls.
- **No overlapping enforcement.** The On confirmation says to turn off the matching Carl-bot or Dyno automod first, so two bots never act on the same message.
- Native Discord AutoMod integration where it blocks content earlier; supplement rather than duplicate.
- Moderation cases, notes, warnings, evidence links, permission-scoped history search.
- `/mod timeout` (clamped to Discord's 28-day maximum), `untimeout`, `kick`, `ban`, `unban`, and bounded `purge` as a durable background job — bulk delete only reaches messages under 14 days old, older ones go one at a time under rate limits.
- Protected users and roles, hierarchy checks, per-action capability grants, confirmation policy for high-impact actions.
- Reconciliation of actions taken directly in Discord, flagged `source: discord_audit_log (inferred)`, never authoritative.

**Gate:** automod reaches On via the switch, recorded by an `automod.state_set` audit row. *(2026-09-30, ADR 0121: after 17 days of reviewing and flagging matches, the owner replaced the per-rule observe floor and one-rule-at-a-time cutover with this switch.)* Hierarchy and permission tests pass, duplicate execution is impossible, and every action records actor, target, reason, evidence, timestamps, and outcome. All of it works with no AI configured at all — because at this point there is none.

---

## Release 3 — the assistant

Now there is a spine, real moderation records, and a server worth searching.

*(2026-09-12: the first two bullets — archive ingestion and FTS5 search, minus the member-facing `/find` — are pulled forward into Release 2's observe window as Phase 4b, together with an owner-only MCP server over a Cloudflare Tunnel so the owner's own Claude clients can read the archive and the server's state. See `docs/superpowers/specs/2026-09-12-mcp-operator-server-design.md`. Nothing else in this list moves.)*

- Archive ingestion for owner-enabled channels and forums only (ADR 0009). Resumable single-worker backfill with a persisted per-channel cursor.
- Attachment handling per channel: `none`, `metadata`, or `bytes`. Bytes are downloaded at ingest because Discord CDN URLs expire in roughly 24 hours (`REVIEW.md` §C1). Content-hash deduplication.
- Tiered retention and deletion tombstones per ADR 0009, with the scheduled expiry job.
- SQLite FTS5 search. `/find` with permission-filtered citations — filter the citation list, not just the content (`REVIEW.md` §C16).
- Resource registry with SSRF-defended fetching.
- Provider layer with the ADR 0010 eligibility gate, the generic OpenAI-compatible adapter, explicit routing, and a hard monthly ceiling that fails closed.
- Context compiler with per-section budgets, a recorded disclosure plan, and retrieved content in a delimited labelled envelope. A turn whose only new input is retrieved text may not emit a tool call.
- `/ask` with citations. Defer within three seconds, then throttled progressive edits (`REVIEW.md` §C7).
- `/remind`, `/decision`, `/review-plan`.
- Server card and a small **hand-curated** memory set. No automatic extraction yet.
- `/mydata`, `/forgetme`, and a per-member opt-out from memory extraction.
- Golden question set including prompt-injection cases, inaccessible-channel traps, and citation-leak cases. Any unauthorised retrieval is release-blocking.

**Gate:** `/ask` gets used weekly and saves a manual search. No permission test leaks content or the existence of content. Provider outage degrades visibly and leaves every Release 1 and 2 module untouched. Measured memory meets `docs/15` on the Mint box.

---

## After Release 3

Everything else lives in `docs/13` as a backlog, prioritised only after Release 3 has run for a month: automatic memory extraction, the full dashboard in `docs/06_DASHBOARD_TARGET.md`, optional embeddings, the member-facing feature tier, welcome messages, tags and custom commands, scheduled messages, starboard, tickets, and public-release packaging.

The previous roadmap's "Milestone 9 — parity modules" is deleted. Modules graduate from the backlog one at a time, each with a concrete use case someone has actually asked for.
