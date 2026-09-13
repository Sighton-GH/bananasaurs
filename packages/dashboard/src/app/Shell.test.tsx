// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderWithSession, stubFetch } from '../test-support.js';
import { NAV } from './routes.js';
import { Shell } from './Shell.js';

const HEALTH = {
  guildId: '1540816150026518620',
  guildName: 'Bananasaurs dev',
  gateway: { connected: true, pingMs: 42, guildCount: 1 },
  safety: { killswitch: false, dryRun: false, breakerOpen: false },
  jobCounts: {},
  oldestDueJobAtMs: undefined,
};

function renderAt(path: string) {
  stubFetch([
    { url: '/api/health', body: HEALTH },
    { url: '/api/log-routes', body: { routes: [] } },
    { url: '/api/panels', body: [] },
    { url: '/api/audit?limit=50', body: [] },
  ]);
  const { hook } = memoryLocation({ path });
  return renderWithSession(
    <Router hook={hook}>
      <Shell />
    </Router>,
  );
}

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('Shell', () => {
  it.each([
    ['/', 'Overview'],
    ['/safety', 'Safety'],
    ['/logging', 'Logging'],
    ['/panels', 'Role panels'],
    ['/audit', 'Audit'],
  ])('renders the %s page titled %s and marks its rail entry current', async (path, title) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy();
    const link = screen.getByRole('link', { name: title, current: 'page' });
    expect(link.getAttribute('href')).toBe(path);
  });

  it('renders the not-found page for an unknown path, with nothing current', async () => {
    renderAt('/nope');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeTruthy();
    expect(screen.queryByRole('link', { current: 'page' })).toBeNull();
  });

  it('the rail lists every built NAV entry and no others, and names the guild', async () => {
    renderAt('/');
    const nav = screen.getByRole('navigation', { name: 'Areas' });
    const labels = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent);
    expect(labels).toEqual(NAV.filter((n) => n.status === 'built').map((n) => n.label));
    expect(await screen.findAllByText('Bananasaurs dev')).not.toHaveLength(0);
  });

  it('exposes Sign out', async () => {
    renderAt('/');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });
});
