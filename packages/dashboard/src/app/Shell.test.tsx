// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderWithSession, stubFetch } from '../test-support.js';
import { NOT_BUILT } from '../pages/stub.js';
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
  const mock = stubFetch([
    { url: '/api/health', body: HEALTH },
    { url: '/api/log-routes', body: { routes: [] } },
    { url: '/api/panels', body: [] },
    { url: '/api/audit?limit=50', body: [] },
    { url: '/api/automod/rules', body: { rules: [] } },
    {
      url: '/api/automod/review?limit=50',
      body: { matches: [], nativeHits: [], nativeBlocked: 0, verdicts: {} },
    },
    { method: 'POST', url: '/api/logout', body: {} },
  ]);
  const { hook } = memoryLocation({ path });
  renderWithSession(
    <Router hook={hook}>
      <Shell />
    </Router>,
  );
  return mock;
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
    ['/automod', 'Automod'],
    ['/review', 'Review'],
    ['/cases', 'Cases'],
    ['/cutover', 'Cutover'],
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
    const aside = screen.getByRole('complementary');
    expect(await within(aside).findByText('Bananasaurs dev')).toBeTruthy();
  });

  it('Sign out posts /api/logout', async () => {
    const mock = renderAt('/');
    await screen.findByRole('button', { name: 'Sign out' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    });
    const call = mock.mock.calls.find((c) => (c[0] as string) === '/api/logout');
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).method).toBe('POST');
  });

  it.each([
    ['/archive', 'Archive'],
    ['/search', 'Search'],
    ['/resources', 'Resources'],
    ['/providers', 'Providers'],
    ['/memory', 'Memory'],
    ['/ai', 'AI workspace'],
    ['/proposals', 'Proposals'],
  ])('renders NOT_BUILT at the %s stub titled %s', async (path, title) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy();
    expect(await screen.findByText(NOT_BUILT)).toBeTruthy();
  });

  it.each([['/archive'], ['/search']])(
    'the %s stub says where the feature lives today (S10-D3)',
    async (path) => {
      renderAt(path);
      expect(
        await screen.findByText(
          'The archive and search exist in Release 2 as operator CLI commands (`archive`, `mcp`) and through the MCP connector; the page arrives with Release 3.',
        ),
      ).toBeTruthy();
    },
  );

  it('the Planned nav group lists exactly the seven stub labels', async () => {
    renderAt('/');
    const nav = screen.getByRole('navigation', { name: 'Planned' });
    const labels = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent);
    expect(labels).toEqual([
      'Archive',
      'Search',
      'Resources',
      'Providers',
      'Memory',
      'AI workspace',
      'Proposals',
    ]);
    expect(labels).toEqual(NAV.filter((n) => n.status === 'stub').map((n) => n.label));
  });
});
