# Slice 7 — Application shell: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: this plan is executed with
> `opencode-delegate:opencode-driven-development` (one opencode implementer
> session per task, one task review per task, a whole-branch review by the
> strongest model at the end). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the one-file dashboard with an application shell — routing,
design tokens, layout, navigation, and a shared component set — into which the
five existing sections migrate with no behaviour change.

**Architecture:** `App.tsx` keeps the session state machine (loading / anon /
bootstrap / authed) and, when authed, renders `<Shell>`: a left rail, a page
header, a state strip, and a `wouter` `<Switch>` of five pages. A
`SessionProvider` owns the CSRF token, the re-auth prompt and the toast region
and exposes `read`/`write`; a `HealthProvider` fetches `/api/health` once and
feeds both the Overview page and the state strip. Every page renders its data
through one `<DataState>` boundary with explicit loading / empty / error /
degraded states.

**Tech Stack:** React 19, Vite 8, Tailwind v4 (`@theme` tokens), `wouter` 3,
Radix Dialog, vitest 2 with `jsdom` per-file, `@testing-library/react`.

**Spec:** `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`
§3 Slice 7 and §5; `docs/decisions/0043-the-dashboard-stack-design-system-and-information-architecture.md`
(D1–D6 bind every task).

## Global Constraints

- **Read `docs/reports/briefs/SANDBOX_RULES.md` before running any command.**
  Explicit paths on every `rg` and `git`; gates by exit code, never through a
  pipe; `git restore` to undo experiments; never read `.env`, `data/**`,
  `backups/**`.
- **Dependencies are already installed** (commit `c5836d6`). Add none. The
  permitted imports beyond React are exactly: `tailwindcss` (CSS only),
  `wouter`, `wouter/memory-location` (tests only), `@radix-ui/react-dialog`,
  `@radix-ui/react-dropdown-menu`, `@radix-ui/react-tabs`,
  `@radix-ui/react-tooltip`, `@radix-ui/react-select`,
  `@testing-library/react` (tests only).
- **`packages/dashboard/src/api.ts` is not modified.** `apiFetch`,
  `getSession`, `ApiError`, `ReadonlyError`, `CSRF_HEADER`, `SessionInfo` and
  `NoSession` are consumed as they are. The dashboard may not import
  `@bananasaurs/*` packages (ESLint boundary rule; `packages/core/src/boundaries.test.ts`).
- **No behaviour change (ADR 0043 D5).** The migrated pages issue exactly
  these requests and no others: `GET /api/health`, `GET /api/log-routes`,
  `POST /api/log-routes` body `{ eventKind, channelId, includeContent }`,
  `GET /api/panels`, `GET /api/audit?limit=50`, `POST /api/killswitch` body
  `{ on }`, `POST /api/logout` with the CSRF header, `POST /api/login` body
  `{ username, password }`, `POST /api/bootstrap` body
  `{ token, username, password }`, and the re-auth round trip that `apiFetch`
  already performs.
- **Nothing outside `packages/dashboard/` changes** except where a task names
  a file explicitly.
- **Do not touch** `packages/storage/src/repos/automod-rules.ts`,
  `setRuleMode`, `mod_rules`, or `packages/core/src/effects/gateway.ts`. The
  observe window is running; a change there restarts its clock.
- **Design system (ADR 0043 D4), verbatim tokens:** canvas `#14181d`, panel
  `#1b2026`, line `#2b333c`, ink `#d9dfe6`, ink-muted `#8a94a0`, hold
  `#f2b441` (the only accent; state only, never on a button, never
  decorative), danger `#e5484d`, ok `#3db37a`. Light theme via
  `prefers-color-scheme`. System sans stack, 14px base, `tabular-nums`
  everywhere. No all-caps labels, no monospace for data, no card grid, no
  motion beyond what answers a click.
- **Copy:** sentence case; buttons name their effect ("Turn kill switch on");
  the confirming toast uses the same verb; empty states say what to do next;
  errors say what failed and what to try.
- **Tests:** dashboard tests are `*.test.tsx` under `packages/dashboard/src/`
  and begin with `// @vitest-environment jsdom` on line 1. They stub
  `globalThis.fetch` with `vi.stubGlobal` and assert URLs and bodies; they
  never assert class names, colours or layout. Commit at every step the
  brief marks as a commit point.
- **Every gate run alone, read by exit code:** `npm run typecheck`,
  `npm run lint`, `npm run test`.
- **Learned in Task 1 (ruling PR-41):** every `*.test.tsx` file adds
  `import { cleanup } from '@testing-library/react'` and `afterEach(cleanup)`
  — vitest `globals` is off, so RTL's auto-cleanup never registers. A `.ts`
  file may not import from a `.tsx` module (`tsconfig.all.json` has no
  `jsx`); `Resource<T>` is therefore defined in `hooks/useResource.ts` and
  re-exported from `ui/DataState.tsx` — import it from either. Optional aria
  props on `Field`'s child type spell `| undefined`
  (`exactOptionalPropertyTypes`). `packages/dashboard/tsconfig.json` and
  `eslint.config.js` were amended in Task 1 so `*.test.tsx` belongs to the
  DOM project; do not touch them again.

---

## File structure

```
packages/dashboard/src/
  main.tsx                 unchanged
  api.ts                   unchanged
  App.tsx                  session state machine only (Task 4 rewrites it)
  styles.css               Tailwind import + @theme tokens + base layer (Task 1)
  test-support.tsx         fetch stub + renderWithProviders (Task 2)
  ui/
    Button.tsx             (Task 1)
    Badge.tsx              (Task 1)
    Field.tsx              Field, Input, Checkbox (Task 1)
    DataTable.tsx          (Task 1)
    PageHeader.tsx         (Task 1)
    DataState.tsx          Resource<T> + DataState (Task 1)
    Toast.tsx              ToastProvider, useToast (Task 2)
    ConfirmDialog.tsx      Radix dialog stating scope (Task 2)
    ReauthDialog.tsx       Radix dialog for ADR 0029 (Task 2)
  hooks/
    useResource.ts         (Task 1)
  app/
    session.tsx            SessionProvider, useSession (Task 2)
    health.tsx             HealthProvider, useHealth, HealthInfo (Task 3)
    routes.ts              NAV entries (Task 4)
    StateStrip.tsx         (Task 4)
    Shell.tsx              rail + header + strip + Switch (Task 4)
  pages/
    overview.tsx           (Task 3)
    safety.tsx             (Task 3)
    logging.tsx            (Task 3)
    panels.tsx             (Task 3)
    audit.tsx              (Task 3)
    login.tsx              LoginForm, BootstrapForm moved (Task 4)
    not-found.tsx          (Task 4)
```

---

### Task 1: Tokens, base styles, and the shared primitives

**Files:**
- Modify: `packages/dashboard/src/styles.css` (replace whole file)
- Modify: `packages/dashboard/vite.config.ts`
- Create: `packages/dashboard/src/ui/Button.tsx`
- Create: `packages/dashboard/src/ui/Badge.tsx`
- Create: `packages/dashboard/src/ui/Field.tsx`
- Create: `packages/dashboard/src/ui/DataTable.tsx`
- Create: `packages/dashboard/src/ui/PageHeader.tsx`
- Create: `packages/dashboard/src/ui/DataState.tsx`
- Create: `packages/dashboard/src/hooks/useResource.ts`
- Test: `packages/dashboard/src/ui/DataState.test.tsx`
- Test: `packages/dashboard/src/ui/DataTable.test.tsx`
- Test: `packages/dashboard/src/hooks/useResource.test.tsx`
- Test: `packages/dashboard/src/vitest-environment.test.ts`

**Interfaces** (`ReactElement` is documentation for the return type — leave
return types inferred in code; `JSX` is not a global under `@types/react` 19):
- Produces:
  ```ts
  // ui/Button.tsx
  export type ButtonVariant = 'default' | 'primary' | 'danger';
  export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    readonly variant?: ButtonVariant;
    readonly busy?: boolean;
  }
  export function Button(props: ButtonProps): ReactElement;

  // ui/Badge.tsx
  export type BadgeTone = 'neutral' | 'hold' | 'danger' | 'ok';
  export function Badge(props: { readonly tone?: BadgeTone; readonly children: ReactNode }): ReactElement;

  // ui/Field.tsx
  export function Field(props: { readonly label: string; readonly hint?: string; readonly error?: string; readonly children: ReactElement }): ReactElement;
  export function Input(props: InputHTMLAttributes<HTMLInputElement>): ReactElement;
  export function Checkbox(props: InputHTMLAttributes<HTMLInputElement> & { readonly label: string }): ReactElement;

  // ui/DataTable.tsx
  export interface Column<T> { readonly key: string; readonly header: ReactNode; readonly cell: (row: T) => ReactNode; readonly numeric?: boolean }
  export function DataTable<T>(props: { readonly columns: readonly Column<T>[]; readonly rows: readonly T[]; readonly rowKey: (row: T) => string; readonly caption: string }): ReactElement;

  // ui/PageHeader.tsx
  export function PageHeader(props: { readonly title: string; readonly purpose: string; readonly actions?: ReactNode }): ReactElement;

  // ui/DataState.tsx
  export type Resource<T> =
    | { readonly state: 'loading' }
    | { readonly state: 'error'; readonly request: string; readonly message: string; readonly retry: () => void }
    | { readonly state: 'ready'; readonly data: T; readonly degraded?: string };
  export function DataState<T>(props: { readonly resource: Resource<T>; readonly isEmpty?: (data: T) => boolean; readonly empty?: ReactNode; readonly children: (data: T) => ReactNode }): ReactElement;

  // hooks/useResource.ts
  export interface UseResource<T> { readonly resource: Resource<T>; readonly reload: () => void }
  export function useResource<T>(request: string, load: () => Promise<T>): UseResource<T>;
  ```

