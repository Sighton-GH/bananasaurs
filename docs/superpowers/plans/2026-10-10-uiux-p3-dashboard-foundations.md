# P3 — Dashboard foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `docs/superpowers/plans/2026-10-10-uiux-00-glm-handoff.md` first.

**Goal:** The dashboard gets a light-first theme that passes WCAG AA in both themes, the Inter font, Lucide
icons, the missing UI primitives, one states kit, crash boundaries and the accessibility basics. Pages are
**not** redesigned here; P5 sweeps them. The only page edits are colour fixes.

**Architecture:**
- Tokens live only in `packages/dashboard/src/styles.css`. A test parses that file and checks every contrast
  pair.
- Primitives are hand-written React components in `packages/dashboard/src/ui/`, on the Radix packages
  already installed. Each has a keyboard and ARIA test.
- `DataState` routes every resource to one of the states-kit components.
- Two error boundaries sit in `Shell`.

**Tech stack:** React 19, Tailwind v4, Radix (already installed), wouter, Vitest with jsdom and Testing
Library. New:
- `@fontsource-variable/inter` **5.3.0**: the UI font, self-hosted through the Vite build (OFL-1.1).
- `lucide-react` **1.48.0**: the icon set, tree-shaken, imported through one module (ISC).
- `@testing-library/user-event` **14.6.7**, dev only: real keyboard events for the Radix primitives' tests
  (MIT).

**Spec:** `docs/superpowers/specs/2026-10-10-ui-ux-overhaul-design.md` §7, §8.3. **Decisions:**
`docs/decisions/0142-dashboard-light-first-theme-fonts-icons.md`; the ADR wins where the two differ.
**Rules:** `docs/28_UI_UX_GUIDELINES.md` §4, §5.2, §7.

**Base:** branch `uiux/p3-dashboard-foundations`, cut from `uiux/p2-logs-moderation`. P3 shares no code
with P1 or P2. If the owner wants the dashboard first, cut it from `worktree-ui-ux-overhaul-spec` instead;
nothing below changes.

## Global Constraints

- **No `node:*` import anywhere under `packages/dashboard`**, tests included; ESLint bans it. Read files in
  tests with Vite's `?raw` suffix and `import.meta.glob`.
- **Pages import icons only from `src/ui/icons.ts`.** ESLint enforces this after Task 4.
- **No hex colour and no Tailwind palette colour** (`blue-700`, `amber-50`, `slate-800` …) in any `.tsx`
  file. Use the tokens. A test enforces this after Task 3.
- Every new interactive primitive:
  - is reachable and operable with the keyboard
  - has a visible focus ring (`outline-accent`)
  - has an accessible name
  - has a test that drives it with `userEvent`
- Copy follows `docs/28` §2–§3. Use strings from this plan verbatim.
- Tests that render components start with `// @vitest-environment jsdom`, like every existing dashboard
  test.
- Don't change any page's layout or behaviour. Colour-class fixes in Task 3 and the shell changes in
  Tasks 10 and 11 are the only page-level edits.

## Review Focus

1. **Contrast is measured, not eyeballed.** `theme.contrast.test.ts` (Task 2) must fail if any pair in
   ADR 0142's table drops below its threshold, or if the dark media-query block and the
   `data-theme='dark'` block differ. Change one value by hand and watch it fail before trusting it.
2. **A crash in one page leaves navigation working.** In Task 10's test, a route throws, the rail still
   renders, and navigating away clears the crash.
3. **403 is not "failed to load".** `DataState` with a 403 shows Forbidden with the server's words, and
   never a retry button that cannot work (Task 9).
4. **Errors are announced assertively, success politely.** Task 8's toast test checks the two regions.
5. **The first visit is light, and a saved choice is kept.** Task 1's theme test covers no saved value,
   `light`, `dark` and `system`.

## File structure

| File | Responsibility |
| --- | --- |
| `packages/dashboard/package.json`, `package-lock.json` | three dependencies |
| `packages/dashboard/src/main.tsx` | font import, theme boot first |
| `packages/dashboard/src/app/theme-boot.ts` | create: set `data-theme` before React mounts |
| `packages/dashboard/src/app/theme.tsx` | modify: light default |
| `packages/dashboard/src/styles.css` | rewrite tokens: light-first, tones, type roles |
| `packages/dashboard/src/theme.contrast.test.ts` | create: WCAG checks over `styles.css` |
| `packages/dashboard/src/no-raw-colours.test.ts` | create: the palette-class guard |
| `packages/dashboard/src/ui/icons.ts` | create: the one Lucide import site |
| `eslint.config.js` | modify: restrict `lucide-react` |
| `packages/dashboard/src/ui/{Button,Badge,Card,Field}.tsx` | modify: tokens, states, sizes |
| `packages/dashboard/src/ui/{Spinner,Select,Textarea,RadioGroup,Link,Kbd}.tsx` | create |
| `packages/dashboard/src/ui/{Tabs,DropdownMenu,Tooltip,DescriptionList,KeyValueTable,CodeBlock,Pagination}.tsx` | create |
| `packages/dashboard/src/ui/{Skeleton,ProgressBar,InlineAlert,Banner,ErrorSummary}.tsx`, `Toast.tsx` | create / modify |
| `packages/dashboard/src/ui/states.tsx`, `DataState.tsx`, `hooks/useDelayedFlag.ts` | states kit |
| `packages/dashboard/src/app/CrashBoundary.tsx`, `Shell.tsx` | crash boundaries |
| `packages/dashboard/src/app/routes.ts`, `Shell.tsx` | skip link, main focus, tab titles |
| `packages/dashboard/src/pages/kit.tsx` | create: `/kit`, owner-only |
| `docs/28_UI_UX_GUIDELINES.md`, `docs/STATE.md` | final values, state entry |

---

### Task 1: Dependencies, Inter, and a light first visit

**Files:**
- Modify: `packages/dashboard/package.json` (and the root `package-lock.json` through npm)
- Modify: `packages/dashboard/src/main.tsx`
- Create: `packages/dashboard/src/app/theme-boot.ts`, `theme-boot.test.ts`
- Modify: `packages/dashboard/src/app/theme.tsx`, `theme.test.tsx`

**Interfaces:**
- Produces:
  - `bootTheme(storage: Pick<Storage, 'getItem'>, root: HTMLElement): void`
  - `THEME_STORAGE_KEY = 'bananasaurs-theme'`, exported from `theme-boot.ts` and used by `theme.tsx`
  - `readChoice()` returns `'light'` when nothing is saved

- [ ] **Step 1: Install exactly these versions**

```bash
npm install --workspace @bananasaurs/dashboard --save-exact @fontsource-variable/inter@5.3.0 lucide-react@1.48.0
npm install --workspace @bananasaurs/dashboard --save-dev --save-exact @testing-library/user-event@14.6.7
```

Check `packages/dashboard/package.json`. It must list those three exact versions and nothing else new. If
npm installed another top-level package, undo it and report it as a deviation.

- [ ] **Step 2: Failing tests**

`packages/dashboard/src/app/theme-boot.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { bootTheme, THEME_STORAGE_KEY } from './theme-boot.js';

const store = (value: string | null) => ({ getItem: (k: string) => (k === THEME_STORAGE_KEY ? value : null) });

afterEach(() => document.documentElement.removeAttribute('data-theme'));

describe('bootTheme (ADR 0142 decision 2)', () => {
  it('a first visit is light', () => {
    bootTheme(store(null), document.documentElement);
    expect(document.documentElement.dataset['theme']).toBe('light');
  });
  it.each(['light', 'dark'])('a saved %s is kept', (saved) => {
    bootTheme(store(saved), document.documentElement);
    expect(document.documentElement.dataset['theme']).toBe(saved);
  });
  it('a saved "system" sets no attribute, so the media query decides', () => {
    bootTheme(store('system'), document.documentElement);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
  it('a storage that throws (private mode) still gives light', () => {
    bootTheme({ getItem: () => { throw new Error('denied'); } }, document.documentElement);
    expect(document.documentElement.dataset['theme']).toBe('light');
  });
});
```

In `theme.test.tsx`, change the test that expects `'system'` with an empty store so it expects `'light'`,
and add a test that a stored `'system'` still reports `choice: 'system'`. Keep the other tests.

