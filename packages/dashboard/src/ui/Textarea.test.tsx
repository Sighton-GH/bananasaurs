// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Field } from './Field.js';
import { Textarea } from './Textarea.js';
afterEach(cleanup);
it('typing updates a polite count and merges the Field hint', async () => {
  const user = userEvent.setup();
  const input = vi.fn();
  const change = vi.fn();
  render(
    <Field label="Update" hint="What changed?" htmlFor="update">
      <Textarea maxLength={500} showCount onInput={input} onChange={change} />
    </Field>,
  );
  await user.tab();
  const textarea = screen.getByRole('textbox', { name: 'Update' });
  expect(document.activeElement).toBe(textarea);
  await user.keyboard('abc');
  const count = screen.getByText('3 / 500');
  expect(count.getAttribute('aria-live')).toBe('polite');
  expect(count.closest('label')).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Update' })).toBe(textarea);
  const ids = textarea.getAttribute('aria-describedby')?.split(' ') ?? [];
  expect(ids).toContain(count.id);
  expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain('What changed?');
  expect(input).toHaveBeenCalledTimes(3);
  expect(change).toHaveBeenCalledTimes(3);
});
it('controlled values and the strict 90 percent boundary determine the count', () => {
  const { rerender } = render(
    <Textarea aria-label="Update" maxLength={10} showCount value="123456789" onChange={vi.fn()} />,
  );
  expect(screen.getByText('9 / 10').classList.contains('text-tone-hold-ink')).toBe(false);
  rerender(
    <Textarea aria-label="Update" maxLength={10} showCount value="1234567890" onChange={vi.fn()} />,
  );
  expect(screen.getByText('10 / 10').classList.contains('text-tone-hold-ink')).toBe(true);
});
it('defaultValue counts immediately and no counter renders without both props', () => {
  const { rerender } = render(
    <Textarea
      defaultValue="abc"
      maxLength={5}
      showCount
      aria-label="Update"
      aria-describedby="hint"
      aria-invalid
    />,
  );
  expect(screen.getByText('3 / 5')).toBeTruthy();
  expect(screen.getByRole('textbox').classList.contains('border-tone-danger')).toBe(true);
  rerender(<Textarea aria-label="Update" showCount aria-describedby="hint" />);
  expect(screen.queryByText(/\/ 5/)).toBeNull();
  expect(screen.getByRole('textbox').getAttribute('aria-describedby')).toBe('hint');
});

it('standalone count updates with keyboard input and preserves descriptions and callbacks', async () => {
  const user = userEvent.setup();
  const input = vi.fn();
  const change = vi.fn();
  render(
    <>
      <span id="hint">What changed?</span>
      <Textarea
        aria-label="Update"
        aria-describedby="hint"
        maxLength={500}
        showCount
        onInput={input}
        onChange={change}
      />
    </>,
  );
  await user.tab();
  await user.keyboard('abc');
  const textarea = screen.getByRole('textbox', { name: 'Update' });
  const count = screen.getByText('3 / 500');
  expect(count.getAttribute('aria-live')).toBe('polite');
  expect(textarea.getAttribute('aria-describedby')?.split(' ')).toEqual(['hint', count.id]);
  expect(input).toHaveBeenCalledTimes(3);
  expect(change).toHaveBeenCalledTimes(3);
});
