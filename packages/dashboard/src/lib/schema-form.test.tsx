// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { capsConfig, rapidSpamConfig, keywordFilterConfig } from '@bananasaurs/core';
import { SchemaForm, inspectSchema } from './schema-form.js';
afterEach(cleanup);
describe('SchemaForm', () => {
  it('uses the actual caps schema bounds and preserves hidden keys', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={capsConfig}
        value={{ minLength: 10, maxRatio: 0.8, hidden: { x: 1 } }}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText('Min length');
    expect(input).toHaveProperty('min', '1');
    expect(input).toHaveProperty('max', '4000');
    expect(input).toHaveProperty('step', '1');
    fireEvent.change(input, { target: { value: '20' } });
    expect(onChange).toHaveBeenLastCalledWith({ minLength: 20, maxRatio: 0.8, hidden: { x: 1 } });
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ minLength: '', maxRatio: 0.8, hidden: { x: 1 } });
  });
  it('uses rapid spam milliseconds without changing units', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={rapidSpamConfig}
        value={{ maxMessages: 5, windowMs: 1000 }}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText('Window ms');
    expect(input).toHaveProperty('min', '1000');
    expect(input).toHaveProperty('max', '600000');
    fireEvent.change(input, { target: { value: '2000' } });
    expect(onChange).toHaveBeenCalledWith({ maxMessages: 5, windowMs: 2000 });
  });
  it('does not materialize optional/default keys; clearing removes rather than defaults', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={z.object({ enabled: z.boolean().optional(), count: z.number().default(5) })}
        value={{}}
        onChange={onChange}
      />,
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Count (optional)')).toHaveProperty('value', '');
    fireEvent.click(screen.getByLabelText('Enabled (optional)'));
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Clear count' }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });
  it('reports nested, record, union and refined object schemas as unsupported', () => {
    expect(
      inspectSchema(
        z.object({
          nested: z.object({ x: z.string() }),
          record: z.record(z.string()),
          union: z.union([z.string(), z.number()]),
        }),
      ).unsupported,
    ).toBe(true);
    expect(inspectSchema(z.object({ x: z.string() }).refine(() => true)).unsupported).toBe(true);
  });
  it('recognizes the empty strict keyword schema', () => {
    render(
      <SchemaForm
        schema={keywordFilterConfig}
        emptyMessage="This rule has no settings; its word list is under Lists."
        value={{}}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText('This rule has no settings; its word list is under Lists.'),
    ).toBeTruthy();
  });
  it('renders small enums as radios, large enums as a select, and array row errors', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        schema={z.object({
          mode: z.enum(['a', 'b']),
          many: z.enum(['a', 'b', 'c', 'd', 'e', 'f']),
          words: z.array(z.string()),
        })}
        value={{ mode: 'a', many: 'a', words: ['first'], hidden: 1 }}
        onChange={onChange}
        errors={{ 'words.0': 'Fix this word' }}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'b' }));
    expect(onChange).toHaveBeenCalledWith({ mode: 'b', many: 'a', words: ['first'], hidden: 1 });
    expect(screen.getByRole('combobox')).toBeTruthy();
    expect(screen.getByText('Fix this word')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Words 1'), { target: { value: 'second' } });
    expect(onChange).toHaveBeenCalledWith({ mode: 'a', many: 'a', words: ['second'], hidden: 1 });
  });
});
