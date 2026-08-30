# WP5 slice 14 — the dashboard: Opus handoff prompt

Paste the section below into a fresh Claude Code session running **Opus, high
effort**. It scopes the work Opus should do itself and ends by asking Opus to
write the follow-on prompt for Sonnet.

Written 2026-08-30 at the end of slice 13.

---

## MODEL AND EFFORT

**Opus, high effort.** You are building the authentication and session core of
the Bananasaurs dashboard.

`docs/decisions/0022-claude-model-strategy.md` puts "Fastify route handlers for
well-understood endpoints" and "React dashboard components" in Tier B (Sonnet),
and that is right for most of slice 14. It is not right for the part you are
doing. The ADR's own Tier A definition is *anything where a subtle bug has real
consequences (wrong ban, data leak, silent failure)*, and this dashboard is the
control plane for a bot with a kill switch, an audit trail and a log
configuration on it. Password hashing, session tokens hashed at rest, CSRF,
lockout, and a bootstrap route that must 404 rather than 403 are all
one-line-wrong-and-silently-broken. This is the last security-critical surface
in Release 1.

**You decide where your half ends.** Build what genuinely needs this tier —
the security-critical core and the decisions that shape everything after it —
and stop there. Do not carry on into React components or CRUD routes that follow
an established pattern just because you are already in the file. When you stop,
you will write the prompt that hands the rest to Sonnet (see FINISH BY).

## BRANCH

```bash
git fetch origin
```

Slice 13 is on **`worktree-wp5-operator-cli`**, merged to `main`. Start from
`main` and call EnterWorktree with name `wp5-dashboard`.

Do **not** work on `wp4-logging`, `worktree-wp3-role-panels`,
`worktree-wp5-live-test-fixes`, `worktree-wp5-live-test-report`,
`worktree-clarify-doc21`, or `worktree-wp5-operator-cli`. All stale or merged.

Commit on your new branch only. **Never `git push`**, never merge, never force.

## SETUP

```bash
npm install && npm run build && npm run db:migrate
npm run test
```

Confirm **1278 tests pass** before changing anything. If the count differs, stop
and find out why.

Mutation numbering continues from **196**. Next free ADR number is **0027**
(verify with `ls docs/decisions/`).

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
   map at the top. It is a map in a test, not the document its name suggests,
   and it holds the `dashboard_sessions` exemption: the one unique index in the
   schema that does not lead with `guild_id`, because a session is looked up by
   its token *before* the guild is known. Any index you add that does not lead
   with `guild_id` fails that test until it is listed there with a reason.
5. **`packages/core/src/authz.ts`**, particularly `CHANNEL_AUTHORIZED_ACTORS`
   and the comment above it.
6. **`docs/SESSION_LOG.md`**, the WP5 entries for slices 13a–13e — the shape the
   operator surface settled on, and the three ADRs it needed (0024, 0025, 0026).
7. **`packages/core/src/ops/`** — the whole directory. The dashboard's read
   endpoints answer the same questions `bananasaurs status`, `audit tail`,
   `log routing list` and `panel list` already answer, and `OpsPorts` is the
   shape those answers already have.

## WHAT YOU ARE BUILDING

`packages/http` — a Fastify API served by the existing daemon, bound to
`127.0.0.1`, in the same process (ADR 0006). At minimum, and this is the part
that needs you rather than Sonnet:

- **The account repository and Argon2id password handling.** Instance-level,
  not guild-scoped — read the schema comment for why.
- **DB-backed sessions.** The cookie carries a random 256-bit token; the
  database stores only its hash. Guild-scoped rows. Immediate revocation.
- **The first-account bootstrap**, exactly as `docs/19` §6.10 step 2 describes.
- **CSRF on every state-changing request**, failed-attempt lockout using the
  `failed_attempts` / `locked_until` columns that already exist, and
  re-authentication for destructive actions.
- **`bananasaurs bootstrap reissue --confirm`** in the operator CLI. This is
  ADR 0012's documented recovery path and the reason the owner is not a single
  point of failure for dashboard access. The command pattern is established:
  `defineCommand` in `packages/core/src/ops/commands/`, registered in
  `registry.ts`, reached through a port on `OpsPorts`. Slices 13d and 13e are
  six worked examples.
- **The authorization decision for a dashboard session**, and its ADR.

Anything past that — the read endpoints over ports that already exist, the React
page, the Vite build — is Sonnet's, and you are writing its prompt rather than
its code.

## SETTLED — DO NOT RE-LITIGATE

- **Two packages, named already.** `packages/http` (the API) and
  `packages/dashboard` (the static bundle). `eslint.config.js:57` and `:77`
  already carry their ADR 0014 boundary rules, written before the directories
  existed and **inert until you create them** — exactly as `packages/cli`'s were
  until slice 13a. `packages/dashboard` may not import `fastify`, `node:*`,
  `@bananasaurs/storage`, discord.js or the REST port: it talks to the API over
  HTTP. `packages/core/src/boundaries.test.ts` asserts these rules actually
  fire; add cases for the new directories there.
- **No Discord OAuth.** Other club administrators hold Discord Administrator and
  it grants nothing here (ADR 0012). Do not add a login-with-Discord button "for
  convenience".
