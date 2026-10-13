# UI and UX guidelines

> **DRAFT — awaiting owner review (2026-10-10).** Design spec:
> `docs/superpowers/specs/2026-10-10-ui-ux-overhaul-design.md`. Once approved, this document is the
> rulebook: every Discord post and every dashboard page follows it, and a review that finds a
> surface breaking it treats that as a defect.

These rules cover both places people meet Bananasaurs: **Discord**, where every club member sees it,
and the **dashboard**, where the owner and a few execs and moderators run it. The two should feel
like one product: the same words for the same things, the same colours for the same states, and the
same honesty about what happened.

---

## 1. Principles

1. **Say what happened, then what to do.** Every message, success or failure, answers both questions.
   If nothing needs doing, say that.
2. **Members first in Discord, operators first in the dashboard.** A card in a club channel is written
   for someone who has never seen the dashboard. A dashboard page is written for a club lead who is not
   a developer.
3. **Colour means state, never decoration.** Six tones, one meaning each (§4). Brand warmth comes from
   the banana-saur artwork, not from colouring the interface yellow.
4. **Show the scope before the action.** Anything that changes Discord or deletes data states exactly
   what it will touch, in numbers and names, before the person confirms.
5. **Never hide a failure, never fake an absence.** If something did not load, say it did not load. Do
   not render someone's tasks as "No tasks yet" because the request failed.
6. **One way to do each thing.** One button style per role, one place for each kind of message, one
   word per concept. Consistency is what makes a tool feel built rather than assembled.
7. **Calm by default.** Most of the time nothing is wrong. Interfaces stay quiet until something needs
   attention, and then that one thing is obvious.

---

## 2. Voice and words

### 2.1 Voice

Plain, direct, warm, brief. Bananasaurs sounds like a capable club officer: it gets to the point,
doesn't lecture, and doesn't joke about problems.

- **Active voice, present tense.** "Maya picked this up." not "This task has been picked up."
- **Sentence case everywhere** — titles, buttons, headings, menu items. "Post update", not "Post Update".
- **Second person for the reader, first person never.** "You can't edit this task." The bot does not
  say "I" outside assistant answers.
- **Name things by what people recognise.** "Background tasks", not "jobs"; "Role panels", not
  "panels config"; "Reminder", not "nudge slot".
- **No filler.** Cut "please", "simply", "just", "successfully", "in order to".
- **Humour only in empty states and art**, never in errors, warnings or moderation.

### 2.2 Vocabulary

Use the left column. Never show the right column to a member; avoid it in the dashboard unless the
page is literally about that mechanism.

| Say | Don't say |
| --- | --- |
| task | ticket, item, slot |
| due | deadline (in UI), dueAt |
| assigned to | assignee (in Discord) |
| in progress / not started / waiting for review / done | in_progress, awaiting_approval |
| update (a progress note) | report, progress record |
| reminder | nudge |
| moderator | mod (in dashboard headings; fine in `/mod` command names) |
| timeout | mute |
| background task | job |
| couldn't | failed to |
| turned off | disabled (for features a person switched off) |
| observe only | dry run, shadow mode |
| Ref 7F3K | request id, trace id (to members) |

### 2.3 Times, numbers, names

