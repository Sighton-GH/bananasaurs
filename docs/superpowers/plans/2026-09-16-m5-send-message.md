# Slice M5 — `send_message`, the allowlist, and audit

**Status: DRAFT.** Written 2026-09-16, before implementation.
**Branch:** `oc/m5-send-message`. **ADR:** none new — ADR 0044 §4 already
governs this slice ("bound by design §3's allowlist, forced empty
`allowedMentions`, 2000-character cap, idempotency key,
ten-per-guild-per-hour cap, effect gateway and audit row").
**Precondition:** M4, merged at `24c5aec`.
**Not run lean** — the owner's instruction. It is the only write in the whole
MCP design.

## Why this slice is different from M1–M4

Everything before this was a read. This is the first path where a `tools/call`
over the network causes Bananasaurs to act on Discord. That changes which
rules bind:

- **Hard rule 6** — every Discord side effect has a durable idempotency key
  and a unique constraint that makes double execution impossible. Gateway
  events replay on reconnect; MCP clients retry on timeout. Both happen.
- **Hard rule 1** — AI is never in the enforcement path. This is not an
  enforcement action: it is the owner posting a message they asked for. But
  the same discipline applies — the model's output is untrusted input, passes
  a Zod validator, and the *daemon* decides whether to send.
- **ADR 0044's replacement bullet** — the trigger must be the owner's
  keystroke in the owner's own client. That is a rule the owner keeps, not a
  control the daemon holds, and the ADR already says so. Nothing in this
  slice may make an automated trigger *easier*.

## The observe window

Two live guilds are in an observe window. The owner's standing constraint:
**do not touch `mod_rules`, `setRuleMode`, or the effect gateway's moderation
paths.** Two rulings below exist specifically to honour it, and one step is
flagged as the riskiest thing in the slice.

## Rulings, decided before dispatch

**M5-D1 — the send effect is a sibling module, not a new kind inside
`gateway.ts`.** The slice plan says "a new effect kind through
`core/effects`", and the obvious reading is to widen
`packages/core/src/effects/gateway.ts`. Reading it settles the question the
other way: that file is not a general effect gateway, it is the *role* effect
gateway. Its own layer list is
`panel status → role allowlist → protected target → hierarchy + managed`,
four steps that have no meaning for a message, and its types are `RoleIntent`
and a `RefusalReason` union of ten role-specific strings.

So M5 adds `packages/core/src/effects/message-gateway.ts` — same directory,
which is what ADR 0014 requires for anything that may import the REST port,
and the same layered shape:

```
1. allowlist        mcp_send_allowlist                   -> refuse
2. kill switch      guilds.killswitch                    -> refuse
3. circuit breaker  guilds.breaker_state = 'open'        -> refuse
4. rate cap         ten per guild per rolling hour       -> refuse
5. idempotency      INSERT OR IGNORE mcp_sends           -> 0 rows = replay
6. dry run          guilds.dry_run -> record, no REST call
7. execute          the single REST call, allowedMentions forced empty
8. record           outcome, message id, audit row
```

**Zero edits to `gateway.ts`.** That is the point: the moderation chokepoint
cannot regress if no line of it changes, and "the tests still pass" is a
weaker guarantee than "the file is byte-identical" while a clock is running.

The cost is that three safety reads — kill switch, breaker, dry-run — are
written twice in the tree. **Do not extract them into a shared helper**:
extraction means editing the moderation chokepoint to call it, which is the
one thing this ruling exists to avoid. Three duplicated lines, with a comment
naming the reason and naming the extraction as the cleanup to do once the
observe window closes, is the cheaper mistake.

**M5-D2 — `allowedMentions` becomes an optional field on `OutgoingMessage`,
and the MCP path always sets `{ parse: [] }`.** Nothing in the tree sets
`allowedMentions` today (`grep` over `packages` and `apps` finds no
occurrence of it or `allowed_mentions`), so every message the bot currently
sends is free to ping. Making the port suppress mentions *by default* would
be the better end state and is **not** this slice's business: it changes the
behaviour of panel posts and log messages while two guilds are being
observed. M5 sets the field explicitly on its own call and proves it with a
test at the fake port. The wider gap is recorded in `docs/STATE.md` as a
finding, not fixed here.

**M5-D3 — an idempotency key that comes back with different content is a
refusal, not a replay.** The obvious design is: same key, return the first
result. That is right for a retry, and it is a trap for a mistake — a client
that reuses a key with new content would be told its message was sent, and it
never was. So `mcp_sends` stores a hash of `(channel_id, content)` beside the
key, and:

- key absent → send, record.
- key present, hash matches → replay: return the first result, send nothing.
  This is the retry case and it must be indistinguishable from success.
- key present, hash differs → refuse, with a reason that says the key was
  already used for a different message.

Cost if wrong: a client that deliberately edits and retries under one key
gets a refusal it must handle. That is the direction to err in.

**M5-D4 — the rate cap counts accepted sends, durably, from `mcp_sends`.**
Ten per guild per rolling hour (the plan's Q1 default, unchanged by the
owner). Computed from rows, not from an in-memory bucket, so a restart does
not hand out ten more — that is the whole reason the design said durable.

Counted: outcomes `sent` and `dry_run`. Not counted: refusals of any kind. A
dry-run send costs no Discord call, but it is an operator-requested send and
letting it be free would make the cap depend on a safety toggle. Refusals
must not count, or a client that keeps hitting a non-allowlisted channel
would lock the owner out of the channels they *can* post to.

**M5-D5 — `audit_events.actor_type` gains `'mcp_operator'` by the ADR 0042
PR-32 rebuild, and this is the riskiest step in the slice.** The CHECK is
`actor_type IN ('member','owner','operator_cli','dashboard','system','doctor')`
and SQLite cannot alter a CHECK in place, so the column-then-rebuild dance is
the only route. `audit_events` is the table every moderation action writes
to, and this runs as a migration on a live database.

The alternative — reusing `'operator_cli'` for a send that did not come from
the CLI — is rejected: it puts a false statement in the one table whose whole
job is to be true later. An audit trail that lies to avoid a migration is
worse than the migration.

Mitigations, all required: `npm run db:generate` produces it (never
hand-written); the `schema-invariants` proof that Slice 6 owed covers the
rebuilt table; the migration is proved to apply on top of a database holding
real audit rows, with a test asserting the row count and one row's full
contents survive; and `docs/SMOKE_TESTS.md`'s restore drill gains the note.

**M5-D6 — the tool refuses a DM channel id before it consults the
allowlist.** The plan asks for this ordering explicitly and it is worth
saying why, because it looks backwards: a DM channel can never be on a
guild-scoped allowlist, so the allowlist would refuse it anyway. The reason
is that the allowlist lookup is guild-scoped and a DM has no guild — checking
it first means asking a guild-partitioned table about a row that cannot have
a partition key. Refusing on channel type first keeps the partition
invariant clean (CLAUDE.md rule 2).

## Global constraints (copy verbatim into every brief)

1. **Do not touch** `mod_rules`, `setRuleMode`, `packages/core/src/mod/`,
   `packages/core/src/automod/`, or `packages/core/src/effects/gateway.ts`.
   The observe window is running on two live guilds. Ruling M5-D1 exists so
   that no task needs to; if a task appears to need one of these, stop and
   report rather than editing it.
2. **Guild scope is a mandatory partition key** (CLAUDE.md rule 2). Both new
   tables carry `guild_id` with the snowflake CHECK and the cascade FK to
   `guilds`, like every existing one. Every new repository function takes a
   `GuildScope` first and goes through `scope.only(...)`.
3. **Every Discord side effect has a durable idempotency key** and a unique
   constraint that makes double execution impossible (hard rule 6). For this
   slice that is `UNIQUE (guild_id, idempotency_key)` on `mcp_sends`, and the
   claim happens **before** the REST call, so a crash between them cannot
   double-send.
4. **Model output is untrusted input** (hard rule 3). Every argument passes a
   Zod validator. The content is member-readable text the owner asked to
   post; it is never interpreted as an instruction by anything.
5. **No secrets anywhere** (rule 4). Pino redaction is an allowlist. No token
   value, no authorization code, no client secret under any name. **The audit
   row carries the channel, never the content** — content lives in
   `mcp_sends` and in Discord.
6. **`npm run db:generate` is the only way to produce a migration.** Never
   hand-write one.
7. **Break every guard and watch it fail** before believing it. Name the line
   you neutralised and quote the failure.
8. **`PRIVACY.md` changes land in the same commit as the migration** they
   describe (Slice 2 precedent).
9. Gates: `npm run typecheck && npm run lint && npm run test` pass by exit
   code, run by you, not reported from reasoning.

## Tasks

### Task 1 — the schema, the repositories, and the rebuild

`mcp_send_allowlist (guild_id, channel_id, added_by_account_id, added_at)`,
PK `(guild_id, channel_id)`. `mcp_sends (guild_id, idempotency_key,
channel_id, content_hash, message_id NULLABLE, token_id, sent_at, outcome)`
with **UNIQUE `(guild_id, idempotency_key)`**. The `audit_events.actor_type`
rebuild per M5-D5. Repository functions for both tables, the sliding-hour
count for M5-D4, and the `INSERT OR IGNORE` claim.

### Task 2 — the message gateway

`packages/core/src/effects/message-gateway.ts` per M5-D1's layer list, with
its ports, its refusal union, and its tests. No REST call in the tool layer;
the gateway is the only thing that can reach `sendMessage`. `allowedMentions`
per M5-D2.

### Task 3 — the tool, behind the send scope

`send_message` in `packages/mcp`, registered only when the principal carries
`bananasaurs:send` (M4-D17 put the mechanism there; this is the first tool to
use the other scope). 2000-character cap. The eight refusal tests the slice
plan lists, each watched red first.

### Task 4 — the CLI and the audit row

`bananasaurs mcp allow-channel <id> --confirm`, `disallow-channel`,
`allowlist`, `sends [--since]`. The audit row with
`actor_type='mcp_operator'`, `via='mcp'`, the client id, the token id and the
channel — never the content.

### Task 5 — docs

`docs/17` (the four commands and what the allowlist means), `PRIVACY.md` (the
bot can post to channels the owner allowlisted, at the owner's request), and
`docs/STATE.md`.

## Not in M5

The tunnel and Cloudflare Access — that is M6. Any moderation tool: no
moderation, automod, role, ban, kick, timeout or purge tool exists in any
slice of this design (design §12), and M5 does not start one. Making
`allowedMentions` default-empty across the whole tree (M5-D2).