Run `npx vitest run packages/dashboard/src/app`. Expect FAIL.

- [ ] **Step 3: Implement**

`packages/dashboard/src/app/theme-boot.ts`:

```ts
/**
 * Runs before React mounts (imported first in main.tsx), so a first visit on
 * a dark-OS machine does not flash dark before turning light (ADR 0142
 * decision 2). A module, not an inline script, so the CSP stays as it is.
 */
export const THEME_STORAGE_KEY = 'bananasaurs-theme';

export const bootTheme = (storage: Pick<Storage, 'getItem'>, root: HTMLElement): void => {
  let saved: string | null = null;
  try {
    saved = storage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Storage blocked: fall through to the light default.
  }
  if (saved === 'system') {
    root.removeAttribute('data-theme');
    return;
  }
  root.setAttribute('data-theme', saved === 'dark' ? 'dark' : 'light');
};
```

`theme.tsx`:
- Import `THEME_STORAGE_KEY` and drop the local `STORAGE_KEY`.
- `readChoice` returns `'light'`, `'dark'`, `'system'` or (when nothing is stored) `'light'`. Wrap the read
  in `try`.
- Update the docstring: "A first visit is light (ADR 0142). A saved choice wins; a saved `system` follows
  the OS."

`main.tsx`, the first lines:

```ts
import { bootTheme } from './app/theme-boot.js';
bootTheme(window.localStorage, document.documentElement);
import '@fontsource-variable/inter';
```

ES modules hoist imports, so `bootTheme` runs after every import, but still before
`createRoot(...).render(...)`. That is early enough, because nothing paints before the first render. Leave
the remaining imports as they are.

- [ ] **Step 4: Gates and commit**

```bash
npx vitest run packages/dashboard/src/app
npm run typecheck
npm run lint
npm run test
npm run build
git add packages/dashboard package-lock.json
git commit -m "P3 Task 1: Inter, Lucide, user-event; a first visit is light"
```

`npm run build` must emit `inter-*.woff2` files under `packages/dashboard/dist/assets/`. Check that they
are there. The daemon serves `dist`, so no external request is made.

---

### Task 2: Light-first tokens and the contrast test

**Files:**
- Modify: `packages/dashboard/src/styles.css`
- Create: `packages/dashboard/src/theme.contrast.test.ts`

**Interfaces:**
- Produces these Tailwind utilities, among others: `bg-sunk`, `border-line-strong`, `text-ink-faint`,
  `bg-accent`, `text-accent`, `text-accent-ink`, `bg-accent-bg`, `bg-tone-<t>`, `bg-tone-<t>-bg`,
  `text-tone-<t>-ink`, `border-tone-<t>`, `font-mono`, `text-title`, `text-section`, `text-body`,
  `text-small`, `text-caption`, `rounded-control`, `rounded-panel`, `shadow-float`. Here `<t>` is one of
  `neutral`, `progress`, `hold`, `ok` and `danger`.
- These existing utilities keep working, with new values:
  - `bg-canvas`, `bg-panel`, `border-line`, `text-ink`, `text-ink-muted`
  - `bg-hold`, `text-hold-ink`
  - `text-danger`, `border-danger`, `text-ok`, `border-ok`

- [ ] **Step 1: The failing contrast test**

