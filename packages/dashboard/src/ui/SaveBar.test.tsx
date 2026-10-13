// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaveBar } from './SaveBar.js';

afterEach(cleanup);
afterEach(() => {
  delete document.documentElement.dataset.theme;
});
describe('SaveBar', () => {
  it('renders nothing at zero and uses exact singular/plural counts', () => {
    const props = { onSave: vi.fn(), onDiscard: vi.fn() };
    const { container, rerender } = render(<SaveBar {...props} dirtyCount={0} />);
    expect(container.innerHTML).toBe('');
    rerender(<SaveBar {...props} dirtyCount={1} />);
    expect(screen.getByText('1 unsaved change')).toBeTruthy();
    rerender(<SaveBar {...props} dirtyCount={3} />);
    expect(screen.getByText('3 unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });
  it('updates only the count in a stable polite live region without rewriting unchanged text', () => {
    const props = { onSave: vi.fn(), onDiscard: vi.fn() };
    const { rerender } = render(<SaveBar {...props} dirtyCount={1} />);
    const count = screen.getByText('1 unsaved change');
    expect(count.getAttribute('aria-live')).toBe('polite');
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar.getAttribute('aria-live')).toBeNull();
    expect(within(count).queryAllByRole('button')).toHaveLength(0);
    for (const name of ['Save', 'Discard']) {
      expect(count.contains(within(bar).getByRole('button', { name }))).toBe(false);
    }

    const observer = new MutationObserver(() => undefined);
    observer.observe(count, { childList: true, characterData: true, subtree: true });
    try {
      rerender(<SaveBar {...props} dirtyCount={1} busy />);
      expect(screen.getByText('1 unsaved change')).toBe(count);
      expect(observer.takeRecords()).toHaveLength(0);

      rerender(<SaveBar {...props} dirtyCount={3} />);
      expect(screen.getByText('3 unsaved changes')).toBe(count);
      expect(count.getAttribute('aria-live')).toBe('polite');
      expect(observer.takeRecords().length).toBeGreaterThan(0);
      expect(within(bar).getByRole('button', { name: 'Save' })).toBeTruthy();
      expect(within(bar).getByRole('button', { name: 'Discard' })).toBeTruthy();
    } finally {
      observer.disconnect();
    }
  });
  it('disables both actions while busy and keeps Save named with a spinner', () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    render(<SaveBar dirtyCount={3} onSave={onSave} onDiscard={onDiscard} busy />);
    for (const name of ['Save', 'Discard']) {
      const button = screen.getByRole('button', { name });
      expect(button.getAttribute('aria-busy')).toBe('true');
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(screen.getByRole('button', { name: 'Save' }).querySelector('svg')).not.toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });
  it.each(['light', 'dark'])(
    'uses theme tokens and in-flow wrapping containment (%s), not a fixed overlay',
    (theme) => {
      document.documentElement.dataset.theme = theme;
      render(
        <main style={{ width: 180 }}>
          <button>Page control</button>
          <SaveBar dirtyCount={123} onSave={() => undefined} onDiscard={() => undefined} />
        </main>,
      );
      const bar = screen.getByRole('region', { name: 'Unsaved changes' });
      expect(bar.className).toContain('sticky bottom-0');
      expect(bar.className).toContain('bg-panel');
      expect(bar.className).toContain('text-ink');
      expect(bar.className).toContain('flex-wrap');
      expect(bar.className).toContain('min-w-0');
      expect(bar.className).not.toContain('fixed');
      expect(within(bar).getAllByRole('button')).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'Page control' })).toBeTruthy();
    },
  );
});
