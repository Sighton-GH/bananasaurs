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
  capabilities: { 'acct-2': ['audit.read'] },
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
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove server access' })[0]!);
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

describe('AccountsPage capabilities (account grant parity)', () => {
  it('shows held capabilities in this guild and grants another through the confirm', async () => {
    const mock = stubFetch([
      { url: '/api/accounts', body: ACCOUNTS },
      { method: 'POST', url: '/api/accounts/ops-alt/capabilities', body: { outcome: 'granted' } },
    ]);
    renderWithSession(<AccountsPage />);

    // The held one is listed for the non-owner account; the owner row says so instead.
    expect(await screen.findByText('audit.read')).toBeTruthy();
    expect(screen.getByText('every capability (owner)')).toBeTruthy();

    const select = screen.getByLabelText('Grant a capability to ops-alt');
    fireEvent.change(select, { target: { value: 'config.read' } });
    expect(await screen.findByText(/the config\.read capability in guild/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Grant capability' }));

    await vi.waitFor(() => {
      const post = mock.mock.calls.find(
        (c) => (c[0] as string) === '/api/accounts/ops-alt/capabilities',
      );
      expect(post).toBeDefined();
      expect(bodyOf(post!)).toEqual({ capability: 'config.read' });
    });
  });

  it('creates an account at the least-privilege floor after a quoted review', async () => {
    const mock = stubFetch([
      { url: '/api/accounts', body: ACCOUNTS },
      {
        method: 'POST',
        url: '/api/accounts',
        body: {
          accountId: 'acct-9',
          username: 'mod-casey',
          password: 'generated-secret',
          guildAccess: false,
          capabilities: [],
        },
      },
    ]);
    renderWithSession(<AccountsPage />);
    await screen.findByText('bryan');

    // Capability picks stay hidden until guild access is on.
    expect(screen.queryByLabelText('audit.read')).toBeNull();

    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'mod-casey' },
    });
    // The live review line states the floor before anything is written.
    expect(screen.getByText(/reaches nothing until you grant both/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review and create' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('non-owner account');
    expect(dialog.textContent).toContain('no guild access and no capabilities');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create account' }));
    });

    const post = mock.mock.calls.find(
      (c) =>
        (c[0] as string) === '/api/accounts' && (c[1] as { method?: string }).method === 'POST',
    )!;
    expect(bodyOf(post)).toEqual({
      username: 'mod-casey',
      grantThisGuild: false,
      capabilities: [],
    });

    // The generated password crosses the screen exactly once.
    const printOnce = await screen.findByRole('dialog', { name: 'Account created' });
    expect(printOnce.textContent).toContain('Generated password for mod-casey');
    expect(printOnce.textContent).toContain('generated-secret');
  });

  it('scopes a new account with this guild and picked capabilities', async () => {
    const mock = stubFetch([
      { url: '/api/accounts', body: ACCOUNTS },
      {
        method: 'POST',
        url: '/api/accounts',
        body: {
          accountId: 'acct-10',
          username: 'mod-jules',
          password: 'generated-secret-2',
          guildAccess: true,
          capabilities: ['audit.read'],
        },
      },
    ]);
    renderWithSession(<AccountsPage />);
    await screen.findByText('bryan');

    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'mod-jules' },
    });
    fireEvent.click(screen.getByLabelText(/Give this account access to this server/));
    fireEvent.click(screen.getByLabelText('audit.read'));
    expect(
      screen.getByText(/access to guild 1540816150026518620 with the capabilities audit\.read/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review and create' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('with the capabilities audit.read');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create account' }));
    });

    const post = mock.mock.calls.find(
      (c) =>
        (c[0] as string) === '/api/accounts' && (c[1] as { method?: string }).method === 'POST',
    )!;
    expect(bodyOf(post)).toEqual({
      username: 'mod-jules',
      grantThisGuild: true,
      capabilities: ['audit.read'],
    });
    expect((await screen.findByRole('dialog', { name: 'Account created' })).textContent).toContain(
      'Generated password for mod-jules',
    );
  });
});
