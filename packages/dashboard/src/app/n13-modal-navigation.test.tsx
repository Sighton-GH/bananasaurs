// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Link, Router, useLocation } from 'wouter';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard.js';
import { renderWithSession, stubFetch } from '../test-support.js';
import { HealthProvider } from './health.js';
import { JumpNav } from './JumpNav.js';

function DirtyHost({ dirty }: { dirty: boolean }) {
  const [path] = useLocation();
  const previous = useRef(path);
  const main = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState('Unsaved tuning');
  const guard = useUnsavedGuard(dirty);
  // Match Shell's route-change focus contract, including its race with dialog close.
  useEffect(() => {
    if (previous.current === path) return;
    previous.current = path;
    main.current?.focus();
  }, [path]);
  return (
    <>
      <JumpNav />
      <main id="main" ref={main} tabIndex={-1}>
        <input aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <p>{path}</p>
        <Link href="/other">Other destination</Link>
      </main>
      {guard}
    </>
  );
}
function setup(dirty = true) {
  const fetch = stubFetch([
    { url: '/api/health', body: { guildId: '1540816150026518620', guildName: 'Test guild' } },
  ]);
  renderWithSession(
    <Router>
      <HealthProvider>
        <DirtyHost dirty={dirty} />
      </HealthProvider>
    </Router>,
  );
  const writes = () => fetch.mock.calls.filter(([, init]) => (init?.method ?? 'GET') !== 'GET');
  return { writes, push: vi.spyOn(window.history, 'pushState') };
}
async function openSafety() {
  const user = userEvent.setup();
  const trigger = screen.getByRole('button', { name: /Open navigation/ });
  await user.click(trigger);
  const sheet = screen.getByRole('dialog', { name: 'Jump to' });
  const link = within(sheet).getByRole('link', { name: 'Safety' });
  link.setAttribute('href', '/safety?tab=limits#details');
  return { user, trigger, sheet, link, nested: within(link).getByText('Safety') };
}
beforeEach(() => window.history.replaceState(null, '', '/assistant/tuning'));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('N13 JumpNav dirty-route handoff (DOM lifecycle, not native geometry)', () => {
  it.each(['Stay', 'Escape'])(
    '%s yields the sheet, retains URL/draft and restores its visible opener',
    async (action) => {
      const { writes, push } = setup();
      const { user, trigger, sheet, nested } = await openSafety();
      // Observe Radix's real deferred close lifecycle on the detached sheet.
      // The new trap can mask a focus steal in jsdom, so verify suppression too.
      const restoreTrigger = vi.spyOn(trigger, 'focus');
      let oldTrapClose: Event | undefined;
      sheet.addEventListener('focusScope.autoFocusOnUnmount', (event) => {
        oldTrapClose = event;
      });
      await user.click(nested);
      const guard = screen.getByRole('dialog', { name: 'Leave without saving?' });
      expect(document.querySelector('.jumpnav-sheet')).toBeNull();
      expect(document.querySelector('.jumpnav-overlay')).toBeNull();
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(guard.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).toBe(within(guard).getByRole('button', { name: 'Stay' }));
      // Let Radix's deferred close autofocus run: the old trap must not steal focus.
      await waitFor(() => expect(oldTrapClose?.defaultPrevented).toBe(true));
      expect(restoreTrigger).not.toHaveBeenCalled();
      expect(guard.contains(document.activeElement)).toBe(true);
      if (action === 'Escape') await user.keyboard('{Escape}');
      else await user.click(within(guard).getByRole('button', { name: 'Stay' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(document.activeElement).toBe(trigger);
      expect(window.location.pathname + window.location.search + window.location.hash).toBe(
        '/assistant/tuning',
      );
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Draft' }).value).toBe(
        'Unsaved tuning',
      );
      expect(push).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(0);
      // A second open and Escape must behave like a normal sheet close, not reuse handoff state.
      await user.click(trigger);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(document.activeElement).toBe(trigger);
    },
  );

  it('keyboard Leave keeps exact query/hash, navigates once and does not cover or steal destination focus', async () => {
    const { writes, push } = setup();
    const { user, nested } = await openSafety();
    await user.click(nested);
    expect(document.querySelector('.jumpnav-sheet')).toBeNull();
    await user.tab();
    const leave = screen.getByRole('button', { name: 'Leave' });
    expect(document.activeElement).toBe(leave);
    await user.keyboard('{Enter}');
    fireEvent.click(leave);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/safety?tab=limits#details',
    );
    expect(push).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.getElementById('main'));
    expect(document.querySelector('.jumpnav-overlay')).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it('pointer Leave closes both layers and subsequent page links retain their own opener', async () => {
    const { writes, push } = setup();
    const { user, nested } = await openSafety();
    await user.click(nested);
    await user.click(screen.getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(push).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.getElementById('main'));
    expect(document.querySelector('.jumpnav-sheet')).toBeNull();
    const pageLink = screen.getByRole('link', { name: 'Other destination' });
    await user.click(pageLink);
    await user.click(screen.getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(pageLink);
    expect(push).toHaveBeenCalledTimes(1);
    expect(writes()).toHaveLength(0);
  });

  it('capture blocks downstream handlers and repeat clicks keep one guard and the first destination', async () => {
    const { push, writes } = setup();
    const { nested } = await openSafety();
    const downstream = vi.fn();
    document.addEventListener('click', downstream);
    try {
      fireEvent.click(nested);
      fireEvent.click(screen.getByText('Other destination'));
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(document.querySelector('.jumpnav-sheet')).toBeNull();
      expect(downstream).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('click', downstream);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/safety?tab=limits#details',
    );
    expect(push).toHaveBeenCalledTimes(1);
    expect(writes()).toHaveLength(0);
  });

  it('clean nested links still navigate and close without a guard', async () => {
    const { push, writes } = setup(false);
    const { user, nested } = await openSafety();
    await user.click(nested);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Wouter uses the Link prop, not the mutated DOM href used by capture tests.
    expect(window.location.pathname).toBe('/safety');
    expect(push).toHaveBeenCalledTimes(1);
    expect(writes()).toHaveLength(0);
  });

  it('modified links retain browser behavior without starting a dirty handoff', async () => {
    const { push } = setup();
    const { link, nested } = await openSafety();
    // Prevent jsdom default navigation only after inspecting the real document capture path.
    let captured = true;
    link.addEventListener('click', (event) => {
      captured = event.defaultPrevented;
      event.preventDefault();
    });
    fireEvent.click(nested, { ctrlKey: true });
    expect(captured).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });
});
