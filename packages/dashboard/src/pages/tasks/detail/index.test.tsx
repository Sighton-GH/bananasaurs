// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router, Route, useLocation } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../../../test-support.js';
import userEvent from '@testing-library/user-event';
import { pick } from '../test-support.js';
import { TaskDetailPage } from './index.js';

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
  links: [],
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

  it('Mark done posts { version } to /complete for a working task (ADR 0138)', async () => {
    const working = { ...BASE_TASK, status: 'in_progress', version: 2 };
    const mock = renderDetail({ ...DETAIL, task: working }, [
      { method: 'POST', url: '/api/tasks/task-1/complete', body: { task: working } },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark done' }));
    await vi.waitFor(() => {
      const posts = (mock.mock.calls as unknown[][]).filter(
        ([url, init]) =>
          url === '/api/tasks/task-1/complete' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts.length).toBeGreaterThan(0);
      expect(bodyOf(posts[0]!)).toEqual({ version: 2 });
    });
  });

  it('offers Approve, not Mark done, while a completion request is waiting', async () => {
    renderDetail();
    await screen.findByRole('button', { name: 'Approve' });
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull();
  });

  it('detail edit with a thread destination sends that thread id', async () => {
    const mock = renderDetail(
      { ...DETAIL, task: { ...BASE_TASK, status: 'in_progress', version: 2 } },
      [{ method: 'PUT', url: '/api/tasks/task-1', body: { task: BASE_TASK } }],
    );
    await pick(userEvent.setup(), 'Destination', /help-thread/);
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
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => /title/i.test(a.textContent ?? ''))).toBe(true);
  });

  it('a report body containing markup renders as text', async () => {
    renderDetail(
      {
        ...DETAIL,
        reports: [
          { reportId: 'r1', authorId: 'user-9', body: '<b>x</b>', createdAt: 1700000000000 },
        ],
      },
      [],
      '/tasks/task-1?tab=progress',
    );
    expect(await screen.findByText('<b>x</b>')).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
  });

  it('shows report dates in the task timezone', async () => {
    renderDetail(
      {
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
      },
      [],
      '/tasks/task-1?tab=progress',
    );
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
      '/tasks/task-1?tab=progress',
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

  it('shows task links as external links', async () => {
    renderDetail({
      ...DETAIL,
      links: [
        { label: 'Docs', url: 'https://example.com' },
        { label: 'Spec', url: 'https://spec.example.com' },
      ],
    });
    const docs = await screen.findByRole('link', { name: 'Docs ↗' });
    expect(docs.getAttribute('href')).toBe('https://example.com');
    const spec = screen.getByRole('link', { name: 'Spec ↗' });
    expect(spec.getAttribute('href')).toBe('https://spec.example.com');
  });

  it('saving the edit form sends links', async () => {
    const links = [
      { label: 'Docs', url: 'https://example.com' },
      { label: 'Spec', url: 'https://spec.example.com' },
    ];
    const mock = renderDetail({ ...DETAIL, task: { ...BASE_TASK, status: 'in_progress' }, links }, [
      { method: 'PUT', url: '/api/tasks/task-1', body: { task: BASE_TASK } },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => {
      const puts = (mock.mock.calls as unknown[][]).filter(
        ([url, init]) =>
          url === '/api/tasks/task-1' && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(puts.length).toBeGreaterThan(0);
      const body = bodyOf(puts[0]!) as Record<string, unknown>;
      expect(body['links']).toEqual(links);
    });
  });

  it('clears stale link errors when a row is removed or edited in the edit form', async () => {
    const links = [
      { label: 'Bad', url: 'http://example.com' },
      { label: 'Good', url: 'https://example.com' },
    ];
    renderDetail({ ...DETAIL, task: { ...BASE_TASK, status: 'in_progress' }, links });
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Link 1: enter a URL that starts with https://')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Link 1 URL'), {
      target: { value: 'https://fixed.example.com' },
    });
    expect(screen.queryByText('Link 1: enter a URL that starts with https://')).toBeNull();
    fireEvent.change(screen.getByLabelText('Link 1 URL'), {
      target: { value: 'http://example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Link 1: enter a URL that starts with https://')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove link 1' }));
    expect(screen.queryByText('Link 1: enter a URL that starts with https://')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Link 1 label').value).toBe('Good');
  });

  it('renders duplicate link URLs without a React key warning', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderDetail({
        ...DETAIL,
        links: [
          { label: 'One', url: 'https://example.com' },
          { label: 'Two', url: 'https://example.com' },
        ],
      });
      expect(await screen.findByRole('link', { name: 'One ↗' })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Two ↗' })).toBeTruthy();
      const keyWarnings = spy.mock.calls.filter((c) => String(c[0]).includes('same key'));
      expect(keyWarnings).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('breadcrumb (P4 Task 2)', () => {
  it('shows Tasks > record title once the task is ready, and the fallback while loading', async () => {
    renderDetail();
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav.querySelector('[aria-current="page"]')!.textContent).toBe('Task');
    expect(await screen.findByRole('heading', { level: 1, name: 'Fix the intake' })).toBeTruthy();
    const ready = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(ready.querySelector('a')!.getAttribute('href')).toBe('/tasks');
    expect(ready.querySelector('[aria-current="page"]')!.textContent).toBe('Fix the intake');
  });

  it('keeps the generic title and never fetches a name when permission is denied', async () => {
    const mock = stubFetch([{ url: '/api/tasks/task-1', body: DETAIL }]);
    const { hook } = memoryLocation({ path: '/tasks/task-1' });
    renderWithSession(
      <Router hook={hook}>
        <Route path="/tasks/:taskId" component={TaskDetailPage} />
      </Router>,
      { session: { ...TEST_SESSION, instanceOwner: false, canManageTasks: false } },
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav.querySelector('[aria-current="page"]')!.textContent).toBe('Task');
    expect(nav.querySelector('a')!.getAttribute('href')).toBe('/tasks');
    // The existing request lifecycle still runs; the denied view must not show its title.
    await waitFor(() => expect(mock).toHaveBeenCalled());
    expect(screen.queryByText('Fix the intake')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Task');
  });
});

describe('R1 truthful detail preview', () => {
  it('does not invent Updated when old data omits it', async () => {
    renderDetail();
    await screen.findByText('Preview');
    const preview = screen.getByRole('complementary', { name: 'Preview' });
    expect(preview.querySelector('[data-discord-card]')).toBeNull();
    expect(preview.textContent).toContain('Updated time was not recorded');
  });
});
