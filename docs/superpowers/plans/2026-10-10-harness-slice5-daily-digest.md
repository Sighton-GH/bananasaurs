# Slice 5: Daily digest and automatic memory proposals — implementation plan

> **Instinct plan.** Read with `2026-10-10-harness-00-instinct-handoff.md` and `2026-10-10-harness-00-shared-contracts.md`.
> **Status:** DRAFT — refreshed by the controller before round 2

**Goal:** Once a day the bot summarises that day's conversations and drafts memory proposals the owner reviews; nothing becomes memory without approval.
**Spec:** docs/superpowers/specs/2026-10-09-assistant-harness-capability-design.md §Slice 5 (5a–5e), decisions D1, D10(a), §4.7
**ADRs:** 0150  **Migration:** daily_digests
**Base:** main @ 0371edc3

## Global Constraints

- `CLAUDE.md` hard rules 1–9 apply. In particular: AI is never in the enforcement path; every query, key and job carries a guild id; model output passes Zod; every Discord side effect has a durable idempotency key; no secrets in code, logs or fixtures; no new outbound destination unless the slice's ADR records the owner's instruction.
- No new dependency.
- Fixtures use invented names (Sam L, Alex P, Car Team A). Never a real member's name or id.
- Canadian English, plain words in prompts and dashboard copy. No tool names shown to members.
- Write the failing test first for anything touching permissions, pings, idempotency, retention or guild scope, and watch it fail before writing the code.
- Slice 5 values (spec §Slice 5, §4.7): the digest runs once per guild per local day at 04:00 in the club's time zone (`BANANASAURS_TIME_ZONE`); input capped at 40,000 chars and split into chunks if larger; `daySummary` at most 300 words; at most 10 memory proposals; one or two model calls per guild per day, after Gemini's midnight-Pacific reset so it never competes with evening chat. Input is the bot's own conversations only (D10a). Proposals enter the existing memory-proposal review queue marked `daily-digest`; nothing becomes memory without the owner's approval; code drops duplicates by normalised-text match. Digest rows follow the conversation retention setting (61/182/365 days, or keep forever). `search_conversations` also searches digests. Each run writes a run-ledger entry with source `daily-digest`.
- Slice 5 runs after Slice 6 merges: the digest runs on the light tier through Slice 6's `orderChainByTier` and an `assistant.digest…` tier setting (contracts §3). This plan is written against today's code (no `tier` on `ChainEntry`, no `orderChainByTier`): every place that plugs into Slice 6 carries an `(after Slice 6: …)` marker and works without it.

## Plan decisions

- `assistant_decisions` has no source CHECK (verified `packages/storage/src/schema.ts:2358-2378`: only kind/status CHECKs; `provenance` is free text), so the migration adds the digest table and widens only `assistant_runs_source`; the `daily-digest` mark travels in `provenance`.
- `assistant.digestEnabled` is a `count` 0/1 setting, not a toggle: the tuning page has no boolean display and its renderer is shared with the UI overhaul, so no new display type.
- A day with no turns still writes a digest row ("No assistant conversations that day") with no model call, so the dashboard shows the run and a replay is a plain no-op.
- Multi-chunk outputs are merged in code (summaries joined, proposals concatenated and capped), not with a second combine call, keeping the 1–2 request budget.
- The digest run's `userId` and each proposal's `requesterId` are the bot application id: both columns carry a snowflake CHECK and no member asked.
- Digest recall hits use `conversationId: "digest:<day>"` and the channel of their first matching conversation; `tools.ts` filters the `digest:` prefix out of `recalledConversationIds` so only real conversations get `recalled` links (FK safety).
- The `queued` run event gains `via: "schedule"`; no new event kind is needed.
- Model and parse failures complete the job without throwing (a failed run entry is written), so a bad model day cannot burn quota across 5 job retries; only unexpected errors propagate to the job retry.
- `assistant.digestTier` (default `light`) ships now; chain ordering goes through a local `orderChainForDigest` passthrough marked `(after Slice 6: replace the body with orderChainByTier(entries, tier))`.
- The local-day bucket key is `assistant_daily_digest:<YYYY-MM-DD>` in `BANANASAURS_TIME_ZONE`, enqueued with `oncePerBucket` (ADR 0127); the timer only enqueues once the local hour reaches the configured hour.
- Digest search is a SQL `LIKE` prefilter plus a JS channel-intersection filter (at most ~365 rows per guild): no new FTS table for one row a day.

## Review Focus

