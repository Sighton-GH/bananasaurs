# The MCP operator server — slice plan

> **STATUS: DRAFT — for review.** Produced 2026-09-12. This is the slice-level
> plan for the six MCP slices (M1–M6). Each slice gets its own detailed
> implementation plan in its own session, written from this file and its ADR,
> exactly as Slices 0–6 did — a task-level plan written now for M5 would be
> stale by the time M5 starts.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (or the opencode variant, if the
> session has it) to implement each slice task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Status:** DRAFT

**Goal:** The owner opens Claude — on the box, in the desktop app, or on
claude.ai — connects to `https://bananasaurs.sighton.ca/mcp`, and can ask
what channels exist, search what was said, read the bot's cases and audit
trail, and post a message to an allowlisted channel. Nothing else.

**Spec:** `docs/superpowers/specs/2026-09-12-mcp-operator-server-design.md` —
**read it first.** This plan carries the steps; the spec carries the
reasoning and the owner's six recorded decisions.

**Roadmap position:** Release 2, during the observe window, after Slices 7–9
and before Slices 10–12 (spec §9). The Release 2/3 roadmap spec's §3 and §9
were edited on 2026-09-12 to place these slices and renumber the Release 3
ADR reservations.

**Tech stack:** existing, plus **one new dependency**: `@modelcontextprotocol/sdk`
1.30.0 (MIT). Justification: it is the reference implementation of the
protocol the Claude clients speak, and the transport class it provides is
framework-agnostic. Its Express-shaped auth router is **not** used (spec §5).
`cloudflared` is a host package, not an npm dependency.

---

## Contents

- Decisions I need from you
- Global constraints (every slice)
- Slice M1 — archive schema, ingestion, retention
- Slice M2 — FTS5 search and permission-filtered citations
- Slice M3 — the OAuth 2.1 authorization server
- Slice M4 — the MCP server and the read tools
- Slice M5 — `send_message`, the allowlist, and audit
- Slice M6 — tunnel, Access, and the live end-to-end
- Dependency order
- Gates that apply to every slice
- What "done" means for the whole thing

---

## Decisions I need from you

These are the spec's §11, repeated here because this is the file you act on.

| # | Question | Default if you say nothing |
| --- | --- | --- |
| Q1 | Send rate cap — 10 per guild per rolling hour is a guess | 10 |
| Q2 | May M1/M2 interleave with Slices 7–9, or strictly follow them? | Strictly follow |
| Q3 | Token lifetimes: access 1 h, refresh 30 d | As stated |
| Q4 | Which test-guild channels enter archive scope first? | None; you enable them via the CLI after M1 |
| Q5 | Confirm the Anthropic training opt-out is set on the account that will hold these connectors (spec §8.4) | Blocks M4's first real read — not the code |

---

## Global constraints (every slice)

1. **Read `docs/reports/briefs/SANDBOX_RULES.md`.** Binding. Never read or
   ask for `.env`. Always give `rg` an explicit path and never pipe into it.
   Check gates by exit code, never through `tail`. One command per call.
2. **Guild scope is a mandatory partition key** (CLAUDE.md rule 2). Every new
   repository function takes a `GuildScope` first and goes through
   `scope.only(...)`. Every new table carries `guild_id` with the snowflake
   CHECK and the cascade FK to `guilds`, like every existing one.
3. **`npm run db:generate` is the only way to produce a migration.** Never
   hand-write one. If a CHECK is needed on an existing table, it is the
   add-columns-then-rebuild dance ADR 0042 ruling PR-32 recorded, and the
   rebuild needs the same `schema-invariants` proof Slice 6 owed.
4. **Pino redaction is an allowlist** (rule 4). Every new logged field name
   needs a `LOGGABLE_FIELDS` entry with a comment. Token values, authorization
   codes, and client secrets are never loggable under any name.
5. **Break it and watch it fail.** Eighteen decorative guards have been found
   on this project. Watch every guard go red before making it pass, and say
   which line you neutralised.
6. **Verify both directions of a boundary.** A check tested for the wrong
   input and never for the absent input is Slice 4's CRITICAL-2.
7. **Delegate on cheap models, hand over files.** `docs/22_DELEGATION_AND_CONTEXT.md`.
   Name a model on every dispatch; brief as a file path; reports back as
   files; reviewers get a pre-generated diff.
8. **ADR first** where §10 of the spec names one. M1 needs 0046, M3 needs
   0045, M4 needs 0044. Write it, then plan, then code.
9. **`PRIVACY.md` changes land in the same commit as the migration** they
   describe (Slice 2 precedent).
