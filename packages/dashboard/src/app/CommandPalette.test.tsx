// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router, useLocation } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import type { SessionInfo } from '../api.js';
import { renderWithSession, stubFetch, TEST_SESSION, type StubRoute } from '../test-support.js';
import { CommandPalette } from './CommandPalette.js';
import { PaletteProvider, usePalette } from './palette-context.js';

const OWNER: SessionInfo = { ...TEST_SESSION, instanceOwner: true };
const PLAIN: SessionInfo = { ...TEST_SESSION, instanceOwner: false, canManageTasks: false };
const SNOWFLAKE = '333333333333333333';

const TASKS = {
  teams: [{ teamId: 't1', name: 'Robotics', kind: 'subteam', categoryId: 'c' }],
  tasks: [
    { taskId: 'k1', title: 'Order servos', teamId: 't1', status: 'in_progress', archivedAt: null },
  ],
  presidentRoleId: null,
};
const CASES = {
  cases: [
    {
      caseId: 'abcdef123456',
      memberId: '111',
      status: 'open',
      member: { username: 'dana', displayName: 'Dana' },
    },
  ],
};
const RULES = {
  rules: [{ ruleId: 'r1', kind: 'keyword_filter', name: 'Block spam', enabled: true }],
};
const OK: StubRoute[] = [
  { url: '/api/tasks?include=done,archived', body: TASKS },
  { url: '/api/mod/cases?limit=50', body: CASES },
  { url: '/api/automod/rules', body: RULES },
];

function Where() {
  const [loc] = useLocation();
  return <output data-testid="loc">{loc}</output>;
}

function renderPalette(opts: { session?: SessionInfo; strict?: boolean } = {}) {
  const { hook } = memoryLocation({ path: '/start' });
  const tree = (
    <Router hook={hook}>
      <PaletteProvider>
        <Where />
        <button type="button">opener</button>
        <input aria-label="external" />
        <CommandPalette />
      </PaletteProvider>
    </Router>
  );
  return renderWithSession(opts.strict === true ? <StrictMode>{tree}</StrictMode> : tree, {
    session: opts.session ?? OWNER,
  });
}

const dialog = () => screen.queryByRole('dialog', { name: 'Search or jump to' });
const combobox = () => screen.getByRole('combobox');
const options = () => screen.queryAllByRole('option');
const optionNames = () => options().map((o) => o.textContent ?? '');
const loc = () => screen.getByTestId('loc').textContent;
const scrollSpy = vi.fn();
const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const calls = (mock: ReturnType<typeof stubFetch>) => mock.mock.calls.map((c) => urlOf(c[0]));

beforeEach(() => {
  Element.prototype.scrollIntoView = scrollSpy;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('opening', () => {
  it('Ctrl-K from the body opens a named dialog with focus in the combobox', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    expect(dialog()).toBeNull();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Search or jump to' })).toBeTruthy();
    expect(document.activeElement).toBe(combobox());
  });
  it('Meta-K does the same', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByRole('dialog', { name: 'Search or jump to' })).toBeTruthy();
    expect(document.activeElement).toBe(combobox());
  });
  it('Ctrl-K inside a focused input elsewhere opens it and prevents the browser default', async () => {
    stubFetch(OK);
    renderPalette();
    const external = screen.getByLabelText('external');
    external.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      external.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByRole('dialog', { name: 'Search or jump to' })).toBeTruthy();
  });
  it('Ctrl-K while open closes it, from inside the combobox', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog');
    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(dialog()).toBeNull());
  });
  it('toggles on every press and registers one capture listener under StrictMode', async () => {
    stubFetch(OK);
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const user = userEvent.setup();
    renderPalette({ strict: true });
    const adds = add.mock.calls.filter((c) => c[0] === 'keydown').length;
    const removes = remove.mock.calls.filter((c) => c[0] === 'keydown').length;
    expect(adds - removes).toBe(1);
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog');
    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(dialog()).toBeNull());
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});

