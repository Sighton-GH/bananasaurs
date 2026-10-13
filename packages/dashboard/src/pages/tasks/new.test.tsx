// @vitest-environment jsdom
import { cleanup, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../../test-support.js';
import { TaskCreatePage } from './new.js';
import { pick } from './test-support.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const TEAMS = {
  teams: [{ teamId: 'one', name: 'Tech', categoryId: '333333333333333333' }],
  tasks: [],
};

const DESTINATIONS = {
  destinations: [
    { channelId: '444444444444444444', name: 'tech-tasks', kind: 'channel' },
    {
      channelId: '555555555555555555',
      name: 'help-thread',
      kind: 'thread',
      parentName: 'tech-tasks',
    },
  ],
};

const ASSIGNEES = {
  assignees: [{ memberId: '555555555555555555', displayName: 'Alex' }],
};

function renderCreate(
  extraRoutes: readonly { method?: string; url: string; status?: number; body: unknown }[] = [],
  taskPosts?: unknown,
  assignees: unknown = ASSIGNEES,
) {
  const mock = stubFetch([
    { url: '/api/tasks', body: taskPosts === undefined ? TEAMS : { ...TEAMS, taskPosts } },
    { url: '/api/tasks/teams/one/destinations', body: DESTINATIONS },
    { url: '/api/tasks/teams/one/assignees', body: assignees },
    ...extraRoutes,
  ]);
  renderWithSession(
    <Router>
      <TaskCreatePage />
    </Router>,
    { session: { ...TEST_SESSION, instanceOwner: true } },
  );
  return mock;
}

async function fillValid(user: ReturnType<typeof userEvent.setup>) {
  await pick(user, 'Team', 'Tech');
  fireEvent.change(screen.getByLabelText(/task title/i), { target: { value: 'Fix the intake' } });
  fireEvent.change(screen.getByLabelText(/due date/i), {
    target: { value: '2026-10-10T09:00' },
  });
  await pick(user, 'Destination', 'tech-tasks');
}

