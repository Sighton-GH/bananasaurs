// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { McpPage } from './mcp.js';

const CLIENTS = {
  clients: [
    {
      clientId: 'cl-1',
      clientName: 'Claude Desktop',
      registrationSource: 'dynamic',
      createdAt: 0,
      redirectUriCount: 2,
    },
  ],
};
const TOKENS = {
  tokens: [
    {
      tokenId: 'tok-1',
      kind: 'access',
      clientId: 'cl-1',
      accountId: 'acct-1',
      createdAt: 0,
      expiresAt: Date.now() + 3_600_000,
      revokedAt: null,
      lastUsedAt: null,
    },
    {
      tokenId: 'tok-2',
      kind: 'refresh',
      clientId: 'cl-1',
      accountId: 'acct-1',
      createdAt: 0,
      expiresAt: Date.now() + 86_400_000,
      revokedAt: 1000,
      lastUsedAt: 500,
    },
  ],
};
const ALLOWLIST = { entries: [{ channelId: 'c-9', addedByAccountId: 'acct-1', addedAt: 0 }] };

const SENDS = {
  sends: [
    {
      channelId: 'c-9',
      messageId: 'm-1',
      tokenId: 'tok-1',
      sentAt: 0,
      outcome: 'sent',
    },
  ],
};

const ROLE_POLICY = {
  grantMode: 'below-bot',
  pingMode: 'allowlist',
  entries: [{ roleId: 'r-1', purpose: 'grant', addedByAccountId: 'acct-1', addedAt: 0 }],
};

const ROLES = {
  roles: [
    {
      roleId: 'r-1',
      name: 'Helpers',
      colour: 0,
      position: 3,
      managed: false,
      manageable: true,
      allowlisted: true,
      optionable: true,
    },
  ],
};

const STUBS = [
  { url: '/api/mcp/clients', body: CLIENTS },
  { url: '/api/mcp/tokens', body: TOKENS },
  { url: '/api/send-allowlist', body: ALLOWLIST },
  { url: '/api/mcp/sends?since=7d', body: SENDS },
  { url: '/api/role-policy', body: ROLE_POLICY },
  { url: '/api/guild/roles', body: ROLES },
];

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const selectOf = (element: HTMLElement): HTMLSelectElement => {
  if (!(element instanceof HTMLSelectElement)) throw new Error('expected a <select>');
  return element;
};

