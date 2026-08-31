# Moderation Commands Slice — Implementation Plan (Release 2)

> **For agentic workers:** implement task-by-task, in order. Each task is
> test-first, ends with `npm run typecheck && npm run lint && npm run test`
> clean, and is exactly one commit. Steps use checkbox syntax for tracking.

**Goal:** The moderation-commands slice of Release 2 — `/mod timeout`,
`untimeout`, `kick`, `ban`, `unban`, `warn`, bounded `purge` as a durable
background job, case `note`s, `evidence` links, permission-scoped `history`;
confirmation taps for ban and purge; mod warnings feeding the same escalation
ladder automod strikes feed; purged messages in the deletion-attribution
record — all gated on `moderation.act`, all working with no AI configured.

**Architecture:** `/mod` arrives as a `slashCommand` `DomainEvent` and is
handled by a new core subscriber in `packages/core/src/mod/` following the
`status-slash.ts` `SlashResponder` pattern. Member actions go through the
extended `ModerationActionGateway` (ADR 0035's layering, now with
`ban`/`unban`/`untimeout`); purge goes through a durable `mod_purge` job on
the existing `jobs` machinery, deleting only via `DiscordPort` and feeding
every deleted message through the normal ADR 0023 attribution path. Ban and
purge first write a durable pending intent (`mod_pending_actions`) and
render an ephemeral preview with Confirm/Cancel buttons; the idempotency
claim binds to the confirmed intent, not the invocation.

**Tech Stack:** TypeScript (Node 22, strict), discord.js v14 (REST routes
only), better-sqlite3 + Drizzle, Vitest, FakeDiscord. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-moderation-commands-design.md`.
**ADR:** `docs/decisions/0037-moderation-commands-warnings-purge-and-confirmations.md`.

## Global Constraints

- Guild scope everywhere (CLAUDE.md rule 2): every repo function takes
  `GuildScope` first; every new table carries `guild_id`;
  `schema-invariants.test.ts` enforces it.
- Durable idempotency for every Discord side effect (rule 6): gateway claims
  for member actions, `jobs_dedupe` for purge, `event_dedupe` for
  attribution.
- `packages/core` never imports discord.js or `@bananasaurs/storage`
  (ADR 0014, `boundaries.test.ts`); schemas/repos in storage, decisions in
  core, wiring in `apps/daemon`.
- Test first for anything touching permissions, hierarchy, idempotency,
  retention, or guild scope. No exceptions.
- `npm run typecheck && npm run lint && npm run test` clean before any task
  counts as done.

---

### Task 0: ADR, spec, and this plan (docs commit)

- [ ] Files: `docs/decisions/0037-…md`, `docs/superpowers/specs/2026-08-31-moderation-commands-design.md`,
      `docs/superpowers/plans/2026-08-31-moderation-commands-plan.md`,
      root `implementation_plan.md`.
- [ ] Commit: `moderation: ADR 0037 — /mod commands, ladder-feeding warnings, bounded purge, confirmation taps`

### Task 1: Schema — `actor_id`, widened CHECKs, `mod_pending_actions`

**Files:** modify `packages/storage/src/schema.ts` (`modCaseEvents`, new
`modPendingActions` table); migration via `npm run db:generate` (becomes
`drizzle/0007_*.sql`); test-first additions to
`packages/storage/src/repos/mod-cases.test.ts` (CHECK acceptance for the six
new `action_taken` values, `escalation_action` `'ban'`/`'unban`', `actor_id`
round-trip) and a new `packages/storage/src/repos/mod-pending.test.ts`.

**Interfaces:** Drizzle exports `modPendingActions`; `ModCaseActionTaken`
gains `'warned' | 'note' | 'evidence_added' | 'purged' | 'purge_refused' |
'purge_failed'`; `ModCaseEscalationAction` gains `'ban' | 'unban'`;
`RecordCaseEventInput` gains optional `actorId`.

- [ ] Step 1: Write the failing tests (CHECK acceptance + actor round-trip;
      pending-actions insert/read/expire/guild-scope), watch them fail.
- [ ] Step 2: Apply the schema edits; `npm run db:generate`; review the
      generated SQL for the widened CHECKs (SQLite CHECK constraints are
      only enforced on write — the migration must recreate the table or
      rely on drizzle-kit's table-rebuild; read the generated SQL before
      accepting it).
