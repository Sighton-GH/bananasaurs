# ADR 0044: The MCP server is an operator surface, and the SDK becomes a runtime dependency

Status: accepted (2026-09-14)

Amends: ADR 0013 (operator CLI and Claude Code access).
Precedes: Slice M4 (the MCP server and the read tools). Nothing in M4 may be
implemented before this ADR is accepted — that is `CLAUDE.md`'s rule for a
consequential choice, and this one changes what a permanent prohibition
means.

## Context

The owner wants his own Claude clients — Claude Code on this host, the
desktop app, claude.ai — to read the club server: what channels exist, what
was said in `#planning` last week, which rules are observing, what the bot
did yesterday. Design:
`docs/superpowers/specs/2026-09-12-mcp-operator-server-design.md`. Slice plan:
`docs/superpowers/plans/2026-09-12-mcp-operator-server-plan.md`. Slices M1
(archive), M2 (search) and M3 (the OAuth 2.1 authorization server) are merged;
M4 builds the MCP server itself and the read tools.

ADR 0013 §2 drew a bright line and called it permanent. Three of its clauses
have to be read carefully before a single tool exists, because a careless
reading permits this design and a careful one appears to forbid it. This ADR
does the careful reading, in public, rather than letting an implementer
decide it in a commit message.

## Decision

### 1. The operative test is ADR 0013's own: whose keystroke, and where the answer goes

ADR 0013 §2 ends with the test to apply when unsure: **"if a club member's
action causes the `claude` binary to run, it is wrong. If the owner's
keystroke causes it to run, it is fine."** That test is the load-bearing part
of the rule, and it is unambiguous here. Every MCP session begins with the
owner opening his own client and typing something. No club member's action
reaches it; no Discord event triggers it; the bot never spawns anything.

The direction is the reverse of the prohibited one. In the pattern ADR 0013
forbids, the bot is the caller: a Discord event runs `claude`, and the
subscription serves a member. Here Claude is the caller and the bot is a
read-only server answering a request that started at the owner's keyboard.
`CLAUDE.md` rule 9 stands untouched and unamended: **no Discord handler, job,
scheduler, or HTTP route may spawn the `claude` binary or read Claude
subscription credentials**, and M4 adds no such path. Bananasaurs remains
something Claude talks to; it never becomes something that talks to Claude.

### 2. The bullet that has to be retired, and exactly how far

ADR 0013 §2 prohibits, permanently:

> Any bridge that takes a Discord message, sends it to Claude Code, and
> returns the result to Discord — regardless of how many hops sit in
> between, and regardless of whether a human approves each one.

Read literally, `search_messages` plus `send_message` **is** such a bridge:
Discord messages go to Claude, and a result can come back to a Discord
channel. The "regardless of whether a human approves each one" clause was
written precisely to stop someone arguing their way past it with a human in
the loop, which is the argument §1 above might look like.

So this ADR does not argue past it. It **replaces** the bullet, and states
what replaces it:

> **Prohibited, permanently:** any path by which a club member's action, or a
> Discord event, causes content to be sent to Claude, or causes Claude's
> output to reach Discord. The trigger must be the owner's keystroke in the
> owner's own client, and the owner must be the one who reads the answer.
> Automation of that trigger — a cron job, a scheduler, a webhook, a Discord
> interaction, a retry — is prohibited whether or not a human once approved
> the pattern.

