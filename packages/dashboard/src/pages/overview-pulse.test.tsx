// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthInfo } from '../app/health.js';
import { renderWithSession, stubFetch } from '../test-support.js';
import { OperatorPulse } from './overview-pulse.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const HEALTH: HealthInfo = {
  guildId: '1540816150026518620',
  guildName: 'Bananasaurs Club',
  gateway: { connected: true, pingMs: 42, guildCount: 1 },
  safety: { killswitch: false, dryRun: true, breakerOpen: false },
  jobCounts: { queued: 4 },
  oldestDueJobAtMs: undefined,
};

const OK_SOURCES = [
  { url: '/api/providers/eligibility', body: { warnings: [] } },
  {
    url: '/api/automod/review',
    body: { matches: [], nativeHits: [], nativeBlocked: 0, verdicts: {} },
  },
  { url: '/api/jobs?failedOnly=true&limit=100', body: [] },
  {
    url: '/api/backups',
    body: {
      backups: [
        {
          fileName: 'bananasaurs-2026-09-20T03-00.db.gz',
          sizeBytes: 4_288_000,
          createdAtMs: Date.now(),
          hasChecksum: true,
        },
      ],
    },
  },
  { url: '/api/audit?limit=8', body: [] },
  { url: '/api/archive/status', body: { channels: [], index: { indexed: 0, rows: 0 } } },
  { url: '/api/mcp/clients', body: { clients: [] } },
  { url: '/api/mcp/sends?since=24h', body: { sends: [] } },
];

