// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Badge } from './Badge.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { PrintOnceDialog } from './PrintOnceDialog.js';
import { Select } from './Select.js';
import { ToastProvider, useToast } from './Toast.js';

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalScrollIntoView === undefined) {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  } else {
    Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
  }
});

// Deterministic frames ensure mount's reveal cannot satisfy later focus assertions.
function toastObservationHarness() {
  let nextFrame = 1;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
  const observations: { targets: Element[]; callback: () => void }[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      readonly record: { targets: Element[]; callback: () => void };
      constructor(callback: () => void) {
        this.record = { targets: [], callback };
        observations.push(this.record);
      }
      observe(target: Element) {
        this.record.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        this.record.targets.length = 0;
      }
    },
  );
  let headerBottom = 120;
  const header = document.createElement('header');
  header.getBoundingClientRect = () => ({ bottom: headerBottom }) as DOMRect;
  document.body.append(header);
  const scroll = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute('data-toast-stack')) return { top: 250, height: 100 } as DOMRect;
    if (this.textContent === 'hidden action')
      return { top: 260, bottom: 300, height: 40 } as DOMRect;
    return { top: 150, bottom: 170, height: 20 } as DOMRect;
  });
  function Host() {
    const push = useToast();
    return (
      <>
        <button onClick={() => push({ tone: 'danger', title: 'Refused' })}>push</button>
        <button>hidden action</button>
      </>
    );
  }
  render(
    <ToastProvider>
      <Host />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByText('push'));
  const stack = document.querySelector('[data-toast-stack]') as HTMLElement;
  const flushFrames = () =>
    act(() => {
      const pending = Array.from(frames.values());
      frames.clear();
      for (const callback of pending) callback(0);
    });
  flushFrames();
  scroll.mockClear();
  return {
    frames,
    observations,
    stack,
    header,
    scroll,
    flushFrames,
    setHeaderBottom: (bottom: number) => {
      headerBottom = bottom;
    },
  };
}

