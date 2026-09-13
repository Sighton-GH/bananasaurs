// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthProvider } from '../app/health.js';
import { bodyOf, renderWithSession, stubFetch } from '../test-support.js';
import { AuditPage } from './audit.js';
import { LoggingPage } from './logging.js';
import { OverviewPage } from './overview.js';
import { PanelsPage } from './panels.js';
import { SafetyPage } from './safety.js';

const HEALTH = {
  guildId: '1540816150026518620',
  guildName: 'Bananasaurs dev',
  gateway: { connected: true, pingMs: 42, guildCount: 1 },
  safety: { killswitch: false, dryRun: true, breakerOpen: false },
  jobCounts: { pending: 2 },
  oldestDueJobAtMs: undefined,
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('OverviewPage', () => {
  it('fetches /api/health and renders the same fields the old Health section did', async () => {
    const mock = stubFetch([{ url: '/api/health', body: HEALTH }]);
    renderWithSession(
      <HealthProvider>
        <OverviewPage />
      </HealthProvider>,
    );
    expect(await screen.findByText(/Bananasaurs dev/)).toBeTruthy();
    expect(screen.getByText('(1540816150026518620)')).toBeTruthy();
    expect(screen.getByText('connected')).toBeTruthy();
    expect(screen.getByText('42 ms')).toBeTruthy();
    // Dry run is on → a hold badge; kill switch and breaker are off → plain text.
    expect(screen.getByText('on')).toBeTruthy();
    expect(screen.getAllByText('off')).toHaveLength(1);
    expect(screen.getByText('closed')).toBeTruthy();
    expect(screen.getByText('pending=2')).toBeTruthy();
    expect(screen.queryByText(/Scheduler lag/)).toBeNull();
    expect(mock.mock.calls.map((c) => c[0] as string)).toEqual(['/api/health']);
  });

  it('renders the scheduler lag row only when a due job is waiting', async () => {
    stubFetch([{ url: '/api/health', body: { ...HEALTH, oldestDueJobAtMs: 0 } }]);
    renderWithSession(
      <HealthProvider>
        <OverviewPage />
      </HealthProvider>,
    );
    expect(await screen.findByText('Scheduler lag')).toBeTruthy();
  });
});

describe('SafetyPage', () => {
  it('turning on states the scope, then posts { on: true } and reloads health', async () => {
    const mock = stubFetch([
      { url: '/api/health', body: HEALTH },
      { method: 'POST', url: '/api/killswitch', body: { ok: true, killswitch: true } },
    ]);
    renderWithSession(
      <HealthProvider>
        <SafetyPage />
      </HealthProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Turn kill switch on' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('guild 1540816150026518620');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Turn kill switch on' }));
    });
    const post = mock.mock.calls.find((c) => (c[0] as string) === '/api/killswitch')!;
    expect(bodyOf(post)).toEqual({ on: true });
    expect(mock.mock.calls.filter((c) => (c[0] as string) === '/api/health')).toHaveLength(2);
  });

  it("turning off posts { on: false } with no confirmation dialog (re-auth is apiFetch's, covered in session.test.tsx)", async () => {
    const mock = stubFetch([
      { url: '/api/health', body: HEALTH },
      { method: 'POST', url: '/api/killswitch', body: { ok: true, killswitch: false } },
    ]);
    renderWithSession(
      <HealthProvider>
        <SafetyPage />
      </HealthProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn kill switch off' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    const post = mock.mock.calls.find((c) => (c[0] as string) === '/api/killswitch')!;
    expect(bodyOf(post)).toEqual({ on: false });
  });
});

describe('LoggingPage', () => {
  it('lists routes from /api/log-routes and posts the same body the old form did', async () => {
    const mock = stubFetch([
      {
        url: '/api/log-routes',
        body: {
          routes: [
            { eventKind: 'message_delete', channelId: '42', enabled: true, includeContent: false },
          ],
        },
      },
      { method: 'POST', url: '/api/log-routes', body: { ok: true } },
    ]);
    renderWithSession(<LoggingPage />);
    expect(await screen.findByText('message_delete')).toBeTruthy();
    expect(screen.getByText('redacted')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Event kind'), { target: { value: 'member_join' } });
    fireEvent.change(screen.getByLabelText('Channel ID'), { target: { value: '99' } });
    fireEvent.click(screen.getByLabelText('Include message content'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set route' }));
    });
    const post = mock.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(post[0] as string).toBe('/api/log-routes');
    expect(bodyOf(post)).toEqual({
      eventKind: 'member_join',
      channelId: '99',
      includeContent: false,
    });
    expect(
      mock.mock.calls.filter(
        (c) => (c[0] as string) === '/api/log-routes' && c[1]?.method !== 'POST',
      ),
    ).toHaveLength(2);
  });

  it('shows an empty state that says what to do', async () => {
    stubFetch([{ url: '/api/log-routes', body: { routes: [] } }]);
    renderWithSession(<LoggingPage />);
    expect(await screen.findByText(/No routes yet/)).toBeTruthy();
  });
});

describe('PanelsPage', () => {
  it('fetches /api/panels and renders each panel', async () => {
    stubFetch([
      {
        url: '/api/panels',
        body: [
          {
            panelId: 'p1',
            kind: 'roles',
            component: 'select',
            behaviour: 'toggle',
            status: 'posted',
            messageId: 'm',
            optionCount: 3,
          },
        ],
      },
    ]);
    renderWithSession(<PanelsPage />);
    expect(await screen.findByText('p1')).toBeTruthy();
    expect(screen.getByText('roles/select/toggle')).toBeTruthy();
    expect(screen.getByText('posted')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });
});

describe('AuditPage', () => {
  it('fetches /api/audit?limit=50 and formats actor and subject as before', async () => {
    const mock = stubFetch([
      {
        url: '/api/audit?limit=50',
        body: [
          {
            auditId: 1,
            at: 0,
            actorType: 'cli',
            actorId: null,
            actorUnixUserClaimed: 'bryan',
            via: null,
            action: 'killswitch.on',
            subjectType: 'guild',
            subjectId: '123',
            dryRun: false,
          },
        ],
      },
    ]);
    renderWithSession(<AuditPage />);
    expect(await screen.findByText('cli (bryan, claimed)')).toBeTruthy();
    expect(screen.getByText('guild:123')).toBeTruthy();
    expect(mock.mock.calls.map((c) => c[0] as string)).toEqual(['/api/audit?limit=50']);
  });

  it('renders the error state naming the request when the API fails', async () => {
    stubFetch([{ url: '/api/audit?limit=50', status: 500, body: { error: 'boom' } }]);
    renderWithSession(<AuditPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the audit log');
  });
});