- [ ] **Step 1: Wire Tailwind into Vite**

`packages/dashboard/vite.config.ts` — add the plugin, keep the existing comment:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Bound to the same loopback origin the daemon serves from — `server.ts`
 * mounts this build's `dist/` and falls back to `index.html` for the SPA
 * routes (`docs/19` §6.10). `npm run dev` in the daemon does not proxy to
 * Vite's dev server; a change here still needs `vite build` to reach the
 * dashboard the daemon actually serves.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
```

- [ ] **Step 2: Replace `styles.css` with the token system**

```css
@import 'tailwindcss';

/*
 * The design tokens (ADR 0043 D4). These are the only place a colour, size or
 * face is named; components use the utilities Tailwind derives from them
 * (`bg-canvas`, `text-ink-muted`, `border-line`, `bg-hold`, …). Dark first;
 * light swaps the same tokens under `prefers-color-scheme`.
 */
@theme {
  --color-canvas: #14181d;
  --color-panel: #1b2026;
  --color-line: #2b333c;
  --color-ink: #d9dfe6;
  --color-ink-muted: #8a94a0;
  --color-hold: #f2b441;
  --color-hold-ink: #1a1405;
  --color-danger: #e5484d;
  --color-ok: #3db37a;

  --font-sans:
    system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;

  --text-xs: 0.75rem;
  --text-sm: 0.8125rem;
  --text-base: 0.875rem;
  --text-lg: 1rem;
  --text-xl: 1.25rem;
  --text-2xl: 1.5rem;

  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
}

@layer base {
  :root {
    color-scheme: dark light;
  }

  @media (prefers-color-scheme: light) {
    :root {
      --color-canvas: #f4f6f8;
      --color-panel: #ffffff;
      --color-line: #d7dde3;
      --color-ink: #1b2026;
      --color-ink-muted: #5c6773;
      --color-hold: #d99a1e;
      --color-hold-ink: #1a1405;
    }
  }

  html {
    font-variant-numeric: tabular-nums;
  }

  body {
    margin: 0;
    background: var(--color-canvas);
    color: var(--color-ink);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: 1.45;
  }

  h1,
  h2,
  h3 {
    margin: 0;
    font-weight: 600;
    line-height: 1.2;
  }

  a {
    color: inherit;
  }

  :focus-visible {
    outline: 2px solid var(--color-hold);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    * {
      transition: none !important;
      animation: none !important;
    }
  }
}
```

- [ ] **Step 3: Write the primitives**

`ui/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'default' | 'primary' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  /** Disables the button and marks it busy for assistive tech while a request is in flight. */
  readonly busy?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  default: 'border-line bg-panel text-ink hover:border-ink-muted',
  primary: 'border-ink bg-ink text-canvas hover:opacity-90',
  danger: 'border-danger bg-transparent text-danger hover:bg-danger hover:text-white',
};

/**
 * Every button in the dashboard. `type` defaults to `button` so a button inside
 * a form never submits it by accident; pass `type="submit"` deliberately.
 */
export function Button({
  variant = 'default',
  busy = false,
  className = '',
  disabled,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      aria-busy={busy || undefined}
      disabled={disabled === true || busy}
      className={`inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
```

`ui/Badge.tsx`:

```tsx
import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'hold' | 'danger' | 'ok';

const TONE: Record<BadgeTone, string> = {
  neutral: 'border-line text-ink-muted',
  hold: 'border-hold bg-hold text-hold-ink',
  danger: 'border-danger text-danger',
  ok: 'border-ok text-ok',
};

/** A small inline status chip. `hold` is the one accent and means the bot is holding back. */
export function Badge({ tone = 'neutral', children }: { readonly tone?: BadgeTone; readonly children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs ${TONE[tone]}`}>
      {children}
    </span>
  );
}
```

`ui/Field.tsx`:

```tsx
import { cloneElement, isValidElement, useId, type InputHTMLAttributes, type ReactElement } from 'react';

/**
 * A labelled form control. The label wraps only its text and the control, so
 * the control's accessible name is exactly the label text; the hint and the
 * error sit outside the label with their own ids and are attached to the
 * control through `aria-describedby` (the child must be a single element —
 * an `<Input>` — for that to work).
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly children: ReactElement<{ 'aria-describedby'?: string; 'aria-invalid'?: boolean }>;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint !== undefined ? hintId : undefined, error !== undefined ? errorId : undefined]
    .filter((x): x is string => x !== undefined)
    .join(' ');
  const control = isValidElement(children)
    ? cloneElement(children, {
        'aria-describedby': describedBy === '' ? undefined : describedBy,
        'aria-invalid': error !== undefined ? true : undefined,
      })
    : children;
  return (
    <div className="text-sm">
      <label className="block">
        <span className="mb-1 block text-ink-muted">{label}</span>
        {control}
      </label>
      {hint !== undefined && (
        <span id={hintId} className="mt-1 block text-xs text-ink-muted">
          {hint}
        </span>
      )}
      {error !== undefined && (
        <span id={errorId} role="alert" className="mt-1 block text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink placeholder:text-ink-muted ${props.className ?? ''}`}
    />
  );
}

export function Checkbox({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { readonly label: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <input type="checkbox" {...rest} />
      {label}
    </label>
  );
}
```

`ui/DataTable.tsx`:

```tsx
import type { ReactNode } from 'react';

export interface Column<T> {
  readonly key: string;
  readonly header: ReactNode;
  readonly cell: (row: T) => ReactNode;
  /** Right-aligns the column; numbers already render with tabular figures. */
  readonly numeric?: boolean;
}

/**
 * Tables where the data is tabular (ADR 0043 D4): hairline rows, no zebra, a
 * visually hidden caption so screen readers know what the table is. Callers
 * decide emptiness before rendering this — an empty table is a `DataState`
 * concern, not a table one.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
}: {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly caption: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-left text-ink-muted">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`px-2 py-1.5 font-normal ${c.numeric === true ? 'text-right' : ''}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-line">
              {columns.map((c) => (
                <td key={c.key} className={`px-2 py-1.5 align-top ${c.numeric === true ? 'text-right' : ''}`}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

`ui/PageHeader.tsx`:

```tsx
import type { ReactNode } from 'react';

/** Every page opens with its name and one sentence saying what it is for (`docs/06`'s shared page pattern). */
export function PageHeader({ title, purpose, actions }: { readonly title: string; readonly purpose: string; readonly actions?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl">{title}</h1>
        <p className="mt-1 text-sm text-ink-muted">{purpose}</p>
      </div>
      {actions !== undefined && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}
```

`ui/DataState.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Button } from './Button.js';

/**
 * The four states `docs/06` requires every page to make explicit. A page
 * renders its data only through this boundary, so omitting a state is harder
 * than including one.
 */
export type Resource<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly request: string; readonly message: string; readonly retry: () => void }
  | { readonly state: 'ready'; readonly data: T; readonly degraded?: string };

export function DataState<T>({
  resource,
  isEmpty,
  empty = <p className="text-sm text-ink-muted">Nothing here yet.</p>,
  children,
}: {
  readonly resource: Resource<T>;
  readonly isEmpty?: (data: T) => boolean;
  readonly empty?: ReactNode;
  readonly children: (data: T) => ReactNode;
}) {
  if (resource.state === 'loading') {
    return (
      <p role="status" className="text-sm text-ink-muted">
        Loading…
      </p>
    );
  }
  if (resource.state === 'error') {
    return (
      <div role="alert" className="rounded-sm border border-danger px-3 py-2 text-sm">
        <p>
          Could not load {resource.request}: {resource.message}
        </p>
        <Button className="mt-2" onClick={resource.retry}>
          Try again
        </Button>
      </div>
    );
  }
  if (isEmpty?.(resource.data) === true) return <>{empty}</>;
  return (
    <>
      {resource.degraded !== undefined && (
        <p role="status" className="mb-2 rounded-sm border border-hold px-3 py-1.5 text-sm">
          {resource.degraded}
        </p>
      )}
      {children(resource.data)}
    </>
  );
}
```

`hooks/useResource.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import type { Resource } from '../ui/DataState.js';

export interface UseResource<T> {
  readonly resource: Resource<T>;
  readonly reload: () => void;
}

/**
 * Loads once on mount and again on `reload()`. `request` is the human name
 * used in the error state ("the audit log"), not the URL. A result that
 * arrives after the component re-requested is dropped, so a slow first
 * response cannot overwrite a fresh one.
 */
export function useResource<T>(request: string, load: () => Promise<T>): UseResource<T> {
  const [generation, setGeneration] = useState(0);
  const [resource, setResource] = useState<Resource<T>>({ state: 'loading' });
  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    let cancelled = false;
    setResource({ state: 'loading' });
    load().then(
      (data) => {
        if (!cancelled) setResource({ state: 'ready', data });
      },
      (err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setResource({ state: 'error', request, message, retry: reload });
      },
    );
    return () => {
      cancelled = true;
    };
    // `load` is expected to be stable (wrap it in useCallback at the call site).
  }, [generation, load, request, reload]);

  return { resource, reload };
}
```

- [ ] **Step 4: Write the tests**

`ui/DataState.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataState } from './DataState.js';