- **Discord:** every time is a Discord timestamp so each reader sees their own zone — `<t:…:R>` ("in
  3 days") for nearness, `<t:…:f>` for exact moments. Due dates show both: "Due Fri 17 Oct
  (<t:…:R>)".
- **Dashboard:** relative time in tables ("4 min ago") with the absolute time and zone on hover and in
  detail views. All numbers in columns use tabular figures.
- **People** are mentions in Discord (`<@id>`) and display names with a small avatar in the dashboard.
  Never show a raw snowflake ID where a name can be resolved; when it can't, say "a former member"
  rather than a number.
- **Counts** are exact under 1,000; "1.2k" above. Zero is a word in prose: "No overdue tasks."

---

## 3. Writing errors

Every error, in Discord or the dashboard, is built from the same three parts. The copy lives in one
catalogue (`packages/core/src/copy/errors.ts`) so the same failure reads the same everywhere.

1. **Title** — what happened, in a few words. "Couldn't time out Maya"
2. **Detail** — why, framed as the system's rule, never the person's fault. "Maya's highest role is
   above the bot's role."
3. **Next step** — what the reader can do, or who can. "Ask a server admin to move the Bananasaurs role
   above Maya's."

Plus, for moderators and owners only: **Ref 7F3K**, which finds the log line and audit row.

### 3.1 Rules

- Be specific. Separate messages for empty, too long, wrong format, not allowed, not found, and
  "something on our side broke".
- **Empty field → instruction:** "Enter a task title." **Wrong value → description:** "Link labels
  must be 34 characters or fewer."
- Reuse the field's own label in its error. A field labelled "Link URL" gets "Enter a link URL that
  starts with https://".
- Never use: *invalid, illegal, forbidden, oops, uh-oh, please, sorry, unfortunately, an error
  occurred, something went wrong* (alone), *failed to*.
- Never blame: not "You entered…", but "The link needs to start with https://".
- Never show internal codes, stack traces or reason enums to members (`some-internal-reason`,
  `hierarchy_violation`). Translate them.
- Say whether anything changed. If nothing did: "Nothing was changed." If part did, list what did.
- Say whether retrying will help. Only offer **Try again** when it can succeed.
- Preserve input. A failed form keeps everything typed; a failed modal reply offers the text back.
- Apologise only for genuine outages on our side, once, briefly: "Bananasaurs is having trouble
  reaching Discord. Your update is saved and will post when the connection is back."

### 3.2 Before and after (real strings from today's code)

| Today | Rewrite |
| --- | --- |
| `ban refused for <@id>: some-internal-reason.` | **Couldn't ban @maya** · The bot can't act on members whose top role is above its own. Ask a server admin to move the Bananasaurs role higher. |
| `Could not update tasks right now. Try again later.` | **Couldn't update the task** · Bananasaurs couldn't save the change. Nothing was changed. Try again in a minute. |
| `Something went wrong running that command. An operator has been notified.` | **That didn't work** · Something broke on our side and nothing was changed. The server owner has been told. Ref 7F3K. |
| `You do not have permission to ban members.` | **You can't ban members** · Banning needs the moderator permission in Bananasaurs. Ask the server owner if you need it. |
| `Too small.` (dashboard field) | Enter a task title. |
| `Not in the right format.` | Enter a link URL that starts with https:// |
| `The request failed` | **Couldn't save the reminder** · Bananasaurs refused the change: the channel no longer exists. Pick another channel. |
| `Bananasaurs could not be reached` | **Bananasaurs can't be reached** · Changes won't save until the connection is back. This message clears itself. |

### 3.3 Where errors appear

| Surface | Situation | Pattern |
| --- | --- | --- |
| Discord | a button or command failed or was refused | private (ephemeral) card, red or amber tone, to the person who acted only |
| Discord | the public card's state is now wrong | the card re-renders; the reason goes privately to whoever acted |
| Discord | the bot can't do its job (missing permission, missing channel) | private card to the actor naming who can fix it; the owner sees one alert in Doctor and the dashboard banner |
| Dashboard | a field is wrong | inline under the field + error summary at the top of the form; focus moves to the summary |
| Dashboard | a write was refused | inline alert in the form or dialog that sent it |
| Dashboard | part of a page failed to load | that section shows "Unavailable" with Try again; the rest works |
| Dashboard | the whole page failed | page-level Unavailable with Try again and Ref |
| Dashboard | system problem (offline, bot disconnected, provider down, kill switch) | one global banner per cause, above the content |
| Dashboard | the page crashed | crash panel with Reload and Copy details; navigation still works |
| Dashboard | no permission | Forbidden state naming the permission and who can grant it |

Toasts are for **brief good news** ("Task created · Undo"). An error never lives only in a toast that
disappears.

---

## 4. Colour and tone

Six tones. Each means exactly one thing on both surfaces.

| Tone | Meaning | Discord card accent | Typical use |
| --- | --- | --- | --- |
| **Neutral** (slate) | information, nothing to do | `0x64748B` | logs, joins/leaves, clarifying questions |
| **Accent** (navy-blue) | the primary thing to do here | `0x2F5BD3` | new task, primary buttons, links, focus |
| **Progress** (blue) | underway | `0x3B82F6` | task in progress, running job |
| **Hold** (amber) | waiting, held back, needs a decision | `0xE0A526` | waiting for review, automod observe-only, safety mode |
| **OK** (green) | done, healthy | `0x2E9A62` | task done, check passed, role granted |
| **Danger** (red) | overdue, failed, destructive, moderation action | `0xD64545` | overdue, timeout issued, delete confirmation, errors |

Dashboard values are final as of ADR 0142 and are checked by
`packages/dashboard/src/theme.contrast.test.ts` in both themes. The Discord accents above are unchanged.
In the dashboard, light amber is `#b8800f` (the proposal's `#c98a12` was 2.95:1 on white).

- **Never colour alone.** Every tone also has a word and an icon ("⚠ Overdue", a red "Overdue" pill),
  so it reads for colour-blind members and in grayscale.
- **Amber is reserved for "held / waiting".** It is never a brand colour and never decoration.
- **Banana yellow appears only in artwork.**
- In the dashboard each tone has three tokens: `--tone-x` (icon, border), `--tone-x-bg` (tinted fill),
  `--tone-x-ink` (text on the fill). Text on any fill meets 4.5:1.

---

## 5. Icons

### 5.1 Discord emoji vocabulary

One emoji per concept, defined in `packages/core/src/ui/discord/tokens.ts`. Don't add a new one in a
render function; add it to the table.

| Concept | Emoji |
| --- | --- |
| task | 📋 |
| due / reminder | ⏰ |
| overdue / warning | ⚠️ |
| in progress | 🔧 |
| waiting for review | 👀 |
| done / success | ✅ |
| sent back | ↩️ |
| update / progress note | 📝 |
| link | 🔗 (link buttons use Discord's own ↗) |
| digest | 🗓️ |
| member joined / left | 👋 / 🚪 |
| message edited / deleted | ✏️ / 🗑️ |
| roles changed | 🏷️ |
| automod match | 🛡️ |
| warning issued | 📣 |
| timeout | ⏸️ |
| ban / kick | 🔨 / 👢 |
| error | ❌ |
| info / hint | 💡 |

Emoji go in the eyebrow and on buttons only — never in the middle of a sentence, never more than one
per line.

### 5.2 Dashboard icons

Pages import icons from src/ui/icons.ts only; ESLint enforces it.

`lucide-react`, 16 px in dense UI and 20 px in headers, stroke 1.75, `currentColor`. An icon never
appears without a visible label except in a toolbar where it has a tooltip and an `aria-label`.

---

## 6. Discord

### 6.1 Two kinds of output

- **Conversation** (assistant answers) is plain Markdown, written like a person talking. No cards.
- **System output** (tasks, reminders, logs, moderation, panels, confirmations, results, errors) is a
  **Components V2 card**.

### 6.2 Card anatomy

```
┃ 📋 NEW TASK · Car Team A                [thumbnail]
┃ **Wire the brake light harness**
┃ Run the harness from the rear bulkhead to both tail lights. Use 18 AWG.
┃ Due Fri 17 Oct (in 7 days) · For @maya @leo
┃ ─────────────────────────────────────────
┃ [ Wiring diagram ↗ ] [ BOM sheet ↗ ]
┃ [ I'm on it ]  [ Post update ]
┃ -# Task #42 · Reply here or use Post update to share progress
```

| Part | Rule |
| --- | --- |
| Accent bar | the card's tone (§4) |
| Eyebrow | `-#` subtext: emoji + KIND in capitals + `·` + context (team, channel, rule). Always present. |
| Title | bold, ≤ 80 characters shown, truncated with … |
| Body | ≤ 6 lines on a channel card; longer text truncates with "…" and the full text lives in the thread or the private detail view |
| Facts line | `·`-separated facts, timestamps as `<t:…>`; mentions here |
| Separator | between content and controls; never two in a row |
| Link buttons | grey, labels from the data (≤ 34 chars), max 5 |
| Action buttons | ≤ 1 primary (Discord's fixed blurple "Primary" style — bots cannot recolour buttons); Approve may use the green "Success" style; destructive actions red ("Danger"); everything else grey ("Secondary"); verbs that name the outcome |
| Footer | `-#` subtext: reference ("Task #42", "Case 118") + freshness or one hint |

### 6.3 Card types

| Type | Used for | Size | Art |
| --- | --- | --- | --- |
| **Headline** | new task, digest, role panel, announcements | full anatomy | thumbnail; banner on digest and panels |
| **Compact** | reminders, check-ins, log events | eyebrow + title/one line + facts | thumbnail on reminders/check-ins only |
| **Result** (private) | what your click or command did | eyebrow + one sentence + optional detail | none |
| **Confirm** (private) | destructive or wide actions | scope statement + Confirm / Cancel | none |
| **Error** (private) | refusals and failures | §3 three parts | none |
| **List** (private) | `/task list`, case history | grouped sections, ≤ 10 rows, pager buttons | none |

### 6.4 Buttons

- Label = the outcome, as a verb: "I'm on it", "Post update", "Approve", "Send back", "Time out",
  "Delete message". Never "OK", "Submit", "Yes".
- At most one primary per card. Destructive buttons are red and always lead to a confirm card or a
  modal — never act on the first click.
- ≤ 34 characters with an emoji, ≤ 38 without.
- A button that opens a form needs no "…"; its label still names the outcome ("Post update").
- A button that leaves Discord is a link button; Discord adds the ↗ itself.
- After a card's state ends (approved, done, deleted), its buttons are removed, not disabled-and-left.

### 6.5 Public vs private

- **Public** only when the channel needs to know: the task itself, its state changes, the digest,
  panels, log events.
- **Private** for everything about one person's action: results, confirms, errors, lists, the pick
  prompt.
- Never post a failure publicly. Never post one member's moderation history publicly.

### 6.6 Pings

- Ping only the people the card is for: assignees on a new task, the reviewer role on a review
  request. Never `@everyone` / `@here`.
- Edits never ping. Reminders ping the assignee once per reminder.
- If cards cannot carry pings (P0 spike), a single plain line above the card carries them:
  "@maya @leo — new task for you".

### 6.7 Cards that change

- A card re-renders in place when its subject changes, from any surface (Discord, dashboard, MCP).
- The footer shows freshness ("updated <t:…:R>").
- A click on an out-of-date card gets a private "This card was out of date — it's been refreshed."
  and the card updates.

### 6.8 Art

- Art appears **only on member-facing headline and compact cards** (tasks, reminders, check-ins,
  digest, role panels). Never on logs, moderation, confirmations, results or errors.
- Thumbnail: the banana-saur mark on its light tile. Banner: composed banana-saur and leaf strips
  (digest, panels, announcements only).
- Art is uploaded with the message as an attachment, never linked from the web.
- Every image has alt text.
- Art never carries information. A card must read completely with images off.

### 6.9 Limits to design within

| Limit | Value |
| --- | --- |
| Components per message | 40 |
| Text across the card | ~4,000 characters (confirmed in the P0 spike) |
| Buttons per row | 5 |
| Link buttons per task | 5 (product limit) |
| Button label | 34 with emoji / 38 without |
| Select options | 25 |
| Modal label | 45; description 100 |

`budget.ts` fails a test if any card can exceed them.

### 6.10 Accessibility in Discord

- Never colour alone (§4). Never emoji alone: "⚠️ Overdue", not "⚠️".
- Alt text on every image.
- Mentions and timestamps instead of hand-written names and times, so screen readers and locales
  handle them.
- Keep each line short; screen readers read the card top to bottom.

---

## 7. Dashboard

### 7.1 Look

A calm, light-first operator console. Warm off-white canvas, white panels, navy ink, one navy-blue
accent, status tones from §4. Dark theme is a full alternative, not an inversion. The banana-saur
appears in the rail, login, empty states and the backdrop, never as UI colour.

### 7.2 Page template

Every page, in this order:

1. **Header** — title, one-line purpose ("Tasks your teams are working on"), primary action on the
   right, breadcrumbs on detail pages.
2. **Status** — only if the page has a health or state worth knowing (a banner or a one-line summary).
3. **Main content** — the list, form or detail.
4. **Secondary detail** — in tabs, never in a scroll that goes on forever.

A page longer than about three screens is split into tabs or sub-pages.

### 7.3 Layout, spacing, type

- Spacing scale: 4, 8, 12, 16, 24, 32, 48 px. Siblings get `gap`, not margins.
- Content max width 1400 px; forms max 720 px; prose max 65 characters.
- Type roles: page title 24/32 semibold; section title 16/24 semibold; body 14/20; small 13/18;
  caption 12/16; mono 13/20 for IDs and code.
- Inter for UI; `ui-monospace` for IDs, code, JSON.
- Radius: 6 px controls, 10 px panels; shadows only on floating layers (menus, dialogs, toasts).

### 7.4 Components — when to use which

| Need | Use | Not |
| --- | --- | --- |
| The one main action | primary Button | two primaries |
| Destructive action | danger Button → ConfirmDialog with exact scope | a red link |
| Choose one of ≤ 5 | radio group or segmented control | a select |
| Choose one of many | Select (searchable past 10) | raw `<select>` |
| Long text | Textarea with character count | Input |
| Read-only key facts | DescriptionList / KeyValueTable | raw JSON |
| Code, JSON, prompts | CodeBlock with Copy | a `<pre>` without copy |
| Status | Badge with tone and word | coloured text |
| More actions on a row | DropdownMenu (⋯) | a row of five buttons |
| Switch sections | Tabs | a long scroll |
| Explain a term | Tooltip / HelpTip | a paragraph above the form |
| Brief success | Toast with Undo when reversible | an alert |
| Problem in a task flow | InlineAlert | a toast |
| System-wide problem | Banner | a toast |

### 7.5 Forms

- Labels above fields, hint text under the label, error under the field.
- Group long forms into titled sections ("What", "Who", "When", "Links").
- Mark optional fields "(optional)"; don't asterisk required ones.
- Validate on blur for format, on submit for everything; never while the person is still typing a
  first entry.
- On submit failure: error summary at the top listing each problem as a link to its field; focus
  moves there.
- Long settings pages have a sticky save bar ("3 unsaved changes · Discard · Save") and warn before
  leaving with unsaved changes.
- Secrets are write-only after saving: show "Saved · ends in …4f2a · Replace".

### 7.6 Tables

- Every table has: a title or clear context, a filter/search bar if it can exceed 20 rows, an empty
  state, a loading skeleton, and pagination or "Load more".
- Rows open a detail page on click; row actions live in a ⋯ menu.
- Status column uses Badges. Time column is relative with absolute on hover.
- Numbers right-aligned in tabular figures. IDs in mono, truncated with copy on hover.

### 7.7 States

Every data view designs all of these, not only the happy path:

| State | Shows |
| --- | --- |
| Loading | nothing under 1 s; skeleton for areas, spinner for small parts up to 3 s; progress bar beyond; > 10 s becomes a background task |
| Empty (first use) | illustration + one sentence on what will appear + one primary action ("Create the first task") |
| Empty (filtered) | "No tasks match these filters" + Clear filters |
| Unavailable | what couldn't load, whether the rest is safe to use, Try again; never shown as "empty" |
| Stale | "Updated 4 min ago · Refresh" when data is older than its refresh interval |
| Partial | what succeeded, what didn't, and what to do about the rest |
| Forbidden | the permission needed and who can grant it |
| Not found | "This task doesn't exist or was deleted" + a way back |

No more than five failure messages on one page; past that, show one page-level Unavailable.

### 7.8 Navigation

- Rail grouped by what people do (Club, Moderation, Assistant, Messages, System); an account sees only
  what it can use.
- Ctrl/⌘-K opens the command palette: pages, tasks, members, cases, rules, common actions.
  The palette finds members by user ID only, until the API can search members by name.
- The current page is highlighted in the rail and named in the browser tab ("Tasks · Bananasaurs").
- Deep links to Discord open in Discord ("Open in Discord ↗").

### 7.9 Accessibility (part of done)

- WCAG 2.2 AA: text 4.5:1, large text and UI parts 3:1, in both themes.
- Visible focus on every interactive element; logical tab order; skip link to content.
- Every control has a label; icon-only buttons have `aria-label` and a tooltip.
- Errors and alerts are announced assertively; status updates politely.
- Dialogs trap focus and return it on close.
- Respect `prefers-reduced-motion`; no motion carries meaning.
- Usable at 200 % zoom and at 360 px wide (desktop-first, but nothing breaks).

### 7.10 Motion

Short and functional: 120–200 ms ease-out for menus, dialogs, toasts, row expand. No decorative
animation in working views. The backdrop art never moves.

---

## 8. Review checklist

Use this for every PR that touches a Discord post or a dashboard page.

**Words**
- [ ] Sentence case; vocabulary from §2.2; no internal codes or enums visible to members.
- [ ] Every message says what happened and what to do next (or that nothing needs doing).
- [ ] Errors follow §3: title, detail, next step, Ref for moderators/owners, no banned words.

**Discord**
- [ ] System output is a card built with the kit; conversation stays plain.
- [ ] Eyebrow, title, facts, footer present; tone matches §4; emoji from the vocabulary.
- [ ] Timestamps are `<t:…>`; people are mentions; user text escaped.
- [ ] ≤ 1 primary button; destructive actions confirm; labels are outcome verbs within length.
- [ ] Results, confirms, errors and lists are private.
- [ ] Art only where §6.8 allows, with alt text; card reads fully with images off.
- [ ] Snapshot test of the card JSON for every state; budget test passes.
- [ ] Any new task capability is reachable through MCP.

**Dashboard**
- [ ] Page follows the template; nothing longer than ~3 screens without tabs.
- [ ] Uses kit components only (no raw `<select>`, `<table>`, hard-coded colours, raw JSON).
- [ ] Loading, empty, unavailable, stale, forbidden and not-found states designed.
- [ ] Field errors specific; error summary and focus on failed submit; input preserved.
- [ ] Keyboard-only walkthrough done; focus visible; contrast checked in both themes.

---

## 9. Sources

- Discord developer docs — Components reference and button design guidance.
- Nielsen Norman Group — "Error-Message Guidelines".
- GOV.UK Design System — Error message component and Error summary.
- IBM Carbon Design System — Notification pattern.
- GitHub Primer — Degraded experiences; Loading; Empty states.
- Linear — "How we redesigned the Linear UI".
- Vercel Geist — colour system.
- WCAG 2.2 — contrast and focus requirements.
