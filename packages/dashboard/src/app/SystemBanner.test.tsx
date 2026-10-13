// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, OfflineError, type SessionInfo } from '../api.js';
import type { Resource } from '../hooks/useResource.js';
import { renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { HealthProvider, useHealth, type HealthInfo } from './health.js';
import { SessionProvider } from './session.js';
import { SystemBanner, systemCauses, type SystemCause } from './SystemBanner.js';

const MODEL_URL = '/api/assistant/model-health?window=24h';

const base: HealthInfo = {
  guildId: '1',
  guildName: 'g',
  gateway: { connected: true, pingMs: 1, guildCount: 1 },
  safety: { killswitch: false, dryRun: false, breakerOpen: false },
  jobCounts: {},
  oldestDueJobAtMs: undefined,
};

const ready = (data: HealthInfo): Resource<HealthInfo> => ({ state: 'ready', data });
const failed = (error: unknown): Resource<HealthInfo> => ({
  state: 'error',
  request: 'the health summary',
  message: 'x',
  error,
  retry: () => undefined,
});
const everything: HealthInfo = {
  ...base,
  gateway: { ...base.gateway, connected: false },
  safety: { killswitch: true, dryRun: true, breakerOpen: true },
};
const ids = (causes: readonly SystemCause[]) => causes.map((c) => c.id);

const model = (name: string, extra: Record<string, unknown> = {}) => ({
  model: name,
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
  ...extra,
});
const PERSISTENT = { window: '24h', models: [model('stealth/space-bunny-alpha')] };
const HEALTHY = {
  window: '24h',
  models: [
    model('stealth/space-bunny-alpha', {
      ok: 10,
      successRate: 1,
      failuresByCode: {},
      persistent: undefined,
    }),
  ],
};

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
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
afterEach(() => vi.restoreAllMocks());

describe('systemCauses', () => {
  it('lists every cause once, in order, with the plan copy and actions', () => {
    const causes = systemCauses({
      online: false,
      readonly: true,
      health: ready(everything),
      failingModels: ['a/model', 'b/model'],
    });
    expect(ids(causes)).toEqual([
      'offline',
      'killswitch',
      'breaker',
      'gateway',
      'readonly',
      'dry-run',
      'models',
    ]);
    expect(new Set(ids(causes)).size).toBe(causes.length);
    expect(causes.map((c) => c.tone)).toEqual([
      'danger',
      'danger',
      'danger',
      'hold',
      'hold',
      'hold',
      'hold',
    ]);
    const by = Object.fromEntries(causes.map((c) => [c.id, c]));
    expect(by.offline?.text).toBe(
      "Bananasaurs can't be reached. Changes won't save until it's back.",
    );
    expect(by.offline?.action).toBeUndefined();
    expect(by.killswitch?.text).toBe('Kill switch is on. The bot is taking no actions in Discord.');
    expect(by.killswitch?.action).toEqual({ label: 'Open Safety', href: '/safety' });
    expect(by.breaker?.text).toBe(
      'The safety breaker is open. Discord changes are paused until someone checks.',
    );
    expect(by.breaker?.action).toEqual({ label: 'Open Safety', href: '/safety' });
    expect(by.gateway?.text).toBe(
      'The bot is disconnected from Discord. Logs and replies will resume when it reconnects.',
    );
    expect(by.gateway?.action).toEqual({ label: 'Open Doctor', href: '/doctor' });
    expect(by.readonly?.text).toBe('This dashboard is read-only. Changes are refused.');
    expect(by.readonly?.action).toBeUndefined();
    expect(by['dry-run']?.text).toBe(
      'Preview mode is on. Discord changes are logged, not applied.',
    );
    expect(by['dry-run']?.action).toEqual({ label: 'Open Safety', href: '/safety' });
    expect(by.models?.text).toBe('2 AI models keep failing: a/model…');
    expect(by.models?.action).toEqual({ label: 'Open AI setup', href: '/assistant/setup' });
  });

  it('safety-unknown: an ordinary 500 is unknown, not offline', () => {
    const err = new ApiError(500, { error: 'internal' });
    const causes = systemCauses({
      online: true,
      readonly: false,
      health: failed(err),
      failingModels: [],
    });
    expect(ids(causes)).toEqual(['safety-unknown']);
    expect(causes[0]?.tone).toBe('hold');
    expect(causes[0]?.text).toBe(
      "Safety status couldn't load. Check Safety before making changes.",
    );
    expect(causes[0]?.action).toEqual({ label: 'Open Safety', href: '/safety' });
  });

  it('an offline health error gives offline once and suppresses safety-unknown', () => {
    const causes = systemCauses({
      online: true,
      readonly: false,
      health: failed(new OfflineError('offline')),
      failingModels: [],
    });
    expect(ids(causes)).toEqual(['offline']);
  });

  it('offline with a health error keeps the independent known causes', () => {
    const causes = systemCauses({
      online: false,
      readonly: true,
      health: failed(new OfflineError('offline')),
      failingModels: ['a/model'],
    });
    expect(ids(causes)).toEqual(['offline', 'readonly', 'models']);
    expect(ids(causes)).not.toContain('safety-unknown');
  });

  it('navigator offline with minimal inputs is just offline', () => {
    expect(
      ids(systemCauses({ online: false, readonly: false, health: ready(base), failingModels: [] })),
    ).toEqual(['offline']);
  });

  it('navigator offline with cached kill switch still shows both, ordered', () => {
    const causes = systemCauses({
      online: false,
      readonly: false,
      health: ready({ ...base, safety: { killswitch: true, dryRun: false, breakerOpen: false } }),
      failingModels: [],
    });
    expect(ids(causes)).toEqual(['offline', 'killswitch']);
  });

  it('loading health and missing safety invent no cause', () => {
    expect(
      systemCauses({
        online: true,
        readonly: false,
        health: { state: 'loading' },
        failingModels: [],
      }),
    ).toEqual([]);
    expect(
      systemCauses({
        online: true,
        readonly: false,
        health: ready({ ...base, safety: undefined }),
        failingModels: [],
      }),
    ).toEqual([]);
  });

  it('duplicate model names make one models cause naming one model', () => {
    const causes = systemCauses({
      online: true,
      readonly: false,
      health: ready(base),
      failingModels: ['a/model', 'a/model'],
    });
    expect(causes).toHaveLength(1);
    expect(causes[0]?.text).toBe('1 AI model keeps failing: a/model.');
  });

  it('no cause when everything is fine', () => {
    expect(
      systemCauses({ online: true, readonly: false, health: ready(base), failingModels: [] }),
    ).toEqual([]);
  });
});

function Probe() {
  return <p>health:{useHealth().resource.state}</p>;
}

function renderBanner(
  health: { status?: number; body: unknown } | 'offline',
  models: { status?: number; body: unknown } = { body: { window: '24h', models: [] } },
  session = TEST_SESSION,
) {
  const mock = stubFetch([
    ...(health === 'offline' ? [] : [{ url: '/api/health', ...health }]),
    { url: MODEL_URL, ...models },
  ]);
  if (health === 'offline') {
    const inner = mock.getMockImplementation();
    mock.mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === '/api/health') return Promise.reject(new TypeError('Failed to fetch'));
      return inner?.(input, init) ?? Promise.reject(new TypeError('no impl'));
    });
  }
  return {
    mock,
    ...renderWithSession(
      <HealthProvider>
        <SystemBanner />
        <Probe />
      </HealthProvider>,
      { session },
    ),
  };
}

