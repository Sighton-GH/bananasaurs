// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
import { Shell } from './Shell.js';
import { ThemeProvider } from './theme.js';

const { Element: DomElement } = globalThis as unknown as {
  Element: {
    prototype: {
      hasPointerCapture?: (pointerId: number) => boolean;
      releasePointerCapture?: (pointerId: number) => void;
      scrollIntoView?: () => void;
    };
  };
};
if (!DomElement.prototype.hasPointerCapture) DomElement.prototype.hasPointerCapture = () => false;
if (!DomElement.prototype.releasePointerCapture)
  DomElement.prototype.releasePointerCapture = () => undefined;
if (!DomElement.prototype.scrollIntoView) DomElement.prototype.scrollIntoView = () => undefined;

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
afterEach(() => vi.restoreAllMocks());

const HEALTH = {
  guildId: '1540816150026518620',
  guildName: 'Bananasaurs dev',
  gateway: { connected: true, pingMs: 42, guildCount: 1 },
  safety: { killswitch: false, dryRun: false, breakerOpen: false },
  jobCounts: {},
  oldestDueJobAtMs: undefined,
};

function renderAt(path: string) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  stubFetch([
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
    { url: '/api/assistant/model-health?window=24h', body: { window: '24h', models: [] } },
  ]);
  const { hook } = memoryLocation({ path });
  renderWithSession(
    <ThemeProvider>
      <Router hook={hook}>
        <Shell />
      </Router>
    </ThemeProvider>,
    { session: TEST_SESSION },
  );
}

function mobileHeader(): HTMLElement {
  const header = document.querySelector('header');
  if (header === null) throw new Error('mobile header missing');
  return header;
}

describe('D4 mobile header (two rows)', () => {
  it('has exactly two direct child rows: brand plus icon controls, then JumpNav', () => {
    renderAt('/panels');
    const header = mobileHeader();
    const rows = Array.from(header.children);
    expect(rows).toHaveLength(2);
    const [first, second] = rows as [HTMLElement, HTMLElement];

    // Row 1: the brand on the left and the three icon controls in one group.
    expect(within(first).getByText('Bananasaurs')).toBeTruthy();
    expect(within(first).getByRole('button', { name: /Switch to (light|dark) mode/ })).toBeTruthy();
    expect(within(first).getByRole('button', { name: 'Search or jump to' })).toBeTruthy();
    expect(
      within(first).getByRole('button', { name: `Account menu for ${TEST_SESSION.accountId}` }),
    ).toBeTruthy();

    // Row 2: JumpNav full width, and nothing else up in row 1.
    expect(
      within(second).getByRole('button', { name: /Open navigation - current page/ }),
    ).toBeTruthy();
    expect(within(first).queryByRole('button', { name: /Open navigation/ })).toBeNull();
    expect(within(second).queryByText('Bananasaurs')).toBeNull();
  });

  it('keeps every control reachable by keyboard in visual order', async () => {
    renderAt('/panels');
    const user = userEvent.setup();
    const header = mobileHeader();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Skip to content' }));
    await user.tab();
    expect(document.activeElement).toBe(
      within(header).getByRole('button', { name: /Switch to (light|dark) mode/ }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      within(header).getByRole('button', { name: 'Search or jump to' }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      within(header).getByRole('button', { name: `Account menu for ${TEST_SESSION.accountId}` }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      within(header).getByRole('button', { name: /Open navigation - current page/ }),
    );
  });
});
