// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrintOnceDialog } from './PrintOnceDialog.js';

afterEach(cleanup);

function mount(onDone = () => undefined) {
  return render(
    <PrintOnceDialog
      open
      title="Password reset"
      secretLabel="New password"
      secret="synthetic-nonsecret"
      onDone={onDone}
    />,
  );
}

describe('N21 PrintOnceDialog lifecycle (class-level; JSDOM has no layout, native check separate)', () => {
  it('paints above the sticky z-30 page header (overlay and content carry a layer above 30)', () => {
    mount();
    const dialog = screen.getByRole('dialog');
    const layer = (el: Element | null): number => {
      const m = /(?:^|\s)z-\[?(\d+)\]?(?:\s|$)/.exec(el?.getAttribute('class') ?? '');
      return m === null ? 0 : Number(m[1]);
    };
    expect(layer(dialog)).toBeGreaterThan(30);
    const overlay = dialog.previousElementSibling;
    expect(layer(overlay)).toBeGreaterThan(30);
  });

  it('reveals the initially focused action on open', async () => {
    const spy = vi.fn();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- saved only to restore the prototype slot
    const orig = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = spy;
    try {
      mount();
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      expect(spy).toHaveBeenCalled();
      expect(document.activeElement?.textContent).toBe('Copy');
    } finally {
      HTMLElement.prototype.scrollIntoView = orig;
    }
  });

  it('backdrop press does not move focus out of the dialog', () => {
    mount();
    const dialog = screen.getByRole('dialog');
    const overlay = dialog.previousElementSibling as HTMLElement;
    const notPrevented = fireEvent.mouseDown(overlay);
    expect(notPrevented).toBe(false); // default (focus to body) prevented
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('Done restores focus to the connected opener', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(
      <PrintOnceDialog open title="t" secretLabel="l" secret="x" onDone={() => undefined} />,
    );
    rerender(
      <PrintOnceDialog
        open={false}
        title="t"
        secretLabel="l"
        secret={undefined}
        onDone={() => undefined}
      />,
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('reveal runs after focus with nearest options on Copy, once per open (stale frames cancelled)', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.set(++id, cb);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (n: number) => frames.delete(n));
    const calls: Array<{ text: string | null; arg: unknown; focusedAtCall: boolean }> = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- restored below
    const orig = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, arg?: unknown) {
      calls.push({
        text: this.textContent,
        arg,
        focusedAtCall: document.activeElement === this,
      });
    };
    const props = { title: 't', secretLabel: 'l', secret: 'x', onDone: () => undefined };
    try {
      const { rerender } = render(<PrintOnceDialog open {...props} />);
      rerender(<PrintOnceDialog open={false} {...props} secret={undefined} />);
      rerender(<PrintOnceDialog open {...props} />);
      for (const cb of [...frames.values()]) cb(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        text: 'Copy',
        arg: { block: 'nearest', inline: 'nearest' },
        focusedAtCall: true,
      });
    } finally {
      HTMLElement.prototype.scrollIntoView = orig;
      vi.unstubAllGlobals();
    }
  });
});
