// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { ErrorSummary } from '../ui/ErrorSummary.js';
import { Field, Input } from '../ui/Field.js';
import { ApiError } from '../api.js';
import { useFieldErrors } from './useFieldErrors.js';

afterEach(cleanup);
const fieldError = (fields: readonly { path: string; problem: string }[]) =>
  new ApiError(400, { error: 'bad-request', fields });
describe('useFieldErrors', () => {
  it('preserves server instructions, exact paths and server summary order', () => {
    const { result } = renderHook(useFieldErrors);
    let captured = false;
    act(() => {
      captured = result.current.capture(
        fieldError([
          { path: 'links.0.url', problem: 'Enter a URL starting with https://' },
          { path: 'title', problem: 'Enter a task title.' },
        ]),
      );
    });
    expect(captured).toBe(true);
    expect(result.current.errorFor('links.0.url')).toBe('Enter a URL starting with https://');
    expect(result.current.errorFor('links')).toBeUndefined();
    expect(result.current.errorFor('links.0')).toBeUndefined();
    expect(result.current.errorFor('')).toBeUndefined();
    expect(result.current.summary).toEqual([
      { fieldId: 'field-links-0-url', message: 'Enter a URL starting with https://' },
      { fieldId: 'field-title', message: 'Enter a task title.' },
    ]);
  });
  it('makes code-valued problems readable, preserves human text and exact identity', () => {
    const { result } = renderHook(useFieldErrors);
    act(() => {
      result.current.capture(
        fieldError([
          { path: 'title', problem: 'too_small' },
          { path: 'links.0.url', problem: 'invalid_string' },
          { path: 'priority', problem: 'future_code' },
          { path: 'description', problem: 'Keep this human instruction.' },
        ]),
      );
    });
    expect(result.current.errorFor('title')).toBe('Too small.');
    expect(result.current.errorFor('links.0.url')).toBe('Not in the right format.');
    expect(result.current.errorFor('links')).toBeUndefined();
    expect(result.current.errorFor('priority')).toBe('Not valid.');
    expect(result.current.errorFor('description')).toBe('Keep this human instruction.');
    expect(result.current.summary.map((e) => e.message)).toEqual([
      'Too small.',
      'Not in the right format.',
      'Not valid.',
      'Keep this human instruction.',
    ]);
  });
  it('works with Field and ErrorSummary without clearing input, and summary links focus the exact field', () => {
    function Form() {
      const errors = useFieldErrors();
      const [value, setValue] = useState('http://keep-this-draft');
      const error = errors.errorFor('links.0.url');
      return (
        <>
          <ErrorSummary errors={errors.summary} />
          <Field
            label="Link URL"
            htmlFor="field-links-0-url"
            {...(error === undefined ? {} : { error })}
          >
            <Input
              id="field-links-0-url"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
          <button
            onClick={() =>
              errors.capture(
                fieldError([
                  { path: 'links.0.url', problem: 'Enter a URL starting with https://' },
                ]),
              )
            }
          >
            Save
          </button>
        </>
      );
    }
    render(<Form />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const summary = screen
      .getAllByRole('alert')
      .find((element) => element.querySelector('h2') !== null);
    expect(summary).toBeTruthy();
    expect(document.activeElement).toBe(summary);
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Link URL' });
    expect(input.value).toBe('http://keep-this-draft');
    expect(screen.getAllByText('Enter a URL starting with https://')).toHaveLength(2);
    fireEvent.click(screen.getByRole('link', { name: 'Enter a URL starting with https://' }));
    expect(document.activeElement).toBe(input);
  });
  it('replaces stale captures and clears only the requested exact path, or all', () => {
    const { result } = renderHook(useFieldErrors);
    act(() => {
      result.current.capture(fieldError([{ path: 'title', problem: 'Enter a title.' }]));
    });
    act(() => {
      result.current.capture(
        fieldError([
          { path: 'links.0.url', problem: 'Use https://' },
          { path: 'links.1.url', problem: 'Use https:// too' },
        ]),
      );
    });
    expect(result.current.errorFor('title')).toBeUndefined();
    act(() => {
      result.current.clear('links');
    });
    expect(result.current.summary).toHaveLength(2);
    act(() => {
      result.current.clear('links.0.url');
    });
    expect(result.current.summary).toEqual([
      { fieldId: 'field-links-1-url', message: 'Use https:// too' },
    ]);
    expect(result.current.errorFor('links.0.url')).toBeUndefined();
    act(() => {
      result.current.clear();
    });
    expect(result.current.summary).toEqual([]);
  });
  it.each([
    new Error('down'),
    new ApiError(500, { error: 'server' }),
    null,
    undefined,
    42,
    { message: 'unknown' },
    Object.create(null),
  ])('non-field unknown values clear stale errors safely (%s)', (error: unknown) => {
    const { result } = renderHook(useFieldErrors);
    act(() => {
      result.current.capture(fieldError([{ path: 'title', problem: 'Enter a title.' }]));
    });
    let captured = true;
    act(() => {
      captured = result.current.capture(error);
    });
    expect(captured).toBe(false);
    expect(result.current.summary).toEqual([]);
    expect(result.current.errorFor('title')).toBeUndefined();
  });
});
