# P5 — Dashboard page sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `docs/superpowers/plans/2026-10-10-uiux-00-glm-handoff.md` first.

**Goal:** Every dashboard page follows one template and uses only kit components. In order of pain:
1. tasks
2. AI setup
3. behaviours
4. raw-JSON pages
5. long settings pages
6. everything else

No raw `<select>`, `<textarea>` or `<table>` is left. No raw JSON is shown, except inside a `CodeBlock`
under "Advanced". Field errors are specific, and every page has its loading, empty, unavailable, forbidden
and not-found states.

**Architecture:**
- Large pages are split into a folder of small files: `pages/<area>/index.tsx` plus one file per tab or
  section.
- A new `/assistant/behaviours/:id` route moves behaviour editing off the list.
- Shared form pieces handle server field errors, the sticky save bar and the unsaved-changes guard:
  `useFieldErrors`, `FormSection`, `SaveBar` and `useUnsavedGuard`.
- A `DiscordCardPreview` renders the real card JSON from `@bananasaurs/core` for task posts.

**Tech stack:** P3 primitives and P4 shell. **No new dependencies. No server changes**, except the one
read-only addition in Task 2: a `?preview=1` mode of an existing task view model, if it is needed. That
task says when.

**Spec:** §7.6, §8.3. **Rules:** `docs/28` §7. **Base:** branch `uiux/p5-page-sweep`, cut from
`uiux/p4-dashboard-shell`.

**Shipping:** the spec says P5 ships "page by page", so every task is independently mergeable. Run the
gates and commit at the end of each task, as always. Do not leave a page half-converted between commits.

## The page recipe (apply to every page you touch)

1. **Header.** `PageHeader` with title, purpose, primary action on the right, and `crumbs` on detail pages.
   The purpose is one sentence that says what the page is for, from the reader's side ("Tasks your teams
   are working on").
2. **Status.** Only when the page has state worth knowing, as `PageHeader status` or an `InlineAlert`.
3. **Content.** If it is longer than about three screens at 1280 × 800, split it into `Tabs`. The selected
   tab lives in the URL query (`?tab=keys`), so a link can open it and Back works.
4. **Controls.**
   - `<select>` → `Select`, or `RadioGroup` when there are 5 options or fewer and space allows.
   - `<textarea>` → `Textarea`, with `showCount` when it has a limit.
   - `<table>` → `DataTable`.
   - Inline links → `Link`.
   - Status text → `Badge`.
   - A row of 3+ buttons on a list row → `DropdownMenu`.
5. **Raw data.** `JSON.stringify` in JSX → `KeyValueTable` for objects people read, and `CodeBlock` for
   payloads people copy. A JSON *editor* stays, but behind a `Tabs` or `<details>` labelled **Advanced**.
6. **States.** Data goes through `DataState`. Give each `Empty` a title that says what will appear, and one
   primary action. A filtered empty is `No <things> match these filters` with **Clear filters**.
7. **Forms.**
   - Labels above fields, with `(optional)` marked. Group fields in `FormSection`s.
   - Server field errors map to fields through `useFieldErrors`, and an `ErrorSummary` sits at the top.
   - Input is never cleared on error.
   - Settings pages use `SaveBar` and `useUnsavedGuard`.
8. **Words.** Every string follows docs/28 §2–§3. Replace `Failed to …`, `Invalid …`, `Error:`, `Please`
   and `Oops` where you see them.
9. **Classes.** Swap old tokens for the new names as you touch lines:
   - `text-danger` → `text-tone-danger-ink`
   - `rounded-sm` on panels → `rounded-panel`
   - `text-xl` page titles → `PageHeader`
   - `text-sm` body → `text-body` or `text-small`

   Do not hunt for them in untouched lines.
10. **Tests.**
    - Keep every behavioural assertion.
    - Update selectors that relied on raw elements. A `combobox` is now a Radix trigger, so use
      `userEvent` to pick an option.
    - Add one test per page for its empty state and one for its failure state, if missing.

A page is done when `rg -n "<select|<textarea|<table|JSON.stringify" <its files>` finds nothing outside
`ui/` and `lib/` (except `JSON.stringify` for request bodies), and its tests pass.

## Global Constraints

- **No new dependency.** No HTTP route changes except the one Task 2 may add, and only if its condition
  holds.
