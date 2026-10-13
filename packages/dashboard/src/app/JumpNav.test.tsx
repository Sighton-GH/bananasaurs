// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderWithSession, stubFetch } from '../test-support.js';
import { HealthProvider } from './health.js';
import { currentNavEntry, JumpNav } from './JumpNav.js';
import { visibleNav } from './routes.js';
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

function renderAt(path: string) {
  stubFetch([{ url: '/api/health', body: HEALTH }]);
  const { hook, history } = memoryLocation({ path, record: true });
  renderWithSession(
    <Router hook={hook}>
      <HealthProvider>
        <JumpNav />
      </HealthProvider>
    </Router>,
  );
  return history;
}

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('currentNavEntry', () => {
  it.each([
    ['/', 'Overview'],
    ['/audit', 'Audit log'],
    ['/cases/42', 'Cases'],
    ['/members/987654321098765432', 'Members'],
    ['/automod/rule-1', 'Automod'],
    ['/tasks/abc', 'Tasks'],
    ['/assistant/history/trace-1', 'History'],
    ['/assistant', 'Behaviours'],
  ])('maps %s to %s', (location, label) => {
    expect(currentNavEntry(location)?.label).toBe(label);
  });

  it('returns undefined for an unknown route or a bare prefix', () => {
    expect(currentNavEntry('/nope')).toBeUndefined();
    expect(currentNavEntry('/archivex')).toBeUndefined();
    expect(currentNavEntry('/tasksXYZ')).toBeUndefined();
  });

  it('orients to a hidden entry without revealing it: the trigger names the parent of a detail route', () => {
    // Tasks is owner-only, but the trigger answers "where am I" from NAV, not
    // visibleNav; the sheet itself only ever lists visible entries.
    renderAt('/tasks/abc');
    expect(
      screen.getByRole('button', { name: 'Open navigation - current page Tasks' }),
    ).toBeTruthy();
  });
});

describe('JumpNav', () => {
  it('names the current area on the trigger, and every NAV entry once inside the sheet', async () => {
    renderAt('/audit');
    const trigger = screen.getByRole('button', {
      name: 'Open navigation - current page Audit log',
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);

    const sheet = await screen.findByRole('dialog', { name: 'Jump to' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const nav = within(sheet).getByRole('navigation', { name: 'Areas' });
    const labels = Array.from(nav.querySelectorAll('a')).map((a) =>
      a.textContent?.replace(/Current/g, ''),
    );
    // P4 Task 1 group order. The default test session is not the instance
    // owner, so the owner-only AI tuning entry stays out of the sheet here.
    const groupOrder = ['Club', 'Moderation', 'Assistant', 'Messages', 'System'];
    expect(labels).toEqual(
      groupOrder.flatMap((group) =>
        visibleNav(false)
          .filter((n) => n.group === group)
          .map((n) => n.label),
      ),
    );
    const current = within(nav).getByRole('link', { current: 'page' });
    expect(current.getAttribute('href')).toBe('/audit');
    expect(current.textContent).toContain('Audit log');
    expect(current.textContent).toContain('Current');
    expect(current.className).toContain('bg-accent-bg');
    expect(current.className).toContain('text-accent');
    // Every entry carries its decorative icon; the stub Future chip is gone.
    for (const link of Array.from(nav.querySelectorAll('a'))) {
      expect(link.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    }
    expect(within(nav).queryByText('Future')).toBeNull();
  });

  it('sheet group captions meet AA normal-text contrast on the canvas in both themes', async () => {
    renderAt('/');
    fireEvent.click(screen.getByRole('button', { name: /Open navigation/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Jump to' });
    const headings = within(sheet)
      .getAllByRole('heading', { level: 2 })
      .filter((h) => h.id.startsWith('jumpnav-'));
    expectCaptionsReadable(headings, sheet);
  });

  it('wraps a long label and keeps the Current badge inside the row on narrow sheets', async () => {
    // The pre-existing overflow (Connected apps + Current badge at 180 CSS
    // zoom, owner-deferred to P4 at 22:37) is fixed by a wrapping, shrinkable
    // row. jsdom cannot measure layout; these classes are the CSS contract
    // the native checker verifies in a real browser.
    renderAt('/mcp');
    fireEvent.click(screen.getByRole('button', { name: /Open navigation/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Jump to' });
    const current = within(sheet).getByRole('link', { current: 'page' });
    expect(current.className).toContain('flex-wrap');
    const labelSpan = current.querySelector('span');
    expect(labelSpan?.className).toContain('min-w-0');
    expect(labelSpan?.className).toContain('break-words');
    const badge = within(current).getByText('Current');
    expect(badge.className).toContain('shrink-0');
    expect(current.textContent).toContain('Connected apps');
  });

  it('marks the parent of a detail route current inside the sheet', async () => {
    renderAt('/automod/rule-1');
    fireEvent.click(screen.getByRole('button', { name: /Open navigation/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Jump to' });
    const nav = within(sheet).getByRole('navigation', { name: 'Areas' });
    const current = within(nav).getByRole('link', { current: 'page' });
    expect(current.getAttribute('href')).toBe('/automod');
    expect(current.textContent).toContain('Current');
  });

  it('carries the server identity, sign-out and credit so mobile keeps the rail footer', async () => {
    renderAt('/');
    fireEvent.click(screen.getByRole('button', { name: /Open navigation/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Jump to' });
    expect(await within(sheet).findByText('Bananasaurs dev')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(
      within(sheet)
        .getByRole('link', { name: /Sighton Media/ })
        .getAttribute('href'),
    ).toBe('https://sighton.ca');
  });

  it('orients detail routes to their list page and falls back on unknown routes', async () => {
    renderAt('/cases/42');
    expect(
      screen.getByRole('button', { name: 'Open navigation - current page Cases' }),
    ).toBeTruthy();
    cleanup();
    renderAt('/nope');
    expect(
      screen.getByRole('button', { name: 'Open navigation - current page Jump to' }),
    ).toBeTruthy();
  });

  it('navigates to the chosen area and closes the sheet', async () => {
    const history = renderAt('/');
    fireEvent.click(screen.getByRole('button', { name: /Open navigation/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Jump to' });
    fireEvent.click(within(sheet).getByRole('link', { name: 'Search' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(history[history.length - 1]).toBe('/search');
  });

  it('closes on escape and on the close button, returning focus to the trigger', async () => {
    renderAt('/');
    const trigger = screen.getByRole('button', { name: /Open navigation/ });
    fireEvent.click(trigger);
    const sheet = await screen.findByRole('dialog', { name: 'Jump to' });
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const again = await screen.findByRole('dialog', { name: 'Jump to' });
    fireEvent.click(within(again).getByRole('button', { name: 'Close navigation' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
