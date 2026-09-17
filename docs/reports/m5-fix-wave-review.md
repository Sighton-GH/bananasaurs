# Slice M5 fix-wave re-review — Opus, 2026-09-17

Scoped re-review of the two fix waves on `oc/m5-send-message`, in the worktree
`/home/bryan/projects/bananasaurs/.oc-worktrees/oc/m5-send-message` (41 commits
off `main`). The whole-branch review's verdict was DO-NOT-SHIP on C1 and C2.

## Verdict: SHIP, with nits

Both Criticals are closed, and closed at the layer that matters — I drove the
production code rather than reading it, and in the case of C1 I drove it all
the way through the composed daemon app into the real `createDiscordRestPort`
with a recording socket. `allowed_mentions` is on the wire. Every attack I
could construct on the send allowlist — a DM-shaped id, a channel of another
guild the bot is in, a category, a thread, a row written straight through the
repository, and the guild absent from the client cache entirely — is refused
with **zero** REST calls and no ledger row.

I found no new way for a message to reach Discord that should not. The four
new findings below are all Minor and none of them blocks a merge.

## Gates, run here, one at a time

| Gate | Command | Exit | Result |
| --- | --- | --- | --- |
| typecheck | `npm run typecheck` | 0 | clean (`tsc --build --force` + `tsc -p tsconfig.all.json`) |
| lint | `npm run lint` | 0 | eslint clean, `All matched files use Prettier code style!` |
| test | `npm run test` | 0 | **173 files / 3285 tests passed**, 60.9 s |

3285 tests against the previous review's 3270: +15, which matches the tests the
fix waves added (wire body ×2, C2 send-time, C2 allow-time ×4, M5-D12 no-trip,
M6 direct call, I3 failed audit, I4 ×3, M8 ×2).

## Observe-window constraint, confirmed

```
git diff --name-only main..HEAD | grep -E 'mod/|automod/|effects/gateway.ts'   -> no match (exit 1)
git diff main..HEAD -- packages/core/src/effects/gateway.ts | wc -c            -> 0
```

`packages/core/src/effects/gateway.ts` is byte-identical to `main`. Nothing
under `packages/core/src/mod/` or `packages/core/src/automod/` is touched. The
one file in the diff with "automod" in its name is
`packages/storage/src/repos/automod-rule-lists.test.ts`, and the change is four
`notNeeded(...)` entries added to an `OpsPorts` test fixture — no production
automod code. M5-D1 is still honoured.

---

# Findings closed

## C1 — `allowed_mentions` on the wire: **CLOSED**

`packages/discord/src/rest/port.ts:447` now spreads the field as snake_case,
with a defensive copy of `parse`.

**Probe 1 — the adapter alone**, `createDiscordRestPort` with a recording
`rest` stub:

```
A body: {"content":"@everyone hello club","allowed_mentions":{"parse":[]}}
A has allowed_mentions?         true
A has camelCase allowedMentions? false
B body (nothing set): {"content":"panel post"}   keys: content
```

**Probe 2 — the whole path**, through `buildDashboardApp`, a real minted
`bananasaurs:send` token over the real OAuth flow, the real MCP transport, the
real gateway, the real repositories on real SQLite, and the real REST adapter
with a recording socket:

```
POST /channels/444444444444444444/messages
  {"content":"probe content zz9","allowed_mentions":{"parse":[]}}
```

That is the composition the daemon builds: `apps/daemon/src/index.ts:177`
creates the port, `index.ts:216` hands it to `startDashboardApi`, and
`http/wiring.ts:140` hands it to `registerMcpRoutes`. `DashboardAppDeps.discord`
is required, not optional, so a composition that forgets it does not compile.

**The trap.** `packages/discord/src/rest/port.test.ts:375` asserts on
`last(requests).body` — and `harness` replaces `makeRequest` on a real
`discord.js` `REST`, so `requests[].body` is the JSON that would have gone out
on the socket, parsed back. That is the last layer before the outside world,
which is exactly the lesson C1 taught. A camelCase key would fail the
`toMatchObject({ allowed_mentions: { parse: [] } })`, and the companion test at
:392 asserts `not.toHaveProperty('allowedMentions')` as well as
`not.toHaveProperty('allowed_mentions')`.