- **Behaviour stays the same.** Every request a page makes, with its body and its guard (reauth, confirm
  dialog, CSRF through `session.write`), stays exactly as it is. P5 changes presentation, structure and
  words, not what is sent.
- **Splitting a file is a move, not a rewrite.** Move components into new files unchanged first and commit
  that alone, then restyle. This keeps reviews readable: a "move" commit then a "sweep" commit, per page.
- Every `ConfirmDialog` keeps stating exact scope (docs/06).

## Review Focus

1. **No request changed.** For each page, the tests that assert `stubFetch` calls (method, URL, body) must
   pass **unchanged**. If one needs a change, explain it in the deviations file.
2. **Server field errors land on the right field.** A 400 with `fields: [{ path: 'title', problem }]` on
   New task shows the problem under Title, lists it in the ErrorSummary, and moves focus to the summary
   (Task 1, Task 2).
3. **Unsaved changes are not lost silently.** Editing Configuration, then clicking a rail link, asks
   `Leave without saving?`. Cancel stays, and the edits remain (Task 1, Task 6).

---

### Task 1: Shared form pieces and the Discord card preview

**Files:**
- Create: `packages/dashboard/src/ui/FormSection.tsx`, `SaveBar.tsx`, `DiscordCardPreview.tsx`
  and their tests
- Create: `packages/dashboard/src/hooks/useFieldErrors.ts`, `useUnsavedGuard.tsx` and their tests

**Interfaces:**

```ts
export function FormSection(props: { title: string; description?: string; children: ReactNode }): ReactElement;
// <section aria-labelledby> with an h2 text-section, description text-small text-ink-muted, children in a grid gap-4 max-w-[720px]

export function useFieldErrors(): {
  /** From a thrown error: DescribedError.fields → { [path]: problem } and the summary list. */
  readonly capture: (error: unknown) => boolean;          // true when it had field errors
  readonly errorFor: (path: string) => string | undefined; // for Field error=
  readonly summary: readonly { fieldId: string; message: string }[]; // for ErrorSummary
  readonly clear: (path?: string) => void;
};
// fieldId convention: `field-${path.replaceAll('.', '-')}`; pages give each control that id.

export function SaveBar(props: { dirtyCount: number; onSave: () => void; onDiscard: () => void; busy?: boolean }): ReactElement | null;
// sticky bottom bar: "<n> unsaved change(s) · Discard · Save" ; null when dirtyCount is 0; role="region" aria-label="Unsaved changes"

export function useUnsavedGuard(dirty: boolean): ReactElement | null;
// while dirty: beforeunload prompt; and in-app link clicks (capture phase, a[href^="/"]) open a ConfirmDialog
// "Leave without saving?" / "Your changes on this page will be lost." / [Stay] [Leave]; returns the dialog element to render

export function DiscordCardPreview(props: { message: { components: readonly unknown[] }; art?: Readonly<Record<string, string>> }): ReactElement;
// renders V2 JSON (container 17, text 10, section 9, thumbnail 11, gallery 12, separator 14, action row 1, buttons 2)
// with Discord-like styling from the mockup; Markdown subset: **bold**, *italic*, `code`, > quote, -# subtext, [link](url), <t:…:R|F|f|d> rendered as local time,
// <@id>/<@&id>/<#id> as pills; never dangerouslySetInnerHTML.
```

- [ ] **Step 1: Failing tests**

1. `useFieldErrors`:
   - `capture(new ApiError(400, { error: 'bad-request', fields: [{ path: 'links.0.url', problem: 'Enter a URL starting with https://' }] }))`
     returns true.
   - `errorFor('links.0.url')` returns the problem.
   - `summary` is `[{ fieldId: 'field-links-0-url', message: 'Enter a URL starting with https://' }]`.
   - A non-field error returns false and leaves the state empty.
2. `SaveBar` renders nothing at 0. At 3 it shows `3 unsaved changes`. Discard and Save call their handlers.
   While busy, Save shows a spinner and is disabled.
3. `useUnsavedGuard(true)`:
   - Clicking an in-app link opens the dialog, and the location does not change.
   - **Stay** closes the dialog.
   - **Leave** navigates.
   - With `dirty` false, links navigate directly.
   - A `beforeunload` listener is added only while dirty.
