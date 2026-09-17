# Slice M5 whole-branch review — Opus, 2026-09-16

Branch `oc/m5-send-message`, 29 commits off `main` (`230ed53`), reviewed in
the worktree `/home/bryan/projects/bananasaurs/.oc-worktrees/oc/m5-send-message`.

## Verdict: DO-NOT-SHIP

Two defects on the one new write path, both proved by driving the production
code rather than reading it. Both are small fixes in files this branch never
opened, and neither is in the moderation chokepoint, so the observe window is
not at risk from either the defect or its repair. Everything else in the slice
is in good shape — the migration, the ledger, the cap, the scope gating and the
guild partition all hold under probing.

The blocking pair:

1. **`allowed_mentions` never reaches Discord.** The gateway sets it; the REST
   adapter silently drops it. A `send_message` containing `@everyone` pings all
   210 members. This is the seventh composition defect, and the whole slice —
   ruling M5-D2, the tool description the model reads, `docs/17`, and the
   **published PRIVACY.md** — asserts the opposite as a fact.
2. **The send allowlist never checks that the channel is in the guild**, and
   the REST route carries no guild id, so one mistyped `mcp allow-channel`
   posts into another guild or into a DM. PRIVACY.md's "it cannot send you a
   DM" is a claim nothing enforces.

Fix those two, re-run the gates, and this is a SHIP.

## Gates, run here, one at a time

| Gate | Command | Exit | Result |
| --- | --- | --- | --- |
| typecheck | `npm run typecheck` | 0 | clean (`tsc --build --force` + `tsc -p tsconfig.all.json`) |
| lint | `npm run lint` | 0 | eslint clean, `All matched files use Prettier code style!` |
| test | `npm run test` | 0 | **173 files / 3270 tests passed**, 54.9s |

Counts match the brief exactly.

## Observe-window constraint, confirmed

```
git diff --name-only main..HEAD | grep -E 'mod/|automod/|effects/gateway.ts'   -> no matches (exit 1)
git diff main..HEAD -- packages/core/src/effects/gateway.ts | wc -c            -> 0
```

`packages/core/src/effects/gateway.ts` is byte-identical to `main`. Nothing
under `packages/core/src/mod/` or `packages/core/src/automod/` is touched.
M5-D1 was honoured.

---

# Findings

## Critical

### C1 — `allowedMentions` is dropped by the REST adapter: `@everyone` pings

**The seventh composition defect**, and the exact shape the brief predicted: a
property proved in a unit test *and* in the composed wiring test that the
composed daemon does not have.

`packages/core/src/effects/message-gateway.ts:303` sets
`allowedMentions: { parse: [] }`. `packages/core/src/discord/port.ts:102` adds
the field to `OutgoingMessage`. But `packages/discord` is **not in this
branch's diff at all** (`git diff --stat main..HEAD -- packages/discord` is
empty), and its `toRestMessage` — the function that builds the POST body —
predates the field:

```ts
// packages/discord/src/rest/port.ts:438
function toRestMessage(message: OutgoingMessage): Record<string, unknown> {
  return {
    ...(message.content === undefined ? {} : { content: message.content }),
    ...(message.embeds === undefined ? {} : { embeds: message.embeds }),
    ...(message.components === undefined ? {} : { components: message.components }),
  };
}
```

`allowedMentions` is not spread, so it never reaches the wire. Absent
`allowed_mentions`, Discord's default is to parse **every** mention in the
content, including `@everyone` and `@here`.

**Evidence — driven, not reasoned.** The production adapter with a recording
REST stub (`createDiscordRestPort` is exactly what `apps/daemon/src/index.ts:177`
builds and `index.ts:216` hands to the MCP wiring):

```
returned ref: {"channelId":"444444444444444444","messageId":"999999999999999999"}
REST calls: [ { "verb": "POST",
                "route": "/channels/444444444444444444/messages",
                "body": { "content": "@everyone hello club" } } ]
allowed_mentions present in body? false
```

**Why every test missed it.** Both tests that assert the property assert it
against a `DiscordPort` *fake*, one layer above the defect:

- `packages/core/src/effects/message-gateway.test.ts:465`
- `apps/daemon/src/mcp/wiring.test.ts:463` —
  `expect(calls[0]?.args[2]).toEqual({ content: CONTENT, allowedMentions: { parse: [] } })`,
  against `FakeDiscord`.

The composed test added by Task 4 specifically to close this defect class
stops at the same seam. `packages/discord/src/rest/port.test.ts:367` is the
only test of the real adapter's `sendMessage` and it asserts only the returned
ref.