describe('McpPage', () => {
  it('renders clients, tokens and the allowlist', async () => {
    stubFetch(STUBS);
    renderWithSession(<McpPage />);
    expect(await screen.findByText('Claude Desktop')).toBeTruthy();
    expect(screen.getAllByText('tok-1').length).toBeGreaterThan(0);
    expect(screen.getByText('live')).toBeTruthy();
    expect(screen.getByText('revoked')).toBeTruthy();
    expect(screen.getAllByText('c-9').length).toBeGreaterThan(0);
    // The send ledger is a page section now, not a "still on the CLI" note.
    expect(screen.getByText('Send ledger')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Connected apps' })).toBeTruthy();
    expect(screen.getByText('m-1')).toBeTruthy();
    expect(screen.queryByText(/no HTTP route yet/)).toBeNull();
  });

  it('renders a write-seed allowlist row as Initial setup, never the raw sentinel', async () => {
    stubFetch(
      STUBS.map((s) =>
        s.url === '/api/send-allowlist'
          ? {
              url: s.url,
              body: {
                entries: [{ channelId: 'c-9', addedByAccountId: 'system:write-seed', addedAt: 0 }],
              },
            }
          : s,
      ),
    );
    renderWithSession(<McpPage />);
    expect(await screen.findByText('Initial setup')).toBeTruthy();
    expect(screen.queryByText('system:write-seed')).toBeNull();
  });

  it('revokes a token through the confirm dialog', async () => {
    const mock = stubFetch([
      ...STUBS,
      {
        method: 'POST',
        url: '/api/mcp/tokens/tok-1/revoke',
        body: { tokenId: 'tok-1', tokensRevoked: 1 },
      },
    ]);
    renderWithSession(<McpPage />);
    // The first Revoke belongs to the client row, the second to the live token.
    const revokeButtons = await screen.findAllByRole('button', { name: 'Revoke' });
    fireEvent.click(revokeButtons[1]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke token' }));
    await vi.waitFor(() => {
      const post = mock.mock.calls.find(
        (c) => (c[0] as string) === '/api/mcp/tokens/tok-1/revoke' && c[1]?.method === 'POST',
      );
      expect(post, 'revoke POST').toBeTruthy();
    });
  });

  it('renders the role policy card with modes and the allowlist', async () => {
    stubFetch(STUBS);
    renderWithSession(<McpPage />);
    expect(await screen.findByText('Role policy')).toBeTruthy();
    expect(selectOf(screen.getByLabelText('Grant mode')).value).toBe('below-bot');
    expect(selectOf(screen.getByLabelText('Ping mode')).value).toBe('allowlist');
    // The name comes from the live role list, which resolves just after the
    // policy itself; the id is its own column. The id also appears in the
    // role picker's suggestion list, so it is a multi-match.
    expect(await screen.findByText('Helpers')).toBeTruthy();
    expect(screen.getAllByText('r-1').length).toBeGreaterThan(0);
  });

  it('saves the modes through the policy route', async () => {
    const mock = stubFetch([
      ...STUBS,
      {
        method: 'POST',
        url: '/api/role-policy',
        body: {
          before: { grantMode: 'below-bot', pingMode: 'allowlist' },
          after: { grantMode: 'allowlist', pingMode: 'allowlist' },
          changed: true,
        },
      },
    ]);
    renderWithSession(<McpPage />);
    fireEvent.change(await screen.findByLabelText('Grant mode'), {
      target: { value: 'allowlist' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save modes' }));
    await vi.waitFor(() => {
      const post = mock.mock.calls.find(
        (c) => (c[0] as string) === '/api/role-policy' && c[1]?.method === 'POST',
      );
      expect(post, 'policy POST').toBeTruthy();
    });
    const post = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/role-policy' && c[1]?.method === 'POST',
    );
    expect(bodyOf(post!)).toEqual({ grant: 'allowlist', ping: 'allowlist' });
  });

  it('adds a role through the allowlist route', async () => {
    const mock = stubFetch([
      ...STUBS,
      { method: 'POST', url: '/api/role-allowlist', body: { outcome: 'allowed' } },
    ]);
    renderWithSession(<McpPage />);
    fireEvent.change(await screen.findByPlaceholderText('Search role names'), {
      target: { value: 'r-2' },
    });
    fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'ping' } });
    fireEvent.click(screen.getByRole('button', { name: 'Allow role' }));
    await vi.waitFor(() => {
      const post = mock.mock.calls.find(
        (c) => (c[0] as string) === '/api/role-allowlist' && c[1]?.method === 'POST',
      );
      expect(post, 'allow POST').toBeTruthy();
    });
    const post = mock.mock.calls.find(
      (c) => (c[0] as string) === '/api/role-allowlist' && c[1]?.method === 'POST',
    );
    expect(bodyOf(post!)).toEqual({ roleId: 'r-2', purpose: 'ping', accountId: 'acct-1' });
  });

  it('removes an allowlist row through the delete route', async () => {
    const mock = stubFetch(STUBS);
    renderWithSession(<McpPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await vi.waitFor(() => {
      const call = mock.mock.calls.find(
        (c) =>
          (c[0] as string) === '/api/role-allowlist/r-1?purpose=grant' && c[1]?.method === 'DELETE',
      );
      expect(call, 'disallow DELETE').toBeTruthy();
    });
  });

  it('shows a server refusal inline instead of failing silently', async () => {
    stubFetch([
      ...STUBS,
      {
        method: 'POST',
        url: '/api/role-allowlist',
        status: 409,
        body: { error: 'role-dangerous' },
      },
    ]);
    renderWithSession(<McpPage />);
    fireEvent.change(await screen.findByPlaceholderText('Search role names'), {
      target: { value: 'r-9' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Allow role' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/dangerous permission/);
  });
});