describe('ARIA', () => {
  it('wires combobox, listbox, groups and one selected option', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog');
    await screen.findByText('Order servos');
    const box = combobox();
    expect(box.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('listbox');
    expect(box.getAttribute('aria-controls')).toBe(list.id);
    const selected = options().filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(box.getAttribute('aria-activedescendant')).toBe(selected[0]?.id);
    for (const group of within(list).getAllByRole('group')) {
      const heading = document.getElementById(group.getAttribute('aria-labelledby') ?? '');
      expect(heading?.textContent).toBeTruthy();
    }
    expect(list.querySelectorAll('svg:not([aria-hidden="true"])')).toHaveLength(0);
  });
  it('lists Pages and Actions at once, before any source answers', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate;
        return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } });
      }),
    );
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog');
    expect(optionNames().some((n) => n.startsWith('Overview'))).toBe(true);
    expect(optionNames().some((n) => n.startsWith('New task'))).toBe(true);
    const panel = screen.getByRole('dialog');
    expect(
      within(panel)
        .getAllByRole('status')
        .map((s) => s.textContent),
    ).toEqual(
      expect.arrayContaining(['Loading tasks…', 'Loading cases…', 'Loading automod rules…']),
    );
    expect(screen.queryByText(/No results/)).toBeNull();
    release();
    await waitFor(() => expect(within(panel).queryAllByRole('status')).toHaveLength(0));
  });
});

describe('searching and keys', () => {
  it('typing "task" then Enter goes to /tasks despite New task and task matches', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByText('Order servos');
    await user.type(combobox(), 'task');
    expect(optionNames()[0]).toMatch(/^Tasks/);
    await user.keyboard('{Enter}');
    expect(loc()).toBe('/tasks');
    await waitFor(() => expect(dialog()).toBeNull());
  });
  it('ArrowDown twice then Enter picks the third item; activedescendant tracks', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByText('Order servos');
    const first = options();
    expect(combobox().getAttribute('aria-activedescendant')).toBe(first[0]?.id);
    await user.keyboard('{ArrowDown}');
    expect(combobox().getAttribute('aria-activedescendant')).toBe(first[1]?.id);
    await user.keyboard('{ArrowDown}');
    expect(combobox().getAttribute('aria-activedescendant')).toBe(first[2]?.id);
    expect(first[2]?.getAttribute('aria-selected')).toBe('true');
    expect(first[0]?.getAttribute('aria-selected')).toBe('false');
    const third = first[2]?.textContent ?? '';
    await user.keyboard('{Enter}');
    expect(loc()).not.toBe('/start');
    expect(third).toBeTruthy();
  });
  it('wraps at both ends across sections', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByText('Order servos');
    const all = options();
    await user.keyboard('{ArrowUp}');
    expect(combobox().getAttribute('aria-activedescendant')).toBe(all[all.length - 1]?.id);
    await user.keyboard('{ArrowDown}');
    expect(combobox().getAttribute('aria-activedescendant')).toBe(all[0]?.id);
  });
  it('scrolls the active option into view, nearest', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByText('Order servos');
    await user.keyboard('{ArrowDown}');
    expect(scrollSpy).toHaveBeenLastCalledWith({ block: 'nearest' });
  });
  it('finds a task by title and opens /tasks/<id>', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(combobox(), 'servos');
    const option = await screen.findByRole('option', { name: /Order servos/ });
    expect(option.textContent).toContain('Robotics · In progress');
    await user.keyboard('{Enter}');
    expect(loc()).toBe('/tasks/k1');
  });
  it('maps a case and a rule', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    const c = await screen.findByRole('option', { name: /Case abcdef12/ });
    expect(c.textContent).toContain('Dana');
    await user.click(c);
    expect(loc()).toBe('/cases/abcdef123456');
    await user.keyboard('{Control>}k{/Control}');
    const r = await screen.findByRole('option', { name: /Block spam/ });
    expect(r.textContent).toContain('Keyword filter · On');
    await user.click(r);
    expect(loc()).toBe('/automod/r1');
  });
  it('caps a section at 8 results', async () => {
    const cases = Array.from({ length: 12 }, (_, i) => ({
      caseId: `case${String(i).padStart(4, '0')}xyz`,
      memberId: '9',
      status: 'open',
      member: null,
    }));
    stubFetch([
      ...OK.filter((r) => !r.url.includes('cases')),
      { url: '/api/mod/cases?limit=50', body: { cases } },
    ]);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /Case case0000/ });
    expect(options().filter((o) => /^Case case/.test(o.textContent ?? ''))).toHaveLength(8);
  });
  it('repairs the active option when the current one disappears', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByText('Order servos');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.type(combobox(), 'servos');
    const only = options();
    expect(only).toHaveLength(1);
    expect(combobox().getAttribute('aria-activedescendant')).toBe(only[0]?.id);
    expect(only[0]?.getAttribute('aria-selected')).toBe('true');
  });
  it('has no activedescendant and says so when nothing matches', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByText('Order servos');
    await user.type(combobox(), 'zzqqxx');
    expect(options()).toHaveLength(0);
    expect(combobox().hasAttribute('aria-activedescendant')).toBe(false);
    expect(screen.getByText('No results for "zzqqxx"')).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(loc()).toBe('/start');
  });
  it('offers Open member <id> for a snowflake and navigates', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(combobox(), SNOWFLAKE);
    const option = await screen.findByRole('option', { name: `Open member ${SNOWFLAKE}` });
    await user.click(option);
    expect(loc()).toBe(`/members/${SNOWFLAKE}`);
  });
  it('does not show "No results" while a source is still loading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(combobox(), 'zzqqxx');
    expect(screen.queryByText(/No results/)).toBeNull();
  });
  it('Kill switch only navigates to Safety and never writes', async () => {
    const mock = stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(combobox(), 'kill');
    const option = screen.getByRole('option', { name: /Kill switch/ });
    expect(option.textContent).toContain('Opens Safety');
    await user.keyboard('{Enter}');
    expect(loc()).toBe('/safety');
    expect(mock.mock.calls.every((c) => (c[1]?.method ?? 'GET') === 'GET')).toBe(true);
    expect(calls(mock).some((u) => u.includes('safety'))).toBe(false);
  });
});

