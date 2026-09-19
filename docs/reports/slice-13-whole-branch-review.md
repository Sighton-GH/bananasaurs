# Slice 13 — whole-branch review

**Branch:** `oc/slice-13-operator-gaps` (13 commits, `main`..`HEAD`, fork point `d746b5f`)
**Worktree:** `/home/bryan/projects/bananasaurs/.oc-worktrees/oc/slice-13-operator-gaps`
**Reviewed:** 2026-09-19 · reviewer changed no files; probe suites were written, run, and deleted
(`git status --porcelain` empty at the end).

## Verdict: SHIP-WITH-FIXES

I went looking specifically for the two things named as highest value — a way to reach a
guild's data the account should not reach, and a login response that distinguishes a valid
username from an invalid one. **I found neither.** Both were driven, not reasoned about:
27 HTTP-level probes against the real Fastify app and the migrated database, plus 2 against
the real daemon wiring. Every refusal path holds and every refusal leaves the session row
physically unchanged.

What stops this being a clean SHIP is not the security surface. It is that **Task 1's
documentation and comments ship the diagnosis Task 2 retracted**, and that the new
partition-move primitive enforces guild scope in the caller rather than in the repository,
which CLAUDE.md rule 2 names as a bug "even if every current caller passes it".

## Gates (run in the worktree, one at a time)

| Gate | Exit | Result |
|---|---|---|
| `npm run typecheck` | **0** | `tsc --build --force && tsc -p tsconfig.all.json`, clean |
| `npm run lint` | **0** | `eslint . && prettier --check .`, "All matched files use Prettier code style!" |
| `npm run test` | **0** | **175 test files, 3,413 tests, all passed** (53.91s) |

Matches the counts the brief stated. Nothing was built in the main checkout.

## Constraint check

`git diff --name-only main...HEAD` over the forbidden paths returns **empty**:
`packages/core/src/mod/`, `packages/core/src/automod/`, `packages/core/src/effects/gateway.ts`,
`packages/storage/src/schema.ts`, `drizzle/`.

**No migration.** `drizzle/` untouched; `dashboard_sessions.guild_id` already existed.

The only edits inside automod-adjacent files are the two literal-only ones the briefs
authorised — one `accountSetPassword` stub line in `apps/daemon/src/automod.integration.test.ts`
and three stub lines in `packages/storage/src/repos/automod-rule-lists.test.ts`. Both are
`OpsPorts`/`OpsInstance` exhaustiveness fillers; neither touches automod behaviour.

27 files changed, +2,173 / −66.

---

# Findings

## Critical — none

## Important

### I1. `docs/17` ships the false diagnosis the slice exists to retract

`docs/17_OPERATOR_ACCESS.md`, new paragraph under "Reaching the dashboard":

> A fresh account reaches only the **first** guild in `BANANASAURS_GUILD_ALLOWLIST` — that is
> all `bootstrap` grants, and nothing else granted the rest until slice 13. On this instance
> that meant the owner's account reached the dev guild while the club guild sat unreachable by
> anybody, which is how the Release 2 gate's own guild went unopened for months.

This is false, and the code that falsifies it is on the same branch.
`packages/http/src/auth.ts:509-517`:

```ts
  // Access to every guild this instance serves, then every capability in each.
  for (const id of deps.guildIds) {
    const scope = deps.scopes.forGuild(parseGuildId(id));
    accountRepo.grantGuildAccess(scope, accountId);
    accountRepo.grantAllCapabilities(scope, { accountId, capabilities: CAPABILITIES, ... });
  }
```

Bootstrap grants **every** allowlisted guild, and has since it was written. This is exactly
the claim the plan's section "1. CORRECTED" exists to withdraw ("I read the `grantGuildAccess`
call on line 455 without its enclosing loop and inverted the finding"), and exactly what
ADR 0045 Amendment 6 (A6-4, on `main`) already records correctly. Task 1's brief was written
against the wrong diagnosis, Task 1 implemented it faithfully, and Task 2's correction never
went back to Task 1's prose.

The same retracted claim appears twice more in code comments:

- `packages/core/src/ops/commands/account.ts`, `accountGrantGuildCommand` doc comment:
  *"The guild-access lever `bootstrap` never grew: a fresh account reaches only
  `deps.guildIds[0]`, and until this command nothing could grant it the others."*
- `packages/core/src/ops/ports.ts`, `accountGrantGuild` — reads correctly on the `--guild`
  rule but inherits the same framing.