`packages/dashboard/src/theme.contrast.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import css from './styles.css?raw';

/** `--color-x: #rrggbb;` pairs inside the first block whose header matches. */
const block = (header: RegExp): Record<string, string> => {
  const start = css.search(header);
  if (start < 0) throw new Error(`no block ${header}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < css.length; end++) {
    if (css[end] === '{') depth++;
    if (css[end] === '}' && --depth === 0) break;
  }
  const body = css.slice(open + 1, end);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[m[1]!] = m[2]!.toLowerCase();
  return out;
};

const lum = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
};
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const LIGHT = block(/@theme\s*\{/);
const DARK = block(/:root\[data-theme='dark'\]\s*\{/);
const DARK_MEDIA = block(/:root:not\(\[data-theme\]\)\s*\{/);

const TEXT = 4.5;
const UI = 3;
const TONES = ['neutral', 'progress', 'hold', 'ok', 'danger'] as const;

const PAIRS: [fg: string, bg: string, min: number][] = [
  ['ink', 'canvas', TEXT],
  ['ink', 'panel', TEXT],
  ['ink', 'sunk', TEXT],
  ['ink-muted', 'canvas', TEXT],
  ['ink-muted', 'panel', TEXT],
  ['ink-muted', 'sunk', TEXT],
  ['ink-faint', 'panel', UI],
  ['line-strong', 'panel', UI],
  ['line-strong', 'canvas', UI],
  ['accent', 'panel', TEXT],
  ['accent', 'canvas', TEXT],
  ['accent-ink', 'accent', TEXT],
  ['accent', 'accent-bg', TEXT],
  ['danger', 'panel', TEXT],
  ['danger', 'canvas', TEXT],
  ['ok', 'panel', TEXT],
  ['hold-ink', 'hold', TEXT],
  ...TONES.flatMap((t): [string, string, number][] => [
    [`tone-${t}-ink`, `tone-${t}-bg`, TEXT],
    [`tone-${t}`, 'panel', UI],
    [`tone-${t}`, 'canvas', UI],
  ]),
];

describe.each([
  ['light', LIGHT],
  ['dark', DARK],
])('%s theme (ADR 0142 decision 1)', (_name, theme) => {
  it.each(PAIRS)('%s on %s ≥ %d:1', (fg, bg, min) => {
    expect(theme[fg], `--color-${fg} missing`).toBeDefined();
    expect(theme[bg], `--color-${bg} missing`).toBeDefined();
    expect(ratio(theme[fg]!, theme[bg]!)).toBeGreaterThanOrEqual(min);
  });
});

it('the dark media block and the data-theme block are identical', () => {
  expect(DARK_MEDIA).toEqual(DARK);
});

it('dark redefines every light token', () => {
  expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort());
});
```

`danger`, `ok` and `hold-ink` must be literal hex values in **both** blocks for the parser to see them.
They are aliases by value, so repeat the `-ink` value rather than writing `var(...)`.

Run `npx vitest run packages/dashboard/src/theme.contrast.test.ts`. Expect FAIL: the tokens don't exist
yet.

- [ ] **Step 2: Rewrite the tokens**

Replace the `@theme` block and the three theme blocks in `@layer base` of `styles.css`. Keep everything
after them (`html`, `body`, the backdrop, `h1–h3`, `a`, focus, reduced motion, utilities). Change
`:focus-visible` as shown below.

```css
/*
 * The design tokens (ADR 0043 D4, amended by ADR 0142). Light-first: these
 * are the light values; dark redefines every one of them below. Contrast is
 * checked by theme.contrast.test.ts — change a value and run it.
 */
@theme {
  --color-canvas: #f8f6f0;
  --color-panel: #ffffff;
  --color-sunk: #f1eee5;
  --color-line: #e5e1d6;
  --color-line-strong: #8a8577;
  --color-ink: #14213d;
  --color-ink-muted: #596377;
  --color-ink-faint: #8a93a3;
  --color-accent: #2f5bd3;
  --color-accent-ink: #ffffff;
  --color-accent-bg: #e8eefc;

  --color-tone-neutral: #64748b;
  --color-tone-neutral-bg: #eef1f5;
  --color-tone-neutral-ink: #3f4b5e;
  --color-tone-progress: #3b82f6;
  --color-tone-progress-bg: #e6f0fe;
  --color-tone-progress-ink: #1d4ed8;
  --color-tone-hold: #b8800f;
  --color-tone-hold-bg: #fdf3dc;
  --color-tone-hold-ink: #7a5208;
  --color-tone-ok: #2e9a62;
  --color-tone-ok-bg: #e3f4ea;
  --color-tone-ok-ink: #1d6b43;
  --color-tone-danger: #d64545;
  --color-tone-danger-bg: #fce8e8;
  --color-tone-danger-ink: #a42626;

  /* Old names, kept so every page still works (ADR 0142 decision 1). */
  --color-hold: #b8800f;
  --color-hold-ink: #1a1405;
  --color-danger: #a42626;
  --color-ok: #1d6b43;

  --backdrop-glow-a: rgb(201 138 18 / 0.1);
  --backdrop-glow-b: rgb(46 154 98 / 0.08);
  --backdrop-art-opacity: 0.22;

  --font-sans: 'Inter Variable', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --font-mono: ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace;

  /* Type roles (docs/28 §7.3). The old xs…2xl names stay for unswept pages. */
  --text-title: 1.5rem;
  --text-title--line-height: 2rem;
  --text-section: 1rem;
  --text-section--line-height: 1.5rem;
  --text-body: 0.875rem;
  --text-body--line-height: 1.25rem;
  --text-small: 0.8125rem;
  --text-small--line-height: 1.125rem;
  --text-caption: 0.75rem;
  --text-caption--line-height: 1rem;
  --text-xs: 0.75rem;
  --text-sm: 0.8125rem;
  --text-base: 0.875rem;
  --text-lg: 1rem;
  --text-xl: 1.25rem;
  --text-2xl: 1.5rem;

  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
  --radius-control: 0.375rem;
  --radius-panel: 0.625rem;

  --shadow-float: 0 8px 24px rgb(20 33 61 / 0.12), 0 2px 6px rgb(20 33 61 / 0.08);
}
```

Write the dark values from ADR 0142's table into **both** of these blocks, with identical contents:

```css
@layer base {
  :root {
    color-scheme: light dark;
  }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme]) {
      /* dark values — identical to the block below (the test enforces it) */
    }
  }

  :root[data-theme='dark'] {
    /* dark values */
  }

  :root[data-theme='light'] {
    color-scheme: light;
  }
  :root[data-theme='dark'] {
    color-scheme: dark;
  }
```

The dark aliases are `--color-hold: #f2b441`, `--color-hold-ink: #1a1405`, `--color-danger: #ffadad` and
`--color-ok: #86ddb0`. The dark glows are `rgb(242 180 65 / 0.08)` and `rgb(76 194 138 / 0.06)`, and the
art opacity is `0.28`. The dark `--shadow-float` is `0 8px 24px rgb(0 0 0 / 0.45), 0 2px 6px rgb(0 0 0 /
0.3)`. `--shadow-float` is not a colour token, so the parser ignores it.

The old `:root[data-theme='light']` block is now redundant: light is the `@theme` default. Keep only the
`color-scheme` line shown above.

Change `:focus-visible` to:

```css
  :focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
```

Add `font-feature-settings: 'cv11', 'ss01';` to `body`. This turns on Inter's single-storey "a" and open
digits, and the `tabular-nums` rule on `html` stays as it is.

- [ ] **Step 3: Watch the test guard**

Run the contrast test and expect PASS. Then change `--color-ink-muted` in the light block to `#8a93a3`. The
`ink-muted on panel` row must fail. Revert the change and run again, and expect PASS. Do the same for one
dark value. Note both runs in the commit message.

- [ ] **Step 4: Gates and commit**

```bash
npx vitest run packages/dashboard
npm run typecheck
npm run lint
npm run test
npm run build
git add packages/dashboard/src/styles.css packages/dashboard/src/theme.contrast.test.ts
git commit -m "P3 Task 2: light-first tokens with tones; contrast test over styles.css"
```

---

### Task 3: Fix the undefined accent and the hard-coded colours

**Files:**
- Create: `packages/dashboard/src/no-raw-colours.test.ts`
- Modify: `pages/doctor.tsx`, `pages/mcp.tsx`, `pages/archive.tsx`, `pages/permissions.tsx`,
  `pages/panel-builder.tsx` (accent, which now exists: check that they render)
- Modify: `pages/tasks.tsx`, `pages/task-posts-switch.tsx`, `pages/task-teams.tsx`, `pages/task-detail.tsx`,
  `pages/docs.tsx`, `ui/TaskPostsBanner.tsx` (palette classes)

- [ ] **Step 1: The failing guard**

`packages/dashboard/src/no-raw-colours.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

const files = import.meta.glob('./**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const PALETTE =
  /\b(?:text|bg|border|ring|outline|from|to|via|fill|stroke|decoration|divide|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
const HEX = /#[0-9a-fA-F]{6}\b/g;

describe('no raw colours in components (docs/28 §8, ADR 0142)', () => {
  it.each(Object.keys(files).filter((f) => !f.endsWith('.test.tsx')))('%s uses tokens only', (file) => {
    const src = files[file]!;
    expect(src.match(PALETTE) ?? []).toEqual([]);
    expect(src.match(HEX) ?? []).toEqual([]);
  });
});
```

Run it. It fails on the files listed above.

- [ ] **Step 2: Replace each class**

| Was | Now |
| --- | --- |
| `text-blue-700 underline` on a link | `text-accent underline underline-offset-2` |
| `hover:border-blue-500 hover:text-blue-700` (docs nav) | `hover:border-accent hover:text-accent` |
| `[&_a]:text-blue-700` | `[&_a]:text-accent` |
| `border-blue-200 bg-blue-50 … text-slate-800` (an info box) | `border-tone-progress bg-tone-progress-bg … text-tone-progress-ink` |
| `border-amber-300 bg-amber-50 … text-slate-800` (task-posts-off warning, `TaskPostsBanner`) | `border-tone-hold bg-tone-hold-bg … text-tone-hold-ink` |

`TaskPostsBanner` and `task-posts-switch` are now theme-aware, which was the bug the spec named.

Task 6 adds a `Link` primitive. Do **not** swap these links to it now; P5 does that page by page. This task
changes classes only.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run packages/dashboard
npm run typecheck
npm run lint
npm run test
git add packages/dashboard/src
git commit -m "P3 Task 3: palette classes become tokens; guard test"
```

---

### Task 4: Icons through one module

**Files:**
- Create: `packages/dashboard/src/ui/icons.ts`, `icons.test.tsx`
- Modify: `eslint.config.js`
- Modify: `packages/dashboard/src/ui/ThemeToggle.tsx` (drop the hand-drawn SVGs)

**Interfaces:**
- Produces: `Icon` (`{ icon: LucideIcon; size?: 'sm' | 'md'; label?: string; className?: string }`)
  and named re-exports. Each name is used by a primitive in Tasks 5–11 or by the toggle.

- [ ] **Step 1: `icons.ts`, test first**

`icons.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Icon, IconSun } from './icons.js';

describe('Icon (docs/28 §5.2)', () => {
  it('is decorative by default', () => {
    const { container } = render(<Icon icon={IconSun} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('stroke-width')).toBe('1.75');
  });
  it('takes a label when it stands alone', () => {
    const { getByRole } = render(<Icon icon={IconSun} size="md" label="Light mode" />);
    expect(getByRole('img', { name: 'Light mode' }).getAttribute('width')).toBe('20');
  });
});
```

`icons.ts`:

```ts
/**
 * The only file that imports lucide-react (ADR 0142 decision 4; ESLint
 * enforces it). Add an icon here, by its role, before using it on a page.
 * 16 px in dense UI, 20 px in headers, stroke 1.75, currentColor.
 */
import { createElement } from 'react';
import type { LucideIcon } from 'lucide-react';
export type { LucideIcon };
export {
  AlertTriangle as IconWarning,
  Ban as IconForbidden,
  Check as IconCheck,
  ChevronDown as IconChevronDown,
  ChevronLeft as IconChevronLeft,
  ChevronRight as IconChevronRight,
  CircleAlert as IconError,
  CircleCheck as IconSuccess,
  Clipboard as IconCopy,
  ExternalLink as IconExternal,
  Info as IconInfo,
  Loader2 as IconSpinner,
  Moon as IconMoon,
  MoreHorizontal as IconMore,
  RefreshCw as IconRefresh,
  Search as IconSearch,
  Sun as IconSun,
  X as IconClose,
  FileQuestion as IconNotFound,
  CloudOff as IconUnavailable,
  Inbox as IconEmpty,
} from 'lucide-react';

const SIZE = { sm: 16, md: 20 } as const;

export function Icon({
  icon,
  size = 'sm',
  label,
  className,
}: {
  readonly icon: LucideIcon;
  readonly size?: 'sm' | 'md';
  readonly label?: string;
  readonly className?: string;
}) {
  return createElement(icon, {
    size: SIZE[size],
    strokeWidth: 1.75,
    className,
    ...(label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label }),
  });
}
```

Lucide renames icons between majors. If `tsc` says one of these names does not exist in 1.48.0, look up its
current name in `node_modules/lucide-react/dist/lucide-react.d.ts` and use that. Keep the `Icon*` alias the
same.

`icons.ts` uses `createElement` so it can stay a `.ts` file. If the project's lint prefers `.tsx` for
JSX, rename it to `icons.tsx` and update the ESLint path in Step 2 to match.

- [ ] **Step 2: ESLint**

In `eslint.config.js`, the dashboard block:
- Add `ignores: ['packages/dashboard/src/ui/icons.ts']`.
- Add a second group to its `ban(...)` call:

  ```js
      [['lucide-react', 'lucide-react/*'], 'Import icons from src/ui/icons.ts so the set stays small and reviewable (ADR 0142 decision 4).'],
  ```

Then add a block right after it, for `icons.ts` alone. It repeats the server-code group **without** the
Lucide group. Flat config resolves a repeated rule id by last-wins, as the file's own comment explains, so
the file must still get the server-code ban:

```js
  {
    files: ['packages/dashboard/src/ui/icons.ts'],
    rules: ban([
      [...REST_PORT, ...DB, ...DISCORD_JS, '@bananasaurs/storage', '@bananasaurs/http', '@bananasaurs/discord', '@bananasaurs/discord/*', 'fastify', 'node:*'],
      'The dashboard builds to static assets with Vite and must not import server code (docs/19 §1). Talk to the API over HTTP.',
    ]),
  },