describe('R5 geometry (class/behaviour contract only; native layout is rechecked by the lead)', () => {
  it('Badge wraps only when opted in', () => {
    render(
      <>
        <Badge wrap>sentence status</Badge>
        <Badge>plain</Badge>
      </>,
    );
    expect(screen.getByText('sentence status').className).toContain('whitespace-normal');
    expect(screen.getByText('sentence status').className).not.toContain('whitespace-nowrap');
    expect(screen.getByText('plain').className).toContain('whitespace-nowrap');
  });

  it('Select bounds a long value inside the trigger', () => {
    const long = 'x'.repeat(70);
    render(
      <Select
        value={long}
        onValueChange={() => undefined}
        options={[{ value: long, label: long }]}
        aria-label="Guild"
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Guild' });
    expect(trigger.querySelector('span.truncate')?.textContent).toContain(long);
  });

  it('PrintOnce scrolls inside the viewport and returns focus to the opener', () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>opener</button>
          <PrintOnceDialog
            open={open}
            title="Password"
            secretLabel="New password"
            secret="synthetic-nonsecret"
            onDone={() => setOpen(false)}
          />
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByText('opener');
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('overflow-y-auto');
    expect(dialog.className).toContain('max-h-');
    fireEvent.click(screen.getByRole('button', { name: 'I have saved it' }));
    expect(document.activeElement).toBe(opener);
  });

  it('ConfirmDialog reveals the initially focused action', async () => {
    const spy = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: spy,
    });
    render(
      <ConfirmDialog
        open
        title="T"
        scope="s"
        confirmLabel="Go"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(spy).toHaveBeenCalled();
  });

  it('Toast stack reserves bottom padding while shown and releases it', async () => {
    function Push() {
      const push = useToast();
      return <button onClick={() => push({ tone: 'danger', title: 'Failed' })}>go</button>;
    }
    render(
      <ToastProvider>
        <Push />
      </ToastProvider>,
    );
    expect(document.body.style.paddingBottom).toBe('');
    fireEvent.click(screen.getByText('go'));
    expect(document.body.style.paddingBottom).not.toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Failed' }));
    expect(document.body.style.paddingBottom).toBe('');
  });
  it('N17 reserves a focus corridor between measured header and persistent stack, reveals next focus, and restores styles', async () => {
    const header = document.createElement('header');
    header.getBoundingClientRect = () => ({ bottom: 120 }) as DOMRect;
    document.body.append(header);
    document.body.style.paddingBottom = '7px';
    document.documentElement.style.scrollPaddingBottom = '9px';
    const scroll = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute('data-toast-stack')) return { top: 250, height: 100 } as DOMRect;
        if (this.textContent === 'next action') return { top: 260, bottom: 300 } as DOMRect;
        return { top: 0, bottom: 0, height: 0 } as DOMRect;
      });
    function Push() {
      const push = useToast();
      return (
        <>
          <button onClick={() => push({ tone: 'danger', title: 'Refused' })}>push</button>
          <button>next action</button>
        </>
      );
    }
    render(
      <ToastProvider>
        <Push />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('push'));
    const stack = document.querySelector('[data-toast-stack]') as HTMLElement;
    expect(stack.style.maxHeight).toBe('calc(0.5 * (100dvh - 120px - 2rem))');
    screen.getByText('next action').focus();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(scroll).toHaveBeenCalledWith({ top: 58, behavior: 'instant' });
    expect(document.activeElement).toBe(screen.getByText('next action'));
    expect(screen.getByRole('alert').textContent).toContain('Refused');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Refused' }));
    expect(document.body.style.paddingBottom).toBe('7px');
    expect(document.documentElement.style.scrollPaddingBottom).toBe('9px');
    rect.mockRestore();
    header.remove();
    document.body.style.removeProperty('padding-bottom');
    document.documentElement.style.removeProperty('scroll-padding-bottom');
  });
  it('N17 remeasures stack and header resize, ignores toast/modal focus, and disconnects on cleanup', async () => {
    let resize: (() => void) | undefined;
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe = observe;
        disconnect = disconnect;
        unobserve() {}
      },
    );
    let height = 40;
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute('data-toast-stack'))
          return {
            top: 260,
            bottom: 260 + height,
            left: 0,
            right: 100,
            width: 100,
            height,
            x: 0,
            y: 260,
            toJSON: () => ({}),
          };
        return {
          top: 20,
          bottom: 40,
          left: 0,
          right: 100,
          width: 100,
          height: 20,
          x: 0,
          y: 20,
          toJSON: () => ({}),
        };
      });
    const scroll = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    function Push() {
      const push = useToast();
      return <button onClick={() => push({ tone: 'hold', title: 'Waiting' })}>push</button>;
    }
    render(
      <ToastProvider>
        <Push />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('push'));
    expect(document.documentElement.style.scrollPaddingBottom).toBe('64px');
    height = 90;
    act(() => {
      resize?.();
    });
    expect(document.documentElement.style.scrollPaddingBottom).toBe('114px');
    screen.getByRole('button', { name: 'Dismiss: Waiting' }).focus();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(scroll).not.toHaveBeenCalled();
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('data-state', 'open');
    const input = document.createElement('input');
    modal.append(input);
    document.body.append(modal);
    input.focus();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(scroll).not.toHaveBeenCalled();
    modal.remove();
    cleanup();
    expect(disconnect).toHaveBeenCalled();
    expect(document.body.style.paddingBottom).toBe('');
    expect(document.documentElement.style.scrollPaddingBottom).toBe('');
    expect(observe).toHaveBeenCalled();
    rect.mockRestore();
    vi.unstubAllGlobals();
  });
  it('N17 primary action pairs fit the measured corridor without hiding a persistent refusal (synthetic bounds only)', async () => {
    const scroll = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    const header = document.createElement('header');
    header.getBoundingClientRect = () => ({ bottom: 183 }) as DOMRect;
    document.body.append(header);
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute('data-toast-stack')) return { top: 280, height: 60 } as DOMRect;
        if (this.textContent === 'Save' || this.textContent === 'Keep my text')
          return { top: 195, bottom: 224, height: 29 } as DOMRect;
        return { top: 232, bottom: 261, height: 29 } as DOMRect;
      });
    function Push() {
      const push = useToast();
      return (
        <>
          <button
            onClick={() => push({ tone: 'danger', title: 'That channel cannot receive messages' })}
          >
            push
          </button>
          <button>Save</button>
          <button>Discard</button>
          <button>Keep my text</button>
          <button>Use theirs</button>
        </>
      );
    }
    render(
      <ToastProvider>
        <Push />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('push'));
    for (const label of ['Save', 'Discard', 'Keep my text', 'Use theirs']) {
      screen.getByText(label).focus();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(document.activeElement).toBe(screen.getByText(label));
      expect(screen.getByRole('alert').textContent).toContain(
        'That channel cannot receive messages',
      );
    }
    expect(scroll).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Dismiss: That channel cannot receive messages' }),
    ).toBeTruthy();
    rect.mockRestore();
    header.remove();
  });
  it('N17 focusin reveals a newly focused hidden action after all mount frames finish', () => {
    const h = toastObservationHarness();
    try {
      expect(h.frames.size).toBe(0);
      screen.getByText('hidden action').focus();
      h.flushFrames();
      expect(h.scroll).toHaveBeenCalledExactlyOnceWith({ top: 58, behavior: 'instant' });
      expect(document.activeElement).toBe(screen.getByText('hidden action'));
    } finally {
      cleanup();
      h.header.remove();
      vi.unstubAllGlobals();
    }
  });

  it('N17 stack observer explicitly observes the header and remeasures on its resize', () => {
    const h = toastObservationHarness();
    try {
      const stackObserver = h.observations.find((o) => o.targets.includes(h.stack));
      expect(stackObserver).toBeDefined();
      expect(stackObserver?.targets).toContain(h.header);
      screen.getByText('hidden action').focus();
      h.flushFrames();
      h.scroll.mockClear();
      h.setHeaderBottom(275);
      act(() => {
        stackObserver?.callback();
      });
      h.flushFrames();
      // The corridor is now impossible: do not scroll between opposing edges.
      expect(h.scroll).not.toHaveBeenCalled();
    } finally {
      cleanup();
      h.header.remove();
      vi.unstubAllGlobals();
    }
  });

  it('N17 cleanup cancels the pending focus reveal frame before it can scroll', () => {
    const h = toastObservationHarness();
    try {
      screen.getByText('hidden action').focus();
      const pending = [...h.frames.keys()];
      expect(pending).toHaveLength(1);
      cleanup();
      for (const id of pending) expect(h.frames.has(id)).toBe(false);
      h.flushFrames();
      expect(h.scroll).not.toHaveBeenCalled();
    } finally {
      cleanup();
      h.header.remove();
      vi.unstubAllGlobals();
    }
  });
});
