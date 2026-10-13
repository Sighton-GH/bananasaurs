# P4 — Dashboard shell: rail, header, system banner, command palette — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `docs/superpowers/plans/2026-10-10-uiux-00-glm-handoff.md` first.

**Goal:** The dashboard's chrome reads as one product:
- a rail grouped by what people do, with icons and a clear current page
- page headers with breadcrumbs
- one system banner that names every live problem once
- a **Ctrl/⌘-K command palette** that jumps to pages, tasks, cases and automod rules, and starts common
  actions

**Architecture:**
- `routes.ts` stays the single source of navigation. It gains icons and the new groups.
- `SystemBanner` replaces `StateStrip` and `ModelHealthBanner`. It reads `/api/health` and
  `/api/assistant/model-health` (the existing calls) and the browser's online state.
- The palette is hand-written on the Radix Dialog already installed. Its sources load when it opens, and
  each source fails on its own.

**Tech stack:** React 19, wouter, Radix Dialog, and the P3 primitives (`Banner`, `Kbd`, `Icon`,
`Spinner`, `Link`). **No new dependencies, and no server changes.**

**Spec:** §7.5. **Rules:** `docs/28` §7.2, §7.8. **Base:** branch `uiux/p4-dashboard-shell`, cut from
`uiux/p3-dashboard-foundations`. P4 needs P3's tokens and primitives.

## Decisions settled here

The spec left these to this plan.

1. **Rail groups and labels:**

   | Group | Entries (path → label) |
   | --- | --- |
   | **Club** | `/` Overview · `/tasks` Tasks · `/panels` Role panels · `/assistant/schedules` Schedules · `/docs` Guide |
   | **Moderation** | `/automod` Automod · `/review` Review queue · `/cases` Cases · `/members` Members · `/logging` Logging · `/safety` Safety · `/permissions` Permissions |
   | **Assistant** | `/assistant/setup` AI setup · `/assistant/tuning` AI tuning · `/assistant` Behaviours · `/assistant/conversations` Conversations · `/assistant/history` History · `/assistant/skills` Skills · `/assistant/resources` Resources · `/memory` Memory |
   | **Messages** | `/archive` Archive · `/search` Search |
   | **System** | `/jobs` Background tasks · `/audit` Audit log · `/doctor` Doctor · `/backups` Backups · `/config` Configuration · `/accounts` Accounts · `/mcp` Connected apps |

   Only labels change. The paths, `ownerOnly` and `taskAccess` flags stay exactly as they are.
   "Self-granted roles" becomes **Role panels**, the name members see in Discord. "Review" becomes
   **Review queue**, and "Audit" becomes **Audit log**.
2. **The command palette has no dependency.** It is about 250 lines on the installed Radix Dialog. `cmdk`
   would add a package for the same result (spec §7.3 left this open).
3. **Palette sources** are pages, actions, tasks, cases and automod rules, using the endpoints the pages
   already call.
   - **Members cannot be searched by name.** The API has no member search (`/api/guild/members` pages by
     cursor only). A query that is a user id (17–20 digits) offers **Open member <id>**. Name search waits
     for a server route; that is out of scope for a dashboard-only phase.
4. **The Kill switch action navigates to Safety. It does not toggle anything.** A palette is a fast path,
   and a guild-wide stop must keep its confirmation on the Safety page.
5. **Banner order is by severity:**
   1. offline
   2. kill switch
   3. circuit breaker
   4. gateway disconnected
   5. safety status unknown
   6. read-only
   7. preview mode
   8. failing AI models

   At most five show. The rest collapse into `and N more`, which expands in place (docs/28 §7.7's
   "no more than five").
6. **`stub.tsx` is deleted.** No `NAV` entry is a stub any more, and `NavStatus` loses `'stub'`. The other
   two pages the spec called orphaned are not: `assistant-live.tsx` and `what-the-ai-saw.tsx` are imported
   as components by the assistant pages.

## Global Constraints

- **No new dependency. No HTTP or core change.**
- The rail, the mobile jump sheet and the palette all read `visibleNav(...)`, so an account never sees,
  in any of the three, a page it cannot open.
- The palette never runs a write. Every item navigates.
- Keyboard: the palette opens with Ctrl-K on Linux and Windows and ⌘-K on macOS, from anywhere,
  including inside a text field. Escape closes it and focus returns where it was.