describe('SystemBanner (migrated StateStrip cases)', () => {
  it('renders nothing when nothing is held', async () => {
    const { mock } = renderBanner({ body: base });
    await screen.findByText('health:ready');
    await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByRole('region', { name: 'System status' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names the unknown state when health fails with an ordinary error', async () => {
    renderBanner({ status: 500, body: { error: 'boom' } });
    const section = await screen.findByRole('region', { name: 'System status' });
    expect(section.textContent).toContain("Safety status couldn't load");
    expect(within(section).getByRole('status').textContent).toContain(
      "Safety status couldn't load",
    );
    expect(within(section).queryByRole('alert')).toBeNull();
    expect(section.textContent).not.toContain("can't be reached");
  });

  it('names every active hold on one surface', async () => {
    renderBanner({ body: everything }, { body: PERSISTENT }, { ...TEST_SESSION, readonly: true });
    const section = await screen.findByRole('region', { name: 'System status' });
    await within(section).findByRole('button', { name: 'and 1 more' });
    fireEvent.click(within(section).getByRole('button', { name: 'and 1 more' }));
    for (const text of [
      'Kill switch is on',
      'The safety breaker is open',
      'disconnected from Discord',
      'read-only',
      'Preview mode is on',
      '1 AI model keeps failing',
    ]) {
      expect(section.textContent).toContain(text);
    }
  });
});

describe('SystemBanner (migrated ModelHealthBanner cases)', () => {
  it('names each persistent model, its streak and the failure, with a link to the editor', async () => {
    renderBanner({ body: base }, { body: PERSISTENT });
    expect(
      (await screen.findAllByText('stealth/space-bunny-alpha', { exact: false })).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('10 times', { exact: false })).toBeTruthy();
    expect(
      screen.getByText('This model is not available on this key', { exact: false }),
    ).toBeTruthy();
    const links = screen.getAllByRole('link', { name: 'Open AI setup' });
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('/assistant/setup');
    // The details live inside the models banner, not in a second cause.
    expect(
      within(screen.getByRole('region', { name: 'System status' })).getAllByRole('status'),
    ).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('adds no models cause when no model is persistently failing', async () => {
    const { mock } = renderBanner({ body: base }, { body: HEALTHY });
    await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByRole('link', { name: 'Open AI setup' })).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('times in a row');
  });

  it('adds no models cause when the only persistent model left the chain (ADR 0129)', async () => {
    const { mock } = renderBanner(
      { body: base },
      {
        body: {
          window: '24h',
          models: [model('stealth/space-bunny-alpha', { inChain: false, keyLabel: 'Old key' })],
        },
      },
    );
    await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByRole('link', { name: 'Open AI setup' })).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('times in a row');
  });

  it('keeps a model with a missing inChain (older responses)', async () => {
    renderBanner({ body: base }, { body: PERSISTENT });
    expect(await screen.findByText('1 AI model keeps failing', { exact: false })).toBeTruthy();
  });

  it('stays silent on a 403 and does not throw', async () => {
    const { mock } = renderBanner({ body: base }, { status: 403, body: { error: 'forbidden' } });
    await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByRole('link', { name: 'Open AI setup' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('two failing models make one cause that names both in its details', async () => {
    renderBanner(
      { body: base },
      { body: { window: '24h', models: [model('a/one'), model('b/two', { keyId: 'key-2' })] } },
    );
    expect(await screen.findByText('2 AI models keep failing: a/one…')).toBeTruthy();
    expect(screen.getByText('b/two', { exact: false })).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'System status' })).getAllByRole('status'),
    ).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('SystemBanner behaviour', () => {
  it('shows offline while online=false events arrive, keeping cached holds', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    renderBanner({
      body: { ...base, safety: { killswitch: true, dryRun: false, breakerOpen: false } },
    });
    await screen.findByText('Kill switch is on', { exact: false });
    expect(screen.queryByText("Bananasaurs can't be reached", { exact: false })).toBeNull();
    act(() => {
      vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
      window.dispatchEvent(new Event('offline'));
    });
    const section = screen.getByRole('region', { name: 'System status' });
    const texts = within(section)
      .getAllByRole('alert')
      .map((a) => a.textContent ?? '');
    expect(texts[0]).toContain("Bananasaurs can't be reached");
    expect(texts[1]).toContain('Kill switch is on');
    act(() => {
      vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByText("Bananasaurs can't be reached", { exact: false })).toBeNull();
  });

  it('a failed health read that is offline shows offline once, not safety-unknown', async () => {
    renderBanner('offline');
    const section = await screen.findByRole('region', { name: 'System status' });
    expect(section.textContent).toContain("Bananasaurs can't be reached");
    expect(section.textContent).not.toContain("Safety status couldn't load");
    expect(within(section).getAllByRole('alert')).toHaveLength(1);
  });

  it('announces holds politely while danger causes stay alerts', async () => {
    renderBanner({ body: everything });
    const section = await screen.findByRole('region', { name: 'System status' });
    await within(section).findByText('Preview mode is on', { exact: false });
    const alerts = within(section).getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.textContent).toContain('Kill switch is on');
    expect(alerts[1]?.textContent).toContain('The safety breaker is open');
    const holds = within(section).getAllByRole('status');
    expect(holds).toHaveLength(2);
    expect(holds[0]?.textContent).toContain('disconnected from Discord');
    expect(holds[1]?.textContent).toContain('Preview mode is on');
  });

  it('renders each action as an in-app link', async () => {
    renderBanner({ body: everything });
    await screen.findByText('Kill switch is on', { exact: false });
    const hrefs = screen
      .getAllByRole('link')
      .map((l) => `${l.textContent ?? ''}:${l.getAttribute('href') ?? ''}`);
    expect(hrefs).toContain('Open Safety:/safety');
    expect(hrefs).toContain('Open Doctor:/doctor');
  });

  it('shows five causes then an "and N more" button that expands in place', async () => {
    renderBanner({ body: everything }, { body: PERSISTENT }, { ...TEST_SESSION, readonly: true });
    const section = await screen.findByRole('region', { name: 'System status' });
    await within(section).findByRole('button', { name: 'and 1 more' });
    // Six causes: killswitch, breaker, gateway, readonly, dry-run, models.
    expect(within(section).queryAllByRole('alert')).toHaveLength(2);
    expect(within(section).getAllByRole('status')).toHaveLength(3);
    const button = within(section).getByRole('button', { name: 'and 1 more' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const controls = button.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(section.querySelector(`#${CSS.escape(controls ?? '')}`)).toBeTruthy();
    expect(section.textContent).not.toContain('AI model');
    button.focus();
    fireEvent.click(button);
    expect(within(section).queryAllByRole('alert')).toHaveLength(2);
    expect(within(section).getAllByRole('status')).toHaveLength(4);
    expect(section.textContent).toContain('1 AI model keeps failing');
    const after = within(section).getByRole('button', { name: 'Show fewer' });
    expect(after.getAttribute('aria-expanded')).toBe('true');
    expect(after.getAttribute('aria-controls')).toBe(controls);
    fireEvent.click(after);
    expect(within(section).queryAllByRole('alert')).toHaveLength(2);
    expect(within(section).getAllByRole('status')).toHaveLength(3);
    expect(within(section).getByRole('button', { name: 'and 1 more' })).toBeTruthy();
  });

  it('keeps expansion meaningful when causes change: no stale "more" label', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    renderBanner({ body: everything }, { body: PERSISTENT }, { ...TEST_SESSION, readonly: true });
    const section = await screen.findByRole('region', { name: 'System status' });
    await within(section).findByRole('button', { name: 'and 1 more' });
    fireEvent.click(within(section).getByRole('button', { name: 'and 1 more' }));
    act(() => {
      vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
      window.dispatchEvent(new Event('offline'));
    });
    // 7 causes now; still expanded, all visible, button says Show fewer.
    expect(within(section).queryAllByRole('alert')).toHaveLength(3);
    expect(within(section).getAllByRole('status')).toHaveLength(4);
    expect(within(section).getByRole('button', { name: 'Show fewer' })).toBeTruthy();
    act(() => {
      vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(within(section).queryAllByRole('alert')).toHaveLength(2);
    expect(within(section).getAllByRole('status')).toHaveLength(4);
  });
});

describe('SystemBanner R1 durability', () => {
  it('lets the action wrap below the text so the text column stays readable when narrow', async () => {
    renderBanner({
      body: { ...base, safety: { killswitch: true, dryRun: false, breakerOpen: false } },
    });
    const link = await screen.findByRole('link', { name: 'Open Safety' });
    // The action shares one wrapping flex row with the text: when the text
    // column would drop below its readable basis, the action moves to its own
    // line instead of squeezing the text into mid-word breaks (180 CSS px).
    const row = link.parentElement;
    expect(row?.className).toContain('flex-wrap');
    const text = within(row as HTMLElement).getByText('Kill switch is on', { exact: false });
    const column = text.closest('div');
    expect(column?.className).toContain('basis-32');
    // Wide layouts keep the action right-aligned on the text's own line.
    expect(link.className).toContain('ml-auto');
  });

  it('expands and collapses with real keyboard Enter and Space', async () => {
    const user = userEvent.setup();
    renderBanner({ body: everything }, { body: PERSISTENT }, { ...TEST_SESSION, readonly: true });
    const section = await screen.findByRole('region', { name: 'System status' });
    const button = await within(section).findByRole('button', { name: 'and 1 more' });
    expect(within(section).queryAllByRole('alert')).toHaveLength(2);
    expect(within(section).getAllByRole('status')).toHaveLength(3);
    button.focus();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    expect(within(section).queryAllByRole('alert')).toHaveLength(2);
    expect(within(section).getAllByRole('status')).toHaveLength(4);
    const fewer = within(section).getByRole('button', { name: 'Show fewer' });
    expect(document.activeElement).toBe(fewer);
    expect(fewer.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard(' ');
    expect(within(section).queryAllByRole('alert')).toHaveLength(2);
    expect(within(section).getAllByRole('status')).toHaveLength(3);
    await user.keyboard(' ');
    expect(within(section).queryAllByRole('alert')).toHaveLength(2);
    expect(within(section).getAllByRole('status')).toHaveLength(4);
    await user.keyboard('{Enter}');
    expect(within(section).queryAllByRole('alert')).toHaveLength(2);
    expect(within(section).getAllByRole('status')).toHaveLength(3);
    expect(document.activeElement).toBe(
      within(section).getByRole('button', { name: 'and 1 more' }),
    );
  });

  it('keeps expansion truthful as causes shrink to one, then empty, then grow back', async () => {
    const table: Record<string, unknown> = {
      '/api/health': everything,
      [MODEL_URL]: PERSISTENT,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return Promise.resolve(
          new Response(JSON.stringify(table[url] ?? { error: 'unstubbed' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    function ReloadHealth() {
      const health = useHealth();
      return (
        <button type="button" onClick={health.reload}>
          reload health
        </button>
      );
    }
    const tree = (session: SessionInfo) => (
      <SessionProvider session={session} onLoggedOut={() => undefined}>
        <HealthProvider>
          <SystemBanner />
          <ReloadHealth />
        </HealthProvider>
      </SessionProvider>
    );
    const readonly = { ...TEST_SESSION, readonly: true };
    const view = render(tree(readonly));

    // Six causes; expand so all are visible.
    const section = await screen.findByRole('region', { name: 'System status' });
    fireEvent.click(await within(section).findByRole('button', { name: 'and 1 more' }));
    expect(within(section).queryAllByRole('alert')).toHaveLength(2);
    expect(within(section).getAllByRole('status')).toHaveLength(4);

    // Shrink to the small set: healthy safety data leaves read-only + models.
    table['/api/health'] = base;
    fireEvent.click(screen.getByRole('button', { name: 'reload health' }));
    await vi.waitFor(() => expect(section.textContent ?? '').not.toContain('Kill switch is on'));
    expect(within(section).queryAllByRole('alert')).toHaveLength(0);
    expect(within(section).getAllByRole('status')).toHaveLength(2);
    expect(section.textContent).toContain('read-only');
    expect(section.textContent).toContain('1 AI model keeps failing');
    // No "more" label can lie about hidden causes once everything fits.
    expect(within(section).queryByRole('button', { name: /more|fewer/ })).toBeNull();

    // Empty: a read-write session with healthy data renders nothing at all.
    table[MODEL_URL] = HEALTHY;
    view.rerender(tree({ ...TEST_SESSION }));
    await vi.waitFor(() =>
      expect(screen.queryByRole('region', { name: 'System status' })).toBeNull(),
    );

    // Grow back to six: the expanded meaning survived small and empty sets.
    table['/api/health'] = everything;
    table[MODEL_URL] = PERSISTENT;
    view.rerender(tree({ ...readonly }));
    const back = await screen.findByRole('region', { name: 'System status' });
    await within(back).findByText('1 AI model keeps failing', { exact: false });
    expect(within(back).queryAllByRole('alert')).toHaveLength(2);
    expect(within(back).getAllByRole('status')).toHaveLength(4);
    const fewer = within(back).getByRole('button', { name: 'Show fewer' });
    expect(fewer.getAttribute('aria-expanded')).toBe('true');
  });
});
