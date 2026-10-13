// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Checkbox, Field, Input } from './Field.js';

afterEach(cleanup);

describe('Field', () => {
  it("the control's accessible name is exactly the label", () => {
    render(
      <Field label="Password" hint="At least 12 characters">
        <Input type="password" />
      </Field>,
    );
    const input = screen.getByLabelText('Password');
    expect(input.tagName).toBe('INPUT');
  });

  it('hint and error are attached through aria-describedby and the error sets aria-invalid', () => {
    render(
      <Field label="Password" hint="At least 12 characters" error="Too short">
        <Input type="password" />
      </Field>,
    );
    const input = screen.getByLabelText('Password');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const ids = (describedBy as string).split(' ');
    expect(ids).toHaveLength(2);
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toContain('At least 12 characters');
    expect(texts).toContain('Too short');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('no describedby when neither is given', () => {
    render(
      <Field label="Password">
        <Input type="password" />
      </Field>,
    );
    expect(screen.getByLabelText('Password').getAttribute('aria-describedby')).toBeNull();
  });
});

it('optional is part of the visible and accessible label', () => {
  render(
    <Field label="Name" optional>
      <Input />
    </Field>,
  );
  expect(screen.getByRole('textbox', { name: 'Name (optional)' })).toBeTruthy();
});
it('error uses a danger control border and a decorative error icon', () => {
  render(
    <Field label="Name" error="Enter a name">
      <Input />
    </Field>,
  );
  const input = screen.getByRole('textbox', { name: 'Name' });
  expect(input.classList.contains('border-tone-danger')).toBe(true);
  expect(input.classList.contains('border-line-strong')).toBe(false);
  expect(screen.getByRole('alert').firstElementChild?.getAttribute('aria-hidden')).toBe('true');
});
it('Input handles both aria-invalid forms and its normal border', () => {
  const { rerender } = render(<Input aria-label="Name" aria-invalid="true" />);
  expect(screen.getByRole('textbox').classList.contains('border-tone-danger')).toBe(true);
  rerender(<Input aria-label="Name" aria-invalid="false" />);
  expect(screen.getByRole('textbox').classList.contains('border-line-strong')).toBe(true);
  expect(screen.getByRole('textbox').classList.contains('border-tone-danger')).toBe(false);
});

it('input and checkbox are named and keyboard operable', async () => {
  render(
    <>
      <Field label="Name">
        <Input />
      </Field>
      <Checkbox label="Enabled" />
    </>,
  );
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
  await user.keyboard('Maya');
  expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('Maya');
  await user.tab();
  const checkbox = screen.getByRole('checkbox', { name: 'Enabled' });
  expect(document.activeElement).toBe(checkbox);
  await user.keyboard(' ');
  expect((checkbox as HTMLInputElement).checked).toBe(true);
  expect(checkbox.classList.contains('size-4')).toBe(true);
  expect(checkbox.classList.contains('accent-[var(--color-accent)]')).toBe(true);
});

it('explicit linkage overrides the child id and keeps child content outside the label', () => {
  function Composite(props: {
    id?: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
  }) {
    return (
      <>
        <Input {...props} />
        <span>Extra child content</span>
      </>
    );
  }
  const { container } = render(
    <Field label="Update" htmlFor="update" hint="Hint" error="Error">
      <Composite id="old-id" />
    </Field>,
  );
  const input = screen.getByRole('textbox', { name: 'Update' });
  expect(input.id).toBe('update');
  expect(container.querySelector('label')?.htmlFor).toBe('update');
  expect(input.closest('label')).toBeNull();
  expect(screen.getByText('Extra child content').closest('label')).toBeNull();
  expect(input.getAttribute('aria-invalid')).toBe('true');
  const descriptions = input
    .getAttribute('aria-describedby')
    ?.split(' ')
    .map((id) => document.getElementById(id)?.textContent);
  expect(descriptions).toEqual(['Hint', 'Error']);
});
it('default mode retains the wrapped child, its id and unchanged DOM structure', () => {
  const { container } = render(
    <Field label="Update">
      <Input id="existing" />
    </Field>,
  );
  const input = screen.getByRole('textbox', { name: 'Update' });
  const label = container.querySelector('label');
  expect(input.id).toBe('existing');
  expect(input.parentElement).toBe(label);
  expect(label?.hasAttribute('for')).toBe(false);
  expect(label?.className).toBe('block');
  expect(label?.children).toHaveLength(2);
  expect(label?.firstElementChild?.textContent).toBe('Update');
  expect(label?.firstElementChild?.className).toBe('mb-1 block text-ink-muted');
  expect(container.firstElementChild?.className).toBe('text-sm');
  expect(container.firstElementChild?.children).toHaveLength(1);
});