10. **Nothing in these slices may touch `mod_rules`, `mod_cases` writers,
    `setRuleMode`, or the effect gateway's moderation paths.** The observe
    window is running. A change there restarts a clock.

---

## Slice M1 — archive schema, ingestion, retention

**ADR:** 0046 — write it first.
**Precondition:** none within this plan; Slices 7–9 done per Q2.

**Goal:** Messages from owner-enabled channels land in SQLite, edits and
deletions are recorded, a restart resumes backfill, and content of deleted
messages expires on the A1 schedule — with nothing enabled by default.

### Tasks

- [ ] **Tests first: retention and scope.** Before any table exists, write
  the tests that assert (a) a channel not in `archive_channels` produces no
  row on `MESSAGE_CREATE`; (b) a channel in `log_excluded_channels` produces
  no row even if archive-enabled; (c) a deleted message's content is null
  after the 30-day expiry job runs and its tombstone remains; (d) a message
  pinned to an open case survives the expiry; (e) two guilds cannot see each
  other's rows. Watch all five fail against an empty implementation.
- [ ] **Schema.** `archive_channels (guild_id, channel_id, attachment_policy
  CHECK IN ('none','bytes'), enabled_at, cursor_message_id, backfill_state)`;
  `archive_messages (guild_id, message_id PK, channel_id, author_id,
  content NULLABLE, created_at, edited_at, deleted_at, retention_class CHECK
  IN ('default','case','preserve'), content_purged_at)`;
  `archive_message_edits (guild_id, message_id, edit_seq, content, edited_at)`;
  `archive_attachments (guild_id, message_id, attachment_id, filename,
  content_type, size, sha256 NULLABLE, bytes_path NULLABLE)`. Unique on
  `(guild_id, message_id)`. `npm run db:generate`. `schema-invariants` covers
  every new table for the partition key and the cascade.
- [ ] **Repository.** `packages/storage/src/archive/` — `enableChannel`,
  `disableChannel`, `upsertMessage`, `recordEdit`, `recordDelete`,
  `markPreserve`, `linkToCase`, `expireContent(now)`, all `GuildScope`-first.