**Why this is Important and not Minor.** This is the operator manual. It sends the next
person hunting a bug that does not exist, and it contradicts the ADR of record in the same
repository. It also misstates history in a way that is on the record ("which is how the
Release 2 gate's own guild went unopened for months" — the guild was reachable the whole time;
what was broken was *logging in*, because the form posted no `guildId`).

**Fix.** Replace the paragraph with the corrected justification the plan already wrote
(plan lines 44–50): `grant-guild`/`revoke-guild` cannot make a guild reachable that bootstrap
did not already grant; what they are for is **restricting** an account to fewer guilds and
restoring access afterwards. Fix the two comments to match. Doc-and-comment only — no code
change, no test change.

### I2. `setSessionGuild` is an unguarded partition-move primitive; the only access check lives in the route

Driven (probe, passing):

```ts
const moved = sessionRepo.setSessionGuild(t.scopes.forGuild(GUILD_A), {
  sessionIdHash: hash,
  guildId: GUILD_C,          // the account has NO access row for GUILD_C
  now: clock,
});
expect(moved).toBe(true);    // ← passes
expect(rowGuild(cookie)).toBe(GUILD_C);
```

The repository function will move any live session into any guild. The `hasGuildAccess` check
that makes this safe exists only in `packages/http/src/server.ts:410-416`. CLAUDE.md rule 2:
*"Enforce it in repository function signatures and database constraints, not in caller
discipline. A query that can omit guild scope is a bug even if every current caller passes it."*
This is the mirror image — the target partition is caller-supplied and unvalidated.

Mitigating, and I drove it: `authenticate` (`auth.ts:105-108`) re-checks `hasGuildAccess` on
the row's guild on **every** request, so the illegally moved session immediately answers
`{ authenticated: false, reason: 'access-revoked' }`. **This is not exploitable today.** It is
a boundary that depends on a backstop in a different package, on a function whose whole
purpose is to violate the partition invariant, with a doc comment that says nothing about it.

Worse, the module header of `packages/storage/src/repos/sessions.ts:9-10` still asserts the
invariant this slice repealed:

> Guild-scoped rows (ADR 0012: **a session is for one guild, so a stolen cookie cannot be
> pointed at another**)

A stolen cookie *can* now be pointed at another guild — every guild the account reaches. That
is the deliberate, correct consequence of S13-D7, but the file that states the opposite is the
file that implements it.