describe('focus', () => {
  it('Escape closes and restores the exact opener', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
  it('restores an external input and the body', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    const external = screen.getByLabelText('external');
    external.focus();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(external);
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(document.body);
  });
  it('restores exactly once (one focus call on the opener)', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    const opener = screen.getByRole('button', { name: 'opener' });
    const focus = vi.spyOn(opener, 'focus');
    opener.focus();
    focus.mockClear();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    // Radix restores focus on a zero-delay timer: wait past it.
    await new Promise((r) => setTimeout(r, 30));
    expect(focus).toHaveBeenCalledTimes(1);
  });
  it('does not restore the stale opener after navigating', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    const opener = screen.getByRole('button', { name: 'opener' });
    const focus = vi.spyOn(opener, 'focus');
    opener.focus();
    focus.mockClear();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(dialog()).toBeNull());
    await new Promise((r) => setTimeout(r, 30));
    expect(focus).not.toHaveBeenCalled();
  });
  it('keeps keyboard focus inside the dialog (modal trap)', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    const d = await screen.findByRole('dialog');
    await user.tab();
    await user.tab();
    expect(d.contains(document.activeElement)).toBe(true);
    expect(screen.queryByRole('button', { name: 'opener' })).toBeNull();
    expect(screen.getByText('opener').closest('[aria-hidden="true"]')).toBeTruthy();
  });
});