**Every caller that could set it.** `grep` over `packages` and `apps` finds
`allowedMentions` set in exactly one production site:
`packages/core/src/effects/message-gateway.ts:332`. The port type is
`{ readonly parse: readonly [] }`, so the empty set is the only value that
typechecks. Probe 1 case B and the committed test at :392 both confirm panel
posts and log messages still send no such key. M5-D2's opt-in is intact.

## C2 — a message reaching a channel outside the guild: **CLOSED**

Two checks, both against the guild's own channel cache:

- allow-time, `apps/daemon/src/ops/wiring.ts:550` / `isTextChannelOfGuild` at
  :718, reached by the real CLI dispatch path (`runtime/daemon.ts:406`
  `contextFor` builds `opsPortsFor` with the live client);
- send-time, `apps/daemon/src/mcp/wiring.ts:487` `isSendChannelInGuild`, wired
  into the new `MessageGatewayDeps.state.isChannelInGuild`, checked at
  `message-gateway.ts:229` as layer 1b.

**Send-time attacks.** Probe 2, composed as above, with all six ids written
**straight through `mcpSendRepo.allowChannel`** — the stale-row shape, bypassing
the allow-time check entirely — and dry run turned off so a refusal that leaked
would produce a real POST:

| Attack | Answer | REST calls | Ledger row |
| --- | --- | --- | --- |
| guild A text channel (control) | sent | 1 | `sent` |
| DM-shaped id `7000…` | refused | **0** | none |
| text channel of guild B (bot is in B) | refused | **0** | none |
| category of guild A | refused | **0** | none |
| thread in guild A | refused | **0** | none |
| guild A, but guild cleared from the client cache | refused | **0** | none |

The cross-guild case is real, not incidental: discord.js's
`GuildChannelManager` keeps its own `_cache` per guild (no `get cache()`
override in `node_modules/discord.js/src/managers/GuildChannelManager.js`), so
guild A's cache genuinely does not hold guild B's channel.

Fails **closed** when the guild is absent from cache — the last row above —
which is the direction that matters for a daemon that is not yet READY.

**Allow-time attacks**, probe 3, `opsPortsFor` with a real `Client` seeded via
`guilds._add`:

```
allowSendChannel guild A text      -> allowed          row=true
allowSendChannel guild B text      -> no-such-channel  row=false
allowSendChannel DM-shaped         -> no-such-channel  row=false
allowSendChannel guild A voice     -> allowed          row=true   (see N1)
allowSendChannel guild A category  -> no-such-channel  row=false
allowSendChannel guild A thread    -> no-such-channel  row=false
repeat guild A text                -> already-allowed
```

And the CLI command renders each outcome with an audit record:

```
cmd <guild B channel> -> text: "channel … is not a text channel of this guild; nothing changed"
                         data: {ok:false, reason:"no-such-channel", …}
                         audit.after: {outcome:"no-such-channel", …}
```

The operator now gets feedback where the original review found none.

`allowSendChannel` is called from exactly one place in production
(`packages/core/src/ops/commands/mcp-allowlist.ts:44`), and no dashboard route
reaches it — see N2 for the structural caveat.

## I3 — a failed Discord call writes an audit row: **CLOSED**

Probe 4, composed path, `rest.post` throwing a `DiscordAPIError`-named error:

```
audit rows: 1
  {"action":"mcp.message.sent","actorType":"mcp_operator","dryRun":0,
   after:{"clientId":"cli_…","tokenId":"tok_…","outcome":"failed"}}
any audit row containing the content? false
ledger row: {"idempotencyKey":"kf", …, "outcome":"sent"}   (no messageId)
cap used: 1
```

Exactly one row, `outcome: 'failed'`, no `messageId`, no content, `dry_run` 0.
The unit test at `message-gateway.test.ts:545` pins it with a unique content
string and `JSON.stringify(audits[0]).not.toContain(secret)`.

## I4 — the replay-without-id text: **CLOSED**

Read as a model would read it, the new text contains no recipe that ends in a
second post. Probe 4, the real replay state (first attempt threw, ledger row
has no message id):

