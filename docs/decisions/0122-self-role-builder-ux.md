# 0122. Self-granted role builder: emoji picker, live preview, numbered options

Date: 2026-09-30

Status: accepted (owner request 2026-09-30). Amends ADRs 0053 and 0054.

## Context

The owner found the reaction-role form hard to use. Spaces were rejected in the
name, the operator had to invent an option ID, a "label" field made no sense
on a reaction, the emoji box needed a pasted emoji or a snowflake, and the
channel box showed a bare ID with the name printed underneath.

## Decision

1. **Name box**: spaces become dashes, capitals become lowercase, and other
   characters the name rules refuse are dropped as you type.
2. **Option IDs** are numbered by the form (`option-1`, `option-2`, ...) and
   hidden. The counter only counts up, so a removed option's ID is never
   reused. The ID stays in the stored definition as the stable key.
3. **Label** is removed for reaction roles. The shared schema already treats
   it as optional there, so nothing server-side changes. Buttons and dropdowns
   keep it because Discord requires one.
4. **Emoji picker**: a searchable chooser over every Unicode emoji, with skin
   tones, plus the server's custom emoji. Unicode data comes from
   `emojibase-data` (MIT, no runtime code), bundled and loaded on first use as
   its own chunk, so nothing is fetched from a third party. We rejected
   `emoji-picker-element` because it fetches its data from a CDN by default,
   which would add an outbound destination. The picker returns the same value
   the old text box held (Unicode characters, or a custom emoji snowflake), so
   `emojiKey` handling is unchanged.
5. **Custom emoji list**: `GET /api/guild/emojis`, behind `panels.manage`,
   reads the guild's emoji over REST from the one configured guild. Its image
   URLs point at Discord's CDN and are loaded by the operator's browser, the
   same way Discord itself shows them. The daemon makes no new outbound call
   beyond the existing Discord API.
6. **Live preview**: the existing message check (`GET
   /api/guild/channels/:channelId/messages/:messageId`) also returns the
   message's author name and text (at most 2000 characters), read from the
   same live fetch. The form draws that message with the chosen reactions
   beneath it, or the buttons / dropdown of a role panel.
7. **Channel picker**: a chosen channel shows `#name (id)` in the box. This is
   shared with the logging, automod, search and task pages, so they behave the
   same way.

## Consequences

- One new dashboard dependency, `emojibase-data` (MIT). It is data only and is
  never loaded until a picker opens.
- The message text is shown only to an operator holding `panels.manage`, for
  a channel in the configured guild, and is not stored or logged.
- Dropping the manual emoji field means a pasted custom emoji ID is no longer
  possible. The picker lists every custom emoji the guild has, which is the
  only place an ID could validly come from.
