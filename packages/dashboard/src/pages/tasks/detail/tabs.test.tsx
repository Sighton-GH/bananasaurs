// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router, Route, useLocation, useSearch } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../../../test-support.js';
import { pick } from '../test-support.js';
import { TaskDetailPage } from './index.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const TASK = {
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
  updatedAt: Date.UTC(2026, 9, 9, 12, 0),
};
const DETAIL = {
  task: TASK,
  team: { teamId: 'team-1', name: 'Tech', kind: 'subteam', categoryId: 'cat-1' },
  children: [],
  reports: [{ reportId: 'r1', authorId: 'user-1', body: 'Did a thing', createdAt: 1700000000000 }],
  reminders: [],
  links: [],
};
const ROUTES = [
  { url: '/api/tasks/task-1', body: DETAIL },
  {
    url: '/api/tasks/teams/team-1/assignees',
    body: { assignees: [{ memberId: 'user-1', displayName: 'Alex' }] },
  },
  {
    url: '/api/tasks/teams/team-1/destinations',
    body: {
      destinations: [
        { channelId: 'chan-1', name: 'general', kind: 'channel' },
        { channelId: 'thread-1', name: 'help-thread', kind: 'thread', parentName: 'general' },
      ],
    },
  },
];

function Probe() {
  const [loc] = useLocation();
  const search = useSearch();
  return <p data-testid="url">{`${loc}?${search}`}</p>;
}

function render(
  path: string,
  extra: readonly Parameters<typeof stubFetch>[0][number][] = [],
  routes: readonly Parameters<typeof stubFetch>[0][number][] = ROUTES,
) {
  const mock = stubFetch([...routes, ...extra]);
  const mem = memoryLocation({ path, record: true });
  renderWithSession(
    <Router hook={mem.hook} searchHook={mem.searchHook}>
      <Route path="/tasks/:taskId" component={TaskDetailPage} />
      <Probe />
    </Router>,
    { session: { ...TEST_SESSION, instanceOwner: true } },
  );
  return { mock, mem };
}

