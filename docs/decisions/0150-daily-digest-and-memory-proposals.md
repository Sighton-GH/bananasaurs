# 0150. Daily digest and automatic memory proposals

Date: 2026-10-10

Status: accepted (owner decisions D1, D10, 2026-10-10).

## Context

The owner chose automatic memory (D1): once a day the AI summarises that day's conversations, stores the summary for future reference, and drafts memory proposals for owner review. Only the bot's own conversations are read (D10a); reading every channel live stays out as a privacy and cost change. Hard rule 1 governs: the model drafts, deterministic code stores, and only the owner approves what becomes memory.

## Decision

1. A new time-bucketed job kind, `assistant_daily_digest`, runs once per guild per local day (04:00 in `BANANASAURS_TIME_ZONE`, hourly timer tick, bucket key `assistant_daily_digest:<YYYY-MM-DD>` enqueued with `oncePerBucket`, ADR 0127), so a restart or a replay cannot run it twice.
2. Input is that day's turns from `assistant_conversation_turns`, grouped by conversation with the existing rolling summaries, capped at 40,000 chars (instance setting `assistant.digestInputChars`), split into chunks if larger. The same evidence framing, `redactEvidenceText` and outbound scan as every provider call apply. It runs on the guild's normal model chain ordered by Slice 6's `orderChainByTier` with the tier from the service accessor `backgroundTier('daily-digest')` (instance setting `assistant.routerDailyDigestTier`, default `light`); it never calls `routeRun`, and its `routed` run event carries reason `background-tier`.
3. Output is validated by Zod like any form: `daySummary` (at most 300 words) and `memoryProposals[]` (at most 10, each with text, why, and source conversation ids). Proposals enter the existing memory-proposal queue (`assistant_decisions`, kind `memory`, provenance `daily-digest`) via `insertDecisionDraftOnce` with deterministic ids `digest:<day>:<index>`. A proposal duplicating an existing memory or a pending draft is dropped by code using a normalised-text match. Nothing becomes memory without owner approval; the save path is untouched.
4. The summary is stored in a new `assistant_daily_digests` table keyed by guild and day. Retention follows the conversation retention setting (the prune job deletes digest rows older than the window; keep-forever keeps them). `search_conversations` also searches digests, but recall shows a digest only when EVERY conversation it covers is in a channel the asker may search (fail-closed): the summary spans the whole day, so one searchable channel cannot authorise other channels' content. The dashboard lists digests under Conversations and holds the digest controls on the Memory page (spec §4.7).
5. Each run writes a run-ledger entry with source `daily-digest` (CHECK widened; `assistant_decisions` has no source CHECK, so only the runs CHECK changes), so failures show on the dashboard like any other run. Model and parse failures complete without throwing (no job retry); only unexpected errors retry.
6. No new outbound destination: the digest calls the guild's configured providers only.

## Consequences

- About 1–2 model calls per guild per day, after the Pacific midnight quota reset.
- Digest summaries and proposals are club content shown to `audit.read` holders; the provider-training disclosure covers them like any other provider call.
