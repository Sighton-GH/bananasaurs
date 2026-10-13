// @vitest-environment jsdom
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../../../test-support.js';
import { TaskDetailPage } from './index.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const TASK = {
  taskId: 'task-1',
  teamId: 'team-1',
  title: 'Fix the intake',
  description: 'Details',
  status: 'in_progress',
  priority: 'normal',
  assignmentKind: 'team',
  assigneeId: null,
  assigneeIds: [],
  dueAt: Date.UTC(2026, 9, 10, 17, 0),
  timezone: 'UTC',
  destinationId: 'chan-1',
  version: 3,
  archivedAt: null,
};
const DETAIL = {
  task: TASK,
  team: { teamId: 'team-1', name: 'Tech', kind: 'subteam', categoryId: 'cat-1' },
  children: [
    {
      childId: 'c1',
      title: 'Step one',
      dueAt: Date.UTC(2026, 9, 11),
      status: 'pending',
      completedAt: null,
    },
    {
      childId: 'c2',
      title: 'Step two',
      dueAt: Date.UTC(2026, 9, 12),
      status: 'pending',
      completedAt: null,
    },
  ],
  reports: [{ reportId: 'r1', authorId: 'user-1', body: 'Did a thing', createdAt: 1700000000000 }],
  reminders: [],
  links: [],
};
type Route_ = { method?: string; url: string; status?: number; body: unknown };
const BASE: Route_[] = [
  { url: '/api/tasks/task-1', body: DETAIL },
  { url: '/api/tasks/teams/team-1/assignees', body: { assignees: [] } },
  { url: '/api/tasks/teams/team-1/destinations', body: { destinations: [] } },
];

function render(path: string, extra: Route_[] = [], onLoggedOut = () => undefined) {
  const mock = stubFetch([...BASE, ...extra]);
  const mem = memoryLocation({ path });
  renderWithSession(
    <Router hook={mem.hook} searchHook={mem.searchHook}>
      <Route path="/tasks/:taskId" component={TaskDetailPage} />
      <Route path="/tasks">Task list destination</Route>
    </Router>,
    { session: { ...TEST_SESSION, instanceOwner: true }, onLoggedOut },
  );
  const original = mock.getMockImplementation()!;
  mock.mockImplementation((input, init) => {
    const route = extra.find((r) => r.url === input && r.method === init?.method);
    return route?.status === 204
      ? Promise.resolve(new Response(null, { status: 204 }))
      : original(input, init);
  });
  return mock;
}
const deletes = (mock: ReturnType<typeof stubFetch>) =>
  (mock.mock.calls as unknown[][]).filter(
    ([, i]) => (i as RequestInit | undefined)?.method === 'DELETE',
  );

// Keep the write unresolved so repeated activation and cancellation are tested
// during the request, not after an already-completed response.
function deferDelete(mock: ReturnType<typeof stubFetch>, url: string) {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const original = mock.getMockImplementation()!;
  mock.mockImplementation((input, init) =>
    input === url && init?.method === 'DELETE' ? pending : original(input, init),
  );
  return () =>
    resolve(
      url.includes('/children/')
        ? new Response('{}', { headers: { 'content-type': 'application/json' } })
        : new Response(null, { status: 204 }),
    );
}

