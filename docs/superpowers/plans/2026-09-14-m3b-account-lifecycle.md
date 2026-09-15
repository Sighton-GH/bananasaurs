# Slice M3b — dashboard account disable, enable, delete

**Status: DRAFT.** Written 2026-09-14, before implementation.
**Branch:** `oc/m3b-account-lifecycle`. **ADR:** none new — ADR 0045
Amendment 3 (already appended) records the four decisions.

## Why this slice exists

ADR 0045 D6 promises "revoking the account revokes everything it approved."
The M3 whole-branch review established that **nothing in this tree can
disable or delete a dashboard account** — no route, no CLI command, no
repository function; `dashboard_accounts.disabled` is read in four places
(`packages/http/src/auth.ts:101,175`, `packages/http/src/oauth/provider.ts:289,410,495`)
and written in none outside tests. D6 is a promise with no trigger. This
slice ships the trigger and proves it.

## Global constraints (copy verbatim into every brief)

1. **Guild scope is a mandatory partition key** (CLAUDE.md rule 2). These
   functions are the documented *instance-level* exception (ADR 0027):
   `dashboard_accounts` has no `guild_id` and an account exists before a
   guild is chosen. Every new repository function therefore takes
   `InstanceScope` as its first parameter and uses `readInstance` /
   `writeInstance`. **Never** add a `guild_id` column or a `GuildScope`
   overload here.
2. **Every gate must be watched failing before it is believed** (CLAUDE.md
   "Verify, do not assert"). Each test listed below must be written and seen
   red before the code that makes it green.
3. **No secrets anywhere.** `password_hash` never appears in a command's
   `text` or `data`, never in a log line, never in an audit row's `before`
   or `after`.
4. **Do not touch** `mod_rules`, `setRuleMode`, `packages/core/src/effects/gateway.ts`,
   or anything under `packages/core/src/mod/` and `packages/core/src/automod/`.
   The observe clock is running on two live guilds.
5. `packages/core/src/ops/ports.ts` may **not** import `@bananasaurs/storage`
   (ADR 0014). Port types are hand-written projections; the mapping happens
   in `apps/daemon/src/ops/wiring.ts`.
6. Gates: `npm run typecheck && npm run lint && npm run test` must all pass,
   by exit code, before any task reports DONE.

---

## Task 1 — repository functions

**File:** `packages/storage/src/repos/accounts.ts` (append to the
`// --- accounts` region, before `// --- guild access`).
**Tests:** `packages/storage/src/repos/accounts.test.ts`.

### 1a. `setAccountDisabled`

```ts
/**
 * Disables or re-enables an account (ADR 0045 Amendment 3, A3-1).
 *
 * The lever ADR 0045 D6 promised and M3 did not have: `disabled` was read in
 * five places and written in none outside tests, so "revoking the account
 * revokes everything it approved" had no trigger. Returns `false` for an
 * unknown id, so the caller can tell "no such account" from "already in that
 * state" — both write nothing, and they are different answers to an operator.
 *
 * It does NOT touch `failed_attempts` or `locked_until` (A3-4): a lockout
 * (ADR 0029) answers a different question, and clearing it as a side effect
 * of enabling would make the login throttle depend on an unrelated command.
 */
export const setAccountDisabled = (
  scope: InstanceScope,
  input: { accountId: string; disabled: boolean },
): boolean =>
  writeInstance(scope, ({ db }) => {
    const result = db
      .update(dashboardAccounts)
      .set({ disabled: input.disabled ? 1 : 0 })
      .where(eq(dashboardAccounts.accountId, input.accountId))
      .run();
    return result.changes === 1;
  });
```

### 1b. `deleteAccount`

Signature and contract:

```ts
export interface AccountDeletion {
  readonly deleted: boolean;
  /** OAuth tokens revoked in the same transaction. */
  readonly tokensRevoked: number;
  /** Unexchanged authorization codes deleted in the same transaction. */
  readonly codesDeleted: number;
}

export const deleteAccount = (
  scope: InstanceScope,
  input: { accountId: string; now: number },
): AccountDeletion
```

One `writeInstance` transaction, in this order:

