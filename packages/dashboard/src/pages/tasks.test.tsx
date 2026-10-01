// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
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

function renderBoard() {
  stubFetch([{ url: '/api/tasks?include=done,archived', body: BOARD }]);
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
});
