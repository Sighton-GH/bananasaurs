// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Tooltip, TooltipProvider } from './Tooltip.js';
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
it('describes a keyboard-focused child and dismisses on Escape', async () => {
  render(
    <TooltipProvider>
      <Tooltip content="More information">
        <button type="button">Help</button>
      </Tooltip>
    </TooltipProvider>,
  );
  const user = userEvent.setup();
  expect(screen.queryByRole('tooltip')).toBeNull();
  await user.tab();
  const tip = await screen.findByRole('tooltip');
  expect(tip.textContent).toBe('More information');
  expect(screen.getByRole('button').getAttribute('aria-describedby')).toBe(tip.id);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  expect(screen.getByRole('button').hasAttribute('aria-describedby')).toBe(false);
});

it('waits the provider delay before showing a hovered child', async () => {
  const timeout = vi.spyOn(globalThis, 'setTimeout');
  render(
    <TooltipProvider>
      <Tooltip content="Delayed help">
        <button type="button">Help</button>
      </Tooltip>
    </TooltipProvider>,
  );
  await userEvent.setup().hover(screen.getByRole('button'));
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(timeout.mock.calls.some((call) => call[1] === 300)).toBe(true);
  expect((await screen.findByRole('tooltip')).textContent).toBe('Delayed help');
  timeout.mockRestore();
});

it('bounds the content to the viewport with safe edge gaps and wraps long words', async () => {
  render(
    <TooltipProvider>
      <Tooltip content="More information">
        <button type="button">Help</button>
      </Tooltip>
    </TooltipProvider>,
  );
  await userEvent.setup().tab();
  const tip = await screen.findByRole('tooltip');
  // jsdom class contract, not geometry proof: the cap must track the viewport
  // rather than a fixed 320px that overflows a 180 CSS px native-zoom viewport.
  expect(tip.className).toContain('max-w-[min(20rem,calc(100vw-2rem))]');
  expect(tip.className).not.toContain('max-w-xs');
  expect(tip.className).toContain('break-words');
});

it('keeps long unbroken content whole across keyboard, hover and Escape', async () => {
  const longToken = `Ref-${'x'.repeat(80)}`;
  const content = `This button does not change data. ${longToken}`;
  render(
    <TooltipProvider>
      <Tooltip content={content}>
        <button type="button">Help</button>
      </Tooltip>
    </TooltipProvider>,
  );
  const user = userEvent.setup();
  await user.tab();
  const tip = await screen.findByRole('tooltip');
  // Nothing clipped, truncated or removed: the visible tooltip carries the full string.
  expect(tip.textContent).toBe(content);
  expect(screen.getByRole('button').getAttribute('aria-describedby')).toBe(tip.id);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  // Escape hides the tooltip; focus stays on the trigger.
  expect(document.activeElement).toBe(screen.getByRole('button'));
  await user.hover(screen.getByRole('button'));
  expect((await screen.findByRole('tooltip')).textContent).toBe(content);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
});