## Review Focus

1. **Visibility parity.** A non-owner without `tasks.manage` sees no Tasks entry in the rail, the jump
   sheet or the palette, and no task results in the palette (Task 1, Task 4).
2. **One failing source does not break the palette.** If `/api/tasks` returns 500, the palette still lists
   pages, cases and rules, and shows one line, `Tasks couldn't load`, in the Tasks section (Task 4).
3. **The banner never repeats a cause and never hides one.** The kill switch shows exactly once, whether
   health reports it or not. Offline shows even when health is cached (Task 3).

---

### Task 1: Rail groups, labels and icons

**Files:**
- Modify: `packages/dashboard/src/app/routes.ts`
- Modify: `packages/dashboard/src/app/Shell.tsx` (`Rail`), `JumpNav.tsx`
- Modify: `packages/dashboard/src/ui/icons.ts` (rail icons)
- Modify: `Shell.test.tsx`, `JumpNav.test.tsx`, `routes` tests
- Delete: `packages/dashboard/src/pages/stub.tsx`, `stub.test.tsx`; the `NOT_BUILT` import in `Shell.test.tsx`

**Interfaces:**
- `NavGroup = 'Club' | 'Moderation' | 'Assistant' | 'Messages' | 'System'`.
- `GROUPS` lists them in that order.
- `NavEntry` loses `status`, and gains `icon: LucideIcon` and `keywords?: readonly string[]`. The palette
  matches on the keywords too, for example `['kill switch', 'dry run', 'breaker']` on Safety.

- [ ] **Step 1: Failing tests**

In `Shell.test.tsx` and `JumpNav.test.tsx`:
- The group order becomes `['Club', 'Moderation', 'Assistant', 'Messages', 'System']`.
- Every label in Decision 1 is present for an owner.
- `/assistant/history` is in `Assistant`.
- The current page's link has `aria-current="page"` and the classes `bg-accent-bg text-accent`.
- **A detail page highlights its parent.** At `/tasks/abc` the Tasks entry is current. Today it uses exact
  equality, so it is not. Use `pageTitle`'s longest-prefix rule from P3 Task 11. Move that logic into a
  shared `activeNavPath(path)` in `routes.ts`, and make `pageTitle` use it.
- The visibility tests keep their intent: owner-only entries are hidden, and `taskAccess` shows Tasks.

Add a `routes.test.ts` case: every `NAV` path appears exactly once, every group in `GROUPS` has at least
one entry, and every entry has an icon.

Run them. Expect FAIL.

- [ ] **Step 2: Implement**

Add the rail icons to `icons.ts`, aliased by role:

```ts
  LayoutDashboard as IconOverview,
  ListChecks as IconTasks,
  ToggleRight as IconPanels,
  CalendarClock as IconSchedules,
  BookOpen as IconGuide,
  Shield as IconAutomod,
  Inbox as IconReview,
  FolderOpen as IconCases,
  Users as IconMembers,
  ScrollText as IconLogging,
  ShieldAlert as IconSafety,
  KeyRound as IconPermissions,
  Bot as IconAiSetup,
  SlidersHorizontal as IconTuning,
  Sparkles as IconBehaviours,
  MessagesSquare as IconConversations,
  History as IconHistory,
  Wrench as IconSkills,
  Library as IconResources,
  Brain as IconMemory,
  Archive as IconArchive,
  Search as IconSearchPage,
  Cog as IconJobs,
  FileClock as IconAudit,
  Stethoscope as IconDoctor,
  DatabaseBackup as IconBackups,
  Settings as IconConfig,
  UserCog as IconAccounts,
  Plug as IconConnectedApps,
  Plus as IconAdd,
  Command as IconCommand,
```

As in P3, if a name is missing in 1.48.0, use its current name. `Inbox` and `Search` are already exported
under `IconEmpty` and `IconSearch`; alias each a second time under the role name.

Rewrite `NAV` from Decision 1, keeping each entry's flags and adding its icon. Then in the rail:
- Each link is `flex items-center gap-2.5 rounded-control px-2.5 min-h-9 text-body`.
- The icon is `<Icon icon={entry.icon} />`.
- Current: `bg-accent-bg text-accent font-medium`. Otherwise: `text-ink-muted hover:bg-sunk hover:text-ink`.
- Group headings are `text-caption font-semibold uppercase tracking-wider text-ink-faint`.

