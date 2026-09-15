# Slice M3c — `account revoke-credentials`

**Status: DRAFT.** Written 2026-09-15, before implementation.
**Branch:** `oc/m3c-revoke-credentials`. **ADR:** none new — ADR 0045
Amendment 3 gains a fifth decision, A3-5.

## Why

M3b's whole-branch review found that `account disable` is a **pause, not a
rotation**: both guards are live re-reads, so everything stops while the
account is disabled and `account enable` hands every credential back intact —
a stolen session cookie authenticates again, a stolen refresh chain mints a
fresh thirty-day pair. The slice's own tests assert that, correctly: it is
what proves nothing is cached. But `docs/17` presented `disable` as the
ADR 0045 D6 lever for a compromised account, and for that purpose a pause is
not enough. `sessionRepo.revokeAllForAccount` and
`accountRepo.setPasswordHash` both exist, are tested, and have **zero
production callers**.

The owner's call, 2026-09-15: ship the rotation command.

## The shape, decided

**Ruling M3c-R1 — one command that revokes both credential kinds, leaving the
account enabled.** `bananasaurs account revoke-credentials <username>
--confirm` revokes every live dashboard session **and** every live OAuth
token, and does not touch `disabled`. Composable: `disable` pauses,
`revoke-credentials` rotates, both together mean locked out *and* rotated.
Each command keeps one meaning, which is A3-4's principle and which held up
well in M3b. Folding revocation into `disable` would also break the two
`bearer.test.ts` tests that prove nothing is cached, and those are
load-bearing for M4. Cost if wrong: an operator responding to a compromise
types two commands instead of one.

**Ruling M3c-R2 — revocation is by account, which makes lineage-versus-chain
moot, and the ADR should say so rather than leaving it inferred.** ADR 0044
obligation 2 requires every new revocation surface to choose lineage over
chain deliberately. Here the predicate is `account_id`, which is a strict
superset of both: every lineage the account owns is covered, so the hazard
PR-127 describes — a walk that spares the sibling token minted beside the one
you revoked — cannot arise. Cost if wrong: nothing; the broader predicate
cannot under-revoke.

**Ruling M3c-R3 — sessions are guild-scoped, so the port needs the guild
scopes.** `sessionRepo.revokeAllForAccount` takes a `GuildScope`
(`dashboard_sessions` carries `guild_id`), while `dashboard_accounts` and
`oauth_tokens` are instance-level. Revoking instance-wide therefore means
iterating every guild this daemon serves. `OpsInstanceDeps` gains
`guildScopes: readonly GuildScope[]`, built in `daemon.ts` from the same
allowlist `contextFor` already uses, and `accountOpsFor` takes it. Cost if
wrong: one more constructor parameter.

**Ruling M3c-R4 — two transactions, not one.** M3b's `deleteAccount` puts its
three writes in one transaction because a crash between them would leave the
account gone and its tokens live. Here there is no such asymmetry: a crash
between the session revoke and the token revoke leaves some credentials
revoked and some not, which is exactly the state a retry fixes, and
`writeInstance` does not nest so one transaction across an instance-level and
several guild-scoped writes is not available anyway. The command reports what
it actually revoked. Cost if wrong: an operator re-runs the command.

## Global constraints (copy verbatim into the brief)

1. **Guild scope is a mandatory partition key** (CLAUDE.md rule 2).
   `dashboard_sessions` is guild-partitioned and its revocation takes a
   `GuildScope` through `scope.only(...)`. `dashboard_accounts` and
   `oauth_tokens` are the documented instance-level exception (ADR 0027).
2. **Every gate must be watched failing before it is believed.**
3. **No secrets anywhere.** No password hash, no session id, no token value
   in any output, log line or audit row — ids and counts only.
4. **Do not touch** `mod_rules`, `setRuleMode`, `packages/core/src/mod/`,
   `packages/core/src/automod/`, `packages/core/src/effects/gateway.ts`. The
   observe window is running on two live guilds.
5. **Do not change what `disable` or `enable` do.** The two `bearer.test.ts`
   tests that prove a re-enabled account's token verifies again must still
   pass, unchanged. They are not a bug.
6. Gates: `npm run typecheck && npm run lint && npm run test` pass by exit
   code.

## Tasks

### Task 1 — the repository function, the port, the command, and the proof

One task; it is small and the parts are meaningless separately.

