# 0054. Panels carry their own message content, and the builder offers reaction roles as a first-class format

Date: 2026-09-20
Status: accepted
Amends: 0053 (which kept the builder to button/select components)

## Context

ADR 0053 shipped the dashboard builder with buttons and select menus only.
Reviewing it against a Carl-bot reaction-role editor, the owner corrected
the product intent (2026-09-20): the feature he knows is **reaction roles**
— a bot-owned Discord message where adding or removing an emoji reaction
adds or removes the mapped role — and he wants both that and the
button/dropdown form, presented plainly, with the whole flow easy to use
without Discord bot terminology. Carl-bot's editor also exposes editable
message content, an allowlist of prerequisite roles, and a role blacklist.

The panel model already is a reaction-role engine: a managed panel with
`component: 'reaction'` posts a bot-owned message, seeds its reactions, and
the interaction pipeline adds and removes roles as members react and
un-react, with hierarchy and permission checks, reconciliation and audit.
What the model lacked was the message body: `renderPanelMessage` had a
content seam but no caller could supply one, because a panel definition had
no content field and no column stored it.

## Decision

1. **A panel carries its message content.** `PanelDefinition` gains an
   optional `content` (trimmed, 1–2000 characters — Discord's limit), stored
   on a new nullable `panels.content` column (migration 0024), and
   `postManagedPanel` / `editManagedPanel` render `panel.content`, falling
   back to the existing default copy when unset. Adopted panels are
   untouched: Bananasaurs does not edit other bots' messages. The field is
   optional rather than required so existing definitions, fixtures and
   config files keep parsing unchanged.
2. **The builder offers both formats, reactions first-class.** The format
   choice is "Emoji reactions" (`component: 'reaction'`, emoji required per
   option, label optional) alongside "Buttons" and "Dropdown". This amends
   ADR 0053's builder exclusion of reaction components; the schema and the
   daemon already supported them, so the change is builder-side. User-facing
   copy names the area "Reaction roles" and the formats plainly, not
   "panel" jargon.
3. **Eligibility gates are builder fields.** `requiredRoleId` (only members
   holding this role can pick up roles) and `blockedRoleIds` (members
   holding any of these cannot) were already in the definition schema and
   the POST body; the builder gains pickers fed by the live role list. They
   are optional and off by default.
4. **No embed composer yet.** `OutgoingMessage` already supports embeds, so
   a later slice is additive; but a full embed builder (title, description,
   colour, fields, images, author, footer) is a large surface whose value is
   decoration, and message content covers the communication need. Recorded
   as a deliberate non-goal the owner can override.

## Consequences

- Creating a panel with content still never publishes; the stored body is
  what the separate publish step posts, and the review step shows it.
- Editing content after publish is still not a dashboard flow; publish
  re-renders from the stored definition, so a later "edit" feature is a
  write to one column plus the existing edit path.
- The CLI's `panel create --definition` accepts the same field with no new
  flag, because the definition file is the schema.
