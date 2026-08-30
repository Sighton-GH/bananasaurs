**Status:** DRAFT — ready to hand off. `/privacy` is dropped from Release 1 (Discord doesn't require a privacy policy below 100 servers, and Bananasaurs serves one). Slash-command infrastructure is still worth building, validated against a real command — `/status` — rather than left inert. `/status` is open to any guild member, no capability gate (Bryan's call).

# WP5 slice 15 (revised) — slash-command support, validated by `/status`

## Contents

- [What changed from the original draft](#what-changed-from-the-original-draft)
- [Decision I need from you](#decision-i-need-from-you)
- [Model and effort](#model-and-effort)
- [Branch](#branch)
- [Setup](#setup)
- [Read first, in this order](#read-first-in-this-order)
- [What you are building](#what-you-are-building)
- [Settled — do not re-litigate](#settled--do-not-re-litigate)
- [Things that will bite you](#things-that-will-bite-you)
- [Protocol](#protocol)
- [Security](#security)
- [Finish by](#finish-by)

## What changed from the original draft

The first draft of this handoff built `/privacy`: a feature-state-aware renderer of `PRIVACY.md`, on the reasoning that `docs/19` §6.11 named it as the next slice. Bryan's call: Discord requires a privacy policy only above 100 servers, Bananasaurs runs on one, so that renderer is speculative work for a threshold nowhere in sight — drop it.

The slash-command plumbing underneath it (`DomainEvent` variant, translation branch, registration) is still worth having regardless of what command uses it first, so the slice keeps that half and gets a new reason to exist: `/status`, an ephemeral reply that mirrors what `GET /api/health` already serves — gateway connection, kill switch state, job counts, scheduler lag. Same data, same ports, a different front door. This also means the slice validates the pipeline against something real rather than wiring it to nothing.

`docs/19_RELEASE_0_1_PLAN.md` §6.11 and `PRIVACY.md` are no longer required reading for this slice. Leave `PRIVACY.md` alone.

## Decision — resolved

**`/status` is open to any guild member, no capability check.** The dashboard's `GET /api/health` requires `config.read` because a dashboard session is a bearer credential over a network port and every route there is gated with no exceptions; a slash command instead arrives with the caller's real Discord identity attached, and the data itself (bot connected? kill switch on? job counts?) isn't secret the way an audit trail or config values would be. Still write the ADR recording this — it's a real authorization decision, not a default, even though it's now settled.

## Model and effort

**Opus, high effort**, single session. Unchanged from the original draft's reasoning: there's no existing slash-command scaffolding anywhere in the repo to follow, so the domain event, translation branch, and registration are "invent the pattern" work (ADR 0022 §3/§5). `/status`'s own logic is closer to Tier B (it's the dashboard's `/api/health` route with a different transport) — don't split the session over that difference; the plumbing is still the bulk of the work and still Tier A.

## Branch

```bash
git fetch origin
git checkout main
```

WP5 slice 14 (both halves) is merged to main. Start from main and call `EnterWorktree` with a name that doesn't collide with any retired worktree — `wp5-dashboard`, `wp5-dashboard-page`, `wp5-operator-cli`, `wp5-live-test-fixes`, `wp5-live-test-report`, `wp4-logging`, `wp3-role-panels`, and `clarify-doc21` are all stale or merged. `wp5-slash-commands` is free.

Commit on your new branch only. Never `git push`, never merge, never force.

## Setup

```bash
npm install && npm run build && npm run db:migrate
npm run test
```

**Confirm 1547 tests pass across 68 files before changing anything.** If the count differs, stop and find out why.

Next free ADR number is **0032** (verify with `ls docs/decisions/`). Mutation numbering continues from **232**.

## Read first, in this order

1. `packages/core/src/discord/events.ts`, the `InteractionEvent` shape (`customId`, `values?` — button/select-shaped) and its neighbours, so you can see what a sibling `DomainEvent` variant looks like before adding one.
2. `packages/discord/src/events.ts` around line 106 — `attachGatewayTranslation`'s `InteractionCreate` handler, currently `if (!interaction.isButton() && !interaction.isStringSelectMenu()) return undefined;`. A slash command interaction is silently dropped today, no log, no exception.
3. `packages/core/src/ops/ports.ts` — `OpsPorts.safetyState()` / `.jobCounts()` / `.oldestDueJobAtMs()` and `OpsInstance.gateway()`. This is the entire data `/status` reports; nothing new to query.
4. `packages/http/src/routes/read.ts`, the `GET /api/health` handler (slice 14). `/status` is this same call sequence — `deps.portsFor(scope)`, then `ports.safetyState()`, `ports.jobCounts()`, `ports.oldestDueJobAtMs(now)`, plus `instance.gateway()` — reached from a slash command instead of an HTTP route. Worth reading as the shape to match, not to import from (`packages/discord` cannot reach `packages/http`).
5. `apps/daemon/src/runtime/daemon.ts`, the `portsFor` closure built in slice 14 (`const portsFor = (scope: GuildScope): OpsPorts => …`, keyed on `byGuild.get(scope.guildId)`). The dashboard reaches it via `session.scope`; a slash-command handler needs the same closure, keyed on the interaction's own `guildId` instead — checked against the allowlist the same way the pipeline already does (`allowlist.has(guildId)` in `createDaemon`), not trusted blindly.
6. `packages/core/src/discord/port.ts` — `DiscordPort`'s current method set, so you know what's missing for command registration and where it would slot in.
7. ADR 0014 (packages/core boundaries) and `eslint.config.js`'s `boundaryRules` for `packages/discord` and `packages/core/src/effects`. This is what the registration-location decision below has to satisfy.
8. `apps/daemon/src/runtime/doctor.ts:40`, the `UseApplicationCommands` permission-bit check — already part of the verified `2416004288` total in `docs/18`, so no permission change is needed, but `doctor` may be the right place to also confirm command registration actually happened, not just that the bit is granted.
9. `packages/testkit/src/fake-discord.ts`, `emitInteraction` / `wasDeferred` / `wasEphemeral` (around line 346). The harness already has interaction-reply tracking built for buttons; a slash-command test almost certainly extends this rather than inventing new fixture machinery.
10. `docs/09_OWNER_SETUP.md:13` and `docs/21_TESTING_THE_BOT.md:80,103` — the only other slash-command mentions in the doc set, both cosmetic (a setup-flow note and a permission checklist item).

## What you are building

1. **A `slashCommand` (or similarly named) `DomainEvent` variant**, sibling to `InteractionEvent`, carrying command name, interaction id, token, channel/user/guild ids. No existing type to copy from; this is new. Don't design it narrowly around `/status` alone — it should hold up for a second command later without a rework, even though none is speced yet.
2. **A translation branch** in `packages/discord/src/events.ts` that recognises `interaction.isChatInputCommand()` (or equivalent) alongside the existing button/select branch, rather than falling into the current silent drop.
3. **Command registration** — the bot has to tell Discord `/status` exists before anyone can invoke it. A direct REST call, guild-scoped, from a function in `packages/discord` (alongside `createDiscordClient`, `createDiscordRestPort`) called by the composition root (`apps/daemon/src/index.ts`) — **not** through the effect gateway. Reasoning:
   - None of the gateway's seven layers fit — kill switch, dry-run, rate cap, breaker, hierarchy check, idempotency-by-`trigger_ref`, and per-effect audit rows all exist for actions with consequences to a member or a target. Registering a command list has neither.
   - It's already idempotent by nature — Discord's registration endpoint replaces the whole command set per call, so the gateway's idempotency-key machinery would be manufacturing a property that's already there for free.
   - ADR 0014 already sanctions this location: the REST port is importable from exactly two places, the effect gateway and the composition root, and this isn't gateway-shaped work.
   - It does **not** need a `DiscordPort` method — that interface exists so `packages/core` stays discord.js-free, and this code never runs inside `core`.
   - Loop the guild allowlist rather than hard-coding a single guild id, even though Release 1 has exactly one entry — guild scope is a partition key everywhere else in this project (CLAUDE.md rule 2), and this is the one place that discipline isn't a database query but the principle still applies.
   - Not fully settled: the exact call-site timing (right after `client.login()` resolves vs. inside a `ClientReady` handler, the pattern `runDoctor` already uses) depends on discord.js's actual token-vs-gateway-ready sequencing — check that against the real client rather than guessing.
   - Write an ADR recording this placement before implementing it.
4. **The `/status` handler** — receives the domain event, resolves the interaction's `guildId` to a `GuildScope` via the daemon's `portsFor` seam (checked against the allowlist), calls `ports.safetyState()` / `.jobCounts()` / `.oldestDueJobAtMs(now)` and `instance.gateway()`, and replies ephemerally. Open to any guild member — no `authorize()` call, no capability grant needed (decided above).
5. Tests: the translation branch recognises a slash-command interaction and drops it correctly if unrecognised (mirroring the existing button/select coverage); registration is called with the right guild ids; `/status` reports the right data for the right guild and nothing for another guild in the allowlist (the same cross-guild isolation shape slice 14's `daemon.portsFor` test proved).

## Settled — do not re-litigate

- **No `/privacy`, no `PRIVACY.md` rendering, no feature-state-aware renderer.** Out of scope for this slice and for Release 1 generally, per the 100-server threshold. Don't open `PRIVACY.md`.
- **The `UseApplicationCommands` permission bit is already granted and verified** — `docs/18`'s permission total (`2416004288`) includes it, and slice 6's `doctor` check already asserts privileged intents at runtime the same way. Don't touch the permission math.
- **No Discord OAuth, no new outbound network destination** — a slash command reply is a response to an interaction already in hand.
- **`packages/core` cannot reach discord.js or a database handle** (ADR 0014) — `/status`'s data read goes through `OpsPorts`/`OpsInstance`, same as every other `core`-adjacent module.
- **Command registration is a direct REST call from the composition root, not the effect gateway, and is guild-scoped, not global.** Settled above — write the ADR, don't re-argue the placement.

## Things that will bite you

**A slash command interaction has a 3-second ack window.** `/status`'s data read (a couple of port calls against SQLite) should be well inside that, but if it grows, defer first and edit the reply after — the same pattern `FakeDiscord.wasDeferred` already tracks for buttons. Decide this from the harness's existing hooks, not by timing out against a real guild.

**There is no existing `DomainEvent` variant to copy for a slash command**, unlike almost every other slice in this project, which extended an established shape. Build it to hold up for a command with options later, even though `/status` itself takes none.

**`daemon.portsFor` is keyed by `scope.guildId`, looked up in `byGuild` — and `byGuild` is built once, at `createDaemon` construction, from the config allowlist.** A slash command's `guildId` comes from Discord, not from a session the server issued, so it needs the same "is this actually in the allowlist" check the gateway's `isGuildAllowed` already does before it's trusted enough to build a scope from — don't skip that because the dashboard's equivalent path (session-derived scope) already implies it.

**You cannot connect to Discord to test registration end-to-end.** The registration call itself (a REST call listing commands) has no `FakeDiscord` equivalent yet — check whether one needs to be added to the harness, the same way `emitInteraction` was added for interaction replies, before claiming registration is tested.

## Protocol

1. Record consequential choices as ADRs in `docs/decisions/`, numbered sequentially from **0032**, before implementing them. Both the registration-location and the `/status`-is-open decisions are settled *what* to do above, but not yet recorded *why* — that's still your job.
2. Write the test first for anything touching guild scope or command registration.
3. Run `npm run typecheck && npm run lint && npm run test` and paste the real output. Do not report completion on the basis of code you have not run.
4. After each slice, break the implementation deliberately to prove the tests catch it. Number the mutations from **232**. Restore with a file copy, never `git checkout <file>`.
5. Append to `docs/SESSION_LOG.md` after each slice.
6. Commit after each slice, on the branch. Never `git push`.

## Security

You cannot connect to Discord and must not attempt to. Never spawn the `claude` binary from application code.

## Finish by

Stopping when the domain event, the translation branch, registration, the `/status` handler, and the tests are done, tested and committed, and reporting: what you built, the real verification output, the mutation log from 232 with every survivor and what it changed, and the ADR(s) you wrote.

**After this slice**, per Bryan's direction, the next phase is not more feature slices — it's testing the dashboard (slice 14) and other already-built features against something closer to real use, rather than continuing to build ahead. That's a live-testing session, not a code slice, and isn't scoped in this doc.
