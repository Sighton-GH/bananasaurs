# 0092. Upcoming events, channel history, and fewer document tools

Status: accepted. Implements docs/23 slice 6 (§5). Depends on ADR 0089 (the recent-messages port) and ADR 0090 (the audience set).

## Context

The most common question in the owner's sample is "when's the meeting?", and the bot cannot see Discord scheduled events. Channel context (ADR 0089) covers only the last N messages. Six overlapping document tools cause wrong picks (docs/23 research §4): `list_sources`, `search_sources`, `open_resource`, `outline`, `read_chunk` and `refresh_source`.

## Decision

1. **`upcoming_events`** (no arguments; the skill `answer-questions`, read-only).
   - It returns up to 10 items in the next 30 days, soonest first.
   - **Discord scheduled events,** fetched through a new port method `listScheduledEvents` (`GET /guilds/{id}/scheduled-events`; no gateway intent is needed).
     - An event tied to a channel is listed only when that channel is in the audience of the answer channel (ADR 0090).
     - External events (no channel) are listed.
     - Each line reads `name — start (in the club's time zone) — location or #channel`, with the description capped at 200 characters.
   - **Channel reminders** that post in a channel in the audience, one-off or repeating, next occurrence first.
     - Each line reads `reminder text — when — #channel`.
     - Personal reminders (no channel ping) are never listed.
   - All text is untrusted evidence: redacted and neutralised.
   - Try it (no channel) lists external events only, plus reminders for channels the asker can read.
2. **`channel_history`** `{ before?: string, limit?: 1–50 }` (skill `answer-questions`, read-only).
   - It reads the **current channel only**, through the ADR 0089 `fetchRecentMessages` port. It uses the same line format and cleaning as channel context.
   - `before` must be a message id that an earlier result in the same request returned (ADR 0071). The result ends with `Older: before=<id>` and registers that id as a handle. An unknown `before` refuses.
   - Without `before`, it starts just above the channel-context window.
   - It is not available in Try it or when the window setting is 0.
3. **Document tools, six down to four.**
   - `search_sources` `{ query?: string, filter?: string }`: without `query` it lists sources (the old `list_sources`); with `query` it searches as before.
   - `open_resource` `{ resourceId?: string, docId?: string }`, exactly one of the two:
     - with `resourceId` it opens as before and includes the outline of a document-like resource;
     - with `docId` it returns that doc's outline (the old `outline`).
   - `read_chunk` and `refresh_source` are unchanged.
   - `list_sources` and `outline` are removed from the catalogue, the skill map and the tool schemas. A call to a removed name gets the standard unknown-tool refusal.
   - Stored traces keep their old names, so History still renders them.

## Consequences

- "When's the meeting?" is answered from Discord itself, with no stale fact in the prompt.
- There is one extra read-only REST call per `upcoming_events` call. `channel_history` pages at most 50 messages per call, within the loop's call caps.
