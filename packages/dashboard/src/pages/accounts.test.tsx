// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
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
    },
    {
      accountId: 'acct-2',
      username: 'ops-alt',
      isOwner: false,
      disabled: true,
      lockedUntil: Date.now() + 60_000,
      createdAt: 0,
    },
  ],
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('AccountsPage', () => {
  it('lists accounts with owner, disabled and lockout states', async () => {
    stubFetch([{ url: '/api/accounts', body: ACCOUNTS }]);
    renderWithSession(<AccountsPage />);
    expect(await screen.findByText('bryan')).toBeTruthy();
    expect(screen.getByText('owner')).toBeTruthy();
    expect(screen.getByText('disabled')).toBeTruthy();
    expect(screen.getByText(/locked until/)).toBeTruthy();
    expect(screen.getByText('enabled')).toBeTruthy();
  });

  it('disable states the pause-not-rotation scope and posts { disabled: true }', async () => {
    const mock = stubFetch([
      { url: '/api/accounts', body: ACCOUNTS },
      {
        method: 'POST',
        url: '/api/accounts/bryan/disabled',
        body: {
          changed: true,
          username: 'bryan',
          isOwner: true,
          disabled: true,
          lockedUntil: null,
          enabledOwnersRemaining: 1,
        },
      },
    ]);
    renderWithSession(<AccountsPage />);
    await screen.findByText('bryan');
    fireEvent.click(screen.getAllByRole('button', { name: 'Disable' })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('a pause, not a rotation');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Disable account' }));
    });
    const post = mock.mock.calls.find((c) => (c[0] as string) === '/api/accounts/bryan/disabled')!;
    expect(bodyOf(post)).toEqual({ disabled: true });
    expect(mock.mock.calls.filter((c) => (c[0] as string) === '/api/accounts')).toHaveLength(2);
  });

  it('reset password requires the typed confirmation body and shows the secret exactly once', async () => {
    const mock = stubFetch([
      { url: '/api/accounts', body: ACCOUNTS },
      {
        method: 'POST',
        url: '/api/accounts/bryan/password',
        body: {
          username: 'bryan',
          accountId: 'acct-1',
          password: 'shown-once-only',
          sessionsRevoked: 2,
          guildsTouched: 2,
        },
      },
    ]);
    renderWithSession(<AccountsPage />);
    await screen.findByText('bryan');
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset password' })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('shown exactly once');
    expect(dialog.textContent).toContain('OAuth tokens are NOT revoked');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Reset password' }));
    });
    const post = mock.mock.calls.find((c) => (c[0] as string) === '/api/accounts/bryan/password')!;
    expect(bodyOf(post)).toEqual({ confirm: true });
    const printOnce = await screen.findByRole('dialog', { name: 'Password reset' });
    expect(printOnce.textContent).toContain('shown-once-only');
    // Escape cannot strand the only copy; the done button closes and reloads.
    fireEvent.keyDown(printOnce, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Password reset' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(printOnce).getByRole('button', { name: 'I have saved it' }));
    });
    expect(screen.queryByText('shown-once-only')).toBeNull();
    expect(mock.mock.calls.filter((c) => (c[0] as string) === '/api/accounts')).toHaveLength(2);
  });

  it('revoke own guild access warns that it signs you out', async () => {
    stubFetch([{ url: '/api/accounts', body: ACCOUNTS }]);
    renderWithSession(<AccountsPage />);
    await screen.findByText('bryan');
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke guild' })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('your own account');
    expect(dialog.textContent).toContain('no way back in');
  });

  it('delete is a danger confirmation naming the cascade', async () => {
    const mock = stubFetch([
      { url: '/api/accounts', body: ACCOUNTS },
      {
        method: 'DELETE',
        url: '/api/accounts/ops-alt',
        body: {
          username: 'ops-alt',
          accountId: 'acct-2',
          wasOwner: false,
          tokensRevoked: 0,
          codesDeleted: 0,
          enabledOwnersRemaining: 1,
          accountsRemaining: 1,
        },
      },
    ]);
    renderWithSession(<AccountsPage />);
    await screen.findByText('ops-alt');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Not reversible');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    });
    expect(
      mock.mock.calls.some(
        (c) => (c[0] as string) === '/api/accounts/ops-alt' && c[1]?.method === 'DELETE',
      ),
    ).toBe(true);
  });
});
