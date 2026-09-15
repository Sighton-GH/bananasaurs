# 0045 — The OAuth authorization server is Fastify-native, and its tables are instance-level

Status: accepted
Date: 2026-09-13
Precedes Slice M3 of
`docs/superpowers/plans/2026-09-12-mcp-operator-server-plan.md` (design:
`docs/superpowers/specs/2026-09-12-mcp-operator-server-design.md` §5, §8.3).
Depends on ADR 0006 (one process, do not split into services), ADR 0008
(Fastify, SQLite, Zod at every boundary), ADR 0012 (dashboard accounts are
local Argon2id accounts), ADR 0027 (instance-level storage scope), ADR 0028
(a dashboard account is a principal holding an explicit capability set).
Constrained by `CLAUDE.md` rules 2, 4, 7 and 8.

## Context

M3 makes the bot an OAuth 2.1 authorization server, because the Claude
desktop app and claude.ai will only add a remote MCP server as a custom
connector if it offers OAuth 2.1 with PKCE, dynamic client registration and
authorization-server metadata discovery. M3 is the authentication boundary
for everything M4–M6 expose, and the plan does not run it lean.

Four facts, verified against this tree and the live registry on 2026-09-13
rather than recalled:

1. **The SDK is permissively licensed.** `npm view @modelcontextprotocol/sdk`
   reports **1.30.0, MIT**, matching what the design recorded on 2026-09-12.
   Hard rule 7 is satisfied with a one-line dependency justification.
2. **The SDK is not installed.** There is no `@modelcontextprotocol/sdk` in
   `node_modules` and no mention of it in any `package.json` in the
   workspace. M3 is the slice that introduces it, so the terms on which it
   enters are M3's decision to make and not an inherited one.
3. **The SDK's auth router is Express-shaped.** The design records that
   `server/auth/router.js` composes the OAuth handlers for Express, and that
   the package depends on `express@5`, `hono`, `@hono/node-server`, `cors`,
   `express-rate-limit`, `ajv` and `eventsource`. Installing it therefore
   puts two more HTTP frameworks into the dependency closure whether or not
   a line of their code ever runs.
4. **`INSTANCE_LEVEL` holds exactly two tables today.**
   `packages/storage/src/schema-invariants.test.ts:43` exempts
   `dashboard_accounts` and `bootstrap_tokens` from the guild-partition
   invariants, with a comment saying that adding to the list requires
   editing the file deliberately. M3 adds **three** tables to it —
   `oauth_clients`, `oauth_authorization_codes`, `oauth_tokens` — which more
   than doubles the set of tables that ADR 0004's database-level guard no
   longer covers. That is the part of M3 most worth writing down.

Reading the invariants rather than assuming them: the `every table is
STRICT` block loops **all** tables, so an instance-level table is still
required to be STRICT; only the `guild_id TEXT NOT NULL` requirement, the
composite-foreign-key requirement and the snowflake CHECK are lifted by the
exemption.

## Decision

**D1 — Approach A is binding: the SDK carries the MCP protocol, Fastify
carries OAuth.** The six OAuth endpoints — the two metadata documents,
authorize, token, register, revoke — plus the consent page are native
Fastify routes with Zod at every boundary, implemented against the shape of
the SDK's `OAuthServerProvider`, with clients, codes and tokens in SQLite.
The auth code sits beside `packages/http/src/policy.ts`, where the origin
and CSRF rules already live, and reuses them for the consent form.
Approach B (mount `mcpAuthRouter` through `@fastify/middie`) stays the
documented fallback, with an explicit trigger: **if the route layer exceeds
its estimate by more than one session, switch.** The provider
implementation is identical under both, so the switch is a routing change
and not a rewrite. Cost if wrong: one session, and the fallback is
pre-argued.

**D2 — the SDK enters M3 as a devDependency, not a runtime one.** M3 needs
it for exactly two things: the provider interface's shape at the type level,
and the conformance run that drives the real client against the daemon.
Neither runs in the daemon. Making it a devDependency keeps Express 5 and
Hono out of the production dependency closure while still buying the test
that matters — the one that proves the server speaks the protocol the Claude
clients actually speak, rather than the protocol we believe the RFCs
describe. M4 promotes it to a runtime dependency of `packages/mcp`, where
the transport genuinely executes SDK code. Justification for the dependency
record: *the reference implementation of the protocol this server must
speak, MIT, used at M3 only for its type surface and its conformance
client.* Cost if wrong: if the SDK's provider interface turns out to be
unusable as a type-only import, the interface is re-declared locally in one
file and the conformance test keeps the devDependency alone.

