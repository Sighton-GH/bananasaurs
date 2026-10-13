// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolArguments } from './tool-arguments.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('authorized trace argument shapes', () => {
  it.each([
    ['scalar', 'redacted', '"redacted"'],
    ['array', [1, 'visible'], '[\n  1,\n  "visible"\n]'],
    ['null', null, 'null'],
  ])('copies %s without inventing fields', async (_label, args, text) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<ToolArguments args={args} name="lookup" call={1} />);
    expect(screen.queryByRole('rowheader')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show raw' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(text);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });
  it('distinguishes absent arguments from an empty authorized object', () => {
    const view = render(<ToolArguments args={undefined} name="lookup" call={1} />);
    expect(screen.getByText('No arguments were recorded.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    view.rerender(<ToolArguments args={{}} name="lookup" call={1} />);
    expect(screen.getByText('No arguments were supplied.')).toBeTruthy();
    expect(screen.queryByRole('rowheader')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show raw' }));
    expect(screen.getByText('{}')).toBeTruthy();
  });
});