- [ ] **Live subscriber.** `packages/core/src/archive/subscriber.ts` on the
  existing pipeline for `messageCreate`, `messageUpdate`, `messageDelete`,
  `messageDeleteBulk`. Deduplicated by the existing `event_dedupe` fingerprint.
  Honours both vetoes (task 1's tests a and b).
- [ ] **Backfill worker.** One job kind, `archive_backfill`, on the job table
  with the ADR 0016 dedupe key `(guild_id, channel_id)`. Fetches 100 at a
  time, persists the cursor after every page, respects the REST port's
  rate-limit handling (ADR 0018). A restart mid-channel resumes from the
  cursor — tested by killing the fake between pages.
- [ ] **Attachments.** Policy `none` writes the metadata row and a `sha256`
  only if the URL is still live at ingest. Policy `bytes` downloads to
  `data/archive/<guild_id>/<sha256>` with dedupe by hash. **Default `none`.**
  `bytes` is tested but nothing enables it.
- [ ] **Expiry job.** `archive_expiry`, scheduled daily, implements the three
  tiers. Tested with a frozen clock at day 29, 30, 31.
- [ ] **CLI.** `bananasaurs archive enable-channel <id> [--attachments bytes]
  --confirm`, `disable-channel`, `status` (per channel: cursor, backfill
  state, row count), `preserve <message_id> --confirm`. Writes audit rows.
- [ ] **`PRIVACY.md`** gains the archive and retention rows in the migration
  commit.
- [ ] **`doctor`** reports archive-enabled channels the bot can no longer read.

### Not in M1

Search. Anything MCP. Any dashboard page.

---

## Slice M2 — FTS5 search and permission-filtered citations

**ADR:** none new (0046 covers it).
**Precondition:** M1.

**Goal:** `searchMessages(scope, query, filters)` returns ranked excerpts and
citations, and a citation never names a channel outside the caller's
visibility set.

### Tasks

- [ ] **Tests first: the leak.** Seed two archive channels, put the caller's
  visibility set as one of them, search for a term that appears in both.
  Assert the result has one hit **and one citation** — not one excerpt and
  two citations. Watch it fail.
- [ ] **FTS5 virtual table** `archive_messages_fts` with external content
  pointing at `archive_messages`, triggers kept in sync on insert/update/
  delete, `guild_id` carried as an unindexed column so the query can filter
  it. Verify `better-sqlite3`'s build has FTS5 compiled in — check
  `node_modules`, do not assume.
- [ ] **Repository.** `searchMessages(scope, {query, channelIds?, authorId?,
  before?, after?, limit})` with `limit ≤ 100`, BM25 ranking, snippets via
  `snippet()`.
- [ ] **Visibility filter.** A `VisibilitySet` type — the channels a principal
  may cite. For the MCP operator it is "every archive-enabled channel in the
  guild." The filter is applied to the SQL, not to the result list in
  JavaScript, so a channel outside the set cannot appear in `COUNT(*)` either.
- [ ] **Purged content.** A message whose content was expired is excluded from
  the FTS index (trigger on `content_purged_at`) but its tombstone remains
  reachable by `getMessage`.
- [ ] **CLI.** `bananasaurs archive search <query> [--channel] [--author]` for
  operator verification and for the guided-bot-testing runbook.

---

## Slice M3 — the OAuth 2.1 authorization server

**ADR:** 0045 — write it first.
**Precondition:** none within this plan (M3 does not need the archive).
**Not run lean.** This is an authorization boundary. Plan review, per-task
review, whole-branch review on the strongest model, fix wave, re-review.

**Goal:** A conformant OAuth 2.1 authorization server on Fastify, tokens
bound to a dashboard account that holds `mcp.authorize`, verified by the SDK's
own client against the running daemon.

### Tasks

- [ ] **Tests first: the boundary.** (a) A token request with a code issued to
  a different `client_id` is refused; (b) a code is single-use — the second
  exchange fails **and revokes the first token** (RFC 6749 §4.1.2); (c) PKCE
  `S256` is required and `plain` is refused; (d) a refresh rotates and the old
  refresh token is dead; (e) a revoked access token fails on the next request
  within the same second; (f) a dashboard account without `mcp.authorize`
  cannot reach the consent page's approve action; (g) a redirect URI not
  registered to the client is refused at authorize time. Seven red tests
  before any route exists.
- [ ] **Schema.** `oauth_clients (client_id PK, client_name, redirect_uris
  JSON, created_at, created_by_account_id NULLABLE, registration_source
  CHECK IN ('dynamic','cli'))`; `oauth_authorization_codes (code_hash PK,
  client_id, account_id, scopes, code_challenge, redirect_uri, expires_at,
  used_at)`; `oauth_tokens (token_id PK, token_hash UNIQUE, kind CHECK IN
  ('access','refresh'), client_id, account_id, scopes, expires_at,
  revoked_at, last_used_at, parent_token_id NULLABLE)`. Instance-level
  (ADR 0027) — tokens are not guild-scoped; **tool calls are** (M4).
- [ ] **`OAuthServerProvider` implementation** against the SDK's interface,
  backed by the tables above. Hash tokens with SHA-256 at rest. Lifetimes per
  spec §8.3 and Q3.
- [ ] **Fastify routes.** `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource`, `GET /oauth/authorize` (consent
  page), `POST /oauth/authorize` (approve/deny, CSRF-protected via
  `policy.ts`), `POST /oauth/token` (`authorization_code` and
  `refresh_token` grants, PKCE verified), `POST /oauth/register` (dynamic
  client registration, RFC 7591, **rate-limited** and **redirect URIs
  restricted to `https://` or loopback**), `POST /oauth/revoke`. Every body
  through Zod.
- [ ] **Consent page.** Server-rendered, no React — it is one form. Logs in
  with a dashboard account (reuse `packages/http/src/auth.ts`'s verifier,
  not its session). Shows client name, redirect URI host, and scopes.
  Requires `mcp.authorize`.
- [ ] **Bearer verification middleware** for `/mcp`: looks the token up,
  checks expiry and revocation, attaches `{accountId, clientId, tokenId,
  scopes}` to the request. **Every** request — no caching.
- [ ] **CLI.** `bananasaurs mcp clients`, `bananasaurs mcp tokens`,
  `bananasaurs mcp revoke <token_id> --confirm`, `bananasaurs mcp
  revoke-client <client_id> --confirm`, `bananasaurs account grant
  <account> mcp.authorize --confirm` (or whatever the existing capability
  grant command is — check `packages/cli/src` first).
- [ ] **Conformance run.** Use the SDK's own `examples/client/simpleOAuthClient`
  against the daemon on loopback, in a test, end to end: register, authorize
  (drive the consent form with the test HTTP client), exchange, call a stub
  `/mcp`, refresh, revoke, fail. This is the test that proves the server
  speaks the protocol the Claude clients speak.
- [ ] **Redaction.** `LOGGABLE_FIELDS` gains `oauth_client_id` and
  `oauth_token_id` with comments. A test greps a captured log stream for any
  raw token or code value and fails if found.

### Fallback

If the route layer exceeds its estimate by more than a session, spec §5's
approach B is the documented alternative and the `OAuthServerProvider`
carries over unchanged.

---

## Slice M4 — the MCP server and the read tools

**ADR:** 0044 — write it first (it amends ADR 0013; the amendment must land
before a tool exists).
**Precondition:** M2, M3.

**Goal:** A Claude client with a `bananasaurs:read` token connects to `/mcp`,
lists tools, and every read tool in spec §3 works against the test guild.

### Tasks

- [ ] **Tests first: scope and envelope.** (a) Every content-bearing tool
  result carries the evidence envelope and the preamble, and content
  containing the delimiter string cannot close the envelope; (b) a two-guild
  test — a tool call naming guild B from a session whose bot is in guild A
  and B returns B's data only, and naming a guild the bot is not in returns
  a refusal, not an empty set; (c) a `read`-only token's `tools/list` does
  not contain `send_message`; (d) a request with no bearer token gets the
  RFC 9728 `WWW-Authenticate` challenge pointing at the metadata URL.
- [ ] **`packages/mcp`** workspace package. `eslint.config.js` gains its
  boundary block (spec §4). `McpServer` + `WebStandardStreamableHTTPServerTransport`,
  bridged from Fastify's request/reply to Web-standard `Request`/`Response`.
  Session management per the SDK's transport: one transport per MCP session
  id, cleaned up on close.
- [ ] **Tool handlers**, each: parse input with Zod → resolve `guildId` against
  the allowlist → build `GuildScope` → call the repository → wrap in the
  envelope → return. Tools per spec §3. `get_health` is the exception (no
  guild).
- [ ] **The evidence envelope.** One function, `envelope(items)`, used by every
  content-bearing tool. Fixed preamble text lives in one constant and is
  quoted in ADR 0044.
- [ ] **The overview resource.** `bananasaurs://guild/{guildId}/overview`.
- [ ] **Training-eligibility record** (spec §8.4). No provider-eligibility
  table exists yet (checked `schema.ts` 2026-09-12 — ADR 0010's table is
  Release 3 work). Create the minimal one ADR 0010 describes
  (`provider_eligibility`: provider, `trains_on_input` CHECK IN
  ('no','yes','unknown'), evidence URL, reviewed-at), instance-level, so
  Release 3's provider layer inherits it rather than creating a second. One
  row: "Anthropic consumer via MCP". `doctor` warns past 90 days.
  **M4's first real-content read against the test guild waits on Q5.**
- [ ] **Loopback smoke.** `claude mcp add --transport http bananasaurs
  http://127.0.0.1:8787/mcp` on the box, OAuth flow through the consent page
  in a browser over `ssh -L`, then `get_server_overview` and
  `search_messages` for real. Record the transcript in
  `docs/reports/mcp-m4-loopback-smoke.md`.

---

## Slice M5 — `send_message`, the allowlist, and audit

**ADR:** 0044 (already written for M4) — its send section governs this.
**Precondition:** M4.
**Not run lean.** It is the only write.

**Goal:** A `bananasaurs:send` token can post to an allowlisted channel, once
per idempotency key, without pings, under the rate cap, with an audit row.

### Tasks

- [ ] **Tests first: every refusal.** (a) Channel not on the allowlist →
  refused; (b) a DM channel id → refused before the allowlist is consulted;
  (c) same idempotency key twice → one send, second call returns the first
  result; (d) content with `@everyone` → sent with `allowedMentions: {parse:
  []}` and the fake REST port proves no mention was parsed; (e) the eleventh
  send in an hour → refused with a reason; (f) kill switch on → refused by
  the gateway, not by the tool; (g) dry-run on → recorded, not sent; (h) a
  `read`-only token → tool absent from list and refused on direct call.
  Eight red tests.
- [ ] **Schema.** `mcp_send_allowlist (guild_id, channel_id, added_by_account_id,
  added_at)` PK `(guild_id, channel_id)`; `mcp_sends (guild_id,
  idempotency_key, channel_id, message_id NULLABLE, token_id, sent_at,
  outcome)` **UNIQUE `(guild_id, idempotency_key)`** (hard rule 6).
- [ ] **`audit_events.actor_type` gains `'mcp_operator'`.** This is a CHECK
  on an existing table: column-then-rebuild per ADR 0042 PR-32, with the
  `schema-invariants` proof for the rebuild.
- [ ] **The effect.** A new effect kind through `core/effects` — the gateway
  applies kill switch, breaker, dry-run. The tool never touches the REST port.
- [ ] **Rate cap.** In the daemon, keyed `(guild_id)`, sliding hour, from
  `mcp_sends` rows — durable, not in-memory, so a restart does not reset it.
- [ ] **CLI.** `bananasaurs mcp allow-channel <id> --confirm`,
  `disallow-channel`, `allowlist`, `sends [--since]`.
- [ ] **Audit row** with `actor_type='mcp_operator'`, `via='mcp'`, client id,
  token id, and the channel — never the content (content is in `mcp_sends`
  and in Discord).

---

## Slice M6 — tunnel, Access, and the live end-to-end

**ADR:** none new (0045 covers exposure).
**Precondition:** M5.

**Goal:** From the Claude desktop app on a laptop off the LAN, add
`https://bananasaurs.sighton.ca/mcp` as a connector, complete the consent flow
behind Cloudflare Access, and run every tool. Then revoke the token and watch
the next call fail.

### Tasks

- [ ] **`cloudflared` systemd unit** in `deploy/`, ingress rules publishing
  **only** `/mcp` and `/oauth/*` and `/.well-known/oauth-*`, everything else
  → 404 at the edge. Documented in `docs/17` §2.4 (new).
- [ ] **Cloudflare Access application** on `/oauth/authorize` only, policy =
  the owner's identity. **Not** on `/oauth/token`, `/oauth/register`,
  `/oauth/revoke`, `/mcp`, or the well-known documents. Recorded in
  `docs/07`.
- [ ] **Origin/Host check verified against the real tunnel** (spec §6, last
  bullet). Write down what `Host` and `Origin` actually arrive as. If
  `policy.ts` refuses the consent POST, the fix is in `policy.ts`'s known-host
  list with a comment — not a bypass.
- [ ] **`doctor`** gains: tunnel config present and publishes only the
  expected paths; Access configured on the consent path (checked by an
  unauthenticated `GET /oauth/authorize` through the public hostname
  returning an Access redirect, not the consent page); training-eligibility
  row not stale.
- [ ] **Live run**, recorded in `docs/reports/mcp-m6-live-run.md` in the
  style of `release1-smoke-tests-live-run.md`: desktop app connector added,
  consent completed, every read tool exercised, one `send_message` to the
  allowlisted test channel, one refused send to a non-allowlisted channel,
  revoke, failure. claude.ai connector added and one read tool exercised.
  Claude Code on a laptop via `claude mcp add --transport http`.
- [ ] **`docs/SMOKE_TESTS.md`** gains an MCP section.
- [ ] **`docs/17` §4** ("what this must never become") gains the line ADR 0044
  adds: the MCP server is permitted **because** its output goes to the owner's
  client and its one write is owner-instructed and allowlisted; a tool that
  posted a member's question's answer would still be the prohibited bridge.

---

## Dependency order

```
Slices 7 → 8 → 9 (Release 2 dashboard, first — Q2)
                │
     ┌──────────┴──────────┐
     │                     │
   M1 (archive)          M3 (OAuth)          ← independent of each other
     │                     │
   M2 (search)             │
     │                     │
     └──────────┬──────────┘
                │
              M4 (MCP + read tools)
                │
              M5 (send_message)
                │
              M6 (tunnel, Access, live run)
                │
        Slices 10 → 11 → 12 (Release 2 close-out)
```

M1→M2 and M3 are parallel tracks. If two sessions run, one takes each.

## Gates that apply to every slice

- `npm run typecheck && npm run lint && npm run test` — each run alone, exit
  code checked, before any claim of done.
- ADR written before the slice's first commit, where one is named.
- Plan reviewed by a cheap model before dispatch (`docs/22`).
- Whole-branch review by the strongest model at the end of each slice; M3 and
  M5 additionally get a fix wave and a re-review.
- `docs/STATE.md` "Where the build is" updated at slice end, saying which of
  *merged and green* / *migrated onto the live database* / *actually running*
  is true. For M1 the distinction matters: an archive subscriber that is
  merged has archived nothing until a channel is enabled.
- Ledger entry in `docs/reports/release2-slices-1-6-ledger.md` (rename or
  start `release2-mcp-ledger.md` at M1 — the session decides and says which).

## What "done" means for the whole thing

The owner, from the Claude desktop app on a laptop not on the LAN, asks
"what did people talk about in #planning this week and draft an announcement
for #general" — gets a grounded answer with citations to real messages in the
test guild, approves the draft, says "post it", and it appears in `#general`
once, with no pings, with an audit row naming the token that did it. Then
`bananasaurs mcp revoke` makes the next call fail. And `npm run test` is
green with every AI provider unreachable, because nothing in this plan
needed one.