4. `DiscordCardPreview`:
   - Given `renderTaskCard(sample)` from `@bananasaurs/core` (P1), it renders the eyebrow, the bold title,
     the link buttons as `a` elements with their labels, and **I'm on it** as a disabled-looking button.
   - The container's accent colour is the left border colour.
   - A `<script>` inside a text display renders as text.
   - `<t:1760000000:R>` renders a relative time.

Run them. Expect FAIL.

- [ ] **Step 2: Implement**

- `DiscordCardPreview` walks the component tree with a `switch` on `type`.
- The Markdown subset is a small tokenizer in `lib/discord-markdown.tsx` that returns React nodes. Read
  `lib/guide-markdown.tsx` first and reuse its approach.
- Art keys map to `/brand/...` URLs through the `art` prop. The daemon does not serve card art to the
  dashboard, so the preview uses the brand images already in `public/brand/`, with a note: `Art shown here
  is a stand-in; Discord shows the card art.`
- Copy the preview styling values from the Discord section of `docs/design/ui-mockups.html` (the `--d-*`
  variables). Define them as local CSS custom properties on the preview root, in both Discord themes,
  following the dashboard theme. Copying them within this repo needs no provenance entry.

- The dashboard already imports runtime values from `@bananasaurs/core` (`LOG_ACTION_CATALOG`,
  `PROVIDER_FAILURE_TEXT`), so importing `renderTaskCard` follows a working pattern. Still run
  `npm run build` after adding the import. It must not warn that a `node:` module was externalised for the
  browser. If it does, the card renderer pulled in something server-side. Stop and record which import did
  it, rather than shimming it.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run packages/dashboard/src
