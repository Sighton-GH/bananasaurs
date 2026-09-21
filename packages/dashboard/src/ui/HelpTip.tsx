import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Pixels of breathing room the note keeps from either viewport edge. */
const VIEWPORT_MARGIN = 8;

/**
 * The "?" help circle that sits next to a label whose meaning or consequence
 * is not obvious on first read (owner request, 2026-09-20: help circles with
 * popup info boxes wherever they help). `label` names the thing explained,
 * so the trigger's accessible name is `Help: <label>`; `children` is the
 * note itself - one or two plain sentences, never interactive content.
 *
 * This is a disclosure, not a tooltip: hover-only help does not exist on
 * touch, so the circle is a real button that toggles on click and tap and
 * through the keyboard like any other button. Escape closes the note and
 * returns focus to the trigger; a pointer down anywhere outside closes it
 * too. Focus stays on the trigger while the note is read, which is why the
 * note must not contain links or controls.
 *
 * After layout the note is clamped into the viewport: a circle near the edge
 * of a 390px phone shifts its note inward instead of letting it run off the
 * screen or cover the field it explains.
 */
export function HelpTip({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [dx, setDx] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) !== true) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Runs before paint so the note never flashes off-screen. The natural
  // centred position comes from transform-free layout values (the wrapper
  // carries no transform, and offsetWidth ignores one), so the computed
  // shift never depends on the one already applied and cannot oscillate.
  useLayoutEffect(() => {
    if (!open) {
      setDx(0);
      return;
    }
    const note = noteRef.current;
    const root = rootRef.current;
    if (note === null || root === null) return;
    const naturalLeft =
      root.getBoundingClientRect().left + root.offsetWidth / 2 - note.offsetWidth / 2;
    const naturalRight = naturalLeft + note.offsetWidth;
    let next = 0;
    if (naturalRight > window.innerWidth - VIEWPORT_MARGIN) {
      next = window.innerWidth - VIEWPORT_MARGIN - naturalRight;
    } else if (naturalLeft < VIEWPORT_MARGIN) {
      next = VIEWPORT_MARGIN - naturalLeft;
    }
    setDx(next);
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex align-middle">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Help: ${label}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        className="mx-0.5 inline-flex size-4 items-center justify-center rounded-full border border-line text-[0.625rem] leading-none text-ink-muted hover:border-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink"
      >
        <span aria-hidden="true">?</span>
      </button>
      {open && (
        <span
          ref={noteRef}
          id={id}
          role="note"
          aria-label={label}
          className="absolute top-full left-1/2 z-40 mt-1 block w-60 max-w-[calc(100vw-1rem)] rounded-md border border-line bg-panel p-2 text-left text-xs font-normal text-ink shadow-lg"
          style={{ transform: `translateX(calc(-50% + ${dx}px))` }}
        >
          {children}
        </span>
      )}
    </span>
  );
}
