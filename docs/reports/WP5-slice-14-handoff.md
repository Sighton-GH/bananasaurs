# WP5 slice 14 handoff — the dashboard

Written 2026-08-30, at the end of slice 13. Slice 13 (the operator CLI) is
complete and committed on `worktree-wp5-operator-cli`; nothing is pushed.

---

## MODEL AND EFFORT

**Split the slice across two models. Do not run 14a on a cheap tier.**

`docs/decisions/0022-claude-model-strategy.md` puts "Fastify route handlers for
well-understood endpoints" and "React dashboard components" in Tier B (Sonnet).
That is right for **14b** and wrong for **14a**, and the ADR says why in its own
Tier A definition: *anything where a subtle bug has real consequences (wrong
ban, data leak, silent failure)*.

14a is authentication on a control plane that exposes the kill switch, the
audit trail and the log configuration. Password hashing, session tokens hashed
at rest, CSRF, lockout, and a bootstrap route that must **404 rather than 403**
are all one-line-wrong-and-silently-broken. It is the last security-critical
surface in Release 1.

| Slice | Work | Model |
|---|---|---|
| **14a** — accounts, sessions, bootstrap, CSRF, lockout | Auth core | **Opus, high effort** |
| **14b** — the one page, and the read endpoints it calls | Established patterns | **Sonnet, medium** |
| The drizzle migration, `.env.example`, docs edits | Mechanical | Free tier / ClinePass |

**On DeepSeek specifically.** It is not a Claude Code model — it is reachable
through Cline/ClinePass, and ADR 0022 §4 scopes free and ClinePass models to
*mechanical* work: migrations, documentation, test scaffolding, formatting,
type-only changes. Authentication is not on that list and must not be added to
it. Use it for the migration and the `.env.example` update if you like; not for
anything in `packages/http/src/auth`.

If cost is the binding constraint, the cheaper honest split is: Opus writes
14a's ADR, the session/password/bootstrap modules and their tests; Sonnet writes
every route that is not on the auth path, plus all of 14b.

---

## BRANCH

Work continues on **`worktree-wp5-operator-cli`**, or call EnterWorktree with
name `wp5-dashboard` if you would rather isolate it. Either is fine; slice 14
depends on slice 13's committed work, not on its working tree.

Do **not** work on `wp4-logging`, `worktree-wp3-role-panels`,
`worktree-wp5-live-test-fixes`, `worktree-wp5-live-test-report`, or
`worktree-clarify-doc21`. All stale or merged.

**Never `git push`.** Commit per slice on your branch.

## SETUP

```bash
npm install && npm run build && npm run db:migrate
npm run test
```

Confirm **1278 tests pass** before changing anything. If the count differs,
stop and find out why.

Mutation numbering continues from **196**. Next free ADR number is **0027**
(verify — `ls docs/decisions/`).

## READ FIRST, IN THIS ORDER

1. **`docs/decisions/0012-dashboard-authentication-is-owner-provisioned-local-accounts.md`.**
   The whole design. Read it before you read any code.
2. **`docs/19` §6.10** — the first-account bootstrap, in four numbered steps.
   Follow them literally; step 2 in particular.
3. **`packages/storage/src/schema.ts:600-701`** — `dashboard_accounts`,
   `account_guild_access`, `dashboard_sessions`, `bootstrap_tokens`. **All four
   tables already exist and are migrated.** You are writing repositories and
   routes, not schema. Read the comment on `dashboard_sessions`' primary key
   before you touch it.
4. **`packages/storage/src/schema-invariants.test.ts`** — the `UNIQUE_BY_DESIGN`
   map at the top. It is a map in a test, not a document, and it holds the
   `dashboard_sessions` exemption: the one unique index in the schema that does
   not lead with `guild_id`, because a session is looked up by its token
   *before* the guild is known. Any index you add that does not lead with
   `guild_id` fails that test until it is listed there with a reason.
5. **`packages/core/src/authz.ts`**, particularly `CHANNEL_AUTHORIZED_ACTORS`
   and the comment above it.
6. **`docs/SESSION_LOG.md`**, the WP5 entries for slices 13a–13e — the shape
   the operator surface settled on, and the two ADRs it needed.
7. `docs/decisions/0024` and `0026` — the operator-surface decisions you will
   be extending with `bootstrap reissue`.

## WHAT THIS SLICE COVERS

**14a — the API.** `packages/http`: Fastify, bound to `127.0.0.1`. Account
repository, Argon2id password hashing, DB-backed sessions with the token hashed
at rest, guild-scoped session rows, CSRF on every state-changing request,
failed-attempt lockout, re-authentication for destructive actions, and the
first-account bootstrap flow. Plus `bananasaurs bootstrap reissue --confirm` in
the operator CLI, which is ADR 0012's documented recovery path and the reason
the owner is not a single point of failure.

**14b — the page.** `packages/dashboard`: React + Vite built to static files
and served by Fastify. One page: health, log routing, panel config, audit table,
kill switch. Every one of those already has a working read behind it — reuse
`OpsPorts`' shape rather than inventing a second set of queries.

## SETTLED — DO NOT RE-LITIGATE

- **Two packages, named already.** `packages/http` (the API) and
  `packages/dashboard` (the static bundle). `eslint.config.js:57` and `:77`
  already carry their ADR 0014 boundary rules, written before the directories
  existed and **inert until you create them** — exactly as `packages/cli`'s were
  until slice 13a. `packages/dashboard` may not import `fastify`, `node:*`,
  `@bananasaurs/storage`, discord.js or the REST port: it talks to the API over
  HTTP. `packages/core/src/boundaries.test.ts` asserts these rules actually
  fire; add cases for the two new directories there.
