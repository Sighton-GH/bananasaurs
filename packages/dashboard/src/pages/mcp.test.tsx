// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
      connectionId: 'tok-1',
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
      connectionId: 'tok-1',
      createdAt: 0,
      expiresAt: Date.now() + 86_400_000,
      revokedAt: 1000,
      lastUsedAt: 500,
    },
  ],
};
const CONNECTIONS = {
  connections: [
    {
      connectionId: 'tok-1',
      accountId: 'acct-1',
      accountUsername: 'racerbot-club-claude',
      clientId: 'cl-1',
      clientName: 'Claude Desktop',
      scopes: ['bananasaurs:read', 'bananasaurs:send', 'bananasaurs:tasks'],
      createdAt: 0,
      lastUsedAt: null,
      status: 'connected',
      tokenCount: 2,
    },
    {
      connectionId: 'tok-old',
      accountId: 'acct-1',
      accountUsername: 'racerbot-club-claude',
      clientId: 'cl-1',
      clientName: 'Claude Desktop',
      scopes: ['bananasaurs:read'],
      createdAt: 0,
      lastUsedAt: 500,
      status: 'revoked',
      tokenCount: 4,
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
  { url: '/api/mcp/connections', body: CONNECTIONS },
  { url: '/api/send-allowlist', body: ALLOWLIST },
  { url: '/api/mcp/sends?since=7d', body: SENDS },
  { url: '/api/role-policy', body: ROLE_POLICY },
  { url: '/api/guild/roles', body: ROLES },
];

afterEach(cleanup);
afterEach(() => window.history.replaceState(null, '', '/mcp'));

const openTab = (name: string) => userEvent.click(screen.getByRole('tab', { name }));
afterEach(() => vi.unstubAllGlobals());

describe('McpPage', () => {
  it('renders clients, tokens and the allowlist', async () => {
    stubFetch(STUBS);
    renderWithSession(<McpPage />);
    expect((await screen.findAllByText('Claude Desktop')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('tok-1').length).toBeGreaterThan(0);
    expect(screen.getByText('live')).toBeTruthy();
    expect(screen.getAllByText('revoked').length).toBeGreaterThan(0);
    await openTab('Send allowlist');
    expect(screen.getAllByText('c-9').length).toBeGreaterThan(0);
    // The send ledger is a page section now, not a "still on the CLI" note.
    expect(screen.getByText('Send ledger')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Connected apps' })).toBeTruthy();
    await openTab('Send ledger');
    expect(await screen.findByText('m-1')).toBeTruthy();
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
    await openTab('Send allowlist');
    expect(await screen.findByText('Initial setup')).toBeTruthy();
    expect(screen.queryByText('system:write-seed')).toBeNull();
  });

  it('renders the Connections card with username, app name and plain scope labels', async () => {
    stubFetch(STUBS);
    renderWithSession(<McpPage />);
    expect(await screen.findByText('Connections', { selector: 'h2' })).toBeTruthy();
    expect((await screen.findAllByText('racerbot-club-claude')).length).toBe(2);
    expect(screen.getByText('connected')).toBeTruthy();
    expect(screen.getAllByText('Post').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Tasks').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Read').length).toBe(2);
    // Raw rows live behind a collapsed section.
    expect(screen.getByText('Individual tokens (advanced)')).toBeTruthy();
  });

  it('disconnects a connected connection through the confirm dialog', async () => {
    const mock = stubFetch([
      ...STUBS,
      {
        method: 'POST',
        url: '/api/mcp/connections/tok-1/disconnect',
        body: { connectionId: 'tok-1', tokensRevoked: 2 },
      },
    ]);
    renderWithSession(<McpPage />);
    // Only the connected connection offers Disconnect.
    const buttons = await screen.findAllByRole('button', { name: 'Disconnect' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect app' }));
    await vi.waitFor(() => {
      const post = mock.mock.calls.find(
        (c) =>
          (c[0] as string) === '/api/mcp/connections/tok-1/disconnect' && c[1]?.method === 'POST',
      );
      expect(post, 'disconnect POST').toBeTruthy();
    });
  });

  it('deletes a connection and a raw token behind confirm dialogs', async () => {
    const mock = stubFetch([
      ...STUBS,
      {
        method: 'POST',
        url: '/api/mcp/connections/tok-old/delete',
        body: { connectionId: 'tok-old', tokensRevoked: 0, tokensDeleted: 4 },
      },
      {
        method: 'POST',
        url: '/api/mcp/tokens/tok-2/delete',
        body: { tokenId: 'tok-2', tokensRevoked: 0, tokensDeleted: 1 },
      },
    ]);
    renderWithSession(<McpPage />);
    const deletes = await screen.findAllByRole('button', { name: 'Delete' });
    // Connections rows come first (connected, then revoked), then the raw rows.
    fireEvent.click(deletes[1]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete connection' }));
    await vi.waitFor(() => {
      expect(
        mock.mock.calls.find((c) => (c[0] as string) === '/api/mcp/connections/tok-old/delete'),
        'connection delete POST',
      ).toBeTruthy();
    });
    // The raw rows sit in a collapsed section; open it.
    fireEvent.click(screen.getByText('Individual tokens (advanced)'));
    const rawDeletes = await screen.findAllByRole('button', { name: 'Delete' });
    fireEvent.click(rawDeletes[rawDeletes.length - 1]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete token' }));
    await vi.waitFor(() => {
      expect(
        mock.mock.calls.find((c) => (c[0] as string) === '/api/mcp/tokens/tok-2/delete'),
        'token delete POST',
      ).toBeTruthy();
    });
  });

  it('Clean up asks first, then calls the cleanup route and reports the counts', async () => {
    const mock = stubFetch([
      ...STUBS,
      {
        method: 'POST',
        url: '/api/mcp/cleanup',
        body: { tokensDeleted: 400, clientsDeleted: 2 },
      },
    ]);
    renderWithSession(<McpPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clean up' }));
    expect(await screen.findByText(/no longer works/)).toBeTruthy();
    expect(mock.mock.calls.some((c) => (c[0] as string) === '/api/mcp/cleanup')).toBe(false);
    fireEvent.click(
      await screen
        .findAllByRole('button', { name: 'Clean up' })
        .then((b) => b[b.length - 1] as HTMLElement),
    );
    await vi.waitFor(() => {
      const post = mock.mock.calls.find(
        (c) => (c[0] as string) === '/api/mcp/cleanup' && c[1]?.method === 'POST',
      );
      expect(post, 'cleanup POST').toBeTruthy();
    });
    expect(await screen.findByText(/400 token rows and 2 unused apps/)).toBeTruthy();
  });

  it('shows how many connections each registered client has', async () => {
    stubFetch(STUBS);
    renderWithSession(<McpPage />);
    await openTab('Registered clients');
    expect(await screen.findByRole('columnheader', { name: 'Connections' })).toBeTruthy();
  });

  it('renders the role policy card with modes and the allowlist', async () => {
    stubFetch(STUBS);
    renderWithSession(<McpPage />);
    await openTab('Role policy');
    expect(await screen.findByRole('heading', { name: 'Role policy' })).toBeTruthy();
    expect(
      within(screen.getByRole('group', { name: 'Grant mode' })).getByRole<HTMLInputElement>(
        'radio',
        { name: 'Roles below the bot' },
      ).checked,
    ).toBe(true);
    expect(
      within(screen.getByRole('group', { name: 'Ping mode' })).getByRole<HTMLInputElement>(
        'radio',
        { name: 'Allowlisted roles only' },
      ).checked,
    ).toBe(true);
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
    await openTab('Role policy');
    const group = await screen.findByRole('group', { name: 'Grant mode' });
    await userEvent.click(within(group).getByRole('radio', { name: 'Allowlisted roles only' }));
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
    await openTab('Role policy');
    fireEvent.change(await screen.findByPlaceholderText('Search role names'), {
      target: { value: 'r-2' },
    });
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Purpose' })).getByRole('radio', {
        name: 'Ping roles',
      }),
    );
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
    await openTab('Role policy');
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
    await openTab('Role policy');
    fireEvent.change(await screen.findByPlaceholderText('Search role names'), {
      target: { value: 'r-9' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Allow role' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/dangerous permission/);
  });
});

describe('Connected apps tab routing', () => {
  it('opens a deep-linked tab and preserves unrelated query parameters on navigation', async () => {
    window.history.replaceState(null, '', '/mcp?tab=send-ledger&context=club');
    const mock = stubFetch(STUBS);
    renderWithSession(<McpPage />);
    expect(await screen.findByText('m-1')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Send ledger' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await openTab('Connections');
    expect(await screen.findByText('connected')).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('connections');
    expect(new URLSearchParams(window.location.search).get('context')).toBe('club');
    expect(mock.mock.calls.some((c) => c[1]?.method !== undefined && c[1]?.method !== 'GET')).toBe(
      false,
    );
  });

  it('falls back to Connections for an unknown tab without rewriting the URL', async () => {
    window.history.replaceState(null, '', '/mcp?tab=unknown');
    stubFetch(STUBS);
    renderWithSession(<McpPage />);
    expect(await screen.findByText('connected')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Connections' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(window.location.search).toBe('?tab=unknown');
  });

  it('follows a popstate back to the selected section', async () => {
    stubFetch(STUBS);
    renderWithSession(<McpPage />);
    await screen.findByText('connected');
    await openTab('Send ledger');
    expect(await screen.findByText('m-1')).toBeTruthy();
    window.history.replaceState(null, '', '/mcp?tab=connections');
    fireEvent(window, new PopStateEvent('popstate'));
    expect(await screen.findByText('connected')).toBeTruthy();
    expect(screen.queryByText('m-1')).toBeNull();
  });

  it('keeps the full cleanup scope and Cancel focus without making a request', async () => {
    const mock = stubFetch(STUBS);
    renderWithSession(<McpPage />);
    const opener = await screen.findByRole('button', { name: 'Clean up' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(
      'Working connections are not touched; their revoked tokens',
    );
    expect(dialog.textContent).toContain(
      'kept until 14 days after they expire, so a stolen one is still caught.',
    );
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    expect(mock.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(false);
  });
});

describe('Connected apps data and action safety', () => {
  it('shows a role-list failure rather than treating it as an empty success', async () => {
    stubFetch(
      STUBS.map((s) =>
        s.url === '/api/guild/roles' ? { ...s, status: 503, body: { error: 'unavailable' } } : s,
      ),
    );
    renderWithSession(<McpPage />);
    await openTab('Role policy');
    expect(await screen.findByText("Couldn't load the role list")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save modes' })).toBeTruthy();
  });

  it.each([
    ['connections', '/api/mcp/connections', { connections: [] }, 'No apps have connected yet.'],
    ['send-allowlist', '/api/send-allowlist', { entries: [] }, /No channels allowlisted/],
    ['registered-clients', '/api/mcp/clients', { clients: [] }, 'No clients registered yet.'],
    [
      'send-ledger',
      '/api/mcp/sends?since=7d',
      { sends: [] },
      'No connector messages in the last 7 days.',
    ],
  ] as const)('distinguishes empty %s from failed data', async (tab, url, body, message) => {
    window.history.replaceState(null, '', `/mcp?tab=${tab}`);
    stubFetch(STUBS.map((s) => (s.url === url ? { ...s, body } : s)));
    renderWithSession(<McpPage />);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retains identifiers-only tokens and distinguishes token failure from no tokens', async () => {
    stubFetch(
      STUBS.map((s) =>
        s.url === '/api/mcp/tokens' ? { ...s, status: 503, body: { error: 'unavailable' } } : s,
      ),
    );
    renderWithSession(<McpPage />);
    expect(await screen.findByText("Couldn't load the MCP tokens")).toBeTruthy();
    expect(screen.queryByText('No tokens minted yet.')).toBeNull();
    expect(screen.getByText('Individual tokens (advanced)')).toBeTruthy();
  });

  it('shows the required capability on a refused connections read, never a false empty', async () => {
    stubFetch(
      STUBS.map((s) =>
        s.url === '/api/mcp/connections'
          ? {
              ...s,
              status: 403,
              body: {
                error: 'forbidden',
                title: 'Connections need access',
                message: 'Needs mcp.manage.',
              },
            }
          : s,
      ),
    );
    renderWithSession(<McpPage />);
    expect(await screen.findByText('Needs mcp.manage.')).toBeTruthy();
    expect(screen.queryByText('No apps have connected yet.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it.each([
    {
      kind: 'disconnect',
      opener: 'Disconnect',
      confirm: 'Disconnect app',
      route: '/api/mcp/connections/a%2Fb%20%3F/disconnect',
      response: { connectionId: 'a/b ?', tokensRevoked: 7 },
      scope: 'Every token from this sign-in stops working at once;',
      outcome: /7 token\(s\) revoked/,
    },
    {
      kind: 'connection',
      opener: 'Delete',
      confirm: 'Delete connection',
      route: '/api/mcp/connections/a%2Fb%20%3F/delete',
      response: { connectionId: 'a/b ?', tokensDeleted: 9 },
      scope: 'Any live token is revoked first, then every token row of this connection is deleted.',
      outcome: /9 token row\(s\) removed/,
    },
    {
      kind: 'token',
      opener: 'Delete',
      confirm: 'Delete token',
      route: '/api/mcp/tokens/a%2Fb%20%3F/delete',
      response: { tokenId: 'a/b ?', tokensDeleted: 1 },
      scope: "If this token's connection is still connected, the whole connection is disconnected",
      outcome: 'Token row deleted',
    },
    {
      kind: 'client',
      opener: 'Revoke',
      confirm: 'Remove client',
      route: '/api/mcp/clients/a%2Fb%20%3F/revoke',
      response: { clientId: 'a/b ?', tokensRevoked: 11 },
      scope:
        'The app is removed and every access token ever issued to it stops working immediately.',
      outcome: /11 token\(s\) revoked/,
    },
    {
      kind: 'cleanup',
      opener: 'Clean up',
      confirm: 'Clean up',
      route: '/api/mcp/cleanup',
      response: { tokensDeleted: 17, clientsDeleted: 3 },
      scope: 'registered over an hour ago. Working connections are not touched;',
      outcome: /17 token rows and 3 unused apps/,
    },
  ])(
    'keeps $kind confirmation, encoded ID, body, CSRF and result counts',
    async ({ kind, opener, confirm, route, response, scope, outcome }) => {
      const routes = STUBS.map((s) => {
        if (s.url === '/api/mcp/connections')
          return {
            ...s,
            body: { connections: [{ ...CONNECTIONS.connections[0], connectionId: 'a/b ?' }] },
          };
        if (s.url === '/api/mcp/tokens')
          return { ...s, body: { tokens: [{ ...TOKENS.tokens[0], tokenId: 'a/b ?' }] } };
        if (s.url === '/api/mcp/clients')
          return { ...s, body: { clients: [{ ...CLIENTS.clients[0], clientId: 'a/b ?' }] } };
        return s;
      });
      const mock = stubFetch([...routes, { method: 'POST', url: route, body: response }]);
      renderWithSession(<McpPage />);
      if (kind === 'client') await openTab('Registered clients');
      if (kind === 'token')
        fireEvent.click(await screen.findByText('Individual tokens (advanced)'));
      const openers = await screen.findAllByRole('button', { name: opener });
      const action = kind === 'token' ? openers[openers.length - 1]! : openers[0]!;
      action.focus();
      fireEvent.click(action);
      let dialog = await screen.findByRole('dialog');
      expect(dialog.textContent).toContain(scope);
      expect(mock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(0);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await vi.waitFor(() => expect(document.activeElement).toBe(action));
      expect(mock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(0);
      fireEvent.click(action);
      dialog = await screen.findByRole('dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: confirm }));
      expect(await screen.findByText(outcome)).toBeTruthy();
      const posts = mock.mock.calls.filter((c) => c[1]?.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(posts[0]![0]).toBe(route);
      expect(bodyOf(posts[0]!)).toEqual({});
      expect(new Headers(posts[0]![1]?.headers).get('x-bananasaurs-csrf')).toBe('csrf-test');
    },
  );
});

describe('Connected apps remaining state boundaries', () => {
  it('shows the empty token section without issuing or revealing a token', async () => {
    const mock = stubFetch(
      STUBS.map((s) => (s.url === '/api/mcp/tokens' ? { ...s, body: { tokens: [] } } : s)),
    );
    renderWithSession(<McpPage />);
    expect(await screen.findByText('No tokens minted yet.')).toBeTruthy();
    expect(mock.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(false);
    expect(screen.queryByRole('button', { name: /issue|reveal/i })).toBeNull();
  });

  it.each([
    ['connections', '/api/mcp/connections', 'the MCP connections', 'No apps have connected yet.'],
    ['send-allowlist', '/api/send-allowlist', 'the send allowlist', /No channels allowlisted/],
    ['role-policy', '/api/role-policy', 'the role policy', /No roles allowlisted/],
    ['registered-clients', '/api/mcp/clients', 'the MCP clients', 'No clients registered yet.'],
    [
      'send-ledger',
      '/api/mcp/sends?since=7d',
      'the send ledger',
      'No connector messages in the last 7 days.',
    ],
  ] as const)(
    'shows unavailable %s without substituting an empty state',
    async (tab, url, what, empty) => {
      window.history.replaceState(null, '', `/mcp?tab=${tab}`);
      stubFetch(
        STUBS.map((s) =>
          s.url === url ? { ...s, status: 503, body: { error: 'unavailable' } } : s,
        ),
      );
      renderWithSession(<McpPage />);
      expect(await screen.findByText(`Couldn't load ${what}`)).toBeTruthy();
      expect(screen.queryByText(empty)).toBeNull();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    },
  );
});

describe('Connected apps review regressions', () => {
  it('preserves the URL fragment as well as unrelated query parameters', async () => {
    window.history.replaceState(null, '', '/mcp?context=club#review-anchor');
    stubFetch(STUBS);
    renderWithSession(<McpPage />);
    await screen.findByText('connected');
    await openTab('Send ledger');
    expect(window.location.search).toBe('?context=club&tab=send-ledger');
    expect(window.location.hash).toBe('#review-anchor');
  });

  it('keeps unsaved policy choices and role input across tabs without further reads', async () => {
    const mock = stubFetch(STUBS);
    renderWithSession(<McpPage />);
    await screen.findByText('connected');
    expect(mock.mock.calls).toHaveLength(6);
    await openTab('Role policy');
    const grant = await screen.findByRole('group', { name: 'Grant mode' });
    await userEvent.click(within(grant).getByRole('radio', { name: 'Allowlisted roles only' }));
    fireEvent.change(screen.getByPlaceholderText('Search role names'), {
      target: { value: 'r-unsaved' },
    });
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Purpose' })).getByRole('radio', {
        name: 'Ping roles',
      }),
    );
    const before = mock.mock.calls.map((call) => call[0]);
    expect(before.filter((url) => url === '/api/guild/roles')).toHaveLength(2);
    await openTab('Connections');
    expect(screen.queryByRole('group', { name: 'Grant mode' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save modes' })).toBeNull();
    await openTab('Role policy');
    const restored = await screen.findByRole('group', { name: 'Grant mode' });
    expect(
      within(restored).getByRole<HTMLInputElement>('radio', { name: 'Allowlisted roles only' })
        .checked,
    ).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Role' }).value).toBe('r-unsaved');
    expect(
      within(screen.getByRole('group', { name: 'Purpose' })).getByRole<HTMLInputElement>('radio', {
        name: 'Ping roles',
      }).checked,
    ).toBe(true);
    expect(mock.mock.calls.map((call) => call[0])).toEqual(before);
    expect(mock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });
});

it('retains a role refusal and input in a hidden inactive panel without keyboard access', async () => {
  const mock = stubFetch([
    ...STUBS,
    { method: 'POST', url: '/api/role-allowlist', status: 409, body: { error: 'role-dangerous' } },
  ]);
  renderWithSession(<McpPage />);
  await openTab('Role policy');
  fireEvent.change(await screen.findByPlaceholderText('Search role names'), {
    target: { value: 'r-refused' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Allow role' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toMatch(/dangerous permission/);
  const calls = mock.mock.calls.map((call) => call[0]);
  await openTab('Connections');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Role' })).toBeNull();
  const hidden = screen.getAllByRole('tabpanel', { hidden: true }).find((panel) => panel.hidden);
  expect(hidden).toBeTruthy();
  expect(hidden!.tabIndex).toBe(-1);
  expect(hidden!.contains(alert)).toBe(true);
  await userEvent.tab();
  expect(hidden!.contains(document.activeElement)).toBe(false);
  await openTab('Role policy');
  expect((await screen.findByRole('alert')).textContent).toMatch(/dangerous permission/);
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Role' }).value).toBe('r-refused');
  expect(mock.mock.calls.map((call) => call[0])).toEqual(calls);
});

it('real browser history Back and Forward restores query tabs and fragment', async () => {
  window.history.replaceState(null, '', '/mcp?tab=connections&context=club#review-anchor');
  stubFetch(STUBS);
  renderWithSession(<McpPage />);
  await screen.findByText('connected');
  await openTab('Send ledger');
  window.history.back();
  await vi.waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Connections' }).getAttribute('aria-selected')).toBe(
      'true',
    ),
  );
  expect(window.location.search).toBe('?tab=connections&context=club');
  expect(window.location.hash).toBe('#review-anchor');
  window.history.forward();
  await vi.waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Send ledger' }).getAttribute('aria-selected')).toBe(
      'true',
    ),
  );
  expect(window.location.hash).toBe('#review-anchor');
});