1. `UPDATE oauth_tokens SET revoked_at = now WHERE account_id = ? AND revoked_at IS NULL`
   — count into `tokensRevoked`.
2. `DELETE FROM oauth_authorization_codes WHERE account_id = ?` — count into
   `codesDeleted`.
3. `DELETE FROM dashboard_accounts WHERE account_id = ?` — `deleted` is
   `changes === 1`.

Import `oauthTokens` and `oauthAuthorizationCodes` from `../schema.js`.

Why steps 1 and 2 exist when `verifyAccessToken` already returns
`account-gone` (ADR 0045 Amendment 3, A3-2): `oauth_tokens.account_id`
carries no foreign key, deliberately, so the rows survive the account. Left
alone they would print as **live** in `bananasaurs mcp tokens` for up to
thirty days, and a revocation that depends on a second module's check is the
exact shape Amendment 2 found false in two directions.

When `deleted` is `false` (unknown id), steps 1 and 2 will have matched
nothing anyway — no separate existence check is needed, and adding one would
be a second place the answer is decided.

### 1c. `countEnabledOwners`

```ts
/** `is_owner = 1 AND disabled = 0`. The commands use it for A3-3's warning. */
export const countEnabledOwners = (scope: InstanceScope): number
```

### 1d. `listAccounts`

```ts
/** Every account, oldest first. The observation surface for a disable. */
export const listAccounts = (scope: InstanceScope): readonly AccountRow[]
```

**Ruling M3b-R1:** `listAccounts` and the `account list` command in Task 3
are not in the owner's one-line spec for this slice. They ship anyway,
because without them nothing in the tree can *show* that a disable took
effect, and CLAUDE.md's "verify, do not assert" makes an unobservable write
a half-shipped one. Cost if wrong: one read command and one repository
function nobody uses.

### Tests for Task 1 (write each, watch it fail, then implement)

In `packages/storage/src/repos/accounts.test.ts`, using the existing
`openMigratedTestDatabase()` helper the file already uses:

1. `setAccountDisabled` flips `disabled` to `true`, and `findAccountById`
   reports it — **and `setAccountDisabled(..., {disabled: false})` flips it
   back.**
2. `setAccountDisabled` returns `false` for an unknown account id and writes
   nothing (assert the row count is unchanged).
3. `setAccountDisabled` does **not** change `failedAttempts` or
   `lockedUntil`: seed an account, call `recordFailedAttempt` twice, disable,
   enable, assert both fields are exactly what `recordFailedAttempt` left.
4. `deleteAccount` removes the row and returns `{ deleted: true }`.
5. `deleteAccount` revokes the account's live OAuth tokens and reports the
   count: create two tokens via `oauthRepo.createToken` (one access, one
   refresh) plus one already-revoked token, delete, assert `tokensRevoked`
   is **2** and every row's `revokedAt` is non-null. An already-revoked
   token's `revokedAt` must be **unchanged** — assert the original value.
6. `deleteAccount` does **not** revoke another account's tokens: seed two
   accounts each with a live token, delete one, assert the other's token is
   still live.
7. `deleteAccount` deletes the account's authorization codes and leaves
   another account's codes alone.
8. `deleteAccount` cascades `account_guild_access`, `account_capabilities`
   and `dashboard_sessions`: seed an account with guild access in two
   guilds, a capability in each, and a session; delete; assert all three
   tables hold zero rows for that account and still hold the *other*
   account's rows. (The cascade is the schema's, not this function's — the
   test pins that it is really on, per `schema-invariants.test.ts`'s
   precedent.)
9. `deleteAccount` returns `{ deleted: false, tokensRevoked: 0, codesDeleted: 0 }`
   for an unknown id.
10. `deleteAccount` does **not** delete `audit_events` rows or
    `oauth_clients` rows whose `created_by_account_id` is the deleted
    account — the trail outlives the account. Assert both survive.
11. `countEnabledOwners` counts owners that are not disabled: seed two
    owners and one non-owner, assert 2; disable one owner, assert 1.
12. `listAccounts` returns every account oldest first and never exposes a
    plaintext password — assert `passwordHash` is the hash that was written
    and that no field equals the plaintext.

**Verification:** `npm run typecheck && npm run lint && npx vitest run packages/storage/src/repos/accounts.test.ts`

