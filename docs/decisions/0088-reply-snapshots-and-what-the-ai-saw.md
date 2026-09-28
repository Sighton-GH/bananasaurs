# 0088. Reply snapshots and the "What the AI saw" panel

Status: accepted (implements docs/23 slice 2, owner decision D9). Extends ADR 0076 (traces).

## Context

D9 asks for a full snapshot of what each reply's model saw, deleted with the conversation. The web UI must show clearly what context and knowledge the AI used (D8).

ADR 0076 traces already hold most of it:
- every prompt section, with its text;
- model attempts and token usage;
- tool calls;
- guard removals.

Traces are stored as validated JSON, are guild-scoped, are capped at 200 KB, and are deleted with their conversation.

The gaps:
- tool results are cut to a 1,500-character preview;
- nothing records which context blocks were included;
- the Conversations page only links out to History.

## Decision

1. **Full tool results.** Each tool call stores its whole result text as the model received it: redacted, escaped, and at most the tool's own cap, with a maximum of 6,000 characters. It no longer stores a 1,500-character preview. `capTrace` still bounds the whole trace. The field stays named `preview` for stored-row compatibility; its doc comment says it is the full result.
2. **Included blocks.** Each trace gains `included`:
   - `snippetChunkIds`: the pre-retrieved evidence chunks;
   - `quote`: whether a quoted message was present;
   - `historyTurns`: the number of replayed turns;
   - `toolsOffered`: from the G3 work.

   Later slices add `channelMessages` (slice 3) and `summaryVersion` (slice 5) to the same object. The schema field is optional, so old rows still parse, and there is no migration.
3. **"What the AI saw" inline.** On the Conversations page, each bot turn that has a trace gets a collapsible "What the AI saw" panel. It loads that trace and shows:
   - the prompt sections under plain labels (identity and rules, what it can do, club sources, earlier turns, evidence, the member's message);
   - the tools offered and called, with their results;
   - the model and token counts.

   "View details" to History stays.
4. **Disclosure.** `PRIVACY.md` says that reply snapshots can hold copies of club-source text, quoted messages, and, once slice 3 lands, channel messages that are later deleted from Discord. Snapshots are deleted with their conversation (the existing retention setting) and when a member is forgotten (ADR 0085 addendum).

## Consequences

- Traces grow toward the 200 KB cap sooner; `capTrace` shortens the largest fields first.
- The owner can see why an answer went wrong from the conversation itself. The reminder refusal on 2026-09-28 needed a round trip to see the prompt; now it is one click.
