// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../../test-support.js';
import { CSRF_HEADER } from '../../api.js';
import { PermissionsPage } from '../permissions.js';

beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/permissions');
});

const CASES = [
  { action: 'Allow read', method: 'POST', path: '/api/read-scope', body: { channelId: 'chan /' } },
  { action: 'Stop read', method: 'DELETE', path: '/api/read-scope/chan%20%2F', body: undefined },
  {
    action: 'Allow send',
    method: 'POST',
    path: '/api/send-allowlist',
    body: { channelId: 'chan /', accountId: 'acct-1' },
  },
  {
    action: 'Stop send',
    method: 'DELETE',
    path: '/api/send-allowlist/chan%20%2F',
    body: undefined,
  },
  {
    action: 'Archive',
    method: 'POST',
    path: '/api/archive/channels',
    body: { channelId: 'chan /', attachmentPolicy: 'none' },
  },
  {
    action: 'Stop archiving',
    method: 'POST',
    path: '/api/archive/channels/chan%20%2F/pause',
    body: undefined,
  },
  {
    action: 'Resume archiving',
    method: 'POST',
    path: '/api/archive/channels/chan%20%2F/resume',
    body: undefined,
  },
  {
    action: 'No access',
    method: 'POST',
    path: '/api/log-exclusions',
    body: { channelId: 'chan /' },
  },
  {
    action: 'Restore access',
    method: 'DELETE',
    path: '/api/log-exclusions/chan%20%2F',
    body: undefined,
  },
] as const;

function reads(action: string, category: boolean) {
  const channelId = category ? 'cat /' : 'chan /';
  const scopeKind = category ? 'category' : 'channel';
  return [
    {
      url: '/api/guild/channels',
      body: { channels: [{ channelId, name: 'target', kind: category ? 'category' : 'text' }] },
    },
    {
      url: '/api/archive/status',
      body: {
        channels: ['Stop archiving', 'Resume archiving'].includes(action)
          ? [{ channelId, scopeKind, collecting: action !== 'Resume archiving' }]
          : [],
      },
    },
    {
      url: '/api/send-allowlist',
      body: { entries: action === 'Stop send' ? [{ channelId, scopeKind }] : [] },
    },
    {
      url: '/api/read-scope',
      body: { entries: action === 'Stop read' ? [{ channelId, scopeKind }] : [] },
    },
    {
      url: '/api/log-routes',
      body: { excludedChannels: action === 'Restore access' ? [channelId] : [] },
    },
  ];
}

describe('Permissions request invariants', () => {
  it.each(CASES)(
    'channel $action keeps URL, method, body and CSRF',
    async ({ action, method, path, body }) => {
      const fetch = stubFetch([...reads(action, false), { url: path, method, body: { ok: true } }]);
      renderWithSession(<PermissionsPage />);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Change #target' }));
      await user.click(screen.getByRole('menuitem', { name: action }));
      await waitFor(() =>
        expect(
          fetch.mock.calls.some((call) => call[0] === path && call[1]?.method === method),
        ).toBe(true),
      );
      const writes = fetch.mock.calls.filter((call) => (call[1]?.method ?? 'GET') !== 'GET');
      expect(writes).toHaveLength(1);
      expect(bodyOf(writes[0] ?? [])).toEqual(body);
      expect(new Headers(writes[0]?.[1]?.headers).get(CSRF_HEADER)).toBe('csrf-test');
    },
  );

  it.each(CASES.filter((item) => !['No access', 'Restore access'].includes(item.action)))(
    'category $action keeps category scope and never attachment bytes',
    async ({ action, method, path, body }) => {
      const categoryPath =
        path
          .replace('/read-scope/chan', '/read-scope/categories/cat')
          .replace('/send-allowlist/chan', '/send-allowlist/categories/cat')
          .replace('/archive/channels', '/archive/categories')
          .replace('chan%20%2F', 'cat%20%2F') +
        (path === '/api/read-scope' || path === '/api/send-allowlist' ? '/categories' : '');
      const expected =
        body === undefined
          ? undefined
          : action === 'Allow send'
            ? { channelId: 'cat /', accountId: 'acct-1' }
            : { channelId: 'cat /' };
      const fetch = stubFetch([
        ...reads(action, true),
        { url: categoryPath, method, body: { ok: true } },
      ]);
      renderWithSession(<PermissionsPage />);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('radio', { name: 'text + attachment bytes' }));
      await user.click(screen.getByRole('button', { name: 'Change target' }));
      await user.click(
        screen.getByRole('menuitem', { name: action === 'Archive' ? 'Archive category' : action }),
      );
      await waitFor(() =>
        expect(
          fetch.mock.calls.some((call) => call[0] === categoryPath && call[1]?.method === method),
        ).toBe(true),
      );
      const writes = fetch.mock.calls.filter((call) => (call[1]?.method ?? 'GET') !== 'GET');
      expect(writes).toHaveLength(1);
      expect(bodyOf(writes[0] ?? [])).toEqual(expected);
      expect(new Headers(writes[0]?.[1]?.headers).get(CSRF_HEADER)).toBe('csrf-test');
    },
  );

  it('server read-only refusal keeps the session guard and does not reload scope', async () => {
    const fetch = stubFetch([
      ...reads('Allow read', false),
      {
        url: '/api/read-scope',
        method: 'POST',
        status: 503,
        body: { error: 'read-only', message: 'Nothing was changed.' },
      },
    ]);
    renderWithSession(<PermissionsPage />, { session: { ...TEST_SESSION, readonly: true } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Change #target' }));
    await user.click(screen.getByRole('menuitem', { name: 'Allow read' }));
    expect(await screen.findByText('This instance is read-only')).toBeTruthy();
    expect(fetch.mock.calls.filter((call) => (call[1]?.method ?? 'GET') !== 'GET')).toHaveLength(1);
    expect(fetch.mock.calls.filter((call) => call[0] === '/api/guild/channels')).toHaveLength(1);
  });
});
