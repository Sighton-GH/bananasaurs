// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { pick } from '../test-support.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { renderWithSession, stubFetch, TEST_SESSION } from '../../../test-support.js';
import { TaskTeamsPage } from './index.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const SETUP = {
  teams: [{ teamId: 'team-1', name: 'Tech', issues: [] }],
  presidentRoleCandidates: [{ roleId: 'role-1', name: 'President' }],
  presidentRoleId: 'role-1',
};

const CHANNELS = {
  channels: [
    { channelId: 'cat-1', name: 'Tech', kind: 'category' },
    { channelId: 'chan-1', name: 'tech-tasks', kind: 'text', parentId: 'cat-1' },
  ],
};

const ROLES = {
  roles: [
    { roleId: 'role-1', name: 'President' },
    { roleId: 'role-2', name: 'Tech lead' },
  ],
};

function renderTeams(
  extraRoutes: readonly { method?: string; url: string; status?: number; body: unknown }[] = [],
  taskPosts?: unknown,
) {
  const mock = stubFetch([
    { url: '/api/tasks/setup', body: taskPosts === undefined ? SETUP : { ...SETUP, taskPosts } },
    { url: '/api/guild/channels', body: CHANNELS },
    { url: '/api/guild/roles', body: ROLES },
    { url: '/api/tasks/teams/team-1/members', body: { members: [] } },
    ...extraRoutes,
  ]);
  renderWithSession(
    <Router>
      <TaskTeamsPage />
    </Router>,
    { session: { ...TEST_SESSION, instanceOwner: true } },
  );
  return mock;
}

describe('task teams page', () => {
  it('warns with the off text when posts are off', async () => {
    renderTeams([], {
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
    renderTeams([], { enabled: true, switchOn: true, message: 'Task posts are on.' });
    expect(await screen.findByText('Task posts are on.')).toBeTruthy();
  });

  it('clears the president role with a DELETE', async () => {
    const mock = renderTeams([{ method: 'DELETE', url: '/api/tasks/president-role', body: {} }]);
    await pick(userEvent.setup(), 'President role', 'Not selected');
    await vi.waitFor(() => {
      const calls = mock.mock.calls as unknown[][];
      expect(
        calls.some(
          ([url, init]) =>
            url === '/api/tasks/president-role' &&
            (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true);
    });
  });

  it('shows the inline message when team delete returns 409 team-has-tasks', async () => {
    renderTeams([
      {
        method: 'DELETE',
        url: '/api/tasks/teams/team-1',
        status: 409,
        body: { error: 'team-has-tasks' },
      },
    ]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit Tech' }));
    await user.click(await screen.findByRole('button', { name: 'Delete team' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete team' }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('team-has-tasks');
  });

  it('team edit announcement select lists only channels in the team category', async () => {
    stubFetch([
      {
        url: '/api/tasks/setup',
        body: {
          ...SETUP,
          teams: [{ teamId: 'team-1', name: 'Tech', categoryId: 'cat-1', issues: [] }],
        },
      },
      {
        url: '/api/guild/channels',
        body: {
          channels: [
            { channelId: 'cat-1', name: 'Tech', kind: 'category' },
            { channelId: 'cat-2', name: 'Other', kind: 'category' },
            { channelId: 'chan-1', name: 'tech-tasks', kind: 'text', parentId: 'cat-1' },
            { channelId: 'chan-2', name: 'other-tasks', kind: 'text', parentId: 'cat-2' },
          ],
        },
      },
      { url: '/api/guild/roles', body: ROLES },
      { url: '/api/tasks/teams/team-1/members', body: { members: [] } },
    ]);
    renderWithSession(
      <Router>
        <TaskTeamsPage />
      </Router>,
      { session: { ...TEST_SESSION, instanceOwner: true } },
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit Tech' }));
    await user.click(await screen.findByRole('combobox', { name: /^Announcements channel$/ }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toContain('tech-tasks');
    expect(options).not.toContain('other-tasks');
  });
});
