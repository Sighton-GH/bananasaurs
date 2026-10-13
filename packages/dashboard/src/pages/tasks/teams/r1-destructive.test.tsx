// @vitest-environment jsdom
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderWithSession, stubFetch, TEST_SESSION } from '../../../test-support.js';
import { pick } from '../test-support.js';
import { TaskTeamsPage } from './index.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const SETUP = {
  teams: [{ teamId: 'team-1', name: 'Tech', categoryId: 'cat-1', issues: [] }],
  presidentRoleCandidates: [{ roleId: 'role-1', name: 'President' }],
  presidentRoleId: 'role-1',
};
type Route_ = { method?: string; url: string; status?: number; body: unknown };
const MEMBERS = {
  members: [
    { discordUserId: 'u1', kind: 'member', displayName: 'Sam' },
    { discordUserId: 'u2', kind: 'lead', displayName: 'Alex' },
  ],
};

function render(path: string, extra: Route_[] = []) {
  const mock = stubFetch([
    { url: '/api/tasks/setup', body: SETUP },
    {
      url: '/api/guild/channels',
      body: { channels: [{ channelId: 'cat-1', name: 'Tech', kind: 'category' }] },
    },
    { url: '/api/guild/roles', body: { roles: [] } },
    { url: '/api/tasks/teams/team-1/members', body: MEMBERS },
    { url: '/api/guild/members?limit=100', body: { members: [] } },
    ...extra,
  ]);
  const mem = memoryLocation({ path });
  renderWithSession(
    <Router hook={mem.hook} searchHook={mem.searchHook}>
      <TaskTeamsPage />
    </Router>,
    { session: { ...TEST_SESSION, instanceOwner: true } },
  );
  const original = mock.getMockImplementation()!;
  mock.mockImplementation((input, init) => {
    const route = extra.find((r) => r.url === input && r.method === init?.method);
    return route?.status === 204
      ? Promise.resolve(new Response(null, { status: 204 }))
      : original(input, init);
  });
  return mock;
}
const deletes = (mock: ReturnType<typeof stubFetch>) =>
  (mock.mock.calls as unknown[][]).filter(
    ([, i]) => (i as RequestInit | undefined)?.method === 'DELETE',
  );

// Keep the write unresolved so repeated activation and cancellation are tested
// during the request, not after an already-completed response.
function deferDelete(mock: ReturnType<typeof stubFetch>, url: string) {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const original = mock.getMockImplementation()!;
  mock.mockImplementation((input, init) =>
    input === url && init?.method === 'DELETE' ? pending : original(input, init),
  );
  return () => resolve(new Response(null, { status: 204 }));
}

