// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderWithSession, stubFetch, TEST_SESSION } from '../test-support.js';
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

vi.mock('../pages/overview.js', async () => {
  const { usePalette } = await import('./palette-context.js');
  return {
    OverviewPage: () => {
      const p = usePalette();
      return <output data-testid="palette-probe">{String(p.isOpen)}</output>;
    },
  };
});

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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderShell() {
  const mock = stubFetch([
    { url: '/api/health', body: HEALTH },
    { url: '/api/assistant/model-health?window=24h', body: { window: '24h', models: [] } },
    { method: 'POST', url: '/api/logout', body: {} },
  ]);
  const { hook } = memoryLocation({ path: '/' });
  renderWithSession(
    <ThemeProvider>
      <Router hook={hook}>
        <Shell />
      </Router>
    </ThemeProvider>,
    { session: TEST_SESSION },
  );
  return mock;
}

describe('Shell top bar (P4 Task 2)', () => {
  it('names the desktop and mobile Search controls identically', async () => {
    renderShell();
    const buttons = await screen.findAllByRole('button', { name: 'Search or jump to' });
    expect(buttons).toHaveLength(2);
    const desktop = buttons.find((b) => b.textContent.includes('Search or jump to…'))!;
    expect(within(desktop).getByText(/^(Ctrl K|\u2318 K)$/)).toBeTruthy();
    const mobile = buttons.find((b) => b !== desktop)!;
    expect(mobile.textContent).toBe('');
    expect(mobile.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
  });

  it.each([
    ['MacIntel', '\u2318 K'],
    ['Win32', 'Ctrl K'],
  ])('platform %s shows the %s shortcut hint', async (platform, hint) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    renderShell();
    const buttons = await screen.findAllByRole('button', { name: 'Search or jump to' });
    const desktop = buttons.find((b) => b.textContent.includes('Search or jump to…'))!;
    expect(desktop.querySelector('kbd')!.textContent).toBe(hint);
  });

  it.each([0, 1])('Search button %i opens the palette state', async (index) => {
    renderShell();
    const buttons = await screen.findAllByRole('button', { name: 'Search or jump to' });
    expect(screen.getByTestId('palette-probe').textContent).toBe('false');
    await act(async () => {
      fireEvent.click(buttons[index]!);
    });
    expect(screen.getByTestId('palette-probe').textContent).toBe('true');
  });

  it('mounts one palette: Search opens a single dialog, Ctrl-K toggles it, Escape restores the Search button', async () => {
    renderShell();
    const user = userEvent.setup();
    const buttons = await screen.findAllByRole('button', { name: 'Search or jump to' });
    const desktop = buttons.find((b) => b.textContent.includes('Search or jump to\u2026'))!;
    desktop.focus();
    await user.click(desktop);
    const dialogs = await screen.findAllByRole('dialog', { name: 'Search or jump to' });
    expect(dialogs).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole('combobox'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(desktop);
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findAllByRole('dialog', { name: 'Search or jump to' })).toHaveLength(1);
    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('account menu shows the account id and Sign out posts /api/logout', async () => {
    const mock = renderShell();
    const user = userEvent.setup();
    const triggers = await screen.findAllByRole('button', {
      name: `Account menu for ${TEST_SESSION.accountId}`,
    });
    await user.click(triggers[0]!);
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    const call = mock.mock.calls.find((c) => (c[0] as string) === '/api/logout');
    expect((call![1] as RequestInit).method).toBe('POST');
  });

  it('Escape closes the account menu and returns focus to its trigger', async () => {
    renderShell();
    const user = userEvent.setup();
    const [trigger] = await screen.findAllByRole('button', {
      name: `Account menu for ${TEST_SESSION.accountId}`,
    });
    await user.click(trigger!);
    await screen.findByRole('menuitem', { name: 'Sign out' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the original footer Sign out and the jump opener', async () => {
    renderShell();
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open navigation - current page/ })).toBeTruthy();
  });
});
