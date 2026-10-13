// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { renderToString } from 'react-dom/server';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ToastProvider, useToast } from './Toast.js';

afterEach(cleanup);

function Trigger() {
  const toast = useToast();
  return (
    <>
      <button onClick={() => toast({ tone: 'ok', title: 'Saved' })}>ok</button>
      <button onClick={() => toast({ tone: 'neutral', title: 'FYI' })}>neutral</button>
      <button onClick={() => toast({ tone: 'danger', title: 'Failed', message: 'why' })}>
        danger
      </button>
      <button onClick={() => toast({ tone: 'hold', title: 'Paused' })}>hold</button>
    </>
  );
}

describe('toasts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders ok into a polite live region, and an ok toast leaves on its own', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('ok'));
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toContain('Saved');
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(region.textContent).not.toContain('Saved');
  });

  it('renders no role=alert region when there are no assertive toasts', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByText('ok'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Saved');
  });

  it('danger and hold toasts render into an assertive role=alert region and stay', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('danger'));
    fireEvent.click(screen.getByText('hold'));
    const region = screen.getByRole('alert');
    expect(region.textContent).toContain('why');
    expect(region.textContent).toContain('Paused');
    expect(screen.getByRole('status').textContent).not.toContain('why');
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(region.textContent).toContain('why');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Failed' }));
    expect(region.textContent).not.toContain('Failed');
  });

  it('ok and neutral toasts live in the polite region and auto-dismiss after 6 s', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('neutral'));
    const region = screen.getByRole('status');
    expect(region.textContent).toContain('FYI');
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(region.textContent).not.toContain('FYI');
  });

  it('a toast action calls onClick and dismisses the toast', () => {
    const onUndo = vi.fn();
    function ActionTrigger() {
      const toast = useToast();
      return (
        <button
          onClick={() =>
            toast({ tone: 'ok', title: 'Archived', action: { label: 'Undo', onClick: onUndo } })
          }
        >
          go
        </button>
      );
    }
    render(
      <ToastProvider>
        <ActionTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('go'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(screen.getByRole('status').textContent).not.toContain('Archived');
  });

  it('an ok toast with an action stays for 10 s rather than 6', () => {
    const onUndo = vi.fn();
    function ActionTrigger() {
      const toast = useToast();
      return (
        <button
          onClick={() =>
            toast({ tone: 'ok', title: 'Archived', action: { label: 'Undo', onClick: onUndo } })
          }
        >
          go
        </button>
      );
    }
    render(
      <ToastProvider>
        <ActionTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('go'));
    const region = screen.getByRole('status');
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(region.textContent).toContain('Archived');
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(region.textContent).not.toContain('Archived');
  });

  it('bounds the desktop-width stack to the viewport including both edge gaps', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('danger'));
    const stack = screen.getByRole('status').parentElement;
    expect(stack?.classList.contains('w-80')).toBe(true);
    expect(stack?.classList.contains('right-4')).toBe(true);
    expect(stack?.classList.contains('max-w-[calc(100%-2rem)]')).toBe(true);
  });

  it('lets toast cards and text shrink and wrap without shrinking the dismiss button', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('danger'));
    const title = screen.getByText('Failed');
    const content = screen.getByText('why').parentElement;
    const card = screen.getByRole('alert').firstElementChild;
    expect(card?.classList.contains('min-w-0')).toBe(true);
    expect(content?.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
    expect(title.classList.contains('min-w-0')).toBe(true);
    expect(title.classList.contains('flex-1')).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Dismiss: Failed' }).classList.contains('shrink-0'),
    ).toBe(true);
  });

  it('gives the title its own row before the fixed dismiss target at narrow widths', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('danger'));
    const title = screen.getByText('Failed');
    const header = title.parentElement;
    const dismiss = screen.getByRole('button', { name: 'Dismiss: Failed' });
    expect(header?.classList.contains('flex-col')).toBe(true);
    expect(header?.classList.contains('sm:flex-row')).toBe(true);
    expect(header?.classList.contains('items-stretch')).toBe(true);
    expect(title.classList.contains('min-w-0')).toBe(true);
    expect(title.classList.contains('flex-1')).toBe(true);
    expect(dismiss.classList.contains('shrink-0')).toBe(true);
    expect(dismiss.classList.contains('self-end')).toBe(true);
  });

  it('useToast outside the provider throws', () => {
    expect(() => render(<Trigger />)).toThrow(/inside <ToastProvider>/);
  });
});

