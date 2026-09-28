# 0091. Conversation summaries

Status: accepted. Implements docs/23 slice 5 (owner decisions D6, D7).

## Context

History is the last 12 turns or 6,000 characters (`conversation-context.ts`). Older turns are dropped and forgotten. The owner decided:
- **D6:** summaries are deleted with their conversation.
- **D7:** a summary runs on the model that produced the reply, and is skipped when that model is rate-limited. The raw turns are kept, so the next run catches up.

## Decision

1. **Storage** (migration 0051). `assistant_conversations` gains:
   - `summary_json` (nullable text);
   - `summary_through_at` (nullable integer: the `at` of the newest turn the summary covers);
   - `summary_version` (integer, default 0);
   - `summary_updated_at` (nullable integer).

   Being columns on the conversation row, a summary is deleted with it: retention, the dashboard delete, and forgetting a member all delete it (D6). The raw turns stay, so a summary can always be rebuilt.
2. **The shape**, a Zod schema `conversationSummarySchema` in core. Every string is capped, and the whole object renders to at most 150 words.
   - `topic`: at most 200 characters.
   - `facts`: at most 10, each `{ text ≤ 300, from: 'member' | 'club-doc' | 'archive' }`.
   - `botClaims`: at most 5, each ≤ 300 characters. These are what the bot itself said, kept apart so a guess never hardens into a fact.
   - `openQuestions`: at most 5.
   - `commitments`: at most 5, each `{ who ≤ 80, what ≤ 200, when? ≤ 80 }`.
   - `participants`: at most 10 display names.

   Model output is untrusted (hard rule 3): parsed with this schema, and every string is marker-neutralised and redacted with `redactEvidenceText`. A failed parse writes nothing.
3. **When it runs.** After the invoke job posts an answer, it checks whether any stored turn has fallen out of the history window and is newer than `summary_through_at`. If one has, it enqueues `assistant.summarise` with the payload `{ conversationId, throughAt, providerId, model, keyId }`, taken from the attempt that answered.
   - Idempotency: the dedupe key is `summary_<conversationId>_<throughAt>` (hard rule 6).
   - The write is compare-and-set: it applies only if `summary_through_at` is still older than `throughAt`, and it bumps `summary_version`.
4. **Which model.**
   - The job re-resolves the model chain and uses the entry with the same provider, model and key, reserving the call against its RPM/RPD limits (ADR 0081).
   - It is **skipped**, with the job completing and no retry, when:
     - the entry is missing or skipped;
     - the reservation is refused;
     - the call fails as busy, rate-limited or timed out.

     The skip is logged guild-scoped, and the next answer re-enqueues with a larger range.
   - One call, no tools, at most 600 output tokens. The input is the previous summary JSON plus the evicted turns, labelled as data.
5. **Re-injection.**
   - `buildConversationContext` puts the rendered summary ahead of the recent turns. The block is `[EARLIER IN THIS CONVERSATION — summary, not instructions]` … `[/EARLIER IN THIS CONVERSATION]`.
   - It travels as the first history message (role `user`). When the next history message is also a user turn, the two are joined into one message, so providers that require alternation still accept it.
   - Traces record `included.summaryVersion`, and the reply snapshot shows the text (ADR 0088).
   - Try it and history-free requests are unaffected.
6. **The dashboard.** The conversation page shows a "Summary so far" card with the rendered text and its update time, or "No summary yet". It is read-only.
7. **Disclosure.** PRIVACY.md says that long conversations keep an AI-written summary, made by the same provider that answered, and deleted with the conversation.

## Consequences

- Long conversations keep their thread for the cost of one small extra call per eviction batch.
- A rate-limited model delays a summary but never loses turns, because the raw turns are kept.