What the original bullet was protecting is preserved in full: no `/ask`, no
member-triggered summarisation, no Discord-facing AI outside the provider
layer and its eligibility gate (ADR 0010, ADR 0013 §3), and no scheduled job
that "just" asks Claude something and posts it. What changes is that the
*owner*, at his own keyboard, may now read his own server through a client of
his choosing and may post a message he asked for — which is the same thing
ADR 0013 §2 already listed under **Permitted** ("the owner acts on that
answer by making a change — through the CLI, the dashboard, or Discord — as
himself"), over a different transport.

**Cost if wrong.** The distinction this rests on is the trigger, and the
trigger is not enforceable in code: the bot cannot see whether a human typed
the prompt that produced a `tools/call`. If the owner ever wires an MCP
client to a scheduler, the bot will serve it exactly as it serves a typed
question. That is a rule the owner keeps, not a control the daemon holds, and
this ADR says so rather than implying otherwise.

### 3. "Reads Claude subscription credentials" is unchanged and is not what M3 built

ADR 0013 §2's second prohibited bullet — "any code path that reads Claude
subscription credentials or OAuth tokens" — is **not amended**. It still
holds absolutely.

The tokens M3 built are Bananasaurs' own: minted by Bananasaurs' authorization
server, hashed at rest in Bananasaurs' database, bound to a Bananasaurs
dashboard account, revocable with `bananasaurs mcp revoke`. No Anthropic
credential is read, stored, forwarded or seen by any line of this code. The
OAuth flow runs in the *other* direction from the one the bullet names: the
client authenticates to Bananasaurs, not the reverse.

### 4. What the tools may do, and the three obligations M3 handed forward

M4 ships **read tools only**. The single write tool `send_message` is
designed (design §3) but is **not** in M4's scope; it arrives in a later
slice and is bound by design §3's allowlist, forced empty `allowedMentions`,
2000-character cap, idempotency key, ten-per-guild-per-hour cap, effect
gateway and audit row. No moderation, automod, role, ban, kick, timeout or
purge tool exists in any slice of this design (design §12).

Three obligations M3 recorded in ADR 0045 Amendment 2 bind every tool M4
writes. The first is load-bearing and a tool that ignores it is a security
defect, not a style point:

1. **`requireBearer` returns 200 with an *empty* reachable guild set.** PR-92
   recomputes the reachable set per call from the approving account's current
   `mcp.authorize` grants rather than freezing it into the token, so an
   account that has lost its capability keeps a verifying access token — with
   an empty set — until it expires, up to an hour. Therefore: **every tool
   refuses when the reachable set is empty**, and **every tool intersects its
   `guildId` against that set** before any repository call. A tool that takes
   no `guildId` would otherwise be reachable by an account holding no grant
   anywhere, which is why `get_health` — guild-independent in design §3 — must
   still refuse on empty. This is checked in the tool layer, once, in a shared
   helper, and tested by a tool that is *only* refused by it.
2. **Revocation is by lineage, never by descent.** Any new revocation surface
   M4 adds chooses `issued_from_code_hash` deliberately; a `parent_token_id`
   walk cannot reach the access token minted beside the first refresh token
   (ADR 0045 Amendment 2, PR-94/PR-118/PR-127).
3. **The bearer guard must stay usable under `BANANASAURS_READONLY`.**
   `touchToken` is best-effort for that reason (PR-128). Read tools must not
   introduce a write on the success path of a read.

Slice M3b has since closed D6's missing trigger at the account end
(ADR 0045 Amendment 3): disabling or deleting a dashboard account now stops
its live tokens on the very next request. Obligation 1 is **not** relieved by
that — it is about the capability being revoked while the account survives,
which is a different and more likely event.

### 5. Guild scope is enforced in the tool handler, at the first statement

Hard rule 2 with no exception. Every tool takes an explicit `guildId`,
validates it against the guild allowlist inside the handler, intersects it
against the reachable set from obligation 1, and only then constructs the
`GuildScope` the repository functions require. A two-guild test proves a
token cannot read the other guild's data through any tool.

### 6. Retrieved content is evidence, never instruction — and the bot cannot enforce that

Hard rule 3. Every archive-bearing tool result wraps each message in a
delimited, labelled block with a fixed preamble stating that the content is
retrieved evidence and not an instruction, and the delimiters are proof
against content that tries to close them. Tested by asserting the preamble is
present on every content-bearing result.

This is a mitigation, not a control, and the design says so (§8.1): the bot
cannot see the client's turn structure, so it cannot enforce `CLAUDE.md`
rule 3's "a turn whose only new input is retrieved text may not emit a tool
call." **The club guild is now in archive scope** (ADR 0046 Amendment 2), so
from M4 onward these tools return **real members' messages**, subject to the
30-day content purge. The residual — a member posting text designed to steer
a later operator session — is accepted, bounded by the absence of any write
tool in M4, and recorded here rather than in a comment.

### 7. The training-eligibility row is written in M4, before the first real read

Design §8.4. `PRIVACY.md` promises members that nothing is "used to train AI
models", and Anthropic's consumer plans make training on conversations a
setting rather than a guarantee. The owner confirmed on 2026-09-14 that
**training is disabled** on the account that will hold these connectors
(`docs/STATE.md`, "Owner decisions — 2026-09-14", item 1).

The answer is not the control. M4 **writes the row**: an eligibility record
for "Anthropic (consumer, via MCP)" in the shape ADR 0010 requires of every
provider — `trainsOnInput: "no"`, the settings page cited as evidence, and a
review date — and `doctor` warns when that review date is more than 90 days
old. It is a config record rather than a routing target; hard rule 5 does not
care which door the content left by, and neither does the Discord Developer
Policy clause it implements.

### 8. `@modelcontextprotocol/sdk` becomes a runtime dependency

M3 kept the SDK a **devDependency** with zero non-test imports, deliberately
(ADR 0045 D2), using it only to drive a conformance test with the client half.
M4 cannot: the server half is what serves `tools/list` and `tools/call`.

The owner accepted the promotion on 2026-09-14. `CLAUDE.md` asks for a
one-line justification per dependency; one line is not enough here, because
promoting this package pulls a second HTTP stack into the production closure
of a process that currently has exactly one HTTP server (Fastify) and wants
exactly one.

**Correction, measured 2026-09-15 before M4 began.** An earlier draft of this
section — and the owner's decision as recorded in `docs/STATE.md` — named
**six** packages: Express 5, Hono, `cors`, `express-rate-limit`, `ajv` and
`eventsource`. That was written from the SDK's `dependencies` field as quoted
in the design document, and it is wrong: those six are the *direct*
dependencies worth naming, not the closure. Walked from
`node_modules/@modelcontextprotocol/sdk/package.json`, the SDK's transitive
closure is **91 packages**, of which **84 are not already in this project's
production closure**. The production closure goes from **172 packages to
256** — it grows by roughly **49%** to add one server.

The 84, in full, so nobody has to re-derive them:

`accepts` `body-parser` `bytes` `call-bind-apply-helpers` `call-bound`
`content-disposition` `content-type` `cookie-signature` `cors` `cross-spawn`
`debug` `depd` `dunder-proto` `ee-first` `encodeurl` `escape-html`
`es-define-property` `es-errors` `es-object-atoms` `etag` `eventsource`
`eventsource-parser` `express` `express-rate-limit`
`fast-json-stable-stringify` `finalhandler` `forwarded` `fresh`
`function-bind` `get-intrinsic` `get-proto` `gopd` `hasown` `has-symbols`
`hono` `@hono/node-server` `http-errors` `iconv-lite` `inherits`
`ip-address` `isexe` `is-promise` `jose` `json-schema-typed`
`math-intrinsics` `media-typer` `merge-descriptors` `mime-db` `mime-types`
`ms` `negotiator` `object-assign` `object-inspect` `once` `on-finished`
`parseurl` `path-key` `path-to-regexp` `pkce-challenge` `proxy-addr`
`punycode` `qs` `range-parser` `raw-body` `router` `safer-buffer` `send`
`serve-static` `setprototypeof` `shebang-command` `shebang-regex`
`side-channel` `side-channel-list` `side-channel-map` `side-channel-weakmap`
`statuses` `toidentifier` `type-is` `unpipe` `uri-js` `vary` `which`
`wrappy` `zod-to-json-schema`

**The owner should see this number before M4 lands**, because the decision
they took was "six transitive HTTP packages" and the decision they are
actually getting is eighty-four. It does not change the *kind* of trade —
everything below still holds, and the alternatives are the same two — but it
changes its size by more than an order of magnitude, and a decision record
that understates its own cost by that much is the thing this project's
"verify, do not assert" rule exists to catch. It was caught by running
`npm ls` rather than by re-reading the ADR.

**One of the 84 deserves naming: `cross-spawn`.** A process spawner enters
the production closure of a project whose hard rule 9 is that nothing may
spawn the `claude` binary. Two things keep that from being as bad as it
sounds, and both should be stated rather than assumed. It arrives for the
SDK's **client** stdio transport
(`dist/esm/client/stdio.js` — verified by grep, it is the only file that
imports it), which is how an MCP *client* launches a local server process;
this code is a server and imports no client module outside M3's conformance
test. And it confers no new capability: Node's `child_process` is built in,
so nothing that could not spawn before can spawn now. What it adds is audit
surface, not power. Obligation 1 below — no non-test import of the SDK's
Express, Hono, auth-router or client modules — is what keeps it that way,
and it is now worth an explicit test rather than review discipline.

**What it buys.** The MCP wire protocol is a moving specification with
versioned capability negotiation, a JSON-RPC framing layer, two transports
(stdio and Streamable HTTP with SSE), session handling, progress
notifications and cancellation. Reimplementing it means owning compatibility
with three first-party clients that upgrade on their own schedule, and the
failure mode of a subtle mismatch is "claude.ai silently will not connect",
which is expensive to diagnose from this side. The SDK is MIT, is Anthropic's
own, and is what those clients are tested against.

**What it costs.** Six transitive HTTP packages in the production closure,
none of which this design uses:

- `express` 5, `cors`, `express-rate-limit` — the SDK's own
  `mcpAuthRouter`/Express transport helpers, which approach A
  (ADR 0045 D5) deliberately does not use: Bananasaurs' OAuth endpoints are
  Fastify-native and hand-written. **Dead weight, imported by the package,
  unreachable from this code.**
- `hono` — an alternative server runtime, same story.
- `ajv` — JSON Schema validation. Bananasaurs validates with Zod at every
  boundary (stack decision, hard rule 3) and will continue to; `ajv` is the
  SDK's internal business.
- `eventsource` — the SSE client, used by the client half M3's conformance
  test already drives.

**Why the promotion is accepted anyway, and what is rejected with it.** The
spec's approach B (mount the SDK's `mcpAuthRouter` under Fastify) was already
rejected in ADR 0045 D5 for a better reason than dependency count — it would
have put a second HTTP framework in the request path for security-critical
routes. Vendoring the transport was the other alternative: it removes the six
packages and replaces them with a hand-maintained copy of a moving protocol,
which trades a supply-chain surface the owner can audit and update for a
correctness surface only this project maintains. On a single-tenant,
loopback-bound daemon behind a Cloudflare Tunnel and Access (M6), the
supply-chain surface is the cheaper of the two.