- **`dashboard` is not in `CHANNEL_AUTHORIZED_ACTORS` and must not be added.**
  `authz.ts` says so in a comment. The operator socket's authorization is its
  filesystem permissions (ADR 0024); a dashboard session is a credential over a
  network port and goes through `capability_grants` like every other principal.
- **Sessions are DB-backed, not stateless-signed.** `docs/19` §6.10: revocation
  must be immediate on a control plane with a kill switch on it.
- **`/bootstrap` is registered only when the account table is empty and an
  unconsumed token exists.** Otherwise the route does not exist — **404, not
  403**, so its absence leaks nothing. That is a registration-time decision, not
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
  React and Vite are likewise named by ADR 0008 but belong to Sonnet's half.
  Anything beyond those is a stop-and-ask.
- **One process. No second service** (ADR 0006).

## THINGS THAT WILL BITE YOU

Slice 13 hit all of these. They are here so you do not rediscover them.

- **`write(scope, fn)` forbids `async`.** `NotPromise<T>` makes an async
  transaction uncompilable. Argon2 hashing is async: hash **outside** the
  transaction, write the result inside it.
- **The clock.** Every wiring function in this tree takes an injected `now`, not
  `Date.now()`. Slice 13e found a real bug from exactly this: an ops port on the
  wall clock enqueued a job dated in the future that `claimNext` never claimed,
  presenting as a row sitting in `jobs list` forever with nothing saying why.
  Session expiry and token expiry have the same shape.
- **`BANANASAURS_READONLY`.** Every write must refuse under it, the way the CLI
  does. `write()` throws `ReadonlyError`; decide deliberately what HTTP status
  that becomes, and test it. Note also that slice 13d found the daemon could not
  *start* read-only until it was fixed — the same class of bug is available to
  anything that writes at startup, and the bootstrap token generator writes at
  startup.
- **Instance-level vs guild-scoped.** `dashboard_accounts` and
  `bootstrap_tokens` are instance-level; `account_guild_access` and
  `dashboard_sessions` are guild-scoped. `GuildScope` does not apply to the
  first two and forcing it would be worse than the exemption. The schema
  comments explain both choices.
- **TOTP.** ADR 0012 requires it for accounts holding provider-credential or
  purge capability. Neither capability exists in Release 1 — there is no
  provider layer and no purge — and the columns (`totp_secret_enc`,
  `totp_enrolled`) already exist. Decide explicitly whether to build it now or
  record the deferral in an ADR **with the condition that re-arms it**. Do not
  leave it unmentioned.
- **Do not weaken a boundary rule to make an import work.** Slice 13e hit the
  ADR 0014 tripwire because a new file was named `commands/discord.ts`; the fix
  was to rename the file, because a rule weakened for a filename is a rule that
  will not catch the import it exists for.

## PROTOCOL

- **Record consequential choices as ADRs in `docs/decisions/` BEFORE
  implementing them**, numbered sequentially from 0027. You have at least two:
  the TOTP decision above, and the session-lifetime / re-authentication policy.
- **Write the test first** for anything touching permissions, hierarchy,
  idempotency, retention or guild scope. Your entire half qualifies.
- Run `npm run typecheck && npm run lint && npm run test` and **paste the real
  output**. Do not report completion on the basis of code you have not run.
- After each slice, **break the implementation deliberately** to prove the tests
  catch it. Number the mutations from **196**. Restore with a **file copy, never
  `git checkout <file>`** — a checkout also discards anything else uncommitted
  in that file. A survivor is a finding, not a nuisance: across slices 13c–13e,
  eight mutations survived on the first attempt; seven were missing tests and
  one falsified a code comment that was simply wrong.
- Append to `docs/SESSION_LOG.md` after each slice.
- Commit after each slice, on your branch. **Never `git push`.**

## SECURITY

You cannot connect to Discord and must not attempt to. Never read, print or copy
`.env`. Never spawn the `claude` binary from application code, directly or
through a queue, even with a human approving each step (ADR 0013). The ESLint
tripwire enforcing that is absolute; do not add an exception.

## FINISH BY

Stopping when the security-critical core is done, tested and committed, and
reporting: what you built, the real verification output, the mutation log with
every survivor and what it changed, and the ADRs you wrote.

**Then write me a handoff prompt for a Sonnet session to finish slice 14**, as a
file at `docs/reports/WP5-slice-14-sonnet-handoff.md`, and commit it. It should
follow the shape of this prompt — model and effort, branch, setup with the exact
test count you left behind, read-first list, what it covers, settled decisions,
things that will bite it, protocol, security, finish-by — and it should cover
exactly the work you deliberately did not do: the read endpoints over the ports
that already exist, the React + Vite page (health, log routing, panel config,
audit table, kill switch), and its build wiring.

Be concrete about the seams you left for it: the exact module and function names
it should call, which of your types it should import, what it must not touch,
and the mutation number it continues from. A handoff that says "wire up the
remaining endpoints" is not one; a handoff that names the port, the file and the
test file is.

Note for the slice after this one, so it is not rediscovered: slice 15 is
`/privacy`, and **no slash-command support exists at all** —
`packages/discord/src/events.ts:106` filters interactions to buttons and string
select menus only, so slice 15 must add a `slashCommand` domain event, command
registration, and the feature-state-aware renderer `docs/19` §6.11 requires.