Apply the same to `JumpNav`.

Remove `NavStatus`, the `Future` chip and `stub.tsx`. Search for leftovers with
`rg -n "status: 'built'|NOT_BUILT|pages/stub" packages/dashboard/src`; it must find nothing.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run packages/dashboard/src/app
npm run typecheck
npm run lint
npm run test
git add packages/dashboard/src
git commit -m "P4 Task 1: rail regrouped by what people do, with icons; stub page removed"
```

---

### Task 2: Page header with breadcrumbs, and the top bar

**Files:**
- Modify: `packages/dashboard/src/ui/PageHeader.tsx`, create `PageHeader.test.tsx`
- Modify: `packages/dashboard/src/app/Shell.tsx`, `shell-chrome.tsx` (the top bar)
- Modify: the detail pages' headers. Find them with `rg -ln "<PageHeader" packages/dashboard/src/pages`
  and keep only those whose route has a `:param`: task detail, automod rule, case, member, account edit,
  assistant skill, conversation, history detail and the prompt wizard.

**Interfaces:**
- `PageHeader({ title, purpose, actions?, crumbs?: readonly { label: string; href: string }[], status?: ReactNode })`
- The top bar, desktop: guild name (and switcher, as today), a **Search** button showing
  `Search or jump to…` and `<Kbd>Ctrl K</Kbd>` (`⌘ K` on Mac), the theme toggle and the account menu. On
  mobile, the Search button is an icon button with `aria-label="Search or jump to"`.

- [ ] **Step 1: Failing tests**

1. `PageHeader` renders `h1` with `text-title font-semibold`, and the purpose in `text-small text-ink-muted`.
2. With `crumbs`, it renders `nav aria-label="Breadcrumb"`: an ordered list of links, then the current
   title as plain text with `aria-current="page"`.
3. `status` renders between the header row and the content. A page uses it for a one-line state such as
   `Updated 2 min ago`.
4. In the shell, the Search button is present and named `Search or jump to`, and clicking it sets the
   palette open. Assert on the dialog in Task 4. For now, assert that it calls the
   `usePalette().open()` stub that Task 4 replaces.
5. Task detail at `/tasks/abc` shows the breadcrumb `Tasks › <task title>`.

Run them. Expect FAIL.

- [ ] **Step 2: Implement**

- `PageHeader`: header row first, then breadcrumbs above the title.
- `isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)`, kept in `lib/platform.ts`
  with a test.
- `PaletteContext` lives in `app/palette-context.tsx`, with `open()`, `close()` and `isOpen`. Create it
  here with a provider in `Shell`. Task 4 fills in the dialog.
- In each detail page:
  - pass `crumbs`: `[{ label: 'Tasks', href: '/tasks' }]` for task detail, and the equivalent for the
    others
  - use the parent's rail label
  - make the title the record's own name where the page already has it

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run packages/dashboard/src
npm run typecheck
npm run lint
npm run test
git add packages/dashboard/src
git commit -m "P4 Task 2: page header with breadcrumbs; top bar with search"
```

---

### Task 3: One system banner

**Files:**
- Create: `packages/dashboard/src/app/SystemBanner.tsx`, `SystemBanner.test.tsx`
- Create: `packages/dashboard/src/hooks/useOnline.ts`, `useOnline.test.tsx`
- Modify: `packages/dashboard/src/app/Shell.tsx` (replace `<StateStrip />` and `<ModelHealthBanner />`)
- Delete: `packages/dashboard/src/app/StateStrip.tsx` and its test. Move its test cases into
  `SystemBanner.test.tsx`.
- Modify: `packages/dashboard/src/ui/ModelHealthBanner.tsx`. Turn it into a `useModelHealthWarnings()`
  hook that returns the persistent-model lines; the banner renders them. Move its tests.

**Interfaces:**

```ts
export interface SystemCause {
  readonly id: 'offline' | 'killswitch' | 'breaker' | 'gateway' | 'safety-unknown' | 'readonly' | 'dry-run' | 'models';
  readonly tone: 'danger' | 'hold';
  readonly text: string;
  readonly action?: { readonly label: string; readonly href: string };
}
export const systemCauses: (input: {
  online: boolean;
  readonly: boolean;
  health: Resource<HealthInfo>;
  failingModels: readonly string[];
}) => readonly SystemCause[];   // pure, ordered by Decision 5
export function SystemBanner(): ReactElement | null;
export function useOnline(): boolean;
```