```

Lift that list and message into two consts (`DASHBOARD_SERVER_BAN`, `DASHBOARD_SERVER_MESSAGE`), so the
two blocks cannot drift.

Prove the guard works: add `import { Sun } from 'lucide-react';` to `ThemeToggle.tsx`, run
`npm run lint`, and see the error. Then remove the line.

- [ ] **Step 3: The toggle**

In `ThemeToggle.tsx`, delete `SunIcon` and `MoonIcon`, and use `<Icon icon={IconSun} size="md" />` and
`<Icon icon={IconMoon} size="md" />`. Keep its label, title and behaviour. Its classes become
`border-line-strong bg-panel text-ink hover:bg-sunk`.

- [ ] **Step 4: Gates and commit**

```bash
npx vitest run packages/dashboard/src/ui
npm run typecheck
npm run lint
npm run test
git add eslint.config.js packages/dashboard/src/ui
git commit -m "P3 Task 4: icons through one module; lucide-react restricted"
```

---

### Task 5: Button, Badge, Card, Field and Spinner

**Files:**
- Create: `packages/dashboard/src/ui/Spinner.tsx`
- Modify: `packages/dashboard/src/ui/{Button,Badge,Card,Field}.tsx` and their tests (create `Button.test.tsx`
  and `Badge.test.tsx` if missing)

**Interfaces:**
- `Button`:
  - `variant`: `'default' | 'primary' | 'danger' | 'subtle'`. `default` stays the default.
  - `size`: `'sm' | 'md'`, default `'md'`.
  - `busy`: shows a spinner before the label and keeps the width.
  - `icon?: LucideIcon`: a leading icon.
- `Badge`:
  - `tone`: `'neutral' | 'accent' | 'progress' | 'hold' | 'ok' | 'danger'`.
  - `icon?: LucideIcon`.
- `Card`: `title?`, `description?`, `actions?` (the header row) and `padding`: `'md' | 'none'`.
- `Field`:
  - `optional?: boolean` appends ` (optional)` to the label.
  - `error` shows a `tone-danger` border on the control and an error icon before the text.
- `Input` uses `border-line-strong`. When `aria-invalid` is set, it shows `border-tone-danger`.
- `Spinner({ label?: string; size?: 'sm' | 'md' })` is `role="status"` when it has a label, and
  decorative otherwise.

- [ ] **Step 1: Failing tests**

Write one test per new behaviour:
- A primary button has the `bg-accent text-accent-ink` classes.
- A busy button is `disabled`, has `aria-busy="true"` and holds a decorative spinner. Its accessible name is
  still its label.
- A subtle button has no border class.
- A Badge with `tone="progress"` uses `bg-tone-progress-bg text-tone-progress-ink border-tone-progress`.
- A Badge with an icon renders the icon decoratively, before the text.
- Field `optional` renders the label `Name (optional)`. The control's accessible name is `Name
  (optional)`.
- Field `error` sets `aria-invalid`. The error text is in `aria-describedby`, and the input has
  `border-tone-danger`.
- A Spinner with a label is `role="status"` and named by the label.

Run them. Expect FAIL.

- [ ] **Step 2: Implement**

`Button.tsx`, the variant and size tables:

```ts
const VARIANT: Record<ButtonVariant, string> = {
  default: 'border-line-strong bg-panel text-ink hover:bg-sunk active:bg-line',
  primary: 'border-accent bg-accent text-accent-ink hover:brightness-110 active:brightness-95',
  danger: 'border-tone-danger bg-panel text-danger hover:bg-tone-danger-bg',
  subtle: 'border-transparent bg-transparent text-ink hover:bg-sunk',
};
const SIZE = { sm: 'h-7 px-2 text-small', md: 'h-9 px-3 text-body' } as const;
```

The base classes are:

```
inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control border font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50
```

Keep the existing `type` default and the `busy` semantics. When `busy`, render `<Spinner size="sm" />`
first. When `icon` is set and the button is not busy, render `<Icon icon={icon} />` first.

`Spinner.tsx`:

```tsx
import { Icon, IconSpinner } from './icons.js';

/** A small indeterminate spinner (docs/28 §7.7: for small regions up to 3 s). */
export function Spinner({ label, size = 'sm' }: { readonly label?: string; readonly size?: 'sm' | 'md' }) {
  const glyph = <Icon icon={IconSpinner} size={size} className="animate-spin motion-reduce:animate-none" />;
  if (label === undefined) return glyph;
  return (
    <span role="status" aria-label={label} className="inline-flex items-center">
      {glyph}
    </span>
  );
}
```

Badge tones:

```ts
const TONE: Record<BadgeTone, string> = {
  neutral: 'border-tone-neutral bg-tone-neutral-bg text-tone-neutral-ink',
  accent: 'border-accent bg-accent-bg text-accent',
  progress: 'border-tone-progress bg-tone-progress-bg text-tone-progress-ink',
  hold: 'border-tone-hold bg-tone-hold-bg text-tone-hold-ink',
  ok: 'border-tone-ok bg-tone-ok-bg text-tone-ok-ink',
  danger: 'border-tone-danger bg-tone-danger-bg text-tone-danger-ink',
};
```

The base classes are `inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-caption
font-medium whitespace-nowrap`.

**`hold` changes look.** It was solid amber with dark ink, and it becomes a tinted fill. The docstring's
"the one accent" sentence becomes "amber means held or waiting (docs/28 §4)". Update any test that asserted
`bg-hold`.

Card: a `rounded-panel border border-line bg-panel` section. With `title`, it has a header row: the title
in `text-section font-semibold`, the description in `text-small text-ink-muted`, and `actions` on the
right. Keep today's call sites working: `<Card>` with only children must look the same, apart from the new
radius.

Field and Input: as in Interfaces. Checkbox gets `accent-[var(--color-accent)] size-4`.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run packages/dashboard/src/ui
npm run typecheck
npm run lint
npm run test
git add packages/dashboard/src/ui
git commit -m "P3 Task 5: Button, Badge, Card, Field on the new tokens; Spinner"
```

---

### Task 6: Form primitives — Select, Textarea, RadioGroup, Link, Kbd

**Files:**
- Create: `packages/dashboard/src/ui/{Select,Textarea,RadioGroup,Link,Kbd}.tsx` and a test for each
- Create: `packages/dashboard/src/test-setup-radix.ts` (jsdom gaps Radix needs)

**Interfaces:**

```ts
export interface SelectOption { readonly value: string; readonly label: string; readonly description?: string; readonly disabled?: boolean }
export function Select(props: {
  value: string | undefined;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;          // default 'Choose…'
  disabled?: boolean;
  'aria-label'?: string;         // when not inside a Field
  'aria-describedby'?: string;   // Field injects it
  'aria-invalid'?: boolean;
  id?: string;
}): ReactElement;

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { maxLength?: number; showCount?: boolean }): ReactElement;

export function RadioGroup(props: {
  legend: string;
  name: string;
  value: string | undefined;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string; hint?: string }[];
  orientation?: 'vertical' | 'horizontal';
}): ReactElement;

export function Link(props: { href: string; children: ReactNode; className?: string }): ReactElement; // internal → wouter, http(s) → new tab + ↗ icon + "(opens in a new tab)" for screen readers
export function Kbd(props: { children: ReactNode }): ReactElement;
```