describe('task detail tabs and sweep', () => {
  it('opens straight on ?tab=progress and shows reports, not the other tabs', async () => {
    render('/tasks/task-1?tab=progress');
    const tab = await screen.findByRole('tab', { name: 'Progress' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('Did a thing')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('an invalid tab falls back to Overview', async () => {
    render('/tasks/task-1?tab=nonsense');
    const tab = await screen.findByRole('tab', { name: 'Overview' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
  });

  it('choosing a tab writes ?tab=, keeps other query, and Back returns', async () => {
    const user = userEvent.setup();
    const { mem } = render('/tasks/task-1?x=1');
    await user.click(await screen.findByRole('tab', { name: 'Steps' }));
    const url = screen.getByTestId('url').textContent ?? '';
    expect(url).toContain('tab=steps');
    expect(url).toContain('x=1');
    // A pushed entry (not a replace), so the browser Back button returns to the first tab.
    expect(mem.history).toEqual(['/tasks/task-1?x=1', '/tasks/task-1?x=1&tab=steps']);
  });

  it('Overview shows the saved card preview and a description list, with no raw form controls', async () => {
    render('/tasks/task-1');
    expect(await screen.findByText('Preview')).toBeTruthy();
    expect(screen.getByText(/Art shown here is a stand-in/)).toBeTruthy();
    expect(document.querySelector('select:not([aria-hidden])')).toBeNull();
    expect(document.querySelector('dl')).not.toBeNull();
  });

  it('edit form: destination picked with the kit Select still PUTs the thread id', async () => {
    const user = userEvent.setup();
    const { mock } = render('/tasks/task-1', [
      { method: 'PUT', url: '/api/tasks/task-1', body: { task: TASK } },
    ]);
    await pick(user, 'Destination', /help-thread/);
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => {
      const puts = (mock.mock.calls as unknown[][]).filter(
        ([u, i]) => u === '/api/tasks/task-1' && (i as RequestInit | undefined)?.method === 'PUT',
      );
      expect(puts.length).toBe(1);
      expect((bodyOf(puts[0]!) as { destinationId: string }).destinationId).toBe('thread-1');
    });
  });

  it('edit form: server field error shows under the field and in a focused summary, input kept', async () => {
    const user = userEvent.setup();
    render('/tasks/task-1', [
      {
        method: 'PUT',
        url: '/api/tasks/task-1',
        status: 400,
        body: {
          error: 'invalid-body',
          fields: [{ path: 'title', problem: 'Title is too long for a card.' }],
        },
      },
    ]);
    const title = await screen.findByLabelText(/^Title/);
    fireEvent.change(title, { target: { value: 'Kept text' } });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const heading = await screen.findByText("There's a problem");
    const box = heading.closest('[tabindex="-1"]') as HTMLElement;
    await vi.waitFor(() => expect(document.activeElement).toBe(box));
    expect(within(box).getByText('Task title: Title is too long for a card.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>(/^Title/).value).toBe('Kept text');
    expect(document.getElementById('field-title')?.getAttribute('aria-invalid')).toBe('true');
  });

  it('shows the real Created and Updated times from the task response', async () => {
    render(
      '/tasks/task-1',
      [],
      [
        {
          url: '/api/tasks/task-1',
          body: {
            ...DETAIL,
            task: {
              ...TASK,
              createdAt: Date.UTC(2026, 8, 1, 12, 0),
              updatedAt: Date.UTC(2026, 9, 5, 15, 30),
            },
          },
        },
        ...ROUTES.slice(1),
      ],
    );
    expect(await screen.findByText('Created')).toBeTruthy();
    expect(screen.getAllByText('Updated').some((e) => e.tagName === 'DT')).toBe(true);
    expect(screen.getAllByText(/Sep 1, 12:00 PM/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Oct 5, 3:30 PM/).length).toBeGreaterThan(0);
  });

  it('edit form: server assigneeIds.0 focuses the SELECTED (second) member checkbox', async () => {
    const user = userEvent.setup();
    render(
      '/tasks/task-1',
      [
        {
          method: 'PUT',
          url: '/api/tasks/task-1',
          status: 400,
          body: {
            error: 'invalid-body',
            fields: [{ path: 'assigneeIds.0', problem: 'That person is not on the team.' }],
          },
        },
      ],
      [
        {
          url: '/api/tasks/task-1',
          body: {
            ...DETAIL,
            task: { ...TASK, assignmentKind: 'individual', assigneeIds: ['user-2'] },
          },
        },
        {
          url: '/api/tasks/teams/team-1/assignees',
          body: {
            assignees: [
              { memberId: 'user-1', displayName: 'Alex' },
              { memberId: 'user-2', displayName: 'Blair' },
            ],
          },
        },
        ROUTES[2]!,
      ],
    );
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    const heading = await screen.findByText("There's a problem");
    const box = heading.closest('[tabindex="-1"]') as HTMLElement;
    await user.click(within(box).getByText('Person Blair: That person is not on the team.'));
    expect(document.activeElement).toBe(screen.getByLabelText('Blair'));
  });
});

it('R1 edit real wire codes are readable, labelled, ordered and refocus on each rejection', async () => {
  const user = userEvent.setup();
  render('/tasks/task-1', [
    {
      method: 'PUT',
      url: '/api/tasks/task-1',
      status: 400,
      body: {
        error: 'invalid-body',
        fields: [
          { path: 'dueAt', problem: 'too_small' },
          { path: 'priority', problem: 'too_small' },
          { path: 'title', problem: 'too_small' },
        ],
      },
    },
  ]);
  for (let i = 0; i < 2; i++) {
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    const box = (await screen.findByText("There's a problem")).closest(
      '[tabindex="-1"]',
    ) as HTMLElement;
    await vi.waitFor(() => expect(document.activeElement).toBe(box));
    const links = within(box).getAllByRole('link');
    expect(links.map((e) => e.textContent)).toEqual([
      'Task title: Too small.',
      'Due date and time: Too small.',
      'Priority: Too small.',
    ]);
    for (const link of links) {
      await user.click(link);
      expect(document.activeElement).toBe(document.querySelector(link.getAttribute('href')!));
    }
    expect(screen.getByLabelText<HTMLInputElement>(/^Title/).value).toBe('Fix the intake');
  }
});
