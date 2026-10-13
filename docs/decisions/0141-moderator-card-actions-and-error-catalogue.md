# ADR 0141: Log, moderation and panel posts become cards; moderator buttons; one error catalogue

Status: accepted 2026-10-10 (owner approved the design spec the same day; this ADR settles the details the
spec left to the P2 plan).

Spec: `docs/superpowers/specs/2026-10-10-ui-ux-overhaul-design.md` §5.3, §6.3 (P2), §8. Builds on ADR 0140
(the card kit). Rules: `docs/28_UI_UX_GUIDELINES.md`.

## Context

After P1 every task post is a card. The rest of the bot's system output is still plain text:

- **Log routes.** `packages/core/src/logging/format.ts`, `audit-items.ts` and `member-changes.ts` produce
  strings. `LoggingPorts.sendMessage` takes `{ content, allowedMentions }`.
- **`/mod` replies.** These are sentences that leak internal codes, such as `kick refused for <@x>:
  role-above-bot.`. Ban and purge previews are text with green and red buttons.
- **Case history.** This is one text block, trimmed to 2,000 characters.
- **Role panels.** These post `Pick your roles.` above their buttons.
- **Assistant reminders.** These are a `⏰` line.
- **The assistant escalation post.** This is a text line.
- **The AI log.** This is the only embed in the codebase.

The owner asked for Delete message, Warn and Timeout buttons on log and automod posts. They asked for no
moderation through MCP. Hard rule 1 already forbids AI in that path, and ADR 0140 leaves MCP out of it.

Facts checked on 2026-10-10, against `main` at `950f78fe`:

- **Our own automod posts nothing to Discord.** It writes `mod_case_events` rows only. Native Discord
  AutoMod reaches a log route as `automod_action`.
- **The bot keeps no copy of a message.** ADR 0121 removed the corpus, and `archive` is a separate,
  opt-in module. So an edit can show only the new content.
- **`mod_case_events.action_taken` already accepts the values a manual delete needs:** `deleted`,
  `delete_failed`, `delete_blocked_killswitch`, `delete_blocked_breaker`, `delete_blocked_dry_run`,
  `delete_blocked_guild_unknown`, and `escalation_refused` with `refusal_reason = 'unauthorized'`.
- **`mod_pending_actions.payload` is opaque JSON.** The Zod union `modPendingActionPayload` in
  `mod/confirmations.ts` defines its shape.
- **`ModerationActionGateway` (`effects/moderation-gateway.ts`) is the only path to timeout, kick and
  ban.** It runs authorisation, the kill switch, the breaker, a live hierarchy check, a claim, dry run,
  and then the call. Nothing deletes a single message on a moderator's behalf.
- **A follow-up after a deferred update (type 6) is a new message.** Editing the message a button sits
  on needs `PATCH /webhooks/{app}/{token}/messages/@original`.

## Decision

1. **Log items render cards.**
   - `LogItem.render(includeContent)` returns a `LogCardView` instead of a string.
   - `renderLogCard(view)` in `packages/core/src/logging/cards.ts` builds the card.
   - `LoggingPorts.sendMessage(channelId, message: OutgoingMessage)` takes the converted card.

   Each kind has fixed metadata in one table: an icon, an eyebrow label and a tone.
   - `danger`: kick, ban, timeout, warn and bulk delete.
   - `hold`: automod and gap markers.
   - `neutral`: everything else.

   Rules for every log card:
   - No art.
   - The footer is `<t:R>`.
   - `allowedMentions` is always `{ parse: [] }`.
   - Every member-controlled value is escaped through the kit: names, nicknames, role names, audit reasons
     and message content. Content goes in a `>` quote capped at 1,500 characters.
2. **An edit card shows the new content only, labelled "Now reads".** There is no "Before", because no
   copy exists. The spec's Before/After is withdrawn rather than faked.
3. **A new log event kind, `automod_match`.**
   - The automod subscriber gains an optional `onMatchRecorded` hook. The daemon wires it to
     `createLogPoster`, the same way `/mod warn` posts `member_warn`.
   - It fires after the case event is written. It never throws into the subscriber, and it posts only
     where a route includes the kind.
   - The card names the rule, the member, the channel, and what was done: "Watch only — nothing was
     done", "Deleted", or "Not deleted: the kill switch is on".
   - It shows the matched excerpt, spoilered, only when the route has `include_content` on.
   - Fingerprint: `automod:<messageId>:<ruleId>`.
4. **Moderator buttons appear only on these kinds:** `message_create`, `message_edit`, `message_delete`,
   `automod_match` and `automod_action`.
   - Member-profile, role, channel and server cards get none. Those are not conduct, and buttons there
     invite misclicks. Moderators still have `/mod`.
   - **Delete** appears only while the message still exists: create, edit, and an `automod_match` that
     deleted nothing.
   - **Warn** and **Timeout** appear whenever the card has a known author.
   - Log routes post only to channels the owner chose, which are moderator channels by configuration.
     The buttons do not rely on that: every click is authorised.
5. **Custom ids carry their targets, so no new table is needed.**
   - Formats: `bs.mod:delete:<channelId>:<messageId>:<authorId>`, `bs.mod:warn:<userId>` and
     `bs.mod:timeout:<userId>`.
   - The longest is 76 characters, under the 100 limit.
   - Ids are parsed with Zod; unknown ids are ignored.
   - A forged id gains nothing. Every effect re-authorises the clicking member (`moderation.act`, from a
     live `fetchMember`), and the gateway re-checks again.