describe('R1 destructive confirmations (teams)', () => {
  it('member Remove: zero writes on first activation, Cancel/Escape restore opener, confirm sends one DELETE and lands on the heading', async () => {
    const user = userEvent.setup();
    const mock = render('/tasks/teams?tab=members', [
      { method: 'DELETE', url: '/api/tasks/memberships/team-1/u1', status: 204, body: undefined },
    ]);
    await pick(user, 'Team', 'Tech');
    const opener = (await screen.findAllByRole('button', { name: 'Remove' }))[0]!;
    opener.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Remove Sam from Tech/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(deletes(mock)).toHaveLength(0);
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
    await user.click(opener);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deletes(mock)).toHaveLength(0);
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);
    expect(
      within(await screen.findByRole('dialog')).getByText(/Remove Alex from Tech/),
    ).toBeTruthy();
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove member' }),
    );
    await vi.waitFor(() => expect(deletes(mock)).toHaveLength(1));
    expect(deletes(mock)[0]![0]).toBe('/api/tasks/memberships/team-1/u1');
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Members of Tech' })),
    );
  });

  it('team Delete: zero writes until confirmed; confirm sends one DELETE; refusal keeps the editor and message', async () => {
    const user = userEvent.setup();
    const mock = render('/tasks/teams', [
      {
        method: 'DELETE',
        url: '/api/tasks/teams/team-1',
        status: 409,
        body: { error: 'team-has-tasks' },
      },
    ]);
    await user.click(await screen.findByRole('button', { name: 'Edit Tech' }));
    const opener = await screen.findByRole('button', { name: 'Delete team' });
    opener.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Delete team Tech\?/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(deletes(mock)).toHaveLength(0);
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(deletes(mock)).toHaveLength(0);
    await user.click(opener);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete team' }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain('team-has-tasks');
    expect(deletes(mock)).toHaveLength(1);
    expect(deletes(mock)[0]![0]).toBe('/api/tasks/teams/team-1');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete team' })).toBeTruthy();
  });

  it.each(
    ['member', 'team'].flatMap((kind) =>
      [401, 403, 404, 500, 503, 599].map((status) => ({ kind, status })),
    ),
  )('N17 $kind HTTP$status retains opener and editor without reload', async ({ kind, status }) => {
    const user = userEvent.setup();
    const url = kind === 'member' ? '/api/tasks/memberships/team-1/u1' : '/api/tasks/teams/team-1';
    const mock = render(kind === 'member' ? '/tasks/teams?tab=members' : '/tasks/teams', [
      {
        method: 'DELETE',
        url,
        status,
        body: { error: status === 401 ? 'invalid-credentials' : 'tasks-forbidden' },
      },
    ]);
    if (kind === 'member') await pick(user, 'Team', 'Tech');
    else await user.click(await screen.findByRole('button', { name: 'Edit Tech' }));
    const opener = (
      await screen.findAllByRole('button', { name: kind === 'member' ? 'Remove' : 'Delete team' })
    )[0]!;
    const readsBefore = mock.mock.calls.filter(([, init]) => init?.method === 'GET').length;
    await user.click(opener);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: kind === 'member' ? 'Remove member' : 'Delete team',
      }),
    );
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    expect(mock.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(readsBefore);
    expect(screen.getByRole('alert').textContent).toContain(
      status === 401 ? 'invalid-credentials' : 'tasks-forbidden',
    );
  });

  it.each(
    ['member', 'team'].flatMap((kind) => ['cancel', 'retry'].map((outcome) => ({ kind, outcome }))),
  )('N17 $kind reauth $outcome preserves deletion truth', async ({ kind, outcome }) => {
    const user = userEvent.setup();
    const url = kind === 'member' ? '/api/tasks/memberships/team-1/u1' : '/api/tasks/teams/team-1';
    const mock = render(kind === 'member' ? '/tasks/teams?tab=members' : '/tasks/teams', [
      { method: 'POST', url: '/api/reauth', body: {} },
    ]);
    const original = mock.getMockImplementation()!;
    let writes = 0;
    mock.mockImplementation((input, init) => {
      if (input !== url || init?.method !== 'DELETE') return original(input, init);
      writes++;
      return Promise.resolve(
        writes === 1
          ? new Response(JSON.stringify({ error: 'reauth-required' }), { status: 401 })
          : new Response(null, { status: 204 }),
      );
    });
    if (kind === 'member') await pick(user, 'Team', 'Tech');
    else await user.click(await screen.findByRole('button', { name: 'Edit Tech' }));
    const opener = (
      await screen.findAllByRole('button', { name: kind === 'member' ? 'Remove' : 'Delete team' })
    )[0]!;
    await user.click(opener);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: kind === 'member' ? 'Remove member' : 'Delete team',
      }),
    );
    const reauth = (await screen.findByText('Confirm your password')).closest(
      '[role="dialog"]',
    ) as HTMLElement;
    expect(writes).toBe(1);
    if (outcome === 'cancel') {
      await user.click(within(reauth).getByRole('button', { name: 'Cancel' }));
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await vi.waitFor(() => expect(document.activeElement).toBe(opener));
      expect(writes).toBe(1);
      expect(screen.getByText('Nothing was changed.')).toBeTruthy();
    } else {
      await user.type(within(reauth).getByLabelText('Password'), 'synthetic-password');
      await user.click(within(reauth).getByRole('button', { name: 'Confirm' }));
      await vi.waitFor(() => expect(writes).toBe(2));
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole('heading', {
            name: kind === 'member' ? 'Members of Tech' : 'Teams & members',
          }),
        ),
      );
    }
  });

  it.each([
    {
      name: 'member Remove',
      path: '/tasks/teams?tab=members',
      opener: 'Remove',
      confirm: 'Remove member',
      url: '/api/tasks/memberships/team-1/u1',
      heading: 'Members of Tech',
    },
    {
      name: 'team Delete',
      path: '/tasks/teams',
      opener: 'Delete team',
      confirm: 'Delete team',
      url: '/api/tasks/teams/team-1',
      heading: 'Teams & members',
    },
  ])(
    '$name keeps one DELETE pending, blocks Escape/Cancel and focuses the heading after success',
    async ({ path, opener, confirm, url, heading }) => {
      const user = userEvent.setup();
      const mock = render(path);
      const finish = deferDelete(mock, url);
      try {
        if (opener === 'Remove') await pick(user, 'Team', 'Tech');
        else await user.click(await screen.findByRole('button', { name: 'Edit Tech' }));
        await user.click((await screen.findAllByRole('button', { name: opener }))[0]!);
        const dialog = await screen.findByRole('dialog');
        const confirmButton = within(dialog).getByRole('button', { name: confirm });
        const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
        await user.dblClick(confirmButton);
        expect(deletes(mock)).toHaveLength(1);
        expect(deletes(mock)[0]![0]).toBe(url);
        expect((deletes(mock)[0]![1] as RequestInit).body).toBeUndefined();
        expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
        expect((cancel as HTMLButtonElement).disabled).toBe(true);
        await user.keyboard('{Enter}{Escape}');
        expect(screen.getByRole('dialog')).toBe(dialog);
        await user.click(cancel);
        expect(screen.getByRole('dialog')).toBe(dialog);
        expect(deletes(mock)).toHaveLength(1);
      } finally {
        await act(async () => finish());
      }
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('heading', { name: heading })),
      );
      expect(deletes(mock)).toHaveLength(1);
    },
  );
});
