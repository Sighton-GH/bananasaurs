# 0072. Conversations, reply chains and retention

Date: 2026-09-24
Status: Accepted (owner approved spec 2026-09-24)

## Context

Each request sends only the current question: nothing stores conversations,
and Discord events carry no reply reference. The owner decided (spec decision
O3) that a message joins a conversation by tag or reply only, with quoted
context when someone replies to another person. Implements spec Part D
section D3 and Part E.

## Decision

- Conversations are stored in `assistant_conversations` and
  `assistant_conversation_turns` (guild-scoped; guild ID in every key and
  index), plus `assistant_conversation_messages`, which maps each Discord
  message ID (member question or bot answer part) to its conversation and
  turn.
- Which conversation a new request belongs to is deterministic; first match
  wins:
  1. The message is a Discord Reply to a bot answer → that answer's
     conversation, whoever is replying.
  2. The message is a Discord Reply to a member message that is already a
     conversation turn, and it tags the bot → that conversation.
  3. The message is a Discord Reply to another person's message that is not
     in any conversation, and it tags the bot → a new conversation whose
     first context item is the replied-to message, quoted as untrusted
     evidence with its author's display name (for example "Quoted message
     from Alex: …"). The bot fetches it through the Discord port, same
     channel only.
  4. The same person tags the bot in the same channel within the follow-up
     window (30 minutes since that conversation's last turn) → continue their
     most recent conversation there.
  5. Otherwise → a new conversation.
- `/ask` works the same way: its answer message ID is recorded, so a Discord
  Reply to it continues that conversation.
- Starting fresh: a message that begins with `new topic` or `new question`
  (after the tag) always starts a new conversation. The dashboard can also end
  a conversation.
- What the model sees: the last 12 turns (about 6,000 characters, oldest
  dropped first) as real `user` / `assistant` messages. Each user turn is
  prefixed with the speaker's display name when more than one person is in the
  conversation. Earlier tool results are not replayed; the stored answers carry
  what was learned. A conversation's first question becomes its title in the
  dashboard.
- Discord side: events gain `referencedMessageId` (from `message.reference`),
  and `OutgoingMessage` gains `replyTo` (message reference,
  `failIfNotExists: false`). Posting as a Reply pings the person asked, and
  nobody else. A conversation only ever continues in the channel where it
  started.
- The Conversations page lists conversations newest first with filters by
  channel, member and behaviour and text search on titles; each conversation
  shows its turns as a transcript with links to History traces and Discord,
  plus End and Delete buttons.
- Auto-delete: "Delete conversations older than [2 months / 6 months /
  12 months / Keep forever]" (default 6 months), measured from last activity.
  A daily durable job deletes expired conversations with their turns, message
  map and traces, and records a count in the audit log. The dashboard forget
  member action also deletes that member's conversation turns.

## Consequences

Members get real follow-ups by reply or by tagging within 30 minutes, and a
quoted reply can bring one outside message in as labelled evidence. Storage
grows with use, bounded by the auto-delete setting the owner chooses.