> Already recorded under this idempotency key, but the first attempt stored no
> message id, so the message may or may not have been posted to channel
> 444444444444444444: nothing new was posted by this call. Check channel
> 444444444444444444 for the message before retrying, and if you retry, reuse
> this same idempotency key — never a fresh one.

No "fresh key", no "vary the text", no "wait" — the three clauses the old text
offered. The `failed` message got the same treatment and no longer claims
"nothing was posted", which it could not know.

It still distinguishes the two `replayed` cases; both driven, not read:

```
replay WITH an id:    "Already sent under this idempotency key as message 900000000000000001: …"
replay WITHOUT an id: "…stored no message id, so the message may or may not have been posted…"
```

`send.test.ts:245` pins the difference (`withId` contains the message id,
`withoutId` does not, and the strings differ).

## M5 — breaker asymmetry: **CLOSED**

Documented in the module header (`message-gateway.ts:45-56`) and as ruling
M5-D12 in the plan, and pinned by
`message-gateway.test.ts:357` — a `tripBreaker` spy on the fake `state`, ten
sends, the capped eleventh, a breaker-open refusal, and `expect(trips).toHaveLength(0)`.
The test fails if anyone threads a trip through `deps.state`.

Driven end to end as well, probe 4: twelve failing sends through the composed
app left `breakerOpen: false`, `breakerReason: null`, with the rate cap
correctly exhausted at 10.

Caveat, not a finding: the pin only catches a trip routed through
`deps.state.tripBreaker`. A future trip written through `guildRepo` in the
daemon wiring would slip past it. That is a narrow pin, but it is the pin the
ruling asks for, and the gateway's doc comment is the real guard.

## M6 — read-token direct `tools/call`: **CLOSED**

`apps/daemon/src/mcp/wiring.test.ts:310` calls `tools/call send_message` with a
read-scope token minted through the **real** authorize/consent/exchange flow on
the app `buildDashboardApp` builds, asserts `isError` with `-32602`, and asserts
`fakeDiscord.restCalls('sendMessage')` is empty. That is the real composition,
and it is the route an attacker takes rather than `tools/list`.

## M7 — `mcp_sends` in PRIVACY.md: **CLOSED, and the row is true**

The new row claims the record "holds the channel, the time, which credential
sent it, and a fingerprint of the text — **not the message itself**", kept
indefinitely. Checked against the schema (`packages/storage/src/schema.ts:1689`):
`guild_id, idempotency_key, channel_id, content_hash, message_id, token_id,
sent_at, outcome` — no content column. `content_hash` is a SHA-256 of
`channel\0content` (`contentHashFor`), confirmed in the probe output as a
64-hex digest. "Kept indefinitely" is true: `mcpSends` appears nowhere outside
`schema.ts` and its own repository, and no sweep or retention job deletes from
it.

## M8 — untrimmed content: **CLOSED**

Trimmed at the boundary, before the guild gate and before the port call, so
nothing is claimed. Probe 4, composed path:

```
whitespace-only ("   \n\t  "): isError=true "Invalid arguments for this tool."
  REST calls 0 | ledger row none | cap delta 0
padded ("  padded body  "): sent
  wire body {"content":"padded body","allowed_mentions":{"parse":[]}}
```

The content that is hashed, stored and posted are all the same trimmed string.

## The stale comment in `packages/mcp/src/tools/send.ts`: **CLOSED**

Each claim checked against code I ran:

| Claim | True? |
| --- | --- |
| this layer has no DM branch and cannot have one — `McpSendPort` exposes no channel-type lookup | true; the interface at :70 has only `send` |
| the old "a DM can never be in `mcp_send_allowlist` because rows are written per guild" argument is false | true, and the comment now says so explicitly |
| `mcp allow-channel` refuses a channel that is not a text channel of that guild, so the row cannot be written | true for the CLI path (probe 3); see N1 for the one imprecision |
| the send path checks guild membership again before posting | true (probe 2) |
| both are checked against the guild's own channel cache rather than inferred from an id | true |

`docs/17`'s "including a DM, which can never be on it" and PRIVACY.md's "it
cannot send you a DM" are now backed by two enforced checks rather than by an
argument from the schema.

