// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../../test-support.js';
import { PermissionsPage } from '../permissions.js';

const routes = [
  {
    url: '/api/guild/channels',
    body: { channels: [{ channelId: 'one', name: 'general', kind: 'text' }] },
  },
  { url: '/api/archive/status', body: { channels: [] } },
  { url: '/api/send-allowlist', body: { entries: [] } },
  { url: '/api/read-scope', body: { entries: [] } },
  { url: '/api/log-routes', body: { excludedChannels: [] } },
];
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/permissions');
});

describe('Permissions sweep', () => {
  it('uses URL tabs, preserves other query values, and follows query history without writes', async () => {
    window.history.replaceState(null, '', '/permissions?tab=assistant&keep=1#scope');
    const fetch = stubFetch(routes);
    renderWithSession(<PermissionsPage />);
    expect(screen.getByRole('tab', { name: 'Assistant' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('link', { name: 'Open Behaviours' }).getAttribute('href')).toBe(
      '/assistant',
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Specialised' }));
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('specialised');
    expect(new URLSearchParams(window.location.search).get('keep')).toBe('1');
    expect(window.location.hash).toBe('#scope');
    expect(screen.getByRole('link', { name: 'Connected apps' }).getAttribute('href')).toBe('/mcp');
    expect(screen.getByRole('link', { name: 'Role panels' }).getAttribute('href')).toBe('/panels');
    window.history.back();
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Assistant' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    expect(screen.getByRole('link', { name: 'Open Behaviours' })).toBeTruthy();
    expect(window.location.hash).toBe('#scope');
    expect(new URLSearchParams(window.location.search).get('keep')).toBe('1');
    await user.click(screen.getByRole('tab', { name: 'Channels' }));
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Channels' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(fetch.mock.calls.every((call) => (call[1]?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('defaults unknown tab values to Channels and supplies a single switch disclosure', async () => {
    window.history.replaceState(null, '', '/permissions?tab=unknown');
    stubFetch(routes);
    const { container } = renderWithSession(<PermissionsPage />);
    expect(screen.getByRole('tab', { name: 'Channels' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(container.querySelectorAll('details')).toHaveLength(1);
    expect(container.querySelector('summary')?.textContent).toBe('What the switches mean');
    expect(container.querySelectorAll('dl')).toHaveLength(1);
    expect(await screen.findByRole('group', { name: 'Attachment policy' })).toBeTruthy();
    expect(container.querySelector('select')).toBeNull();
  });

  it('opens column help by keyboard and returns focus on Escape', async () => {
    stubFetch(routes);
    renderWithSession(<PermissionsPage />);
    const help = await screen.findByRole('button', { name: 'Help: Read' });
    const user = userEvent.setup();
    help.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('note', { name: 'Read' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('note')).toBeNull();
    expect(document.activeElement).toBe(help);
  });

  it.each(['/api/guild/channels', '/api/archive/status', '/api/send-allowlist', '/api/read-scope'])(
    'mandatory %s failure is unavailable, not empty, with no scope actions',
    async (url) => {
      stubFetch(
        routes.map((route) =>
          route.url === url ? { ...route, status: 503, body: { error: 'unavailable' } } : route,
        ),
      );
      renderWithSession(<PermissionsPage />);
      expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
      expect(screen.queryByText('No channels yet')).toBeNull();
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.queryByRole('group', { name: 'Attachment policy' })).toBeNull();
    },
  );

  it('optional exclusions failure keeps other dimensions and hides only exclusion controls', async () => {
    stubFetch(
      routes.map((route) =>
        route.url === '/api/log-routes'
          ? { ...route, status: 403, body: { error: 'forbidden' } }
          : route,
      ),
    );
    renderWithSession(<PermissionsPage />);
    const table = await screen.findByRole('table');
    expect(table.querySelector('[data-label="Read"]')).toBeTruthy();
    expect(table.querySelector('[data-label="Write"]')).toBeTruthy();
    expect(table.querySelector('[data-label="Archive"]')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Read' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: /No access/ })).toBeNull();
    expect(screen.getByText(/cannot see or change channel access overrides/)).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'No access' })).toBeNull();
  });

  it('empty means successful empty channel data only', async () => {
    stubFetch(
      routes.map((route) =>
        route.url === '/api/guild/channels' ? { ...route, body: { channels: [] } } : route,
      ),
    );
    renderWithSession(<PermissionsPage />);
    expect(await screen.findByText('No channels yet')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
  });
});
