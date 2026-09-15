# Slice M3c whole-branch review — Opus, 2026-09-15

Reviewer: Claude Opus 5 via the Agent tool (brief:
`.oc-runs/m3c-revoke-credentials/final-review-brief.md`; diff:
`.oc-runs/m3c-revoke-credentials/branch.diff`, base `941acdf`, head
`22fbfc6`, 5 commits, 472 insertions over 15 files). This branch had **no
task-level review** — the implementing model was rate-limited — so this is
its only one. Read outside the diff throughout: `packages/http/src/auth.ts`,
`packages/http/src/oauth/provider.ts`, `packages/http/src/server.ts`,
`packages/storage/src/repos/sessions.ts`,
`packages/storage/src/repos/accounts.ts`,
`apps/daemon/src/runtime/daemon.ts`, `packages/core/src/ops/dispatch.ts`,
ADR 0045 Amendment 3, `docs/STATE.md`, and the deployed `.env`. Three Node
probes against a migrated SQLite database driving the real `accountOpsFor`,
the real `exchangeCode` and the real `createDispatcher` over the real
`OPERATOR_COMMANDS`, plus all three gates re-run in the worktree.

**Gates, re-run by me, not taken on report:** `npm run typecheck` exit 0,
`npm run lint` exit 0, `npm run test` exit 0 — **157 files / 3,013 tests**,
matching the controller's numbers exactly. `git diff --name-only main..HEAD`
touches no `mod_rules`, no `setRuleMode`, no `packages/core/src/mod/`, no
`packages/core/src/automod/`, no `effects/gateway.ts`: the observe-window
constraint holds. No Discord side effect is touched, so the idempotency-key
rule is not at issue — confirmed by reading the whole diff, which reaches no
effect gateway and enqueues no job. `disable` and `enable` are unchanged and
the two `bearer.test.ts` tests that prove a re-enabled token verifies again
pass untouched; the diff only adds fifteen lines to that file. No password
hash, session id or token value appears in any output, `data` payload or
audit row — I drove the real command through the real dispatcher and read
the emitted audit row, which carries the username and three counts and
nothing else.

**No Critical.** The command does what its headline says: I watched a live
session and a live token die and the account stay enabled. The two Importants
below are both *incompleteness* of the sweep rather than a broken mechanism,
and I would rather say that plainly than promote one to fill the slot this
project's history predicts. But both are the kind of gap that reads as a lie
to an operator staring at `mcp tokens` during an incident, and both are a few
lines to close.

On the rulings the brief flagged contestable: **M3c-R1** holds. **M3c-R2**
holds *for tokens* — `oauth_tokens.account_id` is `NOT NULL`, every mint path
(`exchangeCode`, `rotateRefreshToken`) copies the approver's account id, and
there is an `oauth_tokens_by_account` index, so no token an account owns
escapes the predicate — but the reasoning was applied to a class it does not
cover; see the second finding. **M3c-R3**'s sweep is complete for every guild
in the allowlist and no more; see the third. **M3c-R4** is right and the
single-writer model makes the ordering question moot: `better-sqlite3` is
synchronous and the daemon is one process, so nothing can interleave between
the session sweep and the token sweep. Sessions cannot mint tokens (consent
takes the password, never the cookie — `oauth/consent.ts:4`,
`routes/oauth.ts:111`) and tokens cannot mint sessions, so the order carries
no risk of its own.

---

Verdict: **SHIP-WITH-FIXES**

### Findings

