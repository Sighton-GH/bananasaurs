# 0093. Cross-conversation recall

Status: accepted. Implements docs/23 slice 7 (owner decision D4). Depends on ADR 0090 (audience) and ADR 0091 (summaries).

## Owner override of REVIEW §E

REVIEW §E puts "memory extraction automation" after Release 3. The owner decided on 2026-09-27 (docs/23 D4) to build summaries **and** recall in this round. This ADR records that override. It covers only what is below:
- a read-only search over the harness-written summaries (ADR 0091);
- no model-written memories: the owner-reviewed "propose a memory" flow is unchanged.

## Decision

1. **Index** (migration 0052).
   - `assistant_conversations` gains `summary_text` (nullable): the rendered summary, set in the same UPDATE that writes `summary_json`.
   - A hand-written external-content FTS5 table, `assistant_conversation_summaries_fts` over `summary_text`, follows the ADR 0073 pattern of `drizzle/0044_resource_chunks_fts.sql`: insert, delete and update triggers, then `rebuild`. Deleting a conversation row (retention, the dashboard delete, forgetting a member) removes its index entry through the delete trigger.
   - Guild isolation comes from joining back to `assistant_conversations` on rowid with the guild filter. Every query is guild-scoped (hard rule 2).
2. **Tool `search_conversations`** `{ query: string (2–200) }` (skill `search-club`, read-only).
   - It matches summaries of other conversations, never the current one.
   - It is limited to conversations whose channel is in the audience of the answer channel (ADR 0090), intersected with the channels the asker can read. Try it uses the asker's channels only.
   - It returns at most 5 hits, newest first. Each is `#channel, <relative date>: topic — up to three facts`, with no participant names (D3 aggregation) and no bot claims.
   - Hits are untrusted evidence.
3. **The `recalled` link.** When an answer's run called `search_conversations` and got hits, the invoke job links the current conversation to each hit conversation with kind `recalled` (ADR 0089 links table, insert-or-ignore).
4. **The Conversations page:** `recalled` links appear in the Links card as "Looked back at".
5. **Disclosure.** PRIVACY.md says the assistant can look back at summaries of earlier conversations held in channels everyone in the current channel can read, and that there is no opt-out (D5).

## Consequences

- "What did we decide about the robot arm last week?" works across conversations.
- Recall only reads summaries, so it inherits their caps and redaction. Raw turns are never searched across conversations.
