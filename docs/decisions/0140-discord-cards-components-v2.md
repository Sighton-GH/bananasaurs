# ADR 0140: Discord system posts become Components V2 cards

Status: accepted 2026-10-10 (owner approved the design spec the same day).

Spec: `docs/superpowers/specs/2026-10-10-ui-ux-overhaul-design.md`. Rules: `docs/28_UI_UX_GUIDELINES.md`.

## Context

Every Discord post the bot makes is a plain `content` string. There is no shared colour, emoji or footer
system, task posts end in a paragraph of boilerplate (`TASK_REPLY_NOTICE`), and the only structured post is
one hand-built embed (`apps/daemon/src/assistant/log-message.ts`). The owner asked for a production-quality
look, chose Components V2 cards, and asked for banana-saur art on member-facing cards.

Facts verified 2026-10-10 (Discord components reference; discordjs.guide "Display Components";
`node_modules`):

- `MessageFlags.IsComponentsV2 = 1 << 15` (32768). With it, `content`, `embeds`, `poll` and `stickers`
  stop working; attachments show only when a component references them.
- **Mentions inside a Text Display ping**, governed by `allowed_mentions` (Discord reference, verbatim:
  "pingable mentions … present in this component will ping and send notifications based on the value of
  the allowed mention object").
- At most **40 components** per message, nested ones included; at most **4,000 characters** across all
  Text Displays.
- A message can be **edited into** V2 by sending the flag with `content`, `embeds`, `poll` and `stickers`
  set to null. Once set, the flag cannot be removed.
- Thumbnail and Media Gallery accept `attachment://<name>` when the file is sent with the message.
- `@discordjs/rest` sends `files: RawFile[]` (`{ name, data, contentType?, key? }`) as multipart.
- discord.js 14.27.0 translates modal submits (`interaction.isModalSubmit()`, `fields.fields`,
  `fields.getTextInputValue`, `fields.getRadioGroup`). It ships Label (18) and Radio Group (21).
- Interaction callback types: 4 reply, 5 deferred reply, 6 deferred update, 7 update message, 9 modal. A
  modal must be the **first** response to an interaction.

## Decision

1. **Two kinds of output.** Assistant answers stay plain Markdown. Everything else the bot posts is a
   Components V2 card, built by one kit.
2. **The kit lives in `packages/core/src/ui/discord/`** and builds plain wire objects with hand-written
   types (numeric `type` literals, the style `core` already uses in `task/components.ts`). `core` gains
   **no** dependency: neither `discord.js` (ADR 0014) nor `discord-api-types`. Every card is built by a pure
   render function from a view model, so it is snapshot-tested without Discord or a database.
3. **Port.** `OutgoingMessage` gains `flags?: number` and `files?: readonly OutgoingFile[]`. Absent, the wire
   output is byte-identical to today. The REST adapter sends multipart when `files` is present, writes
   `attachments: [{ id, filename, description }]` for them, ORs `flags` with the ephemeral bit on interaction
   follow-ups, and on `editMessage` with the V2 flag sends `content: null, embeds: null`. `DiscordPort` gains
   `deferUpdate(guildId, ref)` (callback type 6) and `showModal(guildId, ref, modal)` (callback type 9). A
   new `ModalSubmitEvent` (`kind: 'modalSubmit'`) joins `DomainEvent`; its fingerprint is its interaction id.
4. **Art is attached, never hosted.** Four PNGs live in `apps/daemon/assets/cards/` (rendered by
   `docs/design/card-art/render.py` from the existing brand files): `saur-thumb.png` (160 × 160, 9 KB) and
   `banner-tasks.png`, `banner-digest.png`, `banner-panel.png` (1200 × 240, about 27 KB each). A card names
   its art by key; the daemon attaches the bytes when it sends. No public URL, no CDN URL kept, no new
   outbound destination. Art appears only on member-facing task, reminder, check-in, digest and panel cards.
5. **Task cards refresh by reconciliation.** `task_message_anchors` gains `rendered_version`. On every
   60-second task pass, an anchored card whose `rendered_version` is below the task's `version` is
   re-rendered with `editMessage`, at most 10 edits per guild per pass. Any write from any surface (Discord,
   dashboard, MCP) bumps `version`, so every surface refreshes the card without hooks in each writer. A
   button click also re-renders immediately and records the version.
6. **Old plain-text task posts are converted.** Anchors that existed before this change have
   `rendered_version = 0`. The reconcile pass converts the posts of **open** tasks (not done, not archived)
   into cards, 10 a minute. Done or archived tasks' old posts are left untouched. The owner chose the new
   look, and an open task's post without buttons would be the odd one out.
7. **Task buttons.**
   - **I'm on it** (`bs.task:start:<taskId>:<version>`): deferred update (type 6), then the same authority
     rule as `/task complete` (assignee on the team, or team member for a team task), then
     `setStatus(…, 'in_progress')` with the version as compare-and-swap. The card is edited in place.
     Refusals go privately as follow-ups.
   - **Post update** (`bs.task:update:<taskId>`): shows the modal immediately (type 9) with no permission
     check, because opening a form changes nothing and a live check can exceed Discord's 3-second window.
     Authority is checked on **submit**. A refused submit replies privately and quotes the member's text back
     so nothing typed is lost.
   - The submit records a task report with id `modal:<interactionId>` and schedules an `update` slot. The
     worker posts a compact update card replying to the task card, then schedules the ADR 0112 evaluation
     against that posted message.
8. **MCP parity.** `create_task` and `update_task edit` accept `links`; `get_task` returns them.
   `task_progress record` schedules the same `update` slot, so an MCP update is posted like a button update.
   Its tool description changes from "does not post it" to say it is posted when task posts are on.
9. **Task links.** A new `task_links` table holds up to 5 `(label ≤ 34 chars, https URL ≤ 512 chars)` per
   task, in order. One Zod schema in `core` (`taskLinksSchema`) validates them in HTTP, MCP and the dashboard.
   `updateTask` replaces the list when `links` is given and leaves it alone when it is omitted.

## Deviations from the design spec

- **No `interaction_effects` table.** The spec proposed one for button idempotency. The pipeline already
  records every interaction id in its durable dedupe store (`INSERT OR IGNORE` before any subscriber runs).
  A second click is a different interaction, and the effects are already compare-and-swap (`setStatus` on
  version) or keyed (`recordReport` on `modal:<interactionId>`). A second table would duplicate both.
- **The modal opens without a permission check** (decision 7): the check moves to submit.
- **No task number in the footer.** Tasks are UUIDs. The eyebrow carries the team, and the footer carries
  freshness or one hint.

## Consequences

- One migration: `task_links`, `task_message_anchors.rendered_version`, and the `update` kind in
  `task_nudge_slots.kind`'s CHECK (a table rebuild; that table has no sort-ordered index, so ruling M5-D7
  does not apply).
- A V2 message can never go back to plain text. Converted task posts stay cards.
- Each member-facing card upload adds about 9–37 KB per post.
- Mobile rendering and push-notification preview text are not verifiable from the docs. The owner checks
  them with `npm run smoke:cards` against the test guild. That check does not block the merge.

## Rejected

- **Embeds.** They never ping, they put buttons outside the card, and Discord recommends V2 for new apps.
- **`discord-api-types` in `core`.** Allowed by ADR 0014, but the kit needs about 15 shapes, and
  hand-writing them keeps `core`'s dependency list unchanged.
- **Hooks in every task writer to refresh cards.** There are writers in HTTP, MCP and the gateway, and a
  missed hook would leave a stale card. Reconciling on version is one place and survives restarts.
