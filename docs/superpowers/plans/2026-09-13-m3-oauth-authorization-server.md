# Slice M3 — the OAuth 2.1 authorization server — Implementation Plan

> **For agentic workers:** this plan is executed with
> `opencode-delegate:opencode-driven-development`. The controller writes one
> brief per task; each task ends with an independently testable deliverable.
> Steps use checkbox (`- [ ]`) syntax.

**Goal:** A conformant OAuth 2.1 authorization server on Fastify, issuing
bearer tokens bound to a dashboard account that holds `mcp.authorize`,
verified end to end by the MCP SDK's own client against the running daemon.

**Architecture:** Native Fastify routes implement the six OAuth endpoints
against four new instance-level SQLite tables. The MCP SDK is a
**devDependency only** — its types shape the provider and its example client
proves conformance; no SDK code runs in the daemon until M4. The consent page
is the project's first server-rendered HTML, protected by a single-use nonce
rather than the dashboard's header-based CSRF, which an HTML form cannot
send. A token carries no guild; the guilds it can reach are computed live at
each call from the approving account's current `mcp.authorize` grants.

**Tech Stack:** TypeScript (Node 22, strict), Fastify, better-sqlite3 +
Drizzle, Zod, Vitest, `@node-rs/argon2` (passwords only), `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-09-12-mcp-operator-server-design.md`
§5, §8.3. **ADR:** `docs/decisions/0045-the-oauth-authorization-server-is-fastify-native-and-its-tables-are-instance-level.md`
— read **Amendment 1**, which corrects four claims the spec makes.
**Research:** `.oc-runs/m3-oauth/research-findings.md` (every signature below
is quoted from it and carries a file:line).

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **The observe window is running on two real guilds.** Do **not** modify
   `mod_rules`, `mod_cases`, `mod_case_events`, `setRuleMode`,
   `setRuleConfig`, `recordVerdict`, `packages/core/src/automod/**`,
   `packages/core/src/mod/**`, or `packages/core/src/effects/gateway.ts`.
2. **Guild scope is a mandatory partition key** (`CLAUDE.md` rule 2). The four
   OAuth tables are the exception, are instance-level by ADR 0045 D3, and must
   be added to `INSTANCE_LEVEL` with a reason each. **No OAuth table gets a
   `guild_id` column.**
3. **No secrets in logs, config exports or diagnostics** (rule 4). Pino
   redaction is an allowlist. A token or code **value** never reaches a log,
   an audit row, an error message, or an HTTP response body except the one
   response that mints it.
