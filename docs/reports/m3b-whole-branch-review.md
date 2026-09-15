# Slice M3b whole-branch review — Opus, 2026-09-15

Reviewer: Claude Opus 5 via the Agent tool (brief:
`.oc-runs/m3b-account-lifecycle/final-review-brief.md`; diff:
`.oc-runs/20260915T084107-oc_m3b-account-lifecycle.branch.diff`, base
`417c62c`, head `98b8437`, 24 commits, 2,298 diff lines over 15 files).
Read outside the diff throughout — the schema, `packages/http/src/auth.ts`,
`packages/cli/src/args.ts`, `packages/core/src/ops/dispatch.ts`,
`packages/storage/src/repos/sessions.ts` and the deployed `.env`. Three
Node probes against a migrated SQLite database driving the real
`accountOpsFor` and the real `createDispatcher`, plus the four focused
vitest suites (105 tests, green).

**No Critical.** This is the first slice in the run where the whole-branch
read did not turn one up, and I want to be plain about that rather than
inflate something to fill the slot. The storage layer, the port mapping and
the six bearer tests are correct and prove what they claim. Everything below
is either operator-facing text that is wrong in a state the operator will
actually be in, or a gap the slice inherited and did not close.

---

Verdict: **SHIP-WITH-FIXES**

### Findings

**[Important] `docs/17_OPERATOR_ACCESS.md:72` — "The four `account` commands
are instance-level (ADR 0027) and take no `--guild` flag" is false on the
instance this daemon actually runs.** `createDispatcher` resolves a guild
for *every* command, before argument validation and before the command's
`run` is ever reached (`packages/core/src/ops/dispatch.ts:281`, calling
`resolveGuild` at `:242`); with more than one allowlisted guild and no
`--guild`, it fails with `unknown-guild`. `BANANASAURS_GUILD_ALLOWLIST` in
the deployed `.env` holds **two** guild ids. Executed, against the built
catalogue with two guild ids: `account list` with no guild returned
`{"ok":false,"code":"unknown-guild","message":"this instance serves 2
guilds, so the command must say which: pass --guild <id>"}`; the same
command with `--guild` returned 200 and called `accountList`. So an operator
following the new paragraph during a compromise types `bananasaurs account
disable eve --confirm` on the real daemon and is refused, citing a flag the
line they just read says does not apply — and the existing rule four lines
further down ("Guild-scoped, like every other data path") now contradicts
it. Smallest fix: say what is true — these commands act instance-wide but
the socket still requires a guild on a multi-guild instance, so pass
`--guild <id>`; it selects nothing but the audit trail the row lands in.
(The deeper shape — an instance-level write recorded in one arbitrarily
chosen guild's `audit_events` — is pre-existing with `bootstrap reissue`;
see the Minor below.)

**[Important] `packages/core/src/ops/commands/account.ts:229-233` — `account
delete`'s ownerless warning sends the operator to a command that refuses.**
The warning fires at `enabledOwnersRemaining === 0` and says "Run
`bananasaurs bootstrap reissue --confirm` to re-arm the setup page."
`reissueBootstrapToken` refuses while **any** account row exists
(`apps/daemon/src/ops/wiring.ts:966`, `accountRepo.countAccounts > 0`), not
while any enabled owner exists. Executed: seeded an owner and a non-owner
member, deleted the owner through the real `accountOpsFor` —
`enabledOwnersRemaining: 0`, and `countAccounts` still `1`. The operator, in
the one emergency this warning exists for, follows the instruction and gets
a throw. Ruling R2 rests on this path working; it works only when the
deleted account was the *last row*, which is not what the warning tests for.
Smallest fix: have `accountDelete` return `accountsRemaining` alongside
`enabledOwnersRemaining` and branch the second line — `bootstrap reissue`
when zero remain, otherwise "N account row(s) remain; `bootstrap reissue`
will refuse until they are deleted too."

