# ADR 0128: Mentions typed into MCP-posted text ping

Status: accepted (2026-10-06)

Amends: ADR 0117 §1 ("Mentions are explicit, never parsed"). ADR 0117 §2–§5
stand unchanged.

## Context

ADR 0117 made `pingRoles` and `pingUsers` the only way an MCP post could
notify anyone: a `<@id>` typed into the text rendered but pinged nobody. In
use, the owner's client writes mentions into the text, as any Discord user
would, and leaves the ping lists empty, so the people named were never
notified. `create_thread` starter messages and `create_forum_post` had no
ping lists at all. The owner asked for MCP messages to ping the members and
roles they mention (owner decision, 2026-10-06: users and roles both).

## Decision

1. **Text mentions ping, through the same policy.** In the text of
   `send_message`, `schedule_message` (and `edit_scheduled`), the
   `create_thread` starter message and `create_forum_post`, a user mention
   (`<@id>` or `<@!id>`) pings that member and a role mention (`<@&id>`)
   pings that role, exactly as if the id had been passed in `pingUsers` /
   `pingRoles`, with the ADR 0117 checks applied live: a user must be a
   current member; a role must pass the ping policy (`below-bot` or
   `allowlist`) and the dangerous-permission floor, and is never managed or
   `@everyone`. Mentions inside inline code or fenced blocks are skipped:
   Discord renders them as text and never pings them.
2. **Text mentions are best effort; explicit pings stay strict.** A named
   ping in `pingRoles` / `pingUsers` that fails a check still refuses the
   whole call (ADR 0117). A text mention that fails a check is not pinged and
   the post goes ahead: the mention renders, nobody is notified for it, and
   the tool result names each id that was not pinged and why. Refusing would
   block a post for quoting a departed member's mention. Best effort also
   covers faults: a membership lookup that fails for any reason but Unknown
   Member reports the mention `member-check-failed` rather than failing the
   post, so a Discord blip never stops a send that needed no lookup before.
3. **Caps are unchanged and shared.** 25 users and 10 roles per message,
   counting explicit pings first. Text mentions beyond the cap are not
   pinged, are reported the same way, and cost no lookup.
4. **`@everyone` and `@here` never ping.** `allowedMentions.parse` stays
   `[]` everywhere; only resolved ids are listed.
5. **Scheduled sends** keep storing only the explicit pings. At delivery the
   text's mentions are merged in and filtered with the stored ones by the
   ADR 0119 §2 delivery-time filter, so an `edit_scheduled` content change
   pings what the new text mentions. Scheduling and content edits report the
   mentions that would not ping as of that moment.
6. **Unchanged:** `edit_message` never pings (Discord does not notify on
   edits, and an edit must not start to). Polls, events and embeds never
   ping. Replies ping their author only with `pingReplyAuthor`.

## Consequences

- An owner who types a mention now notifies that person. The owner is the
  only principal that can post through MCP (ADR 0044) and every post is in
  the action ledger, so this is the owner's own side effect, recorded.
- PRIVACY.md's "Messages the bot posts on the owner's behalf" section says
  which mentions ping.
- The parser is a pure function over the text, and `allowedMentions` only
  filters what Discord itself parses, so an id the parser lists by mistake
  still pings nobody unless Discord sees a real mention of it.
- Quoting a retrieved message into a post now pings the mentions it carries,
  through the same policy. The model has to choose to write the post; a
  retrieved message alone still cannot cause one (CLAUDE.md rule 3).
