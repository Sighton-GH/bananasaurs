// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineAlert } from './InlineAlert.js';

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

describe('InlineAlert', () => {
  it('tone danger renders role=alert with title, body, action and a copyable reference', async () => {
    const user = userEvent.setup();
    render(
      <InlineAlert
        tone="danger"
        title="Save failed"
        reference="req-123"
        action={<button type="button">Retry</button>}
      >
        The server said no.
      </InlineAlert>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('bg-tone-danger-bg');
    expect(alert.className).toContain('text-tone-danger-ink');
    expect(alert.className).toContain('border-tone-danger');
    expect(screen.getByText('Save failed').className).toContain('font-medium');
    expect(alert.textContent).toContain('The server said no.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
    const reference = screen.getByText('Ref req-123');
    expect(reference.className).toContain('font-mono');
    expect(reference.className).toContain('text-caption');
    await user.click(screen.getByRole('button', { name: 'Copy reference' }));
    expect(await window.navigator.clipboard.readText()).toBe('req-123');
  });

  it('a rejected clipboard write is swallowed quietly, not an unhandled rejection', async () => {
    // A plain function fake: vi.fn().mockRejectedValue hides the unhandled rejection in this Vitest.
    const writeText = () => Promise.reject(new Error('denied'));
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<InlineAlert tone="danger" title="Save failed" reference="req-123" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy reference' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByText('Ref req-123')).toBeDefined();
  });

  it('the copy button is keyboard-operable and shows a tooltip on focus', async () => {
    const user = userEvent.setup();
    render(<InlineAlert tone="danger" title="Save failed" reference="req-123" />);
    await user.tab();
    const copy = screen.getByRole('button', { name: 'Copy reference' });
    expect(document.activeElement).toBe(copy);
    expect((await screen.findByRole('tooltip')).textContent).toBe('Copy reference');
    await user.keyboard('{Enter}');
    expect(await window.navigator.clipboard.readText()).toBe('req-123');
  });

  it('tone info renders role=status', () => {
    render(<InlineAlert tone="info" title="Heads up" />);
    expect(screen.getByRole('status').textContent).toContain('Heads up');
  });
});

it('reflows the icon above prose before its column becomes too narrow, without clipping', () => {
  render(
    <InlineAlert tone="danger" title="This page hit a problem">
      Nothing was changed.
    </InlineAlert>,
  );
  const alert = screen.getByRole('alert');
  expect(alert.classList.contains('flex-wrap')).toBe(true);
  const text = screen.getByText('This page hit a problem').parentElement;
  for (const token of ['min-w-0', 'basis-48', '[overflow-wrap:anywhere]'])
    expect(text?.classList.contains(token)).toBe(true);
  expect(alert.classList.contains('overflow-hidden')).toBe(false);
});