- [ ] **Step 1: jsdom gaps**

Radix Select calls `hasPointerCapture`, `scrollIntoView` and `ResizeObserver`, and jsdom has none of
them. Create `packages/dashboard/src/test-setup-radix.ts`:

```ts
/** jsdom lacks these; Radix Select and Tooltip call them. Import at the top of a test that opens one. */
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => undefined;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
if (!('ResizeObserver' in globalThis))
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
```

Import it as the first line after the environment comment in each test that opens a Radix popper.

- [ ] **Step 2: Failing tests, one file per primitive**

**Select** (`Select.test.tsx`, using `userEvent.setup()`):
1. Inside a `Field label="Team"`, the trigger is a `combobox` named `Team`, showing the placeholder
   `Choose…`.
2. Pressing Enter on the focused trigger opens a `listbox`. ArrowDown and Enter choose the second option, and
   `onValueChange` gets its value. Focus returns to the trigger.
3. Escape closes it without a change.
4. A disabled option cannot be chosen.
5. With `aria-invalid`, the trigger has `border-tone-danger`.

**Textarea:**
1. With `maxLength={500} showCount`, typing 3 characters shows `3 / 500`. The counter is
   `aria-live="polite"` and is in `aria-describedby`. Merge it with any id `Field` passes in.
2. Past 90 % of `maxLength`, the counter uses `text-tone-hold-ink`.

**RadioGroup:**
1. It renders a `fieldset` with `legend`, and each option is a `radio` named by its label.
2. Arrow keys move the selection (native radio behaviour), and `onChange` fires with the value.
3. A hint renders under its option's label and is in that radio's `aria-describedby`.

**Link:**
1. `/tasks` renders a wouter link with no `target`.
2. `https://discord.com/channels/1/2` renders `target="_blank" rel="noreferrer"`, an external icon, and
   visually hidden text ` (opens in a new tab)`. The accessible name ends with it.
3. `javascript:alert(1)` renders plain text, not a link. This is defence in depth, because hrefs can come
   from server data.

**Kbd:** it renders a `<kbd>` with `font-mono text-caption`.

Run them. Expect FAIL.

- [ ] **Step 3: Implement**

`Select.tsx` on `@radix-ui/react-select`:

```tsx
import * as RadixSelect from '@radix-ui/react-select';
import type { ReactElement } from 'react';
import { Icon, IconCheck, IconChevronDown } from './icons.js';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

/**
 * The dashboard's one select (docs/28 §7.4). Replaces raw <select> page by
 * page in P5. Radix provides the keyboard model and the listbox semantics.
 */
export function Select({
  value,
  onValueChange,
  options,
  placeholder = 'Choose…',
  disabled,
  id,
  ...aria
}: {
  readonly value: string | undefined;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean;
}): ReactElement {
  return (
    <RadixSelect.Root {...(value === undefined ? {} : { value })} onValueChange={onValueChange} disabled={disabled}>
      <RadixSelect.Trigger
        id={id}
        {...aria}
        className={`flex h-9 w-full items-center justify-between gap-2 rounded-control border bg-panel px-3 text-left text-body text-ink data-[placeholder]:text-ink-faint disabled:opacity-50 ${aria['aria-invalid'] === true ? 'border-tone-danger' : 'border-line-strong'}`}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon>
          <Icon icon={IconChevronDown} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-control border border-line bg-panel shadow-float"
        >
          <RadixSelect.Viewport className="p-1">
            {options.map((o) => (
              <RadixSelect.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex cursor-default select-none flex-col rounded-sm py-1.5 pr-2 pl-7 text-body text-ink outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-bg"
              >
                <RadixSelect.ItemIndicator className="absolute left-2 top-2">
                  <Icon icon={IconCheck} />
                </RadixSelect.ItemIndicator>
                <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                {o.description !== undefined && <span className="text-caption text-ink-muted">{o.description}</span>}
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
```

`Field` clones its child to add `aria-describedby` and `aria-invalid`, which the Select accepts. Field's
`<label>` wraps the control. A Radix trigger is a `<button>`, and a button inside a `<label>` is labelled by
it in every browser and in jsdom. Test 1 proves it. If it fails, give `Field` an `htmlFor` mode that passes
`id` to the child, and use it for Select.

Radix Select forbids an empty-string item value. Callers that need "none" use a sentinel such as
`'__none'`. Write that in the docstring.

`Textarea.tsx`: a `<textarea>` with the Input classes, plus `min-h-24 py-2`. When `showCount` and
`maxLength` are set, add a counter `<span id={countId} aria-live="polite">` under it. Track the length
from `value` when the component is controlled, and from an `onInput` count otherwise.

`RadioGroup.tsx`: a native `<fieldset>` and `<legend className="text-small text-ink-muted mb-1">`, then a
`<label>` per option with `<input type="radio" name={name} checked={value === o.value}
onChange={() => onChange(o.value)} className="size-4 accent-[var(--color-accent)]" />`. Native radios give
arrow-key behaviour for free.

`Link.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'wouter';
import { Icon, IconExternal } from './icons.js';

const CLASS = 'text-accent underline underline-offset-2 hover:no-underline';

/** Internal paths route in-app; http(s) opens a new tab and says so; anything else is not a link. */
export function Link({ href, children, className = '' }: { readonly href: string; readonly children: ReactNode; readonly className?: string }) {
  if (href.startsWith('/')) return <RouterLink href={href} className={`${CLASS} ${className}`}>{children}</RouterLink>;
  if (/^https?:\/\//i.test(href))
    return (
      <a href={href} target="_blank" rel="noreferrer" className={`${CLASS} inline-flex items-center gap-0.5 ${className}`}>
        {children}
        <Icon icon={IconExternal} className="size-3.5" />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  return <span className={className}>{children}</span>;
}
```

`Kbd.tsx`: `<kbd className="rounded-sm border border-line-strong bg-sunk px-1 font-mono text-caption">`.

- [ ] **Step 4: Gates and commit**

```bash
npx vitest run packages/dashboard/src/ui
npm run typecheck
npm run lint
npm run test
git add packages/dashboard/src
git commit -m "P3 Task 6: Select, Textarea, RadioGroup, Link, Kbd"
```

---

### Task 7: Structure primitives — Tabs, DropdownMenu, Tooltip, DescriptionList, KeyValueTable, CodeBlock, Pagination

**Files:**
- Create: `packages/dashboard/src/ui/{Tabs,DropdownMenu,Tooltip,DescriptionList,KeyValueTable,CodeBlock,Pagination}.tsx`
  and a test for each

**Interfaces:**

```ts
export function Tabs(props: {
  value: string;
  onValueChange: (v: string) => void;
  tabs: readonly { value: string; label: string; badge?: ReactNode }[];
  children: ReactNode;               // <TabPanel value=…> children
  'aria-label': string;
}): ReactElement;
export function TabPanel(props: { value: string; children: ReactNode }): ReactElement;

export function DropdownMenu(props: {
  label: string;                     // accessible name of the ⋯ trigger, e.g. "More actions for Car Team A"
  items: readonly ({ label: string; onSelect: () => void; tone?: 'danger'; disabled?: boolean } | 'separator')[];
}): ReactElement;

export function Tooltip(props: { content: string; children: ReactElement }): ReactElement;   // wraps a focusable child
export function TooltipProvider(props: { children: ReactNode }): ReactElement;                // mounted once in Shell (Task 11)

export function DescriptionList(props: { items: readonly { term: string; value: ReactNode }[]; columns?: 1 | 2 }): ReactElement;

export type KeyValue = string | number | boolean | null | readonly KeyValue[] | { readonly [k: string]: KeyValue };
export function KeyValueTable(props: { data: { readonly [k: string]: KeyValue }; caption?: string; labels?: Readonly<Record<string, string>> }): ReactElement;

export function CodeBlock(props: { code: string; language?: string; label: string; maxHeight?: number }): ReactElement;

export function Pagination(props: { page: number; pageCount: number; onPageChange: (p: number) => void; label?: string }): ReactElement;
```

