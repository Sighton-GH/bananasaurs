// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router, Route, useLocation, useSearch } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { AccountEditPage } from './account-edit.js';

function LocationProbe() {
  const [location] = useLocation();
  const search = useSearch();
  return (
    <p data-testid="location">
      {location}
      {search === '' ? '' : `?${search}`}
    </p>
  );
}

const LIST = {
  accounts: [
    {
      accountId: 'acct-1',
      username: 'bryan',
      isOwner: true,
      disabled: false,
      lockedUntil: null,
      createdAt: 0,
      revealable: false,
    },
    {
      accountId: 'acct-2',
      username: 'sam',
      isOwner: false,
      disabled: false,
      lockedUntil: null,
      createdAt: 0,
      revealable: true,
    },
  ],
  capabilities: {
    'acct-1': [],
    'acct-2': ['config.read', 'audit.read'],
  },
};

function renderEdit(
  path: string,
  routes: readonly { method?: string; url: string; status?: number; body: unknown }[],
  session: typeof TEST_SESSION = TEST_SESSION,
) {
  const mock = stubFetch(routes);
  const { hook, history } = memoryLocation({ path, record: true });
  renderWithSession(
    <Router hook={hook}>
      <Route path="/accounts/:username" component={AccountEditPage} />
      <LocationProbe />
    </Router>,
    { session },
  );
  return { mock, history };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Like renderEdit, but write requests (non-GET) are answered by the test, so
 * a save can be held in flight while tabs change.
 */
function renderEditWithFetch(
  path: string,
  writeImpl: (url: string) => Promise<Response>,
  session: typeof TEST_SESSION = TEST_SESSION,
) {
  const calls: { url: string; method: string }[] = [];
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    if (method === 'GET' && url === '/api/accounts') return Promise.resolve(json(LIST));
    return writeImpl(url);
  });
  vi.stubGlobal('fetch', mock);
  const { hook, history, navigate } = memoryLocation({ path, record: true });
  renderWithSession(
    <Router hook={hook}>
      <Route path="/accounts/:username" component={AccountEditPage} />
      <LocationProbe />
    </Router>,
    { session },
  );
  return { mock, calls, history, navigate };
}

/** Open the Permissions tab for sam, pick Custom and check Moderate members. */
async function draftCustomWithModeration(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('sam');
  await user.click(screen.getByRole('tab', { name: 'Permissions' }));
  await user.click(
    screen.getByRole('radio', { name: 'Custom Pick individual permissions below.' }),
  );
  await user.click(screen.getByLabelText('Moderate members'));
}

const writesOf = (calls: readonly { method: string }[]): number =>
  calls.filter((c) => c.method !== 'GET').length;

const LIST_WITH_JANE = {
  accounts: [
    ...LIST.accounts,
    {
      accountId: 'acct-3',
      username: 'jane',
      isOwner: false,
      disabled: false,
      lockedUntil: null,
      createdAt: 0,
      revealable: true,
    },
  ],
  capabilities: {
    ...LIST.capabilities,
    'acct-3': ['config.read', 'audit.read'],
  },
};

interface PendingWrite {
  readonly url: string;
  readonly release: (body: unknown, status?: number) => void;
}

/**
 * Deferred-response variant: every write is held until the test releases it,
 * and the accounts list can change between reads. Every pending response is
 * released before the test ends.
 */
function renderEditDeferred(path: string) {
  const pending: PendingWrite[] = [];
  const calls: { url: string; method: string }[] = [];
  let currentList: unknown = LIST_WITH_JANE;
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    if (method === 'GET' && url === '/api/accounts') return Promise.resolve(json(currentList));
    return new Promise<Response>((resolve) => {
      pending.push({
        url,
        release: (body: unknown, status = 200) => resolve(json(body, status)),
      });
    });
  });
  vi.stubGlobal('fetch', mock);
  const { hook, navigate } = memoryLocation({ path, record: true });
  renderWithSession(
    <Router hook={hook}>
      <Route path="/accounts/:username" component={AccountEditPage} />
      <LocationProbe />
    </Router>,
    { session: TEST_SESSION },
  );
  return {
    calls,
    navigate,
    writesTo: (prefix: string): number =>
      calls.filter((c) => c.method !== 'GET' && c.url.startsWith(prefix)).length,
    gets: (): number => calls.filter((c) => c.method === 'GET').length,
    releaseAll: (body: unknown, status = 200): void => {
      pending.forEach((w) => w.release(body, status));
      pending.length = 0;
    },
    releaseMatching: (prefix: string, body: unknown, status = 200): void => {
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        if (pending[i]!.url.startsWith(prefix)) {
          pending[i]!.release(body, status);
          pending.splice(i, 1);
        }
      }
    },
    setList: (next: unknown): void => {
      currentList = next;
    },
  };
}

