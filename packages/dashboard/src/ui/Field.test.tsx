// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Field, Input } from './Field.js';

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