- [ ] **Step 1: Failing tests**

**Tabs:**
1. It renders a `tablist` named by `aria-label`, and one `tab` per entry. The selected tab has
   `aria-selected="true"`.
2. ArrowRight moves focus **and** selection to the next tab, which is Radix's `activationMode="automatic"`.
   `onValueChange` fires.
3. Only the selected panel is in the document, and it is a `tabpanel` labelled by its tab.

**DropdownMenu:**
1. The trigger is a button named by `label`, showing the ⋯ icon.
2. Enter opens a `menu`. ArrowDown moves between `menuitem`s, and Enter calls that item's `onSelect` and
   closes the menu. Focus returns to the trigger.
3. A `tone: 'danger'` item has `text-danger`.

**Tooltip:**
1. Focusing the child shows a `tooltip` with the content, after Radix's delay. Use fake timers, or
   `findByRole`.
2. Escape hides it.
3. The child's `aria-describedby` points at the tooltip while it is open.

**DescriptionList:** a `dl` with `dt`/`dd` pairs. `columns={2}` adds `sm:grid-cols-2`.

**KeyValueTable:**
1. A flat object renders a `table` with one row per key. Keys use `labels[key]` when given; otherwise
   they are humanised (`requestTimeoutMs` → `Request timeout ms`).
2. `true` and `false` render as `Yes` and `No`, `null` renders as `—`, and numbers use `toLocaleString()`.
3. A nested object renders a nested `KeyValueTable` in the cell. An array of scalars renders a
   comma-separated list, and an array of objects renders one nested table per item.
4. Nesting deeper than 4 levels renders a `CodeBlock` of that subtree, so a pathological payload cannot blow
   the layout.

**CodeBlock:**
1. It renders `<pre><code>` with `font-mono text-small` and `aria-label={label}` on the region.
2. **Copy** writes `code` to `navigator.clipboard`. Stub it in the test. The button label changes to
   `Copied` for 2 s, announced politely.
3. With `maxHeight`, the block scrolls, and `tabindex="0"` makes it keyboard-scrollable.

**Pagination:**
1. A `nav` named `label`, default `Pages`, with **Previous**, `Page 2 of 5` and **Next** buttons.
2. Previous is disabled on the first page, and Next on the last.
3. With `pageCount` 1, it renders nothing.

Run them. Expect FAIL.

- [ ] **Step 2: Implement**

Build each on the installed Radix package (`@radix-ui/react-tabs`, `@radix-ui/react-dropdown-menu`,
`@radix-ui/react-tooltip`), or plain elements where Radix has nothing. The classes:

| Part | Classes |
| --- | --- |
| tab list | `flex gap-1 border-b border-line` |
| tab | `-mb-px border-b-2 border-transparent px-3 py-2 text-body text-ink-muted hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink data-[state=active]:font-medium` |
| menu / tooltip content | `z-50 rounded-control border border-line bg-panel p-1 shadow-float` |
| menu item | `rounded-sm px-2 py-1.5 text-body outline-none data-[highlighted]:bg-accent-bg data-[disabled]:opacity-50` |
| tooltip content | add `px-2 py-1 text-caption max-w-xs` and an arrow with `fill-panel` |
| `dl` | `grid gap-x-6 gap-y-3`; `dt` `text-caption text-ink-muted`; `dd` `text-body` |
| table | `w-full text-small`; header cells `bg-sunk text-left font-medium text-ink-muted`; cells `border-t border-line px-3 py-1.5 align-top` |
| code block | `rounded-control border border-line bg-sunk p-3 font-mono text-small overflow-auto` |

Give the DropdownMenu trigger `<Icon icon={IconMore} />` and `aria-label={label}`.

`humanise(key)` splits on camelCase, `_` and `-`, lower-cases, then capitalises the first letter. Put it in
`packages/dashboard/src/lib/humanise.ts`, with its own test.

`TooltipProvider` is Radix's `Tooltip.Provider` with `delayDuration={300}`. Task 11 mounts it in the
shell. The Tooltip test renders it locally.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run packages/dashboard/src/ui packages/dashboard/src/lib
npm run typecheck
npm run lint
npm run test
git add packages/dashboard/src
git commit -m "P3 Task 7: Tabs, DropdownMenu, Tooltip, DescriptionList, KeyValueTable, CodeBlock, Pagination"
```

---

### Task 8: Feedback — Skeleton, ProgressBar, InlineAlert, Banner, ErrorSummary, and toasts

**Files:**
- Create: `packages/dashboard/src/ui/{Skeleton,ProgressBar,InlineAlert,Banner,ErrorSummary}.tsx` and tests
- Modify: `packages/dashboard/src/ui/Toast.tsx`, `Toast.test.tsx`

**Interfaces:**

```ts
export function Skeleton(props: { lines?: number; className?: string }): ReactElement;          // aria-hidden blocks
export function ProgressBar(props: { value: number; max?: number; label: string }): ReactElement; // role=progressbar
export type AlertTone = 'info' | 'hold' | 'danger' | 'ok';
export function InlineAlert(props: { tone: AlertTone; title: string; children?: ReactNode; action?: ReactNode; reference?: string }): ReactElement;
export function Banner(props: { tone: AlertTone; children: ReactNode; action?: ReactNode; onDismiss?: () => void }): ReactElement;
export function ErrorSummary(props: { errors: readonly { fieldId: string; message: string }[]; title?: string }): ReactElement | null;
// Toast gains:
export interface ToastInput { tone; title; message?; detail?; action?: { label: string; onClick: () => void } }
```

| `AlertTone` | Tokens | Icon | Role |
| --- | --- | --- | --- |
| `info` | `tone-progress` | `IconInfo` | `status` |
| `ok` | `tone-ok` | `IconSuccess` | `status` |
| `hold` | `tone-hold` | `IconWarning` | `alert` |
| `danger` | `tone-danger` | `IconError` | `alert` |

- [ ] **Step 1: Failing tests**

**InlineAlert:**
1. `tone="danger"` renders `role="alert"`, the title in `font-medium`, the body, the action, and
   `Ref <reference>` in `font-mono text-caption` with a copy button.
2. `tone="info"` renders `role="status"`.
3. The tinted fill and ink classes match the tone (`bg-tone-danger-bg text-tone-danger-ink`).

**Banner:** it is full-width, with an icon, the text, an optional action and an optional dismiss button
named `Dismiss`. The role follows the table.

**ErrorSummary** (GOV.UK pattern, docs/28 §7.5):
1. With `errors` empty, it renders nothing.
2. With two errors, it renders `role="alert"` with the title `There's a problem` (default) and a list of
   links. Each link's `href` is `#<fieldId>` and its text is the message.
3. Clicking a link focuses the field with that id.
4. On mount it takes focus: `tabindex="-1"` and `ref.focus()` in an effect.

**ProgressBar:** `role="progressbar"`, with `aria-valuenow`, `aria-valuemin="0"`, `aria-valuemax` and
`aria-label`.

**Skeleton:** `aria-hidden="true"` blocks with `animate-pulse motion-reduce:animate-none bg-sunk`, one per
line, the last line 60 % wide.

**Toast:**
1. A `danger` or `hold` toast appears inside a container with `role="alert"` (assertive). `ok` and
   `neutral` toasts appear inside the `role="status"` (polite) container.
2. A toast with `action` shows a button with the action's label. Clicking it calls `onClick` and dismisses
   the toast.
3. Existing behaviour holds: `ok` and `neutral` auto-dismiss after 6 s, `danger` and `hold` stay.
4. An `ok` toast with an action stays for **10 s** rather than 6, so there is time to press Undo.

Run them. Expect FAIL.

- [ ] **Step 2: Implement**

- `InlineAlert`, `Banner`: a `flex gap-2 rounded-control border px-3 py-2` box from the tone table. The
  Banner has no radius and a bottom border only.
- `ErrorSummary`: a `rounded-control border-2 border-tone-danger bg-panel p-3`, with the title in
  `text-section`. The links use the Link classes but are plain `<a href="#id">` elements. On click,
  `preventDefault`, then `document.getElementById(id)?.focus()`.