**D3 — the three OAuth tables are instance-level, and the guard that
replaces the partition key is named.** A token is issued to a dashboard
account and a registered client; it is not issued for a guild, and it must
not be, because M4 resolves the guild **per tool call** against the
allowlist and refuses a guild the bot is not in. Putting a `guild_id` on a
token would create exactly the thing ADR 0004 exists to prevent — a second,
weaker place where guild scope is decided, ahead of and out of sight of the
call that uses it. So all three tables go into `INSTANCE_LEVEL` with a
one-line reason each, they stay STRICT, and three positive tests replace
what the exemption lifts:

- no OAuth table has a `guild_id` column (so a later migration cannot
  quietly re-introduce guild scope at the token layer);
- `INSTANCE_LEVEL` contains exactly the five expected names (so a fourth
  table cannot be added to the exemption without a test failing and a human
  reading this ADR);
- a token's scopes are checked at the call and never carry a guild.

Cost if wrong: the second test is the tripwire, and it fails loudly.

**D4 — lifetimes and hashing are the design's, with the owner's default
taken.** Access 1 hour, refresh 30 days rotating on use, authorization code
5 minutes and single-use; opaque high-entropy random values hashed with
SHA-256 at rest, never Argon2 — the values are not low-entropy secrets and
Argon2 would tax every request. §11 Q3 went unanswered and its stated
default was taken at M1; ADR 0046 records that. Cost if wrong: the desktop
app re-authenticates more often than the owner likes, and the lifetime is
one constant.

**D5 — a replayed authorization code revokes the token it already
minted.** Single-use is not enough on its own: if a code is presented
twice, the correct response under RFC 6749 §4.1.2 is to refuse the second
exchange *and* kill the access and refresh tokens issued from the first,
because a replay is evidence the code leaked. The same rule applies to a
refresh token presented after rotation. Cost if wrong: a user who
double-submits loses a session and re-authorizes.

**D6 — the consent page borrows the dashboard's verifier and not its
session.** It authenticates with the same Argon2id account check
`packages/http/src/auth.ts` uses, and requires the `mcp.authorize`
capability (ADR 0028). It does not accept a dashboard session cookie as
proof, because that would make an open dashboard tab sufficient to mint an
OAuth token, and the two systems' session lifetimes are unrelated. A token
is therefore never stronger than the account that approved it, and revoking
the account revokes everything it approved. Cost if wrong: the owner types
a password at each authorization, which is the intended friction.

**D7 — dynamic registration is open but narrow.** `POST /oauth/register` is
unauthenticated, as RFC 7591 requires for the desktop app to work at all,
and is therefore rate-limited and restricted to redirect URIs that are
`https://` or loopback. A registered client can do nothing until an account
holding `mcp.authorize` approves it at the consent page, so registration
grants no capability by itself. Cost if wrong: a junk `oauth_clients` row,
removable with `bananasaurs mcp revoke-client`.

**D8 — the log surface is the client id and the token id, never a value.**
`LOGGABLE_FIELDS` gains `oauth_client_id` and `oauth_token_id`, each with a
comment saying why it is safe. Pino redaction is an allowlist (rule 4), so
a token value has no path into a log line by default; a test that greps a
captured log stream for a raw token or code and fails on a hit makes that a
guarantee rather than a property of the current call sites.

## Consequences

M3 is the largest single chunk of new code in this design and the one with
the least tolerance for a passing test that proves nothing. Seven red tests
come before any route exists, and each of them is a refusal: wrong client,
replayed code, `plain` PKCE, rotated refresh, revoked token, an account
without `mcp.authorize`, an unregistered redirect URI. A boundary is only
worth what its refusals are worth, so each of those is watched failing
before the route that satisfies it is written.

The dependency closure grows by one MIT package at dev time and by nothing
at runtime until M4. `INSTANCE_LEVEL` grows from two names to five, which
is the real widening here, and D3's second test is what stops it growing to
six without anyone noticing.

