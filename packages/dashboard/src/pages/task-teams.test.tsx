// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { TaskTeamsPage } from './task-teams.js';

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
) {
  const mock = stubFetch([
    { url: '/api/tasks/setup', body: SETUP },
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
  it('clears the president role with a DELETE', async () => {
    const mock = renderTeams([{ method: 'DELETE', url: '/api/tasks/president-role', body: {} }]);
    const select = await screen.findByLabelText(/president role/i);
    fireEvent.change(select, { target: { value: '' } });
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
    fireEvent.click(await screen.findByRole('button', { name: 'Delete team' }));
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
    const select = await screen.findByLabelText('Announcements channel');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toContain('tech-tasks');
    expect(options).not.toContain('other-tasks');
  });
});
