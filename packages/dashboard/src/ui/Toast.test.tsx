// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast.js';

afterEach(cleanup);

function Trigger() {
  const toast = useToast();
  return (
    <>
      <button onClick={() => toast({ tone: 'ok', title: 'Saved' })}>ok</button>
      <button onClick={() => toast({ tone: 'danger', title: 'Failed', message: 'why' })}>
        danger
      </button>
    </>
  );
}

describe('toasts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders into a polite live region, and an ok toast leaves on its own', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('ok'));
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toContain('Saved');
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(region.textContent).not.toContain('Saved');
  });

  it('a danger toast stays until dismissed', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('danger'));
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(screen.getByRole('status').textContent).toContain('why');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Failed' }));
    expect(screen.getByRole('status').textContent).not.toContain('Failed');
  });

  it('useToast outside the provider throws', () => {
    expect(() => render(<Trigger />)).toThrow(/inside <ToastProvider>/);
  });
});
