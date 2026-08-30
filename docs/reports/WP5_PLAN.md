# WP5 plan — operator CLI, dashboard, `/privacy` — **DRAFT**

Status: draft, written before implementation. Slice 6 already shipped (out of
order, `docs/reports/WP5-slice-6.md`). This plan covers slices **13, 14, 15**.

Baseline confirmed on `worktree-wp5-operator-cli` from `93314e0`: `npm run
build` and `npm run db:migrate` exit 0, **954 tests pass**, matching the WP4
handoff exactly.

---

## 1. The scope question the WP4 report asked me to answer first

`docs/reports/WP4.md` §5 flags that slice 13 has no stated command for
configuring `log_routes` / `log_excluded_channels`, and that WP4 is inert
without one.

**It is already in scope, and the WP4 report looked at the wrong list.**
`docs/19` §6.9 ends with "Release 1 surface is exactly the list in `docs/17`",
and `docs/17_OPERATOR_ACCESS.md:33-34` contains:

```
bananasaurs log routing list
bananasaurs log routing set <event> <channel-id> --confirm
```

`docs/19` §7's slice-13 *demonstrable* column names four commands
(`status`, `audit tail`, `panel sync`, `killswitch`) — that is a sample of
what to demo, not the surface. So no scope change is needed; the command is
sized in below as part of 13d, plus `log routing exclude`/`unexclude` for
`log_excluded_channels`, which `docs/17` does not name but which is the other
half of the same table pair and is worthless to defer.

## 2. The union of the three surface lists

| Command | Source | Slice |
|---|---|---|
| `status` | 17, 19 §7, 20 | 13a |
| `killswitch on\|off --confirm` | 17, 19 §7, 20 | 13b |
| `doctor` | 17, 20 | 13c |
| `audit tail -n N [--since 2h]` | 17, 19 §7, 20 | 13c |
| `jobs list [--failed]` | 17 | 13c |
| `config get <key>` | 17 | 13c |
| `panel list`, `panel show <id>` | 17 | 13c |
| `log routing list` | 17 | 13c |
| `config set <key> <value> --confirm` | 17 | 13d |
| `log routing set <event> <channel> --confirm` | 17 | 13d |
| `log routing off <event> --confirm` | — | 13d |
| `log routing exclude\|unexclude <channel> --confirm` | — | 13d |
| `jobs retry <id> --confirm` | 17 | 13d |
| `panel sync <id> --confirm` | 17, 19 §7 | 13e |
| `undo <batch-id> --confirm` | 20 | 13e |
| `adoption allow <n> --confirm` | 21 ex. 5 | 13e |

`bootstrap reissue --confirm` (docs/19 §6.10 step 4) lands in **14a**, with the
account table it re-arms.

## 3. Sizing — why slice 13 becomes 13a–13d

`docs/20` says a slice needing more than roughly 400 lines of new
implementation is mis-sized. Fourteen commands, a socket server, a wire
protocol, a CLI binary and an authorization decision is several times that.
Split the same way WP4 split slice 12 into 12a–12e.

### 13a — the socket, the protocol, and `status`

- `packages/core/src/ops/protocol.ts` — Zod request/response envelope. Model
  output and CLI input alike are untrusted; this is the validator (rule 3).
- `packages/core/src/ops/dispatch.ts` — a **pure** command dispatcher: parsed
  request + command registry -> response. No `net`, no database, so the whole
  command surface is unit-testable with zero I/O.
- `apps/daemon/src/ops/socket.ts` — `net.Server`, newline-delimited JSON,
  `chmod 0660`, stale-socket reclaim.
- `packages/cli/` — the `bananasaurs` bin. Argument parsing, connect, render
  text or `--json`, exit codes. ESLint already bans `@bananasaurs/storage`
  and `better-sqlite3` here (ADR 0014); the rules are inert today and bite the
  moment the directory exists.
- First command: `status`.

**Single-writer correction, completed.** `docs/19` amendment 1 specifies
"socket bind **plus** `O_EXCL` PID lockfile". Only the lockfile exists today —
`packages/storage/src/lock.ts:10` documents the socket bind as if it were
already there, and nothing in the tree calls `net.createServer`. 13a adds the
missing half, and binds **before** opening the database so the comment becomes
true rather than aspirational. Unix-socket `listen()` fails `EADDRINUSE` on a
*stale file* as well as a live listener, so the bind probes with a connect
first: `ECONNREFUSED` means stale, unlink and retry; a successful connect
means a live daemon and start is refused naming the path.

### 13b — the authorization and audit spine, and `killswitch`

Needs **ADR 0024** first (§4 below). Adds: actor construction, the
server-side `--confirm` gate, the readonly refusal, and an audit row on every
write with `actor_type='operator_cli'`, `via='ssh'`,
`actor_unix_user_claimed`. First write command: `killswitch on|off`.

### 13c — read commands

`doctor`, `audit tail`, `jobs list`, `config get` (redaction), `panel list`,
`panel show`, `log routing list`. This is where the model/effort note in the
handoff says to drop to Sonnet: it is the same shape four more times.

