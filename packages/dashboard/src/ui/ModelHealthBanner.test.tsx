// @vitest-environment jsdom
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { ModelHealthBanner } from './ModelHealthBanner.js';

const HEALTH_URL = '/api/assistant/model-health?window=24h';

/** ADR 0129 §8: one model stuck on the same non-transient failure. */
const PERSISTENT = {
  window: '24h',
  models: [
    {
      model: 'stealth/space-bunny-alpha',
      keyId: 'key-1',
      calls: 10,
      ok: 0,
      successRate: 0,
      p50Ms: 120,
      p95Ms: 450,
      tokens: 0,
      costUsd: 0,
      failuresByCode: { 'provider-bad-model': 10 },
      lastError: { at: 1_790_000_000_000, code: 'provider-bad-model' },
      persistent: { code: 'provider-bad-model', since: 1_790_000_000_000, count: 10 },
    },
  ],
};

const HEALTHY = {
  window: '24h',
  models: [
    {
      model: 'stealth/space-bunny-alpha',
      keyId: 'key-1',
      calls: 10,
      ok: 10,
      successRate: 1,
      p50Ms: 120,
      p95Ms: 450,
      tokens: 100,
      costUsd: 0.001,
      failuresByCode: {},
      lastOkAt: 1_790_000_000_000,
    },
  ],
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('ModelHealthBanner', () => {
  it('names each persistent model, its streak and the failure, with a link to the editor', async () => {
    stubFetch([{ url: HEALTH_URL, body: PERSISTENT }]);
    renderWithSession(<ModelHealthBanner />);
    expect(await screen.findByText('stealth/space-bunny-alpha', { exact: false })).toBeTruthy();
    expect(screen.getByText('10 times', { exact: false })).toBeTruthy();
    expect(
      screen.getByText('This model is not available on this key', { exact: false }),
    ).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open Model order' });
    expect(link.getAttribute('href')).toBe('/assistant/setup');
  });

  it('renders nothing when no model is persistently failing', async () => {
    const mock = stubFetch([{ url: HEALTH_URL, body: HEALTHY }]);
    renderWithSession(<ModelHealthBanner />);
    await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByRole('link', { name: 'Open Model order' })).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('times in a row');
  });

  it('renders nothing when the only persistent model left the chain (ADR 0129)', async () => {
    const mock = stubFetch([
      {
        url: HEALTH_URL,
        body: {
          window: '24h',
          models: [
            {
              ...PERSISTENT.models[0],
              inChain: false,
              keyLabel: 'Old key',
            },
          ],
        },
      },
    ]);
    renderWithSession(<ModelHealthBanner />);
    await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByRole('link', { name: 'Open Model order' })).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('times in a row');
  });

  it('renders nothing on a 403, and does not throw', async () => {
    const mock = stubFetch([{ url: HEALTH_URL, status: 403, body: { error: 'forbidden' } }]);
    renderWithSession(<ModelHealthBanner />);
    await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByRole('link', { name: 'Open Model order' })).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('times in a row');
  });
});
