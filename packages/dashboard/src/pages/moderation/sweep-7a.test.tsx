// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthProvider } from '../../app/health.js';
import { bodyOf, renderWithSession, stubFetch } from '../../test-support.js';
import { AutomodRulesPage } from '../automod-rules.js';
import { CasesPage, type ModCase } from '../cases.js';
import { MemberPage } from '../member.js';
import { MembersPage } from '../members.js';
import { SafetyPage } from '../safety.js';
import { Moment } from './moment.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
afterEach(() => vi.useRealTimers());

const HEALTH = {
  guildId: '1540816150026518620',
  guildName: 'Bananasaurs dev',
  gateway: { connected: true, pingMs: 42, guildCount: 1 },
  safety: { killswitch: false, dryRun: false, breakerOpen: false },
  jobCounts: {},
  oldestDueJobAtMs: undefined,
};

const aCase = (n: number, o: Partial<ModCase> = {}): ModCase => ({
  caseId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  memberId: '555555555555555555',
  openedAt: Date.now() - 3 * 3_600_000,
  violationCount: 1,
  escalationTier: 0,
  status: 'open',
  member: { username: 'bryan', displayName: 'Bryan' },
  ...o,
});

describe('Moment', () => {
  it('shows relative text with the absolute time on hover and in dateTime', () => {
    const at = Date.now() - 2 * 3_600_000;
    renderWithSession(<Moment at={at} />);
    const el = screen.getByText('2 hours ago');
    expect(el.tagName).toBe('TIME');
    expect(el.getAttribute('dateTime')).toBe(new Date(at).toISOString());
    const title = el.getAttribute('title') ?? '';
    expect(title).toBe(new Date(at).toLocaleString(undefined, { timeZoneName: 'short' }));
    // docs/28 §2.3: absolute time plus a zone (abbreviation like PDT/UTC or an offset like GMT+1).
    expect(title).toMatch(/\b(?:[A-Z]{2,5}|GMT[+-]\d{1,2}(?::\d{2})?|UTC[+-]\d{1,2})$/);
  });
});

describe('Cases filters', () => {
  const load = (cases: ModCase[]) =>
    stubFetch([
      { url: '/api/mod/cases?limit=50', body: { cases } },
      { url: '/api/health', body: HEALTH },
    ]);

  it('filters by status, shows a filtered empty with Clear filters, and never changes the request', async () => {
    const mock = load([aCase(1), aCase(2)]);
    renderWithSession(
      <HealthProvider>
        <CasesPage />
      </HealthProvider>,
    );
    await screen.findByRole('table', { name: 'Moderation cases' });
    expect(within(screen.getByRole('table')).getAllByText('3 hours ago')).toHaveLength(2);
    fireEvent.click(screen.getByRole('radio', { name: 'Closed' }));
    expect(screen.getByText('No cases match these filters')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('table', { name: 'Moderation cases' })).toBeTruthy();
    const urls = mock.mock.calls.map((c) => c[0] as string);
    expect(urls.filter((u) => u.startsWith('/api/mod/cases'))).toEqual(['/api/mod/cases?limit=50']);
  });
});

describe('Member history', () => {
  it('shows relative opened times', async () => {
    stubFetch([
      {
        url: '/api/mod/members/555555555555555555/cases',
        body: { cases: [aCase(1)] },
      },
    ]);
    const { hook } = (await import('wouter/memory-location')).memoryLocation({
      path: '/members/555555555555555555',
    });
    const { Router, Route } = await import('wouter');
    renderWithSession(
      <Router hook={hook}>
        <Route path="/members/:memberId" component={MemberPage} />
      </Router>,
    );
    expect(await screen.findByText('3 hours ago')).toBeTruthy();
  });
});

describe('Members filter', () => {
  it('filters the loaded page by name and says it only filters this page', async () => {
    stubFetch([
      {
        url: '/api/guild/members',
        body: {
          members: [
            {
              memberId: '1',
              username: 'ada',
              displayName: 'Ada',
              joinedAt: 1_700_000_000_000,
              roleIds: [],
            },
            { memberId: '2', username: 'bob', displayName: 'Bob', joinedAt: null, roleIds: [] },
          ],
        },
      },
    ]);
    renderWithSession(<MembersPage />);
    await screen.findByRole('table', { name: 'Guild members' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find on this page' }), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText('No members on this page match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Bob')).toBeTruthy();
  });
});

describe('Automod create form uses kit controls', () => {
  it('has no native select and posts the same body', async () => {
    const mock = stubFetch([
      {
        url: '/api/automod/state',
        body: { state: 'off', dryRun: false, killswitch: false, enabledRules: [] },
      },
      { url: '/api/automod/rules', body: { rules: [] } },
      { method: 'POST', url: '/api/automod/rules', body: { ok: true } },
    ]);
    const { container } = renderWithSession(<AutomodRulesPage />);
    await screen.findByText('No rules yet. Create one below.');
    expect(container.querySelector('select:not([aria-hidden="true"])')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Kind' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'No links' } });
    fireEvent.change(screen.getByLabelText('Configuration data'), {
      target: { value: '{"pattern":"x"}' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create rule' }));
    });
    const post = mock.mock.calls.find((c) => c[1]?.method === 'POST');
    expect(bodyOf(post!)).toMatchObject({
      ruleId: 'no-links',
      name: 'No links',
      config: { pattern: 'x' },
    });
  });
});

describe('Safety states', () => {
  it('says the state is unknown (not loading forever) when health fails, and offers retry', async () => {
    stubFetch([{ url: '/api/health', status: 500, body: { error: 'boom' } }]);
    renderWithSession(
      <HealthProvider>
        <SafetyPage />
      </HealthProvider>,
    );
    expect(await screen.findByText(/Couldn't load the health summary/)).toBeTruthy();
    expect(screen.getByText(/safety state is unknown/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('lets rows and actions wrap at 180 CSS px without clipping', async () => {
    stubFetch([{ url: '/api/health', body: HEALTH }]);
    const { container } = renderWithSession(
      <HealthProvider>
        <SafetyPage />
      </HealthProvider>,
    );
    await screen.findByText('Kill switch', { selector: 'dt' });
    const dl = container.querySelector('dl')!;
    expect(dl.className).toContain('grid-cols-1');
    expect(dl.className).toContain('sm:grid-cols-[10rem_1fr]');
    const actions = screen.getByRole('button', { name: 'Turn kill switch on' }).parentElement!;
    expect(actions.className).toContain('flex-wrap');
    expect(dl.innerHTML).not.toMatch(/overflow-hidden/);
    expect(actions.className).not.toMatch(/overflow-hidden/);
  });
});
