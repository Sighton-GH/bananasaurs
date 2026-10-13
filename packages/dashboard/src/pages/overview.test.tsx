// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthProvider } from '../app/health.js';
import { renderWithSession, stubFetch } from '../test-support.js';
import { OverviewPage } from './overview.js';

const HEALTH = {
  guildId: '1540816150026518620',
  guildName: 'Bananasaurs dev',
  gateway: { connected: true, pingMs: 42, guildCount: 1 },
  safety: { killswitch: false, dryRun: true, breakerOpen: false },
  jobCounts: { pending: 2 },
  oldestDueJobAtMs: undefined,
};
const PULSE = [
  { url: '/api/providers/eligibility', body: { warnings: [] } },
  {
    url: '/api/automod/review',
    body: { matches: [], nativeHits: [], nativeBlocked: 0, verdicts: {} },
  },
  { url: '/api/jobs?failedOnly=true&limit=100', body: [] },
  {
    url: '/api/backups',
    body: {
      backups: [{ fileName: 'a.db', sizeBytes: 1, createdAtMs: Date.now(), hasChecksum: true }],
    },
  },
  { url: '/api/audit?limit=8', body: [] },
  { url: '/api/archive/status', body: { channels: [], index: { indexed: 0, rows: 0 } } },
  { url: '/api/mcp/clients', body: { clients: [] } },
  { url: '/api/mcp/sends?since=24h', body: { sends: [] } },
];

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const renderOverview = () =>
  renderWithSession(
    <HealthProvider>
      <OverviewPage />
    </HealthProvider>,
  );

describe('OverviewPage (7c)', () => {
  it('card links use the kit Link and the card text uses the token scale', async () => {
    stubFetch([{ url: '/api/health', body: HEALTH }, ...PULSE]);
    renderOverview();
    const link = await screen.findByRole('link', { name: 'Open safety →' });
    expect(link.className).toContain('text-accent');
    await screen.findByText('Nothing needs attention right now.');
    expect(document.querySelector('.text-sm')).toBeNull();
  });

  it('the job lag badge carries the absolute time and keeps the single health fetch', async () => {
    const mock = stubFetch([
      { url: '/api/health', body: { ...HEALTH, oldestDueJobAtMs: 0 } },
      ...PULSE,
    ]);
    renderOverview();
    expect(await screen.findByText(/running late since/)).toBeTruthy();
    await waitFor(() =>
      expect(mock.mock.calls.filter((c) => c[0] === '/api/health')).toHaveLength(1),
    );
  });

  it('a failed health fetch is unavailable, not an empty overview', async () => {
    stubFetch([{ url: '/api/health', status: 500, body: { error: 'boom' } }]);
    renderOverview();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Server')).toBeNull();
  });
});
