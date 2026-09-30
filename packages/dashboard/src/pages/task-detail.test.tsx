// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router, Route, useLocation } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { TaskDetailPage } from './task-detail.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

function LocationProbe() {
  const [location] = useLocation();
  return <p data-testid="location">{location}</p>;
}

const BASE_TASK = {
  taskId: 'task-1',
  teamId: 'team-1',
  title: 'Fix the intake',
  description: 'Details here',
  status: 'awaiting_approval',
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
};

const ASSIGNEES = { assignees: [{ memberId: 'user-1', displayName: 'Alex' }] };

const DESTINATIONS = {
  destinations: [
    { channelId: 'chan-1', name: 'general', kind: 'channel' },
    { channelId: 'thread-1', name: 'help-thread', kind: 'thread', parentName: 'general' },
  ],
};

function renderDetail(
  detail: unknown = DETAIL,
  extraRoutes: readonly { method?: string; url: string; status?: number; body: unknown }[] = [],
) {
  const mock = stubFetch([
    { url: '/api/tasks/task-1', body: detail },
    { url: '/api/tasks/teams/team-1/assignees', body: ASSIGNEES },
    { url: '/api/tasks/teams/team-1/destinations', body: DESTINATIONS },
    ...extraRoutes,
  ]);
  const { hook } = memoryLocation({ path: '/tasks/task-1' });
  renderWithSession(
    <Router hook={hook}>
      <Route path="/tasks/:taskId" component={TaskDetailPage} />
    </Router>,
    { session: { ...TEST_SESSION, instanceOwner: true } },
  );
  return mock;
}

describe('task detail page', () => {
  it('Approve posts { version } to /approve', async () => {
    const mock = renderDetail(DETAIL, [
      { method: 'POST', url: '/api/tasks/task-1/approve', body: { task: BASE_TASK } },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await vi.waitFor(() => {
      const posts = (mock.mock.calls as unknown[][]).filter(
        ([url, init]) =>
          url === '/api/tasks/task-1/approve' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts.length).toBeGreaterThan(0);
      expect(bodyOf(posts[0]!)).toEqual({ version: 3 });
    });
  });

  it('detail edit with a thread destination sends that thread id', async () => {
    const mock = renderDetail(
      { ...DETAIL, task: { ...BASE_TASK, status: 'in_progress', version: 2 } },
      [{ method: 'PUT', url: '/api/tasks/task-1', body: { task: BASE_TASK } }],
    );
    fireEvent.change(await screen.findByLabelText(/destination/i), {
      target: { value: 'thread-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => {
      const puts = (mock.mock.calls as unknown[][]).filter(
        ([url, init]) =>
          url === '/api/tasks/task-1' && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(puts.length).toBeGreaterThan(0);
      const body = bodyOf(puts[0]!) as { destinationId: string };
      expect(body.destinationId).toBe('thread-1');
    });
  });

  it('detail shows an inline alert when the title is blank', async () => {
    renderDetail({ ...DETAIL, task: { ...BASE_TASK, status: 'in_progress' } });
    fireEvent.change(await screen.findByLabelText(/title/i), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/title/i);
  });

  it('a report body containing markup renders as text', async () => {
    renderDetail({
      ...DETAIL,
      reports: [{ reportId: 'r1', authorId: 'user-9', body: '<b>x</b>', createdAt: 1700000000000 }],
    });
    expect(await screen.findByText('<b>x</b>')).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
  });

  it('shows report dates in the task timezone', async () => {
    renderDetail({
      ...DETAIL,
      task: { ...BASE_TASK, timezone: 'America/Vancouver' },
      reports: [
        {
          reportId: 'r1',
          authorId: 'user-1',
          body: 'Did wiring',
          createdAt: Date.UTC(2026, 9, 11, 9, 30),
        },
      ],
    });
    expect(await screen.findByText('Did wiring')).toBeTruthy();
    // 09:30 UTC is 2:30 AM in Vancouver daylight time; the task zone wins
    // over the browser locale (which renders "2026-10-11, 2:30:00 a.m." here).
    expect(screen.getByText(/Oct 11, 2:30 AM/)).toBeTruthy();
  });

  it('delete task confirms inline, sends { version }, and navigates to /tasks', async () => {
    const mock = stubFetch([
      { url: '/api/tasks/task-1', body: DETAIL },
      { url: '/api/tasks/teams/team-1/assignees', body: ASSIGNEES },
      { url: '/api/tasks/teams/team-1/destinations', body: DESTINATIONS },
      { method: 'DELETE', url: '/api/tasks/task-1', body: {} },
    ]);
    const { hook } = memoryLocation({ path: '/tasks/task-1' });
    renderWithSession(
      <Router hook={hook}>
        <Route path="/tasks/:taskId" component={TaskDetailPage} />
        <LocationProbe />
      </Router>,
      { session: { ...TEST_SESSION, instanceOwner: true } },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Delete task' }));
    expect(
      await screen.findByText('Delete this task and all its updates? This cannot be undone.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await vi.waitFor(() => {
      const deletes = (mock.mock.calls as unknown[][]).filter(
        ([url, init]) =>
          url === '/api/tasks/task-1' && (init as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(deletes.length).toBeGreaterThan(0);
      expect(bodyOf(deletes[0]!)).toEqual({ version: 3 });
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/tasks');
    });
  });

  it('delete report confirms inline, calls the report URL, and reloads', async () => {
    const mock = renderDetail(
      {
        ...DETAIL,
        reports: [
          { reportId: 'r1', authorId: 'user-1', body: 'Did wiring', createdAt: 1700000000000 },
        ],
      },
      [{ method: 'DELETE', url: '/api/tasks/task-1/reports/r1', body: {} }],
    );
    expect(await screen.findByText('Did wiring')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(await screen.findByText('Delete this update?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await vi.waitFor(() => {
      const deletes = (mock.mock.calls as unknown[][]).filter(
        ([url, init]) =>
          url === '/api/tasks/task-1/reports/r1' &&
          (init as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(deletes.length).toBeGreaterThan(0);
    });
    await vi.waitFor(() => {
      const gets = (mock.mock.calls as unknown[][]).filter(
        ([url, init]) =>
          url === '/api/tasks/task-1' &&
          ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET',
      );
      expect(gets.length).toBeGreaterThanOrEqual(2);
    });
  });
});