What this ADR does not decide: how `/mcp` itself is served, what the tools
are, or how the evidence envelope is shaped — those are ADR 0044 and M4.
M3 stops at a bearer token that a request can be authenticated with.

---

## Amendment 1 — 2026-09-13, before M3's plan

The first draft of this ADR inherited three claims from the design's §5 and
one from its own reasoning. Reading the tree rather than the spec, all four
are wrong. Rulings PR-90..PR-93.

**PR-90 — `policy.ts` holds no origin or CSRF rules, so D1's "reuses them
for the consent form" is not a thing that can happen.**
`packages/http/src/policy.ts` is 77 lines of ADR 0029 constants (`POLICY`)
and Zod schemas (`passwordSchema`, `usernameSchema`, `loginBodySchema`,
`bootstrapBodySchema`, `reauthBodySchema`). The origin and CSRF rules live
in `packages/http/src/server.ts`: `originMatchesHost` at :132 and `csrfOk`
at :217, both closed over inside `createServer`. D1 is amended to name
`server.ts`. The consent route still sits beside the dashboard's routes; it
simply does not inherit a helper from `policy.ts`, because there is none.

**PR-91 — the dashboard's CSRF mechanism cannot protect an HTML form, so
the consent page needs its own.** `csrfOk` requires a **custom request
header** whose value matches `session.csrfToken` (`server.ts:217-222`).
That works because the dashboard is React calling `fetch`. A
server-rendered `<form>` cannot set a custom header, so `POST /oauth/authorize`
could not satisfy `csrfOk` even if it wanted to — and it has no session to
take a `csrfToken` from, because D6 forbids accepting the session cookie.

The consent flow therefore carries its own protection, and it is stronger
than a bare origin check: `GET /oauth/authorize` validates the client, the
redirect URI and the PKCE parameters **before rendering anything**, then
writes a short-lived single-use pending-authorization row and renders its
id and a random nonce as hidden inputs. `POST /oauth/authorize` requires
`originMatchesHost`, an unexpired unused pending row whose nonce matches,
and the password. The nonce is consumed on use, so a replayed or forged
form post has nothing to spend. This adds a fourth table,
`oauth_pending_authorizations`, to D3's list — instance-level on the same
reasoning, and `INSTANCE_LEVEL` therefore goes from two names to **six**,
not five. D3's second test is amended to expect six.
Cost if wrong: one table and one nonce check; the failure mode is a consent
form that refuses a legitimate submission, which is loud, not silent.

**PR-92 — capabilities are guild-scoped, and `mcp.authorize` was being
treated as instance-level. This is the hole in the slice.**
`account_capabilities` (`packages/storage/src/schema.ts:1451-1466`) is keyed
`(guild_id, account_id, capability)` with a snowflake CHECK on `guild_id`,
and its own comment calls guild-scoped capability "the load-bearing part".
So there is no such thing as holding `mcp.authorize` instance-wide. But
D3 makes tokens instance-level and the design's §5 says an account
"holds `mcp.authorize`" as though it were global. Left alone, an account
granted `mcp.authorize` in guild A would mint a token that M4 could then
point at guild B — the precise cross-guild leak ADR 0004 exists to prevent,
arriving through the authorization layer instead of through a query.

Ruling: **a token's reachable guild set is never stored and never frozen.**
It is computed at **each tool call** as the set of guilds in which the
approving account *currently* holds `mcp.authorize`, intersected with the
guilds the bot is in. Minting requires the capability in at least one
guild. Revoking the grant in guild B stops the next call naming B, with no
token revocation and no cache to invalidate — which is why D3 refused to
put a `guild_id` on the token in the first place. This makes D3's "M4
resolves the guild per tool call against the allowlist" concrete, and moves
the allowlist's definition from "the config" to "the approving account's
live grants". M4's ADR 0044 inherits this. Cost if wrong: a tool call is
refused for a guild the owner expected to reach, and the fix is a grant.

**PR-93 — `mcp.authorize` does not exist and M3 must create it.**
`CAPABILITIES` (`packages/core/src/authz.ts:49-60`) lists nine strings and
`mcp.authorize` is not among them; `Capability` is the union of that
literal tuple, so the string does not typecheck anywhere today. M3 adds it
to the tuple with a comment naming this ADR. The dot-separated lowercase
form matches the nine that exist.