**Copy** (verbatim):

| Cause | Tone | Text | Action |
| --- | --- | --- | --- |
| offline | danger | `Bananasaurs can't be reached. Changes won't save until it's back.` | — |
| killswitch | danger | `Kill switch is on. The bot is taking no actions in Discord.` | `Open Safety` → `/safety` |
| breaker | danger | `The safety breaker is open. Discord changes are paused until someone checks.` | `Open Safety` |
| gateway | hold | `The bot is disconnected from Discord. Logs and replies will resume when it reconnects.` | `Open Doctor` → `/doctor` |
| safety-unknown | hold | `Safety status couldn't load. Check Safety before making changes.` | `Open Safety` |
| readonly | hold | `This dashboard is read-only. Changes are refused.` | — |
| dry-run | hold | `Preview mode is on. Discord changes are logged, not applied.` | `Open Safety` |
| models | hold | `<n> AI model(s) keep failing: <first model name>….` | `Open AI setup` → `/assistant/setup` |

- When the health read failed with an offline error (`describeError(e).code === 'dashboard-offline'`),
  show **offline** only, not also **safety-unknown**.
- When `navigator.onLine` is false, show offline. When it is true but the last health read was offline,
  show offline too.

- [ ] **Step 1: Failing tests**

1. `systemCauses` returns the causes in Decision 5's order, with the copy above, for a health snapshot that
   has every flag set.
2. Each cause appears at most once.
3. An offline health error gives `['offline']` and not `safety-unknown` (Review Focus 3).
4. `useOnline` follows `online` and `offline` window events.
5. `SystemBanner` renders one `Banner` per cause, at most five. The rest go behind a button
   `and <n> more`, which expands them. With no causes, it renders nothing.
6. The danger banners are `role="alert"` and the hold banners are `role="status"`, from P3's `Banner`.
7. Each existing `StateStrip` and `ModelHealthBanner` test case is kept as a `SystemBanner` case with the
   new words.

Run them. Expect FAIL.

- [ ] **Step 2: Implement**

`useOnline`: `useSyncExternalStore`, subscribing to `window` `online`/`offline`, with
`() => navigator.onLine` as the snapshot and `() => true` on the server.