**[Important] `packages/core/src/ops/commands/account.ts:125-130` and
`:229-233` — the warning fires on accounts that were never owners, and then
names the wrong account in the remedy.** `enabledOwnersRemaining === 0` is a
fact about the instance, not about the account just acted on; nothing
consults `outcome.isOwner` / `outcome.wasOwner`. Executed: with the sole
owner already disabled, `account disable member --confirm` printed
`WARNING: that was the last enabled owner account. Nobody can sign in to the
dashboard. Re-enable it with `bananasaurs account enable member --confirm`.`
— `member` is not an owner, and re-enabling it restores no dashboard
sign-in. During a lockout the command is pointing at the wrong row.
Smallest fix: gate the warning on `wasOwner`/`isOwner && changed`, or
reword it to describe the instance ("no enabled owner account remains") and
drop the account-specific remedy.

**[Important] `packages/core/src/ops/commands/account.ts:89` and
`docs/17_OPERATOR_ACCESS.md:54-57` — `disable` is documented as the
compromise lever, but `enable` hands every compromised credential back, and
this slice ships nothing that would let the operator rotate first.**
Disabling revokes nothing: `setAccountDisabled` writes one column, and both
guards that make it bite (`authenticate` at `packages/http/src/auth.ts:101`,
`verifyAccessToken` at `packages/http/src/oauth/provider.ts:495`) are live
re-reads. So the sequence disable → fix → enable restores the stolen session
cookie and the stolen refresh chain exactly as they were — the branch's own
tests assert it twice ("enabling the account restores the same token",
"enabling restores the refresh", `bearer.test.ts:389` and `:405`), as a
feature. The operator has no remedy short of `account delete`:
`sessionRepo.revokeAllForAccount` exists (`sessions.ts:117`) and has **no
production caller** anywhere, and `accountRepo.setPasswordHash`
(`accounts.ts:183`) likewise has **no production caller** — there is no
password-change route, no `account revoke-sessions`, nothing. Concretely: an
account is compromised, the operator runs `account disable` and is told
"every dashboard session and every OAuth token this account approved stops
verifying on the next request", investigates, runs `account enable`, and the
attacker's thirty-day refresh chain mints again. Smallest fix that is
honest without new scope: say so — in `docs/17` ("`enable` restores the
sessions and tokens the disable suspended; for a compromise, use `account
delete`") and in the `disable` command's own second line ("...while it stays
disabled"). The real fix, if it fits M3b, is one more command over the
`revokeAllForAccount` that is already written and tested.

**[Minor] `packages/core/src/ops/dispatch.ts:335` — an instance-level
account write is audited into whichever guild's trail the operator's
`--guild` happened to name.** `auditWriteFor` goes to
`guild.context.ports.recordAudit`, and `audit_events.guild_id` is `NOT
NULL`. `account.deleted` for an account that had access to both guilds is
therefore recorded in one of them, chosen by a flag the operator was told
was irrelevant. Pre-existing with `bootstrap reissue` and
`dashboard.bootstrap_reissued`, but this slice puts the most
security-significant instance-level write in the tree through it. Worth a
sentence in `docs/17` at minimum, and a ruling on whether instance-level
audit rows need a home of their own before M4 adds more of them.

**[Minor] `apps/daemon/src/ops/ops.integration.test.ts` — the four new
commands never run end to end.** `grep "'account"` finds nothing there; the
file is the one place the real socket, the real dispatcher and a real
migrated database meet. Coverage today is `account.test.ts` (commands
against hand-written stubs) plus `wiring.test.ts` (`accountOpsFor` against a
real database), with only the `OpsInstance` type joining them — which is
exactly the seam that produced the `--guild` surprise above, and a seam a
compile check cannot see. One `account disable` dispatch in the integration
file, asserting the audit row as well as the text, would have caught it.

**[Minor] `apps/daemon/src/ops/wiring.ts:871-875` and `:892-894` — the R5
"race" branches are unreachable.** `accountSetDisabled` and `accountDelete`
are synchronous functions over better-sqlite3, which is synchronous, in a
single-writer process (ADR 0008) that the operator CLI never opens the
database behind (ADR 0013). Nothing can write between the
`findAccountByUsername` and the `setAccountDisabled` that follows it, so
`result.changes === 0` cannot happen. Harmless and cheap, but the comments
assert a hazard the concurrency model has already excluded, and a later
reader may take them as evidence that interleaving is possible here. Either
say "defensive; unreachable under the single-writer model" or drop the
branches.

**[Minor] `packages/core/src/ops/commands/account.ts:33-40` — the username
schema admits a leading `-`, which the CLI parser reads as a flag.** The
regex is `^[a-z0-9._-]+$`, so `-bob` is a valid username; `parseArgv`'s
`isFlag` (`packages/cli/src/args.ts:45`) treats any `-`-leading token as a
flag, so `bananasaurs account delete -bob --confirm` fails with "`account
delete` has no flag `-bob`" rather than reaching the daemon. Pre-existing —
the schema was lifted from `account grant`, not written here — and
unreachable through the bootstrap form if its own rules agree, but this
slice is the first to make an unreachable account name a *deletion* problem.
Smallest fix: `.regex(/^[a-z0-9][a-z0-9._-]*$/)`.

---

### What I checked and found sound

- **`deleteAccount` leaves nothing it should not, and keeps what it must.**
  The only foreign keys into `dashboard_accounts` are
  `account_guild_access` and `dashboard_sessions`, both `ON DELETE CASCADE`
  (`schema.ts:1424`, `:1496`), and `account_capabilities` cascades behind
  `account_guild_access` through its composite key (`:1463`). `PRAGMA
  foreign_keys = ON` is set on every connection (`db.ts:96`, `:164`) and in
  `test-support.ts:39`, so the cascades are real and not decorative.
  `audit_events` holds an account id in `actor_id` with **no** foreign key
  (`:515`) and survives — correct. `oauth_clients.created_by_account_id`
  also survives as provenance, which is right; `listClients` joins nothing,
  so no read breaks on the dangling id.
- **`oauth_pending_authorizations` is handled, by not needing to be.** It
  carries no account id, and a pending form is redeemed at
  `routes/oauth.ts:258` through `verifyAccountCredentials`, which refuses a
  deleted account (`findAccountByUsername` → undefined) and a disabled one
  (`auth.ts:175`) before anything is minted.
- **Disabling really does end a dashboard session.** `authenticate`
  re-reads the account row and checks `disabled` on every request
  (`auth.ts:100-101`) — it does not trust the session row. The `docs/17`
  line and the command's own text are true for as long as the account
  stays disabled; see the Important above for the reversal.
- **`writeInstance` is a real transaction** (`write.ts:104`,
  `db.transaction`), so `deleteAccount`'s revoke-codes-delete really is
  atomic, and `NotPromise<T>` makes an async callback uncompilable — the
  documented reason the cross-table writes live in `accounts.ts` rather
  than `oauth.ts` holds up.
- **`enabledOwnersRemaining` is read outside the transaction and it does
  not matter.** Single-writer, synchronous better-sqlite3, no `await` in
  either port method — the read cannot observe another writer.
- **No secret crosses the operator port.** `OpsAccount` names six fields and
  no hash; `accountOpsFor` and `testInstanceFor` both map field by field
  rather than spreading, and `wiring.test.ts` pins it with a sentinel hash
  and a `JSON.stringify` assertion. `--json` output is built from the same
  shape.
- **The six bearer tests prove what they claim.** None advances the clock
  between the 200 and the 401 (`clock` is untouched across each pair), test
  4 reuses the *same* `accessToken` after re-enabling rather than minting a
  fresh one, and test 6's raw-SQL deletion is the only way to reach the
  `account-gone` branch, exactly as R7 says — `deleteAccount` revokes in
  the same transaction and `verifyAccessToken` refuses as `revoked` first
  (`provider.ts:490` precedes `:494`). I re-ran the four focused suites:
  105 tests, all green.
- **The observe window is untouched.** `git diff --name-only 417c62c..HEAD`
  is 15 files; no `mod_rules`, no `setRuleMode`, no effect gateway, no
  moderation source file at all. The two automod files in the list are
  tests, each taking three stub lines in a hand-rolled `OpsInstance`
  literal (R6).
- **R1, R3, R4 are sound as ruled.** `account list` is the only way to see
  a disable took effect and is `write: false` (no `--confirm`, no audit
  row, correctly). `accountOpsFor` is exported and spread at
  `wiring.ts:1046`. `testInstanceFor`'s duplicate is byte-for-byte the same
  mapping; I diffed them by eye and they do not diverge.
- **The `--confirm` gate holds.** Executed: `account delete` without
  `confirm` returned `{"ok":false,"code":"needs-confirm"}` before the
  instance was touched.
