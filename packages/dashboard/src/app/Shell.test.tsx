// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { NOT_BUILT } from '../pages/stub.js';
import { NAV } from './routes.js';
import { Shell } from './Shell.js';
import { ThemeProvider } from './theme.js';

const HEALTH = {
  guildId: '1540816150026518620',
  guildName: 'Bananasaurs dev',
  gateway: { connected: true, pingMs: 42, guildCount: 1 },
  safety: { killswitch: false, dryRun: false, breakerOpen: false },
  jobCounts: {},
  oldestDueJobAtMs: undefined,
};

function renderAt(path: string) {
  const mock = stubFetch([
    { url: '/api/health', body: HEALTH },
    { url: '/api/log-routes', body: { routes: [] } },
    { url: '/api/panels', body: [] },
    { url: '/api/audit?limit=50', body: [] },
    { url: '/api/automod/rules', body: { rules: [] } },
    {
      url: '/api/automod/review?limit=50',
      body: { matches: [], nativeHits: [], nativeBlocked: 0, verdicts: {} },
    },
    { url: '/api/assistant/conversation-retention', body: { days: 182 } },
    {
      url: '/api/assistant/conversations?sort=last-activity&order=desc&limit=50',
      body: { conversations: [] },
    },
    { method: 'POST', url: '/api/logout', body: {} },
  ]);
  const { hook } = memoryLocation({ path });
  renderWithSession(
    <ThemeProvider>
      <Router hook={hook}>
        <Shell />
      </Router>
    </ThemeProvider>,
  );
  return mock;
}

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('Shell', () => {
  it.each([
    ['/', 'Overview'],
    ['/safety', 'Safety'],
    ['/logging', 'Logging'],
    ['/panels', 'Self-granted roles'],
    ['/audit', 'Audit'],
    ['/automod', 'Automod'],
    ['/review', 'Review'],
    ['/cases', 'Cases'],
    ['/cutover', 'Turn on moderation'],
  ])('renders the %s page titled %s and marks its rail entry current', async (path, title) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy();
    const link = screen.getByRole('link', { name: title, current: 'page' });
    expect(link.getAttribute('href')).toBe(path);
  });

  it('renders the not-found page for an unknown path, with nothing current', async () => {
    renderAt('/nope');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeTruthy();
    expect(screen.queryByRole('link', { current: 'page' })).toBeNull();
  });

  it('the rail groups every NAV entry and names the guild', async () => {
    renderAt('/');
    const nav = screen.getByRole('navigation', { name: 'Areas' });
    const labels = Array.from(nav.querySelectorAll('a')).map((a) =>
      a.textContent?.replace('Future', ''),
    );
    // Rendered order follows the rail groups (ADR 0051 D6), not the NAV
    // array: every entry appears exactly once, in group order.
    const groupOrder = ['Start here', 'Moderation', 'Messages', 'Assistant', 'Advanced / System'];
    const expected = groupOrder.flatMap((group) =>
      NAV.filter((n) => n.group === group).map((n) => n.label),
    );
    expect(labels).toEqual(expected);
    expect(within(nav).getByRole('heading', { name: 'Start here' })).toBeTruthy();
    expect(within(nav).getByRole('heading', { name: 'Moderation' })).toBeTruthy();
    expect(within(nav).getByRole('heading', { name: 'Advanced / System' })).toBeTruthy();
    expect(within(nav).getByRole('heading', { name: 'Assistant' })).toBeTruthy();
    const aside = screen.getByRole('complementary');
    expect(await within(aside).findByText('Bananasaurs dev')).toBeTruthy();
  });

  it('names the active server and health freshness in the desktop header', async () => {
    renderAt('/');
    expect(await screen.findByText('Updated', { exact: false })).toBeTruthy();
    expect(screen.getAllByText('Bananasaurs dev')).toHaveLength(3);
    expect(screen.getAllByText('Active server')).toHaveLength(2);
    expect(screen.getByText('Safety mode: changes are logged, not applied')).toBeTruthy();
  });

  it('Sign out posts /api/logout', async () => {
    const mock = renderAt('/');
    await screen.findByRole('button', { name: 'Sign out' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    });
    const call = mock.mock.calls.find((c) => (c[0] as string) === '/api/logout');
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).method).toBe('POST');
  });

  it('shows no guild switcher when the session names a single guild', async () => {
    renderAt('/');
    await screen.findByRole('button', { name: 'Sign out' });
    expect(screen.queryByLabelText('Server')).toBeNull();
  });

  it('the switcher lists exactly the reachable guilds and posts the chosen one', async () => {
    const CLUB = '999999999999999999';
    const mock = stubFetch([
      { url: '/api/health', body: HEALTH },
      { url: '/api/log-routes', body: { routes: [] } },
      { url: '/api/panels', body: [] },
      { url: '/api/audit?limit=50', body: [] },
      { url: '/api/automod/rules', body: { rules: [] } },
      {
        url: '/api/automod/review?limit=50',
        body: { matches: [], nativeHits: [], nativeBlocked: 0, verdicts: {} },
      },
      { method: 'POST', url: '/api/session/guild', body: { guildId: CLUB } },
    ]);
    const onLoggedOut = vi.fn();
    const { hook } = memoryLocation({ path: '/' });
    renderWithSession(
      <ThemeProvider>
        <Router hook={hook}>
          <Shell />
        </Router>
      </ThemeProvider>,
      {
        session: {
          ...TEST_SESSION,
          reachableGuilds: [
            { guildId: TEST_SESSION.guildId, name: 'Bananasaurs dev' },
            { guildId: CLUB, name: 'Club' },
          ],
        },
        onLoggedOut,
      },
    );
    const select = await screen.findByLabelText('Server');
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'Bananasaurs dev',
      'Club',
    ]);
    await act(async () => {
      fireEvent.change(select, { target: { value: CLUB } });
    });
    const call = mock.mock.calls.find((c) => (c[0] as string) === '/api/session/guild');
    expect(call).toBeTruthy();
    expect(bodyOf(call!)).toEqual({ guildId: CLUB });
    expect((call![1] as RequestInit).headers).toMatchObject({
      'x-bananasaurs-csrf': TEST_SESSION.csrfToken,
    });
    expect(onLoggedOut).toHaveBeenCalledTimes(1);
  });

  // ADR 0051 D7 supersedes S10-D3: Archive, Search and Providers are real pages now;
  // only the Release 3 four remain stubs. ADR 0060: /resources is the new
  // Resources page; /ai and /proposals stay aliases of Assistant. Task 9:
  // /providers and /assistant/activity are aliases of AI setup and History.
  it.each([
    ['/resources', 'Resources'],
    ['/assistant/skills', 'Skills'],
    ['/assistant/schedules', 'Schedules'],
    ['/assistant/resources', 'Resources'],
    ['/memory', 'Memory'],
    ['/ai', 'Behaviours'],
    ['/proposals', 'Behaviours'],
    ['/providers', 'AI setup'],
    ['/assistant/setup', 'AI setup'],
    ['/assistant/activity', 'History'],
    ['/assistant/history', 'History'],
    ['/assistant/conversations', 'Conversations'],
  ])('renders the built %s surface titled %s', async (path, title) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy();
    expect(screen.queryByText(NOT_BUILT)).toBeNull();
  });

  // Task 19: Conversations is built — setup-first order, History moved in.
  it('orders the Assistant group setup-first, with Conversations built', () => {
    const assistantNav = NAV.filter((entry) => entry.group === 'Assistant');
    expect(assistantNav.map((entry) => [entry.path, entry.label, entry.status])).toEqual([
      ['/assistant/setup', 'AI setup', 'built'],
      ['/assistant', 'Behaviours', 'built'],
      ['/assistant/conversations', 'Conversations', 'built'],
      ['/assistant/history', 'History', 'built'],
      ['/assistant/skills', 'Skills', 'built'],
      ['/assistant/resources', 'Resources', 'built'],
      ['/assistant/schedules', 'Schedules', 'built'],
      ['/memory', 'Memory', 'built'],
    ]);
    expect(NAV.some((entry) => entry.path === '/providers')).toBe(false);
    expect(
      NAV.some(
        (entry) => entry.path === '/assistant/history' && entry.group === 'Advanced / System',
      ),
    ).toBe(false);
  });

  it('renders the built Conversations page with its purpose sentence', async () => {
    renderAt('/assistant/conversations');
    expect(await screen.findByRole('heading', { level: 1, name: 'Conversations' })).toBeTruthy();
    expect(
      screen.getByText('Every conversation members have had with the assistant, newest first.'),
    ).toBeTruthy();
    expect(screen.queryByText(NOT_BUILT)).toBeNull();
  });

  it('marks nothing as future, now that Task 19 built Conversations', async () => {
    renderAt('/');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(screen.queryByText('Future')).toBeNull();
  });

  it('opens and closes the mobile jump navigation without changing the page', async () => {
    renderAt('/');
    const trigger = await screen.findByRole('button', {
      name: 'Open navigation - current page Overview',
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    const sheet = await screen.findByRole('dialog', { name: 'Jump to' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
  });
});
