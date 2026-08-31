# Implementation Plan — Release 2 Moderation-Commands Slice

## Overview

Add the moderation-commands slice of Release 2 to Bananasaurs on branch
`moderation-commands` (off main @ 1a28a12): `/mod timeout|untimeout|kick|
ban|unban|warn|purge|note|evidence|history`, all gated on the existing
`moderation.act` capability, with second-confirmation taps for ban and
purge, a bounded purge running as a durable background job through the
normal ADR 0023 deletion-attribution path, and mod-issued warnings feeding
the same escalation ladder automod strikes feed. Scope excludes: additional
automod predicates, counters, false-positive review tooling, cutover
tracking, protected-principals config beyond ADR 0015, audit-log
reconciliation, per-action capability grants beyond `moderation.act`,
reason templates, anything Release 3+. No AI anywhere; guild ID is a
mandatory partition key; every Discord side effect carries a durable
idempotency key.

Full documents: ADR `docs/decisions/0037-moderation-commands-warnings-purge-and-confirmations.md`,
spec `docs/superpowers/specs/2026-08-31-moderation-commands-design.md`,
task plan `docs/superpowers/plans/2026-08-31-moderation-commands-plan.md`.

## Types

- `ModerationIntent.action`: `'timeout' | 'untimeout' | 'kick' | 'ban' | 'unban'`
  (core `moderation-gateway.ts`).
- `ModCaseActionTaken` += `'warned' | 'note' | 'evidence_added' | 'purged' |
  'purge_refused' | 'purge_failed'`; `ModCaseEscalationAction` += `'ban' |
  'unban'`; `RecordCaseEventInput` += optional `actorId`.
- New: `modPendingActions` Drizzle table + repo types (`putPendingAction`,
  `takePendingAction` — one-shot read-and-delete); `modPurgePayload` /
  `modPurgeCursor` Zod schemas; `checkPurgeBudget` / `PurgeBudgetDecision`;
  `FetchedMessage` + page type on the port; `issueWarn` ports/result;
  `listCasesForMember` read types.

## Files

**New:** `drizzle/0007_*.sql` (generated); `packages/storage/src/repos/mod-pending.ts`
(+test); `packages/core/src/mod/{warn,purge,commands,confirmations,history}.ts`
(+tests); `packages/core/src/mod/purge` job handler `apps/daemon/src/jobs/mod.ts`;
`apps/daemon/src/mod.integration.test.ts`; ADR/spec/plan docs;
`implementation_plan.md`.

**Modified:** `packages/storage/src/schema.ts` (`modCaseEvents.actor_id`,
widened CHECKs, `mod_pending_actions`); `packages/core/src/discord/port.ts`;
`packages/discord/src/rest/port.ts`; `packages/discord/src/rest/port.test.ts`;
`packages/testkit/src/fake-discord.ts`; `packages/core/src/effects/
{moderation-gateway,budget}.ts` (+tests); `packages/core/src/jobs/kinds.ts`;
`packages/storage/src/repos/mod-cases.ts` (+test); `packages/discord/src/
rest/commands.ts` (`MOD_COMMAND`); `apps/daemon/src/runtime/{commands,guild,doctor}.ts`
(+doctor test).

## Functions

- New port methods: `banMember`, `unbanMember`, `bulkDeleteMessages`,
  `fetchRecentMessages` (FakeDiscord + REST implementations + tests).
- Modified: `ModerationActionGateway.applyAction` (new actions; hierarchy
  path for `ban` only among the new ones), `recordCaseEvent` (`actorId`),
  `buildDoctorReport`/`inspectGuild` (required-permission set).
- New core functions: `issueWarn` (ladder-feeding warn), `runPurgeTick`
  (job body: safety check → budget → bulk/one-at-a-time → honest audit rows
  → enqueued `log_message_delete` → `purged` case event), the `/mod`
  subscriber (per-invocation `authorize('moderation.act')`, ephemeral
  responses, 28-day clamp), `handleModConfirmation` (same-moderator check,
  one-shot intent take, execution bound to the preview-minted dedupe key).
- New repo functions: `putPendingAction`/`takePendingAction`,
  `listCasesForMember`.

## Classes

- `ModerationActionGateway` — modified as above; no new classes (the codebase
  favours port interfaces + factory functions; the `/mod` subscriber follows
  `createAutomodSubscriber`/`status-slash` patterns).

## Dependencies

None added (drizzle-kit generate only produces migration `0007`).

## Testing

Test-first for everything touching permissions, hierarchy, idempotency,
retention, or guild scope. Port tests; gateway tests per new action
(owner/hierarchy refusals, no-hierarchy for unban/untimeout, dry run,
replayed claim → `skipped`); mixed-source counter equality + expiry-equality
tests; purge job tests (ceiling, one-at-a-time, budget, honest attribution,
cursor resume across simulated restart); confirmation tests (double-tap
executes once, wrong-clicker refused, expiry); doctor tests; and
`apps/daemon/src/mod.integration.test.ts` end-to-end on FakeDiscord
covering all acceptance scenarios. Gate per task and at the end:
`npm run typecheck && npm run lint && npm run test` all clean; one commit
per task in the automod branch's style.

## Implementation Order

1. Task 0: commit ADR 0037 + spec + plan + this file.
2. Task 1: schema delta + migration 0007 + pending-actions repo.
3. Task 2: DiscordPort ban/unban/bulk-delete/fetch-recent + FakeDiscord + tests.
4. Task 3: ModerationActionGateway ban/unban/untimeout, idempotency claims.
5. Task 4: shared escalation counter — mod warnings feed the ladder.
6. Task 5: bounded purge job (budget, 14-day ceiling, one-at-a-time,
   deletion-attribution path, resume).
7. Task 6: `/mod` slash commands incl. warn, `moderation.act` checks,
   ephemeral responses, registration per ADR 0032.
8. Task 7: confirmation taps for ban and purge.
9. Task 8: case notes + evidence links.
10. Task 9: permission-scoped case history search.
11. Task 10: doctor check for Ban Members / Manage Messages.
12. Task 11: end-to-end FakeDiscord integration tests (refusals as case
    events, confirm-then-execute, double-tap, warn ladder, purge resume).
