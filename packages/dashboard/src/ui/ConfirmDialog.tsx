import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Button } from './Button.js';

/**
 * The Shell's sticky mobile header owns the top of the viewport below lg, so
 * a viewport-centered dialog slides under it (and an over-tall dialog loses
 * its actions off the bottom). Measure the header's bottom edge at runtime -
 * the same approach as the toast stack, no hardcoded height. A hidden header
 * (lg and up, where the Shell uses a side rail) measures 0 and the dialog
 * keeps its classic centered placement.
 */
function measureHeaderInset(): number {
  if (typeof document === 'undefined') return 0;
  const header = document.querySelector('header');
  if (header === null) return 0;
  const bottom = header.getBoundingClientRect().bottom;
  return Number.isFinite(bottom) && bottom > 0 ? Math.ceil(bottom) : 0;
}

function useHeaderInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const update = (): void => setInset(measureHeaderInset());
    update();
    window.addEventListener('resize', update);
    const header = document.querySelector('header');
    const observer =
      header !== null && typeof ResizeObserver === 'function'
        ? new ResizeObserver(update)
        : undefined;
    if (header !== null) observer?.observe(header);
    return () => {
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [active]);
  return active ? inset : 0;
}

/**
 * A destructive or dangerous action states its exact scope before it can be
 * confirmed (`docs/06`). Radix supplies the focus trap, escape handling and
 * ARIA wiring; escape and the backdrop both cancel. The dialog is capped to
 * the viewport (below the measured sticky header on mobile) and scrolls its
 * own content, so the title, scope, children and actions always stay
 * reachable; closing restores focus to the element that opened it. The
 * optional `children`
 * render between the description and the buttons, outside
 * `Dialog.Description` — an ARIA description must not contain interactive
 * content, so a dialog that needs a form control (the review page's
 * suppression value) puts it here.
 */
export function ConfirmDialog({
  open,
  title,
  scope,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  busy,
  onConfirm,
  onCancel,
  children,
  returnFocus,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly scope: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly danger?: boolean;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly children?: ReactNode;
  readonly returnFocus?: () => HTMLElement | null;
}): ReactElement {
  const inset = useHeaderInset(open);
  const anchored = inset > 0;
  // Radix restores focus to Dialog.Trigger on close, but this dialog is
  // controlled and has no trigger, so focus fell back to <body>. Capture the
  // element focused as the dialog opens (before Radix moves focus inside)
  // and restore it on close; every close path (Cancel, Confirm, Escape,
  // backdrop) unmounts Content through the same Radix lifecycle. A detached
  // opener or a programmatic open with nothing focused simply skips the
  // restore.
  const openerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const revealed = useRef(false);
  // Reveal the initially focused action once the final geometry (header inset
  // applied) is in place. Only until the user moves focus themselves, so a
  // later re-measure never steals focus or scroll.
  useEffect(() => {
    if (!open) {
      revealed.current = false;
      return undefined;
    }
    const frame = requestAnimationFrame(() => {
      const content = contentRef.current;
      const active = document.activeElement;
      if (content === null || !(active instanceof HTMLElement) || !content.contains(active)) return;
      if (!revealed.current || active === initialRef.current) {
        if (typeof active.scrollIntoView === 'function') {
          active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
      initialRef.current ??= active;
      revealed.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, inset]);
  const initialRef = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-canvas/70" />
        <Dialog.Content
          ref={contentRef}
          onOpenAutoFocus={() => {
            openerRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const opener = returnFocus?.() ?? openerRef.current;
            openerRef.current = null;
            initialRef.current = null;
            if (opener !== null && opener.isConnected) opener.focus();
          }}
          className={`fixed left-1/2 w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto overscroll-contain rounded-md border border-line bg-panel p-4 text-ink [overflow-wrap:anywhere] ${
            anchored ? '' : 'top-1/2 -translate-y-1/2 max-h-[calc(100dvh-2rem)]'
          }`}
          style={
            anchored
              ? { top: `${inset + 8}px`, maxHeight: `calc(100dvh - ${inset + 16}px)` }
              : undefined
          }
        >
          <Dialog.Title className="text-lg">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 text-sm">{scope}</div>
          </Dialog.Description>
          {children}
          <div className="mt-4 flex flex-col justify-end gap-2 sm:flex-row">
            <Button
              className="min-h-9 min-w-0 max-w-full h-auto! whitespace-normal! [overflow-wrap:anywhere]"
              onClick={onCancel}
              busy={busy === true}
            >
              {cancelLabel}
            </Button>
            <Button
              className="min-h-9 min-w-0 max-w-full h-auto! whitespace-normal! [overflow-wrap:anywhere]"
              variant={danger ? 'danger' : 'primary'}
              onClick={onConfirm}
              busy={busy === true}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
