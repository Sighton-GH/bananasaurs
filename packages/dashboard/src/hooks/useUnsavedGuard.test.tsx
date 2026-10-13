// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { Link, Router, useLocation } from 'wouter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../app/session.js';
import { stubFetch, TEST_SESSION } from '../test-support.js';
import { useUnsavedGuard } from './useUnsavedGuard.js';

function Page({ dirty = true }: { dirty?: boolean }) {
  const guard = useUnsavedGuard(dirty);
  const [value, setValue] = useState('Edits to keep');
  const [path, navigate] = useLocation();
  return (
    <>
      <p data-testid="path">{path}</p>
      <input aria-label="Draft" value={value} onChange={(e) => setValue(e.target.value)} />
      <Link href="/next?tab=keys#details">
        <span>Next page</span>
      </Link>
      <Link href="/other">Other page</Link>
      <button onClick={() => navigate('/programmatic')}>Programmatic</button>
      {guard}
    </>
  );
}
function setup(dirty = true) {
  stubFetch([]);
  return render(
    <SessionProvider session={TEST_SESSION} onLoggedOut={() => undefined}>
      <Router>
        <Page dirty={dirty} />
      </Router>
    </SessionProvider>,
  );
}
beforeEach(() => {
  window.history.replaceState(null, '', '/editing');
});
afterEach(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('useUnsavedGuard', () => {
  it('intercepts nested targets before wouter, Stay retains input, Leave navigates exact query/hash once', async () => {
    const user = userEvent.setup();
    setup();
    await user.clear(screen.getByRole('textbox', { name: 'Draft' }));
    await user.type(screen.getByRole('textbox', { name: 'Draft' }), 'Changed draft');
    const opener = screen.getByText('Next page').closest('a')!;
    opener.focus();
    const push = vi.spyOn(window.history, 'pushState');
    await user.click(screen.getByText('Next page'));
    expect(window.location.pathname).toBe('/editing');
    expect(screen.getByRole('dialog', { name: 'Leave without saving?' }).textContent).toContain(
      'Your changes on this page will be lost.',
    );
    expect(push).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Draft' }).value).toBe(
      'Changed draft',
    );
    expect(document.activeElement).toBe(opener);
    await user.click(screen.getByText('Next page'));
    const leave = screen.getByRole('button', { name: 'Leave' });
    fireEvent.click(leave);
    fireEvent.click(leave);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/next?tab=keys#details',
    );
    expect(screen.getByTestId('path').textContent).toBe('/next');
    expect(push).toHaveBeenCalledTimes(1);
  });
  it('Escape closes and restores focus without navigating', async () => {
    const user = userEvent.setup();
    setup();
    const link = screen.getByText('Next page').closest('a')!;
    link.focus();
    await user.click(link);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(link);
    expect(window.location.pathname).toBe('/editing');
  });
  it('backdrop cancels without losing the draft or focus', async () => {
    const user = userEvent.setup();
    setup();
    const link = screen.getByText('Next page').closest('a')!;
    link.focus();
    await user.click(link);
    // Radix distinguishes a pointer-down outside Content from a click inside it.
    const overlay = document.querySelector('.bg-canvas\\/70');
    expect(overlay).not.toBeNull();
    await user.click(overlay!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(link);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Draft' }).value).toBe(
      'Edits to keep',
    );
    expect(window.location.pathname).toBe('/editing');
  });
  it('retains same-path query/hash navigation and explicit _self targets', () => {
    setup();
    const link = screen.getByText('Next page').closest('a')!;
    link.setAttribute('href', '/editing?tab=advanced#limits');
    link.setAttribute('target', '_self');
    fireEvent.click(link);
    expect(window.location.search).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/editing?tab=advanced#limits',
    );
  });
  it('keeps the first pending destination when several clicks arrive before confirmation', () => {
    setup();
    const push = vi.spyOn(window.history, 'pushState');
    fireEvent.click(screen.getByText('Next page'));
    fireEvent.click(screen.getByText('Other page'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(window.location.pathname).toBe('/next');
    expect(push).toHaveBeenCalledTimes(1);
  });
  it('does not intercept clean links or programmatic navigation', () => {
    setup(false);
    fireEvent.click(screen.getByText('Next page'));
    expect(window.location.pathname).toBe('/next');
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Programmatic' }));
    expect(window.location.pathname).toBe('/programmatic');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('adds beforeunload only while dirty and clears pending state when dirtiness changes', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { rerender, unmount } = render(<Page dirty={false} />);
    const count = (spy: typeof add, type: string) =>
      spy.mock.calls.filter((c) => c[0] === type).length;
    expect(count(add, 'beforeunload')).toBe(0);
    rerender(<Page dirty />);
    expect(count(add, 'beforeunload')).toBe(1);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByText('Next page'));
    rerender(<Page dirty={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(count(remove, 'beforeunload')).toBe(1);
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    rerender(<Page dirty />);
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();
    expect(count(add, 'beforeunload')).toBe(count(remove, 'beforeunload'));
  });
  it('balances capture listeners in StrictMode and unmount leaves links untouched', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(
      <StrictMode>
        <Page />
      </StrictMode>,
    );
    unmount();
    const clicks = (spy: typeof add) =>
      spy.mock.calls.filter((c) => c[0] === 'click' && c[2] === true);
    expect(clicks(add).length).toBeGreaterThan(0);
    expect(clicks(add)).toHaveLength(clicks(remove).length);
    const a = document.createElement('a');
    a.href = '/next';
    document.body.append(a);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    let prevented = true;
    a.addEventListener('click', (e) => {
      prevented = e.defaultPrevented;
      e.preventDefault();
    });
    a.dispatchEvent(event);
    a.remove();
    expect(prevented).toBe(false);
  });
  it.each([
    { href: '/next', ctrlKey: true },
    { href: '/next', metaKey: true },
    { href: '/next', shiftKey: true },
    { href: '/next', altKey: true },
    { href: '/next', button: 1 },
    { href: '/next', target: '_blank' },
    { href: '/next', download: '' },
    { href: 'https://elsewhere.example/next' },
    { href: '//localhost/next' },
    { href: '#field-title' },
    { href: 'mailto:a@example.test' },
  ])('does not trap browser-special clicks %j', ({ href, target, download, ...init }) => {
    setup();
    const a = document.createElement('a');
    a.setAttribute('href', href);
    if (target !== undefined) a.target = target;
    if (download !== undefined) a.setAttribute('download', download);
    document.body.append(a);
    // Suppress jsdom's default navigation only AFTER measuring the guard.
    let prevented = true;
    a.addEventListener('click', (event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    });
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    a.remove();
    expect(prevented).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('honors an already prevented capture event and stops downstream handlers when trapping', () => {
    const prevent = (event: Event) => event.preventDefault();
    document.addEventListener('click', prevent, true);
    setup();
    fireEvent.click(screen.getByText('Next page'));
    expect(screen.queryByRole('dialog')).toBeNull();
    document.removeEventListener('click', prevent, true);
    cleanup();
    setup();
    const downstream = vi.fn();
    document.addEventListener('click', downstream);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      screen.getByText('Next page').dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(downstream).not.toHaveBeenCalled();
    document.removeEventListener('click', downstream);
  });
});