describe('OperatorPulse', () => {
  it('says nothing needs attention when every source is clear', async () => {
    stubFetch(OK_SOURCES);
    renderWithSession(<OperatorPulse health={HEALTH} />);
    expect(await screen.findByText('Nothing needs attention right now.')).toBeTruthy();
  });

  it('surfaces a disconnected gateway, failed jobs, review backlog and provider warnings', async () => {
    stubFetch([
      {
        url: '/api/providers/eligibility',
        body: {
          warnings: [{ provider: 'openai', reason: 'stale', trainsOnInput: 'yes', reviewedAt: 1 }],
        },
      },
      {
        url: '/api/automod/review',
        body: {
          matches: [
            {
              eventId: 'e1',
              ruleId: 'r1',
              memberId: 'm1',
              at: 1,
              matchedCategory: 'links',
              matchedSnippet: 'x',
              actionTaken: 'none',
              trace: undefined,
            },
          ],
          nativeHits: [],
          nativeBlocked: 2,
          verdicts: {},
        },
      },
      {
        url: '/api/jobs?failedOnly=true&limit=100',
        body: [
          {
            jobId: 7,
            kind: 'send',
            state: 'failed',
            attempts: 3,
            maxAttempts: 3,
            runAfter: 1,
            lastError: 'boom',
            dedupeKey: 'k',
          },
        ],
      },
      { url: '/api/backups', body: { backups: [] } },
      { url: '/api/audit?limit=8', body: [] },
      { url: '/api/archive/status', body: { channels: [], index: { indexed: 0, rows: 0 } } },
      { url: '/api/mcp/clients', body: { clients: [] } },
      { url: '/api/mcp/sends?since=24h', body: { sends: [] } },
    ]);
    renderWithSession(
      <OperatorPulse
        health={{ ...HEALTH, gateway: { connected: false, pingMs: undefined, guildCount: 1 } }}
      />,
    );
    expect(await screen.findByText(/connection to Discord is down/)).toBeTruthy();
    expect(screen.getByText('1 failed job waiting for a retry or a decision.')).toBeTruthy();
    expect(screen.getByText('3 moderation matches need a verdict.')).toBeTruthy();
    expect(screen.getByText('Provider openai review is stale.')).toBeTruthy();
    expect(screen.getByText('No backups exist yet.')).toBeTruthy();
  });

  it('renders the audit tail with actor and via attribution', async () => {
    stubFetch([
      ...OK_SOURCES.filter((s) => s.url !== '/api/audit?limit=8'),
      {
        url: '/api/audit?limit=8',
        body: [
          {
            auditId: 3,
            at: Date.now(),
            actorType: 'account',
            actorId: 'bryan',
            via: 'http',
            action: 'account.capability.granted',
            subjectType: 'account',
          },
        ],
      },
    ]);
    renderWithSession(<OperatorPulse health={HEALTH} />);
    expect(await screen.findByText('account.capability.granted')).toBeTruthy();
    expect(screen.getByText('bryan via dashboard')).toBeTruthy();
    expect(screen.getByText('Full audit log →')).toBeTruthy();
  });

  it('summarises archive and connector activity with honest empty states', async () => {
    stubFetch([
      ...OK_SOURCES.filter(
        (s) =>
          !['/api/archive/status', '/api/mcp/clients', '/api/mcp/sends?since=24h'].includes(s.url),
      ),
      {
        url: '/api/archive/status',
        body: {
          channels: [
            {
              channelId: '333333333333333333',
              attachmentPolicy: 'bytes',
              enabledAt: 1,
              cursorMessageId: '9',
              backfillState: 'running',
              messageCount: 1200,
            },
          ],
          index: { indexed: 1100, rows: 1200 },
        },
      },
      {
        url: '/api/mcp/clients',
        body: {
          clients: [
            {
              clientId: 'c1',
              clientName: 'Claude',
              registrationSource: 'dynamic',
              createdAt: 1,
              redirectUriCount: 1,
            },
          ],
        },
      },
      {
        url: '/api/mcp/sends?since=24h',
        body: {
          sends: [
            { channelId: '1', messageId: '2', tokenId: 't1', sentAt: Date.now(), outcome: 'sent' },
            {
              channelId: '1',
              messageId: null,
              tokenId: 't1',
              sentAt: Date.now(),
              outcome: 'dry_run',
            },
          ],
        },
      },
    ]);
    renderWithSession(<OperatorPulse health={HEALTH} />);
    expect(await screen.findByText(/messages kept\./)).toBeTruthy();
    expect(screen.getByText('1,200')).toBeTruthy();
    expect(screen.getByText(/1,100 of 1,200 rows indexed\./)).toBeTruthy();
    expect(screen.getByText(/1 backfill in progress/)).toBeTruthy();
    expect(screen.getByText(/registered client/)).toBeTruthy();
    expect(screen.getByText('— Claude')).toBeTruthy();
    expect(
      screen.getByText('Sends in the last 24 hours: 1 sent, 1 rehearsed (dry run).'),
    ).toBeTruthy();
  });

  it('keeps the other cards when one source fails', async () => {
    stubFetch([
      ...OK_SOURCES.filter((s) => s.url !== '/api/providers/eligibility'),
      { url: '/api/providers/eligibility', status: 500, body: { error: 'boom' } },
    ]);
    renderWithSession(<OperatorPulse health={HEALTH} />);
    expect(await screen.findByText(/Could not check provider eligibility: boom/)).toBeTruthy();
    expect(screen.getByText('Nothing has been audited yet.')).toBeTruthy();
  });

  it('(7c) a denied or failed check is never read as clear', async () => {
    stubFetch([
      ...OK_SOURCES.filter((s) => s.url !== '/api/jobs?failedOnly=true&limit=100'),
      { url: '/api/jobs?failedOnly=true&limit=100', status: 403, body: { error: 'forbidden' } },
    ]);
    renderWithSession(<OperatorPulse health={HEALTH} />);
    expect(await screen.findByText(/You do not have permission to check failed jobs/)).toBeTruthy();
    expect(screen.queryByText('Nothing needs attention right now.')).toBeNull();
    expect(screen.queryByText('clear')).toBeNull();
    expect(screen.getByText(/Some checks could not run/)).toBeTruthy();
    cleanup();
    stubFetch([
      ...OK_SOURCES.filter((s) => s.url !== '/api/backups'),
      { url: '/api/backups', status: 500, body: { error: 'boom' } },
    ]);
    renderWithSession(<OperatorPulse health={HEALTH} />);
    expect(await screen.findByText(/Could not check the backups: boom/)).toBeTruthy();
    expect(screen.queryByText('Nothing needs attention right now.')).toBeNull();
  });

  it('(7c) recent activity shows relative time with the absolute time on hover; links use the kit', async () => {
    stubFetch([
      ...OK_SOURCES.filter((s) => s.url !== '/api/audit?limit=8'),
      {
        url: '/api/audit?limit=8',
        body: [
          {
            auditId: 3,
            at: Date.now() - 2 * 3_600_000,
            actorType: 'account',
            actorId: 'bryan',
            via: 'http',
            action: 'account.capability.granted',
            subjectType: 'account',
          },
        ],
      },
    ]);
    renderWithSession(<OperatorPulse health={HEALTH} />);
    const when = await screen.findByText('2 hours ago');
    expect(when.getAttribute('title')).toMatch(/\d/);
    expect(screen.getByText('Full audit log →').className).toContain('text-accent');
    expect(document.querySelector('.text-sm')).toBeNull();
  });
});
