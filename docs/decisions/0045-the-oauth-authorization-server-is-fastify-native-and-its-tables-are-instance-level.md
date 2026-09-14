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
