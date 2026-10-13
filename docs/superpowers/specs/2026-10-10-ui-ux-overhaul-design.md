# UI/UX overhaul — Discord cards and the dashboard

> **DRAFT — awaiting owner review (2026-10-10).** Nothing here is implemented. Each phase below
> gets its own implementation plan after this spec is approved. Companion documents:
> `docs/28_UI_UX_GUIDELINES.md` (the rules every surface follows) and the mockup page
> `docs/design/ui-mockups.html` (self-contained; open it in a browser), also published privately at
> https://claude.ai/artifact/DDJxSkkZoLAZK4bMEsEPyH.

## 1. Why

Every Discord post Bananasaurs makes today is a line of plain text. Task posts are a bold title plus a
paragraph of boilerplate, log posts are one sentence each, mod refusals leak internal reason codes
(`ban refused for <@id>: some-internal-reason.`), and case history is a 2,000-character wall. The
dashboard has a sound base (Tailwind tokens, Radix, a component kit, scope-quoting confirmations) but
reads as unfinished: an `accent` colour used in 13 places that is never defined, hard-coded blues
that break the default theme, 50 hand-styled `<select>`s, raw JSON on four pages, generic field
errors ("Too small."), no crash boundary, and three pages of 1,000–2,000 lines.

The owner wants both surfaces to look and behave like a production application, with errors handled
deliberately end to end, grounded in how established product teams design.

## 2. What the owner decided (2026-10-10)

| Question | Decision |
| --- | --- |
| Discord format | **Components V2 cards** for everything the system posts. |
| Dashboard button on task cards | **No.** Most members cannot open the dashboard. |
| Task content | Cards show the **description** and a **structured link list**. |
| Task links | **Structured**: up to 5 links (label + URL) per task, shown as Discord link buttons. Needs a migration. |
| Task buttons | **I'm on it** and **Post update** only. No Mark done, no Snooze on the card. |
| Moderator buttons | **Delete message, Warn, Timeout** on log and automod cards. No member-history button. |
| Dashboard feel | Refined operator console, **light-first**; dark is the alternative theme. |
| Audience | **The owner plus a few execs/mods** with limited accounts. Plain wording matters. |
| First to ship | **Discord task posts**, after the shared guidelines. |
| MCP | **Every added task feature is reachable through MCP.** The owner creates and manages tasks from MCP. |
| Flair | **Bananasaurs artwork on Discord cards** (thumbnails and banner strips). |

## 3. Constraints carried in

