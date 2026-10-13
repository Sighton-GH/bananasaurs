// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router, useLocation, useSearch } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../../../test-support.js';
import { pick } from '../test-support.js';
import { TaskTeamsPage } from './index.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const SETUP = {
  teams: [{ teamId: 'team-1', name: 'Tech', categoryId: 'cat-1', issues: ['No lead role set.'] }],
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
const DIRECTORY = {
  members: [{ memberId: 'u-9', username: 'sam', displayName: 'Sam', roleIds: [] }],
};

function Probe() {
  const [loc] = useLocation();
  const search = useSearch();
  return <p data-testid="url">{`${loc}?${search}`}</p>;
}

type Route = { method?: string; url: string; status?: number; body: unknown };
function render(path = '/tasks/teams', extra: readonly Route[] = [], setup: unknown = SETUP) {
  const mock = stubFetch([
    { url: '/api/tasks/setup', body: setup },
    { url: '/api/guild/channels', body: CHANNELS },
    { url: '/api/guild/roles', body: ROLES },
    { url: '/api/tasks/teams/team-1/members', body: { members: [] } },
    { url: '/api/guild/members?limit=100', body: DIRECTORY },
    ...extra,
  ]);
  const mem = memoryLocation({ path, record: true });
  renderWithSession(
    <Router hook={mem.hook} searchHook={mem.searchHook}>
      <TaskTeamsPage />
      <Probe />
    </Router>,
    { session: { ...TEST_SESSION, instanceOwner: true } },
  );
  return { mock, mem };
}
const callsTo = (mock: ReturnType<typeof stubFetch>, url: string, method: string) =>
  (mock.mock.calls as unknown[][]).filter(
    ([u, i]) => u === url && (i as RequestInit | undefined)?.method === method,
  );

describe('teams page tabs and kit controls', () => {
  it('Teams is the default tab and lists teams in a table with setup issues', async () => {
    render();
    expect((await screen.findByRole('tab', { name: 'Teams' })).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getByText('No lead role set.')).toBeTruthy();
    expect(document.querySelector('select:not([aria-hidden])')).toBeNull();
  });

  it('opens straight on ?tab=members and invalid tabs fall back to Teams', async () => {
    render('/tasks/teams?tab=members');
    expect(
      (await screen.findByRole('tab', { name: 'Members' })).getAttribute('aria-selected'),
    ).toBe('true');
    cleanup();
    render('/tasks/teams?tab=zzz');
    expect((await screen.findByRole('tab', { name: 'Teams' })).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('choosing a tab pushes ?tab= and keeps other query', async () => {
    const user = userEvent.setup();
    const { mem } = render('/tasks/teams?x=1');
    await user.click(await screen.findByRole('tab', { name: 'Members' }));
    expect(screen.getByTestId('url').textContent).toContain('tab=members');
    expect(screen.getByTestId('url').textContent).toContain('x=1');
    expect(mem.history.length).toBe(2);
  });

  it('president role Select sends DELETE for none', async () => {
    const user = userEvent.setup();
    const { mock } = render('/tasks/teams', [
      { method: 'DELETE', url: '/api/tasks/president-role', body: {} },
    ]);
    await pick(user, 'President role', 'Not selected');
    await vi.waitFor(() =>
      expect(callsTo(mock, '/api/tasks/president-role', 'DELETE').length).toBe(1),
    );
  });

  it('president role Select sends PUT { roleId } for a role', async () => {
    const user = userEvent.setup();
    const { mock } = render(
      '/tasks/teams',
      [{ method: 'PUT', url: '/api/tasks/president-role', body: {} }],
      { ...SETUP, presidentRoleId: null },
    );
    await pick(user, 'President role', /^President/);
    await vi.waitFor(() => {
      const puts = callsTo(mock, '/api/tasks/president-role', 'PUT');
      expect(puts.length).toBe(1);
      expect(bodyOf(puts[0]!)).toEqual({ roleId: 'role-1' });
    });
  });

  it('add team with Selects posts the same body', async () => {
    const user = userEvent.setup();
    const { mock } = render('/tasks/teams', [
      { method: 'POST', url: '/api/tasks/teams', body: { teamId: 'team-2' } },
    ]);
    fireEvent.change(await screen.findByLabelText('Team name'), { target: { value: 'Media' } });
    await pick(user, 'Discord category', 'Tech');
    await pick(user, 'Announcements channel', 'tech-tasks');
    await user.click(screen.getByRole('button', { name: 'Add team' }));
    await vi.waitFor(() => {
      const posts = callsTo(mock, '/api/tasks/teams', 'POST');
      expect(posts.length).toBe(1);
      expect(bodyOf(posts[0]!)).toEqual({
        name: 'Media',
        categoryId: 'cat-1',
        kind: 'subteam',
        announcementChannelId: 'chan-1',
      });
    });
  });

  it('edit team: Select picks send the same PUT, and a failed delete keeps the form and its input', async () => {
    const user = userEvent.setup();
    const { mock } = render('/tasks/teams', [
      { method: 'PUT', url: '/api/tasks/teams/team-1', body: {} },
      {
        method: 'DELETE',
        url: '/api/tasks/teams/team-1',
        status: 409,
        body: { error: 'team-has-tasks' },
      },
    ]);
    await user.click(await screen.findByRole('button', { name: 'Edit Tech' }));
    fireEvent.change(await screen.findByLabelText('Team name', { selector: '#edit-team-name' }), {
      target: { value: 'Tech 2' },
    });
    await pick(user, /^Lead role$/, 'Tech lead');
    await user.click(screen.getByRole('button', { name: 'Save team' }));
    await vi.waitFor(() => {
      const puts = callsTo(mock, '/api/tasks/teams/team-1', 'PUT');
      expect(puts.length).toBe(1);
      expect(bodyOf(puts[0]!)).toEqual({
        name: 'Tech 2',
        announcementChannelId: null,
        leadRoleId: 'role-2',
        memberRoleId: null,
      });
    });
    await user.click(screen.getByRole('button', { name: 'Delete team' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete team' }),
    );
    expect((await screen.findAllByText(/team-has-tasks/)).length).toBeGreaterThan(0);
    expect((document.getElementById('edit-team-name') as HTMLInputElement).value).toBe('Tech 2');
  });

  it('members tab: choose a team, search the directory, pick a person and post the same body', async () => {
    const user = userEvent.setup();
    const { mock } = render('/tasks/teams?tab=members', [
      { method: 'POST', url: '/api/tasks/memberships', body: {} },
    ]);
    await pick(user, 'Team', 'Tech');
    fireEvent.change(await screen.findByLabelText('Search the member directory'), {
      target: { value: 'sa' },
    });
    await pick(user, 'Choose member', /Sam/);
    await pick(user, 'Team role', 'Lead');
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    await vi.waitFor(() => {
      const posts = callsTo(mock, '/api/tasks/memberships', 'POST');
      expect(posts.length).toBe(1);
      expect(bodyOf(posts[0]!)).toEqual({ teamId: 'team-1', discordUserId: 'u-9', kind: 'lead' });
    });
  });
});