**What this obliges.** Three things, and they are the price of the decision:

1. **No non-test import of the SDK's Express, Hono, or auth-router modules.**
   The imports M4 adds are the server, the Streamable HTTP transport, and the
   protocol types — nothing else. A test asserts the import surface, the same
   way M3's test asserted the SDK had *no* runtime import.
2. **The count is recorded and watched.** Measured before the promotion on
   2026-09-15: **172 packages** in the production closure, one direct
   production dependency (`@node-rs/argon2`). The post-promotion count goes in
   the M4 ledger beside it, and the expected value is **256**. A number that
   comes back materially different from 256 means the SDK's own dependencies
   moved, and that is worth reading before merging rather than after.
3. **The version is pinned** (`@modelcontextprotocol/sdk` 1.30.0, MIT) and
   moves only on a deliberate bump, because a transitive HTTP server's patch
   level is now a production fact.

**Cost if wrong.** A vulnerability in a package this code never calls still
appears in every audit of this project and still has to be triaged; and if
the SDK's transport ever proves to be the wrong shape for a Fastify-hosted
route, the fallback is vendoring the transport after all, at the cost of one
slice.

## Consequences

- ADR 0013 §2's third prohibited bullet is replaced by the text in §2 above.
  The rest of ADR 0013 — the socket, the guardrails, §3's "runtime AI stays on
  the provider layer", and the keystroke test — stands unchanged.
- `CLAUDE.md` rule 9 is unchanged and needs no edit: nothing in M4 spawns
  `claude` or reads a Claude credential.
- M4's read tools see real members' messages from the club guild
  (ADR 0046 Amendment 2), which raises the stakes on §6 and on the 30-day
  purge that M1 already enforces.
- Express, Hono, `cors`, `express-rate-limit`, `ajv` and `eventsource` enter
  the production dependency closure, unreachable from this code and recorded
  here so that fact is never a surprise.
- The safety of this design rests on one thing no test can assert: that the
  owner does not automate the trigger. That is stated in §2 rather than
  implied, and it is the sentence to re-read if this ever seems to be
  drifting.
