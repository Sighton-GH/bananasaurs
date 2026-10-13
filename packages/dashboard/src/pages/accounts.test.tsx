// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { AccountsPage } from './accounts.js';

const ACCOUNTS = {
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

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('AccountsPage list', () => {
  it('has an Add account button linking to /accounts/new', async () => {
    stubFetch([{ url: '/api/accounts', body: ACCOUNTS }]);
    renderWithSession(<AccountsPage />);
    await screen.findByText('bryan');
    const link = screen.getByRole('link', { name: 'Add account' });
    expect(link.getAttribute('href')).toBe('/accounts/new');
  });

  it('locks the owner row: Owner badge, plain sentence, no mutating controls', async () => {
    stubFetch([{ url: '/api/accounts', body: ACCOUNTS }]);
    renderWithSession(<AccountsPage />);
    await screen.findByText('bryan');
    expect(screen.getByText('Owner')).toBeTruthy();
    expect(
      screen.getByText(
        'The owner runs this Bananasaurs install and always has every permission on every server.',
      ),
    ).toBeTruthy();
    const ownerRow = screen.getByText('bryan').closest('tr')!;
    expect(within(ownerRow).queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(within(ownerRow).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(ownerRow).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(ownerRow).queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(within(ownerRow).queryByRole('button', { name: 'Enable' })).toBeNull();
  });

  it('shows the member role name and an Edit link to the edit page', async () => {
    stubFetch([{ url: '/api/accounts', body: ACCOUNTS }]);
    renderWithSession(<AccountsPage />);
    await screen.findByText('sam');
    const memberRow = screen.getByText('sam').closest('tr')!;
    expect(within(memberRow).getByText('Viewer')).toBeTruthy();
    const edit = within(memberRow).getByRole('link', { name: 'Edit' });
    expect(edit.getAttribute('href')).toBe('/accounts/sam');
  });

  it('never shows a raw capability id as a main label', async () => {
    stubFetch([{ url: '/api/accounts', body: ACCOUNTS }]);
    renderWithSession(<AccountsPage />);
    await screen.findByText('sam');
    expect(screen.queryByText('config.read')).toBeNull();
    expect(screen.queryByText('audit.read')).toBeNull();
    expect(screen.queryByText('accounts.manage')).toBeNull();
  });

  it('an empty roster is an Empty state; failures are unavailable or forbidden, never "no accounts"', async () => {
    stubFetch([{ url: '/api/accounts', body: { accounts: [], capabilities: {} } }]);
    renderWithSession(<AccountsPage />);
    expect(await screen.findByText('No accounts yet')).toBeTruthy();
    cleanup();
    stubFetch([{ url: '/api/accounts', status: 403, body: { error: 'forbidden' } }]);
    renderWithSession(<AccountsPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('No accounts yet')).toBeNull();
    cleanup();
    stubFetch([{ url: '/api/accounts', status: 500, body: { error: 'boom' } }]);
    renderWithSession(<AccountsPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('No accounts yet')).toBeNull();
  });

  it('status is a badge with words, and created is relative with the date on hover', async () => {
    stubFetch([
      {
        url: '/api/accounts',
        body: {
          ...ACCOUNTS,
          accounts: [{ ...ACCOUNTS.accounts[1], createdAt: Date.now() - 3 * 86_400_000 }],
        },
      },
    ]);
    renderWithSession(<AccountsPage />);
    expect((await screen.findByText('Enabled')).className).toContain('border-tone-ok');
    expect(screen.getByText('3 days ago').getAttribute('title')).toMatch(/\d/);
  });
});
