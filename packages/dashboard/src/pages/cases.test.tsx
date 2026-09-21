// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { HealthProvider } from '../app/health.js';
import { renderWithSession, stubFetch } from '../test-support.js';
import { CasePage, type ModCaseDetail } from './case.js';
import { CASES_DEGRADED, CasesPage, type ModCase } from './cases.js';
import { MemberPage } from './member.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '555555555555555555';

function modCase(overrides: Partial<ModCase> = {}): ModCase {
  return {
    caseId: CASE_ID,
    memberId: MEMBER_ID,
    openedAt: 1_700_000_000_000,
    violationCount: 2,
    escalationTier: 1,
    status: 'open',
    ...overrides,
  };
}

const HEALTH_CONNECTED = {
  guildId: '1540816150026518620',
  guildName: 'Bananasaurs dev',
  gateway: { connected: true, pingMs: 42, guildCount: 1 },
  safety: { killswitch: false, dryRun: false, breakerOpen: false },
  jobCounts: {},
  oldestDueJobAtMs: undefined,
};

const healthDisconnected = () => ({
  ...HEALTH_CONNECTED,
  gateway: { connected: false, pingMs: undefined, guildCount: 1 },
});

function renderCasesPage() {
  renderWithSession(
    <HealthProvider>
      <CasesPage />
    </HealthProvider>,
  );
}

function renderCasePage() {
  const { hook } = memoryLocation({ path: `/cases/${CASE_ID}` });
  renderWithSession(
    <Router hook={hook}>
      <Route path="/cases/:caseId" component={CasePage} />
    </Router>,
  );
}

function renderMemberPage() {
  const { hook } = memoryLocation({ path: `/members/${MEMBER_ID}` });
  renderWithSession(
    <Router hook={hook}>
      <Route path="/members/:memberId" component={MemberPage} />
    </Router>,
  );
}

describe('CasesPage', () => {
  it('renders rows from GET /api/mod/cases?limit=50 with links to the case and the member', async () => {
    const mock = stubFetch([
      { url: '/api/health', body: HEALTH_CONNECTED },
      {
        url: '/api/mod/cases?limit=50',
        body: {
          cases: [
            modCase(),
            modCase({
              caseId: '22222222-2222-4222-8222-222222222222',
              memberId: '666666666666666666',
              status: 'closed',
            }),
          ],
        },
      },
    ]);
    renderCasesPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Cases' })).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Moderation cases' });
    const caseLink = within(table).getByRole('link', { name: CASE_ID });
    expect(caseLink.getAttribute('href')).toBe(`/cases/${CASE_ID}`);
    const memberLink = within(table).getByRole('link', { name: MEMBER_ID });
    expect(memberLink.getAttribute('href')).toBe(`/members/${MEMBER_ID}`);
    expect(within(table).getByText('open')).toBeTruthy();
    expect(within(table).getByText('closed')).toBeTruthy();
    expect(mock.mock.calls.map((c) => c[0] as string)).toContain('/api/mod/cases?limit=50');
  });

  it('shows the empty state when there are no cases', async () => {
    stubFetch([
      { url: '/api/health', body: HEALTH_CONNECTED },
      { url: '/api/mod/cases?limit=50', body: { cases: [] } },
    ]);
    renderCasesPage();
    expect(await screen.findByRole('region', { name: 'No moderation cases' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the degraded line only when the gateway is disconnected', async () => {
    stubFetch([
      { url: '/api/health', body: healthDisconnected() },
      { url: '/api/mod/cases?limit=50', body: { cases: [modCase()] } },
    ]);
    renderCasesPage();
    await screen.findByRole('table', { name: 'Moderation cases' });
    expect(screen.getByText(CASES_DEGRADED)).toBeTruthy();
    cleanup();

    stubFetch([
      { url: '/api/health', body: HEALTH_CONNECTED },
      { url: '/api/mod/cases?limit=50', body: { cases: [modCase()] } },
    ]);
    renderCasesPage();
    await screen.findByRole('table', { name: 'Moderation cases' });
    expect(screen.queryByText(CASES_DEGRADED)).toBeNull();
  });
});

describe('CasePage', () => {
  const detail = (): ModCaseDetail => ({
    case: modCase(),
    events: [
      {
        eventId: 'event-new',
        caseId: CASE_ID,
        ruleId: 'kw-two',
        memberId: MEMBER_ID,
        at: 1_700_000_001_000,
        matchedCategory: 'other',
        matchedSnippet: 'newer text',
        actionTaken: 'deleted',
        escalationAction: 'timeout',
        refusalReason: undefined,
        actorId: 'mod-1',
        trace: '{"step":"second"}',
      },
      {
        eventId: 'event-old',
        caseId: CASE_ID,
        ruleId: 'kw-one',
        memberId: MEMBER_ID,
        at: 1_700_000_000_000,
        matchedCategory: 'slur',
        matchedSnippet: 'older text',
        actionTaken: 'would_delete',
        escalationAction: undefined,
        refusalReason: 'dry-run',
        actorId: undefined,
        trace: '{"step":"first"}',
      },
    ],
  });

  it('renders the case and its events oldest first with a trace details per event', async () => {
    stubFetch([{ url: `/api/mod/cases/${CASE_ID}`, body: detail() }]);
    renderCasePage();
    expect(await screen.findByRole('heading', { level: 1, name: CASE_ID })).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Case events' });
    const text = table.textContent ?? '';
    // Oldest first: the older snippet precedes the newer one.
    expect(text.indexOf('older text')).toBeLessThan(text.indexOf('newer text'));
    expect(within(table).getByText('kw-one')).toBeTruthy();
    expect(within(table).getByText('slur')).toBeTruthy();
    expect(within(table).getByText('older text')).toBeTruthy();
    expect(within(table).getByText('would_delete')).toBeTruthy();
    expect(within(table).getByText('dry-run')).toBeTruthy();
    // The snippet cell is plain text, not a code element.
    expect(table.querySelector('code')).toBeNull();
    const traces = table.querySelectorAll('details');
    expect(traces).toHaveLength(2);
    expect(traces[0]?.querySelector('summary')?.textContent).toBe('Trace');
    expect(traces[0]?.textContent).toContain('{"step":"first"}');
  });
});

describe('MemberPage', () => {
  it('calls GET /api/mod/members/:memberId/cases and omits the Member column', async () => {
    const mock = stubFetch([
      { url: `/api/mod/members/${MEMBER_ID}/cases`, body: { cases: [modCase()] } },
    ]);
    renderMemberPage();
    expect(await screen.findByRole('heading', { level: 1, name: MEMBER_ID })).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Member cases' });
    const caseLink = within(table).getByRole('link', { name: CASE_ID });
    expect(caseLink.getAttribute('href')).toBe(`/cases/${CASE_ID}`);
    expect(within(table).queryByText('Member')).toBeNull();
    expect(mock.mock.calls.map((c) => c[0] as string)).toContain(
      `/api/mod/members/${MEMBER_ID}/cases`,
    );
  });
});