describe('task creation', () => {
  it('warns with the off text when posts are off', async () => {
    renderCreate([], {
      enabled: false,
      offReason: 'switch',
      switchOn: false,
      message:
        'Task posts are off for this server — tasks are saved but nothing is posted to Discord. Turn them on with the Task posts switch on the Tasks page.',
    });
    const banner = await screen.findByText(/Task posts switch on the Tasks page/);
    expect(banner.closest('[role="status"]')).toBeTruthy();
  });

  it('shows a short line when posts are on', async () => {
    renderCreate([], { enabled: true, switchOn: true, message: 'Task posts are on.' });
    expect(await screen.findByText('Task posts are on.')).toBeTruthy();
  });

  it('does not show the form to non-owner sessions', () => {
    stubFetch([]);
    renderWithSession(
      <Router>
        <TaskCreatePage />
      </Router>,
    );
    expect(screen.getByText(/Setting up tasks needs the owner/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create task' })).toBeNull();
  });

  it('offers an individual assignment from verified team members', async () => {
    const user = userEvent.setup();
    renderCreate();
    await pick(user, 'Team', 'Tech');
    await user.click(screen.getByRole('radio', { name: 'Specific people' }));
    expect(await screen.findByRole('checkbox', { name: 'Alex' })).toBeTruthy();
  });

  it('create form sends description, timezone and extraReminderAt', async () => {
    const user = userEvent.setup();
    const mock = renderCreate([
      { method: 'POST', url: '/api/tasks', body: { taskId: 'task-new' } },
    ]);
    await pick(user, 'Team', 'Tech');
    fireEvent.change(screen.getByLabelText(/task title/i), { target: { value: 'Fix the intake' } });
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: 'Some details' },
    });
    fireEvent.change(screen.getByLabelText(/due date/i), {
      target: { value: '2026-10-10T09:00' },
    });
    await pick(user, 'Destination', 'tech-tasks');
    fireEvent.click(screen.getByRole('button', { name: 'Add reminder' }));
    fireEvent.change(await screen.findByLabelText(/extra reminder 1/i), {
      target: { value: '2026-10-09T09:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await vi.waitFor(() => {
      const posts = (mock.mock.calls as unknown[][]).filter(
        ([url, init]) =>
          url === '/api/tasks' && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts.length).toBeGreaterThan(0);
      const body = bodyOf(posts[0]!) as Record<string, unknown>;
      expect(body['description']).toBe('Some details');
      expect(typeof body['timezone']).toBe('string');
      expect((body['timezone'] as string).length).toBeGreaterThan(0);
      expect(Array.isArray(body['extraReminderAt'])).toBe(true);
      expect((body['extraReminderAt'] as unknown[]).length).toBe(1);
    });
  });

  it('sends links in the POST body when one valid link is set', async () => {
    const user = userEvent.setup();
    const mock = renderCreate([
      { method: 'POST', url: '/api/tasks', body: { taskId: 'task-new' } },
    ]);
    await pick(user, 'Team', 'Tech');
    fireEvent.change(screen.getByLabelText(/task title/i), { target: { value: 'Fix the intake' } });
    fireEvent.change(screen.getByLabelText(/due date/i), {
      target: { value: '2026-10-10T09:00' },
    });
    await pick(user, 'Destination', 'tech-tasks');
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.change(screen.getByLabelText('Link 1 label'), { target: { value: 'Docs' } });
    fireEvent.change(screen.getByLabelText('Link 1 URL'), {
      target: { value: 'https://example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await vi.waitFor(() => {
      const posts = (mock.mock.calls as unknown[][]).filter(
        ([url, init]) =>
          url === '/api/tasks' && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts.length).toBeGreaterThan(0);
      const body = bodyOf(posts[0]!) as Record<string, unknown>;
      expect(body['links']).toEqual([{ label: 'Docs', url: 'https://example.com' }]);
    });
  });

  it('blocks the POST and names the fix when a link is not https', async () => {
    const user = userEvent.setup();
    const mock = renderCreate([
      { method: 'POST', url: '/api/tasks', body: { taskId: 'task-new' } },
    ]);
    await pick(user, 'Team', 'Tech');
    fireEvent.change(screen.getByLabelText(/task title/i), { target: { value: 'Fix the intake' } });
    fireEvent.change(screen.getByLabelText(/due date/i), {
      target: { value: '2026-10-10T09:00' },
    });
    await pick(user, 'Destination', 'tech-tasks');
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.change(screen.getByLabelText('Link 1 label'), { target: { value: 'Docs' } });
    fireEvent.change(screen.getByLabelText('Link 1 URL'), {
      target: { value: 'http://example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByText('Link 1: enter a URL that starts with https://')).toBeTruthy();
    const posts = (mock.mock.calls as unknown[][]).filter(
      ([url, init]) => url === '/api/tasks' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });

  it('clears stale link errors when a row is removed', async () => {
    const user = userEvent.setup();
    renderCreate([{ method: 'POST', url: '/api/tasks', body: { taskId: 'task-new' } }]);
    await pick(user, 'Team', 'Tech');
    fireEvent.change(screen.getByLabelText(/task title/i), { target: { value: 'Fix the intake' } });
    fireEvent.change(screen.getByLabelText(/due date/i), {
      target: { value: '2026-10-10T09:00' },
    });
    await pick(user, 'Destination', 'tech-tasks');
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.change(screen.getByLabelText('Link 1 label'), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByLabelText('Link 1 URL'), {
      target: { value: 'http://example.com' },
    });
    fireEvent.change(screen.getByLabelText('Link 2 label'), { target: { value: 'Good' } });
    fireEvent.change(screen.getByLabelText('Link 2 URL'), {
      target: { value: 'https://example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByText('Link 1: enter a URL that starts with https://')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove link 1' }));
    expect(screen.queryByText('Link 1: enter a URL that starts with https://')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Link 1 label').value).toBe('Good');
  });

  it('clears a link error when that row is edited', async () => {
    const user = userEvent.setup();
    renderCreate();
    await pick(user, 'Team', 'Tech');
    fireEvent.change(screen.getByLabelText(/task title/i), { target: { value: 'Fix the intake' } });
    fireEvent.change(screen.getByLabelText(/due date/i), {
      target: { value: '2026-10-10T09:00' },
    });
    await pick(user, 'Destination', 'tech-tasks');
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.change(screen.getByLabelText('Link 1 label'), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByLabelText('Link 1 URL'), {
      target: { value: 'http://example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByText('Link 1: enter a URL that starts with https://')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Link 1 URL'), {
      target: { value: 'https://example.com' },
    });
    expect(screen.queryByText('Link 1: enter a URL that starts with https://')).toBeNull();
  });

  it('puts a server field error under its field, in the summary, focuses the summary and keeps input', async () => {
    const user = userEvent.setup();
    renderCreate([
      {
        method: 'POST',
        url: '/api/tasks',
        status: 400,
        body: {
          error: 'invalid-body',
          fields: [
            { path: 'title', problem: 'Title is too long for a card.' },
            { path: 'links.0.url', problem: 'That link points somewhere unsafe.' },
          ],
        },
      },
    ]);
    await fillValid(user);
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Keep me' } });
    await user.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.change(screen.getByLabelText('Link 1 label'), { target: { value: 'Docs' } });
    fireEvent.change(screen.getByLabelText('Link 1 URL'), {
      target: { value: 'https://example.com' },
    });
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    const heading = await screen.findByText("There's a problem");
    const box = heading.closest('[tabindex="-1"]') as HTMLElement;
    await vi.waitFor(() => expect(document.activeElement).toBe(box));
    const title = document.getElementById('field-title')!;
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(within(box).getByText('Task title: Title is too long for a card.')).toBeTruthy();
    expect(screen.getAllByText(/That link points somewhere unsafe\.$/).length).toBe(2);
    expect(document.getElementById('field-links-0-url')!.getAttribute('aria-invalid')).toBe('true');
    expect((title as HTMLInputElement).value).toBe('Fix the intake');
    expect(screen.getByLabelText<HTMLTextAreaElement>(/description/i).value).toBe('Keep me');
    expect(screen.getByLabelText<HTMLInputElement>('Link 1 URL').value).toBe('https://example.com');
    // Editing the field clears just its own problem.
    fireEvent.change(title, { target: { value: 'Shorter' } });
    expect(document.getElementById('field-title')!.getAttribute('aria-invalid')).toBeNull();
  });

  it('client-side problems land under the field and move focus to the summary', async () => {
    const user = userEvent.setup();
    renderCreate();
    await screen.findByLabelText(/task title/i);
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    const heading = await screen.findByText("There's a problem");
    const box = heading.closest('[tabindex="-1"]') as HTMLElement;
    await vi.waitFor(() => expect(document.activeElement).toBe(box));
    expect(within(box).getByText('Team: Choose a team for the task.')).toBeTruthy();
    expect(within(box).getByText('Task title: Enter a title for the task.')).toBeTruthy();
    await user.click(within(box).getByText('Task title: Enter a title for the task.'));
    expect(document.activeElement).toBe(document.getElementById('field-title'));
  });

  it('typing a title updates the card preview title', async () => {
    renderCreate();
    const input = await screen.findByLabelText(/task title/i);
    expect(screen.getByText('Untitled task')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'Ship the poster' } });
    expect(screen.getByText('Ship the poster')).toBeTruthy();
    expect(screen.getByText('Preview')).toBeTruthy();
    expect(screen.getByText(/Art shown here is a stand-in/)).toBeTruthy();
  });

  it('shows backslashes and punctuation in a title literally in the preview', async () => {
    renderCreate();
    const input = await screen.findByLabelText(/task title/i);
    fireEvent.change(input, { target: { value: 'Fix a\\b *not bold* and _x_' } });
    expect(screen.getByText('Fix a\\b *not bold* and _x_')).toBeTruthy();
  });

  it('an incomplete due date does not break the preview or the form', async () => {
    renderCreate();
    const due = await screen.findByLabelText(/due date/i);
    fireEvent.change(due, { target: { value: '2026-10' } });
    expect(screen.getByText('Preview')).toBeTruthy();
  });

  it('shows the link count and keeps it at five', async () => {
    const user = userEvent.setup();
    renderCreate();
    await screen.findByLabelText(/task title/i);
    expect(screen.getByTestId('link-count').textContent).toBe('0 / 5');
    for (let i = 0; i < 5; i += 1)
      await user.click(screen.getByRole('button', { name: 'Add link' }));
    expect(screen.getByTestId('link-count').textContent).toBe('5 / 5');
    expect(screen.queryByRole('button', { name: 'Add link' })).toBeNull();
  });

  describe('every server path maps to a focusable control and visible text', () => {
    const serverFields = (fields: { path: string; problem: string }[]) => [
      {
        method: 'POST',
        url: '/api/tasks',
        status: 400,
        body: { error: 'invalid-body', fields },
      },
    ];

    it('priority and assignmentKind errors show inline and target a radio', async () => {
      const user = userEvent.setup();
      renderCreate(
        serverFields([
          { path: 'priority', problem: 'Priority is not allowed here.' },
          { path: 'assignmentKind', problem: 'Audience is not allowed here.' },
        ]),
      );
      await fillValid(user);
      await user.click(screen.getByRole('button', { name: 'Create task' }));
      await screen.findByText("There's a problem");
      expect(document.getElementById('field-priority')?.tagName).toBe('INPUT');
      expect(document.getElementById('field-assignmentKind')?.tagName).toBe('INPUT');
      // Summary entry plus the inline text next to the group.
      expect(screen.getAllByText(/Priority is not allowed here\.$/).length).toBe(2);
      expect(screen.getAllByText(/Audience is not allowed here\.$/).length).toBe(2);
      await user.click(screen.getByLabelText('Urgent'));
      expect(screen.queryAllByText('Priority is not allowed here.').length).toBe(0);
    });

    it('assigneeIds.<index> targets that person checkbox', async () => {
      const user = userEvent.setup();
      renderCreate(
        serverFields([{ path: 'assigneeIds.0', problem: 'That person is not on the team.' }]),
      );
      await fillValid(user);
      await user.click(screen.getByLabelText('Specific people'));
      await user.click(await screen.findByLabelText('Alex'));
      await user.click(screen.getByRole('button', { name: 'Create task' }));
      await screen.findByText("There's a problem");
      expect(document.getElementById('field-assigneeIds-0')?.tagName).toBe('INPUT');
      expect(screen.getAllByText(/That person is not on the team\.$/).length).toBe(2);
    });

    it('assigneeIds.<n> indexes the SELECTED people, so only the second member selected focuses that checkbox', async () => {
      const user = userEvent.setup();
      renderCreate(
        serverFields([{ path: 'assigneeIds.0', problem: 'That person is not on the team.' }]),
        undefined,
        {
          assignees: [
            { memberId: '555555555555555555', displayName: 'Alex' },
            { memberId: '666666666666666666', displayName: 'Blair' },
          ],
        },
      );
      await fillValid(user);
      await user.click(screen.getByLabelText('Specific people'));
      await user.click(await screen.findByLabelText('Blair'));
      await user.click(screen.getByRole('button', { name: 'Create task' }));
      const heading = await screen.findByText("There's a problem");
      const box = heading.closest('[tabindex="-1"]') as HTMLElement;
      await user.click(within(box).getByText('Person Blair: That person is not on the team.'));
      expect(document.activeElement).toBe(screen.getByLabelText('Blair'));
      // Inline text sits with Blair, not Alex, and clears when membership changes.
      expect(document.getElementById('field-assigneeIds-0')).not.toBe(
        screen.getByLabelText('Blair'),
      );
      await user.click(screen.getByLabelText('Alex'));
      expect(screen.queryAllByText('That person is not on the team.').length).toBe(0);
    });

    it('a label error and a URL error on the same row both show, each on its own control', async () => {
      const user = userEvent.setup();
      renderCreate(
        serverFields([
          { path: 'links.0.label', problem: 'Label is not allowed.' },
          { path: 'links.0.url', problem: 'URL is not allowed.' },
        ]),
      );
      await fillValid(user);
      await user.click(screen.getByRole('button', { name: 'Add link' }));
      fireEvent.change(screen.getByLabelText('Link 1 label'), { target: { value: 'Docs' } });
      fireEvent.change(screen.getByLabelText('Link 1 URL'), {
        target: { value: 'https://example.com' },
      });
      await user.click(screen.getByRole('button', { name: 'Create task' }));
      await screen.findByText("There's a problem");
      expect(screen.getAllByText(/Label is not allowed\.$/).length).toBe(2);
      expect(screen.getAllByText(/URL is not allowed\.$/).length).toBe(2);
      const labelBox = screen.getByLabelText('Link 1 label');
      const urlBox = screen.getByLabelText('Link 1 URL');
      expect(document.getElementById(labelBox.getAttribute('aria-describedby')!)?.textContent).toBe(
        'Label is not allowed.',
      );
      expect(document.getElementById(urlBox.getAttribute('aria-describedby')!)?.textContent).toBe(
        'URL is not allowed.',
      );
    });
  });
});

describe('R1 real validation and neutral preview', () => {
  it('blank and incomplete due show no invented date, urgency or overdue card', async () => {
    renderCreate();
    const due = await screen.findByLabelText(/due date/i);
    const preview = screen.getByRole('complementary', { name: 'Preview' });
    expect(preview.textContent).toContain('Choose a complete due date and timezone');
    expect(preview.querySelector('[data-discord-card]')).toBeNull();
    fireEvent.change(due, { target: { value: '2026-10' } });
    expect(preview.querySelector('[data-discord-card]')).toBeNull();
    expect(preview.textContent).not.toMatch(/Overdue|in 7 days|Updated/);
  });
  it('description and link limits are explained before typing', async () => {
    renderCreate();
    await screen.findByLabelText(/task title/i);
    expect(screen.getByText('Descriptions can be 5000 characters or fewer.')).toBeTruthy();
    expect(screen.getByText('Link labels can be 34 characters or fewer.')).toBeTruthy();
  });
  it('real code errors label and order all seven exact summary targets and focus on repeated rejection', async () => {
    const user = userEvent.setup();
    const paths = [
      'dueAt',
      'links.0.url',
      'links.0.label',
      'assigneeIds.0',
      'assignmentKind',
      'priority',
      'title',
    ];
    renderCreate(
      [
        {
          method: 'POST',
          url: '/api/tasks',
          status: 400,
          body: {
            error: 'invalid-body',
            fields: paths.map((path) => ({ path, problem: 'too_small' })),
          },
        },
      ],
      undefined,
      {
        assignees: [
          { memberId: '555555555555555555', displayName: 'Alex' },
          { memberId: '666666666666666666', displayName: 'Blair' },
        ],
      },
    );
    await fillValid(user);
    await user.click(screen.getByLabelText('Specific people'));
    await user.click(await screen.findByLabelText('Blair'));
    await user.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.change(screen.getByLabelText('Link 1 label'), { target: { value: 'Docs' } });
    fireEvent.change(screen.getByLabelText('Link 1 URL'), {
      target: { value: 'https://example.com' },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await user.click(screen.getByRole('button', { name: 'Create task' }));
      const box = (await screen.findByText("There's a problem")).closest(
        '[tabindex="-1"]',
      ) as HTMLElement;
      await vi.waitFor(() => expect(document.activeElement).toBe(box));
      const entries = within(box).getAllByRole('link');
      expect(entries.map((e) => e.textContent)).toEqual([
        'Task title: Too small.',
        'Audience: Too small.',
        'Person Blair: Too small.',
        'Due date and time: Too small.',
        'Priority: Too small.',
        'Link 1 label: Too small.',
        'Link 1 URL: Too small.',
      ]);
      const targets = [
        'field-title',
        'field-assignmentKind',
        'field-assigneeIds-1',
        'field-dueAt',
        'field-priority',
        'field-links-0-label',
        'field-links-0-url',
      ];
      for (let i = 0; i < entries.length; i++) {
        await user.click(entries[i]!);
        expect(document.activeElement).toBe(document.getElementById(targets[i]!));
      }
      expect(screen.getByLabelText<HTMLInputElement>(/task title/i).value).toBe('Fix the intake');
      expect(screen.getAllByText('Too small.')).toHaveLength(7);
    }
  });
  it('client link summaries explain each bad row and the exact field', async () => {
    const user = userEvent.setup();
    renderCreate();
    await fillValid(user);
    for (let i = 0; i < 2; i++) await user.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.change(screen.getByLabelText('Link 1 URL'), {
      target: { value: 'https://example.com' },
    });
    fireEvent.change(screen.getByLabelText('Link 2 label'), { target: { value: 'Docs' } });
    fireEvent.change(screen.getByLabelText('Link 2 URL'), {
      target: { value: 'http://example.com' },
    });
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    const box = (await screen.findByText("There's a problem")).closest(
      '[tabindex="-1"]',
    ) as HTMLElement;
    expect(
      within(box)
        .getAllByRole('link')
        .map((e) => e.textContent),
    ).toEqual([
      'Link 1 label: Enter a label for link 1',
      'Link 2 URL: Link 2: enter a URL that starts with https://',
    ]);
  });
});

it('R1 valid due and zone render the real card with loaded names and external link notice', async () => {
  const user = userEvent.setup();
  renderCreate();
  await fillValid(user);
  await pick(user, 'Timezone', 'UTC');
  await user.click(screen.getByLabelText('Specific people'));
  await user.click(await screen.findByLabelText('Alex'));
  await user.click(screen.getByRole('button', { name: 'Add link' }));
  fireEvent.change(screen.getByLabelText('Link 1 label'), { target: { value: 'Docs' } });
  fireEvent.change(screen.getByLabelText('Link 1 URL'), {
    target: { value: 'https://example.com' },
  });
  const preview = screen.getByRole('complementary', { name: 'Preview' });
  expect(within(preview).getByText('Alex')).toBeTruthy();
  expect(preview.textContent).not.toContain('<@');
  expect(
    within(preview).getByRole('link', { name: 'Docs (opens in a new tab)' }).getAttribute('href'),
  ).toBe('https://example.com/');
  const dates = Array.from(preview.querySelectorAll('time')).map((e) => e.getAttribute('datetime'));
  expect(dates).toContain('2026-10-10T09:00:00.000Z');
});