**Fix (pick one).** Either take `accountId` on `setSessionGuild` and assert
`hasGuildAccess(targetScope, accountId)` inside the write, or — at minimum — state the contract
loudly in the doc comment ("this function does not check the target; `POST /api/session/guild`
is the one caller and holds the check") and amend the module header to say the invariant is now
"one guild the account can reach, checked on every request".

## Minor

### M1. S13-D5 row 3 does not name the expiry the ruling requires

The ruling table: *"0 accounts, live bootstrap token | names the expiry: setup is pending, not
broken | yes"*. The rendered line (`packages/core/src/ops/commands/reads.ts:207-211`) names the
**count**, not the expiry: `"…but N bootstrap token(s) still live — complete setup before it
expires"`. Documented in a comment as an out-of-scope repository gap
(`countUnconsumedBootstrapTokens` returns only a count). Correct call, but it is a silent
ruling deviation rather than an escalation, which the brief asked for.

### M2. Two things named `doctor` now disagree, and docs/17 does not say which it means

`readDashboardAccess` is computed at exactly one `buildDoctorReport` call site
(`apps/daemon/src/ops/wiring.ts:1164`, the operator socket). The other two —
`apps/daemon/src/index.ts:185` (`npm run doctor`) and `apps/daemon/src/runtime/daemon.ts:623`
(startup) — pass nothing, so both new findings are silently absent and vote nothing on `ok`.
That is deliberate and documented (`runDoctor` "**does not open the database**, so it can be
run against a guild while the daemon is running"), and the fail-open-on-absence design is
right. But `docs/17`'s new paragraph says "check with `doctor`, which now fails loudly on any
allowlisted guild no enabled account can reach" without saying that `npm run doctor` is not
that `doctor`. One clause fixes it.

### M3. `switchGuild` calls `onLoggedOut()` to mean "refresh"

`packages/dashboard/src/app/session.tsx:170`. It is correct — `App.tsx:53` passes `check`,
which re-reads `/api/session` — but a future reader will assume the switch logs you out, and a
future `onLoggedOut` that actually clears state will break the switcher silently. Rename the
prop (e.g. `onSessionChanged`) or add the one-line note at the call site.

### M4. Switcher snaps back between POST and refetch

`Shell.tsx`'s `<select value={session.info.guildId}>` is controlled by the *old* session until
`check()` resolves, so the dropdown visibly reverts for one round trip. Cosmetic.

### M5. The route's own comment contradicts S13-D8's wording

Task 2's brief: *"S13-D8 — the switch is `requireFresh`-free but **capability-checked**."*
`server.ts:384-385` says: *"`requireFresh`-free but capability-**free** too, deliberately."*
The implementation has no capability check — only `hasGuildAccess` — and I think the
implementation is right (no capability in `CAPABILITIES` fits "look at another guild", and
`hasGuildAccess` is the correct gate). But the ruling and the code disagree in writing, and
nobody escalated it.

### M6. The plan of record carries only S13-D1..D5

`docs/superpowers/plans/2026-09-19-slice-13-operator-gaps.md` on `main` contains D1–D5.
S13-D6..D9 exist only in `.oc-runs/slice-13-operator-gaps/task-2-brief.md`. The branch's copy
of the plan is the pre-correction draft (the branch never touched `docs/superpowers/`, so
merging is harmless). Fold D6–D9 into the plan before archiving it.

### M7. Non-resource page state survives a switch

Every `useResource` loader is `useCallback(..., [session])`, so all of them refetch when the
session object is replaced (verified across `audit`, `cases`, `automod-rules`, `automod-rule`,
`cutover`, `member`, `case`, `panels`, `logging`, `review`, and `health`). Local draft state in
a component with no resource to invalidate — most plausibly the new-automod-rule form — does
survive, and a subsequent save would land in the newly selected guild. That is arguably the
right behaviour (you write where the switcher says you are), and no page can show one guild's
data under another guild's name. Noted as residue, not a defect.

---

# Evidence — what I actually ran

All probes were written into the worktree, run under `vitest`, and deleted. The tree is clean.

## Attack 1 — does the login refusal leak anything to someone who cannot log in?

Six HTTP-level probes through `app.inject` against the real server, real database, real argon2:

| State | Status | Body | Keys |
|---|---|---|---|
| wrong password | 401 | `{"error":"invalid-credentials"}` | `['error']` |
| unknown username | 401 | `{"error":"invalid-credentials"}` | `['error']` |
| locked out (after `maxFailedAttempts+1`) | 429 | `{"error":"locked-out"}` | `['error']` |
| disabled account, **correct** password | 401 | `{"error":"invalid-credentials"}` | `['error']` |
| zero guild access, **correct** password | 401 | `{"error":"no-guild-access"}` | `['error']` |
| two reachable guilds, correct password | 401 | `{"error":"guild-required","choices":[…2…]}` | — |

`Object.keys()` asserted exactly `['error']` on all five refusals: **no `choices` key, not even
an empty one.** Shape and status are identical to `main` — the only delta in the login route is
the `if (result.reason === 'guild-required')` early branch (`server.ts:342-347`), which is
unreachable unless `verifyAccountCredentials` returned `ok: true`. I read
`verifyAccountCredentials` line by line: dummy-hash on unknown username, lockout-without-verify,
disabled-as-invalid, all untouched by this branch.

Note that `no-guild-access` *is* distinguishable from `invalid-credentials` — but that is
`main`'s behaviour, unchanged, and it requires already knowing the correct password, so it is
not a username oracle.

**Timing**, 20 paired runs, medians: wrong password **16.38 ms**, guild-required **16.86 ms**.
A 0.5 ms delta against a ~16 ms argon2 floor, and structurally it cannot be an oracle: every
new query (`listAccessibleGuilds` + one `findGuild` per reachable guild) runs strictly after
`verifyPassword` returned true.

## Attack 2 — can the switcher move a session into a guild the account cannot reach?

Twelve probes. In **every** refusal I asserted the database row via `findSessionByHash`, not the
response.

| Attack | Status | Row after |
|---|---|---|
| served guild with no access row (`GUILD_C`) | 403 `no-guild-access` | unchanged (`GUILD_A`) |
| valid snowflake not in the allowlist | 403 `no-guild-access` | unchanged |
| malformed id (`not-a-snowflake`) | 403 `no-guild-access` | unchanged |
| empty string | 400 `bad-request` | unchanged |
| number `123` / array / 200-char string | 400 `bad-request` | unchanged |
| `"111111111111111111' OR '1'='1"` | 403 `no-guild-access` | unchanged |
| **revoked** session | 401 | unchanged |
| **expired** session | 401 | unchanged |
| account **disabled** mid-flight | 401 | unchanged |
| target access **revoked** mid-session | 403 | unchanged |
| another account's CSRF token on my cookie | 403 `csrf` | unchanged |
| `Origin: https://evil.example` with the right CSRF | 403 | unchanged |
| no session at all | 401 | — |
| no CSRF header | 403 `csrf` | unchanged |

Malformed and unreachable are refused identically — 403 `{"error":"no-guild-access"}` — so the
schema is deliberately permissive (`z.string().min(1).max(64)`) rather than snowflake-shaped,
and the comment in `policy.ts:75-81` says exactly why. That is the right call: a 400 on a
malformed id would have been the oracle.

A session is addressed only by its cookie, so "another account's session id" reduces to
"another account's cookie", which authenticates as that account — not an attack. The nearest
real variant (their CSRF, my cookie) is refused.

## Attack 3 — the partition move

- `setSessionGuild(scope(GUILD_B), …)` against a row living in `GUILD_A` → **`false`**, row
  unchanged. `scope.only(...)` governs the write's `WHERE`; a request scoped to another guild
  cannot move it.
- A revoked row → **`false`**, unchanged. (`isNull(revokedAt)` in the `WHERE`.)
- After a legitimate move A→B: `revokeAllForAccount(scope(A))` returns **0**,
  `revokeAllForAccount(scope(B))` returns **1**. The row follows its partition; `revoke-credentials`
  and `set-password` sweep every `guildScopes` entry, so neither loses a switched session.
- Audit row, read raw from `audit_events`:
  `{"guild_id":"222222222222222222","action":"session.guild_switched","before":"{\"guildId\":\"111111111111111111\"}","after":"{\"guildId\":\"222222222222222222\"}"}`
  — one row, in the **new** guild, naming both ends. Switching A→A writes none.
- Grepped every reader of `dashboard_sessions` and `session.guildId`
  (`sessions.ts`, `server.ts`, `auth.ts`, `routes/*.ts`, `wiring.ts`, `daemon.ts`). Nothing
  caches a scope: `authenticate` rebuilds `session.scope` from the row on **every** request, and
  every route handler takes `deps.portsFor(session.scope)`. There is no server-side state that
  assumes a session's guild never changes.
- The one unguarded reader is the repository function itself — see **I2**.

## Attack 4 — does switching re-scope the whole dashboard, or just the header?

The data. Chain verified end to end:

`switchGuild` → `check()` (`App.tsx:28`) → `getSession()` → `setPhase({kind:'authed', session})`
with a **new** `SessionInfo` object → `SessionInner`'s `useMemo([session, …])` produces a new
`Session` → every page's `load = useCallback(…, [session])` changes identity →
`useResource`'s `useEffect([generation, load, …])` refires and sets `{state:'loading'}` first.

I checked every `useResource` call site individually: `audit`, `cases`, `case`, `member`,
`panels`, `logging`, `automod-rules`, `automod-rule`, `cutover`, `review`, and `health` — all
depend on `session`. No page holds guild-derived data past the switch. The dashboard caches no
capability set client-side (`grep -rn "capabilit" packages/dashboard/src` → nothing), so there
is no stale permission UI either. Server-side re-scoping was driven directly: after the switch,
`GET /api/session` reports `GUILD_B`, and the same CSRF token still works (the cookie and its
derivation survive, as S13-D7 intends).

Residue is M7 only.

## Attack 5 — `set-password` secret containment

Driven against the **real** `accountOpsFor` wiring and a migrated database, then the whole
database dumped table by table (`SELECT name FROM sqlite_master WHERE type='table'`, every row
of every table serialised to one blob) and searched:

```
expect(result.password).toHaveLength(43);   // base64url of 32 bytes
expect(blob).not.toContain(result.password); // ← passes
```

The generated plaintext appears in **no** table: not `dashboard_accounts` (which holds an argon2
hash the plaintext verifies against, asserted separately in `wiring.test.ts`), not `audit_events`,
not anywhere. The session sweep ran (`sessionsRevoked: 1`, `revokedAt` stamped).

Command side (`account.test.ts`, theirs): the plaintext is in `text`;
`JSON.stringify(response.data)` and `JSON.stringify(audit)` are both asserted **not** to contain
it. There is also a test that a smuggled `--password hunter2` argument is ignored and never
echoed. I checked the log path independently: `apps/daemon/src/ops/socket.ts` logs only
`component`/`err`/`reason` through `safeLogFields` and never the response body, so `text` reaches
the operator's terminal and nothing else. Rule 4 holds.

`generateToken()` yields 43 characters, comfortably over `passwordSchema`'s 12-character floor
and under its 1024 ceiling, so the generated password is usable at the login form.

## Attack 6 — `grant-guild` / `revoke-guild`

- Grant in A leaves B unreached; re-grant answers `already-had-it` with no duplicate row
  (their `wiring.test.ts`, re-verified).
- Capability cascade driven directly against the database: after
  `revokeGuildAccess(scope(A))`, `account_capabilities` holds **0** rows for guild A and **10**
  for guild B. ADR 0028's cascade works and does not leak across the partition.
- `--confirm` gating, `no-such-account` throwing with no audit row, and the S13-D2 warning line
  (naming `account delete` and `bootstrap reissue`) are all covered by their tests, which I read.

## Attack 7 — the `doctor` findings

All four S13-D5 rows are covered in `reads.test.ts` with the rendered line **and** `ok`:

| State | Asserted line | `ok` |
|---|---|---|
| everything reachable | `dashboard access    ok` | `not.toContain('PROBLEMS FOUND')` |
| unreachable guild | guild id + `account grant-guild` | `doctor: PROBLEMS FOUND` |
| 0 accounts, live token | `dashboard access` + `bootstrap token` | `not.toContain('PROBLEMS FOUND')` |
| 0 accounts, no token | `nobody can sign in` | `doctor: PROBLEMS FOUND` |

Plus a fifth: an older/stubbed `doctor()` port with no `dashboardAccess` section renders no line
and fails nothing. **A fresh instance with a live bootstrap token is `ok`** — confirmed, and the
verdict function is exercised end to end against the real database in `wiring.test.ts`
(`readDashboardAccess` → `dashboardAccessOk`). The verdict is deliberately duplicated in
`reads.ts` (ADR 0014 forbids `packages/core` importing `apps/daemon`) with both copies tested,
which is the same pattern `provider.ts` already uses.

One subtlety worth recording: `readDashboardAccess` counts only **enabled** accounts, and a
guild with no entry in `guildScopes` fails closed. Both are right and both are commented.

---

# Rulings contested

- **S13-D1 (`--guild` is the target).** Correct, and correctly shouted — in the summary, in the
  success text, and in `docs/17`. One guild id on the line is the right call.
- **S13-D2 (no lockout guard on `revoke-guild`).** Correct; consistent with A3-3, and the warning
  names both recovery commands verbatim.
- **S13-D3 (generate, never accept).** Correct, and there is a test that a smuggled password
  argument is ignored rather than merely unused.
- **S13-D4 (sessions die, tokens live).** Correct, and the output names
  `account revoke-credentials` for the other half.
- **S13-D5 (two findings, both vote).** Correct, except the row-3 expiry (M1) and the
  two-doctors ambiguity (M2).
- **S13-D6 (choices only after the password verifies).** Correct, and driven — see Attack 1.
  The refusal is computed from data `login` already had, so it costs no query an attacker can
  time.
- **S13-D7 (re-scope, don't reissue).** Correct. UPDATE under the current scope is the right
  choice over delete-and-insert: one statement, the primary key survives, and every revocation
  query keeps addressing the row. The repository-level consequence is I2.
- **S13-D8 (no `requireFresh`).** **I contested this hardest and it holds.** The worry is that
  the switch changes which guild every subsequent write targets while carrying the old guild's
  freshness across — `setSessionGuild` leaves `reauth_at` untouched. But a fresh login to the
  target guild *also* sets `reauthAt = now` (`auth.test.ts`, "counts a fresh login as a
  re-authentication"), so the switch grants no freshness an attacker could not get by logging
  out and back in with the same password. There is no delta to defend, and a password prompt on
  a dropdown would be exactly the training-the-operator-to-retype problem the ruling names.
  Agreed. The wording problem is M5.
- **S13-D9 (server-fed reachable set).** Correct. `listGuildChoices` is the single function that
  pairs access rows with names, so `login`'s refusal and `GET /api/session` cannot disagree.
  `guildNameOf` swallows a parse failure rather than turning a login into a 500 — good, and the
  worst case is a choice rendered as its id.

# What to fix before merge

1. **I1** — rewrite the `docs/17` paragraph and the two code comments to the corrected
   diagnosis. Doc-only; no test changes.
2. **I2** — either guard `setSessionGuild` with the account id, or state the contract in its
   doc comment and amend the `sessions.ts` module header's now-repealed ADR 0012 invariant.
3. **M2** — one clause in `docs/17` saying which `doctor`.
4. **M6** — fold S13-D6..D9 into the plan of record.

M1, M3, M4, M5 and M7 are fine to carry.