**[Important] `apps/daemon/src/ops/wiring.ts:933` (over
`packages/storage/src/repos/sessions.ts:117`) — the session half of the sweep
has no `revoked_at IS NULL` guard, so it re-revokes dead sessions, overwrites
their revocation timestamp, and reports them as a fresh kill.**
`revokeAllTokensForAccount` was written with `isNull(oauthTokens.revokedAt)`
and the controller probed that line specifically; `sessionRepo.revokeAllForAccount`
sets `revokedAt` on *every* row matching `(guild, account)` — already revoked,
already expired, all of it — and returns `changes`. Executed, through the real
`accountOpsFor` over a migrated database: a session revoked at `t=2000` (an
ordinary logout an hour earlier), then `accountRevokeCredentials` at `t=9000`
reported `sessionsRevoked: 1` and rewrote `revoked_at` from `2000` to `9000`;
running it a second time at `t=12000` reported `sessionsRevoked: 1` again and
rewrote it to `12000`. Concretely: the operator re-runs the command during an
incident — which is the normal thing to do when you are not sure the first one
landed — and is told a session was just killed when nothing was live, and the
one timestamp that would have said *when* the attacker's session actually
ended is now the time of the operator's own second command. The plan's own
test 1 demands exactly this property ("leaves an already-revoked token's
`revokedAt` unchanged") and got it for tokens; the session half never had it
and no test covers it. Smallest fix: add
`isNull(dashboardSessions.revokedAt)` inside the existing `scope.only(...)`
in `revokeAllForAccount`, and a test that revokes one session first and
asserts the sweep returns the live count and leaves the earlier timestamp
alone. (A filter on `expiresAt` is optional — an expired session is already
inert — but without it the count also includes every expired-but-unrevoked
row in the retention window, which inflates the number the operator reads.)

**[Important] `apps/daemon/src/ops/wiring.ts:921-951` — an unexchanged OAuth
authorization code survives the revoke and mints a brand-new thirty-day
refresh chain seconds later.** `deleteAccount` deletes
`oauth_authorization_codes` by account id in the same transaction as the
token revoke (`packages/storage/src/repos/accounts.ts:264`); this command
deletes none. `exchangeCode` gates only on the code's own expiry and on
`approver.disabled` (`packages/http/src/oauth/provider.ts:281-294`) — and
`disabled` is precisely the column this slice is designed *not* to touch.
Executed, driving the real `exchangeCode`: seeded a live code, ran the real
`accountRevokeCredentials` (which reported `tokensRevoked: 0`, truthfully —
there were none yet), then exchanged the code one second later and got
`ok: true` with a fresh access **and** refresh token; the account ended the
sequence holding **two live tokens** immediately after the command that
claims to have ended every one of them. The window is up to five minutes
(`AUTHORIZATION_CODE_TTL_MS = 300_000`). The provider's own comment three
lines above that check already makes the argument for the fix — a code
approved before the account was stopped must not mint, because "`mcp tokens`
would report them live — the one column an operator triaging a compromise
reads" — and that reasoning is about revocation, not about the `disabled`
column it happens to be attached to. This is also where ruling M3c-R2's
superset argument stops: `account_id` is a superset of every token *lineage*,
but a code is a third credential class the account owns and the predicate
never sees it. Smallest fix: a `deleteAuthorizationCodesForAccount` in
`oauth.ts` mirroring the statement `deleteAccount` already runs inline, called
in the same sweep, with `codesDeleted` reported in the result and the audit
row exactly as `accountDelete` reports it.

**[Important] `docs/17_OPERATOR_ACCESS.md:79` — the paragraph that tells the
operator `--guild` is required still governs "the four `account` commands",
and there are now five.** The list four lines above gained
`revoke-credentials`; the paragraph did not. Two readings both go wrong. An
operator who takes the count literally concludes the new command is outside
that set and so is *not* instance-wide — i.e. that it revokes only in the
guild named, and that a session in guild B survives — which is false and
would have them run it twice or distrust the result. An operator who
concludes instead that the `--guild` rule does not apply to it types
`bananasaurs account revoke-credentials alice --confirm` on the real daemon
and is refused. Executed, against the real `OPERATOR_COMMANDS` through the
real `createDispatcher` with two guild ids (the deployed
`BANANASAURS_GUILD_ALLOWLIST` holds two): with no guild,
`{"ok":false,"code":"unknown-guild","message":"this instance serves 2 guilds,
so the command must say which: pass --guild <id>"}`; with a guild id, the
command runs and audits. This is the M3b finding replayed for the command
that was added after it was fixed. Smallest fix: "four" → "five", and add
`revoke-credentials` to the sentence that enumerates what the flag does not
change ("still revokes everywhere, including guild B").

**[Minor] `apps/daemon/src/runtime/daemon.ts:157` — `guildScopes` is the
allowlist, so a session in a guild dropped from the allowlist is not swept
and still authenticates.** `byGuild` is built from
`BANANASAURS_GUILD_ALLOWLIST` and nothing else, and `authenticate` takes the
guild from the session *row*, not from the allowlist
(`packages/http/src/auth.ts:104`), so a session created while guild B was
allowlisted keeps verifying for its full twelve hours after B is removed.
`revoke-credentials` will not touch it, and the "across N guild(s)" line will
not mention it. The blast radius is small and mostly fails closed: every data
route reaches `portsFor`, which throws for a guild with no runtime, so those
are 500s — but `GET /api/session` does not, and answers `authenticated: true`
with the account id and a usable CSRF token. Worth a sentence in the port's
doc comment saying the sweep is over the allowlist, so the next reader does
not assume it is over `dashboard_sessions`; a real fix would sweep the
distinct `guild_id`s present in the table instead, which is the only
definition of "every guild" that cannot drift.

**[Minor] `packages/storage/src/repos/oauth.ts:527` — the shipped doc comment
cites "ADR 0045 Amendment 3 A3-5", which does not exist.** The plan's header
says Amendment 3 "gains a fifth decision, A3-5", but no task ever assigns
writing it and the ADR still ends at A3-4 — `grep -rn "A3-5" docs/` matches
only the plan. The commit list is `Step 2, 3, 4, 6, 7`: **Step 5 is missing**,
which is consistent with the interrupted run and is the likeliest place the
amendment was meant to land. On a project where these citations are how a
decision is found two slices later, a dangling one is a decision that was
never recorded (CLAUDE.md working style, first bullet). Smallest fix: write
A3-5 into ADR 0045 — it is two paragraphs, M3c-R1 and M3c-R2, both already
drafted in the plan — or change the comment to cite the plan's ruling
numbers.

**[Minor] `docs/STATE.md:81-95` — the M3b open question this slice answers is
still recorded as open, and one of its factual claims is now false.** It says
`sessionRepo.revokeAllForAccount` and `accountRepo.setPasswordHash` "both
exist, are tested, and have **zero production callers**"; the first now has
one. It also asks whether to ship `account revoke-sessions`, which shipped
under a different name in this branch. Normally the controller's merge step,
but it is the file the next session reads first, so it belongs on the merge
checklist rather than being discovered later.

### What I checked and found correct

- **The command really ends a live dashboard session.** `authenticate` reads
  the row, then `revokedAt`, then `expiresAt`, then the account, on every
  request (`packages/http/src/auth.ts:93-107`) — nothing is cached, so the
  output text is true for sessions the sweep reaches.
- **`stillEnabled` is read correctly.** `findAccountById` after both writes,
  with an explicit `undefined` branch; both text branches are covered by
  tests and the disabled branch's wording ("these credentials will not work
  if it is re-enabled") is accurate.
- **The audit row.** `account.credentials.revoked`, subject the username,
  `after` the three counts. No session id, no token id, no hash. `before: {}`
  is honest here: the pre-write state of a rotation is not a fact the command
  knows before it acts, and the counts *are* the change. The one thing it
  does not record is whether the account was left enabled — `stillEnabled` is
  in `data` but not in `after` — which is worth a line if A3-5 gets written,
  not a finding on its own.
- **Guild scope.** The session revoke goes through `scope.only(...)` per
  guild; `dashboard_accounts` and `oauth_tokens` stay on `InstanceScope`. The
  `OpsInstanceDeps.guildScopes` type makes the distinction visible at the
  boundary rather than leaving it to caller discipline.
- **`revokeAllTokensForAccount` itself** is correct, indexed, and its
  `isNull` guard is load-bearing — the controller's probe stands, and the
  covering test fails as reported without it.