---

## Task 2 — the `OpsInstance` members and the daemon wiring

**Files:**
- `packages/core/src/ops/ports.ts` (types + three members on `OpsInstance`)
- `packages/core/src/ops/test-fixtures.ts` (`fakeOpsInstance`)
- `apps/daemon/src/ops/wiring.ts` (the implementation)

### 2a. Types in `ports.ts`

Place these beside the existing `OpsMcpClient` / `OpsMcpToken` types.

```ts
/** One dashboard account, as the operator CLI shows it. Never a hash. */
export interface OpsAccount {
  readonly accountId: string;
  readonly username: string;
  readonly isOwner: boolean;
  readonly disabled: boolean;
  readonly lockedUntil: number | null;
  readonly createdAt: number;
}

/**
 * What `account disable|enable` did. `'no-such-account'` is a distinct
 * outcome from `changed: false`: one is a usage mistake, the other is an
 * account that was already in the state asked for.
 */
export type OpsAccountDisableResult =
  | 'no-such-account'
  | {
      readonly changed: boolean;
      readonly username: string;
      readonly isOwner: boolean;
      readonly disabled: boolean;
      /** A live lockout the operator should know about (A3-4). */
      readonly lockedUntil: number | null;
      /** Enabled owners remaining AFTER the write. */
      readonly enabledOwnersRemaining: number;
    };

/** What `account delete` did. */
export type OpsAccountDeleteResult =
  | 'no-such-account'
  | {
      readonly username: string;
      readonly accountId: string;
      readonly wasOwner: boolean;
      readonly tokensRevoked: number;
      readonly codesDeleted: number;
      /** Enabled owners remaining AFTER the delete. */
      readonly enabledOwnersRemaining: number;
    };
```

### 2b. Three members on `OpsInstance`

Add after `mcpRevokeClient`, with a doc comment saying why they are on
`OpsInstance` and not `OpsPorts` (the same reason `reissueBootstrapToken`
is: `dashboard_accounts` is instance-level, ADR 0027 — there is no guild in
the question and none in the answer):

```ts
  /** ADR 0045 Amendment 3: every dashboard account. No hash ever crosses this boundary. */
  accountList(): readonly OpsAccount[];
  /** ADR 0045 Amendment 3 A3-1: the D6 lever. Looks the account up by username. */
  accountSetDisabled(username: string, disabled: boolean): OpsAccountDisableResult;
  /** ADR 0045 Amendment 3 A3-2: deletes the account AND revokes its OAuth tokens in one transaction. */
  accountDelete(username: string): OpsAccountDeleteResult;
```

### 2c. `fakeOpsInstance`

Add all three as `unstubbed('accountList')` etc., matching the file's
existing convention exactly.

### 2d. The wiring in `apps/daemon/src/ops/wiring.ts`

Implement the three members on the `OpsInstance` object literal, next to the
`mcp*` members, using `deps.instanceScope` and `deps.now()`. Projections
field by field — `accountList` maps `AccountRow` to `OpsAccount` and
**must not carry `passwordHash`**. `accountSetDisabled` and `accountDelete`
resolve the username with `accountRepo.findAccountByUsername` first and
return `'no-such-account'` when it is `undefined`; `enabledOwnersRemaining`
is read with `countEnabledOwners` **after** the write.

### Tests for Task 2

Extend the existing wiring test file (find it with
`ls apps/daemon/src/ops/*.test.ts`; if there is no wiring test for the
`mcp*` members, put these in the nearest existing daemon ops test and say so
in the RESULT). Each written and watched red first:

1. `accountList` never exposes `passwordHash`: seed an account with a known
   hash, assert `JSON.stringify(accountList())` does not contain it.
2. `accountSetDisabled('nobody', true)` is `'no-such-account'` and writes
   nothing.
3. `accountSetDisabled` on an already-disabled account returns
   `changed: false` and still reports the correct `disabled: true`.
4. `accountDelete` reports the token count the repository revoked.
5. `enabledOwnersRemaining` is the count **after** the write: disable the
   only enabled owner, assert `0`.

**Verification:** `npm run typecheck && npm run lint && npm run test`

---