// Real timers in this block: userEvent needs to schedule its own delays.
describe('toast keyboard operation', () => {
  beforeEach(() =>
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    ),
  );
  afterEach(() => vi.unstubAllGlobals());

  it('the action button tabs into focus and activates on Enter', async () => {
    const onUndo = vi.fn();
    function ActionTrigger() {
      const toast = useToast();
      return (
        <button
          onClick={() =>
            toast({ tone: 'ok', title: 'Archived', action: { label: 'Undo', onClick: onUndo } })
          }
        >
          go
        </button>
      );
    }
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ActionTrigger />
      </ToastProvider>,
    );
    await user.click(screen.getByText('go'));
    await user.tab();
    const dismiss = screen.getByRole('button', { name: 'Dismiss: Archived' });
    expect(document.activeElement).toBe(dismiss);
    expect((await screen.findByRole('tooltip')).textContent).toBe('Dismiss');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }));
    await user.keyboard('{Enter}');
    expect(onUndo).toHaveBeenCalledOnce();
    expect(screen.queryByText('Archived')).toBeNull();
  });

  it('the dismiss button activates on Enter', async () => {
    function DangerTrigger() {
      const toast = useToast();
      return <button onClick={() => toast({ tone: 'danger', title: 'Failed' })}>fire</button>;
    }
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <DangerTrigger />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss: Failed' }));
    await user.keyboard('{Enter}');
    expect(screen.queryByText('Failed')).toBeNull();
  });
});