## Did the fixes break anything? **No**

Re-driven on the composed path after the Critical fixes, because those fixes
touched the gateway and the ops wiring:

- **Idempotency ordering (M5-D9)** — source order is unchanged: idempotency
  read → identical-content window → rate cap → claim → dry run → REST. The new
  C2 check sits at layer 1b, before the safety-state read, so it refuses rather
  than bypasses.
- **Claim before the REST call (hard rule 6)** — unchanged, and two concurrent
  calls on one key still produce exactly **one** wire call, with the loser
  replaying.
- **The rate cap counts what M5-D4 says** — 1 sent + 3 dry-run = 4; three
  refusals still 4; filling to 10 caps; and a replay under a full cap still
  answers.

One behaviour change worth naming, deliberate and in the safe direction: layer
1b runs before the idempotency read, so a *replay* of an earlier successful send
is now refused while the channel is absent from the cache (for example between
process start and READY) instead of replaying. Fail-closed, and see N3 for the
text it produces.

---

# New findings

All Minor. None blocks the merge.

### N1 — a voice or stage channel is accepted as "a text channel of this guild"

`isTextChannelOfGuild` and `isSendChannelInGuild` both end in
`channel.isTextBased() && !channel.isThread()`, and discord.js implements
`isTextBased()` as `'messages' in this`
(`node_modules/discord.js/src/structures/BaseChannel.js:130`).
`BaseGuildVoiceChannel` constructs a `GuildMessageManager` as `this.messages`
(`BaseGuildVoiceChannel.js:21`), so voice and stage channels pass. Driven:
`allowSendChannel guild A voice -> allowed`, and probe 2 posted into it.

