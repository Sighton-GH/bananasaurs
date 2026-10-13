# ADR 0142: Dashboard foundations — light-first tokens, Inter, Lucide icons, states and crash boundaries

Status: accepted 2026-10-10 (the owner approved the design spec the same day; this ADR settles what the
spec left to the P3 plan).

Spec: `docs/superpowers/specs/2026-10-10-ui-ux-overhaul-design.md` §7.1–§7.4 and §8.3. Rules:
`docs/28_UI_UX_GUIDELINES.md` §4, §5.2 and §7. This ADR amends ADR 0043 D4 (dark-first tokens) and ADR 0051
D6 (inline SVG icons, no new runtime dependencies).

## Context

These facts were checked on 2026-10-10 against `main` at `950f78fe`.

- **Theme.** `packages/dashboard/src/styles.css` defines nine colour tokens, and it is dark-first.
  - Light mode swaps the tokens under `prefers-color-scheme` or `data-theme='light'`.
  - There is no accent token. Even so, `text-accent` and `border-accent` appear 13 times, so they render
    as nothing.
  - Seventeen lines hard-code Tailwind palette colours, such as `text-blue-700` and `bg-amber-50`, in
    the task pages, the docs page and `TaskPostsBanner`. They ignore the theme.
- **Fonts and icons.** The font is `system-ui`. The theme toggle draws its icons as hand-written SVG.
- **Primitives.** `src/ui` has Button, Badge, Card, Field, Input, Checkbox, DataTable, ConfirmDialog,
  Toast, DataState, ErrorNotice, EmptyState and PageHeader.
  - There is no Select, Textarea, Tabs, Tooltip, DropdownMenu, Skeleton, Spinner, InlineAlert, Banner,
    DescriptionList, KeyValueTable or CodeBlock.
  - Radix dialog, select, tabs, tooltip and dropdown-menu are installed, but only the dialog is used.
- **States.** `DataState` shows `Loading…` at once. It shows every error the same way, so a 403 or a 404
  looks like a failure to load.
- **Crashes.** There is no error boundary, so one render exception blanks the whole dashboard, rail
  included.
- **Accessibility.** Toasts sit in one polite live region, errors included. There is no skip link, and
  the browser tab always reads "Bananasaurs".

I measured the mockup palette (`docs/design/ui-mockups.html`) against WCAG 2.2:
- Text, tinted fills and icons pass AA in both themes.
- **Light-theme amber `#c98a12` fails** as a UI colour on white: it is 2.95:1, and 3:1 is needed.
- The panel divider `#e5e1d6` is 1.31:1. It is decorative and exempt, but input borders are not.

## Decision

1. **The tokens are light-first and follow the mockup, with two fixes.**
   - The Tailwind `@theme` block holds the light values.
   - `:root[data-theme='dark']` holds the dark values. So does
     `@media (prefers-color-scheme: dark) { :root:not([data-theme]) }`.
   - Both themes have the same token set, so dark is a redefinition, not an inversion.

   | Token | Light | Dark | Use |
   | --- | --- | --- | --- |
   | `canvas` | `#f8f6f0` | `#12161e` | page ground |
   | `panel` | `#ffffff` | `#191e28` | cards, rail, dialogs |
   | `sunk` | `#f1eee5` | `#10141b` | wells, code, table header |
   | `line` | `#e5e1d6` | `#29303d` | dividers (decorative) |
   | `line-strong` | `#8a8577` | `#687387` | **new**: input and control borders, ≥ 3:1 |
   | `ink` | `#14213d` | `#e6e9f0` | text |
   | `ink-muted` | `#596377` | `#a1aabb` | secondary text, ≥ 4.5:1 on canvas, panel and sunk |
   | `ink-faint` | `#8a93a3` | `#7c8597` | placeholders and disabled text, ≥ 3:1 |
   | `accent` | `#2f5bd3` | `#7f9cff` | primary button, links, focus ring, selection |
   | `accent-ink` | `#ffffff` | `#0e1424` | text on `accent` |
   | `accent-bg` | `#e8eefc` | `#1e2847` | selected row, current rail item |
   | `tone-neutral` / `-bg` / `-ink` | `#64748b` / `#eef1f5` / `#3f4b5e` | `#94a3b8` / `#222a36` / `#c7d0dc` | |
   | `tone-progress` / `-bg` / `-ink` | `#3b82f6` / `#e6f0fe` / `#1d4ed8` | `#60a5fa` / `#16263f` / `#9cc6ff` | |
   | `tone-hold` / `-bg` / `-ink` | **`#b8800f`** / `#fdf3dc` / `#7a5208` | `#f2b441` / `#33280f` / `#f6cd76` | |
   | `tone-ok` / `-bg` / `-ink` | `#2e9a62` / `#e3f4ea` / `#1d6b43` | `#4cc28a` / `#12301f` / `#86ddb0` | |
   | `tone-danger` / `-bg` / `-ink` | `#d64545` / `#fce8e8` / `#a42626` | `#f07171` / `#3a1717` / `#ffadad` | |

   - A `tone-x` colour is for icons and borders only, at 3:1 or better.
   - Text on a tinted fill uses `tone-x-ink`, at 4.5:1 or better.
   - The old names remain as aliases, so the 42 pages keep working:
     - `hold` → `tone-hold`.
     - `hold-ink` stays `#1a1405` in both themes. It is 5.35:1 on light amber and 9.93:1 on dark amber.
     - **`danger` → `tone-danger-ink`, and `ok` → `tone-ok-ink`.** Today's pages use both as text colour,
       and only the `-ink` values pass as text.
   - A Vitest test parses `styles.css` and checks every pair in this table in both themes. It also checks
     that the media-query block and the `data-theme='dark'` block cannot drift apart.
