// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderedList } from './OrderedList.js';

afterEach(cleanup);

const renderList = (onReorder: (next: readonly string[]) => void) =>
  render(
    <OrderedList
      items={['gemini-2.5-flash', 'gemma-3-27b-it', 'openrouter-model']}
      itemKey={(item) => item}
      renderItem={(item) => <span>{item}</span>}
      onReorder={onReorder}
      label="Model order"
    />,
  );

describe('OrderedList', () => {
  it('labels the first row Primary and the rest Fallback', () => {
    renderList(vi.fn());
    expect(screen.getByText('1 · Primary')).toBeTruthy();
    expect(screen.getByText('2 · Fallback')).toBeTruthy();
    expect(screen.getByText('3 · Fallback')).toBeTruthy();
  });

  it('clicking "Move gemini-2.5-flash down" calls onReorder with the swapped order', () => {
    const onReorder = vi.fn();
    renderList(onReorder);
    fireEvent.click(screen.getByRole('button', { name: 'Move gemini-2.5-flash down' }));
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith([
      'gemma-3-27b-it',
      'gemini-2.5-flash',
      'openrouter-model',
    ]);
  });

  it('disables the first item’s up button and the last item’s down button', () => {
    renderList(vi.fn());
    const up = screen.getByRole('button', { name: 'Move gemini-2.5-flash up' });
    expect(up instanceof HTMLButtonElement && up.disabled).toBe(true);
    const down = screen.getByRole('button', { name: 'Move openrouter-model down' });
    expect(down instanceof HTMLButtonElement && down.disabled).toBe(true);
    const middleDown = screen.getByRole('button', { name: 'Move gemma-3-27b-it down' });
    expect(middleDown instanceof HTMLButtonElement && middleDown.disabled).toBe(false);
  });

  it('works keyboard-only: every move control is a focusable button', () => {
    renderList(vi.fn());
    const buttons = screen.getAllByRole('button', { name: /Move .* (up|down)/ });
    expect(buttons.length).toBe(6);
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.tabIndex).not.toBe(-1);
    }
    const onReorder = vi.fn();
    cleanup();
    renderList(onReorder);
    const target = screen.getByRole('button', { name: 'Move gemma-3-27b-it up' });
    target.focus();
    expect(document.activeElement).toBe(target);
    fireEvent.click(target);
    expect(onReorder).toHaveBeenCalledWith([
      'gemma-3-27b-it',
      'gemini-2.5-flash',
      'openrouter-model',
    ]);
  });

  it('offers a drag handle per row', () => {
    renderList(vi.fn());
    const handles = screen.getAllByTitle('Drag to reorder');
    expect(handles.length).toBe(3);
  });
});

const renderStacked = (onReorder: (next: readonly string[]) => void) =>
  render(
    <OrderedList
      stacked
      items={['gemini-2.5-flash', 'gemma-3-27b-it', 'openrouter-model']}
      itemKey={(item) => item}
      renderItem={(item) => <span>{item}</span>}
      onReorder={onReorder}
      label="Model order"
    />,
  );

describe('OrderedList stacked opt-in (R2 narrow-layout repair)', () => {
  it('keeps the single horizontal row by default', () => {
    renderList(vi.fn());
    const row = screen.getByText('gemini-2.5-flash').closest('li');
    expect(row?.className).not.toContain('flex-wrap');
    const content = screen.getByText('gemini-2.5-flash').parentElement;
    expect(content?.className).toContain('flex-1');
    expect(content?.className).not.toContain('w-full');
    const moveRow = screen.getByRole('button', { name: 'Move gemini-2.5-flash up' }).parentElement;
    expect(moveRow?.className).toBe('flex shrink-0 items-center gap-1');
  });

  it('stacked puts move buttons below full-width content', () => {
    renderStacked(vi.fn());
    const row = screen.getByText('gemini-2.5-flash').closest('li');
    expect(row?.className).toContain('flex-wrap');
    const content = screen.getByText('gemini-2.5-flash').parentElement;
    expect(content?.className).toContain('w-full');
    expect(content?.className).toContain('min-w-0');
    expect(screen.getByText('1 · Primary')).toBeTruthy();
    const moveRow = screen.getByRole('button', { name: 'Move gemini-2.5-flash up' }).parentElement;
    expect(content?.nextElementSibling).toBe(moveRow);
    expect(screen.getAllByTitle('Drag to reorder')).toHaveLength(3);
  });

  it('stacked keeps reorder identity and the disabled edges', () => {
    const onReorder = vi.fn();
    renderStacked(onReorder);
    fireEvent.click(screen.getByRole('button', { name: 'Move gemma-3-27b-it up' }));
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith([
      'gemma-3-27b-it',
      'gemini-2.5-flash',
      'openrouter-model',
    ]);
    const up = screen.getByRole('button', { name: 'Move gemini-2.5-flash up' });
    expect(up instanceof HTMLButtonElement && up.disabled).toBe(true);
    const down = screen.getByRole('button', { name: 'Move openrouter-model down' });
    expect(down instanceof HTMLButtonElement && down.disabled).toBe(true);
  });
});
