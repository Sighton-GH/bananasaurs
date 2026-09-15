# Slice M3 whole-branch review — Opus, 2026-09-14

Reviewer: Claude Opus 5 via the Agent tool (brief:
`.oc-runs/m3-oauth/whole-branch-review-brief.md`; diff:
`.oc-runs/m3-oauth/whole-branch.diff`, base `78fb00e`, head `3ceebcb`,
23 commits, 12,581 diff lines with the lockfile excluded). 66 tool uses,
13m08s, six Node probes against a migrated SQLite database and the real
routes driven through `app.inject`. Reproduced verbatim below; the
controller's adjudication is in the ledger (rulings PR-126..PR-134).

A first dispatch died on a Claude session cap before its first tool call and
produced nothing; it was re-dispatched unchanged after the owner cleared the
limit (evaluation D50).

**Both Criticals were independently confirmed by the controller before the
fix wave was written**, by reading the code rather than taking the report:

- Finding 1 — `refreshTokens` (`provider.ts:349-362`) checks that the
  approving account exists and is not disabled and **never checks
  `mcp.authorize`**, so rotation mints for an account that holds nothing.
- Finding 2 — `exchangeCode` writes **both** first-pair rows with
  `parentTokenId: null` (`provider.ts:291` and `:303`), and
  `revokeTokenChain`'s recursive CTE joins on `t.parent_token_id =
  c.token_id` (`repos/oauth.ts:537`), so a walk from the refresh token can
  never reach the access token minted beside it.

After the fix wave the controller ran its own probes: reverting the lineage
call to the chain call fails exactly one test (the named lineage test), and
neutralising the route-layer capability guard fails exactly one test (the
named capability test). Both restored; the final scoped re-review returned
**ALL ADDRESSED** with no new breakage, having executed the two-rotation
replay itself and confirmed all six rows revoked.

---

## The review, verbatim

Verdict: **SHIP-WITH-FIXES**

### Findings

**[Critical] `packages/http/src/oauth/provider.ts:349` (and the route branch
at `packages/http/src/routes/oauth.ts:345`) — refusal (f) applies only to
the first mint; refresh rotation mints for an account that no longer holds
`mcp.authorize` anywhere.** `refreshTokens` re-checks account existence and
`disabled` (PR-95) but never `reachableGuilds`. Executed: granted
`mcp.authorize` in guild A, minted a token, then `revokeAccountCapability` +
`revokeGuildAccess` — the bearer path still returned **200** with
`reachableGuilds: []`, and `POST /oauth/token` with
`grant_type=refresh_token` still returned **200 with a fresh working
access+refresh pair**. Revoking the grant is the only lever the tree
actually offers (see Check A: no disable/delete command exists anywhere),
and it does not end the session; the chain self-renews for 30 rolling days.
ADR 0045 PR-92 says "Minting requires the capability in at least one guild"
— rotation mints. Smallest fix: in the route's refresh branch, mirror
PR-98's layering — `if (reachableGuilds(oauthDeps, row.accountId).length ===
0) return tokenFailure(...)`; that needs the account id, so either return it
from a pre-read or move the check into `refreshTokens` with `guildIds`
already on `OAuthDeps`.

**[Critical] `packages/http/src/oauth/provider.ts:336` — a replayed refresh
token revokes the chain but not the sibling access token minted alongside
it,** so the token the leak most likely exposed survives the leak signal.
`rotateRefreshToken` gives the new pair `parentTokenId = oldRefreshTokenId`,
but `A0` (minted by `exchangeCode` with `parentTokenId: null`) is not a chain
descendant of `R0`. Executed: exchange → refresh → replay `R0`. The replay
was refused and `A1`/`R1` were revoked, but `verifyAccessToken(A0)` returned
`{ok:true}` and its row still had `revoked_at: null`. This is exactly the
hazard PR-118 identified and fixed for `revokeByValue`, which uses
`revokeTokensFromCode` for this reason — the replay path was never given the
same treatment. ADR 0045 D5 says refuse the replay *and* kill the access and
refresh tokens. Smallest fix: one line —
`oauthRepo.revokeTokensFromCode(instance, row.issuedFromCodeHash, now)` in
place of `revokeTokenChain`, identical to the `revokeByValue` branch at
`:411`. `issued_from_code_hash` is `NOT NULL` on every row and pinned by the
PR-110 invariants test, so the whole lineage is reachable.

**[Important] `packages/http/src/oauth/provider.ts:443` — `touchToken` on
the bearer success path makes the guard unusable under
`BANANASAURS_READONLY`.** `touchToken` is a `writeInstance`, and
`writeInstance` throws `ReadonlyError` in read-only mode
(`packages/storage/src/write.ts:103`). Executed: minted a token against a
writable scope factory, then served the same database through
`t.readonlyScopes` with `readonly: true` — the bearer-guarded request
returned **503 `{"error":"read-only"}`**, not 200. PR-107 wired the touch in
for `mcp tokens`' `lastUsedAt`; nothing noticed it gates authentication. It
is also a small oracle: in read-only mode an invalid token gets 401 and a
valid one gets 503, so an unauthenticated caller can distinguish them.
Smallest fix: make the touch best-effort — wrap it in
`try { … } catch { /* telemetry, never gates auth */ }`. Nothing in M3
serves a bearer-guarded route yet, so this is not broken today; M4's
read-only tools are exactly what it breaks.

**[Important] `apps/daemon/src/ops/wiring.ts:966` (port),
`packages/core/src/ops/commands/mcp.ts:112` (`mcp revoke`) — the operator's
only single-token remedy does not stop a leak.** `mcpRevokeToken` calls
`oauthRepo.revokeToken`, which updates exactly one row. Executed: revoked
the access token id from `mcp tokens`; the sibling refresh token immediately
minted a new access token that verified `ok: true`. `mcp tokens`' own
comment says the operator "is looking for what is still usable" — this
command does not make it unusable. Smallest fix: have the port call
`oauthRepo.revokeTokensFromCode(scope, row.issuedFromCodeHash, now)` after
`findTokenById`, so `mcp revoke` kills the lineage the way `revokeByValue`
already does, and say so in the command summary.

**[Minor] `packages/http/src/oauth/provider.ts:250`** — `exchangeCode`
checks the client (PR-109) but never the account, so a code approved before
the account was disabled still mints. Executed: disabled the account between
consent and exchange; the exchange returned `ok: true` and wrote two
`revoked_at: null` rows. The tokens are inert (bearer and refresh both
refuse), but `mcp tokens` reports them "live", which is the one column an
operator triaging a compromise reads. Smallest fix: add the same
`findAccountById` + `disabled` check `refreshTokens` already has, before the
mint.

**[Minor] `apps/daemon/src/http/static.ts:24` — with `MCP_PUBLIC_URL` unset,
every OAuth path answers 200 with the dashboard SPA, not 404.**
`registerOAuthRoutes` returns early (PR-116), and the root
`setNotFoundHandler` only special-cases `/api/`. Executed through the exact
production composition (`createServer` + `registerStaticAssets`, as
`startDashboardApi` does): `GET /.well-known/oauth-protected-resource` →
**200 `<html>SPA</html>`**, `POST /oauth/register` → **200
`<html>SPA</html>`**. `routes/oauth.test.ts:638` asserts 404 for all seven
paths and passes, because no test ever adds the static handler. No OAuth
logic runs, so this is not a security hole — but RFC 9728 discovery against
a non-opted-in daemon fails confusingly, and any reachability check reads
200. Smallest fix: `if (request.url.startsWith('/api/') ||
request.url.startsWith('/oauth/') || request.url.startsWith('/.well-known/'))`.

**[Minor] `packages/storage/src/repos/oauth.ts:621`** — `purgeExpired` has
**no production caller**. `grep -rn purgeExpired packages apps` finds only
its definition, its own repo test, and the generated `.d.ts`. The plan
specified its semantics (PR-108) but never scheduled it, so expired pending
rows, expired codes and revoked+expired tokens accumulate forever, at a rate
a stranger sets (authorize is unauthenticated at 60/hour, register at
20/hour). Smallest fix: call it from the existing backup or archive-expiry
timer in `apps/daemon/src/runtime/`, or delete the function and record the
deferral.

**[Minor] `packages/http/src/oauth/consent.ts:51-53`** — the page lists the
raw scope strings `bananasaurs:read` / `bananasaurs:send` with no statement
of what they permit, and omits the client id and the registration timestamp,
both of which are already in the row. An owner cannot distinguish "the
client I added in Claude desktop thirty seconds ago" from one registered
three weeks ago. Smallest fix: one plain-English line per scope, plus
`registered <ISO date>` and the `cli_…` id under the client name.

### Check A — D6's completeness

**Partially — the guard is complete on every path, but the event it guards
against has no operator surface at all.**

Traced, with the code at each:

- **Bearer.** `provider.ts:440-442`: `const account =
  accountRepo.findAccountById(instance, row.accountId); if (account ===
  undefined) return {ok:false, reason:'account-gone'}; if (account.disabled)
  return {ok:false, reason:'account-disabled'};` — executed, returns 401
  `invalid_token`. Kept.
- **Refresh.** `provider.ts:349-362`: the same two checks, returning
  `invalid_grant`. Kept.
- **Consent.** `auth.ts:159-178` (`verifyAccountCredentials`): unknown
  username → dummy-hash then `invalid-credentials`; `disabled` → dummy-hash
  then `invalid-credentials`. Kept, and it inherits lockout and timing,
  which is what PR-96 bought.
- **Exchange.** `provider.ts:250` checks only the client. A code approved
  before the account was disabled still mints — finding 5 above. The tokens
  are inert, so this is partial in bookkeeping, not in access.
- **What M4 inherits.** `requireBearer` (`bearer.ts:78`) returns a principal
  carrying `reachableGuilds`, computed live; it does **not** refuse an empty
  set. M4 must intersect per call or a zero-grant token reaches any tool
  that is not guild-scoped.

The gap that matters is upstream of all of this: **nothing in the tree can
disable or delete a dashboard account.** `grep -n "^export const"
packages/storage/src/repos/accounts.ts` shows no `deleteAccount` and no
disable setter; `disabled` is read in four places and written in none
outside tests (`provider.test.ts:88` does raw SQL). There is no route and no
`bananasaurs account` subcommand for it. So D6's promise is kept by code
that only a manual `sqlite3 … UPDATE dashboard_accounts SET disabled = 1`
can trigger. The lever an owner *does* have —
`authzRepo.revokeAccountCapability` — stops nothing on the bearer path and
nothing on the refresh path, which is finding 1. Executed end to end: grant
→ mint → revoke capability → **200** → revoke guild access → **200** →
refresh → **200 with a new pair** → `UPDATE … disabled = 1` → **401**.

### Check B — D8 and the log surface

**PR-122 confirmed, correctly sized, and pre-existing — and I found no
second route by which a value reaches a log.**

`grep -rn "safeLogFields" packages/http/src` returns **zero** hits. Not one
call site in the package. The eight non-test log call sites in
`packages/http` are `server.ts:216`, `bearer.ts:71`, and six in
`routes/oauth.ts` (285, 316, 350, 399, 423, 428); every one passes a bare
object literal. `server.ts:216` predates M3 (it is untouched by the diff),
so this is a pre-existing `packages/http` pattern and **not an M3
regression** — the dashboard's own error line has always been outside the
allowlist. M3 adds six lines to a package that never wrapped.

Sizing the exposure: every field M3 actually logs is `component`,
`oauthClientId`, `oauthTokenId`, `reason` — four names, all in
`LOGGABLE_FIELDS`, all carrying ids, never values. So the *current* lines
are correct; what is missing is the mechanism that would keep the *next*
line correct.

Other routes, checked rather than reasoned about:

- **Fastify built-ins.** `server.ts:200`: `Fastify({ logger: false,
  bodyLimit: 64 * 1024 })`. Fastify logs nothing at all — no request line, no
  `req` serializer, so no URL and no `Authorization` header ever reaches a
  sink from the framework.
- **The error handler.** `server.ts:210-217` takes `err.message` only, never
  the error object, with a comment saying exactly why. I looked for a throw
  whose message could carry a secret: `rotateRefreshToken` throws with a
  **token id** (`repos/oauth.ts:576`); `parseStringArray`'s Zod error
  carries the scopes JSON; `new URL(...)` in `beginAuthorization` and
  `redirectWith` is only ever handed an already-registered redirect URI and
  Node's message is the bare string `Invalid URL`. None carries a raw token,
  code, nonce or verifier.
- **An allowlisted key holding the wrong value.** `oauthTokenId` is the one
  that would hurt, and it is the planted leak PR-121 already watched fail.
  `reason` is a closed union of six literals at `provider.ts:390-392`.
- **Unhandled rejection.** The only `async` OAuth handler is `POST
  /oauth/authorize`; its await is `verifyAccountCredentials`, whose
  rejections go through `setErrorHandler`. No floating promise in the OAuth
  files.

What the log-scan test would and would not catch: it drives register →
authorize (GET+POST) → exchange → bearer success → refresh → bearer success
→ revoke → bearer 401 against a real Pino instance with production's
`REDACT_PATHS`, and asserts the dump contains none of `{verifier, nonce,
code, access_token ×2, refresh_token ×2, PASSWORD}` while *positively*
asserting `clientId` and `/tok_[0-9a-f]{32}/` do appear — so it cannot pass
vacuously. It ran green for me in isolation. It would **not** catch: any
error or refusal path (PKCE failure, replay, the 403 no-grant branch, the
429s, a 500 through `setErrorHandler`); the ops/CLI surface and its audit
rows; the **`requestId`**, which is a `generateToken()` value that grants the
right to complete a pending authorization and is not in the `secrets` array;
and any log line added to a file this single happy path does not execute.
Your note is right and I confirmed the mechanism: `{token: raw}` is censored
to `<redacted>` by `REDACT_PATHS[0]` before the sink, so it would not trip
the scan — defence in depth, not the gap.

### Check C — guild scope on the token path

**No caller-controlled input on the path, and no route from a token approved
in guild A to data from guild B.**

The complete path, all of it live per request:

1. `bearer.ts:57` — `verifyAccessToken(deps, raw)` returns `accountId`
   **read from the `oauth_tokens` row**, never from the request.
2. `bearer.ts:83` — `reachableGuilds(deps, verified.accountId)`.
3. `reachable.ts:19` — `accountRepo.listAccessibleGuilds(deps.scopes.instance(), accountId)`.
4. `reachable.ts:22` — `if (!deps.guildIds.includes(id)) continue`, where
   `deps.guildIds` is `deps.config.BANANASAURS_GUILD_ALLOWLIST`
   (`apps/daemon/src/http/wiring.ts:95`) — process configuration, not
   request data.
5. `reachable.ts:24-28` — `authorize({store:
   authzStoreFor(deps.scopes.forGuild(guildId)), guildId, actor:
   actorFor(accountId)}, 'mcp.authorize')`. The scope is built from the id
   the database returned; `actorFor` yields `{type: 'dashboard', roleIds:
   []}`, and `'dashboard'` is in neither `SYSTEM_ACTORS` (`authz.ts:137`)
   nor `CHANNEL_AUTHORIZED_ACTORS` (`authz.ts:164`), so it falls through to
   `store.hasGrant` and needs a real `(guild_id, account_id,
   'mcp.authorize')` row.

The caller controls exactly one thing on this path: the bearer value. There
is no guild parameter anywhere — not in the consent form
(`authorizeFormSchema` is `{requestId, nonce, username, password,
decision}`), not in the token response (`{access_token, refresh_token,
token_type, expires_in, scope}`), and not in the tables (the invariants test
asserts no `guild_id` column on any of the four, and pins `INSTANCE_LEVEL`
at exactly six names). A stale row cannot help either: `listAccessibleGuilds`
and `hasGrant` are both read fresh, nothing is memoised, and I confirmed by
execution that revoking the grant flips `reachableGuilds` to `[]` on the very
next request. So a token approved in guild A can never name guild B.

The residual is the reverse direction, and it is finding 1 plus the M4 note:
`requireBearer` will hand M4 a principal with `reachableGuilds: []` and a
200, so guild isolation holds only as long as every M4 tool intersects
against that array. A tool that takes no guild would be reachable by a token
whose account holds nothing.

### Check D — restart and concurrency

**A restart resets only the two counters, and that costs nothing durable.
The code race cannot happen, and the SQL would settle it correctly if it
could.**

What a restart resets: both `createRateLimiter` maps — `registerLimiter` (20
per hour, one global key `'register'`) and `authorizeLimiter` (60 per hour,
one global key `'authorize'`), both created inside `registerOAuthRoutes` and
holding a `Map` in closure. That is the whole of the in-memory state;
pending authorizations, codes, tokens, lockout counters and sessions are all
SQLite rows and survive. What it lets an unauthenticated caller do: register
up to 20 more junk `oauth_clients` rows and render up to 60 more consent
pages (each writing one pending row) per restart. Neither grants anything —
D7's point is that a registered client can do nothing until an account
holding `mcp.authorize` types a password — and `mcp revoke-client` removes
the junk. The counters are best-effort by construction (PR-97 says so), and
the restart reset does not change that conclusion. The one durable cost is
that those rows are never swept, because `purgeExpired` is never called
(finding 7).

Two concurrent exchanges of one code. The SQL that decides the winner is
`markAuthorizationCodeUsed` (`repos/oauth.ts:390-402`), which Drizzle emits
as:

```sql
UPDATE oauth_authorization_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL
```

and returns `result.changes`. The caller checks it at `provider.ts:268`:
`if (marked === 0) { revokeTokensFromCode(...); return invalid_grant }`.

**Both could not mint, and in fact they cannot even interleave.**
`exchangeCode` is a fully synchronous function — no `await` between
`findAuthorizationCode` and `markAuthorizationCodeUsed` — reached from the
route with no `await` before it, over synchronous better-sqlite3, in one
process (ADR 0006). Node's event loop cannot yield inside it, so PR-100's
find-then-mark window does not exist at runtime. The `WHERE used_at IS NULL`
guard is the belt that would hold anyway if it ever did. Executed: two
back-to-back `exchangeCode` calls on one code gave `first ok: true, second
ok: false invalid_grant`, and the first pair's `revoked_at` was set on both
rows — so the loser not only fails but correctly triggers D5's cascade.

### Check E — the assumption every test shares

**The assumption I picked — "every test builds the Fastify app itself, so
the app under test is the one M3 wired, not the one the daemon runs" — is
false in production, and testing it found one real behaviour difference.**

Every OAuth test calls `createServer({deps, registerRoutes})` and stops
there. `startDashboardApi` (`apps/daemon/src/http/wiring.ts:138`) does one
more thing immediately afterwards: `registerStaticAssets(app,
DASHBOARD_DIST)`, which installs a root `setNotFoundHandler` that serves
`index.html` with **status 200** for everything outside `/api/`. `grep -rn
"registerStaticAssets\|startDashboardApi" apps/daemon/src packages/http/src
--include=*.test.ts` finds exactly one hit, in `static.test.ts`, which
builds a bare app of its own. So no test in the tree has ever run an OAuth
route under the handler production layers over it.

What I ran: a probe that composes the app exactly as `startDashboardApi`
does — `createServer` with `registerOAuthRoutes`, then
`registerStaticAssets` against a temp dist holding an `index.html` — then
drives the full flow.

What I found, both halves worth reporting. **The mounted case is clean:**
both metadata documents 200 with correct JSON, `POST /oauth/register` 201,
`GET /oauth/authorize` 200 `text/html`, `POST /oauth/authorize` 302 to
`https://bot-test.example/cb?code=…&state=st`. The encapsulated child
context (PR-120's fix) is not shadowed by the root 404 handler, and the
PR-120 regression itself holds through the real wiring — `POST /api/login`
with `application/x-www-form-urlencoded` still returns **500**, not 401, so
the login-CSRF guard survives production composition and is not an artefact
of the test harness. **The unmounted case is not clean:** with
`mcpPublicUrl: undefined`, `/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource` and `POST /oauth/register` each
returned **200 `<html>SPA</html>`**. `routes/oauth.test.ts:638` asserts 404
on all seven and passes — true in every test, false in every daemon. That is
finding 6, and it is the same shape as M2's: an assertion that holds only
because the test builds less of the world than production does.

I also checked the M2-literal candidate and it is fine:
`drizzle/meta/_journal.json` carries `0021` at `when: 1789359247301`,
strictly greater than `0020`'s `1789337741258`, so the migrator's
`when`-gate applies it to an existing database; the four tables are new and
need no backfill.

### Check F — what the consent page tells the owner

**The page is honest but thin, and the one thing that protects the owner is
a sentence the attacker can out-shout.**

Rendered verbatim from the probe, with the attacker's client registered as
`client_name: "Bananasaurs Official"`, `redirect_uris:
["https://bot-test.example/cb"]`:

> `Authorize Bananasaurs Official?` (h1)
> `Client **Bananasaurs Official** is requesting access to this server.`
> `It will return to host bot-test.example.`
> `Scopes requested:` · `bananasaurs:read` · `bananasaurs:send`
> `Approve only if you started this from a client you recognise.`

then username, password, Approve, Deny. The `<title>` is `Authorize
Bananasaurs Official`.

What stops them: only the owner reading `bot-test.example` and noticing it
is not theirs, plus needing the owner's password and `mcp.authorize`.
Escaping is correct — `esc` covers the five entities and PR-106's
double-quoted attributes hold — and CSP is `default-src 'none'`, so this is
not an injection question.

Beyond escaping, three things are short of "informed". First, **`client_name`
is 200 characters of attacker-controlled prose rendered in the `<h1>`, the
`<title>` and a `<strong>`, while the warning is one unstyled sentence
below it** — a name like `Bananasaurs Official (verified — the host below is
our CDN, this is expected)` renders as plain text but visually and
rhetorically dominates the page, and nothing marks the name as untrusted.
Second, **the scopes are raw protocol strings**: the page never says what
`bananasaurs:send` lets a client do, so the owner is approving a vocabulary,
not a capability. Third, **the page omits the two fields that would actually
settle it** — the `cli_…` client id, which the owner could compare against
what their client displayed, and `created_at`, which distinguishes a client
registered seconds ago from one that has been sitting in the table. Both are
already on the row `beginAuthorization` reads. PR-98's rejection is right
that RFC 7591 makes this residual rather than a defect, and the one line of
copy was the agreed mitigation — but the page can carry the risk better than
it does for three more interpolations. That is finding 8.

### Check G — the adversary path

**They reach a junk row and a consent page. Nothing else, unless the owner
types their password.**

Walking it as an adversary who controls a client and can make the owner's
browser issue requests but does not know the password:

Reached. `POST /oauth/register` with any name and any `https://` or loopback
redirect — 20 per hour, resetting on restart, creating a row with an
attacker-chosen name (Check F). `GET /oauth/authorize` — 60 per hour, each
writing a pending row, which is also a denial lever: exhausting that bucket
makes the owner's own authorize page return 429 for the rest of the hour.
Discovery: both metadata documents, unauthenticated.

Not reached. Minting anything. The consent POST needs `originMatchesHost`
(browsers do send `Origin` on cross-site form posts), an unconsumed
unexpired pending row, a `nonce` that `secretsMatch`es its stored hash, the
password through `verifyAccountCredentials` with lockout and dummy-hash
timing, and `mcp.authorize` in at least one allowlisted guild. Both
`requestId` and `nonce` are 32-byte `generateToken()` values rendered only
into the page the browser fetched, and a cross-origin page cannot read them
— so a forged form post has nothing to spend, exactly as PR-91 argues.
Stealing the code off the redirect buys nothing without the verifier (S256
only; `plain` refused at `provider.ts:92`), and a second presentation of the
code kills the pair. The token endpoint is unauthenticated but every grant
requires a 256-bit secret the attacker does not hold. The realistic path to
compromise is not technical: it is persuading the owner to open the consent
URL and type their password, which is Check F.

The single most valuable hardening this branch does not have: **re-checking
`mcp.authorize` on refresh** (finding 1). It is the difference between
"revoking the grant ends the session at the next rotation, at worst one hour
later" and "revoking the grant ends nothing, ever, and there is no other
lever". It belongs in **M3**, not later — it is one call to a function the
route already imports, it closes the only path by which a named refusal is
permanently bypassable, and after M4 ships there will be live tokens in the
table whose semantics the fix changes. The close second is making `mcp
revoke` kill the lineage (finding 4); that one could wait for M4 only if the
release notes say plainly that the working remedy today is
`mcp revoke-client`.

### New risks this branch creates for M4

- **`requireBearer` returns 200 with `reachableGuilds: []`.** M4 must refuse
  on an empty array, and every tool must intersect against it; a tool that
  is not guild-scoped is reachable by an account holding no grant anywhere.
  Verified by execution.
- **The bearer guard is unusable under `BANANASAURS_READONLY`** — 503 on
  every valid token, because of `touchToken` (finding 3). M4's read-only
  tool surface is precisely what read-only mode exists for.
- **Promoting the SDK to a runtime dependency (D2) pulls Express 5, Hono,
  `cors`, `express-rate-limit`, `ajv` and `eventsource` into the production
  closure.** M3 deliberately avoided that; M4's ADR should say what it is
  buying.
- **Token lineage semantics now matter to two more callers.** Any M4
  revocation surface must choose lineage (`revokeTokensFromCode`) over chain
  (`revokeTokenChain`) deliberately; the branch currently has one of each
  and one of them is finding 2.
- **`purgeExpired` remains uncalled** (finding 7), so whatever M4 adds
  inherits four tables that only ever grow.

### Observations

- The observe-window constraint is kept. `git diff --name-only 78fb00e HEAD
  -- packages/core/src/automod packages/core/src/mod
  packages/core/src/effects/gateway.ts` returns nothing, and
  `mod_rules`/`setRuleMode`/`setRuleConfig`/`recordVerdict` appear nowhere
  in the new OAuth files. The only automod-adjacent change is
  `apps/daemon/src/automod.integration.test.ts`, which is a PR-102
  `OpsPorts` literal update.
- D2 is kept exactly: `@modelcontextprotocol/sdk` is pinned at `1.30.0` in
  root `devDependencies`, and `grep -rn "@modelcontextprotocol" packages
  apps --include=*.ts` finds three imports, all in `conformance.test.ts`,
  two of them `import type`.
- The PR-121 mechanism is real and I reproduced the reasoning: `token` is
  `REDACT_PATHS[0]`, so `{token: raw}` is censored before the sink. The
  extraction of `REDACT_PATHS` is a pure move with no behaviour change.
- `oauth_tokens` has no index on `issued_from_code_hash` or
  `parent_token_id`, so `revokeTokensFromCode` and the chain CTE scan. At
  single-owner volume this is irrelevant; noting it only because both fixes
  above make those two queries hotter.
- The rate limiter's `prune` walks the whole map on every `check`. With two
  single-key buckets that is two iterations; it only matters if a future
  caller keys by something unbounded.
- Not verifiable in this environment: anything requiring a live Discord
  connection or a real `.env`. Nothing in this review needed one.
