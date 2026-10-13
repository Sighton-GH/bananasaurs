// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderWithSession, stubFetch, TEST_SESSION } from '../../../test-support.js';
import { TaskDetailPage } from './index.js';
import '../test-support.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const BASE_TASK = {
  taskId: 'task-1',
  teamId: 'team-1',
  title: 'Fix the intake',
  description: 'Details here',
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
  task: BASE_TASK,
  team: { teamId: 'team-1', name: 'Tech', kind: 'subteam', categoryId: 'cat-1' },
  children: [],
  reports: [],
  reminders: [],
  links: [],
};

const ASSIGNEES = { assignees: [{ memberId: 'user-1', displayName: 'Alex' }] };

const DESTINATIONS = {
  destinations: [{ channelId: 'chan-1', name: 'general', kind: 'channel' }],
};

type StubRoute = { method?: string; url: string; status?: number; body: unknown };

function renderDetail(
  detail: unknown = DETAIL,
  extraRoutes: readonly StubRoute[] = [],
  path = '/tasks/task-1',
) {
  const mock = stubFetch([
    { url: '/api/tasks/task-1', body: detail },
    { url: '/api/tasks/teams/team-1/assignees', body: ASSIGNEES },
    { url: '/api/tasks/teams/team-1/destinations', body: DESTINATIONS },
    ...extraRoutes,
  ]);
  const { hook, searchHook } = memoryLocation({ path });
  renderWithSession(
    <Router hook={hook} searchHook={searchHook}>
      <Route path="/tasks/:taskId" component={TaskDetailPage} />
    </Router>,
    { session: { ...TEST_SESSION, instanceOwner: true } },
  );
  return mock;
}

describe('reminders focus (d3 L05)', () => {
  it('adding a reminder lands focus back in the form first field', async () => {
    const mock = renderDetail(DETAIL, [
      { method: 'POST', url: '/api/tasks/task-1/reminders', body: { slotId: 's1' } },
    ], '/tasks/task-1?tab=reminders');
    fireEvent.change(await screen.findByLabelText(/reminder date and time/i), {
      target: { value: '2026-10-20T10:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add reminder' }));
    await vi.waitFor(() => {
      const posts = (mock.mock.calls as unknown[][]).filter(
        ([url, init]) =>
          url === '/api/tasks/task-1/reminders' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts.length).toBeGreaterThan(0);
    });
    await vi.waitFor(() => {
      const field = document.getElementById('reminder-at-input');
      expect(field).not.toBeNull();
      expect(document.activeElement).toBe(field);
    });
  });

  it('cancelling a reminder lands focus on the reminders heading', async () => {
    const mock = renderDetail(
      {
        ...DETAIL,
        reminders: [{ slotId: 's1', kind: 'custom', dueAt: Date.UTC(2026, 9, 20, 10, 0), state: 'pending' }],
      },
      [{ method: 'DELETE', url: '/api/tasks/task-1/reminders/s1', body: {} }],
      '/tasks/task-1?tab=reminders',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => {
      const deletes = (mock.mock.calls as unknown[][]).filter(
        ([url, init]) =>
          url === '/api/tasks/task-1/reminders/s1' &&
          (init as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(deletes.length).toBeGreaterThan(0);
    });
    const heading = await screen.findByRole('heading', { name: 'Reminders' });
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
  });
});

describe('status action focus (d3 L06)', () => {
  it('Mark not started focuses the page heading after the POST resolves', async () => {
    const mock = renderDetail(DETAIL, [
      { method: 'POST', url: '/api/tasks/task-1/status', body: { task: BASE_TASK } },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark not started' }));
    await vi.waitFor(() => {
      const posts = (mock.mock.calls as unknown[][]).filter(
        ([url, init]) =>
          url === '/api/tasks/task-1/status' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts.length).toBeGreaterThan(0);
    });
    await vi.waitFor(() => {
      const gets = (mock.mock.calls as unknown[][]).filter(
        ([url, init]) =>
          url === '/api/tasks/task-1' &&
          ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET',
      );
      expect(gets.length).toBeGreaterThanOrEqual(2);
    });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Fix the intake' });
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('Mark done focuses the page heading after the POST resolves', async () => {
    const mock = renderDetail(DETAIL, [
      { method: 'POST', url: '/api/tasks/task-1/complete', body: { task: BASE_TASK } },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done' }));
    await vi.waitFor(() => {
      const posts = (mock.mock.calls as unknown[][]).filter(
        ([url, init]) =>
          url === '/api/tasks/task-1/complete' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts.length).toBeGreaterThan(0);
    });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Fix the intake' });
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
  });
});