This is **not** a C2 breach — the channel is in the guild, the guild partition
holds, and posting to a voice channel's text chat is a legitimate thing an
owner might allowlist. It is a documentation mismatch: three comments and
`docs/17` say "text channel", and the code means "text-capable". Forum and
category channels are correctly refused. Smallest fix: say "text-capable
channel (including a voice channel's chat)" in the comments, or narrow to
`channel.type === ChannelType.GuildText || GuildAnnouncement` if the owner wants
voice chat excluded. A decision, not a defect.

### N2 — the allow-time guard lives in one implementation of `OpsPorts`, not in the type or the repository

Hard rule 2 asks for guild scope enforced in signatures and constraints rather
than caller discipline. The allow-time half of C2 is enforced inside
`opsPortsFor`'s implementation of `allowSendChannel`. A second implementation of
the same interface already exists without it —
`packages/http/src/test-support.ts:497` writes the row with no membership check,
with a comment explaining that ADR 0014 forbids importing a Discord client
there. Today nothing reaches it but tests, and the send-time check contains any
row it could write, so this is contained rather than open.

But it is the same shape as C1: a property held one layer above where it
matters, invisible to the type system. If the dashboard ever grows an
allowlist route, it gets the unguarded implementation and nothing fails.
Smallest fix: none required now; if you want it structural, make
`mcpSendRepo.allowChannel` take a `channelIsInGuild: boolean` (or a resolved
channel) so the check cannot be skipped by any caller.

### N3 — a stale or uncached channel is reported to the model as "not on the send allowlist"

`apps/daemon/src/mcp/wiring.ts:601` maps the gateway's `channel-not-in-guild`
onto `channel-not-allowlisted` because the `McpSendRefusal` vocabulary is
frozen. The model is then told to ask the owner to run
`bananasaurs mcp allow-channel <id> --confirm` — which, for exactly these ids,
answers `no-such-channel`. Probed: with guild A cleared from the cache, an
allowlisted channel answers *"Channel 444… is not on the send allowlist"*.

Harmless (fail-closed, no loop, and the daemon log carries the true reason
`channel-not-in-guild`), but it sends the operator round a circle during the
one window this is most likely to happen in: the seconds after a restart before
READY. Smallest fix: one more `McpSendRefusal` member with its own text, or
append "if the owner has already allowed it, the bot may not yet see the
channel — retry shortly" to the existing string.

### N4 — `mcp sends` shows a failed attempt as `sent`

The ledger's CHECK is `outcome IN ('sent','dry_run')`, so the claim written
before the REST call stays `sent` when the call throws; the `failed` outcome
now exists only in the audit trail. `mcp sends` therefore renders a lost or
rejected POST as `… sent channel … token …` with no message id. The missing
message id is the tell, and `mcp audit` has the truth, but the operator's
first-stop surface reads as a success. Smallest fix: render a row with no
message id as `sent?` (or `unconfirmed`) in the command's text, which needs no
migration.

---

# The eighth composition defect: where else does this branch assert a property one layer too high?

The honest answer for the new code is: nowhere that reaches Discord. I looked
at every property on the branch that has an outside-world consequence.

- **The wire body.** Now asserted at the socket
  (`port.test.ts` `harness` replaces `makeRequest` on a real `REST`). This is
  the last layer, and the fix wave moved the assertion there rather than adding
  a second one above it.
- **Guild membership.** Asserted against a real discord.js `Client` with guilds
  injected through `guilds._add`, in both `ops/wiring.test.ts` and
  `mcp/wiring.test.ts` — real `GuildChannelManager` caches, not a hand-rolled
  `{ guilds: { cache: new Map() } }`. That is the layer that answers in
  production. I checked the production cache configuration too, since a
  fail-closed check against an empty cache would be a silent outage rather than
  a silent leak: `GuildChannelManager` is in `UNLIMITABLE_CACHE_MANAGERS`, is
  absent from `CACHE_LIMITS`, `buildSweeperSettings` sweeps only messages and
  users, and `GatewayIntentBits.Guilds` is required — so the cache is populated
  and unswept.
- **Scope separation.** Pinned through the real OAuth flow and the real
  transport, including the direct-call route (M6).
- **The audit row and the ledger.** Real SQLite through
  `openMigratedTestDatabase`, asserted on rows.
- **The remaining seam** is N2 — a port *interface* whose guarantee lives in one
  of its two implementations. It is the same class of defect as C1, one level
  further out, but the send-time check is a genuine second gate at the last
  layer before the REST call, so nothing rides on it today.

One thing the branch still does not pin, unchanged by these waves and not worth
a test on its own: no test composes `createDiscordRestPort` with the MCP
wiring — the composed send test injects `FakeDiscord`. The two halves are each
pinned at their own last layer, and `DashboardAppDeps.discord` is a required
field, so the gap is a typechecked two-line wiring in `index.ts`. I closed it
by hand in probe 2 and it holds.

---

## Probes

Transient scripts under `/tmp/m5fix/`, not repository files:
`p1.mjs` (the REST adapter alone, recording `rest` stub, wire bodies),
`p2.mjs` (the full composed app — real OAuth, real MCP transport, real
repositories on real SQLite, real REST adapter with a recording socket — six
C2 attacks plus the cache-cleared case),
`p3.mjs` (`opsPortsFor.allowSendChannel` and the CLI command against a real
`Client`),
`p4.mjs` (I3, I4, M8, M5 breaker, on the composed path),
`p5.mjs` (concurrency, cap accounting, replay under a full cap).

No repository file was modified by this review other than this report, and no
state-changing git command was run.

## RESULT

Status: APPROVED_WITH_NITS
Findings closed: 9 of 9 — C1, C2, I3, I4, M5, M6, M7, M8 and the stale comment
New findings: Minor N1 voice/stage channels pass the "text channel" check
(in-guild, so not a C2 breach — a comment/doc mismatch); Minor N2 the allow-time
guard lives in one `OpsPorts` implementation and the `packages/http` one has no
check; Minor N3 an uncached channel is reported to the model as "not on the
send allowlist", sending the operator to a command that will refuse it; Minor
N4 `mcp sends` renders a failed attempt as `sent`
Gates: typecheck 0, lint 0, test 0, 173 files / 3285 tests
Constraint: moderation paths clean — `gateway.ts` byte-identical to `main`,
nothing under `mod/` or `automod/` touched
Concerns or questions: N1 is the only one that wants an owner decision — should
`mcp allow-channel` accept a voice channel's chat, or be narrowed to text and
announcement channels?
