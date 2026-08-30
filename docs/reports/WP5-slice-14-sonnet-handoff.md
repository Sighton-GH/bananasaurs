# WP5 slice 14, second half — the dashboard's read endpoints and its one page

## MODEL AND EFFORT

Sonnet, high effort.

`docs/decisions/0022-claude-model-strategy.md` puts "Fastify route handlers for
well-understood endpoints" and "React dashboard components" in Tier B, and that
is exactly what is left. The security-critical core — password hashing, session
tokens hashed at rest, CSRF, lockout, the bootstrap route, and the authorization
decision for a dashboard session — was built at Tier A in slices 14a–14d and is
committed. **You are not re-deciding any of it.** Your endpoints go through a
guard that already performs the checks, and your job is to make the page work
without weakening what the guard does.

There is one Tier A shaped decision left inside your half, and it is called out
under THINGS THAT WILL BITE YOU: widening `OpsAuditWrite` so a dashboard action
can be attributed. Read that section before you touch `ports.ts`.

## BRANCH

```bash
git fetch origin
git checkout worktree-wp5-dashboard
```

Slices 14a–14d are two commits on that branch, not yet merged to main. Work on
the same branch and commit on top. Never `git push`, never merge, never force.

Do not work on `wp4-logging`, `worktree-wp3-role-panels`,
`worktree-wp5-live-test-fixes`, `worktree-wp5-live-test-report`,
`worktree-clarify-doc21`, or `worktree-wp5-operator-cli`. All stale or merged.

## SETUP

```bash
npm install && npm run build && npm run db:migrate
npm run test
```

**Confirm 1502 tests pass across 64 files before changing anything.** If the
count differs, stop and find out why.

Mutation numbering continues from **219**. Next free ADR number is **0031**
(verify with `ls docs/decisions/`).

## READ FIRST, IN THIS ORDER

1. `docs/SESSION_LOG.md`, the two WP5 slice 14 entries at the end. What was
   built, why, and the two mutation survivors that found real gaps.
2. `docs/decisions/0028-a-dashboard-account-is-a-principal.md`. How a dashboard
   session gets capability. You will call `authorize()` in every route; this is
   what makes that return true.
3. `docs/decisions/0029-dashboard-session-lifetime-and-reauthentication.md`.
   Session lifetime, CSRF, lockout, and — the part that shapes your kill-switch
   route — which actions need re-authentication and which deliberately do not.
4. `packages/http/src/server.ts`. **The whole file.** In particular
   `CreateServerOptions.registerRoutes` and the `RouteGuard` interface: that is
   your entry point and your entire security surface.
5. `packages/http/src/server.test.ts`, the `registerRoutes` block at the top. It
   registers three probe routes — `/api/probe`, `/api/probe-write`,
   `/api/probe-destructive` — that are worked examples of the three shapes you
   need. They exist to prove the guard, not to be the dashboard; leave them.
6. `packages/core/src/ops/ports.ts`. `OpsPorts` and `OpsInstance` are the shape
   every answer you need already has. You are not writing new queries.
7. `apps/daemon/src/ops/wiring.ts`, `opsPortsFor` and `opsInstanceFor`. Where an
   `OpsPorts` is actually constructed, and the seam you will extend.
8. `docs/19_RELEASE_0_1_PLAN.md` §6.10. One page: health, log routing, panel
   config, audit table, kill switch. Nothing else.
9. `docs/06_DASHBOARD_TARGET.md`, first ten lines only. It is a *target*
   document and says so; its fifteen areas are not Release 1.

## WHAT YOU ARE BUILDING

### 1. The read endpoints, over ports that already exist

Nothing here writes a new query. Every answer is already on `OpsPorts`, because
`bananasaurs status`, `audit tail`, `log routing list` and `panel list` answer
the same questions.

Create `packages/http/src/routes/read.ts` exporting one function:

```ts
export const registerReadRoutes = (app: FastifyInstance, guard: RouteGuard, deps: HttpDeps): void
```

and call it from `createServer` via the existing `registerRoutes` hook — do not
add a second hook.