describe('R1 destructive confirmations (detail)', () => {
  it('step Delete: first activation writes nothing, Cancel focused, Escape and Cancel restore the opener', async () => {
    const user = userEvent.setup();
    const mock = render('/tasks/task-1?tab=steps');
    const opener = (await screen.findAllByRole('button', { name: 'Delete' }))[0]!;
    opener.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Step one/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(deletes(mock)).toHaveLength(0);
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
    await user.keyboard('{Enter}');
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(deletes(mock)).toHaveLength(0);
  });

  it('step Delete confirm sends exactly one DELETE with { version } and lands on the heading; second open names the new step', async () => {
    const user = userEvent.setup();
    const mock = render('/tasks/task-1?tab=steps', [
      { method: 'DELETE', url: '/api/tasks/task-1/children/c2', body: {} },
    ]);
    const buttons = await screen.findAllByRole('button', { name: 'Delete' });
    await user.click(buttons[0]!);
    expect(within(await screen.findByRole('dialog')).getByText(/Step one/)).toBeTruthy();
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[1]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Step two/)).toBeTruthy();
    expect(within(dialog).queryByText(/Step one/)).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Delete step' }));
    await vi.waitFor(() => expect(deletes(mock)).toHaveLength(1));
    expect(deletes(mock)[0]![0]).toBe('/api/tasks/task-1/children/c2');
    expect(bodyOf(deletes(mock)[0]!)).toEqual({ version: 3 });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Dated steps' })),
    );
  });

  it('step Delete refusal keeps the honest message and closes the dialog', async () => {
    const user = userEvent.setup();
    const mock = render('/tasks/task-1?tab=steps', [
      {
        method: 'DELETE',
        url: '/api/tasks/task-1/children/c1',
        status: 403,
        body: { error: 'tasks-forbidden' },
      },
    ]);
    await user.click((await screen.findAllByRole('button', { name: 'Delete' }))[0]!);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete step' }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain('tasks-forbidden');
    expect(deletes(mock)).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each(
    ['steps', 'progress', 'overview'].flatMap((tab) =>
      [401, 403, 404, 500, 503, 599].map((status) => ({ tab, status })),
    ),
  )('N17 $tab HTTP$status refuses without reloading or success focus', async ({ tab, status }) => {
    const user = userEvent.setup();
    const url =
      tab === 'steps'
        ? '/api/tasks/task-1/children/c1'
        : tab === 'progress'
          ? '/api/tasks/task-1/reports/r1'
          : '/api/tasks/task-1';
    const mock = render(`/tasks/task-1?tab=${tab}`, [
      {
        method: 'DELETE',
        url,
        status,
        body: { error: status === 401 ? 'invalid-credentials' : 'tasks-forbidden' },
      },
    ]);
    const opener = (
      await screen.findAllByRole('button', { name: tab === 'overview' ? 'Delete task' : 'Delete' })
    )[0]!;
    const readsBefore = mock.mock.calls.filter(
      ([u, init]) => u === '/api/tasks/task-1' && !init?.method?.includes('DELETE'),
    ).length;
    await user.click(opener);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: tab === 'steps' ? 'Delete step' : 'Delete',
      }),
    );
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    expect(
      mock.mock.calls.filter(
        ([u, init]) => u === '/api/tasks/task-1' && !init?.method?.includes('DELETE'),
      ),
    ).toHaveLength(readsBefore);
    expect(deletes(mock)).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toContain(
      status === 401 ? 'invalid-credentials' : 'tasks-forbidden',
    );
  });

  it.each(
    ['steps', 'progress', 'overview'].flatMap((tab) =>
      ['cancel', 'retry'].map((outcome) => ({ tab, outcome })),
    ),
  )(
    'N17 $tab reauth $outcome never mistakes cancellation for deletion',
    async ({ tab, outcome }) => {
      const user = userEvent.setup();
      const url =
        tab === 'steps'
          ? '/api/tasks/task-1/children/c1'
          : tab === 'progress'
            ? '/api/tasks/task-1/reports/r1'
            : '/api/tasks/task-1';
      const mock = render(`/tasks/task-1?tab=${tab}`, [
        { method: 'POST', url: '/api/reauth', body: {} },
      ]);
      const original = mock.getMockImplementation()!;
      let writes = 0;
      mock.mockImplementation((input, init) => {
        if (input !== url || init?.method !== 'DELETE') return original(input, init);
        writes++;
        return Promise.resolve(
          writes === 1
            ? new Response(JSON.stringify({ error: 'reauth-required' }), { status: 401 })
            : tab === 'steps'
              ? new Response('{}', { status: 200 })
              : new Response(null, { status: 204 }),
        );
      });
      const opener = (
        await screen.findAllByRole('button', {
          name: tab === 'overview' ? 'Delete task' : 'Delete',
        })
      )[0]!;
      await user.click(opener);
      await user.click(
        within(await screen.findByRole('dialog')).getByRole('button', {
          name: tab === 'steps' ? 'Delete step' : 'Delete',
        }),
      );
      const reauthTitle = await screen.findByText('Confirm your password');
      const reauth = reauthTitle.closest('[role="dialog"]') as HTMLElement;
      expect(writes).toBe(1);
      if (outcome === 'cancel') {
        await user.click(within(reauth).getByRole('button', { name: 'Cancel' }));
        await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await vi.waitFor(() => expect(document.activeElement).toBe(opener));
        expect(writes).toBe(1);
        expect(screen.getByText('Nothing was changed.')).toBeTruthy();
      } else {
        await user.type(within(reauth).getByLabelText('Password'), 'synthetic-password');
        await user.click(within(reauth).getByRole('button', { name: 'Confirm' }));
        await vi.waitFor(() => expect(writes).toBe(2));
        if (tab === 'overview')
          expect(await screen.findByText('Task list destination')).toBeTruthy();
        else
          await vi.waitFor(() =>
            expect(document.activeElement).toBe(
              screen.getByRole('heading', {
                name: tab === 'steps' ? 'Dated steps' : 'Progress reports',
              }),
            ),
          );
      }
    },
  );

  it('N17 unauthenticated401 still logs out without success effects', async () => {
    const user = userEvent.setup();
    const onLoggedOut = vi.fn();
    const mock = render(
      '/tasks/task-1?tab=progress',
      [
        {
          method: 'DELETE',
          url: '/api/tasks/task-1/reports/r1',
          status: 401,
          body: { error: 'unauthenticated' },
        },
      ],
      onLoggedOut,
    );
    const opener = await screen.findByRole('button', { name: 'Delete' });
    const reads = mock.mock.calls.filter(([, init]) => init?.method === 'GET').length;
    await user.click(opener);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    );
    await vi.waitFor(() => expect(onLoggedOut).toHaveBeenCalledOnce());
    expect(mock.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(reads);
    expect(document.activeElement).not.toBe(
      screen.getByRole('heading', { name: 'Progress reports' }),
    );
  });

  it('N17 child-not-current409 retains the row and opener without success reload', async () => {
    const user = userEvent.setup();
    const mock = render('/tasks/task-1?tab=steps', [
      {
        method: 'DELETE',
        url: '/api/tasks/task-1/children/c1',
        status: 409,
        body: { error: 'child-not-current' },
      },
    ]);
    const opener = (await screen.findAllByRole('button', { name: 'Delete' }))[0]!;
    const reads = mock.mock.calls.filter(([, init]) => init?.method === 'GET').length;
    await user.click(opener);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete step' }),
    );
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(screen.getByText('Step one')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('child-not-current');
    expect(mock.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(reads);
  });

  it('report Delete: zero writes until confirmed, Escape restores the opener, confirm sends one DELETE and focuses the heading', async () => {
    const user = userEvent.setup();
    const mock = render('/tasks/task-1?tab=progress', [
      { method: 'DELETE', url: '/api/tasks/task-1/reports/r1', status: 204, body: undefined },
    ]);
    const opener = await screen.findByRole('button', { name: 'Delete' });
    opener.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(deletes(mock)).toHaveLength(0);
    await user.click(opener);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    );
    await vi.waitFor(() => expect(deletes(mock)).toHaveLength(1));
    expect(deletes(mock)[0]![0]).toBe('/api/tasks/task-1/reports/r1');
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Progress reports' }),
      ),
    );
  });

  it('task Delete: Cancel and Escape write nothing and return to the opener; confirm sends one DELETE with { version }', async () => {
    const user = userEvent.setup();
    const mock = render('/tasks/task-1', [
      { method: 'DELETE', url: '/api/tasks/task-1', status: 204, body: undefined },
    ]);
    const opener = await screen.findByRole('button', { name: 'Delete task' });
    opener.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Fix the intake/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(deletes(mock)).toHaveLength(0);
    await user.click(opener);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    );
    await vi.waitFor(() => expect(deletes(mock)).toHaveLength(1));
    expect(bodyOf(deletes(mock)[0]!)).toEqual({ version: 3 });
    expect(await screen.findByText('Task list destination')).toBeTruthy();
  });

  it.each([
    {
      name: 'step Delete',
      path: '/tasks/task-1?tab=steps',
      opener: 'Delete',
      confirm: 'Delete step',
      url: '/api/tasks/task-1/children/c1',
      body: { version: 3 },
    },
    {
      name: 'report Delete',
      path: '/tasks/task-1?tab=progress',
      opener: 'Delete',
      confirm: 'Delete',
      url: '/api/tasks/task-1/reports/r1',
      body: undefined,
    },
    {
      name: 'task Delete',
      path: '/tasks/task-1',
      opener: 'Delete task',
      confirm: 'Delete',
      url: '/api/tasks/task-1',
      body: { version: 3 },
    },
  ])(
    '$name keeps one DELETE pending and blocks Escape/Cancel until settled',
    async ({ path, opener, confirm, url, body }) => {
      const user = userEvent.setup();
      const mock = render(path);
      const finish = deferDelete(mock, url);
      try {
        await user.click((await screen.findAllByRole('button', { name: opener }))[0]!);
        const dialog = await screen.findByRole('dialog');
        const confirmButton = within(dialog).getByRole('button', { name: confirm });
        const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
        await user.dblClick(confirmButton);
        expect(deletes(mock)).toHaveLength(1);
        expect(deletes(mock)[0]![0]).toBe(url);
        expect(bodyOf(deletes(mock)[0]!)).toEqual(body);
        if (body === undefined) expect((deletes(mock)[0]![1] as RequestInit).body).toBeUndefined();
        expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
        expect((cancel as HTMLButtonElement).disabled).toBe(true);
        await user.keyboard('{Enter}{Escape}');
        expect(screen.getByRole('dialog')).toBe(dialog);
        await user.click(cancel);
        expect(screen.getByRole('dialog')).toBe(dialog);
        expect(deletes(mock)).toHaveLength(1);
      } finally {
        await act(async () => finish());
      }
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(deletes(mock)).toHaveLength(1);
    },
  );

  it.each([
    {
      name: 'step',
      path: '/tasks/task-1?tab=steps',
      opener: 'Delete',
      confirm: 'Delete step',
      url: '/api/tasks/task-1/children/c1',
    },
    {
      name: 'task',
      path: '/tasks/task-1',
      opener: 'Delete task',
      confirm: 'Delete',
      url: '/api/tasks/task-1',
    },
  ])(
    '$name stale-version 409 closes the dialog, explains the reload and GETs the task again',
    async ({ path, opener, confirm, url }) => {
      const user = userEvent.setup();
      const mock = render(path, [
        { method: 'DELETE', url, status: 409, body: { error: 'stale-task-version' } },
      ]);
      await user.click((await screen.findAllByRole('button', { name: opener }))[0]!);
      const taskGets = () =>
        mock.mock.calls.filter(
          ([input, init]) => input === '/api/tasks/task-1' && (init?.method ?? 'GET') === 'GET',
        ).length;
      const before = taskGets();
      expect(before).toBeGreaterThan(0);
      await user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: confirm }),
      );
      await screen.findByText('This task changed; reloaded the latest version.');
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await vi.waitFor(() => expect(taskGets()).toBe(before + 1));
      expect(deletes(mock)).toHaveLength(1);
      expect(deletes(mock)[0]![0]).toBe(url);
      expect(bodyOf(deletes(mock)[0]!)).toEqual({ version: 3 });
    },
  );
});