The net effect on M3's scope: one more table, one more capability, a
consent-form nonce, and a per-call guild resolution that M4 must honour.
None of it is optional, and none of it was visible from the design.

---

## Amendment 2 — 2026-09-14, at M3's close

D5 ("a replayed authorization code revokes the token it already minted") and
D6 ("revoking the account revokes every token it approved") were both
written as one-line promises. Implementing them, and then reviewing the
whole branch, showed that each needs a mechanism the first draft did not
name, and that one of them was **false as shipped** until the fix wave.
Rulings PR-94, PR-126..PR-134.

**D5 is revocation by lineage, not by descent (PR-94, PR-118, PR-127).**
A token's ancestry is recorded in `oauth_tokens.issued_from_code_hash`,
which is `NOT NULL` and **inherited by every rotation** — the row minted by
a refresh copies its parent's value rather than taking one from the caller.
Revoking "what a code minted" therefore means
`revokeTokensFromCode(issued_from_code_hash)`, which reaches the whole
lineage, and **not** a walk down `parent_token_id`. The difference is not
academic: the access token from the first exchange has `parent_token_id
= NULL`, so a descent walk from the refresh token it was minted beside can
never reach it. Both the code-replay path and the refresh-replay path use
lineage. `revokeTokenChain` survives for exactly one caller — revoking an
access token by value, which has no descendants — and any future revocation
surface must choose between them deliberately.

**D6 bites at mint and at use, and the capability is re-checked on every
mint (PR-126, PR-95, and the amendment to the old reading).**
The first implementation read D6 as "at use, not at mint": a code consented
to while the account was healthy still minted, and the tokens were refused
later. That is now wrong in both directions. At **use**, `verifyAccessToken`
and `refreshTokens` check that the approving account exists and is not
disabled, on every request, with no cache. At **mint**, `exchangeCode`
checks the same, and — the part that was missing entirely —
**`refreshTokens` re-checks that the account still holds `mcp.authorize`**.

That last one was a real hole, not a tidiness point. PR-92 says minting
requires the capability in at least one guild; rotation mints; and rotation
did not check. Because **nothing in this tree can disable or delete a
dashboard account** — there is no route, no CLI command and no repository
function; `disabled` is read in four places and written in none outside
tests — revoking the capability is the *only* lever an operator actually
has. It did not end a session: the refresh chain renewed itself for thirty
rolling days. The check lives in the route layer, not the provider, because
the provider cannot see guilds (PR-98); the provider exposes only
`accountForRefreshToken`, a hash-and-read with no other logic, so the two
layers cannot drift.

**What D6 still does not give the operator.** Revoking the capability stops
the *next* mint; it does not revoke live tokens, because PR-92 deliberately
recomputes the reachable guild set per call rather than freezing it. An
access token therefore keeps verifying until it expires — up to an hour —
returning an empty reachable set. **M4 must refuse on an empty set**, and
every tool must intersect against it; a tool that takes no guild would
otherwise be reachable by an account that holds no grant anywhere. This is
the single most important thing M3 hands forward.

**D8 gains a caveat worth stating (PR-122).** `safeLogFields`, the allowlist
rule 4 describes, is applied only where a call site wraps its fields in it,
and `packages/http` has no call sites at all — a pre-existing pattern this
slice followed rather than introduced. Every field M3 logs is allowlisted
and carries an id, and the log-scan test pins the real secrets end to end,
so the promise holds today. It holds by call-site discipline plus Pino's
`redact` denylist, not by the allowlist, and the next OAuth log line is not
protected by anything stronger than review.

**One operational consequence.** `touchToken` was called on the bearer
success path and is a write, so under `BANANASAURS_READONLY` a **valid**
token got a 503 while an invalid one got a 401 — the guard unusable in
precisely the mode read-only exists for, and an oracle besides. The touch is
now best-effort: `lastUsedAt` is telemetry for `mcp tokens` and must never
gate authentication.

---

## Amendment 3 — 2026-09-14, Slice M3b: D6 gets its trigger

