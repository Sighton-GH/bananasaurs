# 0032 — Slash-command registration is a guild-scoped REST call from the composition root, not an effect

Status: accepted
Date: 2026-08-30
Depends on ADR 0014 (packages/core boundaries and who may import the REST port),
ADR 0018 (the REST client refuses rather than retries) and `docs/19` §5 layer 5.
Constrained by `CLAUDE.md` rules 2 (guild scope), 6 (idempotency) and 8.

## Context

Release 1 gained its first slash command, `/status` (ADR 0033). A slash command
does not exist until the bot tells Discord it exists: `PUT
/applications/{app}/guilds/{guild}/commands` with the full command list. Nothing
in the codebase had ever made that call, so this slice had to choose where it
lives.

The default answer in this project is "every Discord side effect goes through
`EffectGateway`". That gateway is why `docs/18`'s blast-radius argument holds,
and routing a new Discord call around it deserves a written reason rather than a
commit message.

## Decision

`registerGuildCommands` lives in `packages/discord/src/rest/commands.ts`, behind
the `@bananasaurs/discord/rest` subpath, and is called by the composition root
(`apps/daemon/src/index.ts`) immediately after `client.login()` resolves. It is
**not** an `EffectGateway` effect, is **not** a `DiscordPort` method, and is
guild-scoped — one `PUT` per allowlisted guild, never the global route.

### Why not the effect gateway

The gateway has seven layers, and registration matches none of them.

| Layer | Why it does not apply |
|---|---|
| Kill switch | Stops the bot acting *on members*. A kill switch that also unregistered `/status` would remove the one command an operator might use to ask why the bot has gone quiet. |
| Dry run | There is no member-visible consequence to withhold. Registering a command changes what Discord's client offers to type, not what happens to anyone. |
| Role rate cap | Budgeted in role mutations per minute. This is one call per guild per process start. |
| Circuit breaker | Counts failures against Discord to stop a runaway. A failed registration is not runaway behaviour; it is a startup diagnostic. |
| Hierarchy check | Compares the bot's highest role against a target role. There is no target and no role. |
| Idempotency by `trigger_ref` | See below — the endpoint is already idempotent. |
| Per-effect audit row | `role_effects` and `effect_batches` describe changes to a member's roles. A command list is neither a member nor a role. |

`CLAUDE.md` rule 6 requires a durable idempotency key for every Discord side
effect. The requirement is satisfied here without machinery, not waived:
Discord's endpoint is a **`PUT` that replaces the whole command set for the
guild**, so the second call and the tenth produce exactly the state the first
did. Minting a `trigger_ref` and a unique constraint would be manufacturing a
property the endpoint already gives for free, and would leave a `role_effects`
row describing something that is not a role effect.

### Why behind `@bananasaurs/discord/rest` rather than the package's main entry

`eslint.config.js` limits importers of `@bananasaurs/discord/rest` to
`packages/core/src/effects` and the composition root, and
`packages/discord/package.json`'s `exports` makes that subpath the only reachable
file path. Together they are `docs/19` §5's fifth layer, and the invariant it
states is *no code outside those two places can cause an authenticated Discord
REST call*.

Registration is an authenticated Discord REST call. Putting it on the package's
main entry — importable from anywhere — would have made that sentence false for
the sake of a shorter import, and the composition root is already permitted to
import the restricted subpath, so nothing is gained by moving it out.

The handoff for this slice named the location as "alongside `createDiscordClient`
and `createDiscordRestPort`", which are in two different entry points. This is
the narrower of the two readings, and it is the one that keeps layer 5 literally
true.

### Why not a `DiscordPort` method

`DiscordPort` exists so `packages/core` can be written without discord.js (ADR
0014). Its methods are the ones `core` calls. No code in `core` registers
commands, and none should: registration is a property of the process's
connection, not of a domain decision. Adding a method would widen the interface
every fake has to implement in order to describe something no domain module
invokes.

### Why guild-scoped, and why a loop

`Routes.applicationGuildCommands(app, guild)` rather than
`Routes.applicationCommands(app)`. Two reasons, one practical and one
structural:

- Guild commands appear immediately; global commands are cached by Discord and
  can take up to an hour to propagate. A command an operator cannot see for an
  hour is indistinguishable from one that failed to register.
- `CLAUDE.md` rule 2 makes guild scope a partition key everywhere. This is the
  one place in the codebase where that discipline is not a database constraint
  but a URL, and the principle still applies: the call names the guild it acts
  on. Release 1 has exactly one entry in `BANANASAURS_GUILD_ALLOWLIST`, and the
  code still loops over the allowlist rather than reading `[0]`, so a second
  guild is configuration rather than a code change.

### Why after `client.login()` resolves, not inside `ClientReady`

Checked against discord.js 14.27.0 rather than guessed. `Client.login()`
(`node_modules/discord.js/src/client/Client.js:216-219`) calls
`this.rest.setToken(token)` **synchronously, before** `await this.ws.connect()`.
So the REST client is authenticated from the moment `login()` is entered, and
registration has no dependency on the gateway reaching READY. `applicationId`
comes from `DISCORD_APPLICATION_ID`, which is configuration, not from
`client.application`, which does not exist until READY.

Awaiting `login()` first is still the right barrier: a rejected `login()` means
Discord refused the token, and firing a REST call with a token we already know is
bad would produce a second, less legible error.

`ClientReady` was rejected as the call site because it fires again on **every
reconnect**. A re-registration per reconnect is repeated requests against the
global rate cap for a set that has not changed, and a flapping connection would
multiply them.

### Failure is logged, not fatal

A failed registration leaves a bot that connects, moderates, logs and serves the
dashboard, but whose `/status` is missing or stale. That is a degraded process,
not a broken one, and `docs/18`'s posture is that the bot's non-AI paths keep
working through peripheral failure. The composition root logs one line per guild
with the outcome and continues.

`doctor` remains the place to ask "is the `UseApplicationCommands` bit granted";
the permission total in `docs/18` (`2416004288`) already includes that bit and is
unchanged by this slice.

## Consequences

- One new module, `packages/discord/src/rest/commands.ts`, reachable only from
  the two directories `docs/19` §5 already permits.
- `RELEASE_1_COMMANDS` is the whole registered set. Because the endpoint replaces
  rather than merges, deleting a command from that array is how a command is
  removed — there is no separate deregistration path to forget.
- A command added to `RELEASE_1_COMMANDS` is registered on the next restart, for
  every allowlisted guild, with no migration and no operator step.
- `EffectGateway` remains the only path to a Discord call that changes a member's
  state, which is the invariant `docs/18` actually depends on.
