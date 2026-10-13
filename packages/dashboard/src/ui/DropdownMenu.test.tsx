// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DropdownMenu } from './DropdownMenu.js';
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
it('opens by keyboard, skips disabled items, selects and returns focus', async () => {
  const selected = vi.fn();
  const disabled = vi.fn();
  render(
    <DropdownMenu
      label="More actions for Car Team A"
      items={[
        { label: 'View', onSelect: vi.fn() },
        'separator',
        { label: 'Unavailable', disabled: true, onSelect: disabled },
        { label: 'Delete', tone: 'danger', onSelect: selected },
      ]}
    />,
  );
  const trigger = screen.getByRole('button', { name: 'More actions for Car Team A' });
  expect(trigger.querySelector('svg')).toBeTruthy();
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('menu')).toBeTruthy();
  expect(screen.getByRole('separator')).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Unavailable' }).getAttribute('aria-disabled')).toBe(
    'true',
  );
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'View' }));
  await user.keyboard('{ArrowDown}');
  const danger = screen.getByRole('menuitem', { name: 'Delete' });
  expect(document.activeElement).toBe(danger);
  expect(danger.classList.contains('text-danger')).toBe(true);
  await user.keyboard('{Enter}');
  expect(selected).toHaveBeenCalledTimes(1);
  expect(disabled).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it('shows its label tooltip on hover without an external provider', async () => {
  render(<DropdownMenu label="More actions for Car Team A" items={[]} />);
  const trigger = screen.getByRole('button', { name: 'More actions for Car Team A' });
  await userEvent.setup().hover(trigger);
  const tip = await screen.findByRole('tooltip');
  expect(tip.textContent).toBe('More actions for Car Team A');
  expect(trigger.getAttribute('aria-describedby')).toBe(tip.id);
});
it('shows its tooltip on keyboard focus, then opens and selects from the same trigger', async () => {
  const selected = vi.fn();
  render(<DropdownMenu label="More actions" items={[{ label: 'View', onSelect: selected }]} />);
  const user = userEvent.setup();
  await user.tab();
  const trigger = screen.getByRole('button', { name: 'More actions' });
  const tip = await screen.findByRole('tooltip');
  expect(tip.textContent).toBe('More actions');
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute('aria-describedby')).toBe(tip.id);
  await user.keyboard('{Enter}');
  expect(screen.getByRole('menu')).toBeTruthy();
  expect(screen.queryByRole('tooltip')).toBeNull();
  await user.keyboard('{Enter}');
  expect(selected).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menu')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it('keeps the accent focus-visible outline contract on keyboard-focused menu items', async () => {
  render(<DropdownMenu label="More actions" items={[{ label: 'View', onSelect: vi.fn() }]} />);
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard('{Enter}');
  const item = screen.getByRole('menuitem', { name: 'View' });
  expect(document.activeElement).toBe(item);
  // jsdom cannot resolve Tailwind layers and :focus-visible like a browser.
  // The base stylesheet supplies a solid 2px outline; no utility may cancel it.
  expect(item.classList.contains('outline-none')).toBe(false);
  expect(item.classList.contains('focus-visible:outline-accent')).toBe(true);
});