describe('toast stack vertical containment (round 7-8)', () => {
  const longTitle = 'The action could not be saved because the reference changed underneath it';
  const message = 'SEEDED LOCAL DATA. Nothing was changed.';
  const detail = 'sample-reference · HTTP 503 · request seeded-001';
  const onUndoA = vi.fn();
  const onUndoB = vi.fn();

  function TwoLong() {
    const toast = useToast();
    return (
      <button
        onClick={() => {
          toast({
            tone: 'hold',
            title: `Hold: ${longTitle}`,
            message,
            detail,
            action: { label: 'Undo hold', onClick: onUndoA },
          });
          toast({
            tone: 'danger',
            title: longTitle,
            message,
            detail,
            action: { label: 'Undo danger', onClick: onUndoB },
          });
        }}
      >
        fire
      </button>
    );
  }

  beforeEach(() => {
    onUndoA.mockClear();
    onUndoB.mockClear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('caps the stack to the viewport height and scrolls inside it', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TwoLong />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    const stack = screen.getByRole('alert').parentElement;
    expect(stack?.classList.contains('max-h-[calc(100dvh-2rem)]')).toBe(true);
    expect(stack?.classList.contains('overflow-y-auto')).toBe(true);
    expect(stack?.classList.contains('overscroll-contain')).toBe(true);
  });

  it('never flex-shrinks a card, so a long card scrolls rather than squashing', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TwoLong />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    for (const el of screen.getByRole('alert').children) {
      expect(el.classList.contains('shrink-0')).toBe(true);
    }
  });

  it('never flex-shrinks the assertive live-region wrapper', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TwoLong />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    expect(screen.getByRole('alert').classList.contains('shrink-0')).toBe(true);
  });

  it('never flex-shrinks the polite live-region wrapper', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TwoLong />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    expect(screen.getByRole('status').classList.contains('shrink-0')).toBe(true);
  });

  it('puts the icon on its own row at narrow widths so text uses the full card width', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TwoLong />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    const title = screen.getByText(longTitle);
    const content = title.parentElement?.parentElement as HTMLElement;
    const row = content.parentElement as HTMLElement;
    expect(row.classList.contains('flex-col')).toBe(true);
    expect(row.classList.contains('sm:flex-row')).toBe(true);
    expect(content.classList.contains('min-w-0')).toBe(true);
    expect(content.classList.contains('sm:flex-1')).toBe(true);
    expect(row.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(row.firstElementChild?.classList.contains('self-start')).toBe(true);
  });

  it('does not sit above the sticky header: no z-layer on the stack', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TwoLong />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    const stack = screen.getByRole('alert').parentElement;
    expect(Array.from(stack?.classList ?? []).some((c) => /^z-/.test(c))).toBe(false);
  });

  it('keeps below a measured sticky header and caps its height to the space left', async () => {
    const header = document.createElement('header');
    header.getBoundingClientRect = () => ({ bottom: 270 }) as DOMRect;
    document.body.appendChild(header);
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TwoLong />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    const stack = screen.getByRole('alert').parentElement as HTMLElement;
    expect(stack.style.maxHeight).toBe('calc(0.5 * (100dvh - 270px - 2rem))');
    header.remove();
  });

  it('falls back to the viewport cap when there is no header or it is hidden', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TwoLong />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    const stack = screen.getByRole('alert').parentElement as HTMLElement;
    expect(stack.style.maxHeight).toBe('calc(0.5 * (100dvh - 0px - 2rem))');
    expect(stack.classList.contains('max-h-[calc(100dvh-2rem)]')).toBe(true);
    cleanup();
    const hidden = document.createElement('header');
    hidden.getBoundingClientRect = () => ({ bottom: 0 }) as DOMRect;
    document.body.appendChild(hidden);
    render(
      <ToastProvider>
        <TwoLong />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    expect((screen.getByRole('alert').parentElement as HTMLElement).style.maxHeight).toBe(
      'calc(0.5 * (100dvh - 0px - 2rem))',
    );
    hidden.remove();
  });

  it('reaches both long cards by keyboard in order and runs each Undo', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TwoLong />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: `Dismiss: Hold: ${longTitle}` }),
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo hold' }));
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: `Dismiss: ${longTitle}` }),
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo danger' }));
    await user.keyboard('{Enter}');
    expect(onUndoB).toHaveBeenCalledOnce();
    await user.tab(); // focus fell to the document; first stop is the page button
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo hold' }));
    await user.keyboard('{Enter}');
    expect(onUndoA).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('toast round 8: SSR, observers, modal isolation', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders on the server with no window (SSR-safe media query initialisation)', () => {
    vi.stubGlobal('window', undefined);
    const html = renderToString(
      <ToastProvider>
        <p>page</p>
      </ToastProvider>,
    );
    expect(html).toContain('page');
  });

  it('disconnects the header observer and removes the resize listener on dismissal', async () => {
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect = disconnect;
      },
    );
    const header = document.createElement('header');
    header.getBoundingClientRect = () => ({ bottom: 100 }) as DOMRect;
    document.body.appendChild(header);
    const remove = vi.spyOn(window, 'removeEventListener');
    function One() {
      const toast = useToast();
      return <button onClick={() => toast({ tone: 'danger', title: 'Failed' })}>one</button>;
    }
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <One />
      </ToastProvider>,
    );
    await user.click(screen.getByText('one'));
    await user.click(screen.getByRole('button', { name: 'Dismiss: Failed' }));
    expect(disconnect).toHaveBeenCalled();
    expect(remove.mock.calls.some(([type]) => type === 'resize')).toBe(true);
    header.remove();
  });

  it('adds no overlay and no element when there are no toasts', () => {
    render(
      <ToastProvider>
        <p>page</p>
      </ToastProvider>,
    );
    expect(
      document.querySelector('[data-toast-stack]')?.childElementCount ?? 0,
    ).toBeLessThanOrEqual(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('closes an open Dismiss tooltip and keeps it closed while a dialog is open', async () => {
    function WithDialog() {
      const toast = useToast();
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => toast({ tone: 'danger', title: 'Failed', message: 'LOCAL DATA' })}>
            fire
          </button>
          <button onClick={() => setOpen(true)}>ask</button>
          <ConfirmDialog
            open={open}
            title="Sure?"
            scope="scope text"
            confirmLabel="Go"
            onConfirm={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <WithDialog />
      </ToastProvider>,
    );
    await user.click(screen.getByText('fire'));
    await user.tab();
    await user.tab();
    await user.tab();
    const dismiss = screen.getByRole('button', { name: 'Dismiss: Failed' });
    await user.hover(dismiss);
    expect(await screen.findByRole('tooltip')).toBeTruthy();
    // open the dialog programmatically while the tooltip is showing
    await act(async () => {
      screen.getByText('ask').click();
    });
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('still opens the tooltip on focus when no dialog is open', async () => {
    function One() {
      const toast = useToast();
      return <button onClick={() => toast({ tone: 'danger', title: 'Failed' })}>one</button>;
    }
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <One />
      </ToastProvider>,
    );
    await user.click(screen.getByText('one'));
    await user.tab();
    expect((await screen.findByRole('tooltip')).textContent).toBe('Dismiss');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
});