**Blast radius.** `send_message` is a tool whose caller is a language model
writing club announcements. "@everyone" is the single most likely token in
that text. The tool description the model reads says "Mentions in the content
never ping: @everyone, @here, role and user mentions are all suppressed", so
the model has been told it is safe to write it.

**Three artefacts state the false property as fact and must change with the
code:**

- `PRIVACY.md`: "Mentions in those messages never ping anyone — `@everyone`,
  `@here`, role and user mentions are all switched off before the message is
  sent." This is a statement to 210 members.
- `docs/17_OPERATOR_ACCESS.md`: "The send sets `allowed_mentions` to the empty
  set … This is the one place in the tree that sets it."
- `docs/STATE.md`: the first of the two carried-forward findings.

**Fix.** One line in `toRestMessage`, plus the snake_case rename Discord's API
requires — note that a naive spread of `message.allowedMentions` would still
be wrong, because the wire field is `allowed_mentions`:

```ts
...(message.allowedMentions === undefined
  ? {}
  : { allowed_mentions: message.allowedMentions }),
```

`packages/discord` is outside the frozen paths. Add the assertion to
`packages/discord/src/rest/port.test.ts` at the wire, not at the port — a
test at the port cannot see this class of defect, which is the whole lesson.

### C2 — the allowlist never checks the channel is in the guild; the route carries no guild

Hard rule 2 says guild scope is enforced in signatures and constraints, not
caller discipline. On this path the guild survives every internal hop and then
evaporates at the last one.

Three facts compose:

1. `bananasaurs mcp allow-channel <id>` performs **no validation beyond the
   snowflake shape**. `packages/core/src/ops/commands/mcp-allowlist.ts:44`
   calls `ctx.ports.allowSendChannel` straight through to
   `mcpSendRepo.allowChannel`; there is no Discord lookup anywhere in the path,
   so nothing checks that the channel exists, that it is in this guild, or that
   it is a guild channel at all.
2. `isChannelAllowed(scope, channelId)` is correctly guild-scoped — it answers
   "is this row present under this guild", which is a different question from
   "is this channel in this guild".
3. `createDiscordRestPort.sendMessage(_guildId, channelId, …)` **ignores its
   guild argument** and posts to `POST /channels/{channelId}/messages`.

So the allowlist row is the only thing standing between a channel id and a
post, and the row is whatever the operator typed.

**Evidence.** A DM-shaped id allowlisted under guild A, driven through the real
gateway and the real REST adapter:

```
allowChannel accepted a DM id under guild A? true
isChannelAllowed(guild A, DM id)?          true
gateway outcome: {"status":"sent","messageId":"800000000000000001"}
wire: [ { "route": "/channels/700000000000000001/messages",
          "body": { "content": "@everyone club meeting moved" } } ]
```

The same holds for a channel belonging to a *different* guild the bot is in:
allowlisted under guild A, posted into guild B, audited under guild A.

**The M5-D6 retraction rests on reasoning that is not true.**
`packages/mcp/src/tools/send.ts:42` argues: "A DM can never be in
`mcp_send_allowlist`, because rows there are written per guild, so the
allowlist is where this safety property belongs." Rows are written *under* a
guild; nothing makes them *of* that guild. The retraction correctly observed
that `packages/mcp` cannot recognise a DM id — that part stands. It then
placed the property in a layer that does not hold it. `docs/17` repeats the
claim ("including a DM, which can never be on it") and PRIVACY.md states it to
members ("it cannot send you a DM").

**Severity.** This needs an operator mistake to fire, which is why it is second
and not first. But it is a mistake with no feedback: `mcp allow-channel`
accepts a wrong id cheerfully, `mcp allowlist` shows it as a normal row, and
the first symptom is a message in the wrong server. The defence the design
claims to have — "the allowlist is the guarantee" — is the one that is absent.

**Fix, in preference order.** Validate at *write* time, where a human is
present and a network call is cheap: `mcp allow-channel` resolves the channel
and refuses when `channel.guildId !== scope.guildId` or the channel is not a
guild text channel. That is one port method on the ops surface and touches
nothing frozen. Failing that, close it at the gateway with an
`isChannelInGuild` port read before the REST call. Either way, correct the
three places that assert the property.

## Important

### I3 — a failed Discord call leaves no audit row at all

`MessageAuditInput.outcome` is typed `'sent' | 'dry-run' | 'failed'`
(`message-gateway.ts:92`) and **nothing ever passes `'failed'`**. The catch
block at `message-gateway.ts:307` logs and returns; `deps.audit.record` is not
called.

**Evidence** (probe F, real storage, throwing port):