- `Toast.tsx`:
  - Render two containers, both at `fixed right-4 bottom-4`: a `role="alert"` one for `danger`/`hold` and a
    `role="status" aria-live="polite"` one for the rest.
  - Stack them in a wrapping `flex flex-col gap-2`.
  - The toast surface is `rounded-panel border bg-panel shadow-float`, with the tone's border colour and a
    leading tone icon.
  - Keep the `×` dismiss button, using `IconClose` and the same `aria-label`.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run packages/dashboard/src/ui
npm run typecheck
npm run lint
npm run test
git add packages/dashboard/src/ui
git commit -m "P3 Task 8: alerts, banner, error summary, skeleton, progress; assertive error toasts with actions"
```

---

### Task 9: The states kit, and `DataState` routes to it

**Files:**
- Create: `packages/dashboard/src/hooks/useDelayedFlag.ts`, `useDelayedFlag.test.tsx`
- Create: `packages/dashboard/src/ui/states.tsx`, `states.test.tsx`
- Modify: `packages/dashboard/src/ui/DataState.tsx`, `DataState.test.tsx`
- Modify: `packages/dashboard/src/ui/EmptyState.tsx` (re-export `Empty` under the old name, so pages keep
  working)

**Interfaces:**

```ts
/** False until `ms` have passed while `active` stays true; resets when `active` goes false. */
export function useDelayedFlag(active: boolean, ms: number): boolean;

export function Loading(props: { label?: string; variant?: 'skeleton' | 'spinner'; lines?: number }): ReactElement | null;
export function Empty(props: { title: string; detail?: ReactNode; action?: ReactNode; art?: boolean }): ReactElement; // same props as today's EmptyState, plus art
export function Unavailable(props: { what: string; error: unknown; onRetry?: () => void; restIsSafe?: boolean }): ReactElement;
export function Forbidden(props: { error?: unknown; permission?: string }): ReactElement;
export function NotFound(props: { what: string; backHref?: string; backLabel?: string }): ReactElement;
export function Stale(props: { updatedAt: number; onRefresh: () => void; now?: number }): ReactElement;

// DataState gains:
//   loading → <Loading/> (nothing for 1 s, then skeleton; "Still loading…" + Try again after 10 s)
//   error 403 → <Forbidden error/>; 404 → <NotFound what={request}/>; other → <Unavailable what={request}/>
//   401 never reaches here (the session handles it) — if it does, Unavailable.
//   new optional props: notFound?: ReactNode, emptyTitle?, emptyAction?
```

**Copy** (verbatim):

| State | Text |
| --- | --- |
| `Loading` after 10 s | `Still loading. This is taking longer than usual.` + **Try again** (when a retry is given) |
| `Unavailable` | title `Couldn't load <what>`; body: the described error message; `restIsSafe` adds `The rest of this page is working.`; **Try again**; `Ref <requestId>` when present |
| `Forbidden` | title from the server's catalogue title, else `You don't have access to this`; body from the server message, else `Your account doesn't include this.`; then `Ask the owner to change your account in Accounts.` |
| `NotFound` | title `<What> doesn't exist or was deleted`; a Link back (`backLabel`, default `Go back`) |
| `Stale` | `Updated <relative time>` · **Refresh** (uses `lib/relative-time.ts`) |
| `Empty` art | `art` (default true) shows `/brand/bananasaur.png` at 64 px with `alt=""`, in place of today's `·` dot (ADR 0051 D5 allows the mark in empty states) |

- [ ] **Step 1: Failing tests**

`useDelayedFlag`: with fake timers, it is false at 0 and 999 ms, and true at 1,000 ms. Going inactive
resets it.

`states.test.tsx`: one test per row of the copy table, plus:
- `Unavailable` and `Forbidden` render `role="alert"`. `Loading` after 1 s renders a `role="status"`
  region named `Loading <label>`, and before 1 s it renders nothing.
- `Forbidden` **never** shows a Try again button (Review Focus 3).
- `Unavailable` with an `ApiError` that has `requestId: 'abc123'` shows `Ref abc123`.

`DataState.test.tsx`: keep every existing test whose behaviour is still right. Change these:
- The loading test advances timers 1 s before expecting the status.
- The error test, for a 500, expects `Couldn't load <request>` and Try again.
- New: a 403 `ApiError` with body `{ error: 'owner-only', title: 'Only the owner can do this', message: '…' }`
  shows that title and no Try again.
- New: a 404 shows the NotFound text.
- New: `degraded` still renders its hold note. It becomes `InlineAlert tone="hold"`.

Run them. Expect FAIL.

- [ ] **Step 2: Implement**

`useDelayedFlag`:

```ts
import { useEffect, useState } from 'react';

export function useDelayedFlag(active: boolean, ms: number): boolean {
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    if (!active) {
      setFlag(false);
      return;
    }
    const t = setTimeout(() => setFlag(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return flag;
}
```

`states.tsx`: compose `InlineAlert`, `Skeleton`, `Spinner`, `Link`, `Button`, `Icon` and `describeError`.
`Loading` uses two flags: `useDelayedFlag(true, 1000)` and `useDelayedFlag(true, 10_000)`. `DataState`
passes `onRetry={resource.retry}` to `Loading` for the 10-second case.

`DataState`: the branch on `resource.error` reads it with
`error instanceof ApiError ? error.status : undefined`. Import `ApiError` from `../api.js`.

`EmptyState.tsx` becomes `export { Empty as EmptyState } from './states.js';`. Today's `EmptyState` takes
`title`, `detail` and `action`, and `Empty` takes the same three, so every call site keeps working. Keep its
`aria-label={title}` section, and use `rounded-panel border-dashed border-line-strong`.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run packages/dashboard
npm run typecheck
npm run lint
npm run test
git add packages/dashboard/src
git commit -m "P3 Task 9: states kit; DataState shows Forbidden, NotFound, Unavailable and timed loading"
```

---

### Task 10: Crash boundaries

**Files:**
- Create: `packages/dashboard/src/app/CrashBoundary.tsx`, `CrashBoundary.test.tsx`
- Modify: `packages/dashboard/src/app/Shell.tsx`, `Shell.test.tsx`

**Interfaces:**

```ts
export class CrashBoundary extends Component<{ children: ReactNode; resetKey: string; scope: 'app' | 'page' }, { error?: Error; info?: ErrorInfo; at?: number }>;
export const crashDetails: (input: { error: Error; componentStack: string | undefined; route: string; at: number }) => string;
export const crashRef: (at: number) => string;   // base-36 of the timestamp's last 6 digits, upper-case, e.g. "7F3K2A"
```

**What a crash shows:**

```
┃ ⚠ This page hit a problem
┃ Something in Bananasaurs' dashboard failed while showing this page. Nothing was saved or changed.
┃ The rest of the dashboard still works — pick another page from the menu.
┃ [ Reload page ]  [ Copy details ]          -# Ref 7F3K2A · TypeError
```

When `scope` is `'app'` (the outer boundary), the second paragraph is `Reload the page to continue.`, and
there is no menu, because the shell itself crashed.

- [ ] **Step 1: Failing tests**

1. A child that throws during render shows `This page hit a problem`, the error name, a Ref, and both
   buttons. The panel is `role="alert"`.
2. **Copy details** writes `crashDetails(…)` to the clipboard. The text contains the route, the error name
   and message, and the component stack. It contains **no** API data.
3. **Reload page** calls `window.location.reload`. Stub it.
4. Changing `resetKey` clears the crash and renders the children again.
5. **Shell test (Review Focus 2):** render the shell at a route whose page component throws. Use
   `vi.mock` on one page module to make it throw. Then check:
   - the rail `nav` named `Areas` is still present
   - the crash panel is inside `main`
   - navigating to `/` renders the overview
6. The boundary logs once through `console.error` with the Ref, so it shows in the browser console. Stub
   `console.error` in the test and assert one call that contains the Ref.

Run them. Expect FAIL.

- [ ] **Step 2: Implement**

`CrashBoundary` is a class component, because React 19 still has no hook for error boundaries:
- `static getDerivedStateFromError(error)` returns `{ error, at: Date.now() }`.
- `componentDidCatch(error, info)` stores `info` and calls
  `console.error('[crash]', crashRef(at), error, info.componentStack)`.
- `componentDidUpdate(prev)` clears the state when `prev.resetKey !== this.props.resetKey` while it is
  showing a crash.
- The render uses `InlineAlert tone="danger"`, `Button` and the copy above. The Ref is shown in
  `font-mono`.

In `Shell.tsx`:
- Wrap the routed `<Switch>` (inside `main`) in
  `<CrashBoundary scope="page" resetKey={location}>`, where `location` comes from wouter's
  `useLocation()`.
- Wrap the shell's whole return in `<CrashBoundary scope="app" resetKey="app">`.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run packages/dashboard/src/app
npm run typecheck
npm run lint
npm run test
git add packages/dashboard/src/app
git commit -m "P3 Task 10: crash boundaries around the app and each page"
```