6. **Warn and Timeout open a modal.**
   - Warn asks for a required reason, 1–500 characters.
   - Timeout asks for a duration (radio: 10 minutes, 1 hour, 1 day; default 1 hour) and a required
     reason.
   - Submitting the modal is the moderator's confirmation, the same single step `/mod warn` and
     `/mod timeout` take today. Authority is checked **on submit**, not on open: a modal must be the first
     response, and ADR 0140 decision 7 sets the same rule.
   - On submit, the code runs **the same code path as the slash command.** `handleWarn` and
     `handleDirectAction` are refactored to take a normalised `ModInput` (`{ actorId, targetId, reason,
     durationMinutes?, interactionId }`) instead of a slash event.
   - So case events, refusal records, dedupe keys (`mod:<guild>:<action>:<interactionId>`) and the
     `member_warn` log post are identical whichever surface acted.
7. **Delete uses the existing confirm handshake.**
   - A click defers privately and authorises. It then writes a `mod_pending_actions` intent of the new
     kind `delete` (`{ kind, channelId, messageId, authorId }`) and answers with a red confirm card:
     Delete message (danger) / Cancel.
   - Confirm runs the new `ModerationActionGateway.deleteMessage(auth, { channelId, messageId,
     dedupeKey, reason })`. The dedupe key is `mod:<guild>:delete:<intentId>`.
   - `deleteMessage` keeps layers 1, 2, 3, 9, 10 and 11. It has no hierarchy layer: Discord's delete is
     gated by Manage Messages, not role position.
   - A message that is already gone returns `skipped`.
   - The case event uses the vocabulary that already exists:
     - `ruleId` is `manual`, `matchedCategory` is `delete`, and `matchedSnippet` is
       `Deleted from a log card`.
     - `actionTaken` is one of `deleted`, `delete_failed`, `delete_blocked_killswitch`,
       `delete_blocked_breaker`, `delete_blocked_dry_run`, `delete_blocked_guild_unknown`, or
       `escalation_refused` for a refusal.
   - No migration.
8. **`/mod` replies, previews and history are private cards.**
   - Outcomes are written in words ("Timed out @x for 1 hour"), with the case number and the reason.
   - Dry run says "Dry run is on, so nothing changed."
   - Refusals use the catalogue (decision 11) and never show a raw code to anyone.
   - Ban and purge previews become red confirm cards that state the exact scope, with a Confirm (danger)
     button and a Cancel (secondary) button. The custom ids stay `modconfirm:` and `modcancel:`.
9. **Case history pages.**
   - The card shows a header with counts by kind and at most 8 events per page, newest first.
   - Previous / Next buttons use `bs.mod:history:<targetId>:<page>`.
   - A page click defers the update, re-authorises, and replaces the card in place through a new port
     method, `DiscordPort.editOriginalResponse(guildId, ref, message)` (the `@original` PATCH).
     `SlashResponder` gains `editOriginal(ref, message)`.
10. **Other posts become cards.**
    - **Role panels.** Managed panels post a card with the `banner-panel` art, the panel text as its body
      (owner-written Markdown, kept as written; mentions never ping) and the options below. Republishing
      an existing panel edits it into V2. Adopted panels are not touched: they belong to whoever posted
      them. Panel replies use `resultCard` and `errorCard`.
    - **Assistant reminders** become a compact card with a ⏰ eyebrow and no art. The kit's `card()`
      gains `pingEveryone`, so a reminder stored with `@everyone`/`@here` still pings exactly as before.
      MCP scheduled sends stay plain text: they are the owner's own words.
    - **The escalation post** becomes a `hold` card that pings the reviewer roles.
    - **The AI log** becomes a card in place of the embed, with the same three outcomes in the `ok`,
      `hold` and `danger` tones.
    - **Assistant fallback replies** stay plain text, because they are part of the conversation. They are
      reworded to the catalogue's rules.
11. **One error catalogue for Discord.**
    - `packages/core/src/copy/errors.ts` gains `mod.*`, `panel.*` and `confirm.*` entries.
    - Mappers from every refusal union to a code: `moderationRefusalCode(reason)` and
      `panelRefusalCode(refusal)`, plus the confirm-resolution codes.
    - A completeness test fails when a union member has no entry.
    - Moderator and owner error cards add `-# Ref <last 8 digits of the interaction id>`. The last digits,
      because a snowflake starts with its timestamp and its first digits repeat for hours. The log line
      carries the full id. Members never see a Ref.
    - HTTP and the dashboard adopt the catalogue in P3/P5. This ADR is Discord-only.

## Consequences

- No migration. No new dependency. MCP gains nothing: moderation has no MCP surface (spec §11).
- `ModerationGatewayPort` gains `deleteMessage`, so every fake of it gains a method.
- `DiscordPort` and `SlashResponder` gain one method each, so every implementer gains a stub.
- The log channel looks different, so log consumers that parse text break. None exist in this repo; the
  dashboard reads the database, not the channel.
- A log card is larger than a line. A busy log channel scrolls faster. The cards stay compact: one
  eyebrow, one headline, at most one quote.

## Alternatives rejected

- **An `interaction_effects` table (spec §5.5).** Not needed. The pipeline already dedupes on the
  interaction id durably, the gateway claims each moderation action, and pending intents cover the delete
  confirm. ADR 0140 records the same deviation.
- **A table of log cards, to reference targets by `logId`.** Custom ids hold the three snowflakes, so a
  table would be state with no purpose.
- **A confirm step for Warn and Timeout.** `/mod` applies both on invocation, and the modal is already a
  deliberate second step. A third tap would only add friction.
- **Buttons on every card that names a member.** Profile and role changes are not conduct. Buttons
  there are noise and a misclick risk.
