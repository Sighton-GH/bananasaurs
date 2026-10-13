// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderWithSession, stubFetch, TEST_SESSION } from '../../../test-support.js';
import { AccountEditPage } from '../../account-edit.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

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

type StubRoute = { method?: string; url: string; status?: number; body: unknown };

function renderPermissions(extra: readonly StubRoute[] = []) {
  const mock = stubFetch([{ url: '/api/accounts', body: LIST }, ...extra]);
  const { hook, searchHook } = memoryLocation({ path: '/accounts/sam?tab=permissions' });
  renderWithSession(
    <Router hook={hook} searchHook={searchHook}>
      <Route path="/accounts/:username" component={AccountEditPage} />
    </Router>,
    { session: { ...TEST_SESSION, instanceOwner: true } },
  );
  return mock;
}

/** Draft Custom + Moderate members, then focus the Save button with a real click. */
async function draftAndSave(user: ReturnType<typeof userEvent.setup>) {
  const tab = await screen.findByRole('tab', { name: 'Permissions' });
  expect(tab.getAttribute('aria-selected')).toBe('true');
  await user.click(
    screen.getByRole('radio', { name: 'Custom Pick individual permissions below.' }),
  );
  await user.click(screen.getByLabelText('Moderate members'));
  const save = screen.getByRole('button', { name: 'Save changes' });
  expect(save).toHaveProperty('disabled', false);
  await user.click(save);
  return save;
}

describe('account permissions save focus (d3 L04)', () => {
  it('success focuses the permissions section heading, not body', async () => {
    const user = userEvent.setup();
    const mock = renderPermissions([
      { method: 'POST', url: '/api/accounts/sam/capabilities', body: { outcome: 'granted' } },
    ]);
    await draftAndSave(user);
    await vi.waitFor(() => {
      const posts = (mock.mock.calls as unknown[][]).filter(
        ([url]) => url === '/api/accounts/sam/capabilities',
      );
      expect(posts.length).toBeGreaterThan(0);
    });
    const heading = await screen.findByRole('heading', { name: 'Permissions on this server' });
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('a 403 refusal keeps focus on the Save button, not body', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const mock = stubFetch([{ url: '/api/accounts', body: LIST }]);
    const original = mock.getMockImplementation()!;
    mock.mockImplementation((input, init) => {
      if (input === '/api/accounts/sam/capabilities' && init?.method === 'POST') return pending;
      return original(input, init);
    });
    const { hook, searchHook } = memoryLocation({ path: '/accounts/sam?tab=permissions' });
    renderWithSession(
      <Router hook={hook} searchHook={searchHook}>
        <Route path="/accounts/:username" component={AccountEditPage} />
      </Router>,
      { session: { ...TEST_SESSION, instanceOwner: true } },
    );
    const user = userEvent.setup();
    const save = await draftAndSave(user);
    // The in-flight Save disables, which drops focus to body in a real
    // browser; jsdom keeps it, so reproduce the observed state by focusing
    // a node and removing it, which resets focus to body.
    await vi.waitFor(() => expect(save).toHaveProperty('disabled', true));
    const probe = document.createElement('button');
    document.body.appendChild(probe);
    probe.focus();
    probe.remove();
    expect(document.activeElement).toBe(document.body);
    release(
      new Response(
        JSON.stringify({
          error: 'forbidden',
          title: 'Not allowed',
          message: 'Only the owner can change permissions.',
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    );
    await vi.waitFor(() => expect(save).toHaveProperty('disabled', false));
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save changes' })),
    );
  });
});