- **Hard rule 1 — AI is never in the enforcement path.** Moderator buttons are a shortcut into the
  same deterministic `/mod` code. For this reason the moderator buttons get **no MCP equivalent**:
  an MCP call is made by a model, and a model must not warn or time out a member. (`delete_message`
  already exists in MCP for the bot's own posts; that is unchanged.)
- **Hard rule 2 — guild scope.** Every new repository function, idempotency key and job payload
  takes a guild ID.
- **Hard rule 6 — idempotency.** Every button press that has a Discord side effect carries a durable
  key under a unique constraint. A replayed interaction cannot act twice.
- **Hard rule 8 — no new outbound network destinations.** Card art is uploaded with the message as an
  attachment; nothing is hosted publicly and no image URL is fetched from a third party. Fonts are
  bundled in the dashboard build, never loaded from Google Fonts.
- **ADR 0014 — `core` may not import `discord.js`.** Cards are built in `core` as plain wire objects.
  `discord-api-types` (MIT, already installed transitively) may be added to `core` as a type-only
  dependency so the shapes are exact; ADR 0014's forbidden list does not include it.
- **ADR 0043 / 0051 D5 — amber is reserved for state.** It still means "held / waiting". Banana yellow
  appears only in artwork, never as a UI colour.
- **`BRAND.md` usage rules** currently limit the mark to the rail, login, favicon and empty states.
  The owner's flair request extends that to Discord cards; `BRAND.md` is amended in P0.
- **Release scope.** `CLAUDE.md` limits dashboard work to the current release. The owner's request in
  this session is the explicit instruction that widens it for this work.

## 4. Verified facts this design rests on

Checked against `node_modules` and Discord's reference on 2026-10-10:

- `discord.js` 14.27.0 and `@discordjs/builders` 1.14.1 are installed; the builders ship
  `ContainerBuilder`, `TextDisplayBuilder`, `SectionBuilder`, `SeparatorBuilder`.
  `discord-api-types` defines `MessageFlags.IsComponentsV2 = 32768`.
- Components V2 (Discord reference): Container (accent colour, spoiler), Section (1–3 text displays
  plus one Button or Thumbnail accessory), Text Display (Markdown), Thumbnail, Media Gallery (1–10
  items), File, Separator (divider, small/large spacing). At most **40 components** per message. Once
  a message is sent with the flag it **cannot be removed**; `content`, `embeds`, `poll` and `stickers`
  stop working, and attachments are hidden unless a File or Media Gallery shows them. Discord
  recommends V2 for new apps. Modals support Label, Text Input, selects, File Upload, Radio Group,
  Checkbox Group, Checkbox and Text Display.
- Button labels: at most 34 characters with an emoji, 38 without; one primary button per group.
- `OutgoingMessage` (`packages/core/src/discord/port.ts:99`) has `content`, `embeds`, `components`,
  `allowedMentions`, `replyTo`, `poll` — **no `flags` and no files**.
- The REST adapter (`packages/discord/src/rest/port.ts`) **cannot upload files** and only ever answers
  an interaction with `DeferredChannelMessageWithSource` (line 870); it **cannot show a modal**.
- Every interaction handler today defers ephemerally first. A modal must be the **first** response to
  an interaction (within 3 s), so a modal-opening button cannot defer.
- `/mod` authorises through `authorize(…, 'moderation.act')` (`packages/core/src/mod/commands.ts:306`).
  There is no single-message delete in `/mod`; there is `purge`.
- `club_tasks.description` exists (default `''`) and is never shown on a task post. There is no links
  column.
- MCP already covers the task buttons' semantics: `update_task` `set_status` (`in_progress`) and
  `task_progress` `record`.

### 4.1 Unverified — the P0 spike must answer these before P1 starts

1. Does a `<@user>` / `<@&role>` mention inside a Text Display **ping**, honouring `allowed_mentions`?
   (Task posts depend on it.) If not, the card is preceded by a one-line plain message that carries
   the pings — designed as part of the card, not an afterthought.
2. What does the **push notification / channel preview** show for a V2 message?
3. Can an existing **plain-text post be edited into a V2 card** (adding the flag on edit)? This decides
   whether live task anchors are re-rendered in place or left as they are.
4. Does `attachment://` work in a **Thumbnail** and a **Media Gallery** item, and do the attachments
   survive message **edits** without re-uploading?
5. The total text limit across Text Displays (believed to be 4,000 characters).
6. How the cards render on **Discord mobile** (iOS and Android) and in **light theme**.

The spike is throwaway code posting to `TEST_GUILD_ID`; its findings go into the P0 ADR.

## 5. Architecture

### 5.1 The card kit (`packages/core/src/ui/discord/`)

Small, pure, and the only place Discord wire shapes are assembled.

- `kit.ts` — typed constructors for the V2 components this project uses: `container`, `text`,
  `section`, `thumbnail`, `separator`, `gallery`, `actionRow`, `button`, `linkButton`, `select`,
  plus modal pieces `modal`, `label`, `textInput`, `radioGroup`. Each returns a plain object typed
  with `discord-api-types`. No behaviour, no I/O.
- `tokens.ts` — the shared semantic colour table (`tone → 0xRRGGBB`) and the emoji vocabulary
  (`icon('task')`, `icon('overdue')` …). The same tone names exist as dashboard CSS tokens
  (§7.2), so "amber means waiting" is defined once per surface from one list in the guidelines.
- `text.ts` — Markdown-safe helpers: `escape`, `truncate(n, '…')`, `ts(ms, 'R'|'F'|'D')` for
  `<t:…>` timestamps, `mention.user/role/channel`, `subtext`, `jumpLink`. Every user-supplied string
  passes `escape` (today's `safe()`), and every card enforces Discord's limits through `truncate`.
- `budget.ts` — counts components and text length while a card is built and throws a typed error in
  tests if a card can exceed 40 components or the text limit, so limits are caught at build time,
  not in production.
- `art.ts` — the art registry: `{ key, file, width, height, alt }` for each bundled image (§6.5).
  A card that uses art returns the attachment list alongside its components.

Each surface owns a **render function** next to its logic, e.g. `renderTaskCard(view): CardMessage`,
`renderLogCard(event): CardMessage`, `renderModOutcome(outcome): CardMessage`. A `CardMessage` is
`{ components, flags: IsComponentsV2, files?, allowedMentions }`. Render functions are pure and take a
**view model** (already-resolved names, counts, URLs), so they are snapshot-tested without a database.

### 5.2 Port and adapter changes

- `OutgoingMessage` gains `flags?: number` and `files?: readonly OutgoingFile[]`
  (`{ name, contentType, bytes }`). Absent, the wire output is byte-identical to today
  (the same rule `poll` and `replyTo` follow).
- The REST adapter sends `multipart/form-data` when `files` is present and passes `flags` through.
- `InteractionResponder` gains `showModal(ref, modal)` (response type 9) and
  `updateMessage(ref, message)` (type 7, edit the card the button sits on). Modal submissions arrive
  as a new `ModalSubmitEvent` on the existing interaction bus.
- `FakeDiscord` in `packages/testkit` records flags, files and modals so tests assert on them.

### 5.3 Interactions

`customId` keeps the existing `bs.<area>:<action>:<ids>` shape, Zod-parsed, unknown ids ignored.

| Button | customId | First response | Authorisation | Effect |
| --- | --- | --- | --- | --- |
| I'm on it | `bs.task:start:<taskId>:<version>` | defer update | same rule as `/task complete` (assignee or team member) | `set_status in_progress`; card re-renders with "Picked up by @x" |
| Post update | `bs.task:update:<taskId>` | **show modal** (no defer) | same as above, checked on open *and* on submit | records task progress (same path as `task_progress record`); posts the note in the task thread; card shows "Last update <t:R>" |
| Delete message | `bs.mod:delete:<logId>` | defer ephemeral → confirm card | `moderation.act`, checked on click and on confirm | deletes one message through the audited message gateway |
| Warn | `bs.mod:warn:<logId>` | **show modal** (reason) | `moderation.act` on open and submit | same code path as `/mod warn` |
| Timeout | `bs.mod:timeout:<logId>` | **show modal** (duration radio: 10 min / 1 h / 1 day + reason) | `moderation.act` on open and submit; hierarchy check | same code path as `/mod timeout`, through the existing confirm step |

- Every effect is keyed by the **interaction id** in a durable table with a unique constraint
  (`(guild_id, interaction_id)`), so a replayed or double-clicked interaction is a no-op that answers
  with the original outcome.
- A stale card (task version moved on) answers privately: "This card is out of date — the task
  changed since it was posted." and re-renders the card to the current version.
- Refusals are private (ephemeral) cards using the error catalogue (§8). A refused moderator click is
  audited exactly like a refused `/mod` command.
- Moderator buttons appear only on cards posted to **log-route channels** (already moderator-only by
  configuration), and only where they make sense: Delete only when the message still exists
  (automod match, message-edit); Warn/Timeout whenever the card names a member.

### 5.4 MCP parity (owner requirement)

Every task feature this spec adds is reachable from MCP:

| Feature | MCP |
| --- | --- |
| Task links | `create_task` gains `links: [{label, url}]` (≤5); `update_task` `edit` gains `links` (replace the list); `get_task` and `list_tasks` return them |
| Description on the card | already settable via `create_task` / `update_task edit` — no change |
| I'm on it | `update_task` `set_status` `in_progress` (exists); the card re-renders on any status change, whichever surface made it |
| Post update | `task_progress` `record` (exists); recording through MCP also posts the note in the task thread and refreshes the card, exactly like the button |
| Card re-render | automatic on every task write, from any surface (dashboard, MCP, Discord) |

The `bananasaurs_guide` text and `instructions.ts` are updated so the connector describes links.
Moderator buttons have no MCP equivalent (§3).

### 5.5 Data changes

- **Migration (P1):** `task_links (guild_id, task_id, position, label, url)`, primary key
  `(guild_id, task_id, position)`, `position` 0–4, `label` 1–34 chars (the button budget), `url`
  `https://` only, validated by the same Zod schema in HTTP, MCP and the dashboard form. Foreign key to
  `club_tasks` with cascade.
- **Migration (P1/P2):** `interaction_effects (guild_id, interaction_id, kind, outcome_json,
  created_at)`, unique `(guild_id, interaction_id)`, pruned after 30 days by the existing retention
  job.

## 6. Discord surfaces

### 6.1 Two kinds of output

- **Conversation** — assistant answers — stays plain Markdown. It is a voice in the channel and should
  read like one. Its Sources line keeps the `-#` style.
- **System output** — everything else the bot posts — is a card.

### 6.2 Card anatomy (every card)

```
┃ [art thumbnail, member-facing only]
┃ 📋 NEW TASK · Car Team A               ← eyebrow: icon + kind + context (subtext style)
┃ **Wire the brake light harness**       ← title (bold)
┃ Body / description (≤ 6 lines shown)   ← body
┃ Due <t:…:R> · For @maya @leo           ← facts line, timestamps in the reader's zone
┃ ───────────────────────────────        ← separator
┃ [ Wiring diagram ↗ ] [ BOM sheet ↗ ]   ← link buttons (grey)
┃ [ I'm on it ] [ Post update ]          ← actions (≤1 primary)
┃ -# Task #42 · updated <t:…:R>          ← footer: reference + freshness
```

The accent bar colour is the card's **tone** (§7.1). Every card fits in 40 components with room to
spare; the budget check enforces it.

### 6.3 Surface list (what changes)

**P1 — tasks** (`apps/daemon/src/jobs/task-nudges.ts`, `packages/core/src/task/*`)

| Surface | Today | Card |
| --- | --- | --- |
| New task | bold title + boilerplate | full task card with thumbnail, description, links, I'm on it / Post update |
| Review request | one line + Approve/Reject | amber card "Waiting for review", who marked it done, Approve (green Success style) / Send back (grey) |
| Reminder | one line | compact card: title, due `<t:R>`, overdue in red tone, Post update |
| Weekly check-in | one line | compact card listing the member's open tasks (≤5) with due dates |
| Digest | bullet list | banner art + grouped sections: overdue / due this week / done this week |
| Pick prompt | "Which task is this update for?" | private card with one button per candidate task |
| Clarifying question | plain | small neutral card |
| Approve / send back result | edits post to `✅ Approved by…` | the card re-renders to the green "Done" or blue "Sent back" state, buttons removed |
| `/task list` | lines capped at 15 | private card grouped by team, ≤10 tasks, overdue first, "and N more" footer |
| `/task complete` replies | text | private result cards (§8) |
| Boilerplate `TASK_REPLY_NOTICE` | appended to every post | removed; the Post update button replaces it, and a one-line `-#` hint appears only on the new-task card |

**P2 — logs, automod, moderation, panels, reminders, assistant meta**

| Surface | Card |
| --- | --- |
| Log routes (`core/logging/format.ts`, ~12 formatters) | compact cards: eyebrow (icon + event), who, where, `<t:R>`; edit shows Before / After as quoted blocks; deletes show the content and "deleted by @x (inferred)" exactly as today's honesty rule requires; avatar as thumbnail; moderator buttons where §5.3 allows |
| Gap marker | neutral card "Logging paused <t:F> → <t:F> (bot was disconnected)" |
| Automod match (observe) | amber card: rule name, member, channel, matched excerpt (spoilered when the rule says so), "Observe only — nothing was done"; Delete / Warn / Timeout |
| `/mod` outcomes | private result card: action in words ("Timed out @x for 1 hour"), case number, reason; refusals from the catalogue, never raw codes |
| Ban / purge confirmations | red-tone confirm card stating exact scope ("Delete 37 messages from #general, newest 2 minutes ago"), Confirm (danger) / Cancel |
| Case history | paged private card: header with counts by kind, ≤8 cases per page, Previous / Next buttons |
| Warn notice (`formatWarn`) | case card |
| Role panels | banner art, panel title and description, options as select or buttons with emoji; result replies as small private cards |
| Reminders (`reminder-delivery.ts`) | compact card with ⏰ eyebrow, text, "Set by @x"; confirmation card on creation |
| Assistant escalation post | card naming who asked, where, and the question excerpt, with a jump link |
| Assistant AI-log entry | card replacing today's embed, same three tones |
| Assistant errors (`fallback-replies.ts`) | stay plain text in conversation (they are part of the conversation), reworded to the catalogue |
| MCP `send_message` etc. | unchanged: the owner's free-form content is theirs |

### 6.4 Pings

Pings follow today's rules exactly. If the spike (§4.1-1) shows mentions in Text Displays ping
normally, mentions live inside the card. If not, the card is preceded by a single plain line carrying
the pings ("@maya @leo — new task for you"), sent as one message with the card — both are designed in
the guidelines.

### 6.5 Art and flair

- **Thumbnail** (Section accessory, ~160 px): a sized copy of the owner's mark on its light tile.
  Used on member-facing cards: new task, digest, reminder, panel, check-in.
- **Banner strip** (Media Gallery, 1 item, 1200 × 240): original composed art — the transparent
  `bananasaur.png` cut-out, the `leaves.svg` banana crown and a soft tinted ground, in a few
  variants: `banner-tasks` (cream/yellow), `banner-digest` (leaf green), `banner-panel` (navy).
  Used only on low-frequency headline posts: weekly digest, role panels, announcements.
- **No art** on logs, automod, moderation, confirmations or errors. Those are dense and serious, and
  art there is noise.
- Files are bundled in the repo (`packages/discord/assets/cards/`), sized and compressed (thumbnail
  ≤ 25 KB, banner ≤ 80 KB), and **uploaded with each message as an attachment** (`attachment://`).
  No public hosting, no expiring CDN URL kept anywhere, no new outbound destination.
- Every image has alt text (`description`) for screen readers.
- `BRAND.md` gains a "Discord cards" row and the rule "art on member-facing headline cards only".
- Later, optional: application emojis (owner-uploaded, never expire) for a custom icon set.

## 7. Dashboard

### 7.1 Shared tones (Discord and dashboard)

| Tone | Means | Discord accent | Dashboard token |
| --- | --- | --- | --- |
| `neutral` | information, no action needed | slate | `--tone-neutral` |
| `accent` | primary action, links, selected | navy-blue | `--accent` |
| `progress` | in progress, running | blue | `--tone-info` |
| `hold` | waiting, held, observe-only, needs a decision (ADR 0043 amber) | amber | `--tone-hold` |
| `ok` | done, healthy, succeeded | green | `--tone-ok` |
| `danger` | overdue, failed, destructive, moderation action | red | `--tone-danger` |

### 7.2 Theme (light-first)

Palette drawn from the mark. The mockup page shows the proposal; exact values are finalised and
contrast-checked in P3.

- Canvas: warm off-white (a hint of the mark's cream); panels white; lines a warm grey.
- Ink: the mark's navy outline for text; muted ink checked at ≥ 4.5:1 on canvas and panel.
- Accent: one navy-blue for primary buttons, links, focus and selection.
- Status tones as §7.1; each has a `-bg` (tinted fill) and `-ink` (text on that fill) pair.
- Dark theme: the same tokens redefined, not inverted; keeps today's toggle and `prefers-color-scheme`
  behaviour, but light is the default for a first visit.
- Banana yellow appears only in artwork. Amber stays the one "state" colour.

### 7.3 Type, icons, density

- **Inter** (variable, OFL) bundled with the build through `@fontsource-variable/inter`; `tabular-nums`
  for every number column; a mono face (system `ui-monospace`) for IDs and code.
- A type scale replacing today's six sizes with named roles (page title, section title, body, small,
  caption, mono).
- **Icons:** `lucide-react` (ISC). This reverses ADR 0051 D6's "inline SVG, no new runtime deps"
  for icons only; recorded in the P3 ADR. Icons are tree-shaken.
- **Command palette:** `cmdk` (MIT) or a hand-written list on the existing Radix dialog — decided in
  the P4 plan by bundle size.
- Selected shadcn/ui (MIT) component patterns may be copied for Select, Tabs, Dropdown, Tooltip and
  Sheet, built on the Radix packages already installed. Every copied file is recorded in
  `docs/PROVENANCE.md`.
- Density: comfortable by default for the mixed audience; tables use a compact row height.

### 7.4 Foundations (P3)

- **Fix first:** define `--accent`; remove the 15 hard-coded blue/amber/slate classes; make
  `TaskPostsBanner` theme-aware.
- **Missing primitives:** Select, Textarea, Link, Tabs, DropdownMenu, Tooltip, Skeleton, Spinner,
  ProgressBar, InlineAlert, Banner, Kbd, DescriptionList, CodeBlock, KeyValueTable (replaces raw
  JSON), Pagination. Existing Button/Badge/Card/DataTable/Field get the new tokens and states (hover,
  active, focus, disabled, loading).
- **States kit:** `Loading` (Primer thresholds: nothing < 1 s, skeleton/spinner to 3 s, progress
  beyond), `Empty` (illustration + one primary action), `Unavailable` (degraded: says what is missing
  and whether the rest is safe to use), `Forbidden`, `NotFound`, `Stale` ("Updated 4 min ago ·
  Refresh").
- **Crash boundaries:** one around the app, one per route. A crashed page shows what happened, a
  request/trace id, Copy details and Reload; the rail stays usable.
- **Accessibility:** skip link; landmarks; error toasts and alerts announced assertively; focus moves
  to the error summary after a failed submit; visible focus on every control; reduced motion;
  keyboard paths for every table action.

### 7.5 Shell and navigation (P4)

- The rail keeps its groups but renames for the mixed audience and trims to what an account can use
  (it already filters by capability). Proposed groups: **Club** (Overview, Tasks, Role panels,
  Schedules), **Moderation** (Automod, Review, Cases, Members, Logging, Safety, Permissions),
  **Assistant** (Setup, Behaviours, Conversations, History, Skills, Resources, Memory),
  **Messages** (Archive, Search), **System** (Background tasks, Audit, Doctor, Backups,
  Configuration, Accounts, Connected apps). Final names settle in the P4 plan.
- Header: page title, one-line purpose, primary action on the right, breadcrumbs on detail pages.
- **Ctrl/⌘-K command palette:** jump to any page, task, member, case or rule; run the common actions
  (New task, Kill switch).
- The safety-mode link and `StateStrip` become one consistent system banner (Carbon's model).
- Orphaned pages (`stub.tsx`, `assistant-live.tsx`, `what-the-ai-saw.tsx`) are deleted or wired in.

### 7.6 Page sweep (P5)

Ordered by pain. Each page follows one template: header → summary/health → main content → secondary
detail in tabs.

1. **Tasks** list, new, detail, teams — form with sections (What / Who / When / Links), link editor,
   card preview that renders the real Discord card JSON.
2. **AI setup** (`providers.tsx`, 1,968 lines) — split into tabs: Model order, Keys, Web search,
   GitHub; one status summary on top.
3. **Behaviours** (`assistant.tsx`, 1,406 lines) — list → detail page with tabs.
4. **Task detail** (1,052 lines) — summary header, timeline, progress, steps, reminders as tabs.
5. **Doctor, Configuration, History detail, Automod rule** — raw JSON replaced by KeyValueTable,
   CodeBlock with copy, and a structured rule editor (the JSON editor stays behind "Advanced").
6. **Panel builder, MCP, Resources, Permissions, Account edit** — section headers, sticky save bar,
   unsaved-changes guard.
7. Everything else: tables get filter bar + empty state + row → detail; forms get specific errors.

## 8. Errors, end to end

### 8.1 One catalogue

`packages/core/src/copy/errors.ts`: every refusal and failure code the product can produce maps to

```ts
{ code, title, whatHappened, whatToDo, retryable, audience: 'member' | 'moderator' | 'owner', tone }
```

- Discord replies and HTTP responses both read it; the dashboard already renders server-provided
  `title / message / hint`, so it inherits the copy for free.
- **Members** never see codes. **Moderators and owners** see a short reference (`Ref 7F3K`) that finds
  the log line and audit row.
- A test enumerates every refusal union in `core` and fails if any code lacks a catalogue entry.
- Copy follows the guidelines' error rules (GOV.UK and NN/g): what happened, what to do, no blame, no
  "oops", no "invalid", no "please"/"sorry", no jargon.

### 8.2 Discord

- Errors from a button or command are **private** (ephemeral) cards, red or amber tone, to the person
  who acted. Nothing about a failure is posted publicly except where the public card itself must
  change state.
- Partial outcomes say exactly what did and did not happen ("Warned @x. The DM could not be delivered —
  their DMs are closed.").
- Failures the actor cannot fix (bot lacks permission, channel missing) tell the member who to ask and
  raise an owner-visible alert (Doctor + dashboard banner), once per cause, not per occurrence.
- A post the bot could not deliver (channel deleted, permission lost) shows on the task or route in the
  dashboard with the reason and a Retry.

### 8.3 Dashboard

| Situation | Pattern |
| --- | --- |
| Field invalid | inline under the field, specific ("Enter a URL starting with https://"); error summary at top on submit; focus moves to it; input never cleared |
| Write refused (4xx) | inline alert in the form or dialog that made the request, with the catalogue copy and Ref |
| Write succeeded | short toast ("Task created") with Undo where reversible |
| Read failed (part of page) | that section shows Unavailable with Try again; the rest of the page renders |
| Read failed (whole page) | page-level Unavailable with Try again and Ref |
| 401 session expired | re-auth dialog; the page and unsaved input stay |
| 403 | Forbidden state naming the missing permission and who can grant it |
| Network down | global banner "Bananasaurs can't be reached — changes won't save until it's back", auto-clears |
| Bot degraded (provider down, Discord disconnected, kill switch) | global system banner, one per cause |
| Render crash | route crash boundary (§7.4) |
| Long operation | progress (job) with a link to Background tasks; never a spinner past 10 s |

## 9. Testing

- **Cards:** golden snapshot of every card's wire JSON per state; `budget.ts` limit tests; escaping
  tests with hostile names (`@everyone`, Markdown, 2,000-char titles); tone/icon mapping tests.
- **Interactions:** test-first for authorisation (assignee vs non-member vs moderator), idempotency
  (replayed interaction id), stale version, hierarchy refusal, modal open → submit re-check.
- **MCP:** links round-trip through `create_task` / `update_task` / `get_task`; a progress record via
  MCP re-renders the card.
- **Catalogue:** completeness test over every refusal union.
- **Dashboard:** component tests for each new primitive's keyboard/ARIA contract; route tests for
  crash boundary, Forbidden, Unavailable; form tests for error summary and focus.
- **Live:** a `npm run smoke` card gallery that posts every card variant to `TEST_GUILD_ID` for a
  visual check on desktop and mobile, light and dark.
- Gates as always: `npm run typecheck && npm run lint && npm run test`.

## 10. Phases

| Phase | Contents | Migration | Ships independently |
| --- | --- | --- | --- |
| **P0** | Guidelines (`docs/28`), ADRs, V2 spike answering §4.1, card art files, `BRAND.md` amendment | — | docs only |
| **P1** | Card kit, port/adapter (flags, files, modals), task cards, task links (dashboard form + MCP), I'm on it, Post update, `/task` replies, task error copy | `task_links`, `interaction_effects` | yes |
| **P2** | Log/automod cards, moderator buttons, `/mod` replies, confirmations, case history, panels, reminders, assistant meta posts, error catalogue complete | — | yes |
| **P3** | Light-first theme, fonts, icons, primitives, states kit, crash boundaries, a11y fixes | — | yes |
| **P4** | Shell, rail regroup, command palette, system banner | — | yes |
| **P5** | Page sweep in the §7.6 order | — | page by page |

ADR numbers are taken at implementation time (main is at 0135; open branches hold 0136–0139).
Expected ADRs: Components V2 card kit and art delivery (P0/P1); interaction effects and moderator
buttons (P1/P2); error catalogue (P2); dashboard theme, font and icon dependencies (P3).

## 11. Out of scope

- Redesigning assistant answer content (only its error and meta posts change).
- New moderation powers beyond the three buttons; any moderation through MCP.
- Member-facing web pages; the dashboard stays an operator tool.
- Localisation.
- Application emojis (noted as a later option).

## 12. Research grounding

- Discord developer docs — Components reference (V2 types, limits, flag rules, modal components) and
  button design guidance (label lengths, one primary, verb labels).
- Nielsen Norman Group — error-message guidelines (visibility, plain language, constructive remedy,
  preserve input).
- GOV.UK Design System — error message wording and placement (instruction vs description, banned
  words, error summary).
- IBM Carbon — notification pattern (inline vs toast vs actionable vs banner vs modal; use sparingly).
- GitHub Primer — degraded experiences (never hide failure; partial failure in place; ≤5 outage
  messages; never show user content as empty) and loading thresholds (< 1 s / 1–3 s / 3–10 s / > 10 s).
- Linear — UI redesign write-up (theme from base/accent/contrast in a perceptual colour space, reduced
  chrome noise, alignment, staged rollout).
- Vercel Geist — a 10-step neutral scale plus alpha greys as the backbone of a calm console.
- Dyno / Carl-bot documentation — what a moderation case record carries (case number, action, target,
  moderator, reason, time).