| Route | Port call | Capability |
|---|---|---|
| `GET /api/health` | `instance.gateway()`, `ports.safetyState()`, `ports.jobCounts()`, `ports.oldestDueJobAtMs(now)` | `config.read` |
| `GET /api/log-routes` | `ports.listRoutes()`, `ports.listExcludedChannels()` | `logging.manage` |
| `GET /api/panels` | `ports.listPanels()` | `panels.manage` |
| `GET /api/panels/:id` | `ports.findPanel(id)` | `panels.manage` |
| `GET /api/audit` | `ports.tailAudit({ limit, sinceMs })` | `audit.read` |
| `GET /api/jobs` | `ports.listJobs({ failedOnly, limit })` | `config.read` |

**The seam you need.** `packages/http` cannot import `apps/daemon` (ADR 0014),
and `opsPortsFor` needs the daemon's per-guild `GuildOperations`. So:

- Add to `HttpDeps` in `packages/http/src/server.ts`:
  ```ts
  /** One OpsPorts per guild, supplied by the composition root. */
  readonly portsFor: (scope: GuildScope) => OpsPorts;
  readonly instance: OpsInstance;
  ```
  `OpsPorts` and `OpsInstance` are types from `@bananasaurs/core`, which
  `packages/http` may already import.
- Construct them in `apps/daemon/src/http/wiring.ts`, which already builds
  `HttpDeps` and calls `createServer`. It will need the daemon's `byGuild` map;
  `apps/daemon/src/runtime/daemon.ts` line ~282 shows exactly how `contextFor`
  gets one, and your `portsFor` is the same expression.
- In a route, get the scope from the session: **`session.scope`**, never from a
  query parameter. It was built from the `guild_id` the database returned
  (`packages/http/src/auth.ts`, `authenticate`). A route that reads a guild id
  out of the request is a bug even if it validates it.

**Authorization in every route**, with no exceptions:

```ts
import { authorize } from '@bananasaurs/core';
import { authzStoreFor } from '@bananasaurs/storage';

const result = authorize(
  { store: authzStoreFor(session.scope), guildId: session.guildId, actor: session.actor },
  'audit.read',
);
if (!result.ok) return reply.status(403).send({ error: 'no-grant' });
```

`session.actor` is already a `dashboard` actor with the account's id and no
Discord roles. Do not construct an `Actor` yourself; `actorFor` in `auth.ts` is
the only place one is made, deliberately.

Write a helper — `requireCapability(session, capability, reply)` — rather than
repeating the block, but keep the `authorize()` call inside it. Do not add a
capability argument to `RouteGuard`: the guard's job is session and CSRF, and
merging the two would mean one function whose failure modes are 401, 403-csrf
and 403-no-grant, which is three different things for a page to react to.

### 2. The two write endpoints

| Route | Guard | Port call |
|---|---|---|
| `POST /api/killswitch` `{ on: boolean }` | `on === true` → `guard.require`; `on === false` → `guard.requireFresh` | `ports.setKillswitch(on)` |
| `POST /api/log-routes` `{ eventKind, channelId, includeContent }` | `guard.require` | `ports.setRoute(...)` |

The asymmetry on the kill switch is ADR 0029 and is not an oversight: **enabling
it is not gated by re-authentication.** The control that stops the bot must never
be harder to reach than the one that starts it. Write the test that says so.

Both must record an audit row. See the audit attribution note below — that is
the one real design decision in your half.

Release 1 has no panel-editing endpoint. `docs/19` §6.10 says panel *config*,
and `bananasaurs panel show` plus `panel sync` already cover changing one. Read
only.

### 3. `packages/dashboard` — React + Vite, one page

- `packages/dashboard/package.json`, `tsconfig.json`, `vite.config.ts`,
  `index.html`, `src/main.tsx`, `src/App.tsx`.
- Add `{ "path": "packages/dashboard" }` to root `tsconfig.json` and an alias in
  `vitest.config.ts` if you write component tests.
- One page, five sections: health, log routing, panel config, audit table, kill
  switch. A login form, and a bootstrap form when `/api/bootstrap` exists.
- Talk to the API over `fetch` with `credentials: 'same-origin'`. Read the CSRF
  token from `GET /api/session` (`{ csrfToken }`) and send it as the
  `X-Bananasaurs-CSRF` header on **every** POST. `CSRF_HEADER` is exported from
  `@bananasaurs/http` — but the dashboard may not import that package, so
  hard-code the string and add a test in `packages/http` asserting the two
  agree.