1. **Restart or replay on the same local day runs the digest twice.** Expect exactly one digest row and one proposal set: the timer dedupe key plus `oncePerBucket` refuses the second enqueue even after the first job finished, and the handler returns early when the row exists. Pinned in S5-T7 and S5-T8.
2. **A proposal that restates existing memory or a pending draft.** Expect code to drop it before it reaches the queue, by normalised-text match against both. Pinned in S5-T7.
3. **The model replies with bad JSON.** Expect nothing stored, no queue writes, a failed run entry, and no retry storm. Pinned in S5-T7.
4. **A digest recall leaking a no-access channel.** Expect digest hits filtered to the asker's searchable channels exactly like summary hits. Pinned in S5-T10.
5. **A digest proposal silently becoming memory.** Expect every digest draft stays `draft` until the owner saves it through the existing review path, which this slice does not touch. Pinned in S5-T7.

## Waves

| Wave | Task | Owns (create/modify) | Depends on |
|---|---|---|---|
| 1 | S5-T1: ADR 0150 | Create: `docs/decisions/0150-daily-digest-and-memory-proposals.md` | — |
| 1 | S5-T2: digest pure module | Create: `packages/core/src/assistant/digest.ts`, `packages/core/src/assistant/digest.test.ts` · Modify: `packages/core/src/assistant/index.ts` | — |
| 1 | S5-T3: job kind, payload, lane | Modify: `packages/core/src/jobs/kinds.ts`, `packages/core/src/jobs/kinds.test.ts`, `packages/core/src/jobs/lanes.ts`, `packages/core/src/jobs/lanes.test.ts` | — |
| 2 | S5-T4: migration and digest store | Modify: `packages/storage/src/schema.ts` · Create: `drizzle/` migration (generated), `packages/storage/src/repos/digests.ts`, `packages/storage/src/repos/digests.test.ts` · Modify: `packages/storage/src/index.ts` | S5-T1, S5-T2 |
| 3 | S5-T5: digest settings | Modify: `packages/core/src/settings/instance-settings.ts`, `packages/core/src/settings/instance-settings.test.ts` | S5-T1 |
| 3 | S5-T6: run ledger source | Modify: `packages/core/src/assistant/run-events.ts`, `packages/core/src/assistant/run-events.test.ts`, `packages/storage/src/repos/runs.test.ts` | S5-T1 |
| 4 | S5-T7: digest handler and guild wiring | Create: `apps/daemon/src/jobs/assistant-digest.ts`, `apps/daemon/src/jobs/assistant-digest.test.ts` · Modify: `apps/daemon/src/runtime/guild.ts` | S5-T2, S5-T3, S5-T4, S5-T5, S5-T6 |
| 4 | S5-T8: digest timer and daemon wiring | Create: `apps/daemon/src/runtime/digest-timer.ts`, `apps/daemon/src/runtime/digest-timer.test.ts` · Modify: `apps/daemon/src/runtime/daemon.ts` | S5-T2, S5-T3, S5-T5 |
| 4 | S5-T9: digest retention in the prune job | Modify: `apps/daemon/src/jobs/conversation-prune.ts`, `apps/daemon/src/jobs/conversation-prune.test.ts` | S5-T4 |
| 5 | S5-T10: digests in conversation recall | Modify: `apps/daemon/src/assistant/service.ts`, `apps/daemon/src/assistant/service.test.ts`, `apps/daemon/src/assistant/tools.ts`, `apps/daemon/src/assistant/tools.test.ts` | S5-T4, S5-T7 |
| 5 | S5-T11: digest dashboard API | Create: `packages/http/src/routes/assistant-digests.ts`, `packages/http/src/routes/assistant-digests.test.ts` · Modify: `apps/daemon/src/http/wiring.ts` | S5-T4 |
| 5 | S5-T12: digest dashboard UI | Create: `packages/dashboard/src/components/assistant-digest-list.tsx`, `packages/dashboard/src/components/assistant-digest-settings.tsx`, `packages/dashboard/src/pages/assistant-memory.test.tsx` · Modify: `packages/dashboard/src/pages/assistant-conversations.tsx`, `packages/dashboard/src/pages/assistant-conversations.test.tsx`, `packages/dashboard/src/pages/assistant-memory.tsx` | S5-T5, S5-T11 |
| 6 | S5-T13: STATE.md and PRIVACY.md | Modify: `docs/STATE.md`, `PRIVACY.md` | S5-T1–S5-T12 |

## Tasks

<!-- TASKS -->