Amendment 2 recorded that D6 — "revoking the account revokes everything it
approved" — was a promise with no trigger: **nothing in this tree could
disable or delete a dashboard account.** `disabled` was read in four places
and written in none outside tests. This amendment records the lever, and the
four decisions it needed. No new ADR: the promise is D6's, so the mechanism
belongs beside it.

**A3-1 — the lever is the operator CLI, not the dashboard.** `bananasaurs
account disable|enable|delete <username> --confirm`, over the operator
socket (ADR 0024), instance-level like `bootstrap reissue` for the reason
ADR 0027 gives: an account exists before a guild is chosen, so neither the
question nor the answer names one. No dashboard route ships with it. An
account-management screen is a real thing to want, but the first thing D6
needs is a lever that works when the dashboard is exactly what is
compromised — and the slice that adds a route can add it against repository
functions that already exist and are tested. Cost if wrong: the owner uses
SSH for a thing they would rather click.

**A3-2 — deleting an account revokes its OAuth tokens in the same
transaction, and the revoke is what actually refuses them.**
The first draft of this paragraph said the revoke was belt-and-braces
"because `verifyAccessToken` would return `account-gone` anyway". That was
written from reading the code rather than from running it, and Task 4 of
M3b proved it wrong in an instructive direction. Removing the `account-gone`
guard leaves the whole suite **green**, because the revoke happens inside
the same transaction as the delete, so the very next request is refused as
`revoked` and the account lookup's branch never executes. Through
`deleteAccount`, this write **is** the refusal. Two reasons it is here. The rows survive the account — `oauth_tokens.account_id` carries
no foreign key, deliberately, because the token table is instance-level and
must not cascade-vanish the record of what was issued — so without an
explicit revoke `mcp tokens` would print them as **live** for up to thirty
days, and an operator auditing "what can still reach this daemon" would read
a list that is wrong in the one direction that matters. And a revocation
that depends on a *second* module's check is exactly the shape Amendment 2
found false in two directions at once. The authorization codes for that
account go in the same transaction: an unexchanged code is a token that has
not been minted yet. Cost if wrong: a few extra `UPDATE`s on a table with
tens of rows.

Two facts that only came out of trying to break the guards, and that belong
here rather than in a test comment. **The `account-gone` branch is
unreachable through `deleteAccount`** and is therefore pinned by a test that
deletes the row with raw SQL instead (ruling M3b-R7) — the branch still
matters in production, because a restored backup taken before the account
existed, or a row removed by hand during the `bootstrap reissue` recovery,
both reach it. And **removing that branch is a 500, not a bypass**: without
it, `verifyAccessToken` reads `.disabled` off `undefined` and throws, so the
guard's real job is turning a crash into an honest 401. Both were found by
watching the guards fail, not by reading them, which is the point.

**A3-3 — disable and delete refuse nothing, and say what they cost.**
Neither command guards "the last owner". Both are recoverable from the same
terminal that ran them: a disabled account is re-enabled with `account
enable`, and deleting the last account is the documented recovery path
`bootstrap reissue` already names ("if there is no owner left, remove the
account rows deliberately and run this again") — a guard here would make
that path unreachable forever. What the commands owe the operator instead is
an honest sentence: when the target was the last enabled owner, the output
says so and names the next command. Cost if wrong: an operator locks
themselves out of the dashboard and has to run one more CLI command.

**A3-4 — `enable` clears `disabled` and nothing else.** It does not clear
`failed_attempts` or `locked_until`, because a lockout (ADR 0029) answers a
different question from a disablement and silently clearing one while
undoing the other would make the login-throttle state depend on an unrelated
command. The output reports a live lockout so the operator is not puzzled by
an enabled account that still cannot sign in. Cost if wrong: an operator
waits out a lockout window, or resets it by the path ADR 0029 defines.

**What this closes and what it does not.** D6 now has a trigger at both
ends: revoking `mcp.authorize` stops the next mint (Amendment 2), and
disabling or deleting the account stops the current one on the very next
request — proven by a test that drives the real OAuth routes, mints a token,
verifies it, deletes the account, and asserts the next call to the same
route is a 401 with the RFC 9728 challenge. What it does not close is the
gap Amendment 2 hands to M4 and this slice does not touch: an account that
merely loses its capability keeps a verifying access token with an **empty**
reachable guild set until it expires. **M4 must still refuse on empty.**
