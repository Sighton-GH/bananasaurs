// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
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

const STUBS = [
  { url: '/api/mcp/clients', body: CLIENTS },
  { url: '/api/mcp/tokens', body: TOKENS },
  { url: '/api/send-allowlist', body: ALLOWLIST },
];

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('McpPage', () => {
  it('renders clients, tokens and the allowlist', async () => {
    stubFetch(STUBS);
    renderWithSession(<McpPage />);
    expect(await screen.findByText('Claude Desktop')).toBeTruthy();
    expect(screen.getByText('tok-1')).toBeTruthy();
    expect(screen.getByText('live')).toBeTruthy();
    expect(screen.getByText('revoked')).toBeTruthy();
    expect(screen.getByText('c-9')).toBeTruthy();
    expect(screen.getByText(/no HTTP route yet/)).toBeTruthy();
  });

  it('allow posts channelId with the session account and reloads', async () => {
    const mock = stubFetch([
      ...STUBS,
      { method: 'POST', url: '/api/send-allowlist', body: { outcome: 'allowed' } },
    ]);
    renderWithSession(<McpPage />);
    await screen.findByText('c-9');
    fireEvent.change(screen.getByLabelText('Allow a channel'), { target: { value: 'c-10' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow channel' }));
    });
    const post = mock.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(post[0] as string).toBe('/api/send-allowlist');
    expect(bodyOf(post)).toEqual({ channelId: 'c-10', accountId: 'acct-1' });
    expect(
      mock.mock.calls.filter(
        (c) => (c[0] as string) === '/api/send-allowlist' && c[1]?.method !== 'POST',
      ),
    ).toHaveLength(2);
  });

  it('a 404 on allow surfaces as a failure toast and nothing is added', async () => {
    const mock = stubFetch([
      ...STUBS,
      {
        method: 'POST',
        url: '/api/send-allowlist',
        status: 404,
        body: { error: 'no-such-channel' },
      },
    ]);
    renderWithSession(<McpPage />);
    await screen.findByText('c-9');
    fireEvent.change(screen.getByLabelText('Allow a channel'), { target: { value: 'nope' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow channel' }));
    });
    expect(await screen.findByText(/no-such-channel/)).toBeTruthy();
    expect(
      mock.mock.calls.filter(
        (c) => (c[0] as string) === '/api/send-allowlist' && c[1]?.method !== 'POST',
      ),
    ).toHaveLength(1);
  });

  it('remove states that the connector can no longer post there, then deletes', async () => {
    const mock = stubFetch([
      ...STUBS,
      { method: 'DELETE', url: '/api/send-allowlist/c-9', body: { ok: true, removed: true } },
    ]);
    renderWithSession(<McpPage />);
    await screen.findByText('c-9');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('can no longer post to channel c-9');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove channel' }));
    });
    expect(
      mock.mock.calls.some(
        (c) => (c[0] as string) === '/api/send-allowlist/c-9' && c[1]?.method === 'DELETE',
      ),
    ).toBe(true);
  });
});