- **No Discord OAuth.** Other club administrators hold Discord Administrator
  and it grants nothing here (ADR 0012). Do not add a login-with-Discord button
  "for convenience".
- **`dashboard` is not in `CHANNEL_AUTHORIZED_ACTORS` and must not be added.**
  `authz.ts` says so in a comment. The operator socket's authorization is its
  filesystem permissions (ADR 0024); a dashboard session is a credential over a
  network port and goes through `capability_grants` like every other principal.
- **Sessions are DB-backed, not stateless-signed.** `docs/19` §6.10: revocation
  must be immediate on a control plane with a kill switch on it.
- **The session cookie carries a random 256-bit token; the database stores only
  its hash.** Same discipline as the bootstrap token.
- **`/bootstrap` is registered only when the account table is empty and an
  unconsumed token exists.** Otherwise the route does not exist — **404, not
  403**, so its absence leaks nothing. This is a registration-time decision, not
  a guard inside a handler.
- **The bootstrap token is printed once, to stdout/journal, and never stored in
  plaintext.** Fifteen-minute expiry. No default password, ever.
- **Bind `127.0.0.1`.** Reaching it from elsewhere is `ssh -L` or Tailscale, and
  the operator docs should say so plainly — "the dashboard doesn't load" is
  otherwise a confusing first experience and the fix is *not* to change the
  bind.
- **New dependencies are pre-authorised**: `fastify` (ADR 0008) and an Argon2id
  implementation (ADR 0012). Prefer `@node-rs/argon2` for the prebuilt binary;
  `argon2` is acceptable. One line of justification each in the commit message.
  React and Vite for 14b, likewise named by ADR 0008. Anything beyond those
  four is a stop-and-ask.
- **One process.** The API is served by the same daemon, from the same
  composition root. No second service (ADR 0006).

## THINGS THAT WILL BITE YOU

- **TOTP.** ADR 0012 requires it for accounts holding provider-credential or
  purge capability. Neither capability exists in Release 1 — there is no
  provider layer and no purge. The columns (`totp_secret_enc`, `totp_enrolled`)
  are already in the schema. Decide explicitly whether to build it now or record
  the deferral in an ADR with the condition that re-arms it; do not leave it
  unmentioned.
- **The clock.** Every wiring function in this tree takes an injected `now`, not
  `Date.now()`. Slice 13e found a real bug from exactly this: an ops port on the
  wall clock enqueued a job dated in the future that `claimNext` never claimed,
  presenting as a row sitting in `jobs list` forever with nothing saying why.
  Session expiry has the same shape.
- **`write(scope, fn)` forbids `async`.** `NotPromise<T>` makes an async
  transaction uncompilable. Argon2 hashing is async: hash **outside** the
  transaction, write the result inside it.
- **`BANANASAURS_READONLY`.** Every write must refuse under it, the way the CLI
  does. `write()` throws `ReadonlyError`; map it to a 503 or a 403 deliberately
  and test it.
- **Instance-level vs guild-scoped.** `dashboard_accounts` and
  `bootstrap_tokens` are instance-level; `account_guild_access` and
  `dashboard_sessions` are guild-scoped. `GuildScope` does not apply to the
  first two, and forcing it would be worse than the exemption. Read the schema
  comments — they explain both choices.

## PROTOCOL

- **Record consequential choices as ADRs in `docs/decisions/` BEFORE
  implementing them**, numbered sequentially from 0027. Slice 14a has at least
  two: the TOTP decision above, and whichever session-lifetime/re-auth policy
  you land on.
- **Write the test first** for anything touching permissions, hierarchy,
  idempotency, retention or guild scope. All of 14a's auth path qualifies.
- Run `npm run typecheck && npm run lint && npm run test` and **paste the real
  output**. Do not report completion on the basis of code you have not run.
- After each slice, **break the implementation deliberately** to prove the tests
  catch it. Number the mutations from **196**. Restore with a **file copy, never
  `git checkout <file>`** — a checkout also discards anything else uncommitted
  in that file. `/home/bryan/.claude/jobs/*/tmp/mutate.py` from slice 13 is a
  working harness if it is still around; it is twenty lines to rewrite if not.
  A survivor is a finding, not a nuisance: in slice 13, four of five survivors
  were missing tests and one falsified a comment that was simply wrong.
- Append to `docs/SESSION_LOG.md` after each slice.
- Commit after each slice, on the branch. **Never `git push`.**

## SECURITY

You cannot connect to Discord and must not attempt to. Never read, print or
copy `.env`. Never spawn the `claude` binary from application code, directly or
through a queue, even with a human approving each step (ADR 0013). The ESLint
tripwire enforcing that is absolute; do not add an exception.

Do not weaken a boundary rule to make an import work. Slice 13e hit the ADR 0014
tripwire because a new file was named `commands/discord.ts`; the fix was to
rename the file, because a rule weakened for a filename is a rule that will not
catch the import it exists for.

## FINISH BY

Stopping at the end of slice 14 and reporting: what was built, the real
verification output, the mutation log with every survivor and what it changed,
and the ADRs written. Slice 15 (`/privacy`) is the next slice and is **not**
part of this handoff.

Note for slice 15, so it is not rediscovered: **no slash-command support exists
at all.** `packages/discord/src/events.ts:106` filters interactions to buttons
and string select menus only, so slice 15 must add a `slashCommand` domain
event, command registration, and the feature-state-aware renderer.