## Task 3 — the CLI commands

**Files:**
- `packages/core/src/ops/commands/account.ts` (append; the file already
  holds `accountGrantCommand`)
- `packages/core/src/ops/commands/account.test.ts`
- `packages/core/src/ops/registry.ts` (register all four)

Four commands. `list` is `write: false`; the other three are `write: true`,
which is what makes `--confirm` mandatory — it is a global flag the
dispatcher enforces (`dispatch.ts:288`), so **do not declare a `--confirm`
flag on the command**.

### `account list`

`write: false`, no args. Renders one line per account:
`<username>  <accountId>  owner|member  enabled|DISABLED  created <iso>`,
plus `  locked until <iso>` when `lockedUntil` is in the future relative to
`ctx.now()`. Empty case: `'no dashboard accounts'`. `data` is the array of
`OpsAccount`.

### `account disable` / `account enable`

One positional `username`, validated with **the same Zod username schema
`accountGrantCommand` already uses** — extract that schema to a shared
const in this file rather than copying the regex a third time.

- `'no-such-account'` → `throw new Error(\`no dashboard account ${username}\`)`
  (the file's existing convention: a usage mistake that changed nothing
  produces no audit row).
- `changed: false` → return an `OpsWriteResult` saying nothing changed, with
  `audit.after.changed: false`, exactly the shape `accountGrantCommand`'s
  `'already-held'` branch uses.
- Success text for `disable`:
  `` `disabled ${username}; every dashboard session and OAuth token it approved stops verifying on the next request` ``
- Success text for `enable`: `` `enabled ${username}` ``, and when
  `lockedUntil` is in the future, append a second line:
  `` `note: ${username} is locked out until ${iso(lockedUntil)}; enabling does not clear a lockout` ``
- **A3-3's warning**, appended to `disable`'s text when
  `enabledOwnersRemaining === 0`:
  `` `WARNING: that was the last enabled owner account. Nobody can sign in to the dashboard. Re-enable it with \`bananasaurs account enable ${username} --confirm\`.` ``
- Audit: `action: 'account.disabled'` / `'account.enabled'`,
  `subjectType: 'account'`, `subjectId: username`,
  `before: { disabled: <prior> }`, `after: { disabled: <new>, changed }`.

### `account delete`

One positional `username`, same schema.

- `'no-such-account'` → throw, as above.
- Success text, on three lines:
  1. `` `deleted ${username} (${accountId})` ``
  2. `` `revoked ${n} OAuth token(s) and removed ${m} unexchanged authorization code(s); guild access, capabilities and dashboard sessions cascaded` ``
  3. when `enabledOwnersRemaining === 0`:
     `` `WARNING: that was the last enabled owner account. Nobody can sign in to the dashboard. Run \`bananasaurs bootstrap reissue --confirm\` to re-arm the setup page.` ``
- Audit: `action: 'account.deleted'`, `subjectType: 'account'`,
  `subjectId: username`, `before: { exists: true, isOwner }`,
  `after: { exists: false, tokensRevoked, codesDeleted }`.

### Registry

Import and register all four in `packages/core/src/ops/registry.ts`
alongside `accountGrantCommand`, in the order
`list, disable, enable, delete, grant`.

### Tests for Task 3

`packages/core/src/ops/commands/account.test.ts`, following the file's
existing `fakeOpsInstance` / dispatch patterns. Each written and watched red
first:

1. **`--confirm` really gates each of the three writes.** Dispatch
   `account disable alice` without `--confirm` and assert the refusal is
   `needs-confirm` **and that the port was never called** (a spy that throws
   if invoked). Repeat for `enable` and `delete`. This is the guard the
   slice most needs watched failing: neutralise `write: true` and this test
   must go red.
2. `account list` on an empty instance says `no dashboard accounts`.
3. `account list` marks a disabled account `DISABLED` and an enabled one
   `enabled`, and renders a future `lockedUntil` and not a past one.
4. `account disable` on an unknown username throws and writes no audit row.
5. `account disable` on an already-disabled account returns `changed: false`
   in both `data` and `audit.after`.
6. The last-enabled-owner warning appears in `disable`'s text when
   `enabledOwnersRemaining` is 0 and **does not** appear when it is 1.