2. **A first visit is light.**
   - With no saved choice, the dashboard renders light and sets `data-theme='light'`.
   - A saved `light` or `dark` choice wins. The toggle keeps its single click.
   - A saved `system` still follows the OS, so nobody who chose it is moved.
   - A small `theme-boot.ts`, imported first in `main.tsx`, sets the attribute before React mounts, so a
     dark-OS first visit does not flash. It is a module and not an inline script, so the CSP is untouched.
3. **Inter, bundled.**
   - `@fontsource-variable/inter` 5.3.0 (OFL-1.1) is imported in `main.tsx`. Vite emits the WOFF2 files
     into `dist`, so they are served by the daemon itself.
   - No font CDN, so there is no new outbound destination (hard rule 8).
   - `--font-sans` becomes `'Inter Variable', system-ui, …`, and `--font-mono` is `ui-monospace, …`.
   - The six size tokens become named roles: `title`, `section`, `body`, `small`, `caption` and `mono`.
     Each has a line height, per docs/28 §7.3. The old `text-xs`…`text-2xl` keep working.
4. **Lucide icons, through one module.**
   - `lucide-react` 1.48.0 (ISC) is pinned exactly. It was published 2026-09-24; the version published
     today was not picked.
   - Pages import icons only from `src/ui/icons.ts`. That module re-exports the named icons the dashboard
     uses, sized and stroked per docs/28 §5.2.
   - An ESLint `no-restricted-imports` rule keeps `lucide-react` out of every other file, so the set stays
     reviewable and tree-shaken.
   - **This reverses ADR 0051 D6 for icons only.** Brand art stays inline SVG and PNG.
5. **Primitives are original code on the Radix packages already installed.**
   - Nothing is copied from shadcn/ui or anywhere else, so `docs/PROVENANCE.md` gains no row.
   - New: Select, Textarea, RadioGroup, Link, Tabs, DropdownMenu, Tooltip, Spinner, Skeleton,
     ProgressBar, InlineAlert, Banner, Kbd, DescriptionList, KeyValueTable, CodeBlock, Pagination and
     ErrorSummary.
   - Existing: Button gains `primary` on `accent`, plus `subtle`, `size` and a spinner while busy. Badge
     gains `accent` and `progress`, and an optional icon. Input and Field use `line-strong` and show an
     error border.
   - Each primitive has a keyboard and ARIA test.
6. **A states kit.** `Loading`, `Empty`, `Unavailable`, `Forbidden`, `NotFound` and `Stale`.
   - `DataState` routes to them:
     - **401:** no state of its own; the session flow already handles it.
     - **403:** `Forbidden`, with the server's catalogue title and message.
     - **404:** `NotFound`.
     - **Any other error:** `Unavailable`, with Try again and the request id.
   - Loading follows Primer's thresholds:
     - **Under 1 s:** nothing (docs/28 §7.7).
     - **After that:** a skeleton, or a spinner for a small region.
     - **Past 10 s:** a line saying it is taking longer than usual, with Try again.
7. **Crash boundaries.** There is one around the whole shell and one around the routed content, keyed by
   location.
   - A crash shows "This page hit a problem", the error name, a reference, **Copy details** and **Reload
     page**.
   - The rail and header stay usable, and moving to another route clears the crash.
   - Details are the error name and message, the component stack, the route and the time. No API data is
     included.
8. **Accessibility fixes.**
   - A skip link to `#main`.
   - `<main id="main" tabindex="-1">`, focused on route change.
   - The browser tab reads `<Page> · Bananasaurs`.
   - Toasts are split into two live regions: errors and warnings are assertive (`role="alert"`), and the
     rest are polite.
   - Toasts can carry one action, such as Undo.
   - The focus ring is `accent`, 2 px, offset 2 px.
9. **A kit page at `/kit`, owner-only and not in the rail.** It renders every primitive and state in both
   themes, side by side. It is the visual check for P3–P5 and replaces a Storybook dependency.
10. **`@testing-library/user-event` 14.6.7 (MIT, dev only)**, for keyboard tests of the primitives. Today
    `@testing-library/react` alone can only fire synthetic events, which do not exercise Radix's keyboard
    handling.

## Consequences

- Three new packages: two runtime, one dev. Each is named, versioned and justified in the P3 plan, as
  `CLAUDE.md` asks.
- The dashboard bundle grows by Inter's Latin WOFF2 subset (about 50 KB) plus the icons used (about 1 KB
  each). Pages are not otherwise touched in P3, apart from the colour fixes.
- Every page changes colour at once: light by default, warmer and navier. Tests that assert on class names
  for colours need their expectations updated, but no behaviour changes.
- Raw `<select>` and `<textarea>` elements stay on pages until P5. P3 only provides the replacements.
- `docs/28` §4 records these as the final values, replacing "the P0 proposal".

## Alternatives rejected

- **Keep `system` as the first-visit default.** The owner asked for light-first. A dark OS would otherwise
  show the dark theme to most first-time visitors on the club's laptops.
- **Rename every old token at once** (`text-danger` → `text-tone-danger-ink`). That would touch about 40
  files for no visible gain; the aliases keep them correct. P5 moves pages to the new names as it sweeps
  them.
- **Copy shadcn/ui components.** They are MIT, but they need `class-variance-authority`,
  `tailwind-merge` and `clsx`: three more dependencies for what a 40-line component does here.
- **Storybook** for the visual check. It is a large dev dependency tree. A route in the app itself
  renders the real tokens in the real shell.
- **Google Fonts.** It is a new outbound destination, and it leaks visits to a third party.
