// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as SystemBannerModule from './SystemBanner.js';
import { Router } from 'wouter';
import { StrictMode } from 'react';
import { SessionProvider } from './session.js';
import { memoryLocation } from 'wouter/memory-location';
import userEvent from '@testing-library/user-event';
import type * as NotFoundModule0 from '../pages/not-found.js';
import { Tooltip } from '../ui/Tooltip.js';
import { bodyOf, renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import type { SessionInfo } from '../api.js';
import { NAV, pageTitle, visibleNav } from './routes.js';
import { Shell } from './Shell.js';
import { ThemeProvider } from './theme.js';
import css from '../styles.css?raw';

const HEALTH = {
  guildId: '1540816150026518620',
  guildName: 'Bananasaurs dev',
  gateway: { connected: true, pingMs: 42, guildCount: 1 },
  safety: { killswitch: false, dryRun: false, breakerOpen: false },
  jobCounts: {},
  oldestDueJobAtMs: undefined,
};

// --- group caption contrast (P4 Task 1 fix R1) ---------------------------
// Reads the real stylesheet tokens for the colour class the real group heading
// carries, against the canvas the heading sits on (docs/28 section 7.9: normal
// text 4.5:1 in both themes). The generic theme test only checks faint-on-panel
// at 3:1, so it cannot see this.
const cssBlock = (header: RegExp): Record<string, string> => {
  const start = css.search(header);
  if (start < 0) throw new Error(`no css block ${header}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < css.length; end++) {
    if (css[end] === '{') depth++;
    if (css[end] === '}' && --depth === 0) break;
  }
  const out: Record<string, string> = {};
  for (const m of css.slice(open + 1, end).matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi))
    out[m[1]!] = m[2]!.toLowerCase();
  return out;
};
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
};
const contrastRatio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
function expectCaptionsReadable(headings: HTMLElement[], canvasClass: HTMLElement) {
  expect(headings.length).toBe(5);
  expect(canvasClass.className).toContain('bg-canvas');
  const themes = [
    cssBlock(/@theme\s*\{/),
    cssBlock(/:root:not\(\[data-theme\]\)\s*\{/),
    cssBlock(/:root\[data-theme='dark'\]\s*\{/),
  ];
  for (const h of headings) {
    const token = /(?:^|\s)text-(ink(?:-[a-z]+)?)(?:\s|$)/.exec(h.className)?.[1];
    expect(token, `${h.textContent} has no ink colour class`).toBeTruthy();
    for (const t of themes) {
      expect(t[token!], `${token} defined`).toBeTruthy();
      expect(contrastRatio(t[token!]!, t.canvas!)).toBeGreaterThanOrEqual(4.5);
    }
  }
}

let lastNavigate: (to: string) => void = () => undefined;

function renderAt(
  path: string,
  session: SessionInfo = TEST_SESSION,
  health: Record<string, unknown> = HEALTH,
) {
  const mock = stubFetch([
    { url: '/api/health', body: health },
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
    { url: '/api/assistant/model-health?window=24h', body: { window: '24h', models: [] } },
  ]);
  const { hook, navigate } = memoryLocation({ path });
  lastNavigate = navigate;
  renderWithSession(
    <ThemeProvider>
      <Router hook={hook}>
        <Shell />
      </Router>
    </ThemeProvider>,
    { session },
  );
  return mock;
}

// Task 10 (Review Focus 2): the Members page throws during render so the
// crash-boundary tests can watch a real route fail inside the full shell.
vi.mock('../pages/members.js', () => ({
  MembersPage: () => {
    throw new TypeError('members exploded');
  },
}));

// Task 10 fix: a flag lets one test make a shell-level component (outside the
// page boundary) throw, to prove the app boundary around the whole shell.
const shellCrash = vi.hoisted(() => ({ on: false }));
vi.mock('./SystemBanner.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown> & typeof SystemBannerModule>();
  return {
    ...actual,
    SystemBanner: () => {
      if (shellCrash.on) throw new TypeError('banner exploded');
      return <actual.SystemBanner />;
    },
  };
});

afterEach(cleanup);
afterEach(() => {
  shellCrash.on = false;
});
afterEach(() => vi.unstubAllGlobals());
afterEach(() => vi.restoreAllMocks());

type NotFoundModule = typeof NotFoundModule0;

vi.mock('../pages/not-found.js', async (importOriginal) => {
  const actual = await importOriginal<NotFoundModule>();
  return {
    ...actual,
    NotFoundPage: () => (
      <>
        <actual.NotFoundPage />
        <input aria-label="Autofocus repro" autoFocus />
        <Tooltip content="Page hint">
          <button type="button">Hint trigger</button>
        </Tooltip>
      </>
    ),
  };
});

describe('Shell', () => {
  // The page's own h1 keeps its current wording until the P5 page sweep; the
  // rail label is what P4 Task 1 renames.
  it.each([
    ['/', 'Overview', 'Overview'],
    ['/safety', 'Safety', 'Safety'],
    ['/logging', 'Logging', 'Logging'],
    ['/panels', 'Role panels', 'Role panels'],
    ['/audit', 'Audit', 'Audit log'],
    ['/automod', 'Automod', 'Automod'],
    ['/review', 'Review', 'Review queue'],
    ['/cases', 'Cases', 'Cases'],
  ])(
    'renders the %s page titled %s and marks its rail entry current',
    async (path, title, railLabel) => {
      renderAt(path);
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy();
      const link = screen.getByRole('link', { name: railLabel, current: 'page' });
      expect(link.getAttribute('href')).toBe(path);
      // P4 Task 1: the current entry reads as the accent row, with a
      // decorative icon before the label.
      expect(link.className).toContain('bg-accent-bg');
      expect(link.className).toContain('text-accent');
      expect(link.className).toContain('font-medium');
      expect(link.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    },
  );

  it('renders the not-found page for an unknown path, with nothing current', async () => {
    renderAt('/nope');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeTruthy();
    expect(screen.queryByRole('link', { current: 'page' })).toBeNull();
  });

  it('rail group captions meet AA normal-text contrast on the canvas in both themes', async () => {
    renderAt('/');
    const nav = screen.getByRole('navigation', { name: 'Areas' });
    const headings = within(nav).getAllByRole('heading', { level: 2 });
    expectCaptionsReadable(headings, nav.closest('aside') as HTMLElement);
  });

  it('the rail groups every visible NAV entry and names the guild', async () => {
    renderAt('/');
    const nav = screen.getByRole('navigation', { name: 'Areas' });
    const labels = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent);
    // Rendered order follows the P4 Task 1 rail groups, not the NAV array:
    // every entry appears exactly once, in group order. The default test
    // session is not the instance owner, so the owner-only AI tuning entry
    // is hidden here (see the owner test below).
    const groupOrder = ['Club', 'Moderation', 'Assistant', 'Messages', 'System'];
    const expected = groupOrder.flatMap((group) =>
      visibleNav(false)
        .filter((n) => n.group === group)
        .map((n) => n.label),
    );
    expect(labels).toEqual(expected);
    expect(within(nav).getByRole('heading', { name: 'Club' })).toBeTruthy();
    expect(within(nav).getByRole('heading', { name: 'Moderation' })).toBeTruthy();
    expect(within(nav).getByRole('heading', { name: 'Assistant' })).toBeTruthy();
    expect(within(nav).getByRole('heading', { name: 'Messages' })).toBeTruthy();
    expect(within(nav).getByRole('heading', { name: 'System' })).toBeTruthy();
    // Every rail link carries its decorative icon before the label.
    for (const link of Array.from(nav.querySelectorAll('a'))) {
      expect(link.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    }
    const aside = screen.getByRole('complementary');
    expect(await within(aside).findByText('Bananasaurs dev')).toBeTruthy();
  });

  it('names the active server and health freshness in the desktop header', async () => {
    renderAt('/');
    expect(await screen.findByText('Updated', { exact: false })).toBeTruthy();
    expect(screen.getAllByText('Bananasaurs dev')).toHaveLength(3);
    expect(screen.getAllByText('Active server')).toHaveLength(2);
    // The static "Safety mode" link claimed changes were never applied even
    // when the bot was live; the real state is the system banner's job now.
    expect(screen.queryByText('Safety mode: changes are logged, not applied')).toBeNull();
  });

  it('says the real safety state in the system banner, under the header and above main', async () => {
    renderAt('/', TEST_SESSION, {
      ...HEALTH,
      safety: { killswitch: false, dryRun: true, breakerOpen: false },
    });
    const banner = await screen.findByRole('region', { name: 'System status' });
    expect(banner.textContent).toContain('Preview mode is on. Discord changes are logged');
    const header = banner.previousElementSibling;
    const main = screen.getByRole('main');
    expect(header?.textContent).toContain('Active server');
    expect(
      (header as HTMLElement).compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(banner.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(main.contains(banner)).toBe(false);
  });

  it('shows no system banner when nothing is held, and no old strip or model banner', async () => {
    renderAt('/');
    await screen.findByText('Updated', { exact: false });
    expect(screen.queryByRole('region', { name: 'System status' })).toBeNull();
    expect(screen.queryByTestId('state-strip')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Active holds' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Model health warning' })).toBeNull();
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
      { url: '/api/assistant/model-health?window=24h', body: { window: '24h', models: [] } },
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
  });

  // Task 19: Conversations is built — setup-first order, History moved in.
  // Task 8 (errors-config-ratelimits): AI tuning follows AI setup, owner only.
  // P4 Task 1: Schedules moved to Club; the stub status field is gone.
  it('orders the Assistant group setup-first, with Conversations built', () => {
    const assistantNav = NAV.filter((entry) => entry.group === 'Assistant');
    expect(assistantNav.map((entry) => [entry.path, entry.label])).toEqual([
      ['/assistant/setup', 'AI setup'],
      ['/assistant/tuning', 'AI tuning'],
      ['/assistant', 'Behaviours'],
      ['/assistant/conversations', 'Conversations'],
      ['/assistant/history', 'History'],
      ['/assistant/skills', 'Skills'],
      ['/assistant/resources', 'Resources'],
      ['/memory', 'Memory'],
    ]);
    expect(NAV.some((entry) => entry.path === '/providers')).toBe(false);
    expect(
      NAV.some((entry) => entry.path === '/assistant/history' && entry.group === 'System'),
    ).toBe(false);
    expect(
      NAV.some((entry) => entry.path === '/assistant/schedules' && entry.group === 'Club'),
    ).toBe(true);
  });

  it('renders the built Conversations page with its purpose sentence', async () => {
    renderAt('/assistant/conversations');
    expect(await screen.findByRole('heading', { level: 1, name: 'Conversations' })).toBeTruthy();
    expect(
      screen.getByText('Every conversation members have had with the assistant, newest first.'),
    ).toBeTruthy();
  });

  it('marks nothing as future, now that Task 19 built Conversations', async () => {
    renderAt('/');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(screen.queryByText('Future')).toBeNull();
  });

  it('hides AI tuning from anyone but the instance owner', async () => {
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Areas' });
    expect(within(nav).queryByRole('link', { name: 'AI tuning' })).toBeNull();
    cleanup();
    renderAt('/', { ...TEST_SESSION, instanceOwner: true });
    const ownerNav = await screen.findByRole('navigation', { name: 'Areas' });
    const link = within(ownerNav).getByRole('link', { name: 'AI tuning' });
    expect(link.getAttribute('href')).toBe('/assistant/tuning');
  });

  it('shows Tasks, and only Tasks, to a non-owner who can manage tasks (ADR 0130)', async () => {
    renderAt('/', { ...TEST_SESSION, canManageTasks: true });
    const nav = await screen.findByRole('navigation', { name: 'Areas' });
    expect(within(nav).getByRole('link', { name: 'Tasks' }).getAttribute('href')).toBe('/tasks');
    expect(within(nav).queryByRole('link', { name: 'AI tuning' })).toBeNull();
    expect(
      visibleNav(false, true)
        .filter((n) => n.ownerOnly === true)
        .map((n) => n.label),
    ).toEqual(['Tasks']);
    expect(visibleNav(false).some((n) => n.label === 'Tasks')).toBe(false);
  });

  it.each([
    ['/tasks/abc', 'Tasks'],
    ['/automod/rule-1', 'Automod'],
    ['/assistant/history/trace-1', 'History'],
  ])('marks the parent of the %s detail route current in the rail', async (path, label) => {
    // The detail page itself is not stubbed (404 -> its Unavailable state);
    // the rail assertion is what matters here.
    renderAt(path, { ...TEST_SESSION, instanceOwner: true });
    const link = await screen.findByRole('link', { name: label, current: 'page' });
    expect(link.className).toContain('bg-accent-bg');
    expect(link.className).toContain('text-accent');
  });

  it('does not mark Behaviours current on a History detail route', async () => {
    renderAt('/assistant/history/trace-1', { ...TEST_SESSION, instanceOwner: true });
    await screen.findByRole('link', { name: 'History', current: 'page' });
    expect(screen.queryByRole('link', { name: 'Behaviours', current: 'page' })).toBeNull();
  });

  it('a crashing page leaves the rail working, and navigating away clears the crash (Task 10)', async () => {
    // React logs every boundary-caught error to console.error; silence it.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderAt('/members');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This page hit a problem');
    expect(alert.textContent).toContain('TypeError');
    // The rail survives: the crash is contained inside <main>.
    const nav = screen.getByRole('navigation', { name: 'Areas' });
    expect(nav).toBeTruthy();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('alert')).toBeTruthy();
    // Picking another page from the menu clears the crash and renders it.
    fireEvent.click(within(nav).getByRole('link', { name: 'Overview' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    // The crash panel is gone; other pages keep their own error notices.
    expect(screen.queryByText('This page hit a problem')).toBeNull();
  });

  it('a crash in the shell itself shows the app boundary: reload guidance and no menu (Task 10)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    shellCrash.on = true;
    renderAt('/');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This page hit a problem');
    expect(alert.textContent).toContain('Reload the page to continue.');
    expect(alert.textContent).not.toContain('pick another page from the menu');
    expect(screen.queryByRole('navigation', { name: 'Areas' })).toBeNull();
    expect(screen.queryByRole('main')).toBeNull();
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

describe('pageTitle', () => {
  it('returns the label of the longest matching NAV path on a slash boundary', () => {
    expect(pageTitle('/tasks/abc')).toBe('Tasks');
    expect(pageTitle('/assistant/history/x')).toBe('History');
    expect(pageTitle('/assistant')).toBe('Behaviours');
    expect(pageTitle('/nope')).toBeUndefined();
    expect(pageTitle('/')).toBe('Overview');
  });

  it('never matches a bare prefix or an unknown root', () => {
    expect(pageTitle('/tasksXYZ')).toBeUndefined();
    expect(pageTitle('/archivex')).toBeUndefined();
  });
});

describe('Shell accessibility', () => {
  it('offers a skip link as the first focusable element and moves focus to main', async () => {
    renderAt('/');
    const user = userEvent.setup();
    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(document.activeElement).toBe(skip);
    await user.keyboard('{Enter}');
    const main = document.querySelector('main#main');
    expect(main).toBeTruthy();
    expect(document.activeElement).toBe(main);
  });

  it('makes main programmatically focusable', () => {
    renderAt('/');
    expect(document.querySelector('main')?.getAttribute('id')).toBe('main');
    expect(document.querySelector('main')?.getAttribute('tabindex')).toBe('-1');
  });

  it('sets the tab title and focuses main on navigation, but not on first render', async () => {
    renderAt('/');
    expect(document.title).toBe('Overview \u00b7 Bananasaurs');
    expect(document.activeElement).not.toBe(document.querySelector('main'));
    await act(async () => {
      lastNavigate('/tasks');
    });
    expect(document.title).toBe('Tasks \u00b7 Bananasaurs');
    expect(document.activeElement).toBe(document.querySelector('main'));
  });

  it('titles an unknown path just Bananasaurs', () => {
    renderAt('/nope');
    expect(document.title).toBe('Bananasaurs');
  });

  it('wraps the shell in a TooltipProvider', async () => {
    renderAt('/nope');
    expect(await screen.findByRole('button', { name: 'Hint trigger' })).toBeTruthy();
  });
});

describe('Independent review root StrictMode probe', () => {
  it('preserves page autofocus on first root StrictMode mount', () => {
    const { hook } = memoryLocation({ path: '/nope' });
    stubFetch([
      { url: '/api/health', body: HEALTH },
      { url: '/api/assistant/model-health?window=24h', body: { window: '24h', models: [] } },
    ]);
    render(
      <StrictMode>
        <SessionProvider session={TEST_SESSION} onLoggedOut={() => undefined}>
          <ThemeProvider>
            <Router hook={hook}>
              <Shell />
            </Router>
          </ThemeProvider>
        </SessionProvider>
      </StrictMode>,
    );
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Autofocus repro' }));
  });
});

describe('Shell accessibility under root StrictMode', () => {
  it('moves focus to main on real navigation, including back to an autofocused page', async () => {
    const { hook, navigate } = memoryLocation({ path: '/nope' });
    stubFetch([
      { url: '/api/health', body: HEALTH },
      { url: '/api/assistant/model-health?window=24h', body: { window: '24h', models: [] } },
    ]);
    render(
      <StrictMode>
        <SessionProvider session={TEST_SESSION} onLoggedOut={() => undefined}>
          <ThemeProvider>
            <Router hook={hook}>
              <Shell />
            </Router>
          </ThemeProvider>
        </SessionProvider>
      </StrictMode>,
    );
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Autofocus repro' }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'Safety' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Safety' })).toBeTruthy();
    expect(document.title).toBe('Safety \u00b7 Bananasaurs');
    expect(document.activeElement).toBe(screen.getByRole('main'));

    await act(async () => {
      navigate('/nope');
    });
    expect(screen.getByRole('textbox', { name: 'Autofocus repro' })).toBeTruthy();
    expect(document.title).toBe('Bananasaurs');
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
});

describe('Shell mobile reflow', () => {
  it('lets the sticky header grow into separate brand and bounded control rows', () => {
    renderAt('/panels');
    const header = document.querySelector('header');
    expect(header).toBeTruthy();
    // jsdom cannot measure layout. These constraints are the CSS contract;
    // native browser bounds/pixels verify the resulting layout separately.
    expect(header?.classList.contains('flex-col')).toBe(true);
    expect(header?.classList.contains('items-stretch')).toBe(true);
    expect(header?.classList.contains('h-16')).toBe(false);
    expect(header?.classList.contains('sticky')).toBe(true);
    const jump = within(header!).getByRole('button', {
      name: 'Open navigation - current page Role panels',
    });
    const controls = jump.parentElement!;
    expect(controls.classList.contains('grid')).toBe(true);
    expect(controls.classList.contains('grid-cols-[2.5rem_minmax(0,1fr)]')).toBe(true);
    expect(controls.classList.contains('[&>button:last-child]:min-w-0')).toBe(true);
    expect(controls.classList.contains('[&>button:last-child]:max-w-full')).toBe(true);
    expect(controls.classList.contains('[&>button:last-child>span]:whitespace-normal')).toBe(true);
    expect(controls.classList.contains('[&>button:last-child>span]:break-words')).toBe(true);
    expect(within(header!).getByText('Bananasaurs')).toBeTruthy();
    expect(within(header!).getByText('Operator console')).toBeTruthy();
    expect(header?.querySelector('img')?.getAttribute('src')).toBe('/brand/brand-mark.jpg');
  });

  it('keeps skip, theme and fully named navigation reachable in order', async () => {
    renderAt('/panels');
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Skip to content' }));
    await user.tab();
    const header = document.querySelector('header')!;
    const theme = within(header).getByRole('button', { name: /Switch to .* mode/ });
    expect(document.activeElement).toBe(theme);
    await user.keyboard('{Enter}');
    await user.tab();
    const jump = within(header).getByRole('button', {
      name: 'Open navigation - current page Role panels',
    });
    expect(document.activeElement).toBe(jump);
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Jump to' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(jump);
  });
});