7. `account enable` appends the lockout note when `lockedUntil` is in the
   future and omits it when it is null.
8. `account delete` renders the token and code counts, and the
   `bootstrap reissue` warning only at zero remaining owners.
9. **No password hash reaches the output** of any of the four commands:
   give the fake port an account whose `username` is normal, assert the
   rendered `text` and `JSON.stringify(data)` contain no `$argon2` substring.
10. `account list` is `write: false` — dispatching it **without**
    `--confirm` succeeds.

**Verification:** `npm run typecheck && npm run lint && npm run test`

---

## Task 4 — the end-to-end proof

**File:** `packages/http/src/oauth/bearer.test.ts` (append a new `describe`).
This file already opens a migrated database, seeds an owner account with
`mcp.authorize` in guild A, mounts the real OAuth routes with
`registerOAuthRoutes`, and serves a `/mcp-stub` route behind `requireBearer`.
Use that harness exactly as it stands; add nothing to it beyond the new
tests.

This is the test the owner named: **a deleted account's live OAuth tokens
stop verifying on the very next request.**

1. **Delete stops a live access token on the next request.** Mint a token
   through the real flow the file already uses. `GET /mcp-stub` with it →
   **200**. Then `accountRepo.deleteAccount(t.scopes.instance(), { accountId: ACCOUNT, now: clock })`.
   Advance nothing — the same clock, the same token. `GET /mcp-stub` again →
   **401**, with `WWW-Authenticate` exactly equal to `CHALLENGE`.
2. **Delete stops the refresh token too.** After the delete, `POST` the
   refresh grant to the real token endpoint with the refresh token minted
   beside that access token → a `400`/`invalid_grant` refusal (assert
   whatever the existing refresh-failure tests in this file assert, so the
   two agree), and assert the row's `revokedAt` is non-null.
3. **Disable stops a live access token on the next request.** Same shape as
   (1) with `accountRepo.setAccountDisabled(..., { disabled: true })` → 401.
4. **Enable restores it.** After (3), `setAccountDisabled(..., { disabled: false })`
   and assert the *same* token is **200** again — the guard reads the
   account live on every request and caches nothing, which is the property
   ADR 0045 Amendment 2 depends on.
5. **Break the guard and watch it fail.** Not a test — a step for the
   implementer to perform and report: temporarily comment out the
   `if (account.disabled) return { ok: false, reason: 'account-disabled' };`
   line in `packages/http/src/oauth/provider.ts` (~line 495), run test (3),
   quote the failure text in the RESULT block, then restore the line. A
   guard nobody has watched fail is not accepted.

**Verification:** `npm run typecheck && npm run lint && npm run test`

---

## Task 5 — documentation

**Files:** `docs/17_OPERATOR_ACCESS.md`, `docs/STATE.md`.
Do **not** touch `docs/decisions/0045-*.md` — Amendment 3 is already written
and is the controller's.

1. `docs/17_OPERATOR_ACCESS.md`: add the four commands to whatever table or
   list enumerates the operator surface, in the same format the existing
   `account grant` and `mcp …` entries use. Find it with
   `grep -n "account grant" docs/17_OPERATOR_ACCESS.md`. If `account grant`
   is not listed there, say so in the RESULT and add nothing.
2. `docs/STATE.md`: add one paragraph after the Slice M3 paragraph (the one
   beginning `**Slice M3 — the OAuth 2.1 authorization server**`), in the
   same voice as its neighbours, saying: M3b merged; the four commands; that
   `deleteAccount` revokes tokens and codes in the same transaction; the
   final test count from the green run; and that ADR 0045 D6 now has a
   trigger at both ends while the empty-reachable-set obligation still
   stands for M4. Do **not** edit the "Next action" paragraph — the
   controller owns it.

**Verification:** `npm run typecheck && npm run lint && npm run test`

---

## What "done" means

- `npm run typecheck && npm run lint && npm run test` green by exit code on
  the branch, with the test count recorded.
- Task 4's test (1) passes, and the implementer has quoted the failure text
  from Task 4 step (5).
- `--confirm` has been watched gating all three write commands.
- No `password_hash` in any command output, log line, or audit row.
