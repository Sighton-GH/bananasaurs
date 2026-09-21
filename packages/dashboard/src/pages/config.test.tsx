// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthProvider } from '../app/health.js';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { ConfigPage } from './config.js';

const HEALTH = {
  guildId: '1540816150026518620',
  guildName: 'Bananasaurs dev',
  gateway: { connected: true, pingMs: 42, guildCount: 1 },
  safety: {
    killswitch: false,
    dryRun: true,
    breakerOpen: false,
    breakerReason: null,
    roleRatePerMin: 12,
    reconcileBudget: 50,
    breakerThreshold: 5,
  },
  jobCounts: {},
  oldestDueJobAtMs: undefined,
};

const CONFIG = { token: '<redacted>', guilds: ['1540816150026518620'] };

const renderPage = () =>
  renderWithSession(
    <HealthProvider>
      <ConfigPage />
    </HealthProvider>,
  );

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('ConfigPage', () => {
  it('renders the redacted config and the live safety settings', async () => {
    stubFetch([
      { url: '/api/health', body: HEALTH },
      { url: '/api/config', body: CONFIG },
    ]);
    renderPage();
    // The matrix labels the secret and shows its redacted value; the raw dump
    // survives as a disclosure, so the marker appears in both.
    expect((await screen.findAllByText(/<redacted>/)).length).toBeGreaterThan(0);
    expect(await screen.findByText('on — effects are rehearsed, not sent')).toBeTruthy();
    expect(screen.getByText('secret — redacted')).toBeTruthy();
    expect(screen.getAllByText('environment — restart to change').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Role changes per minute')).toHaveProperty('value', '12');
    expect(screen.getByLabelText('Safety stop threshold')).toHaveProperty('value', '5');
    // No instruction to drop to the terminal survives on this page.
    expect(screen.queryByText(/config set --confirm/)).toBeNull();
  });

  it('turning dry run off states that effects start being sent, then posts', async () => {
    const mock = stubFetch([
      { url: '/api/health', body: HEALTH },
      { url: '/api/config', body: CONFIG },
      { method: 'POST', url: '/api/settings', body: { ok: true } },
    ]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn dry run off' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('start being sent to Discord for real');
    expect(dialog.textContent).toContain('observe still only observes');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Turn dry run off' }));
    });
    const post = mock.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(bodyOf(post)).toEqual({ key: 'dry_run', value: false });
    expect(mock.mock.calls.filter((c) => (c[0] as string) === '/api/health')).toHaveLength(2);
  });

  it('breaker reset appears only when the breaker is open and posts closed', async () => {
    const mock = stubFetch([
      {
        url: '/api/health',
        body: {
          ...HEALTH,
          safety: { ...HEALTH.safety, breakerOpen: true, breakerReason: 'discord 429 storm' },
        },
      },
      { url: '/api/config', body: CONFIG },
      { method: 'POST', url: '/api/settings', body: { ok: true } },
    ]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset breaker' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('discord 429 storm');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Reset breaker' }));
    });
    const post = mock.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(bodyOf(post)).toEqual({ key: 'breaker', value: 'closed' });
  });

  it('applying a changed limit posts only the change; invalid input blocks the post', async () => {
    const mock = stubFetch([
      { url: '/api/health', body: HEALTH },
      { url: '/api/config', body: CONFIG },
      { method: 'POST', url: '/api/settings', body: { ok: true } },
    ]);
    renderPage();
    const threshold = await screen.findByLabelText('Safety stop threshold');
    fireEvent.change(threshold, { target: { value: 'not-a-number' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(mock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(0);

    fireEvent.change(threshold, { target: { value: '9' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    });
    const posts = mock.mock.calls.filter((c) => c[1]?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0]!)).toEqual({ key: 'breaker_threshold', value: 9 });
  });
});