- Handle `401 { error: 'reauth-required' }` by prompting for the password and
  POSTing to `/api/reauth`, then retrying. The session is still live; do not log
  the user out.
- Handle `503 { error: 'read-only' }` by rendering the `message` field, which
  names `BANANASAURS_READONLY` and says what to do.

### 4. Serving the built bundle

Fastify serves `packages/dashboard/dist` as static files, with an SPA fallback to
`index.html`. `@fastify/static` is the obvious way; it is a first-party Fastify
plugin and a reasonable addition, but it is **not** on the pre-authorised list —
justify it in one line in the commit message, as ADR 0008 requires for every new
dependency. A twenty-line manual handler is also fine and avoids the question.

Add `packages/dashboard`'s build to `npm run build`. It must not run in
`npm run test`.

## SETTLED — DO NOT RE-LITIGATE

- **Do not touch `packages/http/src/secrets.ts`, `auth.ts`, or `policy.ts`.**
  Those are the Tier A core, reviewed and mutation-tested. If a route needs
  something they do not expose, add a route-level helper rather than changing
  them; if you are certain one of them is wrong, say so in your report instead
  of editing it.
- **No Discord OAuth.** Other club administrators hold Discord Administrator and
  it grants nothing here (ADR 0012). Do not add a "log in with Discord" button.
- **`dashboard` is not in `CHANNEL_AUTHORIZED_ACTORS` and must not be added.**
  `authz.ts` says so in a comment.
- **The bind is loopback and the schema now enforces it.** `DASHBOARD_BIND` is
  an enum of `127.0.0.1` / `localhost` / `::1`. If the page will not load from
  your laptop, the fix is `ssh -L 8787:127.0.0.1:8787 <host>`, which
  `docs/17` §1 now documents. Do not widen the enum.
- **`packages/dashboard` may not import** `fastify`, `node:*`,
  `@bananasaurs/storage`, `@bananasaurs/http`, `discord.js`, or the REST port.
  `eslint.config.js:77` already bans them and
  `packages/core/src/boundaries.test.ts` asserts the rules resolve. **Add the
  missing `lintText` case** — there is a comment in that file saying exactly why
  it was left out and that it belongs with the slice that creates the package.
  That slice is yours.
- **Sessions, CSRF, lockout and re-auth are decided.** ADRs 0029 and 0030.
- **TOTP is deferred** (ADR 0030), and `packages/core/src/authz.test.ts` has a
  test that fails if a capability requiring it is ever added. Do not delete it.
- One process, no second service (ADR 0006).

## THINGS THAT WILL BITE YOU

**Audit attribution is the one real decision in your half, and `OpsAuditWrite`
cannot currently express a dashboard action.** Read `packages/core/src/ops/
ports.ts`:

```ts
readonly actorType: 'operator_cli';
readonly actorId: undefined;
readonly actorUnixUserClaimed: string | undefined;
readonly via: 'ssh';
```

Every field is narrowed to the CLI. Widening it is straightforward — but get the
reasoning right, because it is the opposite of the CLI's:

- `actorType` becomes `'operator_cli' | 'dashboard'`.
- `via` becomes `'ssh' | 'http'`. The column's vocabulary already includes
  `http`; `docs/19` §6.9 says it means the dashboard.
- **`actorId` must be filled for a dashboard action, and this is the point.**
  The CLI leaves it `undefined` because it has no verified identity — ADR 0024,
  amendment 2: laundering a claimed Unix name into the column every other actor
  type fills with a verified one would make the trail read as stronger evidence
  than it is. A dashboard session is the reverse. The account id came from a
  session the server itself issued against a password it verified, so it *is* a
  verified identity and belongs in that column.
- `actorUnixUserClaimed` stays `undefined` for a dashboard action. There is no
  Unix user in the request and inventing one would be the exact mistake above.

Write that reasoning into an ADR (0031) before you change the type. It is short,
but "why does one actor fill `actor_id` and the other refuse to" is a question
someone will ask later, and the answer is not obvious from either code path
alone.

The dispatcher builds the audit row in `auditWriteFor` at the bottom of
`packages/core/src/ops/dispatch.ts` and hard-codes both fields. Your HTTP routes
do not go through the dispatcher, so you construct `OpsAuditWrite` yourself and
call `ports.recordAudit(...)`. Do not route HTTP requests through
`createDispatcher` to reuse its audit path — it resolves guilds from a
CLI-shaped request and asserts `actorType: 'operator_cli'` unconditionally.