4. **Every table is STRICT.** `npm run db:generate` runs
   `scripts/strictify.mjs`, which adds it. Never hand-write a migration in
   this slice (ADR 0049's exception was FTS5 only).
5. **Zod at every boundary.** Every request body and every query string
   through a schema before use.
6. **Timestamps are INTEGER epoch millis; snowflakes are TEXT.**
   (`packages/storage/src/schema.ts:26-28`.)
7. **Node crypto is imported named from `'node:crypto'`.**
   (`packages/http/src/secrets.ts:1`.)
8. **No new runtime dependency.** `@modelcontextprotocol/sdk` enters as a
   **devDependency** (ADR 0045 D2). Nothing else is added at all.
9. Gates, each alone, by exit code: `npm run typecheck`, `npm run lint`,
   `npm run test`. All three exit 0 before a task is done.
10. `rg` is absent on this machine. Use `grep -rn` with an **explicit path**,
    never a bare `.` or a loop variable. Same for every `git` command.

### Values fixed by ADR 0045 D4 — copy these exactly

| Thing | Value |
| --- | --- |
| Access token lifetime | 1 hour (`3_600_000` ms) |
| Refresh token lifetime | 30 days (`2_592_000_000` ms) |
| Authorization code lifetime | 5 minutes (`300_000` ms), single-use |
| Pending-authorization lifetime | 10 minutes (`600_000` ms), single-use |
| Token value | `generateToken()` — 32 random bytes, base64url |
| Token at rest | `hashToken()` — SHA-256 hex. **Never Argon2.** |
| Constant-time compare | `secretsMatch()` |
| PKCE | `S256` **only**. `plain` is refused. |
| Registration redirect URIs | `https://` or loopback (`http://127.0.0.1`, `http://[::1]`, `http://localhost`) only |

### Existing code every task reuses — do not reinvent

| Need | Use | Where |
| --- | --- | --- |
| Generate an opaque token | `generateToken(): string` | `packages/http/src/secrets.ts:70` |
| Hash a token for storage | `hashToken(token): string` | `packages/http/src/secrets.ts:80` |
| Compare two secrets | `secretsMatch(a, b): boolean` | `packages/http/src/secrets.ts:114` |
| Verify a password | `verifyPassword(storedHash, password): Promise<boolean>` | `packages/http/src/secrets.ts:48` |
| Find an account | `findAccountByUsername(scope: InstanceScope, username)` | `packages/storage/src/repos/accounts.ts:86` |
| Check a capability | `authorize({store, guildId, actor}, capability)` | via `requireCapability`, `packages/http/src/routes/capability.ts:29` |
| Instance-scoped read/write | `readInstance(scope, fn)` / `writeInstance(scope, fn)` | `packages/storage/src/write.ts:102-111` |
| Origin check | `originMatchesHost(request)` | `packages/http/src/server.ts:132` |
| Drive a request in a test | `app.inject({method, url, headers, payload})` | `packages/http/src/routes/write.test.ts:96` |
| A migrated test database | `openMigratedTestDatabase()` | `packages/http/src/routes/write.test.ts:39` |

**The hashing boundary:** repository functions take an already-hashed value.
`auth.ts` does `hashToken(token)` and passes `sessionIdHash` to the repo
(`packages/http/src/auth.ts:242-254`). M3 follows exactly that: hashing
happens in `packages/http`, and `packages/storage` never sees a raw token.

---

## File Structure

**Created**
- `packages/storage/src/repos/oauth.ts` — every read and write over the four
  tables, all `InstanceScope`-first. No hashing, no HTTP types.
- `packages/storage/src/repos/oauth.test.ts`
- `packages/http/src/oauth/provider.ts` — the protocol logic: authorize
  validation, code exchange, PKCE verification, refresh rotation, revocation
  cascade. No Fastify types; takes deps and returns results.
- `packages/http/src/oauth/provider.test.ts` — the seven refusals.
- `packages/http/src/oauth/consent.ts` — renders one HTML form, escaped.
- `packages/http/src/oauth/consent.test.ts`
- `packages/http/src/oauth/rate-limit.ts` — a fixed-window counter.
- `packages/http/src/oauth/rate-limit.test.ts`
- `packages/http/src/oauth/redirect-uri.ts` — the https/loopback rule.
- `packages/http/src/oauth/redirect-uri.test.ts`
- `packages/http/src/routes/oauth.ts` — the Fastify routes.
- `packages/http/src/routes/oauth.test.ts`
- `packages/http/src/oauth/bearer.ts` — bearer verification + live guild set.
- `packages/http/src/oauth/bearer.test.ts`
- `packages/core/src/ops/commands/mcp.ts` + `mcp.test.ts` — CLI.
- `packages/http/src/oauth/conformance.test.ts` — the SDK client, end to end.
- `drizzle/0021_*.sql` — **generated**, never hand-written.

**Modified**
- `packages/core/src/authz.ts` — `mcp.authorize` joins `CAPABILITIES`.
- `packages/core/src/authz.test.ts:112` — the length-9 pin becomes 10.
- `packages/storage/src/schema.ts` — four tables.
- `packages/storage/src/schema-invariants.test.ts` — `INSTANCE_LEVEL` gains
  four names; three new positive tests.
- `packages/core/src/ops/ports.ts` — `OpsInstance` gains the MCP members.
- The **five** `OpsInstance` literals (see Task 6).
- `packages/core/src/ops/registry.ts` — the new commands.
- Wherever `LOGGABLE_FIELDS` lives — two fields (Task 5).
- `package.json` — the devDependency (Task 7).

---

## Task 1: The capability, the schema, and the migration

**Files:**
- Modify: `packages/core/src/authz.ts:49-60`, `packages/core/src/authz.test.ts:112`
- Modify: `packages/storage/src/schema.ts` (append beside the dashboard block
  at `:1376`)
- Modify: `packages/storage/src/schema-invariants.test.ts:43` and its tests
- Generate: `drizzle/0021_*.sql` + journal entry

**Interfaces produced:** the four Drizzle table objects `oauthClients`,
`oauthAuthorizationCodes`, `oauthTokens`, `oauthPendingAuthorizations`, and
the capability string `'mcp.authorize'`.

- [ ] **Step 1: add the capability.** Append to `CAPABILITIES` in
      `packages/core/src/authz.ts`, keeping the existing comment style:

```ts
  /** ADR 0045: may approve an OAuth client at the consent page and mint a token. */
  'mcp.authorize',
```

- [ ] **Step 2: run `npx vitest run packages/core/src/authz.test.ts` and watch
      it fail.** `packages/core/src/authz.test.ts:112` pins the list at length
      9. Update the pin to 10 **and** assert the new string is present, so the
      test still fails if the entry is deleted. Report that you watched it fail.

- [ ] **Step 3: the four tables.** Add to `packages/storage/src/schema.ts`,
      following `dashboard_accounts` (`:1382`) for style — `text()`/`integer()`,
      CHECKs in the third-argument callback, `boolCheck` for booleans,
      ``sql`${col} IN ('a','b')` `` for enumerations. **No `guild_id` on any of
      them.** Timestamps are `integer(...)` epoch millis.

```ts
/**
 * OAuth 2.1 clients. Instance-level (ADR 0045 D3): a client is registered
 * against the daemon, not against a guild.
 */
export const oauthClients = sqliteTable(
  'oauth_clients',
  {
    clientId: text('client_id').primaryKey(),
    clientName: text('client_name').notNull(),
    /** JSON array of absolute URIs, validated on write by redirect-uri.ts. */
    redirectUris: text('redirect_uris').notNull(),
    createdAt: integer('created_at').notNull(),
    createdByAccountId: text('created_by_account_id'),
    registrationSource: text('registration_source').notNull(),
  },
  (t) => [
    check(
      'oauth_clients_registration_source',
      sql`${t.registrationSource} IN ('dynamic','cli')`,
    ),
  ],
);

/**
 * Pending consent forms (ADR 0045 Amendment 1, PR-91). The dashboard's CSRF
 * is a custom request header matched against the session's token, which an
 * HTML form cannot send and this flow has no session to draw from. So the
 * form carries a single-use nonce instead, issued only after the client,
 * redirect URI and PKCE parameters have already been validated.
 */
export const oauthPendingAuthorizations = sqliteTable('oauth_pending_authorizations', {
  requestId: text('request_id').primaryKey(),
  nonceHash: text('nonce_hash').notNull(),
  clientId: text('client_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  scopes: text('scopes').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  state: text('state'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
});

/** Authorization codes. Single-use; a replay revokes what it minted (D5). */
export const oauthAuthorizationCodes = sqliteTable('oauth_authorization_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull(),
  accountId: text('account_id').notNull(),
  scopes: text('scopes').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
});

/**
 * Access and refresh tokens. No `guild_id`, deliberately and permanently:
 * ADR 0045 Amendment 1 PR-92 computes the reachable guild set live at each
 * call from the approving account's current `mcp.authorize` grants, so a
 * guild recorded here would be a second, staler place where scope is decided.
 */
export const oauthTokens = sqliteTable(
  'oauth_tokens',
  {
    tokenId: text('token_id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    kind: text('kind').notNull(),
    clientId: text('client_id').notNull(),
    accountId: text('account_id').notNull(),
    scopes: text('scopes').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    lastUsedAt: integer('last_used_at'),
    /** The refresh token this was rotated from, for D5's cascade. */
    parentTokenId: text('parent_token_id'),
    /** The code_hash this was minted from, for D5's replay cascade. */
    issuedFromCodeHash: text('issued_from_code_hash'),
  },
  (t) => [
    uniqueIndex('oauth_tokens_hash').on(t.tokenHash),
    index('oauth_tokens_by_account').on(t.accountId),
    index('oauth_tokens_by_client').on(t.clientId),
    check('oauth_tokens_kind', sql`${t.kind} IN ('access','refresh')`),
  ],
);
```

- [ ] **Step 4: generate the migration.** Run `npm run db:generate`. It
      produces `drizzle/0021_*.sql` and a journal entry. **Do not edit either
      file by hand.** Confirm the new journal entry's `when` is strictly
      greater than `1789337741258` — the invariants test at
      `packages/storage/src/schema-invariants.test.ts:914-930` requires
      monotonic `when`, and a non-greater entry is **silently skipped** on an
      already-migrated database, which looks exactly like success.

- [ ] **Step 5: the exemption, with reasons.** In
      `packages/storage/src/schema-invariants.test.ts:43`, extend
      `INSTANCE_LEVEL` to six names, each with a one-line reason comment:

```ts
const INSTANCE_LEVEL = new Set<string>([
  'dashboard_accounts',
  'bootstrap_tokens',
  // ADR 0045 D3: an OAuth client is registered against the daemon, not a guild.
  'oauth_clients',
  // ADR 0045 PR-91: a consent form in flight, before any guild is chosen.
  'oauth_pending_authorizations',
  // ADR 0045 D3: a code is exchanged for a token, and a token carries no guild.
  'oauth_authorization_codes',
  // ADR 0045 PR-92: reachable guilds are computed live per call, never stored.
  'oauth_tokens',
]);
```

- [ ] **Step 6: the three positive tests that replace the guard.** Add to
      `packages/storage/src/schema-invariants.test.ts`:

```ts
describe('the OAuth tables are instance-level on purpose (ADR 0045 D3)', () => {
  const OAUTH_TABLES = [
    'oauth_clients',
    'oauth_pending_authorizations',
    'oauth_authorization_codes',
    'oauth_tokens',
  ];

  it.each(OAUTH_TABLES)('%s has no guild_id column', (table) => {
    // A guild_id here would be a second place where scope is decided, ahead
    // of and out of sight of the tool call that uses it (ADR 0045 PR-92).
    expect(columns(table).map((c) => c.name)).not.toContain('guild_id');
  });

  it('INSTANCE_LEVEL contains exactly the six expected names', () => {
    // The tripwire. A seventh table cannot join the exemption without this
    // failing and a human reading ADR 0045.
    expect([...INSTANCE_LEVEL].sort()).toEqual(
      ['bootstrap_tokens', 'dashboard_accounts', ...OAUTH_TABLES].sort(),
    );
  });

  it.each(OAUTH_TABLES)('%s is still STRICT', (table) => {
    expect(allTables().find((r) => r.name === table)?.strict).toBe(1);
  });
});
```

- [ ] **Step 7: break each one and watch it fail.** Remove a name from
      `INSTANCE_LEVEL` (the guild_id invariant must fail for that table);
      restore. Add a `guildId: text('guild_id')` column to `oauth_tokens`,
      regenerate, and watch test 1 and test 2 behave as designed; **revert the
      column and the stray migration**. Report what failed and how many.

- [ ] **Step 8: gates and commit.** `npm run typecheck`, `npm run lint`,
      `npm run test`, each exit 0. Commit as `task 1`.

---

## Task 2: The repository

**Files:** Create `packages/storage/src/repos/oauth.ts`, `oauth.test.ts`.
Modify `packages/storage/src/index.ts` to export the module the way its
neighbours are exported (read it first).

**Interfaces consumed:** Task 1's four tables.
**Interfaces produced:** every function below. Task 3 calls these and nothing
else; if a query is missing, add it here rather than reaching into the db.

- [ ] **Step 1: the signatures.** Every one takes `InstanceScope` first
      (`packages/storage/src/repos/accounts.ts:76` is the pattern) and goes
      through `readInstance` / `writeInstance`. **No raw token ever crosses
      this boundary — the caller hashes.**

```ts
export interface OAuthClientRow { readonly clientId: string; readonly clientName: string;
  readonly redirectUris: readonly string[]; readonly createdAt: number;
  readonly createdByAccountId: string | null; readonly registrationSource: 'dynamic' | 'cli'; }

export interface OAuthTokenRow { readonly tokenId: string; readonly kind: 'access' | 'refresh';
  readonly clientId: string; readonly accountId: string; readonly scopes: readonly string[];
  readonly createdAt: number; readonly expiresAt: number; readonly revokedAt: number | null;
  readonly lastUsedAt: number | null; readonly parentTokenId: string | null;
  readonly issuedFromCodeHash: string | null; }

export const createClient = (scope: InstanceScope, input: {
  clientId: string; clientName: string; redirectUris: readonly string[];
  createdAt: number; createdByAccountId: string | null;
  registrationSource: 'dynamic' | 'cli'; }): void;
export const findClient = (scope: InstanceScope, clientId: string): OAuthClientRow | undefined;
export const listClients = (scope: InstanceScope): readonly OAuthClientRow[];
export const deleteClient = (scope: InstanceScope, clientId: string): number;

export const createPendingAuthorization = (scope: InstanceScope, input: {
  requestId: string; nonceHash: string; clientId: string; redirectUri: string;
  scopes: readonly string[]; codeChallenge: string; state: string | null;
  createdAt: number; expiresAt: number; }): void;
/** Marks consumed and returns the row **only if** it was unconsumed and unexpired. */
export const consumePendingAuthorization = (scope: InstanceScope, requestId: string, now: number)
  : { readonly nonceHash: string; readonly clientId: string; readonly redirectUri: string;
      readonly scopes: readonly string[]; readonly codeChallenge: string;
      readonly state: string | null } | undefined;

export const createAuthorizationCode = (scope: InstanceScope, input: {
  codeHash: string; clientId: string; accountId: string; scopes: readonly string[];
  codeChallenge: string; redirectUri: string; createdAt: number; expiresAt: number; }): void;
/** Reads without consuming — the exchange needs to tell "already used" from "unknown". */
export const findAuthorizationCode = (scope: InstanceScope, codeHash: string)
  : { readonly clientId: string; readonly accountId: string; readonly scopes: readonly string[];
      readonly codeChallenge: string; readonly redirectUri: string;
      readonly expiresAt: number; readonly usedAt: number | null } | undefined;
export const markAuthorizationCodeUsed = (scope: InstanceScope, codeHash: string, now: number): number;

export const createToken = (scope: InstanceScope, input: {
  tokenId: string; tokenHash: string; kind: 'access' | 'refresh'; clientId: string;
  accountId: string; scopes: readonly string[]; createdAt: number; expiresAt: number;
  parentTokenId: string | null; issuedFromCodeHash: string | null; }): void;
export const findTokenByHash = (scope: InstanceScope, tokenHash: string): OAuthTokenRow | undefined;
export const findTokenById = (scope: InstanceScope, tokenId: string): OAuthTokenRow | undefined;
export const listTokens = (scope: InstanceScope): readonly OAuthTokenRow[];
export const touchToken = (scope: InstanceScope, tokenId: string, now: number): void;
export const revokeToken = (scope: InstanceScope, tokenId: string, now: number): number;
/** D5's cascade: every unrevoked token minted from this code. Returns the count. */
export const revokeTokensFromCode = (scope: InstanceScope, codeHash: string, now: number): number;
/** Every unrevoked token of this client. Returns the count. */
export const revokeTokensForClient = (scope: InstanceScope, clientId: string, now: number): number;
/** Housekeeping: delete expired codes and pending rows. Returns counts. */
export const purgeExpired = (scope: InstanceScope, now: number)
  : { readonly codes: number; readonly pending: number };
```

- [ ] **Step 2: write the tests first and watch them fail.** In
      `oauth.test.ts`, against `openMigratedTestDatabase()`. Cover at minimum:
      round-trip of a client with two redirect URIs (the JSON column survives);
      `consumePendingAuthorization` returns the row the first time and
      `undefined` the second; it returns `undefined` for an expired row **and
      still marks nothing**; `findAuthorizationCode` reports `usedAt` rather
      than hiding a used code; `revokeTokensFromCode` revokes both the access
      and the refresh token minted from one code and returns 2; a second call
      returns 0 (already revoked rows are not re-counted);
      `revokeTokensForClient` leaves another client's tokens alone;
      `findTokenByHash` returns a revoked token's row **with** `revokedAt`
      set rather than hiding it — deciding is the caller's job, so assert the
      field and pin the contract.
      Run them, watch them fail, then implement.

- [ ] **Step 3: implement**, following `accounts.ts` for shape. Scopes and
      redirect URIs are stored as JSON via `JSON.stringify`, parsed on read
      with a Zod schema — a malformed row must throw, not silently produce
      `undefined` scopes.

- [ ] **Step 4: gates and commit** as `task 2`.

---

## Task 3: The provider — protocol logic and the seven refusals

**Files:** Create `packages/http/src/oauth/provider.ts`, `provider.test.ts`,
`redirect-uri.ts`, `redirect-uri.test.ts`.

**Interfaces consumed:** Task 2's repository.
**Interfaces produced:** `beginAuthorization`, `completeAuthorization`,
`exchangeCode`, `refresh`, `revoke`, and the `OAuthDeps` shape.

This task is the slice's boundary. **Every one of the seven refusals is
written red and watched failing before the code that satisfies it.** Say so,
per refusal, in the report.

- [ ] **Step 1: the redirect-URI rule** (`redirect-uri.ts`), with tests first:

```ts
/**
 * RFC 7591 leaves redirect URIs to the server. ADR 0045 D7: https or
 * loopback only, because dynamic registration is unauthenticated and an
 * arbitrary http:// target turns it into an open redirector.
 */
export const isAllowedRedirectUri = (raw: string): boolean;
```

Accept: `https://claude.ai/api/mcp/auth_callback`, `http://127.0.0.1:8976/cb`,
`http://[::1]:1/cb`, `http://localhost:3000/cb`, and `HTTPS://example.test/cb`
(scheme comparison is case-insensitive per RFC 3986 — assert it rather than
leaving it to chance). Refuse: `http://evil.test/cb`, any URI with a fragment
(`#`), a relative URI, `javascript:alert(1)`, and a URI that parses but has no
host. One test per case.

- [ ] **Step 2: `OAuthDeps`.** Mirror `AuthDeps`
      (`packages/http/src/auth.ts:30`): `{ scopes: ScopeFactory; now: () => number }`.
      Nothing else; the provider reaches storage only through Task 2.

- [ ] **Step 3: `beginAuthorization`** — validates before rendering anything.
      Given `{clientId, redirectUri, codeChallenge, codeChallengeMethod, scope, state}`:
      refuse an unknown `clientId`; refuse a `redirectUri` **not exactly equal
      to one registered to that client** (string equality, not prefix, not
      host); refuse `codeChallengeMethod !== 'S256'`; refuse a scope outside
      the known set. On success, mint `requestId = generateToken()` and
      `nonce = generateToken()`, store `hashToken(nonce)`, and return
      `{requestId, nonce}` for the form.

- [ ] **Step 4: `completeAuthorization`** — given `{requestId, nonce, accountId}`:
      consume the pending row (single-use, unexpired), verify
      `secretsMatch(hashToken(nonce), row.nonceHash)`, then mint a code:
      `code = generateToken()`, store `hashToken(code)` with a 5-minute expiry
      and the pending row's `codeChallenge`, `redirectUri`, `scopes`. Returns
      the code and the `state` to append to the redirect.

- [ ] **Step 5: `exchangeCode`** — given `{code, clientId, redirectUri, codeVerifier}`:
      1. look up `hashToken(code)`; unknown → refuse.
      2. **`usedAt !== null` → refuse AND `revokeTokensFromCode`** (ADR 0045
         D5; RFC 6749 §4.1.2). A replay is evidence the code leaked, so the
         tokens it already minted die.
      3. expired → refuse.
      4. `row.clientId !== clientId` → refuse. **This is refusal (a).**
      5. `row.redirectUri !== redirectUri` → refuse.
      6. PKCE: `base64url(sha256(codeVerifier)) === row.codeChallenge`, compared
         with `secretsMatch`. Mismatch → refuse.
      7. `markAuthorizationCodeUsed`, then mint an access token (1 h) and a
         refresh token (30 d), both `issuedFromCodeHash = hashToken(code)`.

      The base64url SHA-256, written out so there is no ambiguity:

```ts
const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');
```

- [ ] **Step 6: `refresh`** — rotates. The presented refresh token is revoked
      in the same write that mints its replacement, and the new pair carries
      `parentTokenId` of the old. A refresh token presented **after** it was
      rotated is refused **and** revokes its whole chain, on D5's reasoning.

- [ ] **Step 7: `revoke`** — RFC 7009. Revoking a refresh token also revokes
      the access token minted alongside it. An unknown token returns success
      (the RFC requires it) and reveals nothing.

- [ ] **Step 8: the seven refusals, each red first.** In `provider.test.ts`:

  (a) a code issued to client X, exchanged by client Y → refused;
  (b) the same code exchanged twice → second refused **and** the first
      exchange's access and refresh tokens are now revoked (assert both);
  (c) `codeChallengeMethod: 'plain'` at `beginAuthorization` → refused;
      and a verifier that would satisfy `plain` against an S256 challenge
      → refused;
  (d) a refresh rotates; presenting the old refresh token afterwards is
      refused and the new pair is revoked too;
  (e) a revoked access token fails verification **within the same millisecond**
      — revoke at `now`, verify at `now`, expect failure (no grace, no cache);
  (f) `completeAuthorization` for an account without `mcp.authorize`
      → refused. (Route-level enforcement is Task 4; here assert the provider
      refuses when told the account lacks it.)
  (g) a `redirectUri` not registered to the client → refused at
      `beginAuthorization`, before any pending row is written (assert the
      table is still empty).

- [ ] **Step 9: gates and commit** as `task 3`.

---

## Task 4: The routes, the metadata, and the consent page

**Files:** Create `packages/http/src/routes/oauth.ts`, `oauth.test.ts`,
`oauth/consent.ts`, `consent.test.ts`, `oauth/rate-limit.ts`,
`rate-limit.test.ts`. Modify `packages/http/src/server.ts` only as far as
registering the route module requires — read how `registerWriteRoutes` is
passed in (`packages/http/src/routes/write.test.ts:24-25`) and follow it.

- [ ] **Step 1: the rate limiter**, tests first. A fixed-window counter keyed
      by client IP, injected clock, no global state:
      `createRateLimiter({limit, windowMs, now})` → `{check(key): boolean}`.
      Tests: the nth request inside the window passes and the (n+1)th fails;
      the window rolls over on the injected clock; two keys do not interfere;
      memory does not grow without bound (old windows are dropped — assert the
      internal size after rollover). Applied to `POST /oauth/register` only.

- [ ] **Step 2: the consent page** (`consent.ts`). One function returning an
      HTML string. **This is the project's first server-rendered HTML and
      there is no escaping helper in the tree** (research §12), so write one:

```ts
/** The five XML entities. Every interpolated value goes through this. */
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;' })[c] as string);
```

      The page shows the client name, the redirect URI's **host only**, and
      the scopes; it has hidden `requestId` and `nonce` inputs, a username and
      password field, and approve and deny buttons. Tests: a client registered
      with the name `<script>alert(1)</script>` renders escaped and the raw
      string does not appear in the output; the nonce appears exactly once;
      the full redirect URI (with its path and query) does **not** appear —
      only the host — so a crafted URI cannot smuggle text into the page.
      Send `Content-Type: text/html; charset=utf-8` and
      `Content-Security-Policy: default-src 'none'` — the page needs no
      script, style or image, so the strictest policy is also the correct one.

- [ ] **Step 3: the routes.** Every body and query string through Zod.
  - `GET /.well-known/oauth-authorization-server` and
    `GET /.well-known/oauth-protected-resource` — static documents built from
    the configured public base URL. Test that `code_challenge_methods_supported`
    is exactly `['S256']` — advertising `plain` would invite it.
  - `GET /oauth/authorize` — `beginAuthorization`, then render. On refusal,
    render an error page; **never redirect to an unvalidated `redirect_uri`.**
  - `POST /oauth/authorize` — require `originMatchesHost`; parse the form
    (`application/x-www-form-urlencoded`); `verifyPassword` +
    `findAccountByUsername`; require `mcp.authorize` in at least one guild the
    account can reach (**refusal (f)**); then `completeAuthorization` and
    302 to the redirect URI with `code` and `state`. Deny → 302 with
    `error=access_denied`.
  - `POST /oauth/token` — `grant_type` of `authorization_code` or
    `refresh_token`; anything else → `unsupported_grant_type`. Errors use the
    RFC 6749 §5.2 JSON shape (`{error, error_description}`) with the right
    codes — `invalid_grant`, `invalid_client`, `invalid_request`.
  - `POST /oauth/register` — rate-limited, `isAllowedRedirectUri` on every
    URI, `registration_source: 'dynamic'`.
  - `POST /oauth/revoke` — always 200.
- [ ] **Step 4: route tests** with `app.inject`, following
      `packages/http/src/routes/write.test.ts`. Include refusal (f) end to end
      and refusal (g) at `GET /oauth/authorize`. Assert that **no response
      body and no log line contains a raw code or token** except the token
      response itself.
- [ ] **Step 5: gates and commit** as `task 4`.

---

## Task 5: Bearer verification, the live guild set, and redaction

**Files:** Create `packages/http/src/oauth/bearer.ts`, `bearer.test.ts`.
Modify the `LOGGABLE_FIELDS` file (research §8 names it) and add the log-scan
test — research §8 reports **no captured-log-stream secret scan exists**, so
this creates one.

- [ ] **Step 1: `verifyBearer(deps, authorizationHeader)`.** Parses
      `Bearer <token>`, looks up `hashToken(value)`, and returns
      `{accountId, clientId, tokenId, scopes}` or a typed failure. Checks, in
      order: present, `kind === 'access'`, not revoked, not expired. **Every
      request, no caching** — assert in a test that two calls issue two
      lookups (inject a counting repo).
- [ ] **Step 2: the RFC 9728 challenge.** No token, or a bad one, answers 401
      with `WWW-Authenticate: Bearer resource_metadata="<the
      oauth-protected-resource URL>"`. Test the header string exactly.
- [ ] **Step 3: `reachableGuilds(deps, accountId): readonly GuildId[]`** —
      ADR 0045 PR-92. The guilds in which the account **currently** holds
      `mcp.authorize`, intersected with the guilds the daemon serves. Tests:
      an account granted in guild A only returns `[A]` even when it can
      access B; **revoking the grant in A changes the answer on the very next
      call with no token change**; an account with no grants returns `[]` and
      that is not an error at this layer.
- [ ] **Step 4: redaction.** Add `oauth_client_id` and `oauth_token_id` to
      `LOGGABLE_FIELDS`, each with a comment saying why it is safe (an id is
      not a credential; the value is never logged).
- [ ] **Step 5: the log-scan test.** Capture a Pino stream through a full
      authorize → exchange → refresh → revoke cycle, and fail if the raw
      access token, refresh token, code, nonce or password appears anywhere in
      the captured output. **Then plant a `logger.info({ token })` call
      temporarily, watch the test fail, and remove it.** Report that you did.
- [ ] **Step 6: gates and commit** as `task 5`.

---

## Task 6: The operator CLI

**Files:** Create `packages/core/src/ops/commands/mcp.ts`, `mcp.test.ts`.
Modify `packages/core/src/ops/ports.ts` and `packages/core/src/ops/registry.ts`.

**`OpsInstance` has FIVE object literals, not four.** Every new member must be
added to all five or the build breaks:
1. `apps/daemon/src/ops/wiring.ts:823` (`opsInstanceFor`, production)
2. `packages/http/src/test-support.ts:531` (`testInstanceFor`)
3. `packages/core/src/ops/test-fixtures.ts:101` (`fakeOpsInstance`)
4. `packages/storage/src/repos/automod-rule-lists.test.ts:211`
5. `apps/daemon/src/automod.integration.test.ts:424`

- [ ] **Step 1: the ports.** Add to `OpsInstance`: `mcpListClients()`,
      `mcpListTokens()`, `mcpRevokeToken(tokenId)`, `mcpRevokeClient(clientId)`,
      `grantAccountCapability(guildId, accountId, capability)`.
- [ ] **Step 2: the commands**, following `backupNowCommand`
      (`packages/core/src/ops/commands/backup.ts:26-61`) exactly — `defineCommand`,
      `write: true` where it changes state, a Zod `args` schema, and an
      `audit` record on every write (the type will not compile without one).
  - `mcp clients` (read) — id, name, source, created, redirect URI count.
  - `mcp tokens` (read) — token **id**, kind, client, account, expiry,
    last-used, revoked. **Never a token value** — there is none to print.
  - `mcp revoke <token_id> --confirm` (write).
  - `mcp revoke-client <client_id> --confirm` (write) — revokes the client's
    tokens too, and says how many in the text and the audit `after`.
  - `account grant <account> <capability> --guild <id> --confirm` (write).
    **`--guild` is required and is not optional** — capabilities are keyed
    `(guild_id, account_id, capability)` (`packages/storage/src/schema.ts:1461`),
    so a grant without a guild is not representable. Research §9 confirms **no
    such command exists today**; this creates it. Validate the capability
    against `CAPABILITIES` and refuse an unknown one by name.
- [ ] **Step 3: register** in `OPERATOR_COMMANDS`
      (`packages/core/src/ops/registry.ts:54-103`), in the existing grouping.
- [ ] **Step 4: tests**, following an existing command test. Include: a write
      without `--confirm` is refused **before** argument validation
      (`packages/core/src/ops/dispatch.ts:284-294`); `mcp tokens` output
      contains no 43-character base64url-looking value; `account grant` with an
      unknown capability is refused.
- [ ] **Step 5: gates and commit** as `task 6`.

---

## Task 7: Conformance against the SDK's own client

**Files:** Create `packages/http/src/oauth/conformance.test.ts`.
Modify the root `package.json`.

- [ ] **Step 1: the devDependency.** `npm install --save-dev
      @modelcontextprotocol/sdk@1.30.0`. It is MIT (verified 2026-09-13).
      Record the one-line justification in the commit message: *the reference
      implementation of the protocol this server must speak; M3 uses it for
      types and this conformance test only, and no SDK code runs in the
      daemon.* Confirm in your report that it landed under `devDependencies`
      and **not** `dependencies`.
- [ ] **Step 2: the end-to-end test.** Start the real Fastify app on loopback,
      then, using the SDK's OAuth client helpers: discover metadata, register
      dynamically, drive `GET /oauth/authorize`, submit the consent form with
      the seeded account's credentials, follow the redirect, exchange the code
      with the PKCE verifier, call a stub `/mcp` route with the bearer token,
      refresh, call again, revoke, and assert the next call is 401 with the
      RFC 9728 challenge.
- [ ] **Step 3: if the SDK's client helpers do not fit a test harness**, do not
      force them: report `NEEDS_CONTEXT` with what you found. Do **not**
      silently substitute a hand-rolled client — the whole value of this task
      is that the client is not ours.
- [ ] **Step 4: gates and commit** as `task 7`.

---

## Self-review notes (controller)

Spec coverage against the M3 slice text: tests-first ✓ (T3 step 8, all seven);
schema ✓ (T1, plus the pending table Amendment 1 added); provider ✓ (T3);
routes ✓ (T4); consent page ✓ (T4 step 2); bearer middleware ✓ (T5); CLI ✓
(T6); conformance ✓ (T7); redaction ✓ (T5 steps 4-5).

Three things the slice text assumed that the tree does not have, each now a
step rather than an assumption: no capability-grant CLI command (T6), no rate
limiter (T4 step 1), no server-rendered HTML or escaping helper (T4 step 2).
One thing the slice text got wrong: `mcp.authorize` is per-guild, so the
reachable set is computed live (T5 step 3, ADR 0045 PR-92).