npm run typecheck
npm run lint
npm run test
git add packages/dashboard/src
git commit -m "P5 Task 1: form sections, field errors, save bar, unsaved guard, Discord card preview"
```

---

### Task 2: Tasks — list, new, detail, teams

**Files:**
- Move, then sweep:
  - `pages/tasks.tsx` → `pages/tasks/index.tsx`
  - `task-create.tsx` → `pages/tasks/new.tsx`
  - `task-detail.tsx` → `pages/tasks/detail/{index,overview,steps,progress,reminders}.tsx`
  - `task-teams.tsx` → `pages/tasks/teams/{index,team-form,members}.tsx`
  - `task-posts-switch.tsx` → `pages/tasks/posts-switch.tsx`
- Modify: `app/Shell.tsx` (route imports only)
- Tests move with their pages.

**The pages:**

| Page | Shape |
| --- | --- |
| **Tasks** | header "Tasks" / "Tasks your teams are working on" / **New task** (primary) + ⋯ (Teams & members, Guide). Filter bar: team `Select`, status `Select` (Open / Done / Archived / All), search `Input` (title). `DataTable` columns: Title (link), Team, Status (Badge: Not started neutral, In progress progress, Waiting for review hold, Done ok, Archived neutral), Due (relative, absolute on hover; overdue in `text-tone-danger-ink` + "Overdue" word), Updated. Row ⋯: Open, Archive (ConfirmDialog as today). Empty: "No tasks yet" + **New task**; filtered: "No tasks match these filters" + **Clear filters**. Keep `TaskPostsBanner` above the table. |
| **New task** | `FormSection`s **What** (Title, Description `Textarea` showCount 2000 or the server's limit — read the schema), **Who** (Team `Select`; Audience `RadioGroup`: Whole team / Specific people; assignees picker as today), **When** (Due date-time, Priority `RadioGroup`), **Links** (P1's link editor, restyled: up to 5 rows of Label + URL, Add link, Remove; count `n / 5`). Right column (≥ 1024 px) or below (narrow): **Preview** — `DiscordCardPreview` of the new-task card built from the form state with `renderTaskCard` from `@bananasaurs/core`. Submit **Create task**; field errors via `useFieldErrors`; `ErrorSummary` on failure. |
| **Task detail** | header with crumbs `Tasks ›`, title = task title, status Badge in `status`, actions: **Edit**, ⋯ (Archive, Open in Discord ↗ when anchored). Tabs: **Overview** (DescriptionList: Team, Audience, Due, Priority, Created, Links as `Link`s; the card preview of the current card), **Steps**, **Progress** (reports as a timeline: author, relative time, body as quote, blocker in a hold InlineAlert), **Reminders**. Edit opens the same sections as New task in a `Dialog` or an `?edit=1` mode — use whichever the current page does, restyled. |
| **Teams & members** | two tabs, **Teams** and **Members**. Teams: DataTable (Name, Category, Member role, Lead, ⋯ Edit / Delete). Members: the membership editor with `Select`s replaced. The raw `<table>` becomes a `DataTable`. |

**Preview data:** `renderTaskCard` needs a view model. Build it in `pages/tasks/preview-view.ts` from the
form state and the team list the page already loaded. It should not need a new endpoint. If the view model
needs a field the dashboard cannot know, such as the anchor's message id, pass a placeholder; the preview
is only a picture. **Only if** the view model cannot be built client-side at all, add
`GET /api/tasks/:id/card-preview`. It returns `renderTaskCard(view)` JSON, uses the same authorisation as
`GET /api/tasks/:id`, and has a route test. Record the decision in the deviations file.

- [ ] **Step 1: Move**

Move the files unchanged, fix the imports, and run the gates.
`git commit -m "P5 Task 2a: move task pages into pages/tasks/ (no changes)"`.

- [ ] **Step 2: Failing tests**

Add to the moved tests:
1. The list filters by team and status. The filtered empty state appears, and **Clear filters** resets it.
2. New task: a stubbed 400 with field errors puts each under its field, fills the ErrorSummary, and
   focuses it (Review Focus 2).
3. New task: typing a title updates the preview's bold title.
4. Detail: `?tab=progress` opens the Progress tab. Switching tabs updates the query string.
5. Teams: `Select` changes still send the same request body as before (Review Focus 1).

Run them. Expect FAIL.

- [ ] **Step 3: Sweep**

Apply the recipe and the table above.

- [ ] **Step 4: Gates and commit**

```bash
npx vitest run packages/dashboard/src/pages/tasks
npm run typecheck
npm run lint
npm run test
git add packages
git commit -m "P5 Task 2b: task pages swept — filters, sections, card preview, tabs"
```

---

### Task 3: AI setup (`providers.tsx`, 1,968 lines)

**Files:** move `pages/providers.tsx` → `pages/ai-setup/{index,summary,model-order,keys,web-search,github,terms}.tsx`.
Tests move with it.

**Shape:**
- Header "AI setup" / "Which AI models answer, and the keys they use".
- **Status summary** at the top, in place of today's "Setup checklist" card. It is one row of up to four
  Badges, built from data the page already loads:
  - Models: `n ready`, or `None ready`
  - Keys: `n saved`
  - Web search: `On` / `Off`
  - Terms: `n to check`

  Each badge links to its tab.
- **Tabs:** **Model order** · **Keys** (API keys + Providers) · **Web search** · **GitHub** · **Terms**
  (Terms record + Service terms to check). Use the query param `?tab=`. The default is `model-order`, or
  `keys` when no key is saved.
- Keys are write-only after saving: `Saved · ends in …4f2a · Replace`. This is today's behaviour; keep it
  and restyle it.
- The terms warning for a provider that may train on input (hard rule 5) stays as prominent as today, as a
  `hold` `InlineAlert`.

- [ ] **Steps:** move (commit 3a), failing tests for the tab routing and the summary badges (each links to
  its tab), sweep, gates, then commit 3b: `P5 Task 3b: AI setup split into tabs with a status summary`.

---

### Task 4: Behaviours (`assistant.tsx`, 1,406 lines)

**Files:**
- Move `pages/assistant.tsx` → `pages/behaviours/{index,detail,create,settings}.tsx`
- Add the route `/assistant/behaviours/:id` in `Shell.tsx`. `/assistant`, `/ai` and `/proposals` keep
  rendering the list.

**Shape:**

| Page | Shape |
| --- | --- |
| **Behaviours** (`/assistant`) | header + **New behaviour**. Tabs: **Behaviours** (DataTable: Name, Who can use it, Skills, Status Badge; row → detail) · **Settings** (Tagging @Bananasaurs, AI log channel, Access and routing, Tickets, Decisions and plans — each a `FormSection` with `SaveBar`). Empty: "No behaviours yet" + **New behaviour**. |
| **Behaviour** (`/assistant/behaviours/:id`) | crumbs `Behaviours ›`; tabs **Prompt** (the prompt with `CodeBlock` for "Full prompt", link to the wizard), **Access** (Skills it may use, Who may use it), **Try it**. NotFound when the id is unknown: "This behaviour doesn't exist or was deleted" + back to Behaviours. |
| **New behaviour** | the "Create a behaviour" form as a `Dialog` from the list, restyled with `FormSection`s; on success navigate to its detail page. |

- [ ] **Steps:** move (4a), failing tests (list → detail navigation, NotFound, the Settings `SaveBar`, and
  that the create request is unchanged), sweep, gates, then commit 4b: `P5 Task 4b: behaviours list and
  detail pages; settings tab`.

---

### Task 5: Raw-JSON pages — Doctor, Configuration, History detail, Automod rule

| Page | Change |
| --- | --- |
| **Doctor** (`doctor.tsx`) | `JSON.stringify(data, null, 2)` → each check as a row: Badge (ok / hold / danger) + name + one-line detail + fix link; the raw report under **Advanced** in a `CodeBlock` with Copy ("Copy report"). |
| **Configuration** (`config.tsx`) | "Safety settings" and "Limits" → `DescriptionList`s; "Runtime settings, editable here" → `FormSection` + `SaveBar` + `useUnsavedGuard`; "Process configuration" `JSON.stringify` → `KeyValueTable` with `labels` for known keys; the raw object under **Advanced**. The reset-breaker `ConfirmDialog` stays. |
| **Run detail** (`assistant-history-detail.tsx`) | sections become tabs: **Summary** · **Prompt** · **Tool calls** · **Timeline** · **Sources**; Errors and Flags show as `InlineAlert`s above the tabs when present. Tool-call args: `KeyValueTable` by default, `CodeBlock` toggle "Show raw". |
| **Automod rule** (`automod-rule.tsx`) | configuration JSON textarea → a generated form (below); the JSON editor moves under **Advanced**, still validated on save exactly as today. |

**The generated automod form.** Core exports a `<kind>Config` Zod schema per rule kind
(`packages/core/src/automod/predicates/*.ts`, for example `capsConfig` and `linkDomainConfig`). If they
are not exported from `@bananasaurs/core`'s index, export them there. That is a type-only addition to
core's public surface. Then:

- `lib/schema-form.tsx`: `SchemaForm({ schema, value, onChange, errors })` renders one control per key of
  a `z.object` shape.

  | Zod type | Control |
  | --- | --- |
  | `z.number()` | `Input type="number"` with min/max from checks |
  | `z.boolean()` | `Checkbox` |
  | `z.enum` | `RadioGroup` (≤ 5) or `Select` |
  | `z.string()` | `Input` |
  | `z.array(z.string())` | a list editor (one `Input` per row, Add / Remove) |
  | `.optional()` / `.default()` | unwrapped; label marked `(optional)` |

  Any other type (records, nested objects, unions) makes `SchemaForm` render nothing for that key and set
  `unsupported: true`. The page then opens **Advanced** by default and says `This rule's settings are
  edited as JSON.`
- Labels come from a per-kind label map in `api/automod.ts` (`RULE_CONFIG_LABELS`). A key without a label
  is humanised.
- Use `keywordFilterConfig` (an empty strict object) as the empty case. It shows `This rule has no
  settings; its word list is under Lists.`

- [ ] **Steps:**
  1. Failing tests:
     - Doctor renders a check row per check and no `<pre>` outside Advanced.
     - Config's unsaved guard (Review Focus 3).
     - History detail's tab routing.
     - `SchemaForm` for `capsConfig` and `rapidSpamConfig` renders the expected controls, and editing
       them produces the same JSON the textarea would have.
     - Saving the automod rule sends the **same body** as before (Review Focus 1).
  2. Implement.
  3. Run the gates.
  4. Commit: `P5 Task 5: Doctor, Configuration, run detail and automod rule without raw JSON`.

---

### Task 6: Long settings pages — Panel builder, Connected apps, Resources, Permissions, Account edit

| Page | Change |
| --- | --- |
| **Role panels builder** (`panel-builder.tsx`, 908) | split into `pages/panels/builder/{index,options,behaviour,preview}.tsx`; `FormSection`s **Where** · **Options** · **Behaviour** · **Limits**; the existing `PanelPreview` restyled next to the form (≥ 1024 px); `SaveBar` + guard; "Saved — nothing is live yet" becomes a `hold` `InlineAlert` with **Publish**. |
| **Connected apps** (`mcp.tsx`, 860) | tabs **Connections** · **Send allowlist** · **Role policy** · **Registered clients** · **Send ledger**; tables → `DataTable`; "Clean up connections?" `ConfirmDialog` unchanged. |
| **Resources** (`assistant-resources.tsx`, 733) | list → `DataTable` with filter by source type; row ⋯ for refresh / remove; the add form in a `Dialog`. |
| **Permissions** (`permissions.tsx`, 665) | tabs **Channels** · **Assistant** · **Specialised**; "What each switch means" → `HelpTip`s on each column header + one `DescriptionList` under a **What the switches mean** disclosure; the eight `text-accent` links become `Link`. |
| **Account** (`account-edit.tsx`, 612) | tabs **Summary** · **Permissions** · **Password** · **Sessions and apps**; "Danger zone" stays at the bottom of Summary as a `danger`-bordered `Card`. |

- [ ] **Steps:** for each page, move it, then sweep it, as two commits per page:
  `P5 Task 6x: <page> moved` and `P5 Task 6x: <page> swept`. Write failing tests first, for:
  - tab routing
  - the `SaveBar` and guard where added
  - request bodies unchanged

---

### Task 7: Everything else

Apply the recipe to every remaining page, grouped in commits:
- **7a**, Moderation: `automod-rules`, `review`, `cases`, `case`, `members`, `member`, `logging`, `safety`
- **7b**, Messages and assistant: `archive`, `search`, `assistant-conversations`, `assistant-conversation`,
  `assistant-history`, `assistant-skills`, `assistant-skill`, `skill-items`, `assistant-schedules`,
  `assistant-memory`, `assistant-tuning`, `assistant-prompt-wizard`
- **7c**, System and the rest: `overview`, `overview-pulse`, `jobs`, `audit`, `backups`, `accounts`,
  `account-new`, `docs`, `login`, `not-found`

Rules for each page:
- A list page gets a filter bar if it can exceed 20 rows, an `Empty` state and a filtered-empty state.
- A list page whose rows have a detail page links its rows there.
- Statuses become `Badge`s with words.
- Times are relative, with the absolute time on hover (`title`).
- `login.tsx` keeps its exact auth behaviour, restyled to the tokens, with the brand mark kept.
- `not-found.tsx` uses `NotFound`.

- [ ] **Steps per commit:** failing tests for the states added, the sweep, then the gates.

---

### Task 8: Final sweep and docs

- [ ] **Step 1: The searches**

```bash
rg -n "<select\b|<textarea\b|<table\b" packages/dashboard/src --glob '!**/ui/**' --glob '!**/*.test.tsx'
rg -n "JSON\.stringify\(" packages/dashboard/src/pages
rg -n "\b(Failed to|Invalid|Oops|Please)\b" packages/dashboard/src/pages
rg -n "text-xl\b" packages/dashboard/src/pages
```

1. The first must find nothing.
2. The second may find only request bodies (`body: JSON.stringify(`) and values passed to `CodeBlock`
   under Advanced. List each remaining hit in the deviations file with its reason.
3. The third must find nothing in user-visible strings.
4. The fourth must find nothing: titles go through `PageHeader`.

- [ ] **Step 2: Docs**

`docs/STATE.md`, at the top:

```markdown
**Dashboard page sweep (P5), 2026-10-xx.** Every page on the template; tasks with filters, sectioned form
and live Discord card preview; AI setup, behaviours, panel builder, connected apps, permissions and account
pages split into tabs; raw JSON replaced by tables and copyable code blocks (JSON editors under Advanced);
generated automod rule forms; specific field errors with an error summary; unsaved-changes guard on
settings pages. No new dependencies.
```

`docs/28` §8 checklist: no change. P5 is the checklist applied.

- [ ] **Step 3: Gates and commit**

```bash
npm run typecheck
npm run lint
npm run test
npm run build
git add packages docs
git commit -m "P5 Task 8: final sweep; state"
```

---

## Self-check before handing back

- [ ] Review Focus 1: no `stubFetch` URL, method or body assertion was changed without an entry in
      `docs/superpowers/plans/notes/P5-deviations.md`.
- [ ] Every large page was split with a move-only commit before its sweep commit.
- [ ] The Task 8 searches give the results stated.
- [ ] A keyboard walkthrough in a real browser (`npm run dev`) of New task, AI setup, and Configuration
      with unsaved changes. Report it as done or not done.
- [ ] `npm run typecheck`, `npm run lint`, `npm run test` and `npm run build` all pass, run fresh.
