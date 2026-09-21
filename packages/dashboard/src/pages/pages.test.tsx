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
  safety: {
    killswitch: false,
    dryRun: true,
    breakerOpen: false,
    breakerReason: null,
    roleRatePerMin: 12,
    reconcileBudget: 50,
    breakerThreshold: 5,
  },
  jobCounts: { pending: 2 },
  oldestDueJobAtMs: undefined,
};

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const PULSE_STUBS = [
  { url: '/api/providers/eligibility', body: { warnings: [] } },
  {
    url: '/api/automod/review',
    body: { matches: [], nativeHits: [], nativeBlocked: 0, verdicts: {} },
  },
  { url: '/api/jobs?failedOnly=true&limit=100', body: [] },
  { url: '/api/backups', body: { backups: [] } },
  { url: '/api/audit?limit=8', body: [] },
  { url: '/api/archive/status', body: { channels: [], index: { indexed: 0, rows: 0 } } },
  { url: '/api/mcp/clients', body: { clients: [] } },
  { url: '/api/mcp/sends?since=24h', body: { sends: [] } },
];

describe('OverviewPage', () => {
  it('renders the health fields as cards that lead to their pages', async () => {
    const mock = stubFetch([{ url: '/api/health', body: HEALTH }, ...PULSE_STUBS]);
    renderWithSession(
      <HealthProvider>
        <OverviewPage />
      </HealthProvider>,
    );
    expect(await screen.findByText('Bananasaurs dev')).toBeTruthy();
    expect(screen.getByText('(1540816150026518620)')).toBeTruthy();
    expect(screen.getByText('connected')).toBeTruthy();
    expect(screen.getByText('42 ms')).toBeTruthy();
    expect(screen.getByText('dry run on')).toBeTruthy();
    expect(screen.getByText('pending=2')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the queue →' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open safety →' })).toBeTruthy();
    expect(screen.queryByText(/scheduler lag/)).toBeNull();
    expect(mock.mock.calls.map((c) => c[0] as string).sort()).toEqual(
      ['/api/health', ...PULSE_STUBS.map((s) => s.url)].sort(),
    );
  });

  it('shows the scheduler lag badge only when a due job is waiting', async () => {
    stubFetch([{ url: '/api/health', body: { ...HEALTH, oldestDueJobAtMs: 0 } }, ...PULSE_STUBS]);
    renderWithSession(
      <HealthProvider>
        <OverviewPage />
      </HealthProvider>,
    );
    expect(await screen.findByText(/scheduler lag since/)).toBeTruthy();
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
    fireEvent.click(await screen.findByRole('button', { name: 'Turn kill switch on' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('guild 1540816150026518620');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Turn kill switch on' }));
    });
    const post = mock.mock.calls.find((c) => (c[0] as string) === '/api/killswitch')!;
    expect(bodyOf(post)).toEqual({ on: true });
    expect(mock.mock.calls.filter((c) => (c[0] as string) === '/api/health')).toHaveLength(2);
  });

  it("turning off posts { on: false } with no confirmation dialog (re-auth is apiFetch's)", async () => {
    const mock = stubFetch([
      { url: '/api/health', body: HEALTH },
      { method: 'POST', url: '/api/killswitch', body: { ok: true, killswitch: false } },
    ]);
    renderWithSession(
      <HealthProvider>
        <SafetyPage />
      </HealthProvider>,
    );
    await screen.findByRole('button', { name: 'Turn kill switch off' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn kill switch off' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    const post = mock.mock.calls.find((c) => (c[0] as string) === '/api/killswitch')!;
    expect(bodyOf(post)).toEqual({ on: false });
  });

  it('reads the live hold-back state and points the other levers at Configuration', async () => {
    stubFetch([
      {
        url: '/api/health',
        body: {
          ...HEALTH,
          safety: { ...HEALTH.safety, breakerOpen: true, breakerReason: 'discord 429 storm' },
        },
      },
    ]);
    renderWithSession(
      <HealthProvider>
        <SafetyPage />
      </HealthProvider>,
    );
    expect(await screen.findByText('on — effects are rehearsed')).toBeTruthy();
    expect(screen.getByText('open')).toBeTruthy();
    expect(screen.getByText('discord 429 storm')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Configuration' })).toBeTruthy();
  });
});

describe('LoggingPage', () => {
  const ROUTES = {
    routes: [
      { eventKind: 'message_delete', channelId: '42', enabled: true, includeContent: false },
    ],
    excludedChannels: ['77'],
  };

  it('lists routes and posts the same body the old form did', async () => {
    const mock = stubFetch([
      { url: '/api/log-routes', body: ROUTES },
      { method: 'POST', url: '/api/log-routes', body: { ok: true } },
    ]);
    renderWithSession(<LoggingPage />);
    // Wait on table-only text: the Event kind select renders `message_delete`
    // before the routes load, so it cannot be the readiness signal.
    expect(await screen.findByText('redacted')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getAllByText('message_delete')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Event kind'), { target: { value: 'member_join' } });
    fireEvent.change(screen.getByLabelText('Channel ID'), { target: { value: '99' } });
    fireEvent.click(screen.getByLabelText('Include message content'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set route' }));
    });
    const post = mock.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(post[0] as string).toBe('/api/log-routes');
    // The form defaults to redacted (the privacy-favourable default); the
    // click opted this route into content.
    expect(bodyOf(post)).toEqual({
      eventKind: 'member_join',
      channelId: '99',
      includeContent: true,
    });
    expect(
      mock.mock.calls.filter(
        (c) => (c[0] as string) === '/api/log-routes' && c[1]?.method !== 'POST',
      ),
    ).toHaveLength(2);
  });

  it('toggles a route enabled state and lists exclusions with removal', async () => {
    const mock = stubFetch([
      { url: '/api/log-routes', body: ROUTES },
      { method: 'POST', url: '/api/log-routes/message_delete/enabled', body: { ok: true } },
      { method: 'DELETE', url: '/api/log-exclusions/77', body: { ok: true, removed: true } },
    ]);
    renderWithSession(<LoggingPage />);
    const disable = await screen.findByRole('button', { name: 'Disable' });
    await act(async () => {
      fireEvent.click(disable);
    });
    const toggle = mock.mock.calls.find((c) => (c[0] as string).includes('/enabled'))!;
    expect(bodyOf(toggle)).toEqual({ enabled: false });
    expect(screen.getByText('77')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    });
    expect(
      mock.mock.calls.some(
        (c) => (c[0] as string) === '/api/log-exclusions/77' && c[1]?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('shows an empty state that says what to do', async () => {
    stubFetch([{ url: '/api/log-routes', body: { routes: [], excludedChannels: [] } }]);
    renderWithSession(<LoggingPage />);
    expect(await screen.findByText(/No routes yet/)).toBeTruthy();
  });
});

describe('PanelsPage', () => {
  const PANELS = [
    {
      panelId: 'p1',
      kind: 'roles',
      component: 'select',
      behaviour: 'toggle',
      status: 'posted',
      messageId: 'm',
      optionCount: 3,
    },
  ];
  const DETAIL = {
    ...PANELS[0],
    channelId: 'c-1',
    maxRoles: 2,
    requiredRoleId: undefined,
    blockedRoleIds: [],
    adoptionPassState: 'passing',
    adoptionBlockedCount: 0,
    options: [{ optionId: 'o1', roleId: 'r1', emojiKey: undefined, label: 'Team A' }],
  };

  it('fetches /api/panels and renders each panel', async () => {
    stubFetch([{ url: '/api/panels', body: PANELS }]);
    renderWithSession(<PanelsPage />);
    expect(await screen.findByText('p1')).toBeTruthy();
    expect(screen.getByText('Dropdown · toggle')).toBeTruthy();
    expect(screen.getByText('posted')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('manage loads the detail; publish states its live-Discord scope first', async () => {
    const mock = stubFetch([
      { url: '/api/panels', body: PANELS },
      { url: '/api/panels/p1', body: DETAIL },
      {
        method: 'POST',
        url: '/api/panels/p1/publish',
        body: { action: 'edited', messageId: 'm', reactionsSeeded: 0, reactionsFailed: [] },
      },
    ]);
    renderWithSession(<PanelsPage />);
    await screen.findByText('p1');
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    expect(await screen.findByText('Team A')).toBeTruthy();
    expect(screen.getByText('c-1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Publish to Discord' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('members see the result immediately');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Publish to Discord' }));
    });
    expect(
      mock.mock.calls.some(
        (c) => (c[0] as string) === '/api/panels/p1/publish' && c[1]?.method === 'POST',
      ),
    ).toBe(true);
  });

  it('reconcile only enqueues a job', async () => {
    const mock = stubFetch([
      { url: '/api/panels', body: PANELS },
      { url: '/api/panels/p1', body: DETAIL },
      {
        method: 'POST',
        url: '/api/panels/p1/reconcile',
        body: { enqueued: true, jobId: 5 },
      },
    ]);
    renderWithSession(<PanelsPage />);
    await screen.findByText('p1');
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    await screen.findByText('Team A');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enqueue reconcile' }));
    });
    const post = mock.mock.calls.find((c) => (c[0] as string) === '/api/panels/p1/reconcile')!;
    expect(bodyOf(post)).toEqual({});
  });
});

describe('AuditPage', () => {
  const ROW = {
    auditId: 1,
    at: 0,
    actorType: 'cli',
    actorId: null,
    actorUnixUserClaimed: 'bryan',
    via: 'ssh',
    action: 'killswitch.on',
    subjectType: 'guild',
    subjectId: '123',
    dryRun: false,
  };

  it('fetches /api/audit?limit=50 and formats actor, via and subject', async () => {
    const mock = stubFetch([{ url: '/api/audit?limit=50', body: [ROW] }]);
    renderWithSession(<AuditPage />);
    expect(await screen.findByText('cli (bryan, claimed)')).toBeTruthy();
    expect(screen.getByText('ssh')).toBeTruthy();
    expect(screen.getByText('guild:123')).toBeTruthy();
    expect(mock.mock.calls.map((c) => c[0] as string)).toEqual(['/api/audit?limit=50']);
  });

  it('a dry-run row carries the hold badge', async () => {
    stubFetch([{ url: '/api/audit?limit=50', body: [{ ...ROW, dryRun: true }] }]);
    renderWithSession(<AuditPage />);
    expect(await screen.findByText('dry run')).toBeTruthy();
  });

  it('applies limit and a since duration; an invalid since blocks the fetch', async () => {
    const mock = stubFetch([{ url: '/api/audit?limit=50', body: [ROW] }]);
    renderWithSession(<AuditPage />);
    await screen.findByText('killswitch.on');
    fireEvent.change(screen.getByLabelText('Since'), { target: { value: 'fortnight' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(mock.mock.calls).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Rows'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Since'), { target: { value: '2h' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });
    const second = mock.mock.calls[1]![0] as string;
    expect(second.startsWith('/api/audit?limit=100&sinceMs=')).toBe(true);
  });

  it('renders the error state naming the request when the API fails', async () => {
    stubFetch([{ url: '/api/audit?limit=50', status: 500, body: { error: 'boom' } }]);
    renderWithSession(<AuditPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the audit log');
  });
});
