// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { CodeBlock } from './CodeBlock.js';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('renders labelled code with language, monospace type and keyboard-scrolling', async () => {
  render(<CodeBlock code="const n = 1;" language="ts" label="Example" maxHeight={120} />);
  const region = screen.getByRole('region', { name: 'Example' });
  const pre = region.querySelector('pre');
  expect(pre?.querySelector('code')?.textContent).toBe('const n = 1;');
  expect(pre?.classList.contains('font-mono')).toBe(true);
  expect(pre?.classList.contains('text-small')).toBe(true);
  expect(pre?.classList.contains('overflow-auto')).toBe(true);
  expect(pre?.style.maxHeight).toBe('120px');
  expect(pre?.getAttribute('tabindex')).toBe('0');
  expect(pre?.querySelector('code')?.classList.contains('language-ts')).toBe(true);
  const user = userEvent.setup();
  await user.tab();
  await user.tab();
  expect(document.activeElement).toBe(pre);
});
it('copies by keyboard and announces Copied politely for exactly two seconds', async () => {
  const user = userEvent.setup();
  const timeout = vi.spyOn(globalThis, 'setTimeout');
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  render(<CodeBlock code="hello" label="Example" />);
  await user.tab();
  await user.keyboard('{Enter}');
  expect(write).toHaveBeenCalledWith('hello');
  expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  expect(screen.getByRole('status').textContent).toBe('Copied');
  const reset = timeout.mock.calls.find((call) => call[1] === 2000)?.[0];
  expect(reset).toBeTypeOf('function');
  act(() => {
    if (typeof reset === 'function') reset();
  });
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('');
});
it('does not claim success if copying fails', async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'));
  render(<CodeBlock code="hello" label="Example" />);
  await user.click(screen.getByRole('button', { name: 'Copy' }));
  expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  expect(screen.getByRole('alert').textContent).toBe("Couldn't copy. Select the text and copy it.");
});
