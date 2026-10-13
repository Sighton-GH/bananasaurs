// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Button } from './Button.js';
import { IconCheck } from './icons.js';
afterEach(cleanup);
it('primary uses accent and defaults to a non-submit medium button', () => {
  render(<Button variant="primary">Save</Button>);
  const button = screen.getByRole('button', { name: 'Save' });
  expect(button.classList.contains('bg-accent')).toBe(true);
  expect(button.classList.contains('text-accent-ink')).toBe(true);
  expect(button.classList.contains('min-h-9')).toBe(true);
  expect(button.classList.contains('py-1.5')).toBe(true);
  expect(button.classList.contains('h-9')).toBe(false);
  expect(button.getAttribute('type')).toBe('button');
});
it('busy disables, names by label and keeps the leading slot while replacing its icon', () => {
  const { rerender } = render(<Button icon={IconCheck}>Save</Button>);
  const slot = screen.getByRole('button').firstElementChild;
  expect(slot?.querySelector('.lucide-check')).toBeTruthy();
  rerender(
    <Button icon={IconCheck} busy>
      Save
    </Button>,
  );
  const button = screen.getByRole('button', { name: 'Save' });
  expect(button.hasAttribute('disabled')).toBe(true);
  expect(button.getAttribute('aria-busy')).toBe('true');
  expect(button.firstElementChild).toBe(slot);
  expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(button.querySelector('svg')?.classList.contains('animate-spin')).toBe(true);
  expect(screen.queryByRole('status')).toBeNull();
});
it('subtle has no visible border, small size and keyboard activation', async () => {
  const click = vi.fn();
  render(
    <Button variant="subtle" size="sm" onClick={click}>
      Cancel
    </Button>,
  );
  const button = screen.getByRole('button', { name: 'Cancel' });
  expect(button.classList.contains('border-transparent')).toBe(true);
  expect(button.classList.contains('border-line-strong')).toBe(false);
  expect(button.classList.contains('min-h-7')).toBe(true);
  expect(button.classList.contains('py-1')).toBe(true);
  expect(button.classList.contains('h-7')).toBe(false);
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(button);
  await user.keyboard('{Enter}');
  await user.keyboard(' ');
  expect(click).toHaveBeenCalledTimes(2);
});
it('busy cannot activate and submit props are kept', async () => {
  const click = vi.fn();
  render(
    <Button busy type="submit" onClick={click}>
      Save
    </Button>,
  );
  await userEvent.setup().click(screen.getByRole('button'));
  expect(click).not.toHaveBeenCalled();
  expect(screen.getByRole('button').getAttribute('type')).toBe('submit');
});

it('explicit disabled stays disabled when not busy', async () => {
  const click = vi.fn();
  render(
    <Button disabled onClick={click}>
      Save
    </Button>,
  );
  const button = screen.getByRole('button');
  expect(button.hasAttribute('disabled')).toBe(true);
  expect(button.hasAttribute('aria-busy')).toBe(false);
  await userEvent.setup().click(button);
  expect(click).not.toHaveBeenCalled();
});
it.each([
  ['default', ['border-line-strong', 'bg-panel', 'text-ink', 'hover:bg-sunk', 'active:bg-line']],
  ['danger', ['border-tone-danger', 'bg-panel', 'text-danger', 'hover:bg-tone-danger-bg']],
] as const)('%s uses its token classes', (variant, tokens) => {
  render(<Button variant={variant}>Save</Button>);
  for (const token of tokens)
    expect(screen.getByRole('button').classList.contains(token)).toBe(true);
});
it('plain button has no leading spacer and busy overlays its invisible in-flow label', () => {
  const { rerender } = render(<Button>Save</Button>);
  const button = screen.getByRole('button', { name: 'Save' });
  const label = button.firstElementChild;
  expect(label?.textContent).toBe('Save');
  expect(button.childElementCount).toBe(1);
  expect(label?.classList.contains('opacity-0')).toBe(false);
  rerender(<Button busy>Save</Button>);
  expect(screen.getByRole('button', { name: 'Save' })).toBe(button);
  expect(button.firstElementChild).toBe(label);
  expect(label?.classList.contains('opacity-0')).toBe(true);
  expect(label?.hasAttribute('aria-hidden')).toBe(false);
  expect(label?.classList.contains('absolute')).toBe(false);
  const overlay = button.lastElementChild;
  expect(overlay?.classList.contains('absolute')).toBe(true);
  expect(overlay?.classList.contains('inset-0')).toBe(true);
  expect(overlay?.classList.contains('inline-flex')).toBe(true);
  expect(overlay?.classList.contains('items-center')).toBe(true);
  expect(overlay?.classList.contains('justify-center')).toBe(true);
  expect(overlay?.getAttribute('aria-hidden')).toBe('true');
  expect(overlay?.querySelector('svg')?.classList.contains('animate-spin')).toBe(true);
  rerender(<Button>Save</Button>);
  expect(button.firstElementChild).toBe(label);
  expect(label?.classList.contains('opacity-0')).toBe(false);
  expect(button.childElementCount).toBe(1);
});

it.each([false, true])(
  'normal and disabled labels have a bounded wrapping box (disabled=%s)',
  (disabled) => {
    render(<Button disabled={disabled}>Throw a test error</Button>);
    const button = screen.getByRole('button', { name: 'Throw a test error' });
    expect(button.classList.contains('max-w-full')).toBe(true);
    expect(button.classList.contains('min-w-0')).toBe(true);
    expect(button.classList.contains('whitespace-normal')).toBe(true);
    expect(button.classList.contains('whitespace-nowrap')).toBe(false);
    expect(button.firstElementChild?.classList.contains('min-w-0')).toBe(true);
    expect(button.firstElementChild?.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
  },
);

it('minimum height buttons opt out of cross-axis stretching in mixed-size rows', () => {
  render(
    <div className="flex flex-wrap">
      <Button size="sm">Small</Button>
      <Button>Medium</Button>
    </div>,
  );
  for (const button of screen.getAllByRole('button')) {
    expect(button.classList.contains('h-fit')).toBe(true);
    expect(button.classList.contains('self-start')).toBe(false);
  }
});

it.each(['flex-col', 'items-center', 'items-end'])(
  'preserves parent alignment in %s and keyboard activation',
  async (parentClass) => {
    const click = vi.fn();
    render(
      <div className={`flex ${parentClass}`}>
        <Button size="sm" onClick={click}>
          Small action
        </Button>
        <Button>Medium action</Button>
      </div>,
    );
    const button = screen.getByRole('button', { name: 'Small action' });
    expect(button.className.split(' ').filter((token) => token.startsWith('self-'))).toEqual([]);
    expect(button.classList.contains('w-fit')).toBe(false);
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    expect(click).toHaveBeenCalledTimes(1);
  },
);
