// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Router } from 'wouter';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../../test-support.js';
import { TasksPage } from './index.js';
import { pick } from './test-support.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const BOARD = {
  teams: [{ teamId: 'team-1', name: 'Tech', kind: 'subteam', categoryId: 'cat-1' }],
  tasks: [
    {
      taskId: 'task-routine',
      teamId: 'team-1',
      title: 'Routine check',
      description: '',
      status: 'not_started',
      priority: 'normal',
      assignmentKind: 'team',
      assigneeId: null,
      assigneeIds: [],
      dueAt: Date.UTC(2020, 0, 2, 12, 0),
      timezone: 'UTC',
      destinationId: 'dest-1',
      version: 1,
      archivedAt: null,
    },
    {
      taskId: 'task-urgent',
      teamId: 'team-1',
      title: 'Urgent fix',
      description: '',
      status: 'in_progress',
      priority: 'urgent',
      assignmentKind: 'team',
      assigneeId: null,
      assigneeIds: [],
      dueAt: Date.UTC(2026, 9, 10, 17, 0),
      timezone: 'UTC',
      destinationId: 'dest-1',
      version: 1,
      archivedAt: null,
    },
    {
      taskId: 'task-done',
      teamId: 'team-1',
      title: 'Finished work',
      description: '',
      status: 'done',
      priority: 'normal',
      assignmentKind: 'team',
      assigneeId: null,
      assigneeIds: [],
      dueAt: Date.UTC(2026, 8, 1, 12, 0),
      timezone: 'UTC',
      destinationId: 'dest-1',
      version: 2,
      archivedAt: null,
    },
    {
      taskId: 'task-archived',
      teamId: 'team-1',
      title: 'Old archived',
      description: '',
      status: 'done',
      priority: 'normal',
      assignmentKind: 'team',
      assigneeId: null,
      assigneeIds: [],
      dueAt: Date.UTC(2026, 7, 1, 12, 0),
      timezone: 'UTC',
      destinationId: 'dest-1',
      version: 3,
      archivedAt: Date.UTC(2026, 7, 2, 12, 0),
    },
  ],
  presidentRoleId: null,
};

function renderBoard(taskPosts?: unknown) {
  stubFetch([
    {
      url: '/api/tasks?include=done,archived',
      body: taskPosts === undefined ? BOARD : { ...BOARD, taskPosts },
    },
  ]);
  renderWithSession(
    <Router>
      <TasksPage />
    </Router>,
    { session: { ...TEST_SESSION, instanceOwner: true } },
  );
}