### 13d — write commands that stay inside the database

**Split from the original 13d during implementation.** One slice covering all
seven writes ran well past the ~400 lines `docs/20` calls mis-sized, and the
three Discord-reaching commands are a different kind of work from writing a
column. 13d is therefore: `config set`, `log routing set`,
`log routing off`, `log routing exclude|unexclude`, `jobs retry`.

Needs **ADR 0025** first: `docs/17` lists `config get` and `config set` as a
matched pair over one key space, and they cannot be — the getter reads the
environment, which nothing running can write, and the setter can only reach
per-guild columns. One key space to the operator, two sources underneath.

`log routing set|off|exclude|unexclude` is the WP4 §5 gap closed: those two
tables have had no writer since WP4 shipped.

### 13e — write commands that reach Discord

`panel sync`, `undo`, `adoption allow`. All three go through the existing effect
gateway unchanged — kill switch, breaker, hierarchy, rate cap and dry-run all
still apply. `adoption allow` calls `RateLimiter.grantAllowance`, which is
**in-memory, per-process** (`packages/core/src/effects/rate-limit.ts:43`) —
reaching the live daemon's own limiter is precisely what the socket makes
possible and a database-writing CLI could not do.

Needs **ADR 0026** first. The CLI gives up after thirty seconds and rate-capped
reversal is unbounded — a thirty-effect batch is ninety seconds, a 250-reactor
panel is twelve minutes — and a timed-out request does not stop the daemon. So
`undo` and the reconciliation half of `panel sync` enqueue a job and return its
id; only the bounded work (validate, refuse, report the size, post the message,
seed the reactions) happens on the connection.

### 14a — dashboard API, accounts, sessions, bootstrap

Fastify, Argon2id, DB-backed sessions, the bootstrap token, CSRF, lockout,
`bootstrap reissue`. All four tables already exist
(`packages/storage/src/schema.ts:605-701`). New dependencies `fastify` and an
Argon2 implementation are named by ADR 0008 and ADR 0012, so no stop-and-ask.

### 14b — the one page

React + Vite to static files: health, log routing, panel config, audit table,
kill switch. Bound to `127.0.0.1`.

### 15 — `/privacy`

No slash-command support exists at all: `packages/discord/src/events.ts:106`
filters interactions to buttons and string selects only. So 15 adds a
`slashCommand` domain event, command registration, and the feature-state-aware
renderer of `PRIVACY.md` that `docs/19` §6.11 and finding 4 require — a
section describing a subsystem Release 1 does not have renders as *"Not
enabled in this server"*, never as active behaviour.

## 4. ADR 0024 — the decision that has to be made before 13b

**Where does the CLI's capability come from?**

`capability_grants` is keyed by `(guild_id, principal_type, principal_id)`
with `principal_type IN ('user','role')` and a snowflake `CHECK`. A claimed
Unix username is neither. Three candidate answers:

1. Map the claimed Unix user to a Discord user id and check grants for it.
2. Treat reaching the socket as the authorization, record the claimed identity
   for audit only.
3. Add a `unix` principal type.

**Choosing 2**, for two reasons that need writing down rather than assuming:

- *Bootstrap.* A fresh install has zero `capability_grants` rows and the CLI is
  the only thing that could create the first one. A CLI gated on a grant can
  never issue the first grant.
- *Honesty.* Amendment 2 already establishes the claimed identity is not
  kernel-verified. Checking a grant against an unverifiable claim is not a
  control; it is a control-shaped thing that would read as one in review. The
  real access control is the socket's `0660 bananasaurs:bananasaurs-ops`
  permissions, exactly as `docs/17` §2.1 says.

The consequence stated plainly: **the operator CLI is a root-equivalent
surface over that socket.** What limits it is `--confirm`,
`BANANASAURS_READONLY`, secret redaction, and the fact that every write is
audited under a claimed name — not a capability check. ADR 0024 will say so in
those words, and will *not* fold `operator_cli` into the existing
`SYSTEM_ACTORS` set, which exists for a different reason ("authorized by being
wired in"); it gets its own branch and its own comment so the reasoning is not
inherited by accident.

ADR 0012's "Discord Administrator grants nothing" is untouched: it governs
Discord identities and the dashboard, and slice 14 enforces it there.

## 5. Protocol for every slice

Test first for anything touching permissions, idempotency, retention or guild
scope. `npm run typecheck && npm run lint && npm run test`, real output pasted.
Mutations numbered from **108**, restored by file copy. `docs/SESSION_LOG.md`
appended per slice. Commit per slice on `worktree-wp5-operator-cli`. Never
push.

## 6. Known risks

- **Socket tests need a real filesystem path.** Unit tests use a temp dir; the
  pure dispatcher carries the command semantics so socket tests stay thin.
- **`panel sync` has never had a caller** (`docs/21` "Not testable yet at
  slice 6"). Wiring it is the first time `seedPanelReactions` and
  `postManagedPanel` run outside a unit test.
- **Slice 14 is the largest thing in the package** and the only one needing new
  dependencies and a second toolchain.