async function openPermissionsTab(label: string) {
  await screen.findByText(label);
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: 'Permissions' }));
  return user;
}

const customRoleRadio = () =>
  screen.getByRole('radio', { name: 'Custom Pick individual permissions below.' });

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('AccountEditPage', () => {
  it('splits the page into Summary, Permissions, Password and Sessions and apps tabs', async () => {
    renderEdit('/accounts/sam', [{ url: '/api/accounts', body: LIST }]);
    await screen.findByText('sam');
    const tablist = screen.getByRole('tablist', { name: 'Account sections' });
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Summary', 'Permissions', 'Password', 'Sessions and apps']);
  });

  it('opens on the Summary tab with the danger zone at its bottom', async () => {
    renderEdit('/accounts/sam', [{ url: '/api/accounts', body: LIST }]);
    await screen.findByText('sam');
    expect(screen.getByRole('tab', { name: 'Summary' }).getAttribute('aria-selected')).toBe('true');
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual(['Summary', 'Danger zone']);
    expect(screen.queryByRole('heading', { name: 'Permissions on this server' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Password' })).toBeNull();
  });

  it('opens the tab named in the URL query', async () => {
    renderEdit('/accounts/sam?tab=password', [{ url: '/api/accounts', body: LIST }]);
    await screen.findByRole('heading', { name: 'Password' });
    expect(screen.getByRole('tab', { name: 'Password' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('heading', { name: 'Password' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Summary' })).toBeNull();
  });

  it('falls back to Summary for an unknown tab in the query', async () => {
    renderEdit('/accounts/sam?tab=bogus', [{ url: '/api/accounts', body: LIST }]);
    await screen.findByText('sam');
    expect(screen.getByRole('tab', { name: 'Summary' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeTruthy();
  });

  it('switching tabs pushes the query string so Back returns, and sends no requests', async () => {
    const { mock, history } = renderEdit('/accounts/sam', [{ url: '/api/accounts', body: LIST }]);
    await screen.findByText('sam');
    const callsBefore = mock.mock.calls.length;
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    expect(screen.getByTestId('location').textContent).toBe('/accounts/sam?tab=permissions');
    expect(screen.getByRole('heading', { name: 'Permissions on this server' })).toBeTruthy();
    expect(mock.mock.calls.length).toBe(callsBefore);
    // The switch pushed a new entry, so the browser Back button lands on the
    // previous tab rather than leaving the page.
    expect(history).toEqual(['/accounts/sam', '/accounts/sam?tab=permissions']);
  });

  it('says the account does not exist without revealing the other accounts', async () => {
    renderEdit('/accounts/nobody', [{ url: '/api/accounts', body: LIST }]);
    expect(await screen.findByText(/No such account/)).toBeTruthy();
    expect(screen.queryByText('bryan')).toBeNull();
    expect(screen.queryByText('sam')).toBeNull();
  });

  it('shows the forbidden state when the server refuses the account list', async () => {
    renderEdit('/accounts/sam', [
      {
        url: '/api/accounts',
        status: 403,
        body: {
          error: 'forbidden',
          title: "You don't have access to this",
          message: 'Your account cannot see other accounts.',
        },
      },
    ]);
    expect(await screen.findByText('Your account cannot see other accounts.')).toBeTruthy();
  });

  it('encodes the username in every request URL', async () => {
    const spaced = {
      accounts: [
        LIST.accounts[0],
        {
          accountId: 'acct-9',
          username: 'jo y',
          isOwner: false,
          disabled: false,
          lockedUntil: null,
          createdAt: 0,
          revealable: false,
        },
      ],
      capabilities: { 'acct-1': [], 'acct-9': [] },
    };
    const { mock } = renderEdit('/accounts/jo%20y', [
      { url: '/api/accounts', body: spaced },
      {
        method: 'POST',
        url: '/api/accounts/jo%20y/disabled',
        body: {
          changed: true,
          username: 'jo y',
          isOwner: false,
          disabled: true,
          lockedUntil: null,
          enabledOwnersRemaining: 1,
        },
      },
    ]);
    await screen.findByText('jo y');
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Disable account' }));
    });
    const calls = mock.mock.calls.filter(
      (c) => (c[0] as string) === '/api/accounts/jo%20y/disabled',
    );
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]!)).toEqual({ disabled: true });
  });

  it('preselects the role from the held capabilities and saves only the difference', async () => {
    const { mock } = renderEdit('/accounts/sam', [
      { url: '/api/accounts', body: LIST },
      { method: 'POST', url: '/api/accounts/sam/capabilities', body: { outcome: 'granted' } },
      {
        method: 'DELETE',
        url: '/api/accounts/sam/capabilities/config.read',
        body: { outcome: 'revoked' },
      },
      {
        method: 'DELETE',
        url: '/api/accounts/sam/capabilities/audit.read',
        body: { outcome: 'revoked' },
      },
    ]);
    expect(await screen.findByText('sam')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    // Viewer preselected from the two held capabilities.
    expect(
      screen
        .getByRole('radio', {
          name: 'Viewer Sees settings, logs and history. Changes nothing.',
        })
        .getAttribute('aria-checked'),
    ).toBe('true');
    // Move to Custom and add one permission: one grant, no revokes.
    fireEvent.click(
      screen.getByRole('radio', { name: 'Custom Pick individual permissions below.' }),
    );
    fireEvent.click(screen.getByLabelText('Moderate members'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    const grants = mock.mock.calls.filter(
      (c) => (c[0] as string) === '/api/accounts/sam/capabilities',
    );
    expect(grants).toHaveLength(1);
    expect(bodyOf(grants[0]!)).toEqual({ capability: 'moderation.act' });
    const revokes = mock.mock.calls.filter((c) =>
      (c[0] as string).startsWith('/api/accounts/sam/capabilities/'),
    );
    expect(revokes).toHaveLength(0);
  });

  it('keeps an unsaved permissions draft across tab switches, with no new requests', async () => {
    const { mock } = renderEdit('/accounts/sam', [{ url: '/api/accounts', body: LIST }]);
    await screen.findByText('sam');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    await user.click(
      screen.getByRole('radio', { name: 'Custom Pick individual permissions below.' }),
    );
    await user.click(screen.getByLabelText('Moderate members'));
    expect(screen.getByLabelText('Moderate members')).toHaveProperty('checked', true);
    const callsBefore = mock.mock.calls.length;
    await user.click(screen.getByRole('tab', { name: 'Summary' }));
    expect(screen.getByTestId('location').textContent).toBe('/accounts/sam?tab=summary');
    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    expect(screen.getByTestId('location').textContent).toBe('/accounts/sam?tab=permissions');
    // No reads fired for the tab switches, and the draft is intact.
    expect(mock.mock.calls.length).toBe(callsBefore);
    expect(
      screen
        .getByRole('radio', { name: 'Custom Pick individual permissions below.' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByLabelText('Moderate members')).toHaveProperty('checked', true);
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false);
  });

  it('keeps the draft after a refused save, across tab switches, with no extra writes', async () => {
    const { mock } = renderEdit('/accounts/sam', [
      { url: '/api/accounts', body: LIST },
      {
        method: 'POST',
        url: '/api/accounts/sam/capabilities',
        status: 400,
        body: {
          error: 'bad-request',
          title: 'That permission cannot be granted',
          message: 'Only the owner can grant that permission.',
        },
      },
    ]);
    await screen.findByText('sam');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    await user.click(
      screen.getByRole('radio', { name: 'Custom Pick individual permissions below.' }),
    );
    await user.click(screen.getByLabelText('Moderate members'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    expect(await screen.findByText('Only the owner can grant that permission.')).toBeTruthy();
    const writeCalls = (): number =>
      mock.mock.calls.filter((c) => (c[1]?.method ?? 'GET').toUpperCase() !== 'GET').length;
    expect(writeCalls()).toBe(1);
    const callsBefore = mock.mock.calls.length;
    await user.click(screen.getByRole('tab', { name: 'Summary' }));
    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    // The refused draft survives the round trip and nothing else was sent.
    expect(mock.mock.calls.length).toBe(callsBefore);
    expect(writeCalls()).toBe(1);
    expect(
      screen
        .getByRole('radio', { name: 'Custom Pick individual permissions below.' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByLabelText('Moderate members')).toHaveProperty('checked', true);
  });

  it('does not allow a second save while the first is still in flight across tabs', async () => {
    const pending: (() => void)[] = [];
    const { calls } = renderEditWithFetch(
      '/accounts/sam',
      () =>
        new Promise<Response>((resolve) => {
          pending.push(() => resolve(json({ outcome: 'granted' })));
        }),
    );
    const user = userEvent.setup();
    await draftCustomWithModeration(user);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    expect(writesOf(calls)).toBe(1);
    await user.click(screen.getByRole('tab', { name: 'Summary' }));
    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    const again = screen.getByRole('button', { name: 'Save changes' });
    expect(again).toHaveProperty('disabled', true);
    await act(async () => {
      fireEvent.click(again);
    });
    await act(async () => {
      pending.forEach((release) => release());
    });
    expect(writesOf(calls)).toBe(1);
  });

  it('shows a refusal that arrives while the permissions tab is inactive', async () => {
    const pending: (() => void)[] = [];
    renderEditWithFetch(
      '/accounts/sam',
      () =>
        new Promise<Response>((resolve) => {
          pending.push(() =>
            resolve(
              json(
                {
                  error: 'bad-request',
                  title: 'Refused',
                  message: 'Only the owner can grant that permission.',
                },
                400,
              ),
            ),
          );
        }),
    );
    const user = userEvent.setup();
    await draftCustomWithModeration(user);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    await user.click(screen.getByRole('tab', { name: 'Summary' }));
    await act(async () => {
      pending.forEach((fail) => fail());
    });
    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    expect(await screen.findByText('Only the owner can grant that permission.')).toBeTruthy();
    expect(screen.getByLabelText('Moderate members')).toHaveProperty('checked', true);
  });

  it('keeps the draft when a sibling tab reloads the accounts', async () => {
    const { calls } = renderEditWithFetch('/accounts/sam', () =>
      Promise.resolve(
        json({
          username: 'sam',
          accountId: 'acct-2',
          sessionsRevoked: 2,
          tokensRevoked: 1,
          codesDeleted: 0,
          guildsTouched: 1,
          stillEnabled: true,
        }),
      ),
    );
    const user = userEvent.setup();
    await draftCustomWithModeration(user);
    await user.click(screen.getByRole('tab', { name: 'Sessions and apps' }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Sign out everywhere and disconnect apps' }),
      );
    });
    await user.click(await screen.findByRole('tab', { name: 'Permissions' }));
    expect(
      screen
        .getByRole('radio', { name: 'Custom Pick individual permissions below.' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByLabelText('Moderate members')).toHaveProperty('checked', true);
    expect(writesOf(calls)).toBe(1);
  });

  it('resets the draft when the route moves to another account', async () => {
    const { calls, navigate } = renderEditWithFetch('/accounts/sam', () =>
      Promise.resolve(json({ outcome: 'ok' })),
    );
    const user = userEvent.setup();
    await draftCustomWithModeration(user);
    const callsBefore = calls.length;
    await act(async () => {
      navigate('/accounts/bryan');
    });
    await screen.findByText('bryan');
    await act(async () => {
      navigate('/accounts/sam');
    });
    await screen.findByText('sam');
    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    expect(
      screen
        .getByRole('radio', {
          name: 'Viewer Sees settings, logs and history. Changes nothing.',
        })
        .getAttribute('aria-checked'),
    ).toBe('true');
    // The custom capability list renders in Custom mode: a fresh draft shows
    // only the held baseline, with nothing to save.
    await user.click(
      screen.getByRole('radio', { name: 'Custom Pick individual permissions below.' }),
    );
    expect(screen.getByLabelText('Moderate members')).toHaveProperty('checked', false);
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
    expect(calls.length).toBe(callsBefore);
  });

  it('preselects Custom honestly when the held capabilities match no role', async () => {
    const partial = {
      ...LIST,
      capabilities: { 'acct-1': [], 'acct-2': ['config.read'] },
    };
    renderEdit('/accounts/sam', [{ url: '/api/accounts', body: partial }]);
    await screen.findByText('sam');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    expect(
      screen
        .getByRole('radio', { name: 'Custom Pick individual permissions below.' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByLabelText('Moderate members')).toHaveProperty('checked', false);
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
    await user.click(screen.getByLabelText('Moderate members'));
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false);
  });

  it('reconciles an own successful save to the fresh held baseline', async () => {
    const probe = renderEditDeferred('/accounts/sam');
    const user = await openPermissionsTab('sam');
    await user.click(customRoleRadio());
    await user.click(screen.getByLabelText('Moderate members'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    expect(probe.writesTo('/api/accounts/sam/capabilities')).toBe(1);
    probe.setList({
      ...LIST_WITH_JANE,
      capabilities: {
        ...LIST_WITH_JANE.capabilities,
        'acct-2': ['config.read', 'audit.read', 'moderation.act'],
      },
    });
    await act(async () => {
      probe.releaseAll({ outcome: 'granted' });
    });
    expect(probe.gets()).toBe(2);
    expect(customRoleRadio().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByLabelText('Moderate members')).toHaveProperty('checked', true);
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
    expect(probe.writesTo('/api/accounts/sam/capabilities')).toBe(1);
  });

  it('keeps the other account edits when a late success lands from elsewhere', async () => {
    const probe = renderEditDeferred('/accounts/sam');
    let user = await openPermissionsTab('sam');
    await user.click(customRoleRadio());
    await user.click(screen.getByLabelText('Moderate members'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    expect(probe.writesTo('/api/accounts/sam/capabilities')).toBe(1);
    await act(async () => {
      probe.navigate('/accounts/jane');
    });
    user = await openPermissionsTab('jane');
    await user.click(customRoleRadio());
    await user.click(screen.getByLabelText('Change settings'));
    expect(screen.getByLabelText('Change settings')).toHaveProperty('checked', true);
    await act(async () => {
      probe.releaseAll({ outcome: 'granted' });
    });
    expect(customRoleRadio().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByLabelText('Change settings')).toHaveProperty('checked', true);
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false);
  });

  it('keeps the other account edits when a late refusal lands, and shows it back home', async () => {
    const probe = renderEditDeferred('/accounts/sam');
    let user = await openPermissionsTab('sam');
    await user.click(customRoleRadio());
    await user.click(screen.getByLabelText('Moderate members'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    await act(async () => {
      probe.navigate('/accounts/jane');
    });
    user = await openPermissionsTab('jane');
    await user.click(customRoleRadio());
    await user.click(screen.getByLabelText('Change settings'));
    await act(async () => {
      probe.releaseAll(
        {
          error: 'bad-request',
          title: 'That permission cannot be granted',
          message: 'Only the owner can grant that permission.',
        },
        400,
      );
    });
    // Jane's draft is untouched and nothing was written for her.
    expect(customRoleRadio().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByLabelText('Change settings')).toHaveProperty('checked', true);
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false);
    expect(probe.writesTo('/api/accounts/jane/capabilities')).toBe(0);
    // The refusal and sam's refused selection survive the trip back.
    await act(async () => {
      probe.navigate('/accounts/sam');
    });
    await openPermissionsTab('sam');
    expect(await screen.findByText('Only the owner can grant that permission.')).toBeTruthy();
    expect(screen.getByLabelText('Moderate members')).toHaveProperty('checked', true);
  });

  it('keeps the other account edits when a late non-refusal failure lands', async () => {
    const probe = renderEditDeferred('/accounts/sam');
    let user = await openPermissionsTab('sam');
    await user.click(customRoleRadio());
    await user.click(screen.getByLabelText('Moderate members'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    await act(async () => {
      probe.navigate('/accounts/jane');
    });
    user = await openPermissionsTab('jane');
    await user.click(customRoleRadio());
    await user.click(screen.getByLabelText('Change settings'));
    await act(async () => {
      probe.releaseAll(
        { error: 'internal', title: 'Unavailable', message: 'Try again later.' },
        500,
      );
    });
    expect(customRoleRadio().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByLabelText('Change settings')).toHaveProperty('checked', true);
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false);
  });

  it('keeps the draft and its outcome through a sibling reload during a pending save', async () => {
    const probe = renderEditDeferred('/accounts/sam');
    let user = await openPermissionsTab('sam');
    await user.click(customRoleRadio());
    await user.click(screen.getByLabelText('Moderate members'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    expect(probe.writesTo('/api/accounts/sam/capabilities')).toBe(1);
    user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Sessions and apps' }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Sign out everywhere and disconnect apps' }),
      );
    });
    await act(async () => {
      probe.releaseMatching('/api/accounts/sam/revoke-credentials', {
        username: 'sam',
        accountId: 'acct-2',
        sessionsRevoked: 2,
        tokensRevoked: 1,
        codesDeleted: 0,
        guildsTouched: 1,
        stillEnabled: true,
      });
    });
    user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    expect(screen.getByLabelText('Moderate members')).toHaveProperty('checked', true);
    const btn = screen.getByRole('button', { name: 'Save changes' });
    expect(btn).toHaveProperty('disabled', true);
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(probe.writesTo('/api/accounts/sam/capabilities')).toBe(1);
    probe.setList({
      ...LIST_WITH_JANE,
      capabilities: {
        ...LIST_WITH_JANE.capabilities,
        'acct-2': ['config.read', 'audit.read', 'moderation.act'],
      },
    });
    await act(async () => {
      probe.releaseAll({ outcome: 'granted' });
    });
    expect(screen.getByLabelText('Moderate members')).toHaveProperty('checked', true);
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
    expect(probe.writesTo('/api/accounts/sam/capabilities')).toBe(1);
  });

  it('refreshes the baseline when returning to an account whose save landed elsewhere', async () => {
    const probe = renderEditDeferred('/accounts/sam');
    let user = await openPermissionsTab('sam');
    await user.click(customRoleRadio());
    await user.click(screen.getByLabelText('Moderate members'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    expect(probe.writesTo('/api/accounts/sam/capabilities')).toBe(1);
    await act(async () => {
      probe.navigate('/accounts/jane');
    });
    user = await openPermissionsTab('jane');
    await user.click(customRoleRadio());
    await user.click(screen.getByLabelText('Change settings'));
    // The server now holds the grant; any future GET would return it.
    probe.setList({
      ...LIST_WITH_JANE,
      capabilities: {
        ...LIST_WITH_JANE.capabilities,
        'acct-2': ['config.read', 'audit.read', 'moderation.act'],
      },
    });
    await act(async () => {
      probe.releaseAll({ outcome: 'granted' });
    });
    // Jane's view is undisturbed and no reload fired while she was looking.
    expect(screen.getByLabelText('Change settings')).toHaveProperty('checked', true);
    expect(probe.gets()).toBe(1);
    // Returning to sam refetches, so the held capabilities are truthful.
    await act(async () => {
      probe.navigate('/accounts/sam');
    });
    user = await openPermissionsTab('sam');
    expect(probe.gets()).toBe(2);
    await user.click(customRoleRadio());
    expect(screen.getByLabelText('Moderate members')).toHaveProperty('checked', true);
    // Re-editing from the truthful baseline revokes; it cannot duplicate the grant.
    await user.click(screen.getByLabelText('Moderate members'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    const grantPosts = probe.calls.filter(
      (c) => c.method === 'POST' && c.url === '/api/accounts/sam/capabilities',
    ).length;
    expect(grantPosts).toBe(1);
    await act(async () => {
      probe.releaseAll({ outcome: 'revoked' });
    });
  });

  it('keeps the selection and shows the server answer when a grant is refused', async () => {
    renderEdit('/accounts/sam', [
      { url: '/api/accounts', body: LIST },
      {
        method: 'POST',
        url: '/api/accounts/sam/capabilities',
        status: 400,
        body: {
          error: 'bad-request',
          title: 'That permission cannot be granted',
          message: 'Only the owner can grant that permission.',
        },
      },
    ]);
    await screen.findByText('sam');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    fireEvent.click(
      screen.getByRole('radio', { name: 'Custom Pick individual permissions below.' }),
    );
    fireEvent.click(screen.getByLabelText('Moderate members'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });
    expect(await screen.findByText('Only the owner can grant that permission.')).toBeTruthy();
    // The refused change stays selected so nothing the viewer picked is lost.
    expect(screen.getByLabelText('Moderate members')).toHaveProperty('checked', true);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
  });

  it('reveals the current password for the owner when revealable, once', async () => {
    renderEdit('/accounts/sam', [
      { url: '/api/accounts', body: LIST },
      {
        method: 'POST',
        url: '/api/accounts/sam/reveal-password',
        body: { username: 'sam', password: 'recovered-secret' },
      },
    ]);
    await screen.findByText('sam');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Password' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reveal current password' }));
    });
    const printOnce = await screen.findByRole('dialog', { name: 'Current password' });
    expect(printOnce.textContent).toContain('recovered-secret');
  });

  it('discards the revealed password from the page when the dialog closes', async () => {
    renderEdit('/accounts/sam', [
      { url: '/api/accounts', body: LIST },
      {
        method: 'POST',
        url: '/api/accounts/sam/reveal-password',
        body: { username: 'sam', password: 'recovered-secret' },
      },
    ]);
    await screen.findByText('sam');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Password' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reveal current password' }));
    });
    const printOnce = await screen.findByRole('dialog', { name: 'Current password' });
    await act(async () => {
      fireEvent.click(within(printOnce).getByRole('button', { name: 'I have saved it' }));
    });
    expect(screen.queryByText('recovered-secret')).toBeNull();
  });

  it('explains a missing sealed copy instead of offering reveal', async () => {
    const unrevealable = {
      ...LIST,
      accounts: LIST.accounts.map((a) => (a.username === 'sam' ? { ...a, revealable: false } : a)),
    };
    renderEdit('/accounts/sam', [{ url: '/api/accounts', body: unrevealable }]);
    await screen.findByText('sam');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Password' }));
    expect(screen.queryByRole('button', { name: 'Reveal current password' })).toBeNull();
    expect(screen.getByText('Set a new password to be able to reveal it later.')).toBeTruthy();
  });

  it('signs out everywhere and disconnects apps with one button', async () => {
    const { mock } = renderEdit('/accounts/sam', [
      { url: '/api/accounts', body: LIST },
      {
        method: 'POST',
        url: '/api/accounts/sam/revoke-credentials',
        body: {
          username: 'sam',
          accountId: 'acct-2',
          sessionsRevoked: 2,
          tokensRevoked: 1,
          codesDeleted: 0,
          guildsTouched: 1,
          stillEnabled: true,
        },
      },
    ]);
    await screen.findByText('sam');
    expect(screen.queryByRole('button', { name: 'Revoke connected apps' })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Sessions and apps' }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Sign out everywhere and disconnect apps' }),
      );
    });
    expect(
      mock.mock.calls.some((c) => (c[0] as string) === '/api/accounts/sam/revoke-credentials'),
    ).toBe(true);
  });

  it('confirms the danger zone by name and returns to the list after delete', async () => {
    const { mock } = renderEdit('/accounts/sam', [
      { url: '/api/accounts', body: LIST },
      {
        method: 'DELETE',
        url: '/api/accounts/sam',
        body: {
          username: 'sam',
          accountId: 'acct-2',
          wasOwner: false,
          tokensRevoked: 0,
          codesDeleted: 0,
          enabledOwnersRemaining: 1,
          accountsRemaining: 1,
        },
      },
    ]);
    await screen.findByText('sam');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('sam');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    });
    expect(
      mock.mock.calls.some(
        (c) => (c[0] as string) === '/api/accounts/sam' && c[1]?.method === 'DELETE',
      ),
    ).toBe(true);
    expect(screen.getByTestId('location').textContent).toBe('/accounts');
  });

  it('disables behind a confirmation naming the account', async () => {
    const { mock } = renderEdit('/accounts/sam', [
      { url: '/api/accounts', body: LIST },
      {
        method: 'POST',
        url: '/api/accounts/sam/disabled',
        body: {
          changed: true,
          username: 'sam',
          isOwner: false,
          disabled: true,
          lockedUntil: null,
          enabledOwnersRemaining: 1,
        },
      },
    ]);
    await screen.findByText('sam');
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('sam');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Disable account' }));
    });
    const calls = mock.mock.calls.filter((c) => (c[0] as string) === '/api/accounts/sam/disabled');
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]!)).toEqual({ disabled: true });
  });

  it('removes from this server behind a confirmation naming the account', async () => {
    const { mock } = renderEdit('/accounts/sam', [
      { url: '/api/accounts', body: LIST },
      { method: 'POST', url: '/api/accounts/sam/revoke-guild', body: { outcome: 'revoked' } },
    ]);
    await screen.findByText('sam');
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this server' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('sam');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from this server' }));
    });
    expect(mock.mock.calls.some((c) => (c[0] as string) === '/api/accounts/sam/revoke-guild')).toBe(
      true,
    );
  });

  it('warns about self-lockout when removing your own account from this server', async () => {
    renderEdit('/accounts/sam', [{ url: '/api/accounts', body: LIST }], {
      ...TEST_SESSION,
      accountId: 'acct-2',
    });
    await screen.findByText('sam');
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this server' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('your own account');
  });

  it('does not warn about self-lockout when removing someone else', async () => {
    renderEdit('/accounts/sam', [{ url: '/api/accounts', body: LIST }]);
    await screen.findByText('sam');
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this server' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).not.toContain('your own account');
  });

  it('maps a not-revealable answer to its sentence', async () => {
    renderEdit('/accounts/sam', [
      { url: '/api/accounts', body: LIST },
      {
        method: 'POST',
        url: '/api/accounts/sam/reveal-password',
        status: 409,
        body: {
          error: 'not-revealable',
          title: "That password can't be shown",
          message: "This password can't be shown. Set a new one instead.",
        },
      },
    ]);
    await screen.findByText('sam');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Password' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reveal current password' }));
    });
    expect(
      await screen.findByText("This password can't be shown. Set a new one instead."),
    ).toBeTruthy();
  });

  it('refuses a short chosen password inline, before anything is written', async () => {
    const { mock } = renderEdit('/accounts/sam', [{ url: '/api/accounts', body: LIST }]);
    await screen.findByText('sam');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Password' }));
    fireEvent.click(screen.getByRole('radio', { name: "I'll choose one" }));
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short' } });
    expect(await screen.findByText('Use at least 12 characters.')).toBeTruthy();
    expect(mock.mock.calls.some((c) => (c[0] as string).endsWith('/password'))).toBe(false);
  });

  it('shows only the summary and the password change for the owner account itself', async () => {
    renderEdit('/accounts/bryan', [{ url: '/api/accounts', body: LIST }]);
    await screen.findByText('bryan');
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Summary', 'Password']);
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeTruthy();
    expect(screen.queryByText('Permissions on this server')).toBeNull();
    expect(screen.queryByText('Sessions and apps')).toBeNull();
    expect(screen.queryByText('Danger zone')).toBeNull();
    expect(screen.queryByText('config.read')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Password' }));
    expect(screen.getByText('Change your password')).toBeTruthy();
  });

  it('shows only the summary of an owner account to a non-owner viewer', async () => {
    renderEdit('/accounts/bryan', [{ url: '/api/accounts', body: LIST }], {
      ...TEST_SESSION,
      accountId: 'acct-2',
    });
    await screen.findByText('bryan');
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Password' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Permissions' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Sessions and apps' })).toBeNull();
    expect(screen.queryByText('Danger zone')).toBeNull();
  });

  it('lets the owner change their own password, shown once', async () => {
    const { mock } = renderEdit('/accounts/bryan', [
      { url: '/api/accounts', body: LIST },
      {
        method: 'PUT',
        url: '/api/accounts/bryan/password',
        body: {
          username: 'bryan',
          accountId: 'acct-1',
          password: 'owner-new-secret',
          sessionsRevoked: 1,
          guildsTouched: 1,
        },
      },
    ]);
    await screen.findByText('bryan');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Password' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    });
    expect(mock.mock.calls.some((c) => (c[0] as string) === '/api/accounts/bryan/password')).toBe(
      true,
    );
    const printOnce = await screen.findByRole('dialog', { name: 'New password' });
    expect(printOnce.textContent).toContain('owner-new-secret');
  });
});
