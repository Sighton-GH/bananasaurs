// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Banner } from './Banner.js';

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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Banner', () => {
  it('tone hold renders role=alert, full width, with icon, text, action and Dismiss', () => {
    const onDismiss = vi.fn();
    render(
      <Banner tone="hold" onDismiss={onDismiss} action={<button type="button">Review</button>}>
        Sync is paused.
      </Banner>,
    );
    const banner = screen.getByRole('alert');
    expect(banner.className).toContain('w-full');
    expect(banner.querySelector('svg')).not.toBeNull();
    expect(banner.textContent).toContain('Sync is paused.');
    expect(screen.getByRole('button', { name: 'Review' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('lets live override the tone role without changing default callers', () => {
    const view = render(
      <Banner tone="hold" live="polite">
        Sync is paused.
      </Banner>,
    );
    expect(screen.getByRole('status').textContent).toContain('Sync is paused.');
    expect(screen.queryByRole('alert')).toBeNull();
    view.rerender(
      <Banner tone="info" live="assertive">
        Check now.
      </Banner>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Check now.');
    expect(screen.queryByRole('status')).toBeNull();
    view.rerender(
      <Banner tone="hold" live="assertive">
        Sync is paused.
      </Banner>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Sync is paused.');
    view.rerender(<Banner tone="hold">Sync is paused.</Banner>);
    expect(screen.getByRole('alert').textContent).toContain('Sync is paused.');
  });

  it('Dismiss is keyboard-operable (Tab, then Space) and shows a tooltip on focus', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <Banner tone="hold" onDismiss={onDismiss}>
        Sync is paused.
      </Banner>,
    );
    await user.tab();
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(document.activeElement).toBe(dismiss);
    expect((await screen.findByRole('tooltip')).textContent).toBe('Dismiss');
    await user.keyboard(' ');
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('tone info renders role=status and no Dismiss button without onDismiss', () => {
    render(<Banner tone="info">All good</Banner>);
    expect(screen.getByRole('status').textContent).toContain('All good');
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });
});
