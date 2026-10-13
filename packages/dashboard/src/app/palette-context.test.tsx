// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { PaletteProvider, usePalette } from './palette-context.js';

afterEach(cleanup);

function Probe() {
  const p = usePalette();
  return (
    <>
      <output data-testid="state">{String(p.isOpen)}</output>
      <button onClick={p.open}>open</button>
      <button onClick={p.close}>close</button>
    </>
  );
}

it('starts closed, opens and closes', async () => {
  const user = userEvent.setup();
  render(
    <PaletteProvider>
      <Probe />
    </PaletteProvider>,
  );
  expect(screen.getByTestId('state').textContent).toBe('false');
  await user.click(screen.getByText('open'));
  expect(screen.getByTestId('state').textContent).toBe('true');
  await user.click(screen.getByText('close'));
  expect(screen.getByTestId('state').textContent).toBe('false');
});

it('throws outside the provider', () => {
  const spy = console.error;
  console.error = () => undefined;
  try {
    expect(() => render(<Probe />)).toThrow(/PaletteProvider/);
  } finally {
    console.error = spy;
  }
});

it('keeps open, close and restoreFocus identities stable across renders', async () => {
  const seen: Array<
    Pick<ReturnType<typeof usePalette>, 'open' | 'close' | 'restoreFocus' | 'closeForNavigation'>
  > = [];
  function Capture() {
    const p = usePalette();
    seen.push({
      open: p.open,
      close: p.close,
      restoreFocus: p.restoreFocus,
      closeForNavigation: p.closeForNavigation,
    });
    return <button onClick={p.open}>open</button>;
  }
  const user = userEvent.setup();
  render(
    <PaletteProvider>
      <Capture />
    </PaletteProvider>,
  );
  await user.click(screen.getByText('open'));
  expect(seen.length).toBeGreaterThan(1);
  for (const s of seen) {
    expect(s.open).toBe(seen[0]?.open);
    expect(s.close).toBe(seen[0]?.close);
    expect(s.restoreFocus).toBe(seen[0]?.restoreFocus);
    expect(s.closeForNavigation).toBe(seen[0]?.closeForNavigation);
  }
});

it('Ctrl-K and Meta-K toggle from anywhere, preventing the default', () => {
  render(
    <PaletteProvider>
      <Probe />
      <input aria-label="field" />
    </PaletteProvider>,
  );
  const field = screen.getByLabelText('field');
  field.focus();
  const press = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true, ...init });
    act(() => {
      field.dispatchEvent(e);
    });
    return e;
  };
  expect(press({ ctrlKey: true }).defaultPrevented).toBe(true);
  expect(screen.getByTestId('state').textContent).toBe('true');
  press({ metaKey: true });
  expect(screen.getByTestId('state').textContent).toBe('false');
  press({ key: 'K', ctrlKey: true });
  expect(screen.getByTestId('state').textContent).toBe('true');
  expect(press({ key: 'k' }).defaultPrevented).toBe(false);
  expect(press({ ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
  expect(screen.getByTestId('state').textContent).toBe('true');
});

it('restoreFocus focuses the opener once, then nothing; navigation skips it', async () => {
  function Restore() {
    const p = usePalette();
    return (
      <>
        <button onClick={p.open}>opener</button>
        <button onClick={p.close}>c</button>
        <button onClick={p.closeForNavigation}>nav</button>
        <button onClick={p.restoreFocus}>restore</button>
      </>
    );
  }
  render(
    <PaletteProvider>
      <Restore />
    </PaletteProvider>,
  );
  const opener = screen.getByText('opener');
  const spy = vi.spyOn(opener, 'focus');
  opener.focus();
  spy.mockClear();
  fireEvent.click(opener);
  fireEvent.click(screen.getByText('c'));
  fireEvent.click(screen.getByText('restore'));
  fireEvent.click(screen.getByText('restore'));
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockClear();
  opener.focus();
  spy.mockClear();
  fireEvent.click(opener);
  fireEvent.click(screen.getByText('nav'));
  fireEvent.click(screen.getByText('restore'));
  expect(spy).not.toHaveBeenCalled();
});