describe('tasks board', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 8, 15, 12, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('lists open tasks urgent first in a table with status words and overdue', async () => {
    renderBoard();
    expect(await screen.findByText('Urgent fix')).toBeTruthy();
    const html = document.body.innerHTML;
    expect(html.indexOf('Urgent fix')).toBeLessThan(html.indexOf('Routine check'));
    expect(screen.getByText('Urgent')).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByText('Not started')).toBeTruthy();
    expect(screen.getByText('Overdue')).toBeTruthy();
    expect(screen.getByText('2 of 4 tasks shown')).toBeTruthy();
    expect(screen.queryByText('Finished work')).toBeNull();
    expect(screen.getByRole('link', { name: /Urgent fix/ }).getAttribute('href')).toBe(
      '/tasks/task-urgent',
    );
    expect(screen.getByRole('table', { name: 'Tasks' })).toBeTruthy();
  });

  it('shows done and archived tasks under their own status filter', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Urgent fix');
    await pick(user, 'Status', 'Archived');
    expect(screen.getAllByText('Old archived')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Old archived/ }).getAttribute('href')).toBe(
      '/tasks/task-archived',
    );
    expect(screen.queryByText('Urgent fix')).toBeNull();
    await pick(user, 'Status', 'Done');
    expect(screen.getByText('Finished work')).toBeTruthy();
    expect(screen.queryByText('Old archived')).toBeNull();
    await pick(user, 'Status', 'All');
    expect(screen.getByText('4 of 4 tasks shown')).toBeTruthy();
  });

  it('filters by team and title, shows the filtered empty state, and Clear filters resets it', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText('Urgent fix');
    await user.type(screen.getByRole('searchbox', { name: /Search by title/ }), 'routine');
    expect(screen.queryByText('Urgent fix')).toBeNull();
    expect(screen.getByText('Routine check')).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: /Search by title/ }), ' nothing');
    expect(screen.getByText('No tasks match these filters')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Urgent fix')).toBeTruthy();
    expect(screen.getByText('Routine check')).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('searchbox', { name: /Search by title/ }).value).toBe(
      '',
    );
  });

  it('archiving asks first, names the task, then POSTs the same version', async () => {
    const user = userEvent.setup();
    const mock = stubFetch([
      { url: '/api/tasks?include=done,archived', body: BOARD },
      { method: 'POST', url: '/api/tasks/task-urgent/archive', body: { ok: true } },
    ]);
    renderWithSession(
      <Router>
        <TasksPage />
      </Router>,
      { session: { ...TEST_SESSION, instanceOwner: true } },
    );
    await screen.findByText('Urgent fix');
    await user.click(screen.getByRole('button', { name: 'Actions for Urgent fix' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Urgent fix/)).toBeTruthy();
    expect((mock.mock.calls as unknown[][]).some(([url]) => String(url).includes('/archive'))).toBe(
      false,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Archive task' }));
    await vi.waitFor(() => {
      const post = (mock.mock.calls as unknown[][]).find(([url]) =>
        String(url).includes('/api/tasks/task-urgent/archive'),
      );
      expect(post).toBeTruthy();
      expect(bodyOf(post!)).toEqual({ version: 1 });
    });
  });

  it('cancelling the archive confirmation sends nothing', async () => {
    const user = userEvent.setup();
    const mock = stubFetch([{ url: '/api/tasks?include=done,archived', body: BOARD }]);
    renderWithSession(
      <Router>
        <TasksPage />
      </Router>,
      { session: { ...TEST_SESSION, instanceOwner: true } },
    );
    await screen.findByText('Urgent fix');
    await user.click(screen.getByRole('button', { name: 'Actions for Urgent fix' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(
      (mock.mock.calls as unknown[][]).filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(0);
  });

  it('says there are no tasks yet, with a New task action', async () => {
    stubFetch([{ url: '/api/tasks?include=done,archived', body: { ...BOARD, tasks: [] } }]);
    renderWithSession(
      <Router>
        <TasksPage />
      </Router>,
      { session: { ...TEST_SESSION, instanceOwner: true } },
    );
    expect(await screen.findByText('No tasks yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New task' }).length).toBeGreaterThan(0);
  });

  it('shows an unavailable state when the tasks cannot be loaded', async () => {
    stubFetch([{ url: '/api/tasks?include=done,archived', status: 500, body: { error: 'boom' } }]);
    renderWithSession(
      <Router>
        <TasksPage />
      </Router>,
      { session: { ...TEST_SESSION, instanceOwner: true } },
    );
    expect(await screen.findByRole('button', { name: /try again|retry/i })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('has no inline edit form', async () => {
    renderBoard();
    await screen.findByText('Urgent fix');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByLabelText(/president/i)).toBeNull();
  });

  const OFF = {
    enabled: false,
    offReason: 'switch',
    switchOn: false,
    message:
      'Task posts are off for this server — tasks are saved but nothing is posted to Discord. Turn them on with the Task posts switch on the Tasks page.',
  };

  it('shows the Task posts card with the off text and a Turn on button when posts are off', async () => {
    renderBoard(OFF);
    expect(await screen.findByText(/Task posts switch on the Tasks page/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn on task posts' })).toBeTruthy();
  });

  it('says dry run is the reason when the switch is on but dry run overrides it', async () => {
    renderBoard({
      enabled: false,
      offReason: 'dry-run',
      switchOn: true,
      message: 'Task posts are off because dry run is on for this install (BANANASAURS_DRY_RUN).',
    });
    expect(await screen.findByText(/BANANASAURS_DRY_RUN/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off task posts' })).toBeTruthy();
  });

  it('turning on asks for confirmation, then PUTs enabled true', async () => {
    const mock = stubFetch([
      { url: '/api/tasks?include=done,archived', body: { ...BOARD, taskPosts: OFF } },
      { method: 'PUT', url: '/api/tasks/posting', body: { enabled: true } },
    ]);
    renderWithSession(
      <Router>
        <TasksPage />
      </Router>,
      { session: { ...TEST_SESSION, instanceOwner: true } },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on task posts' }));
    expect(
      await screen.findByText(/post new tasks, reminders, check-ins and weekly digests/),
    ).toBeTruthy();
    expect((mock.mock.calls as unknown[][]).some(([url]) => url === '/api/tasks/posting')).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await vi.waitFor(() => {
      const put = (mock.mock.calls as unknown[][]).find(([url]) => url === '/api/tasks/posting');
      expect(put).toBeTruthy();
      expect(bodyOf(put!)).toEqual({ enabled: true });
    });
  });

  it('shows only a short muted line and a Turn off button when posts are on', async () => {
    renderBoard({ enabled: true, switchOn: true, message: 'Task posts are on.' });
    expect(await screen.findByText('Task posts are on.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off task posts' })).toBeTruthy();
  });
});

describe('R1 archive focus', () => {
  it.each(['Escape', 'Cancel', 'confirm'] as const)(
    'menu to dialog to matching row after %s',
    async (close) => {
      const user = userEvent.setup();
      const mock = stubFetch([
        { url: '/api/tasks?include=done,archived', body: BOARD },
        { method: 'POST', url: '/api/tasks/task-urgent/archive', body: { ok: true } },
      ]);
      renderWithSession(
        <Router>
          <TasksPage />
        </Router>,
        { session: { ...TEST_SESSION, instanceOwner: true } },
      );
      const opener = await screen.findByRole('button', { name: 'Actions for Urgent fix' });
      await user.click(opener);
      await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
      const dialog = await screen.findByRole('dialog');
      await vi.waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
      if (close === 'Escape') await user.keyboard('{Escape}');
      else
        await user.click(
          within(dialog).getByRole('button', {
            name: close === 'confirm' ? 'Archive task' : 'Cancel',
          }),
        );
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'Actions for Urgent fix' }),
        ),
      );
      if (close !== 'confirm')
        expect(
          (mock.mock.calls as unknown[][]).filter(
            ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
          ),
        ).toHaveLength(0);
    },
  );
});

describe('R1 archive fallback and backdrop', () => {
  it('backdrop cancels without writing and returns to row actions', async () => {
    const user = userEvent.setup();
    const mock = stubFetch([{ url: '/api/tasks?include=done,archived', body: BOARD }]);
    renderWithSession(
      <Router>
        <TasksPage />
      </Router>,
      { session: { ...TEST_SESSION, instanceOwner: true } },
    );
    await user.click(await screen.findByRole('button', { name: 'Actions for Urgent fix' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await screen.findByRole('dialog');
    const overlay = document.querySelector('[data-state="open"].fixed.inset-0')!;
    await user.click(overlay);
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Actions for Urgent fix' }),
      ),
    );
    expect(
      (mock.mock.calls as unknown[][]).filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(0);
  });
  it('reload that removes the archived row focuses the status filter', async () => {
    const user = userEvent.setup();
    let reads = 0;
    let writes = 0;
    let posted: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/archive')) {
          writes++;
          if (typeof init?.body !== 'string') {
            throw new Error('Expected archive request body to be a string');
          }
          posted = JSON.parse(init.body);
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        reads++;
        const body =
          reads === 1
            ? BOARD
            : {
                ...BOARD,
                tasks: BOARD.tasks.map((t) =>
                  t.taskId === 'task-urgent' ? { ...t, archivedAt: 1700000000000 } : t,
                ),
              };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    renderWithSession(
      <Router>
        <TasksPage />
      </Router>,
      { session: { ...TEST_SESSION, instanceOwner: true } },
    );
    await user.click(await screen.findByRole('button', { name: 'Actions for Urgent fix' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await user.click(await screen.findByRole('button', { name: 'Archive task' }));
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(document.getElementById('task-list-status')),
    );
    expect(screen.queryByRole('button', { name: 'Actions for Urgent fix' })).toBeNull();
    expect(writes).toBe(1);
    expect(posted).toEqual({ version: 1 });
  });
  it('server refusal closes usefully without losing the row', async () => {
    const user = userEvent.setup();
    stubFetch([
      { url: '/api/tasks?include=done,archived', body: BOARD },
      {
        method: 'POST',
        url: '/api/tasks/task-urgent/archive',
        status: 500,
        body: { error: 'boom' },
      },
    ]);
    renderWithSession(
      <Router>
        <TasksPage />
      </Router>,
      { session: { ...TEST_SESSION, instanceOwner: true } },
    );
    await user.click(await screen.findByRole('button', { name: 'Actions for Urgent fix' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await user.click(await screen.findByRole('button', { name: 'Archive task' }));
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Actions for Urgent fix' }),
      ),
    );
  });
});
