# ADR 0020: The composition root scopes subscribers per guild

Status: accepted (2026-08-24)

Written in WP5 slice 6c, when `apps/daemon/src/index.ts` stopped being the WP1 skeleton.

## Context

Everything below the daemon has been built and tested for eleven work packages, but nothing had ever assembled it. The integration tests each wire a `Pipeline`, an `EffectGateway`, the subscribers and a `JobWorker` by hand, against `FakeDiscord` and **one** guild scope. Slice 6c has to do the same thing once, for real, against `BANANASAURS_GUILD_ALLOWLIST` — which is a *list*.

Four things in that sentence are decisions, not details.

### 1. Subscribers are bound to a scope and do not check the guild

`createReactionSubscriber`, `createMemberUpdateSubscriber`, `createInteractionSubscriber` and `createConnectionSubscriber` all close over a `GuildScope` and none of them compares `event.guildId` against it. That is correct for what they are — a `GuildScope` is the partition key, and re-checking it inside every handler is the caller discipline CLAUDE.md rule 2 exists to avoid. But it means **a single `Pipeline` carrying the subscribers of two guilds would deliver guild B's reaction to guild A's panels**, and the panel lookup would happily find nothing, log nothing surprising, and hide the fault.

The allowlist is one guild today. It is a list in the schema, the schema is validated, and "it only breaks with two guilds configured" is exactly the bug that ships.

### 2. `dry_run` lives in the database, and `docs/21` tells the operator to change it with an environment variable

`guilds.dry_run` defaults to 1 and the effect gateway reads it through `readSafetyState`. `BANANASAURS_DRY_RUN` is config. Nothing connected them, so `docs/21` exercise 3 — "Set `BANANASAURS_DRY_RUN=0`. Restart." — would have had no effect at all, and the operator would have watched a correctly-working bot appear to do nothing.

### 3. Migrations are an operator step

`npm run db:migrate` is in `CLAUDE.md`'s command list and in the slice 6 handoff's setup. The daemon has never run migrations itself.

### 4. The composition root is the one part of the system with no test

By construction: it is where the real client, the real database and the real REST port meet. That is also where the whole system is either wired correctly or not at all, and `docs/21` exercise 1 step 2 — leave an unlisted guild — is called "the single most important behaviour in this document".

## Decision

**One `Pipeline`, and every subscriber wrapped in a guild guard.**

```ts
const scopedTo = (guildId: string, subscriber: Subscriber): Subscriber => ({
  name: `${subscriber.name}[${guildId}]`,
  handle: (event) => (event.guildId === guildId ? subscriber.handle(event) : undefined),
});
```

One `Pipeline`, because the allowlist gate, the process-local departed set and the dedupe table are per-*process* concerns and duplicating them per guild would mean N leave calls for one unlisted guild. The guard is what makes that safe: it is four lines, it is tested directly, and it converts "no caller currently mixes guilds" into something the type of the runtime cannot violate.

The `dedupe.firstSight` port routes by `event.guildId` through the same scope map. It is only reached after the allowlist gate, so the scope always exists; a missing one is thrown rather than defaulted.

**`BANANASAURS_DRY_RUN` is written into `guilds.dry_run` at startup, and nothing else is.**

The environment variable wins, on every start, and the daemon logs when it changed the stored value. Dry run is the control `docs/18` calls layer 4 and `docs/21` calls "the control that makes every later exercise safe to attempt"; an operator who sets it in `.env` and restarts must get what they asked for, and a stale database row silently overriding them is the failure mode that matters.

The other tunables — `roleRatePerMin`, `reconcileBudget`, `breakerThreshold` — stay database-owned. They are operational tuning rather than safety posture, their defaults already match the config defaults, and slice 13's CLI is meant to change them without a restart. Syncing them from the environment on every start would make that CLI's writes disappear on the next restart.

**Dispatches are handled one at a time, per guild.**

Found by assembling the daemon, not by reasoning about it. Discord delivers a shard's dispatches in order and discord.js emits them in order, but **nothing awaits a gateway listener** — so a replayed reaction arriving alongside its original has both handlers read "the member does not have this role", and both call `addRole`. The effect gateway cannot collapse them: `trigger_ref` is deliberately part of the idempotency key so that a member toggling a role off and on again is not mistaken for a replay, and two concurrent passes carry two pass ids.

That is CLAUDE.md rule 6 — "a unique constraint that makes double execution impossible" — failing to a race no test could see until something assembled the whole daemon and pushed two packets at it. The fix is a promise chain per guild. Guild rather than global, because guild scope is the partition key everywhere else and two guilds share no state to race over; and it stays affordable because the expensive work — an adoption pass, a reconciliation — is a *job* and does not run on this path at all.

**A cold start records a zero-length gap.**

`docs/21` exercise 4 is "Ctrl-C, react while it is down, restart", and reactions added in that window produced no dispatch at all. A process that was not running cannot know how long it was down, so the gap's duration is recorded as zero — but its *existence* is what enqueues the reconciliation that recovers the window, and that is the part that matters. Overstating the duration would be worse than understating it: the logging module marks gaps as periods it cannot vouch for, and inventing a long one would blank out a period that was actually observed.

**The daemon refuses to start on an unmigrated database instead of migrating it.**

A process that migrates on start is a process that can migrate the *wrong* database on start, and the single-writer guards exist precisely because a misconfigured `BANANASAURS_DB_PATH` is a real failure. The refusal names the command to run.

**`createDaemon` takes its dependencies, and `main()` constructs them.**

`createDaemon({ config, scopes, discord, client, logger, now })` — an opened database, a `DiscordPort`, and a `Client` that has not logged in. `index.ts` is then thin: parse config, open the database, build the real client and the real REST port from it, call `createDaemon`, log in, and install signal handlers.

That signature is what makes the composition root testable without a network: a test passes `FakeDiscord` as the port, a real `Client` that never connects, and an in-memory migrated database, then pushes **raw gateway packets** through `client.actions.*` exactly as the websocket layer does. The assembled system — discord.js's partial handling, the translation layer, the pipeline, the dedupe table, the subscribers, the effect gateway, the audit rows — runs end to end with only the socket missing.

## Consequences

**Exercise 1 step 2 is verified before it is attempted.** An integration test pushes a `GUILD_CREATE` for an unlisted guild through discord.js and asserts a `leaveGuild` call. The live run confirms it against Discord rather than discovering it there.

**A second allowlisted guild is a supported configuration, not a latent bug.** The guard is asserted directly: a subscriber bound to guild A never sees guild B's event.

**Two more things the daemon does not do yet, named so they are not mistaken for oversights.** Nothing enqueues the periodic `reconcileGuild` timer pass (slice 11) or the `sweepEventDedupe` job (its handler exists and is registered, but no schedule creates one). Both need a scheduler this slice does not build; the reconcile-on-gap path, which is what an outage actually needs, is wired and runs.

**Rejected: one `Pipeline` per guild.** Each would carry its own departed set, so one unlisted guild's `GUILD_CREATE` would produce one leave attempt per configured guild.

**Rejected: making the subscribers check `event.guildId` themselves.** That is caller discipline in eleven places instead of one, it is invisible when omitted, and CLAUDE.md rule 2 asks for the opposite.

**Rejected: `createDaemon(config)` constructing its own database and client.** Untestable, and it would put `openDatabase`'s process-global single-open guard inside the unit under test.
