// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { TasksPage } from './tasks.js';

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
      dueAt: Date.UTC(2099, 9, 10, 17, 0),
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
  it('lists open tasks urgent first, collapses done, counts open', async () => {
    renderBoard();
    expect(await screen.findByText('Urgent fix')).toBeTruthy();
    const html = document.body.innerHTML;
    expect(html.indexOf('Urgent fix')).toBeLessThan(html.indexOf('Routine check'));
    expect(screen.getByText('Urgent')).toBeTruthy();
    expect(screen.getByText('Done (1)')).toBeTruthy();
    expect(screen.getByText('Finished work')).toBeTruthy();
    expect(screen.getByText('2 open')).toBeTruthy();
    expect(screen.getByText('(overdue)')).toBeTruthy();
    expect(screen.getAllByText('Whole team')).toHaveLength(2);
    expect(screen.getByRole('link', { name: /Urgent fix/ }).getAttribute('href')).toBe(
      '/tasks/task-urgent',
    );
  });

  it('shows an archived task only under Archived (1)', async () => {
    renderBoard();
    await screen.findByText('Archived (1)');
    expect(screen.getAllByText('Old archived')).toHaveLength(1);
    const details = screen.getByText('Archived (1)').closest('details')!;
    expect(
      within(details)
        .getByRole('link', { name: /Old archived/ })
        .getAttribute('href'),
    ).toBe('/tasks/task-archived');
    expect(within(details).getByText(/Done · Archived/)).toBeTruthy();
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