1. **`oauthRepo.revokeAllTokensForAccount(scope: InstanceScope, { accountId, now }): number`**
   in `packages/storage/src/repos/oauth.ts` — `UPDATE oauth_tokens SET
   revoked_at = now WHERE account_id = ? AND revoked_at IS NULL`, returning
   `changes`. Doc comment states ruling M3c-R2: the predicate is the account,
   which covers every lineage, so the lineage-versus-chain choice ADR 0044
   obligation 2 requires does not arise here. Note that `deleteAccount` in
   `accounts.ts` performs the same statement inline and must **not** be
   changed to call this — it needs that write inside its own transaction and
   `writeInstance` does not nest.

2. **`OpsInstanceDeps` gains `guildScopes: readonly GuildScope[]`**, passed
   from `daemon.ts` (build it from the same allowlist `contextFor` uses), and
   `accountOpsFor` takes it as a parameter.

3. **`OpsInstance.accountRevokeCredentials(username)`** returning
   `'no-such-account'` or
   `{ username, accountId, sessionsRevoked, tokensRevoked, guildsTouched, stillEnabled }`.
   `stillEnabled` is the account's `disabled` flag inverted, read after the
   writes — it is in the result so the command can say plainly that this was
   a rotation and not a lockout.

4. **`accountRevokeCredentialsCommand`** — `account revoke-credentials`,
   `write: true`, one positional `username` using the file's shared schema.
   `'no-such-account'` throws, like its neighbours. Success text:

   - `` `revoked ${n} dashboard session(s) and ${m} OAuth token(s) for ${username} across ${g} guild(s)` ``
   - `` `${username} is still enabled and can sign in again with its existing password. To stop it signing in at all, use \`account disable\`; to remove it, \`account delete\`.` ``
   - when the account is disabled at the time: replace the second line with
     `` `${username} is disabled, so it cannot sign in regardless; these credentials will not work if it is re-enabled.` ``

   Audit: `action: 'account.credentials.revoked'`, `subjectType: 'account'`,
   `subjectId: username`, `before: {}`, `after: { sessionsRevoked,
   tokensRevoked, guildsTouched }`. Register it in `registry.ts` beside the
   other four.

5. **The proof, in `packages/http/src/oauth/bearer.test.ts`**, in the
   existing M3b `describe`: mint a token through `mintToken()`, confirm
   `GET /mcp-stub` is 200, call `oauthRepo.revokeAllTokensForAccount`, and
   assert the very next request with the same token and the **same clock** is
   401 with the `CHALLENGE` — and, unlike the disable tests, that the account
   is **still enabled** (`findAccountById(...).disabled === false`). That
   last assertion is the whole point of the slice: the credential died and
   the account did not.

6. **Docs.** `docs/17_OPERATOR_ACCESS.md` — add the command to the Release 2
   block and **replace** the paragraph saying "there is no command in this
   release that rotates a password or ends an account's sessions without
   deleting the account", since it is about to be false. Keep the honest
   remainder: there is still no **password** reset, so an attacker who knows
   the password can sign in again after a revoke, and `account disable` or
   `account delete` is the answer to that.

### Tests, each watched red first

1. `revokeAllTokensForAccount` revokes every live token of the account and
   leaves an already-revoked token's `revokedAt` unchanged.
2. It does not touch another account's tokens.
3. `accountRevokeCredentials` revokes sessions in **every** guild the daemon
   serves, not just one — seed a session for the account in two guilds,
   assert both are revoked and `guildsTouched === 2`.
4. It does not revoke another account's sessions in either guild.
5. It leaves `disabled` untouched: disabled stays disabled, enabled stays
   enabled, and `stillEnabled` reports it correctly in both cases.
6. `'no-such-account'` for an unknown username; the command throws and writes
   no audit row.
7. `--confirm` gates it: dispatch without it, assert `needs-confirm` and that
   the port was never called.
8. The `bearer.test.ts` proof from step 5.
9. **Break it and watch it fail**: neutralise the `revoked_at IS NULL`
   predicate — or whichever line the reviewer would most like to see
   defended — run the covering test, quote the failure, restore.

## Not in M3c

A password reset. `setPasswordHash` still has zero callers, so there is no
reset path except `account delete` plus `bootstrap reissue`. That is a real
gap and it is recorded in `docs/STATE.md`, but a CLI that sets a password
needs a delivery story, and the dashboard's own change-password covers the
normal case. Not now.