describe('sources', () => {
  it('loads once when the palette mounts already open under StrictMode double effects', async () => {
    const mock = stubFetch(OK);
    function OpenFirst() {
      const p = usePalette();
      const [ready, setReady] = useState(false);
      useEffect(() => {
        p.open();
        setReady(true);
      }, []);
      return ready ? <CommandPalette /> : null;
    }
    const { hook } = memoryLocation({ path: '/start' });
    renderWithSession(
      <StrictMode>
        <Router hook={hook}>
          <PaletteProvider>
            <OpenFirst />
          </PaletteProvider>
        </Router>
      </StrictMode>,
      { session: OWNER },
    );
    await screen.findByText('Order servos');
    expect(calls(mock).filter((c) => c === '/api/tasks?include=done,archived')).toHaveLength(1);
    expect(calls(mock).filter((c) => c === '/api/mod/cases?limit=50')).toHaveLength(1);
    expect(calls(mock).filter((c) => c === '/api/automod/rules')).toHaveLength(1);
  });
  it('a 500 on tasks leaves the other sections working', async () => {
    stubFetch([
      {
        url: '/api/tasks?include=done,archived',
        status: 500,
        body: { error: 'x', detail: 'SECRET-BODY' },
      },
      ...OK.slice(1),
    ]);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByText("Tasks couldn't load")).toBeTruthy();
    expect(await screen.findByRole('option', { name: /Case abcdef12/ })).toBeTruthy();
    expect(await screen.findByRole('option', { name: /Block spam/ })).toBeTruthy();
    expect(optionNames().some((n) => n.startsWith('Overview'))).toBe(true);
    expect(document.body.textContent).not.toContain('SECRET-BODY');
  });
  it('each failure is independent', async () => {
    stubFetch([{ url: '/api/mod/cases?limit=50', status: 500, body: {} }, OK[0]!, OK[2]!]);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByText("Cases couldn't load")).toBeTruthy();
    expect(await screen.findByRole('option', { name: /Order servos/ })).toBeTruthy();
    expect(screen.queryByText("Tasks couldn't load")).toBeNull();
  });
  it('loads each source once per open, not per keystroke, and again on reopen', async () => {
    const mock = stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByText('Order servos');
    await user.type(combobox(), 'servo');
    const count = (u: string) => calls(mock).filter((c) => c === u).length;
    expect(count('/api/tasks?include=done,archived')).toBe(1);
    expect(count('/api/mod/cases?limit=50')).toBe(1);
    expect(count('/api/automod/rules')).toBe(1);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByText('Order servos');
    expect(count('/api/tasks?include=done,archived')).toBe(2);
  });
  it('loads once per open even under StrictMode double effects', async () => {
    const mock = stubFetch(OK);
    const user = userEvent.setup();
    renderPalette({ strict: true });
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByText('Order servos');
    expect(calls(mock).filter((c) => c === '/api/tasks?include=done,archived')).toHaveLength(1);
    expect(calls(mock).filter((c) => c === '/api/automod/rules')).toHaveLength(1);
  });
  it('a slow read from a previous open never shows after reopen', async () => {
    const resolvers: Array<(r: Response) => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = urlOf(input);
        return new Promise<Response>((resolve) => {
          if (url.startsWith('/api/tasks')) resolvers.push(resolve);
          else
            resolve(
              new Response(JSON.stringify(url.includes('cases') ? CASES : RULES), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            );
        });
      }),
    );
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /Block spam/ });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /Block spam/ });
    expect(resolvers).toHaveLength(2);
    const stale = { ...TASKS, tasks: [{ ...TASKS.tasks[0], taskId: 'old', title: 'Stale task' }] };
    await act(async () => {
      resolvers[0]?.(
        new Response(JSON.stringify(stale), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    expect(screen.queryByText('Stale task')).toBeNull();
    await act(async () => {
      resolvers[1]?.(
        new Response(JSON.stringify(TASKS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    expect(await screen.findByText('Order servos')).toBeTruthy();
    expect(screen.queryByText('Stale task')).toBeNull();
  });
  it('a plain account never calls the task endpoint nor sees task items', async () => {
    const mock = stubFetch(OK);
    const user = userEvent.setup();
    renderPalette({ session: PLAIN });
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /Case abcdef12/ });
    expect(calls(mock).some((u) => u.startsWith('/api/tasks'))).toBe(false);
    expect(screen.queryByText('Order servos')).toBeNull();
    expect(optionNames().some((n) => n.startsWith('New task'))).toBe(false);
    expect(optionNames().some((n) => /^Tasks/.test(n))).toBe(false);
    expect(screen.queryByText(/Tasks couldn't load|Loading tasks/)).toBeNull();
  });
  it('a task manager (not owner) gets tasks but not owner actions', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette({ session: { ...TEST_SESSION, instanceOwner: false, canManageTasks: true } });
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('option', { name: /Order servos/ })).toBeTruthy();
    expect(optionNames().some((n) => n.startsWith('New account'))).toBe(false);
  });
  it('permission lost while open clears task results and stops using the endpoint', async () => {
    const mock = stubFetch(OK);
    const user = userEvent.setup();
    const { hook } = memoryLocation({ path: '/start' });
    const tree = () => (
      <Router hook={hook}>
        <PaletteProvider>
          <CommandPalette />
        </PaletteProvider>
      </Router>
    );
    // Same provider tree, new session info: only the SessionProvider input changes.
    const { SessionProvider } = await import('./session.js');
    const { render } = await import('@testing-library/react');
    const wrap = (info: SessionInfo) => (
      <SessionProvider session={info} onLoggedOut={() => undefined}>
        {tree()}
      </SessionProvider>
    );
    const view = render(wrap(OWNER));
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByText('Order servos');
    const before = calls(mock).filter((u) => u.startsWith('/api/tasks')).length;
    view.rerender(wrap(PLAIN));
    await waitFor(() => expect(screen.queryByText('Order servos')).toBeNull());
    expect(optionNames().some((n) => n.startsWith('New task'))).toBe(false);
    expect(calls(mock).filter((u) => u.startsWith('/api/tasks')).length).toBe(before);
  });
  it('a guild change while open drops the previous guild data and reloads', async () => {
    const mock = stubFetch(OK);
    const user = userEvent.setup();
    const { hook } = memoryLocation({ path: '/start' });
    const { SessionProvider } = await import('./session.js');
    const { render } = await import('@testing-library/react');
    const wrap = (info: SessionInfo) => (
      <SessionProvider session={info} onLoggedOut={() => undefined}>
        <Router hook={hook}>
          <PaletteProvider>
            <CommandPalette />
          </PaletteProvider>
        </Router>
      </SessionProvider>
    );
    const view = render(wrap(OWNER));
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByText('Order servos');
    view.rerender(wrap({ ...OWNER, guildId: '999999999999999999' }));
    await waitFor(() => expect(screen.queryByText('Order servos')).toBeNull());
    await screen.findByText('Order servos');
    expect(calls(mock).filter((u) => u.startsWith('/api/tasks'))).toHaveLength(2);
  });
});

describe('geometry', () => {
  it('bounds the panel and keeps the footer and input outside the scroll list', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    const d = await screen.findByRole('dialog');
    expect(d.className).toMatch(/top-\[12vh\]/);
    expect(d.className).toMatch(/w-\[min\(640px,92vw\)\]/);
    expect(d.className).toMatch(/max-h-/);
    expect(screen.getByRole('listbox').className).toMatch(/max-h-\[60vh\]/);
    expect(screen.getByRole('listbox').className).toMatch(/overflow-y-auto/);
    expect(d.querySelector('kbd')?.closest('div')?.className).toMatch(/shrink-0/);
    expect(combobox().closest('div')?.className).toMatch(/shrink-0/);
  });
});

describe('R1 repairs', () => {
  it('ignores Enter while an IME composition is active', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByText('Order servos');
    fireEvent.keyDown(combobox(), { key: 'Enter', isComposing: true });
    expect(loc()).toBe('/start');
    expect(dialog()).not.toBeNull();
    fireEvent.keyDown(combobox(), { key: 'Enter', isComposing: false });
    expect(loc()).not.toBe('/start');
  });
  it('declares the dialog modal', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    expect((await screen.findByRole('dialog')).getAttribute('aria-modal')).toBe('true');
  });
  it('keeps loading and error notices out of the listbox', async () => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.startsWith('/api/tasks')) return json(500, { error: 'x' });
        if (url.startsWith('/api/mod/cases')) return new Promise<Response>(() => undefined);
        if (url.startsWith('/api/automod/rules')) return json(200, RULES);
        return json(404, {});
      }),
    );
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByText("Tasks couldn't load");
    await screen.findByText('Loading cases…');
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).queryAllByRole('status')).toHaveLength(0);
    expect(within(listbox).queryByText("Tasks couldn't load")).toBeNull();
    expect(Array.from(listbox.children).every((c) => c.getAttribute('role') === 'group')).toBe(
      true,
    );
    expect(screen.getByText('Loading cases…').getAttribute('role')).toBe('status');
  });
  it('keeps no-results text out of the listbox', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(combobox(), 'zzqqxx');
    const note = await screen.findByText('No results for "zzqqxx"');
    expect(screen.getByRole('listbox').contains(note)).toBe(false);
  });
  it('stacks the hint under the label at narrow container widths', async () => {
    stubFetch(OK);
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    const option = await screen.findByRole('option', { name: /Order servos/ });
    expect(option.className).toMatch(/\bflex-wrap\b/);
    const hint = within(option).getByText('Robotics · In progress');
    expect(hint.className).toMatch(/\bbasis-full\b/);
    expect(hint.className).toMatch(/@md:text-right/);
    expect(screen.getByRole('listbox').className).toMatch(/@container/);
  });
});