---

### Task 11: Shell accessibility — skip link, focus on navigation, page titles

**Files:**
- Modify: `packages/dashboard/src/app/routes.ts` (`pageTitle`)
- Modify: `packages/dashboard/src/app/Shell.tsx`, `Shell.test.tsx`

**Interfaces:**
- `pageTitle(path: string): string` returns the label of the longest `NAV` path that is a prefix of `path`,
  or `undefined`. `'/'` matches only `'/'`.
- `document.title` is `<label> · Bananasaurs`, or `Bananasaurs` when nothing matches.

- [ ] **Step 1: Failing tests**

1. `pageTitle('/tasks/abc')` → `'Tasks'`. `pageTitle('/assistant/history/x')` → the History label in
   `NAV`. `pageTitle('/nope')` → `undefined`. `pageTitle('/')` → `'Overview'`.
2. The shell renders a link `Skip to content` as the first focusable element: the first Tab from the body
   focuses it. Activating it moves focus to `main#main`.
3. `main` has `id="main"` and `tabIndex={-1}`.
4. After navigating from `/` to `/tasks`, `document.title` is `Tasks · Bananasaurs`, and
   `document.activeElement` is `main`. **On the first render, focus is not moved**, so a page that
   auto-focuses its own field keeps it.
5. `TooltipProvider` wraps the shell. Assert that a `Tooltip` rendered in a page does not throw.

Run them. Expect FAIL.

- [ ] **Step 2: Implement**

In `routes.ts`:

```ts
/** The rail label for a path, for the browser tab (ADR 0142 decision 8). */
export const pageTitle = (path: string): string | undefined => {
  if (path === '/') return NAV.find((n) => n.path === '/')?.label;
  let best: NavEntry | undefined;
  for (const n of NAV) {
    if (n.path === '/') continue;
    if ((path === n.path || path.startsWith(`${n.path}/`)) && (best === undefined || n.path.length > best.path.length)) best = n;
  }
  return best?.label;
};
```

In `Shell.tsx`:
- As the first child, add
  `<a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-panel focus:px-3 focus:py-2 focus:shadow-float">Skip to content</a>`.
  Give it an `onClick` that calls `preventDefault` and focuses `main`. wouter would otherwise treat the hash
  as a route change.
- `main` gets `id="main"`, `tabIndex={-1}`, `ref={mainRef}` and `className` plus `outline-none`.
- Add an effect on `location`: skip the first run (use a ref flag), then call
  `mainRef.current?.focus({ preventScroll: false })`.
- Add an effect on `location` that sets `document.title`.
- Wrap the shell content in `<TooltipProvider>`.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run packages/dashboard/src/app
npm run typecheck
npm run lint
npm run test
git add packages/dashboard/src/app
git commit -m "P3 Task 11: skip link, focus on navigation, page titles, tooltip provider"
```

---

### Task 12: The `/kit` page, docs and the final sweep

**Files:**
- Create: `packages/dashboard/src/pages/kit.tsx`, `kit.test.tsx`
- Modify: `packages/dashboard/src/app/Shell.tsx` (the route, owner-only)
- Modify: `docs/28_UI_UX_GUIDELINES.md` §4 (final values), `docs/STATE.md`

**Interfaces:**
- Route `/kit`. It is **not** in `NAV`, so the rail does not show it. A non-owner sees `Forbidden`, with
  `permission` `the instance owner`.

- [ ] **Step 1: The page**

`kit.tsx` renders, in order, each under a `<h2>` section title, inside `Card`s:

1. **Tokens.** One swatch per colour token, with its name, read from `getComputedStyle`. There is also a
   tone row: for each tone, its Badge, InlineAlert and Banner.
2. **Type.** Title, section, body, small, caption and mono, each with a sample sentence.
3. **Buttons.** Every variant in both sizes, plus disabled and busy versions, and one with an icon.
4. **Form.** A Field with Input, a Field with Select (5 options, one disabled), a Textarea with a count, a
   RadioGroup, a Checkbox, a Field with an error, and an ErrorSummary listing that error.
5. **Structure.** Tabs with three panels, a DropdownMenu, a Tooltip on a button, a DescriptionList, a
   KeyValueTable of a nested sample config, a CodeBlock of a JSON sample, and Pagination.
6. **States.** `Loading` (forced past 1 s with a `forceVisible` prop, added for the kit only), `Empty`,
   `Unavailable` (with a sample `ApiError` carrying a request id), `Forbidden`, `NotFound` and `Stale`.
7. **Feedback.** Buttons that raise each toast tone, one with Undo.
8. **Crash.** A button labelled `Throw a test error` that makes a child throw inside a local
   `CrashBoundary scope="page"`, to show the crash panel. Reset it by changing its key.

At the top, add a line: `Switch the theme with the toggle to check both. Nothing on this page changes any
data.` Add no API calls.

If `forceVisible` on `Loading` needs a prop, add it with the docstring `For the /kit page only.`

`kit.test.tsx`:
- An owner session renders every section heading.
- A non-owner session renders the Forbidden text.
- Clicking `Throw a test error` shows `This page hit a problem`, and the rest of the kit page is still
  rendered.

- [ ] **Step 2: Docs**

`docs/28_UI_UX_GUIDELINES.md` §4: replace "Values are the P0 proposal; P3 finalises…" with:

```markdown
Dashboard values are final as of ADR 0142 and are checked by
`packages/dashboard/src/theme.contrast.test.ts` in both themes. The Discord accents above are unchanged.
In the dashboard, light amber is `#b8800f` (the proposal's `#c98a12` was 2.95:1 on white).
```

Add a line under §5.2: `Pages import icons from src/ui/icons.ts only; ESLint enforces it.`

`docs/STATE.md`, at the top:

```markdown
**Dashboard foundations (ADR 0142), 2026-10-xx.** Light-first tokens checked for AA in both themes, Inter
(bundled), Lucide icons via src/ui/icons.ts, new primitives (Select, Textarea, RadioGroup, Link, Tabs,
DropdownMenu, Tooltip, DescriptionList, KeyValueTable, CodeBlock, Pagination, alerts, banner, error
summary, skeleton, progress), states kit (Forbidden/NotFound/Unavailable/Stale/timed Loading), crash
boundaries, skip link and page titles. Owner check: /kit in both themes. Pages are swept in P5.
```

- [ ] **Step 3: Final sweep and gates**

```bash
rg -n "lucide-react" packages/dashboard/src --glob '!**/icons.ts'
rg -n "Loading…" packages/dashboard/src/ui
```

The first must find nothing. The second must find nothing in `DataState.tsx`; pages may still have their
own until P5.

```bash
npm run typecheck
npm run lint
npm run test
npm run build
git add packages/dashboard docs
git commit -m "P3 Task 12: /kit page, final token values in docs/28, state"
```

---

## Self-check before handing back

- [ ] `packages/dashboard/package.json` gained exactly `@fontsource-variable/inter@5.3.0`,
      `lucide-react@1.48.0` and (dev) `@testing-library/user-event@14.6.7`, pinned without `^`.
- [ ] Review Focus 1: you watched the contrast test fail on a changed value, and wrote it in the Task 2
      commit message.
- [ ] `no-raw-colours.test.ts` passes, and you did not weaken its regexes.
- [ ] No page's behaviour changed. Existing page tests pass with, at most, colour-class or `Loading`-timing
      updates, each listed in `docs/superpowers/plans/notes/P3-deviations.md`.
- [ ] `npm run build` output contains the Inter WOFF2 files, and no `fonts.googleapis.com` string:
      `rg -n "googleapis" packages/dashboard/dist` finds nothing.
- [ ] `npm run typecheck`, `npm run lint`, `npm run test` and `npm run build` all pass, run fresh.
