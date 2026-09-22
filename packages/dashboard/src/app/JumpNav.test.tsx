// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderWithSession, stubFetch } from '../test-support.js';
import { HealthProvider } from './health.js';
import { currentNavEntry, JumpNav } from './JumpNav.js';
import { NAV } from './routes.js';

const HEALTH = {
  guildId: '1540816150026518620',
  guildName: 'Bananasaurs dev',
  gateway: { connected: true, pingMs: 42, guildCount: 1 },
  safety: { killswitch: false, dryRun: false, breakerOpen: false },
  jobCounts: {},
  oldestDueJobAtMs: undefined,
};

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
    ['/audit', 'Audit'],
    ['/cases/42', 'Cases'],
    ['/members/987654321098765432', 'Members'],
    ['/automod/rule-1', 'Automod'],
  ])('maps %s to %s', (location, label) => {
    expect(currentNavEntry(location)?.label).toBe(label);
  });

  it('returns undefined for an unknown route', () => {
    expect(currentNavEntry('/nope')).toBeUndefined();
    expect(currentNavEntry('/archivex')).toBeUndefined();
  });
});

describe('JumpNav', () => {
  it('names the current area on the trigger, and every NAV entry once inside the sheet', async () => {
    renderAt('/audit');
    const trigger = screen.getByRole('button', {
      name: 'Open navigation - current page Audit',
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);

    const sheet = await screen.findByRole('dialog', { name: 'Jump to' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const nav = within(sheet).getByRole('navigation', { name: 'Areas' });
    const labels = Array.from(nav.querySelectorAll('a')).map((a) =>
      a.textContent?.replace(/Current|Future/g, ''),
    );
    const groupOrder = ['Operate', 'Moderation', 'Archive', 'Instance', 'Assistant'];
    expect(labels).toEqual(
      groupOrder.flatMap((group) => NAV.filter((n) => n.group === group).map((n) => n.label)),
    );
    const current = within(nav).getByRole('link', { current: 'page' });
    expect(current.getAttribute('href')).toBe('/audit');
    expect(current.textContent).toContain('Audit');
    expect(current.textContent).toContain('Current');
    expect(within(nav).queryByText('Future')).toBeNull();
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