**`write(scope, fn)` forbids async.** `NotPromise<T>` makes an async transaction
uncompilable. Nothing in your half hashes anything, so this should not arise —
but if you find yourself wanting `await` inside a `write`, the answer is to move
the await out, not to work around the type.

**The clock is injected everywhere.** `deps.now()`, never `Date.now()`. Slice 13e
found a real bug from exactly this, and slice 14's `bootstrapIsArmed` had a test
that passed for the wrong reason because a test helper advanced a clock it could
not move back. If a test calls `at(clock + something)` and then wants to go back,
capture the original value first.

**`BANANASAURS_READONLY`.** Your write routes must refuse. They mostly do so for
free — `server.ts`'s error handler turns any `ReadonlyError` into a 503 — but
mutation 216 showed that relying on the error handler alone can leak: a code path
that *does not reach a write* answers differently from one that does. If a write
route has an early return before its first write, check `deps.readonly`
explicitly and test that both paths answer identically.

**Instance-level vs guild-scoped.** `dashboard_accounts` and `bootstrap_tokens`
take an `InstanceScope`; everything else takes a `GuildScope`. The type is the
answer to "is this query partitioned" (ADR 0027). You should need only
`session.scope`.

**Do not weaken a boundary rule to make an import work.** Slice 13e hit the
ADR 0014 tripwire because a file was named `commands/discord.ts`; the fix was to
rename the file. A rule weakened for a filename is a rule that will not catch the
import it exists for.

**`GET /api/session` sends no CORS headers, deliberately.** That is what stops a
cross-origin page reading the CSRF token out of its body. If you find yourself
adding CORS headers to make local development work, you are about to defeat a
control — serve the dashboard from the same origin instead.

## PROTOCOL

1. Record consequential choices as ADRs in `docs/decisions/` **before**
   implementing them, numbered sequentially from **0031**. You have at least
   one: the audit attribution decision above.
2. Write the test first for anything touching permissions, authorization,
   idempotency, retention or guild scope. Every route you add is a capability
   check, so that is all of them.
3. Run `npm run typecheck && npm run lint && npm run test` and paste the real
   output. Do not report completion on the basis of code you have not run.
4. After each slice, break the implementation deliberately to prove the tests
   catch it. **Number the mutations from 219.** Restore with a file copy, never
   `git checkout <file>` — a checkout also discards anything else uncommitted in
   that file. A survivor is a finding, not a nuisance: across slices 14a–14d two
   mutations survived, and both were real gaps — one test that passed because a
   clock never reset, and one guard that looked redundant and was a username
   oracle without it. Two suggested starting points: delete a
   `requireCapability` call from one read route, and make the kill-switch route
   use `guard.require` for both directions.
5. Append to `docs/SESSION_LOG.md` after each slice.
6. Commit after each slice, on the branch. Never `git push`.

## SECURITY

You cannot connect to Discord and must not attempt to. Never read, print or copy
`.env`. Never spawn the `claude` binary from application code, directly or
through a queue, even with a human approving each step (ADR 0013). The ESLint
tripwire enforcing that is absolute; do not add an exception.

Your routes are reached by a credential over a network port. Two specific things
to not do, both of which look reasonable in the moment:

- Do not read a guild id, an account id, or a capability from the request. All
  three are on `session`, and all three came from the database.
- Do not add a route that returns configuration without redaction.
  `instance.redactedConfig()` is already redacted before the caller sees it
  (ADR 0013 §4); use it rather than reaching for `config` directly.

## FINISH BY

Stopping when the read endpoints, the two write endpoints, the page, and the
build wiring are done, tested and committed, and reporting: what you built, the
real verification output, the mutation log from 219 with every survivor and what
it changed, and the ADRs you wrote.

## A NOTE FOR THE SLICE AFTER THIS ONE

Slice 15 is `/privacy`, and **no slash-command support exists at all**.
`packages/discord/src/events.ts:106` filters interactions to buttons and string
select menus only. Slice 15 must add a `slashCommand` domain event, command
registration, and the feature-state-aware renderer `docs/19` §6.11 requires. It
is more than one command's worth of work; do not let it be estimated as one.
