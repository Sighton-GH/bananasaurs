// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { pick } from '../test-support.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { renderWithSession, stubFetch, TEST_SESSION } from '../../../test-support.js';
import { TaskTeamsPage } from './index.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const SETUP = {
  teams: [{ teamId: 'team-1', name: 'Tech', categoryId: 'cat-1', issues: [] }],
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

type StubRoute = { method?: string; url: string; status?: number; body: unknown };

function renderTeams(extraRoutes: readonly StubRoute[] = []) {
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

describe('teams editor focus (d3 L05)', () => {
  it('Edit moves focus to the first field of the editor', async () => {
    const user = userEvent.setup();
    renderTeams();
    await user.click(await screen.findByRole('button', { name: 'Edit Tech' }));
    const name = await screen.findByDisplayValue('Tech');
    await vi.waitFor(() => expect(document.activeElement).toBe(name));
  });

  it('closing the editor returns focus to the Edit trigger', async () => {
    const user = userEvent.setup();
    renderTeams();
    const trigger = await screen.findByRole('button', { name: 'Edit Tech' });
    await user.click(trigger);
    await screen.findByDisplayValue('Tech');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe('add team focus (d3 L05/L06)', () => {
  it('empty submit focuses the error with no request sent', async () => {
    const mock = renderTeams();
    fireEvent.click(await screen.findByRole('button', { name: 'Add team' }));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => a.textContent?.includes('Enter a team name.'))).toBe(true);
    const writes = (mock.mock.calls as unknown[][]).filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(writes).toHaveLength(0);
    await vi.waitFor(() =>
      expect(
        alerts.some((a) => document.activeElement === a || a.contains(document.activeElement)),
      ).toBe(true),
    );
  });

  it('creating a team lands focus in the first field for the next one', async () => {
    const user = userEvent.setup();
    const mock = renderTeams([
      { method: 'POST', url: '/api/tasks/teams', body: { teamId: 'team-2' } },
    ]);
    fireEvent.change(await screen.findByLabelText('Team name'), { target: { value: 'Docs' } });
    await pick(user, 'Discord category', 'Tech');
    fireEvent.click(screen.getByRole('button', { name: 'Add team' }));
    const calls = () => mock.mock.calls as unknown[][];
    await vi.waitFor(() => {
      const posts = calls().filter(
        ([url, init]) =>
          url === '/api/tasks/teams' && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts.length).toBeGreaterThan(0);
    });
    // The create reloads the setup, remounting the form; wait for that.
    await vi.waitFor(() => {
      const gets = calls().filter(([url]) => url === '/api/tasks/setup');
      expect(gets.length).toBeGreaterThan(1);
    });
    const name = await screen.findByLabelText<HTMLInputElement>('Team name');
    expect(name.value).toBe('');
    await vi.waitFor(() => {
      const current = document.getElementById('add-team-name');
      expect(current).not.toBeNull();
      expect(document.activeElement).toBe(current);
    });
  });
});
