// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router, useLocation } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { AccountNewPage } from './account-new.js';

function LocationProbe() {
  const [location] = useLocation();
  return <p data-testid="location">{location}</p>;
}

function renderNew(
  session: typeof TEST_SESSION = { ...TEST_SESSION, guildName: 'Bananasaurs dev' },
) {
  const { hook } = memoryLocation({ path: '/accounts/new' });
  renderWithSession(
    <Router hook={hook}>
      <AccountNewPage />
      <LocationProbe />
    </Router>,
    { session },
  );
}

const NO_ACCOUNTS = { accounts: [], capabilities: {} };

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('AccountNewPage', () => {
  it('names the username rules, defaults to a generated password, and offers role cards', async () => {
    stubFetch([{ url: '/api/accounts', body: NO_ACCOUNTS }]);
    renderNew();
    expect(
      await screen.findByText(
        'Lowercase letters, digits, dot, dash, underscore; 3-64 characters, never a leading dash.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Generate one for me' })).toBeChecked();
    expect(screen.getByRole('radio', { name: "I'll choose one" })).not.toBeChecked();
    // Choosing a password reveals the input with the length hint.
    fireEvent.click(screen.getByRole('radio', { name: "I'll choose one" }));
    expect(screen.getByLabelText('New password')).toBeTruthy();
    expect(screen.getByText('At least 12 characters.')).toBeTruthy();
    // Role cards, one per server role plus Custom.
    expect(screen.getByRole('radio', { name: /Viewer/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Moderator/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Server manager/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Custom/ })).toBeTruthy();
  });

  it('Custom reveals every permission with its plain label and description', async () => {
    stubFetch([{ url: '/api/accounts', body: NO_ACCOUNTS }]);
    renderNew();
    await screen.findByRole('radio', { name: /Custom/ });
    fireEvent.click(screen.getByRole('radio', { name: /Custom/ }));
    // Plain labels, not raw ids, with the one-line descriptions.
    expect(screen.getByText('View settings')).toBeTruthy();
    expect(screen.getByText("See this server's settings, rules and assistant setup.")).toBeTruthy();
    expect(screen.getByText('Manage accounts')).toBeTruthy();
    expect(screen.queryByText('config.read')).toBeNull();
    expect(screen.queryByText('accounts.manage')).toBeNull();
  });

  it('reviews the account in plain words before anything is written', async () => {
    stubFetch([{ url: '/api/accounts', body: NO_ACCOUNTS }]);
    renderNew();
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'sam' } });
    expect(
      await screen.findByText(
        'sam will be able to sign in and View settings, View activity logs on Bananasaurs dev.',
      ),
    ).toBeTruthy();
  });

  it('creates with username plus capabilities, shows the password once, then opens the edit page', async () => {
    const mock = stubFetch([
      { url: '/api/accounts', body: NO_ACCOUNTS },
      {
        method: 'POST',
        url: '/api/accounts',
        body: {
          accountId: 'acct-9',
          username: 'sam',
          password: 'generated-secret',
          guildAccess: true,
          capabilities: ['config.read', 'audit.read'],
        },
      },
    ]);
    renderNew();
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'sam' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    });
    const post = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/accounts' && (c[1] as { method?: string }).method === 'POST',
    )!;
    expect(bodyOf(post)).toEqual({
      username: 'sam',
      capabilities: ['config.read', 'audit.read'],
    });
    const printOnce = await screen.findByRole('dialog', { name: 'Account created' });
    expect(printOnce.textContent).toContain('generated-secret');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I have saved it' }));
    });
    expect(screen.getByTestId('location').textContent).toBe('/accounts/sam');
  });

  it('maps username-taken to a plain sentence and never offers guild-access opt-out', async () => {
    stubFetch([
      { url: '/api/accounts', body: NO_ACCOUNTS },
      { method: 'POST', url: '/api/accounts', status: 409, body: { error: 'username-taken' } },
    ]);
    renderNew();
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'sam' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    });
    expect(await screen.findByText('That username is already in use.')).toBeTruthy();
    expect(screen.queryByText('Give this account access')).toBeNull();
  });
});