`SystemBanner`:
- Reads `useSession()`, `useHealth()`, `useOnline()` and `useModelHealthWarnings()`.
- Renders a `section aria-label="System status"` above `main`, at full width, under the top bar.
- Each cause renders as a P3 `Banner`. Its action renders as a P3 `Link`.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run packages/dashboard/src
npm run typecheck
npm run lint
npm run test
git add packages/dashboard/src
git commit -m "P4 Task 3: one system banner, one line per cause, offline included"
```

---

### Task 4: The command palette

**Files:**
- Create: `packages/dashboard/src/app/CommandPalette.tsx`, `CommandPalette.test.tsx`
- Create: `packages/dashboard/src/app/palette-sources.ts`, `palette-sources.test.ts`
- Create: `packages/dashboard/src/lib/fuzzy.ts`, `fuzzy.test.ts`
- Modify: `packages/dashboard/src/app/palette-context.tsx` (from Task 2), `Shell.tsx`
- Modify: `pages/tasks.tsx` only to **export** its `Snapshot` type. `ModCase` (`pages/cases.tsx`) and
  `RuleSummary` (`api/automod.ts`) are already exported.

**Interfaces:**

```ts
export interface PaletteItem {
  readonly id: string;           // stable key, e.g. 'page:/tasks', 'task:<uuid>'
  readonly section: 'Pages' | 'Actions' | 'Tasks' | 'Cases' | 'Automod rules' | 'Members';
  readonly label: string;
  readonly hint?: string;        // right-aligned muted text: team, status, member
  readonly keywords?: readonly string[];
  readonly href: string;
  readonly icon: LucideIcon;
}
export interface PaletteSource {
  readonly section: PaletteItem['section'];
  readonly load: (read: Session['read']) => Promise<readonly PaletteItem[]>;
  readonly visible: (info: SessionInfo) => boolean;
}
export const PALETTE_SOURCES: readonly PaletteSource[];
export const staticItems: (info: SessionInfo) => readonly PaletteItem[];   // pages + actions
export const memberItem: (query: string) => PaletteItem | undefined;       // a snowflake → "Open member <id>"
export const score: (query: string, text: string) => number;               // 0 = no match
export function CommandPalette(): ReactElement;
```

**Items:**
- **Pages**: every `visibleNav(...)` entry, with its keywords.
- **Actions**, where visible:
  - `New task` → `/tasks/new` (needs `mayManageTasks`)
  - `New automod rule` → `/automod`
  - `New account` → `/accounts/new` (owner)
  - `Kill switch` → `/safety` (Decision 4; hint `Opens Safety`)
  - `Run Doctor` → `/doctor`
  - `Open the UI kit` → `/kit` (owner)
- **Tasks**: `/api/tasks?include=done,archived` (only when `mayManageTasks`). The label is the title, the
  hint is `<team> · <status in words>`, and the href is `/tasks/<id>`.
- **Cases**: `/api/mod/cases?limit=50`. The label is `Case <first 8 of id>`, the hint is the member
  (mention name if present, else id), and the href is `/cases/<id>`.
- **Automod rules**: `/api/automod/rules` (`RuleSummary` in `api/automod.ts`). The label is the rule name,
  the hint is `<kind in words> · On` or `<kind in words> · Off` from `enabled` (watch mode is guild-wide, not
  per rule), and the href is `/automod/<ruleId>`.
- **Members**: only `memberItem(query)`.

**Behaviour:**

| Input | Result |
| --- | --- |
| open | focus in the search box; Pages and Actions shown at once; the other sources load once per open, each showing a `Spinner` row while loading |
| typing | items filtered by `score` over label + hint + keywords, sorted by score then by section order; max 8 per section |
| ↑ / ↓ | move the active item across sections; wrap at the ends; the active item is `aria-selected` and scrolled into view |
| Enter | navigate to the active item's `href`, close |
| Esc | close; focus returns to the element focused before opening |
| Ctrl/⌘-K while open | close |
| a source fails | its section shows one line `<Section> couldn't load` (P3 `InlineAlert` tone `hold`, compact); the others work |
| no matches | `No results for "<query>"` and, when the query is a snowflake, the member item |

**ARIA:** a Radix Dialog with `aria-label="Search or jump to"`. Inside it, the input is
`role="combobox" aria-expanded="true" aria-controls=<listbox id> aria-activedescendant=<active option id>`.
The list is `role="listbox"`. Each section is `role="group"` with `aria-labelledby` set to its heading,
and each item is `role="option"`.

- [ ] **Step 1: Failing tests**

`fuzzy.test.ts`:
- `score('tsk', 'Tasks') > 0`.
- `score('tasks', 'Tasks') > score('tsk', 'Tasks')`. A prefix beats a subsequence.
- `score('x', 'Tasks') === 0`.
- Matching ignores case and accents: `score('resume', 'Résumé') > 0`.

`palette-sources.test.ts`:
- `staticItems` for a non-owner without task access has no `New task`, no `Tasks` page and no
  `Open the UI kit` (Review Focus 1).
- Each source maps a stubbed response to items as described.
- `memberItem('123')` is undefined, and `memberItem('333333333333333333')` gives href
  `/members/333333333333333333`.

`CommandPalette.test.tsx` (`userEvent`, `stubFetch` from `test-support.tsx`):
1. Ctrl-K from the body opens a dialog named `Search or jump to`, with focus in the combobox. Meta-K does
   the same.
2. Ctrl-K inside a focused `<input>` elsewhere on the page also opens it.
3. Typing `task` and pressing Enter navigates to `/tasks`, and the dialog closes.
4. ArrowDown twice then Enter picks the third item. `aria-activedescendant` tracks the active item.
5. Escape closes it, and focus is back on the element that had it.
6. `/api/tasks` returns 500, and the Pages, Cases and Automod rules results still render. The Tasks section
   shows `Tasks couldn't load` (Review Focus 2).
7. Typing a snowflake shows `Open member <id>`.
8. A task from the stubbed API is found by its title and navigates to `/tasks/<id>`.

Run them. Expect FAIL.

- [ ] **Step 2: Implement**

