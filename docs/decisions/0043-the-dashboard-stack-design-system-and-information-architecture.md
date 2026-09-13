# 0043 — The dashboard's stack, design system, and information architecture

Status: accepted
Date: 2026-09-12
Precedes Slice 7 of
`docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`
(§5 decided the stack and direction; this ADR records what §5 left open and
what verifying §5's claims changed).
Depends on ADR 0024 (dashboard auth, one owner account), ADR 0029 (re-auth
for sensitive writes — `api.ts` implements it and is unchanged here), ADR 0014
(package boundaries — the dashboard may not import server code).
Constrained by `CLAUDE.md` rule 7 (licensing) and the working-style rule that
every new dependency carries a one-line justification.

## Context

`packages/dashboard` is one 455-line `App.tsx`, 70 lines of CSS, and five
stacked `<section class="panel">` blocks. Slices 8–10 add at least eight pages
to it, and Release 3 adds seven areas more. `docs/06` requires that empty,
stale, degraded and partial states are explicit, that dangerous actions state
their exact scope, that accessibility and keyboard operation are part of done,
and that the UI never pretends an unbuilt area exists. None of that is possible
one `<section>` at a time.

The spec's §5 chose the stack — Tailwind v4, hand-written components, Radix
primitives for the five components where accessibility is hard, `wouter` for
routing — and the direction: a dense, dark-first operator console with one
accent reserved for state. This ADR does not reopen those. It records five
things §5 did not settle, and one thing §5 asserted that turned out to be
wrong.

## Decision

### D1 — Dependencies, verified against the registry rather than the spec

| Package | Version | Licence | Why |
| --- | --- | --- | --- |
| `tailwindcss`, `@tailwindcss/vite` | 4.3.x | MIT | Tokens as CSS custom properties in `@theme`; one Vite plugin line; consistency that fifteen pages cannot drift from |
| `wouter` | 3.11.x | **Unlicense** | ~2 kB, hooks-only routing; React Router has broken its API three times |
| `@radix-ui/react-dialog` | 1.1.x | MIT | Focus trap, ARIA, escape/backdrop handling for the re-auth prompt and destructive confirmations |
| `@radix-ui/react-dropdown-menu` | 2.1.x | MIT | Keyboard-navigable menus (row actions) |
| `@radix-ui/react-tabs` | 1.1.x | MIT | Roving tabindex and ARIA tabs for detail panes |
| `@radix-ui/react-tooltip` | 1.2.x | MIT | Hover and focus tooltips that work for keyboard users |
| `@radix-ui/react-select` | 2.3.x | MIT | Accessible listbox; the native `<select>` cannot be styled to match |
| `jsdom` (dev) | 30.x | MIT | DOM for component tests under vitest |
| `@testing-library/react` (dev) | 16.x | MIT | Render-and-query for component tests; asserts behaviour, not implementation |

**§5 said "eight new dependencies, all MIT". `wouter` is Unlicense**, a
public-domain dedication. It is permissive and compatible with Apache-2.0 as a
dependency; rule 7's MIT/Apache/BSD list governs *copying source*, which this
project does not do from `wouter`. Recorded because the spec's claim was
repeated from memory and the registry says otherwise — the same class of error
`docs/22` warns about.

Toasts are hand-written. §5 lists Radix for exactly five components; a toast is
a `role="status"` live region and a timer, and carries no machinery worth a
dependency.

### D2 — Component tests exist, and what they are for

The dashboard has never had a test of its own; `vitest.config.ts` includes
only `*.test.ts` in a `node` environment. Slice 7's proof of "no behaviour
change" is the HTTP package's route tests staying green, exactly as the spec
says — but the shell adds routing, a state strip, and a component set that
would otherwise ship unexercised, and Slices 8–10 build on them.

So `vitest.config.ts` gains `packages/**/*.test.tsx`, and dashboard tests opt
into `jsdom` per file with `// @vitest-environment jsdom`. The `node` default
is untouched, so the 2,388 existing tests do not change environment.

What these tests assert: routing (a path renders its page; an unknown path
renders the not-found state), the state strip (amber only when a hold is
active), each shared component's keyboard and ARIA contract, and that the five
migrated pages still call the same endpoints with the same bodies. What they do
not assert: layout, colour, or pixels.

### D3 — Routes and the navigation model

| Path | Page | Migrates |
| --- | --- | --- |
| `/` | Overview | the Health section |
| `/safety` | Safety | the Kill switch section |
| `/logging` | Logging | the Log routing section |
| `/panels` | Role panels | the Panels section |
| `/audit` | Audit | the Audit section |
| anything else | Not found | — |

`/bootstrap?token=` and the login form are not routes; they remain the
top-level session state machine's concern, exactly as today, because they
render *instead of* the shell rather than inside it.

Navigation is data, not JSX: an array of `{ path, label, area, status }` where
`status` is `'built'` today and Slice 10 adds `'stub'`. Slices 8 and 10 add
rows; they do not restructure the rail. Unbuilt areas are absent in Slice 7
and visibly stubbed from Slice 10 — never hidden after that, never faked.

The daemon's SPA fallback (`apps/daemon/src/http/static.ts`) already serves
`index.html` for any non-file path, and its test proves it, so deep links need
no server change.

### D4 — Design system

Dark-first, because the console sits on a monitor beside a terminal; light
follows `prefers-color-scheme` with the same tokens swapped. Tokens live in
`@theme` in `styles.css` and nowhere else.

- **Base palette (dark):** background `#14181D`, surface `#1B2026`, line
  `#2B333C`, text `#D9DFE6`, muted text `#8A94A0`. Cool slate, not tinted
  near-black.
- **One accent, reserved for state:** `#F2B441` — amber, the subject's own
  colour. It appears only when the bot is holding back or the operator must
  know something: dry run, kill switch, breaker open, observe window active,
  read-only instance. It is never decorative and never on a button.
- **Two semantic colours, small:** `#E5484D` for destructive actions and
  errors; `#3DB37A` as a status dot for "connected"/"ok". Neither appears as a
  fill larger than a chip.
- **Type:** the system sans stack, one family. The dashboard serves from
  loopback with no external network, and bundling a font is a binary asset in
  the repository. Personality comes from the scale — 14px base, 1.45 leading,
  a six-step scale — and from `font-variant-numeric: tabular-nums` on every
  element. No all-caps labels; no monospace for data.
- **Layout:** a 220px left rail carrying the guild identity (`docs/06`:
  prominent current-guild identity) and the area list; a page header with the
  page's one-sentence purpose; beneath it the **state strip** — silent when
  nothing is held, amber with the exact holds named when something is. The
  strip is the one bold element; everything else is quiet. Content is
  left-aligned, max 1400px, tables with hairline rows for tabular data, detail
  panes (not modals) for anything the operator reads while doing something
  else. Modals only for re-auth and destructive confirmation, both of which
  must interrupt.
- **Copy:** sentence case, verbs on buttons that name the effect ("Turn kill
  switch on"), the same verb in the toast that confirms it. Empty states say
  what to do next; error states say what failed and what to try.
- **Quality floor, not announced:** visible focus rings, `prefers-reduced-
  motion` respected (there is almost no motion to reduce), 4.5:1 contrast on
  text, keyboard-operable everything.

### D5 — What "no behaviour change" means for the five sections

Each migrated page issues the same requests to the same endpoints with the
same bodies and handles the same responses as `App.tsx` does today: `GET
/api/health`, `GET /api/log-routes`, `POST /api/log-routes`, `GET /api/panels`,
`GET /api/audit?limit=50`, `POST /api/killswitch`, `POST /api/logout`, and the
re-auth round trip through `apiFetch`. `api.ts` is not modified. The
`ReadonlyError` path still surfaces the instance's read-only message; it moves
from a `<p class="notice">` to the state strip, which is a presentation change
and not a behaviour change.

### D6 — Shared states

Every page renders through one `<DataState>` boundary with four explicit
states — loading, empty, error (with the failing request named and a retry),
and degraded (data present but stale or partial, with the reason). `docs/06`
lists these as requirements; making them one component makes omitting them
harder than including them.

## Consequences

- Eleven packages join the lockfile (nine runtime, two dev). All permissive;
  none copied into the tree, so `docs/PROVENANCE.md` gains no entry.
- `packages/dashboard/tsconfig.json` and the ESLint boundary rules are
  unchanged in intent; the boundary test's `App.tsx` path may need to follow
  the file if it moves, and the CSRF-header agreement test still reads
  `api.ts`, which does not move.
- The first component test on this project runs under `jsdom`. If the
  per-file environment pragma is ever dropped in favour of a global switch, the
  2,388 node tests would run in a browser shim — the pragma is the guard, and
  a test asserts the config's default environment is still `node`.
- Slice 8's pages are the first real test of D3's navigation model and D6's
  states. If either needs restructuring there, amend this ADR rather than
  work around it.

## Rejected

- **A CSS-in-JS or component library (MUI, Chakra, Mantine).** A second
  design system to fight, and a runtime the loopback console does not need.
- **shadcn's CLI.** Vendors code into the tree; every file becomes a
  `PROVENANCE.md` entry the project must maintain (spec §5).
- **Bundling a typeface.** A binary asset in the repository and a rule 7
  question for the font's licence, to solve a problem the system stack does
  not have on a console one person reads.
- **Skipping component tests because the spec's proof is the route tests.**
  The route tests prove the *API contract* held. They cannot see a route that
  renders nothing, a modal that traps no focus, or a strip that is amber when
  nothing is held.
