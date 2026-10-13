// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router, useLocation } from 'wouter';
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
    expect(dialog.textContent).toContain(
      'Automod acts only when its switch on the Automod page is On.',
    );
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
    const summary = (await screen.findAllByRole('alert')).find((a) =>
      a.textContent?.includes("There's a problem"),
    )!;
    expect(document.activeElement).toBe(summary);
    expect(within(summary).getByRole('link').getAttribute('href')).toBe('#field-breaker_threshold');
    expect(mock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(0);

    fireEvent.change(threshold, { target: { value: '9' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    });
    const posts = mock.mock.calls.filter((c) => c[1]?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0]!)).toEqual({ key: 'breaker_threshold', value: 9 });
  });

  it('renders a 400 limits refusal with the server title, hint, request id and field problem', async () => {
    stubFetch([
      { url: '/api/health', body: HEALTH },
      { url: '/api/config', body: CONFIG },
      {
        method: 'POST',
        url: '/api/settings',
        status: 400,
        body: {
          error: 'bad-request',
          title: 'The request was not valid',
          message: 'One or more fields were missing or had the wrong format.',
          hint: 'Fix the highlighted fields and try again.',
          fields: [{ path: 'value', problem: 'too_big' }],
          requestId: 'req-0a1b2c3d',
        },
      },
    ]);
    renderPage();
    const threshold = await screen.findByLabelText('Safety stop threshold');
    fireEvent.change(threshold, { target: { value: '9' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    });
    expect(await screen.findByText('The request was not valid')).toBeTruthy();
    const notice = (await screen.findAllByRole('alert')).find((a) =>
      a.textContent?.includes('The request was not valid'),
    )!;
    expect(notice.textContent).toContain('Fix the highlighted fields and try again.');
    expect(notice.textContent).toContain('req-0a1b2c3d');
    expect(notice.textContent).toContain('bad-request · HTTP 400 · request req-0a1b2c3d');
    expect((await screen.findAllByText('Too large.')).length).toBeGreaterThan(0);
    // The code survives only inside the `code · HTTP n · request id` meta line.
    expect(screen.getAllByText(/bad-request/)).toHaveLength(1);
  });
});

