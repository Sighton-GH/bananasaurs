// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { HealthProvider, useHealth } from './health.js';
import { StateStrip } from './StateStrip.js';

const base = {
  guildId: '1',
  guildName: 'g',
  gateway: { connected: true, pingMs: 1, guildCount: 1 },
  jobCounts: {},
  oldestDueJobAtMs: undefined,
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('StateStrip', () => {
  function HealthProbe() {
    return <p>health:{useHealth().resource.state}</p>;
  }

  it('renders nothing when nothing is held', async () => {
    stubFetch([
      {
        url: '/api/health',
        body: { ...base, safety: { killswitch: false, dryRun: false, breakerOpen: false } },
      },
    ]);
    renderWithSession(
      <HealthProvider>
        <StateStrip />
        <HealthProbe />
      </HealthProvider>,
    );
    await screen.findByText('health:ready');
    expect(screen.queryByTestId('state-strip')).toBeNull();
  });

  it('names the unknown state when health fails', async () => {
    stubFetch([{ url: '/api/health', status: 500, body: { error: 'boom' } }]);
    renderWithSession(
      <HealthProvider>
        <StateStrip />
      </HealthProvider>,
    );
    const strip = await screen.findByTestId('state-strip');
    expect(strip.textContent).toContain('Health unknown');
  });

  it('names every active hold', async () => {
    stubFetch([
      {
        url: '/api/health',
        body: {
          ...base,
          gateway: { ...base.gateway, connected: false },
          safety: { killswitch: true, dryRun: true, breakerOpen: true },
        },
      },
    ]);
    renderWithSession(
      <HealthProvider>
        <StateStrip />
      </HealthProvider>,
      { session: { ...TEST_SESSION, readonly: true } },
    );
    const strip = await screen.findByTestId('state-strip');
    for (const text of [
      'Read-only instance',
      'Dry run',
      'Kill switch on',
      'Circuit breaker open',
      'Gateway disconnected',
    ]) {
      expect(strip.textContent).toContain(text);
    }
  });
});
