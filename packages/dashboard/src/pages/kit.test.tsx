// @vitest-environment jsdom
import { cleanup, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderWithSession, TEST_SESSION } from '../test-support.js';
import { ThemeProvider } from '../app/theme.js';
import { Shell } from '../app/Shell.js';
import { KitPage } from './kit.js';

const HEADINGS = ['Tokens', 'Type', 'Buttons', 'Form', 'Structure', 'States', 'Feedback', 'Crash'];

function renderKit(instanceOwner?: boolean) {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  renderWithSession(
    <Router>
      <KitPage />
    </Router>,
    {
      session: { ...TEST_SESSION, ...(instanceOwner === undefined ? {} : { instanceOwner }) },
    },
  );
  return fetch;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
});

describe('/kit', () => {
  it('renders every section in order for the instance owner without API calls', () => {
    const fetch = renderKit(true);
    for (const name of HEADINGS)
      expect(screen.getByRole('heading', { level: 2, name })).toBeTruthy();
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent)
      .filter((t) => HEADINGS.includes(t ?? ''));
    expect(headings).toEqual(HEADINGS);
    expect(
      screen.getByText(
        'Switch the theme with the toggle to check both. Nothing on this page changes any data.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Loading sample' })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads swatch values from computed styles and updates when the theme changes', async () => {
    const root = document.documentElement;
    root.style.setProperty('--color-canvas', 'rgb(1, 2, 3)');
    renderKit(true);
    const item = screen.getByText('--color-canvas').closest('li');
    expect(item).not.toBeNull();
    if (item === null) throw new Error('Missing swatch');
    expect(within(item).getByText('rgb(1, 2, 3)')).toBeTruthy();
    root.style.setProperty('--color-canvas', 'rgb(4, 5, 6)');
    root.dataset.theme = 'dark';
    await waitFor(() => expect(within(item).getByText('rgb(4, 5, 6)')).toBeTruthy());
    expect(item.querySelector('span')?.style.backgroundColor).toBe('rgb(4, 5, 6)');
  });

  it.each([false, undefined])(
    'refuses a non-owner (%s), including old sessions without the flag',
    (instanceOwner) => {
      const fetch = renderKit(instanceOwner);
      expect(screen.getByText("You don't have access to this")).toBeTruthy();
      expect(screen.getByText('the instance owner')).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Tokens' })).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('contains the test crash locally and resets it with the keyboard', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetch = renderKit(true);
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'Throw a test error' });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('This page hit a problem')).toBeTruthy();
    for (const name of HEADINGS)
      expect(screen.getByRole('heading', { level: 2, name })).toBeTruthy();
    const reset = screen.getByRole('button', { name: 'Reset test error' });
    reset.focus();
    await user.keyboard(' ');
    expect(screen.queryByText('This page hit a problem')).toBeNull();
    expect(screen.getByText('The crash demo is working.')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses working local form, tabs, pagination, error links and Undo controls', async () => {
    const fetch = renderKit(true);
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'Sample title' });
    await user.type(input, 'Demo');
    expect((input as HTMLInputElement).value).toBe('Demo');
    const checkbox = screen.getByRole('checkbox', { name: 'Enable sample option' });
    checkbox.focus();
    await user.keyboard(' ');
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    const tab = screen.getByRole('tab', { name: 'First' });
    tab.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Second' }).getAttribute('aria-selected')).toBe('true');
    const pages = screen.getByRole('navigation', { name: 'Sample pages' });
    await user.click(within(pages).getByRole('button', { name: 'Next' }));
    expect(within(pages).getByText('Page 2 of 3')).toBeTruthy();
    await user.click(screen.getByRole('link', { name: 'Enter a sample name.' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Sample name' }));
    await user.click(screen.getByRole('button', { name: 'Toast with Undo' }));
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('Sample action undone')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'routes /kit through Shell without putting it in navigation (owner=%s)',
    async (instanceOwner) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          Promise.resolve(new Response(JSON.stringify({ error: 'sample' }), { status: 503 })),
        ),
      );
      const { hook } = memoryLocation({ path: '/kit' });
      renderWithSession(
        <ThemeProvider>
          <Router hook={hook}>
            <Shell />
          </Router>
        </ThemeProvider>,
        {
          session: { ...TEST_SESSION, instanceOwner },
        },
      );
      if (instanceOwner)
        expect(screen.getByRole('heading', { level: 1, name: 'UI kit' })).toBeTruthy();
      else {
        expect(screen.getByText('the instance owner')).toBeTruthy();
        expect(screen.queryByRole('heading', { level: 1, name: 'UI kit' })).toBeNull();
        expect(screen.queryByRole('heading', { level: 2, name: 'Tokens' })).toBeNull();
        expect(screen.queryByRole('textbox', { name: 'Sample title' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Throw a test error' })).toBeNull();
      }
      expect(document.title).toBe('UI kit · Bananasaurs');
      expect(
        within(screen.getByRole('navigation', { name: 'Areas' })).queryByRole('link', {
          name: /kit/i,
        }),
      ).toBeNull();
    },
  );
});
