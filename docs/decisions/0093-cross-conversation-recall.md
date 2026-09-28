# 0093. Cross-conversation recall

Status: accepted. Implements docs/23 slice 7 (owner decision D4). Depends on ADR 0090 (audience) and ADR 0091 (summaries).

## Owner override of REVIEW §E

REVIEW §E puts "memory extraction automation" after Release 3. The owner decided on 2026-09-27 (docs/23 D4) to build summaries **and** recall in this round. This ADR records that override. It covers only what is below:
- a read-only search over the harness-written summaries (ADR 0091);
- no model-written memories: the owner-reviewed "propose a memory" flow is unchanged.

## Decision

1. **Index.** An FTS5 table, `assistant_conversation_summaries_fts` (migration 0052), holds `guild_id`, `conversation_id` and the rendered summary text.
   - It is maintained by the repo function that writes a summary, and deleted by the same paths that delete a conversation (retention, the dashboard delete, forgetting a member).
   - The migration backfills existing summaries.
   - Every query is guild-scoped (hard rule 2).
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