describe('DataState', () => {
  it('announces loading through a status region', () => {
    render(<DataState resource={{ state: 'loading' }}>{() => <p>never</p>}</DataState>);
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(screen.queryByText('never')).toBeNull();
  });

  it('names the failed request and offers a retry that calls back', () => {
    const retry = vi.fn();
    render(
      <DataState resource={{ state: 'error', request: 'the audit log', message: 'boom', retry }}>
        {() => <p>never</p>}
      </DataState>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Could not load the audit log: boom');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('renders the empty node instead of children when isEmpty says so', () => {
    render(
      <DataState resource={{ state: 'ready', data: [] as string[] }} isEmpty={(d) => d.length === 0} empty={<p>Add one.</p>}>
        {() => <p>never</p>}
      </DataState>,
    );
    expect(screen.getByText('Add one.')).toBeTruthy();
    expect(screen.queryByText('never')).toBeNull();
  });

  it('renders children with the data, and a degraded reason when given', () => {
    render(
      <DataState resource={{ state: 'ready', data: 'x', degraded: 'Gateway is reconnecting' }}>
        {(d) => <p>got {d}</p>}
      </DataState>,
    );
    expect(screen.getByText('got x')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Gateway is reconnecting');
  });
});
```

`ui/DataTable.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataTable } from './DataTable.js';

describe('DataTable', () => {
  it('renders one header per column, one row per item, and a caption', () => {
    render(
      <DataTable
        caption="Two people"
        columns={[
          { key: 'name', header: 'Name', cell: (r: { id: string; name: string; n: number }) => r.name },
          { key: 'n', header: 'Count', cell: (r) => r.n, numeric: true },
        ]}
        rows={[
          { id: 'a', name: 'Ada', n: 1 },
          { id: 'b', name: 'Bob', n: 2 },
        ]}
        rowKey={(r) => r.id}
      />,
    );
    expect(screen.getByRole('table', { name: 'Two people' })).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Count']);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText('Bob')).toBeTruthy();
  });
});
```

`hooks/useResource.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { useCallback } from 'react';
import { describe, expect, it } from 'vitest';
import { DataState } from '../ui/DataState.js';
import { useResource } from './useResource.js';

function Probe({ answers }: { readonly answers: Array<() => Promise<string>> }) {
  const load = useCallback(() => {
    const next = answers.shift();
    if (next === undefined) throw new Error('no answer queued');
    return next();
  }, [answers]);
  const { resource } = useResource('the thing', load);
  return <DataState resource={resource}>{(d) => <p>value: {d}</p>}</DataState>;
}

describe('useResource', () => {
  it('goes loading → ready', async () => {
    render(<Probe answers={[() => Promise.resolve('one')]} />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(await screen.findByText('value: one')).toBeTruthy();
  });

  it('goes loading → error with the request name, and retry reloads', async () => {
    render(<Probe answers={[() => Promise.reject(new Error('nope')), () => Promise.resolve('two')]} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the thing: nope');
    await act(async () => {
      screen.getByRole('button', { name: 'Try again' }).click();
    });
    expect(await screen.findByText('value: two')).toBeTruthy();
  });
});
```

`vitest-environment.test.ts` (node environment — no pragma; this guards ADR 0043's Consequence that the 2,388 existing tests keep running under node):

```ts
import { describe, expect, it } from 'vitest';
import config from '../../../vitest.config.js';

describe('the vitest default environment', () => {
  it('is node, so dashboard tests must opt into jsdom per file', () => {
    expect(config.test?.environment).toBe('node');
    expect(config.test?.include).toContain('packages/**/*.test.tsx');
  });
});
```

- [ ] **Step 5: Run the focused tests, then the gates**

Run: `npx vitest run packages/dashboard/src` — expected: all pass.
Then each gate alone by exit code. `npm run lint` will run prettier over the
new files; use `npm run lint:fix` if it reports formatting.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/styles.css packages/dashboard/vite.config.ts packages/dashboard/src/ui packages/dashboard/src/hooks packages/dashboard/src/vitest-environment.test.ts
git commit -m "feat(dashboard): design tokens and shared primitives (Slice 7 task 1)"
```

---

### Task 2: Session provider, toasts, and the two dialogs

**Files:**
- Create: `packages/dashboard/src/ui/Toast.tsx`
- Create: `packages/dashboard/src/ui/ConfirmDialog.tsx`
- Create: `packages/dashboard/src/ui/ReauthDialog.tsx`
- Create: `packages/dashboard/src/app/session.tsx`
- Create: `packages/dashboard/src/test-support.tsx`
- Test: `packages/dashboard/src/ui/Toast.test.tsx`
- Test: `packages/dashboard/src/ui/ConfirmDialog.test.tsx`
- Test: `packages/dashboard/src/app/session.test.tsx`

**Interfaces:**
- Consumes: `Button`, `Field`, `Input` from Task 1; `apiFetch`, `ApiError`,
  `ReadonlyError`, `CSRF_HEADER`, `SessionInfo` from `api.ts`.
- Produces:
  ```ts
  // ui/Toast.tsx
  export type ToastTone = 'neutral' | 'hold' | 'danger' | 'ok';
  export interface ToastInput { readonly tone: ToastTone; readonly title: string; readonly message?: string }
  export function ToastProvider(props: { readonly children: ReactNode }): ReactElement;
  export function useToast(): (toast: ToastInput) => void;

  // ui/ConfirmDialog.tsx
  export function ConfirmDialog(props: {
    readonly open: boolean;
    readonly title: string;
    readonly scope: ReactNode;          // the exact scope of the action, stated before confirming (docs/06)
    readonly confirmLabel: string;      // names the effect, e.g. "Turn kill switch on"
    readonly danger?: boolean;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
  }): ReactElement;

  // ui/ReauthDialog.tsx
  export function ReauthDialog(props: { readonly open: boolean; readonly onSubmit: (password: string) => void; readonly onCancel: () => void }): ReactElement;

  // app/session.tsx
  export interface Session {
    readonly info: SessionInfo;
    /** GET. Throws ApiError on failure so `useResource` can show it. */
    read<T>(url: string): Promise<T>;
    /** POST by default. Returns undefined — after showing a toast — on ReadonlyError or any other ApiError. */
    write<T>(url: string, body: unknown, method?: 'POST' | 'PUT' | 'DELETE'): Promise<T | undefined>;
    logout(): Promise<void>;
  }
  export function SessionProvider(props: { readonly session: SessionInfo; readonly onLoggedOut: () => void; readonly children: ReactNode }): ReactElement;
  export function useSession(): Session;

  // test-support.tsx
  export interface StubRoute { readonly method?: string; readonly url: string; readonly status?: number; readonly body: unknown }
  export function stubFetch(routes: readonly StubRoute[]): ReturnType<typeof vi.fn>;   // installs via vi.stubGlobal('fetch', …) and returns the mock
  export function bodyOf(call: unknown[]): unknown;                                    // JSON.parse of the init.body of one fetch mock call
  export const TEST_SESSION: SessionInfo;
  export function renderWithSession(ui: ReactNode, options?: { readonly session?: SessionInfo; readonly onLoggedOut?: () => void }): ReturnType<typeof render>;
  ```

- [ ] **Step 1: Toasts**

`ui/Toast.tsx`:

```tsx
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button.js';

export type ToastTone = 'neutral' | 'hold' | 'danger' | 'ok';

export interface ToastInput {
  readonly tone: ToastTone;
  readonly title: string;
  readonly message?: string;
}

interface Toast extends ToastInput {
  readonly id: number;
}

const ToastContext = createContext<((toast: ToastInput) => void) | undefined>(undefined);

/** Neutral and ok toasts leave on their own; hold and danger stay until dismissed, because they carry something the operator must read. */
const AUTO_DISMISS_MS = 6000;

const TONE: Record<ToastTone, string> = {
  neutral: 'border-line bg-panel',
  hold: 'border-hold bg-hold text-hold-ink',
  danger: 'border-danger bg-panel',
  ok: 'border-ok bg-panel',
};

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      setToasts((all) => [...all, { ...input, id }]);
      if (input.tone === 'neutral' || input.tone === 'ok') {
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      }
    },
    [dismiss],
  );

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div role="status" aria-live="polite" className="fixed right-4 bottom-4 flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`rounded-sm border px-3 py-2 text-sm ${TONE[t.tone]}`}>
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">{t.title}</p>
              <Button className="px-1.5 py-0 text-xs" onClick={() => dismiss(t.id)} aria-label={`Dismiss: ${t.title}`}>
                ×
              </Button>
            </div>
            {t.message !== undefined && <p className="mt-1">{t.message}</p>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (toast: ToastInput) => void {
  const push = useContext(ToastContext);
  if (push === undefined) throw new Error('useToast must be used inside <ToastProvider>');
  return push;
}
```

- [ ] **Step 2: The two dialogs (Radix)**

`ui/ConfirmDialog.tsx`:

```tsx
import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { Button } from './Button.js';

/**
 * A destructive or dangerous action states its exact scope before it can be
 * confirmed (`docs/06`). Radix supplies the focus trap, escape handling and
 * ARIA wiring; escape and the backdrop both cancel.
 */
export function ConfirmDialog({
  open,
  title,
  scope,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly scope: ReactNode;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-md border border-line bg-panel p-4 text-ink">
          <Dialog.Title className="text-lg">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 text-sm">{scope}</div>
          </Dialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

`ui/ReauthDialog.tsx`:

```tsx
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { Button } from './Button.js';
import { Field, Input } from './Field.js';

/**
 * ADR 0029: a sensitive write asks for the password again without leaving the
 * page. Cancelling (button, escape, backdrop) abandons the write; `apiFetch`
 * receives `undefined` and does not retry.
 */
export function ReauthDialog({
  open,
  onSubmit,
  onCancel,
}: {
  readonly open: boolean;
  readonly onSubmit: (password: string) => void;
  readonly onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-[24rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-md border border-line bg-panel p-4 text-ink">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit(password);
              setPassword('');
            }}
          >
            <Dialog.Title className="text-lg">Confirm your password</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-ink-muted">
              This action needs a recent password entry.
            </Dialog.Description>
            <div className="mt-3">
              <Field label="Password">
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
              </Field>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={onCancel}>Cancel</Button>
              <Button type="submit" variant="primary">
                Confirm
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 3: The session provider**

`app/session.tsx`:

```tsx
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { apiFetch, ApiError, CSRF_HEADER, ReadonlyError, type SessionInfo } from '../api.js';
import { ReauthDialog } from '../ui/ReauthDialog.js';
import { ToastProvider, useToast } from '../ui/Toast.js';

export interface Session {
  readonly info: SessionInfo;
  /** GET. Throws `ApiError` on failure so `useResource` can render it. */
  read<T>(url: string): Promise<T>;
  /**
   * A write. Returns `undefined` after showing a toast when the instance is
   * read-only (`ReadonlyError`) or the request failed (`ApiError`), so callers
   * refresh only on success. The re-auth round trip is `apiFetch`'s.
   */
  write<T>(url: string, body: unknown, method?: 'POST' | 'PUT' | 'DELETE'): Promise<T | undefined>;
  logout(): Promise<void>;
}

const SessionContext = createContext<Session | undefined>(undefined);

/** One outstanding re-auth request at a time, resolved by the dialog below. */
type ReauthResolver = (password: string | undefined) => void;

function SessionInner({
  session,
  onLoggedOut,
  children,
}: {
  readonly session: SessionInfo;
  readonly onLoggedOut: () => void;
  readonly children: ReactNode;
}) {
  const toast = useToast();
  const [reauth, setReauth] = useState<ReauthResolver | undefined>(undefined);

  const requireReauth = useCallback(
    (): Promise<string | undefined> =>
      new Promise((resolve) => {
        setReauth(() => (password: string | undefined) => {
          setReauth(undefined);
          resolve(password);
        });
      }),
    [],
  );

  const value = useMemo<Session>(
    () => ({
      info: session,
      read: <T,>(url: string) => apiFetch<T>(url, session.csrfToken, requireReauth),
      write: async <T,>(url: string, body: unknown, method: 'POST' | 'PUT' | 'DELETE' = 'POST') => {
        try {
          return await apiFetch<T>(url, session.csrfToken, requireReauth, { method, body: JSON.stringify(body) });
        } catch (err) {
          if (err instanceof ReadonlyError) {
            toast({ tone: 'hold', title: 'This instance is read-only', message: err.message });
            return undefined;
          }
          if (err instanceof ApiError) {
            toast({ tone: 'danger', title: 'The request failed', message: err.message });
            return undefined;
          }
          throw err;
        }
      },
      logout: async () => {
        await fetch('/api/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { [CSRF_HEADER]: session.csrfToken },
        });
        onLoggedOut();
      },
    }),
    [session, requireReauth, toast, onLoggedOut],
  );

  return (
    <SessionContext.Provider value={value}>
      {children}
      <ReauthDialog
        open={reauth !== undefined}
        onSubmit={(password) => reauth?.(password)}
        onCancel={() => reauth?.(undefined)}
      />
    </SessionContext.Provider>
  );
}

export function SessionProvider(props: {
  readonly session: SessionInfo;
  readonly onLoggedOut: () => void;
  readonly children: ReactNode;
}) {
  return (
    <ToastProvider>
      <SessionInner {...props} />
    </ToastProvider>
  );
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === undefined) throw new Error('useSession must be used inside <SessionProvider>');
  return session;
}
```

- [ ] **Step 4: Test support**

`test-support.tsx` (imported only by tests; it is under `src/` so the
tsconfig sees it, and it must not be imported by production code):

```tsx
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { SessionInfo } from './api.js';
import { SessionProvider } from './app/session.js';

export interface StubRoute {
  readonly method?: string;
  readonly url: string;
  readonly status?: number;
  readonly body: unknown;
}

/**
 * Installs a `fetch` that answers from `routes` by method + exact URL and
 * returns the mock so a test can assert what was called and with what body.
 * An unmatched request resolves 404 with `{ error: 'unstubbed' }` rather than
 * throwing, so the failure shows up as the page's error state.
 */
export function stubFetch(routes: readonly StubRoute[]) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = routes.find((r) => r.url === url && (r.method ?? 'GET').toUpperCase() === method);
    const status = route?.status ?? (route === undefined ? 404 : 200);
    const body = route?.body ?? { error: 'unstubbed', message: `${method} ${url}` };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

export function bodyOf(call: unknown[]): unknown {
  const init = call[1] as RequestInit | undefined;
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

export const TEST_SESSION: SessionInfo = {
  authenticated: true,
  accountId: 'acct-1',
  guildId: '1540816150026518620',
  csrfToken: 'csrf-test',
  expiresAt: 4102444800000,
  reauthFresh: true,
  readonly: false,
};

export function renderWithSession(
  ui: ReactNode,
  options: { readonly session?: SessionInfo; readonly onLoggedOut?: () => void } = {},
) {
  return render(
    <SessionProvider session={options.session ?? TEST_SESSION} onLoggedOut={options.onLoggedOut ?? (() => undefined)}>
      {ui}
    </SessionProvider>,
  );
}
```

- [ ] **Step 5: Tests**

`ui/Toast.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast.js';

function Trigger() {
  const toast = useToast();
  return (
    <>
      <button onClick={() => toast({ tone: 'ok', title: 'Saved' })}>ok</button>
      <button onClick={() => toast({ tone: 'danger', title: 'Failed', message: 'why' })}>danger</button>
    </>
  );
}

describe('toasts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders into a polite live region, and an ok toast leaves on its own', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('ok'));
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toContain('Saved');
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(region.textContent).not.toContain('Saved');
  });

  it('a danger toast stays until dismissed', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('danger'));
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(screen.getByRole('status').textContent).toContain('why');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Failed' }));
    expect(screen.getByRole('status').textContent).not.toContain('Failed');
  });

  it('useToast outside the provider throws', () => {
    expect(() => render(<Trigger />)).toThrow(/inside <ToastProvider>/);
  });
});
```

`ui/ConfirmDialog.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog.js';

describe('ConfirmDialog', () => {
  it('is a labelled dialog that states the scope and names the effect on its confirm button', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Turn the kill switch on?"
        scope={<p>Stops every Discord side effect for guild 123.</p>}
        confirmLabel="Turn kill switch on"
        danger
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Turn the kill switch on?' });
    expect(dialog.textContent).toContain('Stops every Discord side effect for guild 123.');
    fireEvent.click(screen.getByRole('button', { name: 'Turn kill switch on' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('escape cancels', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open title="T" scope="s" confirmLabel="Do it" onConfirm={() => undefined} onCancel={onCancel} />,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when closed', () => {
    render(
      <ConfirmDialog open={false} title="T" scope="s" confirmLabel="Do it" onConfirm={() => undefined} onCancel={() => undefined} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
```

`app/session.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { useSession } from './session.js';

function Probe() {
  const session = useSession();
  return (
    <>
      <button onClick={() => void session.write('/api/killswitch', { on: true })}>write</button>
      <button onClick={() => void session.logout()}>logout</button>
    </>
  );
}

describe('SessionProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('write sends the CSRF header and JSON body', async () => {
    const fetchMock = stubFetch([{ method: 'POST', url: '/api/killswitch', body: { ok: true, killswitch: true } }]);
    renderWithSession(<Probe />);
    await act(async () => {
      fireEvent.click(screen.getByText('write'));
    });
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('/api/killswitch');
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-bananasaurs-csrf']).toBe(TEST_SESSION.csrfToken);
    expect(bodyOf(call)).toEqual({ on: true });
  });

  it('a read-only 503 becomes a hold toast carrying the server message, not a thrown error', async () => {
    stubFetch([
      { method: 'POST', url: '/api/killswitch', status: 503, body: { error: 'read-only', message: 'BANANASAURS_READONLY is set' } },
    ]);
    renderWithSession(<Probe />);
    await act(async () => {
      fireEvent.click(screen.getByText('write'));
    });
    expect(screen.getByRole('status').textContent).toContain('BANANASAURS_READONLY is set');
  });

  it('a 401 reauth-required opens the re-auth dialog; confirming posts /api/reauth then retries once', async () => {
    let attempts = 0;
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/killswitch') {
        attempts += 1;
        return attempts === 1
          ? new Response(JSON.stringify({ error: 'reauth-required' }), { status: 401 })
          : new Response(JSON.stringify({ ok: true, killswitch: true }), { status: 200 });
      }
      if (url === '/api/reauth') {
        expect(JSON.parse(String(init?.body))).toEqual({ password: 'hunter22hunter22' });
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', mock);
    renderWithSession(<Probe />);
    await act(async () => {
      fireEvent.click(screen.getByText('write'));
    });
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your password' });
    fireEvent.change(dialog.querySelector('input[type=password]')!, { target: { value: 'hunter22hunter22' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });
    expect(attempts).toBe(2);
    expect(mock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/killswitch', '/api/reauth', '/api/killswitch']);
  });

  it('cancelling re-auth abandons the write with no retry and no reauth call', async () => {
    const mock = stubFetch([{ method: 'POST', url: '/api/killswitch', status: 401, body: { error: 'reauth-required' } }]);
    renderWithSession(<Probe />);
    await act(async () => {
      fireEvent.click(screen.getByText('write'));
    });
    await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(mock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/killswitch']);
    expect(screen.getByRole('status').textContent).toContain('The request failed');
  });

  it('logout posts with the CSRF header and calls onLoggedOut', async () => {
    const mock = stubFetch([{ method: 'POST', url: '/api/logout', body: {} }]);
    const onLoggedOut = vi.fn();
    renderWithSession(<Probe />, { onLoggedOut });
    await act(async () => {
      fireEvent.click(screen.getByText('logout'));
    });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-bananasaurs-csrf']).toBe(TEST_SESSION.csrfToken);
    expect(onLoggedOut).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Run focused tests, then the gates, then commit**

Run: `npx vitest run packages/dashboard/src` — all pass. Gates alone by exit
code.

```bash
git add packages/dashboard/src/ui/Toast.tsx packages/dashboard/src/ui/ConfirmDialog.tsx packages/dashboard/src/ui/ReauthDialog.tsx packages/dashboard/src/app/session.tsx packages/dashboard/src/test-support.tsx packages/dashboard/src/ui/Toast.test.tsx packages/dashboard/src/ui/ConfirmDialog.test.tsx packages/dashboard/src/app/session.test.tsx
git commit -m "feat(dashboard): session provider, toasts, confirm and re-auth dialogs (Slice 7 task 2)"
```

---

### Task 3: The five pages and the health provider

**Files:**
- Create: `packages/dashboard/src/app/health.tsx`
- Create: `packages/dashboard/src/pages/overview.tsx`
- Create: `packages/dashboard/src/pages/safety.tsx`
- Create: `packages/dashboard/src/pages/logging.tsx`
- Create: `packages/dashboard/src/pages/panels.tsx`
- Create: `packages/dashboard/src/pages/audit.tsx`
- Test: `packages/dashboard/src/pages/pages.test.tsx`

**Interfaces:**
- Consumes: Task 1 primitives and `useResource`; Task 2 `useSession`,
  `useToast`, `ConfirmDialog`, `renderWithSession`, `stubFetch`, `bodyOf`.
- Produces:
  ```ts
  // app/health.tsx
  export interface HealthInfo {
    guildId: string;
    guildName: string | null;
    gateway: { connected: boolean; pingMs: number | undefined; guildCount: number };
    safety: { killswitch: boolean; dryRun: boolean; breakerOpen: boolean } | undefined;
    jobCounts: Record<string, number>;
    oldestDueJobAtMs: number | undefined;
  }
  export function HealthProvider(props: { readonly children: ReactNode }): ReactElement;
  export function useHealth(): UseResource<HealthInfo>;

  // pages/*.tsx — each a default-less named export taking no props:
  export function OverviewPage(): ReactElement;
  export function SafetyPage(): ReactElement;
  export function LoggingPage(): ReactElement;
  export function PanelsPage(): ReactElement;
  export function AuditPage(): ReactElement;
  ```

- [ ] **Step 1: Health provider**

`app/health.tsx`:

```tsx
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { useResource, type UseResource } from '../hooks/useResource.js';
import { useSession } from './session.js';

export interface HealthInfo {
  guildId: string;
  guildName: string | null;
  gateway: { connected: boolean; pingMs: number | undefined; guildCount: number };
  safety: { killswitch: boolean; dryRun: boolean; breakerOpen: boolean } | undefined;
  jobCounts: Record<string, number>;
  oldestDueJobAtMs: number | undefined;
}

const HealthContext = createContext<UseResource<HealthInfo> | undefined>(undefined);

/**
 * `/api/health` is fetched once for the shell, because both the Overview page
 * and the state strip read it and the strip is on every page. A page that
 * changes safety state (the kill switch) calls `reload()`.
 */
export function HealthProvider({ children }: { readonly children: ReactNode }) {
  const session = useSession();
  const load = useCallback(() => session.read<HealthInfo>('/api/health'), [session]);
  const value = useResource('the health summary', load);
  return <HealthContext.Provider value={value}>{children}</HealthContext.Provider>;
}

export function useHealth(): UseResource<HealthInfo> {
  const health = useContext(HealthContext);
  if (health === undefined) throw new Error('useHealth must be used inside <HealthProvider>');
  return health;
}
```

- [ ] **Step 2: Overview**

`pages/overview.tsx`:

```tsx
import { useHealth } from '../app/health.js';
import { Badge } from '../ui/Badge.js';
import { DataState } from '../ui/DataState.js';
import { PageHeader } from '../ui/PageHeader.js';

/** The former Health section. Same fields, same source (`GET /api/health`). */
export function OverviewPage() {
  const health = useHealth();
  return (
    <>
      <PageHeader title="Overview" purpose="How the bot is connected and what it is doing right now." />
      <DataState resource={health.resource}>
        {(h) => (
          <dl className="grid max-w-2xl grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-muted">Guild</dt>
            <dd>
              {h.guildName ?? '(name not yet known)'} <span className="text-ink-muted">({h.guildId})</span>
            </dd>
            <dt className="text-ink-muted">Gateway</dt>
            <dd>
              {h.gateway.connected ? <Badge tone="ok">connected</Badge> : <Badge tone="danger">disconnected</Badge>}
              {h.gateway.pingMs !== undefined && <span className="ml-2 text-ink-muted">{h.gateway.pingMs} ms</span>}
            </dd>
            <dt className="text-ink-muted">Dry run</dt>
            <dd>{h.safety?.dryRun === true ? <Badge tone="hold">on</Badge> : 'off'}</dd>
            <dt className="text-ink-muted">Kill switch</dt>
            <dd>{h.safety?.killswitch === true ? <Badge tone="hold">on</Badge> : 'off'}</dd>
            <dt className="text-ink-muted">Circuit breaker</dt>
            <dd>{h.safety?.breakerOpen === true ? <Badge tone="hold">open</Badge> : 'closed'}</dd>
            <dt className="text-ink-muted">Jobs</dt>
            <dd>
              {Object.entries(h.jobCounts)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(', ') || 'none'}
            </dd>
            {h.oldestDueJobAtMs !== undefined && (
              <>
                <dt className="text-ink-muted">Scheduler lag</dt>
                <dd>since {new Date(h.oldestDueJobAtMs).toLocaleString()}</dd>
              </>
            )}
          </dl>
        )}
      </DataState>
    </>
  );
}
```

- [ ] **Step 3: Safety (kill switch)**

`pages/safety.tsx`:

```tsx
import { useState } from 'react';
import { useHealth } from '../app/health.js';
import { useSession } from '../app/session.js';
import { Button } from '../ui/Button.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

/**
 * The former Kill switch section. Same request (`POST /api/killswitch`
 * `{ on }`); turning it on now states its scope first (`docs/06`), and turning
 * it off still needs re-auth, which `apiFetch` handles.
 */
export function SafetyPage() {
  const session = useSession();
  const health = useHealth();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const setKillswitch = async (on: boolean) => {
    setBusy(true);
    try {
      const result = await session.write<{ ok: boolean; killswitch: boolean }>('/api/killswitch', { on });
      if (result !== undefined) {
        toast({ tone: 'ok', title: on ? 'Kill switch turned on' : 'Kill switch turned off' });
        health.reload();
      }
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <>
      <PageHeader title="Safety" purpose="The kill switch stops every Discord side effect for this guild. Events are still received and logged." />
      <div className="flex gap-2">
        <Button variant="danger" busy={busy} onClick={() => setConfirming(true)}>
          Turn kill switch on
        </Button>
        <Button busy={busy} onClick={() => void setKillswitch(false)}>
          Turn kill switch off
        </Button>
      </div>
      <p className="mt-2 text-sm text-ink-muted">Turning it off asks for your password again.</p>
      <ConfirmDialog
        open={confirming}
        title="Turn the kill switch on?"
        scope={
          <p>
            Stops every Discord side effect for guild {session.info.guildId} until it is turned off again. Events
            are still received and logged.
          </p>
        }
        confirmLabel="Turn kill switch on"
        danger
        onConfirm={() => void setKillswitch(true)}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
```

- [ ] **Step 4: Logging**

`pages/logging.tsx`:

```tsx
import { useCallback, useState } from 'react';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../ui/Button.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { Checkbox, Field, Input } from '../ui/Field.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

interface LogRoute {
  eventKind: string;
  channelId: string;
  enabled: boolean;
  includeContent: boolean;
}

/** The former Log routing section: `GET /api/log-routes` and `POST /api/log-routes`. */
export function LoggingPage() {
  const session = useSession();
  const toast = useToast();
  const load = useCallback(() => session.read<{ routes: LogRoute[] }>('/api/log-routes').then((r) => r.routes), [session]);
  const routes = useResource('the log routes', load);

  const [eventKind, setEventKind] = useState('');
  const [channelId, setChannelId] = useState('');
  const [includeContent, setIncludeContent] = useState(true);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await session.write<{ ok: boolean }>('/api/log-routes', { eventKind, channelId, includeContent });
      if (result !== undefined) {
        toast({ tone: 'ok', title: `Route set for ${eventKind}` });
        routes.reload();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Logging" purpose="Which Discord events are posted to which channel, and whether message content goes with them." />
      <DataState
        resource={routes.resource}
        isEmpty={(r) => r.length === 0}
        empty={<p className="text-sm text-ink-muted">No routes yet. Set one below to start logging an event kind to a channel.</p>}
      >
        {(rows) => (
          <DataTable
            caption="Log routes"
            rows={rows}
            rowKey={(r) => r.eventKind}
            columns={[
              { key: 'event', header: 'Event', cell: (r) => r.eventKind },
              { key: 'channel', header: 'Channel', cell: (r) => r.channelId },
              { key: 'content', header: 'Content', cell: (r) => (r.includeContent ? 'included' : 'redacted') },
            ]}
          />
        )}
      </DataState>
      <form onSubmit={(e) => void submit(e)} className="mt-6 grid max-w-md gap-3">
        <h2 className="text-lg">Set a route</h2>
        <Field label="Event kind">
          <Input value={eventKind} onChange={(e) => setEventKind(e.target.value)} placeholder="e.g. message_delete" />
        </Field>
        <Field label="Channel ID">
          <Input value={channelId} onChange={(e) => setChannelId(e.target.value)} />
        </Field>
        <Checkbox label="Include message content" checked={includeContent} onChange={(e) => setIncludeContent(e.target.checked)} />
        <div>
          <Button type="submit" variant="primary" busy={busy}>
            Set route
          </Button>
        </div>
      </form>
    </>
  );
}
```

- [ ] **Step 5: Panels**

`pages/panels.tsx`:

```tsx
import { useCallback } from 'react';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';

interface PanelSummary {
  panelId: string;
  kind: string;
  component: string;
  behaviour: string;
  status: string;
  messageId: string | undefined;
  optionCount: number;
}

/** The former Panels section: `GET /api/panels`, read-only here as before. */
export function PanelsPage() {
  const session = useSession();
  const load = useCallback(() => session.read<PanelSummary[]>('/api/panels'), [session]);
  const panels = useResource('the role panels', load);
  return (
    <>
      <PageHeader title="Role panels" purpose="Self-service role menus posted in Discord. Configuration is read-only here — use the operator CLI (panel show / panel sync)." />
      <DataState
        resource={panels.resource}
        isEmpty={(p) => p.length === 0}
        empty={<p className="text-sm text-ink-muted">No panels configured. Create one with the operator CLI.</p>}
      >
        {(rows) => (
          <DataTable
            caption="Role panels"
            rows={rows}
            rowKey={(p) => p.panelId}
            columns={[
              { key: 'id', header: 'Panel', cell: (p) => p.panelId },
              { key: 'shape', header: 'Kind', cell: (p) => `${p.kind}/${p.component}/${p.behaviour}` },
              { key: 'status', header: 'Status', cell: (p) => p.status },
              { key: 'options', header: 'Options', cell: (p) => p.optionCount, numeric: true },
            ]}
          />
        )}
      </DataState>
    </>
  );
}
```

- [ ] **Step 6: Audit**

`pages/audit.tsx`:

```tsx
import { useCallback } from 'react';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';

interface AuditRow {
  auditId: number;
  at: number;
  actorType: string;
  actorId: string | null;
  actorUnixUserClaimed: string | null;
  via: string | null;
  action: string;
  subjectType: string;
  subjectId: string | null;
  dryRun: boolean;
}

/** The former Audit section: `GET /api/audit?limit=50`, same four columns and formatting. */
export function AuditPage() {
  const session = useSession();
  const load = useCallback(() => session.read<AuditRow[]>('/api/audit?limit=50'), [session]);
  const audit = useResource('the audit log', load);
  return (
    <>
      <PageHeader title="Audit" purpose="The last fifty things the bot did or refused to do, and who asked." />
      <DataState resource={audit.resource} isEmpty={(a) => a.length === 0} empty={<p className="text-sm text-ink-muted">Nothing has been audited yet.</p>}>
        {(rows) => (
          <DataTable
            caption="Audit log"
            rows={rows}
            rowKey={(r) => String(r.auditId)}
            columns={[
              { key: 'when', header: 'When', cell: (r) => new Date(r.at).toLocaleString() },
              {
                key: 'actor',
                header: 'Actor',
                cell: (r) => `${r.actorType}${r.actorUnixUserClaimed !== null ? ` (${r.actorUnixUserClaimed}, claimed)` : ''}`,
              },
              { key: 'action', header: 'Action', cell: (r) => r.action },
              { key: 'subject', header: 'Subject', cell: (r) => `${r.subjectType}${r.subjectId !== null ? `:${r.subjectId}` : ''}` },
            ]}
          />
        )}
      </DataState>
    </>
  );
}
```

- [ ] **Step 7: Tests — the pages call the same endpoints with the same bodies**

`pages/pages.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthProvider } from '../app/health.js';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { AuditPage } from './audit.js';
import { LoggingPage } from './logging.js';
import { OverviewPage } from './overview.js';
import { PanelsPage } from './panels.js';
import { SafetyPage } from './safety.js';

const HEALTH = {
  guildId: '1540816150026518620',
  guildName: 'Bananasaurs dev',
  gateway: { connected: true, pingMs: 42, guildCount: 1 },
  safety: { killswitch: false, dryRun: true, breakerOpen: false },
  jobCounts: { pending: 2 },
  oldestDueJobAtMs: undefined,
};

afterEach(() => vi.unstubAllGlobals());

describe('OverviewPage', () => {
  it('fetches /api/health and renders the same fields the old Health section did', async () => {
    const mock = stubFetch([{ url: '/api/health', body: HEALTH }]);
    renderWithSession(
      <HealthProvider>
        <OverviewPage />
      </HealthProvider>,
    );
    expect(await screen.findByText(/Bananasaurs dev/)).toBeTruthy();
    expect(screen.getByText('(1540816150026518620)')).toBeTruthy();
    expect(screen.getByText('connected')).toBeTruthy();
    expect(screen.getByText('42 ms')).toBeTruthy();
    // Dry run is on → a hold badge; kill switch and breaker are off → plain text.
    expect(screen.getByText('on')).toBeTruthy();
    expect(screen.getAllByText('off')).toHaveLength(1);
    expect(screen.getByText('closed')).toBeTruthy();
    expect(screen.getByText('pending=2')).toBeTruthy();
    expect(screen.queryByText(/Scheduler lag/)).toBeNull();
    expect(mock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/health']);
  });

  it('renders the scheduler lag row only when a due job is waiting', async () => {
    stubFetch([{ url: '/api/health', body: { ...HEALTH, oldestDueJobAtMs: 0 } }]);
    renderWithSession(
      <HealthProvider>
        <OverviewPage />
      </HealthProvider>,
    );
    expect(await screen.findByText('Scheduler lag')).toBeTruthy();
  });
});

describe('SafetyPage', () => {
  it('turning on states the scope, then posts { on: true } and reloads health', async () => {
    const mock = stubFetch([
      { url: '/api/health', body: HEALTH },
      { method: 'POST', url: '/api/killswitch', body: { ok: true, killswitch: true } },
    ]);
    renderWithSession(
      <HealthProvider>
        <SafetyPage />
      </HealthProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Turn kill switch on' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('guild 1540816150026518620');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Turn kill switch on' }));
    });
    const post = mock.mock.calls.find((c) => String(c[0]) === '/api/killswitch')!;
    expect(bodyOf(post)).toEqual({ on: true });
    expect(mock.mock.calls.filter((c) => String(c[0]) === '/api/health')).toHaveLength(2);
  });

  it('turning off posts { on: false } with no confirmation dialog', async () => {
    const mock = stubFetch([
      { url: '/api/health', body: HEALTH },
      { method: 'POST', url: '/api/killswitch', body: { ok: true, killswitch: false } },
    ]);
    renderWithSession(
      <HealthProvider>
        <SafetyPage />
      </HealthProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn kill switch off' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    const post = mock.mock.calls.find((c) => String(c[0]) === '/api/killswitch')!;
    expect(bodyOf(post)).toEqual({ on: false });
  });
});

describe('LoggingPage', () => {
  it('lists routes from /api/log-routes and posts the same body the old form did', async () => {
    const mock = stubFetch([
      { url: '/api/log-routes', body: { routes: [{ eventKind: 'message_delete', channelId: '42', enabled: true, includeContent: false }] } },
      { method: 'POST', url: '/api/log-routes', body: { ok: true } },
    ]);
    renderWithSession(<LoggingPage />);
    expect(await screen.findByText('message_delete')).toBeTruthy();
    expect(screen.getByText('redacted')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Event kind'), { target: { value: 'member_join' } });
    fireEvent.change(screen.getByLabelText('Channel ID'), { target: { value: '99' } });
    fireEvent.click(screen.getByLabelText('Include message content'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set route' }));
    });
    const post = mock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(String(post[0])).toBe('/api/log-routes');
    expect(bodyOf(post)).toEqual({ eventKind: 'member_join', channelId: '99', includeContent: false });
    expect(mock.mock.calls.filter((c) => String(c[0]) === '/api/log-routes' && (c[1] as RequestInit | undefined)?.method !== 'POST')).toHaveLength(2);
  });

  it('shows an empty state that says what to do', async () => {
    stubFetch([{ url: '/api/log-routes', body: { routes: [] } }]);
    renderWithSession(<LoggingPage />);
    expect(await screen.findByText(/No routes yet/)).toBeTruthy();
  });
});

describe('PanelsPage', () => {
  it('fetches /api/panels and renders each panel', async () => {
    stubFetch([
      {
        url: '/api/panels',
        body: [{ panelId: 'p1', kind: 'roles', component: 'select', behaviour: 'toggle', status: 'posted', messageId: 'm', optionCount: 3 }],
      },
    ]);
    renderWithSession(<PanelsPage />);
    expect(await screen.findByText('p1')).toBeTruthy();
    expect(screen.getByText('roles/select/toggle')).toBeTruthy();
    expect(screen.getByText('posted')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });
});

describe('AuditPage', () => {
  it('fetches /api/audit?limit=50 and formats actor and subject as before', async () => {
    const mock = stubFetch([
      {
        url: '/api/audit?limit=50',
        body: [
          {
            auditId: 1,
            at: 0,
            actorType: 'cli',
            actorId: null,
            actorUnixUserClaimed: 'bryan',
            via: null,
            action: 'killswitch.on',
            subjectType: 'guild',
            subjectId: '123',
            dryRun: false,
          },
        ],
      },
    ]);
    renderWithSession(<AuditPage />);
    expect(await screen.findByText('cli (bryan, claimed)')).toBeTruthy();
    expect(screen.getByText('guild:123')).toBeTruthy();
    expect(mock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/audit?limit=50']);
  });

  it('renders the error state naming the request when the API fails', async () => {
    stubFetch([{ url: '/api/audit?limit=50', status: 500, body: { error: 'boom' } }]);
    renderWithSession(<AuditPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the audit log');
  });
});
```

The confirm button inside the dialog has the same accessible name as the page
button by design (the verb names the effect in both places); the test selects
the dialog's own button with `within(dialog)`. Never select by class name.

- [ ] **Step 8: Run focused tests, then the gates, then commit**

```bash
git add packages/dashboard/src/app/health.tsx packages/dashboard/src/pages
git commit -m "feat(dashboard): the five pages and the health provider (Slice 7 task 3)"
```

---

### Task 4: Routes, the shell, the state strip, and the App rewrite

**Files:**
- Create: `packages/dashboard/src/app/routes.ts`
- Create: `packages/dashboard/src/app/StateStrip.tsx`
- Create: `packages/dashboard/src/app/Shell.tsx`
- Create: `packages/dashboard/src/pages/login.tsx`
- Create: `packages/dashboard/src/pages/not-found.tsx`
- Modify: `packages/dashboard/src/App.tsx` (replace whole file)
- Test: `packages/dashboard/src/app/Shell.test.tsx`
- Test: `packages/dashboard/src/app/StateStrip.test.tsx`
- Test: `packages/dashboard/src/pages/login.test.tsx`

**Interfaces:**
- Consumes: everything above; `wouter`'s `Router`, `Switch`, `Route`, `Link`,
  `useLocation`; `wouter/memory-location`'s `memoryLocation` in tests.
- Produces:
  ```ts
  // app/routes.ts
  export type NavStatus = 'built' | 'stub';
  export interface NavEntry { readonly path: string; readonly label: string; readonly status: NavStatus }
  export const NAV: readonly NavEntry[];   // '/', '/safety', '/logging', '/panels', '/audit' — all 'built'

  // app/Shell.tsx
  export function Shell(): ReactElement;    // rail + header + StateStrip + Switch; must be inside SessionProvider and a wouter Router

  // app/StateStrip.tsx
  export function StateStrip(): ReactElement | null;

  // pages/login.tsx
  export function LoginForm(props: { readonly onSignedIn: () => void }): ReactElement;
  export function BootstrapForm(props: { readonly token: string; readonly onSignedIn: () => void }): ReactElement;

  // pages/not-found.tsx
  export function NotFoundPage(): ReactElement;
  ```

- [ ] **Step 1: Routes as data**

`app/routes.ts`:

```ts
/**
 * Navigation is data (ADR 0043 D3). Slice 8 adds rows; Slice 10 adds `stub`
 * rows for the Release 3 areas so the roadmap is visible without the UI
 * pretending anything exists. Nothing else about the rail changes.
 */
export type NavStatus = 'built' | 'stub';

export interface NavEntry {
  readonly path: string;
  readonly label: string;
  readonly status: NavStatus;
}

export const NAV: readonly NavEntry[] = [
  { path: '/', label: 'Overview', status: 'built' },
  { path: '/safety', label: 'Safety', status: 'built' },
  { path: '/logging', label: 'Logging', status: 'built' },
  { path: '/panels', label: 'Role panels', status: 'built' },
  { path: '/audit', label: 'Audit', status: 'built' },
];
```

- [ ] **Step 2: The state strip**

`app/StateStrip.tsx`:

```tsx
import { useHealth } from './health.js';
import { useSession } from './session.js';

/**
 * The one bold element (ADR 0043 D4). Silent when nothing is held; amber with
 * every hold named when something is. It reads the same `/api/health` the
 * Overview page does, so the two can never disagree.
 */
export function StateStrip() {
  const session = useSession();
  const health = useHealth();

  const holds: string[] = [];
  if (session.info.readonly) holds.push('Read-only instance: writes are refused');
  if (health.resource.state === 'ready') {
    const safety = health.resource.data.safety;
    if (safety?.dryRun === true) holds.push('Dry run: Discord side effects are logged, not executed');
    if (safety?.killswitch === true) holds.push('Kill switch on: every side effect for this guild is stopped');
    if (safety?.breakerOpen === true) holds.push('Circuit breaker open: Discord writes are paused');
    if (!health.resource.data.gateway.connected) holds.push('Gateway disconnected');
  }

  if (holds.length === 0) return null;
  return (
    <div role="status" data-testid="state-strip" className="border-b border-hold bg-hold px-4 py-1.5 text-sm text-hold-ink">
      <ul className="flex flex-wrap gap-x-6">
        {holds.map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: The shell**

`app/Shell.tsx`:

```tsx
import { Link, Route, Switch, useLocation } from 'wouter';
import { AuditPage } from '../pages/audit.js';
import { LoggingPage } from '../pages/logging.js';
import { NotFoundPage } from '../pages/not-found.js';
import { OverviewPage } from '../pages/overview.js';
import { PanelsPage } from '../pages/panels.js';
import { SafetyPage } from '../pages/safety.js';
import { Button } from '../ui/Button.js';
import { HealthProvider, useHealth } from './health.js';
import { NAV } from './routes.js';
import { useSession } from './session.js';
import { StateStrip } from './StateStrip.js';

function GuildIdentity() {
  const session = useSession();
  const health = useHealth();
  const name = health.resource.state === 'ready' ? health.resource.data.guildName : null;
  return (
    <div className="border-b border-line px-4 py-3">
      <p className="text-xs text-ink-muted">Bananasaurs</p>
      <p className="text-base font-medium">{name ?? 'Guild'}</p>
      <p className="text-xs text-ink-muted">{session.info.guildId}</p>
    </div>
  );
}

function Rail() {
  const [location] = useLocation();
  return (
    <nav aria-label="Areas" className="flex-1 py-2">
      <ul>
        {NAV.map((entry) => {
          const active = location === entry.path;
          return (
            <li key={entry.path}>
              <Link
                href={entry.path}
                aria-current={active ? 'page' : undefined}
                className={`block px-4 py-1.5 text-sm ${active ? 'bg-panel text-ink' : 'text-ink-muted hover:text-ink'}`}
              >
                {entry.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Pages() {
  return (
    <Switch>
      <Route path="/" component={OverviewPage} />
      <Route path="/safety" component={SafetyPage} />
      <Route path="/logging" component={LoggingPage} />
      <Route path="/panels" component={PanelsPage} />
      <Route path="/audit" component={AuditPage} />
      <Route component={NotFoundPage} />
    </Switch>
  );
}

/** Rail, header, state strip, page. Must render inside `SessionProvider` and a wouter `Router`. */
export function Shell() {
  const session = useSession();
  return (
    <HealthProvider>
      <div className="flex min-h-screen">
        <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-canvas">
          <GuildIdentity />
          <Rail />
          <div className="border-t border-line px-4 py-3">
            <Button onClick={() => void session.logout()}>Sign out</Button>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <StateStrip />
          <main className="w-full max-w-[1400px] px-6 py-5">
            <Pages />
          </main>
        </div>
      </div>
    </HealthProvider>
  );
}
```

- [ ] **Step 4: Not found, and the login forms moved**

`pages/not-found.tsx`:

```tsx
import { Link } from 'wouter';
import { PageHeader } from '../ui/PageHeader.js';

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Not found" purpose="There is no page at this address." />
      <p className="text-sm">
        <Link href="/" className="underline">
          Go to the overview
        </Link>
      </p>
    </>
  );
}
```

`pages/login.tsx` — move `LoginForm` and `BootstrapForm` from `App.tsx` with
the **same fetch calls, bodies, and error messages**, restyled with `Field`,
`Input` and `Button`:

```tsx
import { useState } from 'react';
import { Button } from '../ui/Button.js';
import { Field, Input } from '../ui/Field.js';

function Card({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-24 w-[22rem] max-w-[calc(100vw-2rem)] rounded-md border border-line bg-panel p-5">
      <h1 className="text-xl">{title}</h1>
      {children}
    </div>
  );
}

export function LoginForm({ onSignedIn }: { readonly onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error: string };
        setError(
          body.error === 'locked-out'
            ? 'This account is temporarily locked after too many failed attempts.'
            : body.error === 'read-only'
              ? ((body as { message?: string }).message ?? 'This instance is read-only.')
              : 'Wrong username or password.',
        );
        return;
      }
      onSignedIn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Bananasaurs">
      <form onSubmit={(e) => void submit(e)} className="mt-4 grid gap-3">
        <Field label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </Field>
        <Field label="Password" error={error}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        <div>
          <Button type="submit" variant="primary" busy={busy}>
            Sign in
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function BootstrapForm({ token, onSignedIn }: { readonly token: string; readonly onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/bootstrap', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, username, password }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error: string; issues?: string[] };
        setError(body.issues?.join('; ') ?? body.error);
        return;
      }
      onSignedIn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="First-run setup">
      <p className="mt-1 text-sm text-ink-muted">Create the owner account. This link works once.</p>
      <form onSubmit={(e) => void submit(e)} className="mt-4 grid gap-3">
        <Field label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </Field>
        <Field label="Password" hint="At least 12 characters" error={error}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <div>
          <Button type="submit" variant="primary" busy={busy}>
            Create owner account
          </Button>
        </div>
      </form>
    </Card>
  );
}
```

- [ ] **Step 5: Rewrite `App.tsx`**

Replace the whole file. The session state machine is unchanged; everything
that used to live below it is now the shell:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Router } from 'wouter';
import { getSession, type SessionInfo } from './api.js';
import { SessionProvider } from './app/session.js';
import { Shell } from './app/Shell.js';
import { BootstrapForm, LoginForm } from './pages/login.js';

// --- top-level session state machine ----------------------------------------

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'anon' }
  | { readonly kind: 'bootstrap'; readonly token: string }
  | { readonly kind: 'authed'; readonly session: SessionInfo };

const bootstrapToken = (): string | undefined => {
  if (window.location.pathname !== '/bootstrap') return undefined;
  return new URLSearchParams(window.location.search).get('token') ?? undefined;
};

/**
 * Login and first-run setup render *instead of* the shell, not inside it, so
 * they are not routes (ADR 0043 D3). Once authed, `wouter` owns the path.
 */
export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  const check = useCallback(() => {
    void getSession().then((result) => {
      if (result.authenticated) {
        setPhase({ kind: 'authed', session: result });
        return;
      }
      const token = bootstrapToken();
      setPhase(token !== undefined ? { kind: 'bootstrap', token } : { kind: 'anon' });
    });
  }, []);

  useEffect(check, [check]);

  if (phase.kind === 'loading') {
    return (
      <p role="status" className="p-6 text-sm text-ink-muted">
        Loading…
      </p>
    );
  }
  if (phase.kind === 'anon') return <LoginForm onSignedIn={check} />;
  if (phase.kind === 'bootstrap') {
    return <BootstrapForm token={phase.token} onSignedIn={check} />;
  }
  return (
    <SessionProvider session={phase.session} onLoggedOut={check}>
      <Router>
        <Shell />
      </Router>
    </SessionProvider>
  );
}
```

- [ ] **Step 6: Tests**

`app/Shell.test.tsx`:

```tsx
// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderWithSession, stubFetch } from '../test-support.js';
import { NAV } from './routes.js';
import { Shell } from './Shell.js';

const HEALTH = {
  guildId: '1540816150026518620',
  guildName: 'Bananasaurs dev',
  gateway: { connected: true, pingMs: 42, guildCount: 1 },
  safety: { killswitch: false, dryRun: false, breakerOpen: false },
  jobCounts: {},
  oldestDueJobAtMs: undefined,
};

function renderAt(path: string) {
  stubFetch([
    { url: '/api/health', body: HEALTH },
    { url: '/api/log-routes', body: { routes: [] } },
    { url: '/api/panels', body: [] },
    { url: '/api/audit?limit=50', body: [] },
  ]);
  const { hook } = memoryLocation({ path });
  return renderWithSession(
    <Router hook={hook}>
      <Shell />
    </Router>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Shell', () => {
  it.each([
    ['/', 'Overview'],
    ['/safety', 'Safety'],
    ['/logging', 'Logging'],
    ['/panels', 'Role panels'],
    ['/audit', 'Audit'],
  ])('renders the %s page titled %s and marks its rail entry current', async (path, title) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy();
    const link = screen.getByRole('link', { name: title, current: 'page' });
    expect(link.getAttribute('href')).toBe(path);
  });

  it('renders the not-found page for an unknown path, with nothing current', async () => {
    renderAt('/nope');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeTruthy();
    expect(screen.queryByRole('link', { current: 'page' })).toBeNull();
  });

  it('the rail lists every built NAV entry and no others, and names the guild', async () => {
    renderAt('/');
    const nav = screen.getByRole('navigation', { name: 'Areas' });
    const labels = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent);
    expect(labels).toEqual(NAV.filter((n) => n.status === 'built').map((n) => n.label));
    expect(await screen.findByText('Bananasaurs dev')).toBeTruthy();
  });

  it('exposes Sign out', async () => {
    renderAt('/');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });
});
```

`app/StateStrip.test.tsx`:

```tsx
// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { HealthProvider } from './health.js';
import { StateStrip } from './StateStrip.js';

const base = {
  guildId: '1',
  guildName: 'g',
  gateway: { connected: true, pingMs: 1, guildCount: 1 },
  jobCounts: {},
  oldestDueJobAtMs: undefined,
};

afterEach(() => vi.unstubAllGlobals());

describe('StateStrip', () => {
  it('renders nothing when nothing is held', async () => {
    stubFetch([{ url: '/api/health', body: { ...base, safety: { killswitch: false, dryRun: false, breakerOpen: false } } }]);
    renderWithSession(
      <HealthProvider>
        <StateStrip />
      </HealthProvider>,
    );
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('state-strip')).toBeNull();
  });

  it('names every active hold', async () => {
    stubFetch([{ url: '/api/health', body: { ...base, gateway: { ...base.gateway, connected: false }, safety: { killswitch: true, dryRun: true, breakerOpen: true } } }]);
    renderWithSession(
      <HealthProvider>
        <StateStrip />
      </HealthProvider>,
      { session: { ...TEST_SESSION, readonly: true } },
    );
    const strip = await screen.findByTestId('state-strip');
    for (const text of ['Read-only instance', 'Dry run', 'Kill switch on', 'Circuit breaker open', 'Gateway disconnected']) {
      expect(strip.textContent).toContain(text);
    }
  });
});
```

`pages/login.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, stubFetch } from '../test-support.js';
import { BootstrapForm, LoginForm } from './login.js';

afterEach(() => vi.unstubAllGlobals());

describe('LoginForm', () => {
  it('posts { username, password } to /api/login and calls onSignedIn on 200', async () => {
    const mock = stubFetch([{ method: 'POST', url: '/api/login', body: {} }]);
    const onSignedIn = vi.fn();
    render(<LoginForm onSignedIn={onSignedIn} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(bodyOf(mock.mock.calls[0]!)).toEqual({ username: 'owner', password: 'correct horse battery' });
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it('shows the lock-out message on locked-out', async () => {
    stubFetch([{ method: 'POST', url: '/api/login', status: 429, body: { error: 'locked-out' } }]);
    render(<LoginForm onSignedIn={() => undefined} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('temporarily locked');
  });
});

describe('BootstrapForm', () => {
  it('posts { token, username, password } to /api/bootstrap and joins issues on failure', async () => {
    const mock = stubFetch([{ method: 'POST', url: '/api/bootstrap', status: 400, body: { error: 'bad-request', issues: ['too short', 'too common'] } }]);
    render(<BootstrapForm token="tok" onSignedIn={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create owner account' }));
    });
    expect(bodyOf(mock.mock.calls[0]!)).toEqual({ token: 'tok', username: 'owner', password: 'short' });
    expect(screen.getByRole('alert').textContent).toBe('too short; too common');
  });
});
```

- [ ] **Step 7: Build the dashboard once**

Run: `npm run build -w @bananasaurs/dashboard` — expected exit 0 and a
`packages/dashboard/dist/index.html`. This proves the Tailwind plugin and the
`@theme` block compile under Vite, which the tests cannot. Do not commit
`dist/`.

- [ ] **Step 8: Run all dashboard tests, the gates, and commit**

```bash
git add packages/dashboard/src/App.tsx packages/dashboard/src/app packages/dashboard/src/pages
git commit -m "feat(dashboard): routes, shell, state strip; five sections migrated (Slice 7 task 4)"
```

---

## Self-review

- **Spec coverage.** Routing (Task 4), design tokens (Task 1), layout and
  navigation (Task 4), tables/forms/dialogs/toasts/badges (Tasks 1–2),
  empty/loading/degraded/error states (Task 1 `DataState`), the five sections
  migrated with no behaviour change (Task 3, proven by `pages.test.tsx` and by
  the unchanged HTTP route tests). Slice 8's dropdown-menu, tabs, tooltip and
  select have no consumer in Slice 7 and are deliberately not wrapped —
  wrapping a primitive nothing uses is YAGNI; their packages are installed so
  the lockfile is settled.
- **Placeholders.** None; every step carries its code.
- **Type consistency.** `Resource<T>` and `UseResource<T>` are defined in
  Task 1 and consumed by name in Tasks 3–4; `Session.write` returns
  `T | undefined` in Task 2 and every caller in Task 3 checks `!== undefined`;
  `HealthInfo` is defined once in `app/health.tsx`.