```
F: [{"status":"failed","code":"DiscordAPIError"},{"status":"replayed"}]
   row = {"idempotencyKey":"kf", …, "outcome":"sent", messageId absent}
   audits = []
   cap used = 1
```

The consequence is not cosmetic. The failure mode that matters is the one
where Discord *accepted* the POST and the response was lost — the message is
in the channel, and the audit trail says nothing happened. `mcp_sends` holds a
row, so it is recoverable, but the audit trail is the artefact
`docs/17` points the owner at and the one PRIVACY.md promises ("Every such
message is recorded"). A Discord side effect with no audit row is the gap.

Record the `failed` row. The union member already exists; the wiring already
maps `record.outcome` into `after`.

### I4 — the "no message id stored" replay text invites a duplicate post

When a replay finds a ledger row with no `message_id`, `send.ts` answers:

> "Already recorded under this idempotency key, but the first attempt stored no
> message id … Check channel X for the message; if it is absent, send again
> with a fresh key (and, within a minute of identical text, vary the text or
> wait)."

The addressee is a language model. It will not check the channel. It will do
the thing the last clause describes: wait, or vary the text, then resend.

Two ordinary paths reach that state:

- **A lost response.** Probe F above: the REST call threw after Discord may
  already have accepted it. Probe F2 confirms the follow-through — a fresh key
  with the same content, 60 s later, sends again with no refusal
  (`F2 fresh key after 60s, same content: {"status":"sent"…} restCalls=1`).
  If the first POST landed, that is the same message twice.
- **An ordinary concurrent duplicate call.** Probe A:
  `[{"status":"sent","messageId":"500000000000000000"},{"status":"replayed"}]`
  — the loser of the claim race returns `replayed` with `messageId`
  **undefined**, because it re-reads the ledger before the winner's
  `recordMessageId` has run. The message exists and has an id; the caller is
  told it does not. One REST call was made, which is correct, but the answer
  points the model at the resend path for a message that is fine.

Two things worth changing. The concurrency case is cheap to fix: on a lost
claim, the re-read can be deferred, or the answer can distinguish "another
call for this key is in flight" from "the stored row has no id". The genuine
lost-response case cannot be resolved without asking Discord, so the text
should say so plainly and stop at "ask an operator to check the channel" —
it should not hand the model a recipe that ends in a second post.

Not blocking on its own; ship it with C1 and C2.

## Minor

### M5 — the message gateway never trips the breaker, while the role gateway does

Brief question 7. The three duplicated safety *reads* are genuinely equivalent
to `gateway.ts`'s: same `readSafetyState` row, same `killswitch` /
`breakerOpen` / `dryRun` semantics, same position (kill switch and breaker
before any work, dry run immediately before the call). Probe I confirms the
kill switch refuses even a legitimate replay, which is the strict direction.

The asymmetry is on the write side: `gateway.ts` layer 8 trips the breaker on
repeated fault, and `message-gateway.ts` never calls anything that does. A
`send_message` hammering a 5xx contributes nothing to the breaker. This is
arguably correct — one owner-triggered path should not open the breaker for
moderation — but it is undocumented, and the module's M5-D1 note claims the
safety layers are duplicated equivalents. Say which of the two it is.

### M6 — no test drives `tools/call send_message` with a read-only token

Brief question 9. The behaviour is correct — probed directly against
`createMcpServer` with a read-only principal:

```
read-only tools: get_health,search_messages,…,get_server_overview
tools/call send_message result:
  {"content":[{"type":"text","text":"MCP error -32602: Tool send_message not found"}],"isError":true}
port invocations: 0
```

The port is never reached. But every test in the branch pins scope separation
through `tools/list` only; nothing pins the direct call against a name absent
from the list. That is the one route an attacker actually takes. One test.

### M7 — `mcp_sends` has no retention and is absent from PRIVACY.md's table

The ledger grows without bound and nothing sweeps it. Rows carry no content,
so the privacy exposure is small (channel, token id, timestamp, content hash),
but PRIVACY.md's new section promises "Every such message is recorded" and the
"How long it is kept" table below it was not extended. Add the row, or add the
sweep.

### M8 — whitespace-only content passes the boundary and burns a cap slot

`content: z.string().min(1).max(2000)` does not trim. `"   "` parses, claims a
ledger row, reaches Discord, and comes back as a 50006 → `failed`. The row
counts against the ten-per-hour cap (I3 means it is not audited either).
`.trim().min(1)` at the boundary.

---

# What I checked and found correct

Each of these was driven against real code — the compiled packages, real
SQLite through `openMigratedTestDatabase`, and the real REST adapter with a
recording transport — not read.

**Idempotency and double execution (hard rule 6).** The claim is before the
REST call on every path, and the entire decision sequence from
`isChannelAllowed` to `claim` is synchronous, so nothing interleaves inside
it. Two concurrent calls on one key: exactly one REST call, the loser replays
(probe A). Two concurrent calls, different keys, identical content: exactly
one REST call, the loser refused `duplicate-content-recently` (probe B) —
layer B holds under concurrency, not just sequentially. The `UNIQUE
(guild_id, idempotency_key)` constraint is present in schema and in migration
0023. A dry-run row correctly blocks a later real send on the same key
(probe H).

**The rate cap (M5-D4).** Twelve sequential sends against a ledger already
holding three: eight sent, four refused, ten rows, eight REST calls (probe C).
`dry_run` counts. Refusals do not. A replay under a full cap still answers
(probe D), which is M5-D9's point and is pinned. Moving the clock backwards
makes the cap *more* restrictive, not less (probe E) — the safe direction. The
count is durable, from rows, per guild.

**Guild partition.** Every repository function takes `GuildScope` first and
goes through `scope.only`. The allowlist primary key leads with `guild_id`;
the same channel in two guilds is two rows; `isChannelAllowed(B, chanA)` is
false. The idempotency ledger is per guild, so the same key in two guilds is
two independent sends, which is correct. (C2 is where this stops holding, and
it stops at the wire, not in the repositories.)

**Migration 0023 (M5-D5, M5-D7).** Applied 0000→0023 in order against a real
database seeded at 0022 with audit rows:

```
before 0023: ids = 1,2,3   sqlite_sequence = [{"name":"audit_events","seq":3}]
after  0023: ids = 1,2,3   sqlite_sequence = [{"name":"audit_events","seq":3}]
new row id = 4
indexes on audit_events:
  audit_tail: CREATE INDEX `audit_tail` ON `audit_events` (`guild_id`,"at" desc)
integrity: ok    foreign_key_check: []
EXPLAIN QUERY PLAN tail query: SEARCH audit_events USING INDEX audit_tail (guild_id=?)
```

Rows preserved with their `audit_id`, AUTOINCREMENT sequence preserved so ids
do not restart, `audit_tail` byte-identical to what `0000` ships and actually
chosen by the tail query. M5-D7's hand-corrected line is right and the
schema-invariants proof covers the index and not only the rows. `audit_tail`
is the only index on the table, so nothing else was lost. This was called the
riskiest step in the slice; it is sound.

**Content and rule 4.** No content in the audit row (the composed test's
absence assertion is real, and the wiring only ever writes channel, client id,
token id, outcome, message id). No content in any log line: the gateway's four
log sites pass channel, token id, dedupe key, outcome, reason, code — all in
`LOGGABLE_FIELDS` — and `safeLogFields` drops everything else. `err` is
narrowed to `{name, message}` before it reaches pino, so a raw
`DiscordAPIError`'s extra properties cannot ride along. `send.ts` does not log
at all.

**Nothing member-controlled reaches the model unescaped.** This was M4's third
Important (`get_health` interpolating a guild name raw). Every string
`send_message` renders is an id that has already passed `parseSnowflakeId` or
`parseGuildId`, plus a message id from Discord. No guild name, no channel name,
no member text. Clean.

**Scope separation.** `send_message` registers only under `bananasaurs:send`,
independently of the read-scope block, so a read-only token never sees it and a
send-only token sees only it — pinned through the real OAuth flow in
`wiring.test.ts`, and the direct-call route verified by probe (M6).

**The allowlist race.** `disallow-channel` during an in-flight send: the
message still goes out (probe G), because the decision completed synchronously
before the `await`. That window is the REST call itself and cannot be closed
without a second check that would be equally racy. By design, and the right
call.

**M5-D1's structural claim.** The send effect is a genuine sibling; it imports
nothing from `gateway.ts`, declares its own `SafetyStateForSend`, and
`gateway.ts` is untouched. The duplication is real duplication, not drift —
see M5 for the one asymmetry.

**The operator surface.** Four commands registered, the two writes in the
`--confirm`-gated section, both returning audit records. `mcp sends` renders
ids and outcomes and no content. `actorType` is `string` throughout the read
side, so the widened `mcp_operator` value renders without breaking any
consumer.

---

## Probes

The probes behind this review are transient scripts under `/tmp/m5probe/`,
not repository files: `p1` (real REST adapter wire body), `p2`/`p3` (gateway
against real SQLite — concurrency, cap, clock, failure, disallow race, dry
run, kill switch), `p4` (allowlist + real adapter, end to end), `p6`
(migration 0000→0023 with seeded rows), `p7` (read-only `tools/call`). No
repository file was modified by this review other than this report, and no
state-changing git command was run.