- [ ] Step 3: Extend `mod-cases.ts` types and `recordCaseEvent` for
      `actorId`; implement `packages/storage/src/repos/mod-pending.ts`
      (`putPendingAction`, `takePendingAction` — read-and-delete in one
      `write()` so a confirm is one-shot at the storage layer,
      `peekPendingAction`, guild-scoped throughout).
- [ ] Step 4: `npm run typecheck && npm run lint && npm run test`; commit
      `storage: mod_case_events learns actors and six manual outcomes; mod_pending_actions`

### Task 2: DiscordPort ban/unban/bulk-delete/fetch-recent + FakeDiscord

**Files:** modify `packages/core/src/discord/port.ts` (four methods +
`FetchedMessage` type), `packages/discord/src/rest/port.ts` (REST routes),
`packages/discord/src/rest/port.test.ts`, `packages/testkit/src/fake-discord.ts`.

- [ ] Step 1: Write failing port tests first: `banMember`/`unbanMember`
      happy paths and error mapping; `bulkDeleteMessages` 100-id cap and the
      fake's 14-day refusal; `fetchRecentMessages` pagination (`before`).
- [ ] Step 2: Extend the port; implement the REST routes
      (`Routes.guildBan(guildId, userId)` PUT/DELETE,
      `Routes.channelMessagesBulkDelete(channelId)`,
      `Routes.channelMessages(channelId)` with `before`/`limit` params);
      extend FakeDiscord: `bans` set, `memberBanAdd`/`memberBanRemove`
      audit entries after `AUDIT_LOG_LAG_MS`, bulk-delete ceiling
      enforcement (a `DiscordApiError` with Discord's 400-family code),
      fetch-recent over stored messages newest-first with `nextBefore`.
- [ ] Step 3: Gate; commit `port: banMember, unbanMember, bulkDeleteMessages, fetchRecentMessages`

### Task 3: ModerationActionGateway ban/unban/untimeout with durable idempotency

**Files:** modify `packages/core/src/effects/moderation-gateway.ts` and its
test (test-first).

- [ ] Step 1: Failing tests: `ban` refuses `discord-owner` and
      `role-above-bot` (same hierarchy path as kick); `unban` and
      `untimeout` skip the member fetch entirely (assert
      `fetchMember` was *not* called) but still refuse on killswitch /
      breaker / guild-unknown; dry run records without the REST call for
      every new action; a replayed dedupe key returns
      `{ status: 'skipped', reason: 'already-applied' }` — the claim is
      claimed before the REST call, exactly as today.
- [ ] Step 2: Widen `ModerationIntent.action`; branch the execution block;
      keep the hierarchy block behind an action check
      (`action === 'timeout' || action === 'kick' || action === 'ban'`).
- [ ] Step 3: Gate; commit `moderation: ModerationActionGateway learns ban, unban, untimeout`

### Task 4: Shared escalation counter — mod warnings feed the ladder

**Files:** test-first in `packages/storage/src/repos/mod-cases.test.ts`;
implementation is a new pure helper in
`packages/core/src/mod/warn.ts` (`issueWarn` ports) — the storage layer
needs no new function beyond Task 1's `actorId`.

- [ ] Step 1: Failing tests: interleavings of automod-style
      `openOrResolveCase(countsAsViolation: true)` calls and warn-style
      calls produce identical `violationCount` sequences regardless of
      order (mixed-source equality); `nextEscalationTier` reads the same
      counter (3 → timeout, 6 → kick) no matter which source incremented;
      a warn with `actor_id` and `rule_id = 'manual'` lands in
      `listCaseEvents`; expiry equality pinned (no count decay for either
      source across time).
- [ ] Step 2: Implement `issueWarn(deps)` in core: takes ports
      (`openOrResolveCase`, `recordCaseEvent`, `nextEscalationTier`,
      `moderationGateway.applyAction`, logger, guildId, now), returns
      `{ caseId, violationCount, escalation?: ModerationOutcome }`.
      Escalation dedupe key `mod:<guildId>:warn-escalation:<caseId>:<count>`.
- [ ] Step 3: Gate; commit `moderation: a mod warning feeds the same escalation ladder an automod strike feeds`

### Task 5: Bounded purge — budget, job body, honest attribution

**Files:** `packages/core/src/effects/budget.ts` (+ test):
`checkPurgeBudget`; new `packages/core/src/mod/purge.ts` (constants,
payload cursor types, `runPurgeTick` job body with ports) (+ test);
`packages/core/src/jobs/kinds.ts`: `modPurge` kind + `modPurgePayload`
schema + `modPurgeCursor` schema + `purgeDedupeKey`; handler wiring in
`apps/daemon/src/jobs/mod.ts`; registered in `guild.ts`'s `JobWorker`.

- [ ] Step 1: Failing tests for `checkPurgeBudget` and `runPurgeTick`
      (ports faked): fresh phase bulk-deletes ≤100 under-14-day messages
      and saves the cursor; old phase deletes exactly one message and
      signals requeue; budget refusal deletes nothing; safety state
      refused → `purge_refused` case event, no deletes; every deleted
      message got an honest `audit_events` row (actor = moderator,
      `inferred = 0`) and an enqueued `log_message_delete`; completion
      records one `purged` case event.
- [ ] Step 2: Implement. The tick reads the cursor, pages
      `fetchRecentMessages` from `lastMessageId`, filters > 14 days into
      the old phase, and always requeues (`runAfter` spacing) or completes.
      Job handler in the daemon wires the repos, gateway safety read
      (`guildRepo.readSafetyState` — the same function the automod
      subscriber uses), and the case-event writes.
- [ ] Step 3: A restart-resume test: run half a purge, drop the worker,
      re-`claimNext` on a fresh instance, assert no message is deleted
      twice (cursor honoured).
- [ ] Step 4: Gate; commit `moderation: bounded purge as a durable job through the deletion-attribution path`

### Task 6: `/mod` slash commands

**Files:** `packages/discord/src/rest/commands.ts` (`MOD_COMMAND` with ten
subcommands, moderator `default_member_permissions`, joined into the
registered set); new `packages/core/src/mod/commands.ts` (+ test): a
subscriber handling `slashCommand` where `commandName === 'mod'`, with a
`SlashResponder` (defer ephemeral → respond ephemeral), per-invocation
`authorize('moderation.act')` with role ids from `fetchMember`; wiring in
`apps/daemon/src/runtime/guild.ts`.

- [ ] Step 1: Failing tests (core, FakeDiscord not needed yet — ports
      faked): unauthorized caller → ephemeral refusal, no port moderation
      call; `timeout` clamps 28 days; `kick` refuses on hierarchy and
      records the case event with `actor_id` and refusal reason;
      `untimeout`/`unban` execute without hierarchy; every action records
      target, reason, timestamp, outcome.
- [ ] Step 2: Implement the subscriber and the command definition; wire
      ports in `guild.ts` (repos, gateway, logger, now).
- [ ] Step 3: Gate; commit `moderation: /mod slash commands gated on moderation.act`

### Task 7: Confirmation taps for ban and purge

**Files:** new `packages/core/src/mod/confirmations.ts` (+ test): custom-id
parsing, preview rendering, confirm/cancel handling; extend
`packages/core/src/mod/commands.ts` (ban/purge build pending intents instead
of executing); pending-action repo from Task 1; buttons carried on the
ephemeral follow-up via `OutgoingMessage.components`.

- [ ] Step 1: Failing tests: `/mod ban` executes **nothing** and answers
      with a preview + two buttons; Confirm by the same moderator executes
      the ban through the gateway with the intent's dedupe key and deletes
      the pending row; a second Confirm (replayed dispatch) answers
      "already executed" and calls the gateway once total; Confirm by a
      *different* authorized moderator is refused; Cancel deletes the
      intent and executes nothing; an expired intent answers "expired";
      `/mod purge` confirm enqueues exactly one `mod_purge` job (double-tap
      enqueues one, the dedupe collapses the second).
- [ ] Step 2: Implement. The executing action carries the idempotency key
      minted at preview time — never a new one.
- [ ] Step 3: Gate; commit `moderation: confirm-then-execute for /mod ban and /mod purge, idempotency bound to the confirmed intent`

### Task 8: Case notes and evidence links

**Files:** extend `packages/core/src/mod/commands.ts` (+ test): `note` and
`evidence` subcommands; storage needs nothing new beyond Task 1.

- [ ] Step 1: Failing tests: note lands as `action_taken = 'note'`,
      `rule_id = 'manual'`, `actor_id` set, visible via `listCaseEvents`;
      evidence lands as `evidence_added` with the URL; unauthorized caller
      refused; a note on a member with no open case opens one at count 0
      (non-counting) so the event has a case to hang off.
- [ ] Step 2: Implement; gate; commit `moderation: /mod note and /mod evidence as case events`

### Task 9: Permission-scoped case history search

**Files:** `packages/storage/src/repos/mod-cases.ts` (+ test):
`listCasesForMember(scope, memberId)` (cases newest-first, open first) and
re-use of `listCaseEvents`; `packages/core/src/mod/history.ts` or a
function in `commands.ts` (+ test) rendering the ephemeral history reply.

- [ ] Step 1: Failing repo tests: guild-scoped (another guild's member
      returns nothing), ordering stable, events joined per case. Failing
      core test: `history` without `moderation.act` refused; with it,
      cases + events rendered with actor, outcome, timestamps.
- [ ] Step 2: Implement; gate; commit `moderation: permission-scoped /mod history`

### Task 10: Doctor — Ban Members / Manage Messages required

**Files:** `apps/daemon/src/runtime/doctor.ts` (+ `doctor.test.ts`).

- [ ] Step 1: Failing test: a guild missing `BanMembers` or
      `ManageMessages` is flagged; a guild holding them passes;
      `Administrator` still forbidden.
- [ ] Step 2: Implement (`RELEASE_2_MODERATION_PERMISSIONS` constant unioned
      into the required set); gate; commit `doctor: flag missing Ban Members / Manage Messages`

### Task 11: End-to-end FakeDiscord integration tests

**Files:** new `apps/daemon/src/mod.integration.test.ts`, assembled like
`automod.integration.test.ts` (real repos on a migrated test database +
FakeDiscord + the `guild.ts` wiring helpers).

- [ ] Step 1: The scenarios, each asserting on the durable record:
      1. unauthorized caller → ephemeral refusal, refusal recorded as a
         case event where an action was attempted, nothing on the fake;
      2. owner target → refusal with `discord-owner` recorded as a case
         event, no `banMember` call;
      3. role-above-bot target → refusal, no call;
      4. `/mod ban` confirm-then-execute, and a double-tap on Confirm
         producing exactly one ban;
      5. warn → count 3 → automatic timeout; replay the same warn-escalation
         dedupe key → no second timeout;
      6. `/mod purge` confirm → job runs → fake messages deleted in bulk
         (<14d) and one-at-a-time (older) → every message present in
         `audit_events` with the moderator as actor and an enqueued
         `log_message_delete`; purge resuming across a simulated restart
         (rebuild the worker, no double deletion).
- [ ] Step 2: Fix whatever the integration reveals (wiring gaps go back to
      the owning task).
- [ ] Step 3: Full gate: `npm run typecheck && npm run lint && npm run test`;
      commit `moderation: end-to-end FakeDiscord tests — confirm flow, refusals, warn ladder, purge resume`

---

## Self-Review

**Spec coverage:** §2 data model — Task 1. §3 port surface — Task 2. §4
gateway actions — Task 3. §5 warnings — Task 4. §6 purge — Task 5. §7
confirmations — Task 7. §8 `/mod` surface — Tasks 6–9. §9 history — Task 9.
§10 doctor — Task 10. §11 testing — every task's test-first step plus
Task 11's end-to-end pass, which also covers the roadmap gate items:
hierarchy and permission tests (3, 6, 11), duplicate execution impossible
including double-taps (3, 7, 11), every action records actor/target/reason/
evidence/timestamps/outcome (1, 6, 8, 9, 11), a mod warning demonstrably
advances the same ladder (4, 11), purged messages in the deletion record
(5, 11), and it all works with no AI configured (nothing touches a
provider).

**Known risks flagged, not hidden:** drizzle-kit's migration for widening
CHECK constraints may table-rebuild — the generated SQL is reviewed before
acceptance (Task 1 Step 2). `untimeout` on a member whose fetch fails is
modelled as no-hierarchy; the smoke test will confirm Discord's real
behaviour for a non-member timeout removal (it is not exercised by any
FakeDiscord test beyond the port level).