`fuzzy.ts`:

```ts
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** 0 = no match. Prefix > word-start > contiguous > subsequence; shorter texts win ties. */
export const score = (query: string, text: string): number => {
  const q = fold(query.trim());
  const t = fold(text);
  if (q === '') return 1;
  if (t.startsWith(q)) return 1000 - t.length;
  const wordStart = t.split(/[\s/·_-]+/).some((w) => w.startsWith(q));
  if (wordStart) return 800 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return 600 - at - t.length / 10;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 200 - t.length : 0;
};
```

`CommandPalette.tsx`:
- A Radix `Dialog.Root` controlled by `palette-context`.
- `Dialog.Content` is `fixed top-[12vh] left-1/2 w-[min(640px,92vw)] -translate-x-1/2 rounded-panel
  border border-line bg-panel shadow-float`.
- An input row with the search icon, then the scrolling listbox (`max-h-[60vh] overflow-y-auto`), then a
  footer: `<Kbd>↑</Kbd><Kbd>↓</Kbd> to move · <Kbd>Enter</Kbd> to open · <Kbd>Esc</Kbd> to close`.
- Sources load in an effect when `isOpen` becomes true. Hold them in state as
  `Record<section, { state: 'loading' } | { state: 'ready'; items } | { state: 'error' }>`, and reset on
  close.
- Navigate with wouter's `useLocation()[1]`.

Register the global key in `palette-context.tsx`'s provider. Use a `keydown` listener on `window` in the
capture phase: when `(e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'`, call `preventDefault()`
and toggle. Remember `document.activeElement` on open, and focus it again on close. Radix also returns
focus, so check that only one refocus happens.

Mount `<CommandPalette />` once, inside the shell's providers.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run packages/dashboard/src
npm run typecheck
npm run lint
npm run test
git add packages/dashboard/src
git commit -m "P4 Task 4: Ctrl/Cmd-K command palette over pages, actions, tasks, cases and rules"
```

---

### Task 5: Docs and the final sweep

**Files:**
- Modify: `packages/dashboard/src/pages/docs.tsx`, or wherever the Guide's sources are
  (`rg -n "Self-granted roles" packages docs`). Use the new rail labels where the guide names pages.
- Modify: `docs/28_UI_UX_GUIDELINES.md` §7.8 (the final group names; the palette's member limit)
- Modify: `docs/STATE.md`

- [ ] **Step 1: Text**

1. Run `rg -n "Self-granted roles|'Review'|Advanced / System|Start here" packages docs --glob '!docs/superpowers/**'`.
2. Update every place that names a page in the user-facing guide or docs, so it matches Decision 1.
3. Leave historical ADRs alone.

`docs/28` §7.8: replace the group sentence with the five group names. Add this line:
`The palette finds members by user ID only, until the API can search members by name.`

`docs/STATE.md`, at the top:

```markdown
**Dashboard shell (P4), 2026-10-xx.** Rail regrouped (Club, Moderation, Assistant, Messages, System) with
icons and parent highlighting; page headers with breadcrumbs; one system banner per live cause (offline,
kill switch, breaker, gateway, read-only, preview, failing models); Ctrl/⌘-K palette over pages, actions,
tasks, cases and automod rules. No new dependencies.
```

- [ ] **Step 2: Gates and commit**

```bash
rg -n "StateStrip|ModelHealthBanner\b" packages/dashboard/src
npm run typecheck
npm run lint
npm run test
npm run build
git add packages docs
git commit -m "P4 Task 5: guide and docs use the new page names; state"
```

The first search must find only the `useModelHealthWarnings` hook file, if it kept that file name, and no
component use.

---

## Self-check before handing back

- [ ] No `package.json` changed.
- [ ] Review Focus 1–3 each have a passing test.
- [ ] Keyboard walkthrough, done in a real browser with `npm run dev`:
  - Tab from the top of the page reaches the skip link, the Search button, then the rail.
  - Ctrl-K opens the palette, typing and Enter navigates, and Escape returns focus.
  - Write it down in the hand-back report as done or not done. Do not claim it if you did not do it.
- [ ] `npm run typecheck`, `npm run lint`, `npm run test` and `npm run build` all pass, run fresh.
- [ ] `docs/superpowers/plans/notes/P4-deviations.md` lists every deviation, or does not exist.