describe('Configuration drafts', () => {
  it('tracks edits, stays on a guarded link and discards without writing', async () => {
    const mock = stubFetch([
      { url: '/api/health', body: HEALTH },
      { url: '/api/config', body: CONFIG },
    ]);
    renderWithSession(
      <HealthProvider>
        <a href="/doctor">Doctor link</a>
        <ConfigPage />
      </HealthProvider>,
    );
    const input = await screen.findByLabelText('Safety stop threshold');
    fireEvent.change(input, { target: { value: '9' } });
    expect(screen.getByRole('region', { name: 'Unsaved changes' }).textContent).toContain(
      '1 unsaved change',
    );
    fireEvent.click(screen.getByRole('link', { name: 'Doctor link' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Leave without saving?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(input).toHaveProperty('value', '9');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(input).toHaveProperty('value', '5');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(mock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(0);
  });

  it('retains only unsaved fields after a partial save, stops in order, and reloads health', async () => {
    const mock = stubFetch([
      { url: '/api/health', body: HEALTH },
      { url: '/api/config', body: CONFIG },
    ]);
    let posts = 0;
    const original = mock.getMockImplementation()!;
    mock.mockImplementation((input, init) => {
      if (init?.method === 'POST') {
        posts += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              posts === 1
                ? { ok: true }
                : {
                    error: 'bad-request',
                    title: 'Repair limit refused',
                    message: 'Nothing else changed.',
                    fields: [{ path: 'value', problem: 'Too large.' }],
                  },
            ),
            { status: posts === 1 ? 200 : 400, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return original(input, init);
    });
    renderPage();
    fireEvent.change(await screen.findByLabelText('Role changes per minute'), {
      target: { value: '15' },
    });
    fireEvent.change(screen.getByLabelText('Repair changes per run'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('Safety stop threshold'), { target: { value: '9' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(mock.mock.calls.filter((c) => c[1]?.method === 'POST').map(bodyOf)).toEqual([
      { key: 'role_rate_per_min', value: 15 },
      { key: 'reconcile_budget', value: 60 },
    ]);
    expect(mock.mock.calls.filter((c) => c[0] === '/api/health')).toHaveLength(2);
    expect(screen.getByLabelText('Role changes per minute')).toHaveProperty('value', '15');
    expect(screen.getByLabelText('Repair changes per run')).toHaveProperty('value', '60');
    expect(screen.getByLabelText('Safety stop threshold')).toHaveProperty('value', '9');
    expect(screen.getByRole('region', { name: 'Unsaved changes' }).textContent).toContain(
      '2 unsaved changes',
    );
    expect(screen.getByLabelText('Repair changes per run').getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(
      screen.getByText('Saved Role changes per minute. Remaining changes were not saved.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Saved Role changes per minute. Remaining changes were not saved.'),
    ).toBeTruthy();
    expect(screen.getByLabelText('Safety stop threshold').getAttribute('aria-invalid')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('Role changes per minute')).toHaveProperty('value', '15');
    expect(screen.getByLabelText('Repair changes per run')).toHaveProperty('value', '50');
    expect(screen.getByLabelText('Safety stop threshold')).toHaveProperty('value', '5');
  });

  it('does not call failed health an endless loading state', async () => {
    stubFetch([
      {
        url: '/api/health',
        status: 500,
        body: { error: 'unavailable', message: 'Health is offline' },
      },
      { url: '/api/config', body: CONFIG },
    ]);
    renderPage();
    expect((await screen.findAllByText('Health is offline')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Loading the safety state…')).toBeNull();
    expect(screen.queryByLabelText('Safety stop threshold')).toBeNull();
  });
});

function GuardedConfig() {
  const [location] = useLocation();
  return (
    <>
      <output aria-label="Route">{location}</output>
      <a href="/doctor?tab=checks#summary">Doctor route</a>
      <HealthProvider>
        <ConfigPage />
      </HealthProvider>
    </>
  );
}

describe('Configuration save boundaries', () => {
  it('guards unload only while dirty and Leave navigates to the exact path query and hash', async () => {
    window.history.replaceState(null, '', '/config');
    const push = vi.spyOn(window.history, 'pushState');
    stubFetch([
      { url: '/api/health', body: HEALTH },
      { url: '/api/config', body: CONFIG },
    ]);
    renderWithSession(
      <Router>
        <GuardedConfig />
      </Router>,
    );
    const input = await screen.findByLabelText('Safety stop threshold');
    const cleanUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
    fireEvent.change(input, { target: { value: '9' } });
    const dirtyUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('link', { name: 'Doctor route' }));
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByLabelText('Route').textContent).toBe('/config');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave' }));
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/doctor?tab=checks#summary',
    );
    expect(push).toHaveBeenCalledTimes(1);
    window.history.replaceState(null, '', '/');
  });

  it('treats blanks as unchanged, permits fractional role rates and rejects fractional integer limits', async () => {
    const mock = stubFetch([
      { url: '/api/health', body: HEALTH },
      { url: '/api/config', body: CONFIG },
      { method: 'POST', url: '/api/settings', body: { ok: true } },
    ]);
    renderPage();
    fireEvent.change(await screen.findByLabelText('Role changes per minute'), {
      target: { value: '12.5' },
    });
    fireEvent.change(screen.getByLabelText('Repair changes per run'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Safety stop threshold'), { target: { value: '1.5' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    });
    expect(mock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(0);
    expect(screen.getByLabelText('Safety stop threshold').getAttribute('aria-invalid')).toBe(
      'true',
    );
    fireEvent.change(screen.getByLabelText('Safety stop threshold'), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    const writes = mock.mock.calls.filter((c) => c[1]?.method === 'POST');
    expect(writes.map(bodyOf)).toEqual([{ key: 'role_rate_per_min', value: 12.5 }]);
    expect(writes[0]?.[0]).toBe('/api/settings');
    expect(writes[0]?.[1]?.credentials).toBe('same-origin');
    expect(writes[0]?.[1]?.headers).toMatchObject({ 'x-bananasaurs-csrf': 'csrf-test' });
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('keeps draft fields through reauthentication and disables repeated Save and Discard while busy', async () => {
    const mock = stubFetch([
      { url: '/api/health', body: HEALTH },
      { url: '/api/config', body: CONFIG },
    ]);
    const original = mock.getMockImplementation()!;
    let authenticated = false;
    mock.mockImplementation((input, init) => {
      if (input === '/api/reauth') {
        authenticated = true;
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (input === '/api/settings')
        return Promise.resolve(
          new Response(
            JSON.stringify(authenticated ? { ok: true } : { error: 'reauth-required' }),
            { status: authenticated ? 200 : 401 },
          ),
        );
      return original(input, init);
    });
    renderPage();
    fireEvent.change(await screen.findByLabelText('Safety stop threshold'), {
      target: { value: '9' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: 'Save', hidden: true })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Discard', hidden: true })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByLabelText('Safety stop threshold')).toHaveProperty('value', '9');
    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'test-password' },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    });
    const writes = mock.mock.calls.filter((c) => c[0] === '/api/settings');
    expect(writes).toHaveLength(2);
    expect(writes.map(bodyOf)).toEqual([
      { key: 'breaker_threshold', value: 9 },
      { key: 'breaker_threshold', value: 9 },
    ]);
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(screen.getByLabelText('Safety stop threshold')).toHaveProperty('value', '9');
  });
});

it('validates a limit on blur without erasing input, and a later valid blur clears that field error', async () => {
  stubFetch([
    { url: '/api/health', body: HEALTH },
    { url: '/api/config', body: CONFIG },
  ]);
  renderPage();
  const threshold = await screen.findByLabelText('Safety stop threshold');
  fireEvent.change(threshold, { target: { value: '1.5' } });
  fireEvent.blur(threshold);
  expect(threshold.getAttribute('aria-invalid')).toBe('true');
  expect(threshold).toHaveProperty('value', '1.5');
  fireEvent.change(threshold, { target: { value: '7' } });
  fireEvent.blur(threshold);
  expect(threshold.getAttribute('aria-invalid')).toBeNull();
});

it('keeps process configuration failure separate from working safety and limits', async () => {
  stubFetch([
    { url: '/api/health', body: HEALTH },
    {
      url: '/api/config',
      status: 500,
      body: { error: 'unavailable', message: 'Config is offline' },
    },
  ]);
  renderPage();
  expect(await screen.findByText('Config is offline')).toBeTruthy();
  expect(screen.getByLabelText('Safety stop threshold')).toHaveProperty('value', '5');
  expect(screen.queryByText(/No process configuration/)).toBeNull();
});

it('distinguishes an empty redacted configuration response', async () => {
  stubFetch([
    { url: '/api/health', body: HEALTH },
    { url: '/api/config', body: {} },
  ]);
  renderPage();
  expect(await screen.findByText('No process configuration values were returned.')).toBeTruthy();
});
