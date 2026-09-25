// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router, Route, useLocation } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { accountErrorText } from '../api/ops.js';
import { AccountEditPage } from './account-edit.js';

function LocationProbe() {
  const [location] = useLocation();
  return <p data-testid="location">{location}</p>;
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

function renderEdit(path: string, routes: readonly { method?: string; url: string; status?: number; body: unknown }[]) {
  const mock = stubFetch(routes);
  const { hook } = memoryLocation({ path });
  renderWithSession(
    <Router hook={hook}>
      <Route path="/accounts/:username" component={AccountEditPage} />
      <LocationProbe />
    </Router>,
  );
  return mock;
}

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('AccountEditPage', () => {
  it('renders its sections in order: Summary, Permissions, Password, Sessions and apps, Danger zone', async () => {
    renderEdit('/accounts/sam', [{ url: '/api/accounts', body: LIST }]);
    const headings = await screen.findAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([
      'Summary',
      'Permissions on this server',
      'Password',
      'Sessions and apps',
      'Danger zone',
    ]);
  });

  it('preselects the role from the held capabilities and saves only the difference', async () => {
    const mock = renderEdit('/accounts/sam', [
      { url: '/api/accounts', body: LIST },
      { method: 'POST', url: '/api/accounts/sam/capabilities', body: { outcome: 'granted' } },
      { method: 'DELETE', url: '/api/accounts/sam/capabilities/config.read', body: { outcome: 'revoked' } },
      { method: 'DELETE', url: '/api/accounts/sam/capabilities/audit.read', body: { outcome: 'revoked' } },
    ]);
    expect(await screen.findByText('sam')).toBeTruthy();
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
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reveal current password' }));
    });
    const printOnce = await screen.findByRole('dialog', { name: 'Current password' });
    expect(printOnce.textContent).toContain('recovered-secret');
  });

  it('explains a missing sealed copy instead of offering reveal', async () => {
    const unrevealable = {
      ...LIST,
      accounts: LIST.accounts.map((a) =>
        a.username === 'sam' ? { ...a, revealable: false } : a,
      ),
    };
    renderEdit('/accounts/sam', [{ url: '/api/accounts', body: unrevealable }]);
    await screen.findByText('sam');
    expect(screen.queryByRole('button', { name: 'Reveal current password' })).toBeNull();
    expect(screen.getByText('Set a new password to be able to reveal it later.')).toBeTruthy();
  });

  it('signs out everywhere and disconnects apps with one button', async () => {
    const mock = renderEdit('/accounts/sam', [
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
    const mock = renderEdit('/accounts/sam', [
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

  it('maps account error codes to plain sentences', () => {
    expect(accountErrorText('owner-protected')).toBe("The owner account can't be changed here.");
    expect(accountErrorText('weak-password')).toBe('Use at least 12 characters.');
    expect(accountErrorText('username-taken')).toBe('That username is already in use.');
    expect(accountErrorText('not-revealable')).toBe(
      "This password can't be shown. Set a new one instead.",
    );
    expect(accountErrorText('something-else')).toBeUndefined();
  });

  it('maps a not-revealable answer to its sentence', async () => {
    renderEdit('/accounts/sam', [
      { url: '/api/accounts', body: LIST },
      {
        method: 'POST',
        url: '/api/accounts/sam/reveal-password',
        status: 409,
        body: { error: 'not-revealable' },
      },
    ]);
    await screen.findByText('sam');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reveal current password' }));
    });
    expect(
      await screen.findByText("This password can't be shown. Set a new one instead."),
    ).toBeTruthy();
  });

  it('refuses a short chosen password inline, before anything is written', async () => {
    const mock = renderEdit('/accounts/sam', [{ url: '/api/accounts', body: LIST }]);
    await screen.findByText('sam');
    fireEvent.click(screen.getByRole('radio', { name: "I'll choose one" }));
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short' } });
    expect(await screen.findByText('Use at least 12 characters.')).toBeTruthy();
    expect(
      mock.mock.calls.some((c) => (c[0] as string).endsWith('/password')),
    ).toBe(false);
  });

  it('shows only the summary and the password change for the owner account itself', async () => {
    renderEdit('/accounts/bryan', [{ url: '/api/accounts', body: LIST }]);
    await screen.findByText('bryan');
    expect(screen.getByText('Summary')).toBeTruthy();
    expect(screen.getByText('Change your password')).toBeTruthy();
    expect(screen.queryByText('Permissions on this server')).toBeNull();
    expect(screen.queryByText('Sessions and apps')).toBeNull();
    expect(screen.queryByText('Danger zone')).toBeNull();
    expect(screen.queryByText('config.read')).toBeNull();
  });

  it('lets the owner change their own password, shown once', async () => {
    const mock = renderEdit('/accounts/bryan', [
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
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    });
    expect(
      mock.mock.calls.some((c) => (c[0] as string) === '/api/accounts/bryan/password'),
    ).toBe(true);
    const printOnce = await screen.findByRole('dialog', { name: 'New password' });
    expect(printOnce.textContent).toContain('owner-new-secret');
  });
});
