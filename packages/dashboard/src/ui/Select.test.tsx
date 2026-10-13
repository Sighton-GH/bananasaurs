// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Field } from './Field.js';
import { Select } from './Select.js';
// jsdom lacks these DOM APIs called by Radix Select.
const { Element: DomElement } = globalThis as unknown as {
  Element: {
    prototype: {
      hasPointerCapture?: (pointerId: number) => boolean;
      releasePointerCapture?: (pointerId: number) => void;
      scrollIntoView?: () => void;
    };
  };
};
if (!DomElement.prototype.hasPointerCapture) DomElement.prototype.hasPointerCapture = () => false;
if (!DomElement.prototype.releasePointerCapture)
  DomElement.prototype.releasePointerCapture = () => undefined;
if (!DomElement.prototype.scrollIntoView) DomElement.prototype.scrollIntoView = () => undefined;
if (!('ResizeObserver' in globalThis))
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

afterEach(cleanup);
const options = [
  { value: 'a', label: 'Alpha', description: 'First team' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Closed', disabled: true },
];
function Fixture({ changed = vi.fn() }: { changed?: (v: string) => void }) {
  const [value, setValue] = useState<string>();
  return (
    <Field label="Team" hint="Pick your team">
      <Select
        value={value}
        onValueChange={(v) => {
          setValue(v);
          changed(v);
        }}
        options={options}
      />
    </Field>
  );
}
it('Field names the combobox and attaches its hint', () => {
  render(<Fixture />);
  const trigger = screen.getByRole('combobox', { name: 'Team' });
  expect(trigger.textContent).toContain('Choose…');
  expect(document.getElementById(trigger.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
    'Pick your team',
  );
});
it('Enter opens, arrows select Beta and return focus to the trigger', async () => {
  const changed = vi.fn();
  const user = userEvent.setup();
  render(<Fixture changed={changed} />);
  await user.tab();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('listbox')).toBeTruthy();
  expect(screen.getByText('First team')).toBeTruthy();
  await user.keyboard('{ArrowDown}{Enter}');
  expect(changed).toHaveBeenCalledWith('b');
  expect(document.activeElement).toBe(screen.getByRole('combobox'));
  expect(screen.queryByRole('listbox')).toBeNull();
});
it('Escape closes without a change', async () => {
  const changed = vi.fn();
  const user = userEvent.setup();
  render(<Fixture changed={changed} />);
  await user.tab();
  await user.keyboard('{Enter}{Escape}');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(changed).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole('combobox'));
});
it('disabled items cannot be selected with a pointer or arrows', async () => {
  const changed = vi.fn();
  const user = userEvent.setup();
  render(<Fixture changed={changed} />);
  await user.tab();
  await user.keyboard('{Enter}');
  const closed = screen.getByRole('option', { name: 'Closed' });
  expect(closed.getAttribute('aria-disabled')).toBe('true');
  await user.click(closed);
  expect(changed).not.toHaveBeenCalled();
  await user.keyboard('{End}{Enter}');
  expect(changed).toHaveBeenCalledWith('b');
});
it('invalid and disabled trigger states reach the button', () => {
  render(
    <Select
      value={undefined}
      onValueChange={vi.fn()}
      options={options}
      aria-label="Team"
      aria-invalid
      disabled
    />,
  );
  const trigger = screen.getByRole<HTMLButtonElement>('combobox', { name: 'Team' });
  expect(trigger.classList.contains('border-tone-danger')).toBe(true);
  expect(trigger.disabled).toBe(true);
  expect(trigger.getAttribute('aria-invalid')).toBe('true');
});
