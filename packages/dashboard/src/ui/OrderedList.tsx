import {
  useEffect,
  useLayoutEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Badge } from './Badge.js';

export interface OrderedListProps<T> {
  readonly items: readonly T[];
  readonly itemKey: (item: T) => string;
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly onReorder: (next: readonly T[]) => void;
  /** Accessible name for the list itself. */
  readonly label: string;
  /**
   * Plain words naming one row inside the move buttons' accessible names.
   * Defaults to the row's key.
   */
  readonly itemLabel?: ((item: T, index: number) => string) | undefined;
  /**
   * Opt-in narrow layout: the drag handle and badge precede full-width content,
   * with move buttons wrapping below it, so a row fits a narrow viewport.
   * Defaults to the single horizontal row.
   */
  readonly stacked?: boolean | undefined;
}

/** How long a keyboard move waits for the controlled parent to commit the
 *  new order before its focus restore expires. */
const FOCUS_RESTORE_TIMEOUT_MS = 1000;

/**
 * A keyboard-first ordered list with drag handles (ADR 0075).
 *
 * Every row carries ▲/▼ buttons named `Move <row> up/down` — real buttons,
 * so reordering works keyboard-only — plus an HTML5 drag handle for the
 * mouse. The first row is badged `1 · Primary`, the rest `N · Fallback`.
 */
export function OrderedList<T>({
  items,
  itemKey,
  renderItem,
  onReorder,
  label,
  itemLabel,
  stacked = false,
}: OrderedListProps<T>) {
  const nameOf = (item: T, index: number): string => itemLabel?.(item, index) ?? itemKey(item);
  const dragFrom = useRef<number | undefined>(undefined);

  // N15: a keyboard-activated move reinserts the moved row's DOM node (React
  // moves that row, not its sibling, on a down-move) and can disable the
  // pressed button at a list edge. Both drop focus to BODY. Remember the
  // keyboard activation here and restore focus once the controlled parent
  // commits the new order.
  //
  // Focus restore policy:
  // - KEYBOARD ONLY. Pointer clicks (event.detail !== 0) and drag reorder
  //   never schedule a restore: platforms disagree on whether a click focuses
  //   a button (Safari/Firefox on macOS do not), so restoring after a pointer
  //   click could move focus the user never had.
  // - Same control when it stays enabled; when the move disables the pressed
  //   button at a list edge, focus the moved item's opposite-direction
  //   control, which the move just enabled (documented edge policy).
  // - Removed item: the parent answered the reorder by dropping the row, so
  //   focus the first enabled move control still in the list.
  // - Never steal: if the user focused anything else - another row's
  //   controls, a rendered input - or pressed any pointer button before the
  //   commit lands, or the restore window expires, leave focus where it is.
  const listRef = useRef<HTMLOListElement | null>(null);
  const pendingFocus = useRef<{
    key: string;
    item: T;
    direction: 'up' | 'down';
    from: number;
    source: HTMLButtonElement;
    lastFocus: Element | null;
    activatedAt: number;
  } | null>(null);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelListeners = useRef<(() => void) | undefined>(undefined);

  const clearPending = (): void => {
    pendingFocus.current = null;
    if (expiryTimer.current !== undefined) {
      clearTimeout(expiryTimer.current);
      expiryTimer.current = undefined;
    }
    if (cancelListeners.current !== undefined) {
      cancelListeners.current();
      cancelListeners.current = undefined;
    }
  };

  // Drop refs and listeners on unmount even when the parent never commits.
  useEffect(() => clearPending, []);

  /** The up/down buttons of one rendered row: the move container is the row's
   *  last child in both layouts, and renderItem content lives in its own div. */
  const moveButtonsOf = (
    row: Element | undefined,
  ): { up: HTMLButtonElement | undefined; down: HTMLButtonElement | undefined } => {
    const container = row?.lastElementChild;
    const buttons = container?.querySelectorAll('button');
    const [up, down] = buttons ?? [];
    return {
      up: up instanceof HTMLButtonElement ? up : undefined,
      down: down instanceof HTMLButtonElement ? down : undefined,
    };
  };

  const move = (from: number, to: number, event?: ReactMouseEvent<HTMLButtonElement>): void => {
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [taken] = next.splice(from, 1);
    if (taken === undefined) return;
    next.splice(to, 0, taken);
    // event.detail === 0 marks a keyboard-generated click (Enter/Space).
    if (event !== undefined && event.detail === 0) {
      clearPending(); // at most one pending restore
      pendingFocus.current = {
        key: itemKey(taken),
        item: taken,
        direction: to < from ? 'up' : 'down',
        from,
        source: event.currentTarget,
        lastFocus: document.activeElement,
        activatedAt: Date.now(),
      };
      // A pointerdown before the commit cancels the restore: clicking blank
      // space (which drops focus to BODY) or clicking another control must
      // not be overridden by a stale keyboard restore. Focus moves are
      // tracked so the guard below can tell "user tabbed between the moved
      // item's move buttons" from "user focused anything else".
      const onPointerDown = (): void => clearPending();
      const onFocusIn = (focusEvent: Event): void => {
        if (pendingFocus.current !== null) {
          pendingFocus.current.lastFocus =
            focusEvent.target instanceof Element ? focusEvent.target : null;
        }
      };
      document.addEventListener('pointerdown', onPointerDown, { capture: true });
      document.addEventListener('focusin', onFocusIn, { capture: true });
      cancelListeners.current = () => {
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('focusin', onFocusIn, true);
      };
      expiryTimer.current = setTimeout(clearPending, FOCUS_RESTORE_TIMEOUT_MS + 50);
    }
    onReorder(next);
  };

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null) return;
    if (Date.now() - pending.activatedAt > FOCUS_RESTORE_TIMEOUT_MS) {
      clearPending(); // expired: never steal focus later
      return;
    }
    const list = listRef.current;
    if (list === null) {
      clearPending();
      return;
    }
    // The committed reorder places the moved item exactly one position over.
    // Identity first: only the moved object itself proves the commit. A key
    // match is the fallback for parents that rebuild item objects, and it is
    // consulted only once the moved object's identity has vanished from both
    // endpoints - otherwise a distinct same-key row (duplicate keys) or a
    // same-order interim render would consume the restore.
    const matchesKey = (item: T | undefined): boolean =>
      item !== undefined && itemKey(item) === pending.key;
    const expected = pending.direction === 'up' ? pending.from - 1 : pending.from + 1;
    const inRange = (index: number): boolean => index >= 0 && index < items.length;
    let committed = inRange(expected) && items[expected] === pending.item;
    let waiting = !committed && inRange(pending.from) && items[pending.from] === pending.item;
    if (!committed && !waiting) {
      committed = inRange(expected) && matchesKey(items[expected]);
      waiting = !committed && inRange(pending.from) && matchesKey(items[pending.from]);
    }
    if (waiting) return; // order not committed yet: keep waiting

    let target: HTMLButtonElement | undefined;
    if (committed) {
      const refs = moveButtonsOf(list.children[expected]);
      // Never steal focus: restore only when both the current and the most
      // recently focused element are the pressed button, BODY (focus dropped
      // by the row reinsertion), or the moved item's own move buttons.
      const acceptable = (el: Element | null): boolean =>
        el === null ||
        el === document.body ||
        el === pending.source ||
        el === refs.up ||
        el === refs.down;
      if (acceptable(document.activeElement) && acceptable(pending.lastFocus)) {
        const same = pending.direction === 'up' ? refs.up : refs.down;
        const other = pending.direction === 'up' ? refs.down : refs.up;
        target = same !== undefined && !same.disabled ? same : other;
      }
    } else if (!items.some((item) => item === pending.item || matchesKey(item))) {
      // Removed-item fallback: the parent answered the reorder by dropping the
      // row, so focus the first enabled move control still in the list.
      const acceptable = (el: Element | null): boolean =>
        el === null || el === document.body || el === pending.source;
      if (acceptable(document.activeElement) && acceptable(pending.lastFocus)) {
        for (const row of list.children) {
          const refs = moveButtonsOf(row);
          target =
            refs.up !== undefined && !refs.up.disabled
              ? refs.up
              : refs.down !== undefined && !refs.down.disabled
                ? refs.down
                : undefined;
          if (target !== undefined) break;
        }
      }
    }
    // Any other outcome means an unrelated change moved the item: no steal.
    clearPending();
    if (target === undefined || target.disabled || !target.isConnected) return;
    target.focus({ preventScroll: true });
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'nearest' });
    }
    // Reveal the focus ring below the page header: prefer the sticky/fixed
    // header (the one that actually overlays content) and use its measured
    // bottom edge, since the height changes with zoom, wrapping and banners.
    // Fall back to the first header when none is positioned.
    let headerBottom: number | undefined;
    const headers = document.querySelectorAll('header');
    for (const header of headers) {
      const position = getComputedStyle(header).position;
      if (position === 'sticky' || position === 'fixed') {
        const bottom = header.getBoundingClientRect().bottom;
        headerBottom = headerBottom === undefined ? bottom : Math.max(headerBottom, bottom);
      }
    }
    const firstHeader = headers[0];
    if (headerBottom === undefined && firstHeader !== undefined) {
      headerBottom = firstHeader.getBoundingClientRect().bottom;
    }
    if (headerBottom !== undefined) {
      const clearance = headerBottom + 4;
      const top = target.getBoundingClientRect().top;
      if (top < clearance) window.scrollBy({ top: top - clearance });
    }
  });

  return (
    <ol ref={listRef} aria-label={label} className="grid gap-2">
      {items.map((item, index) => {
        const name = nameOf(item, index);
        return (
          <li
            key={itemKey(item)}
            className={`flex items-center gap-2 rounded-sm border border-line bg-canvas px-2 py-1.5${stacked ? ' flex-wrap' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const from = dragFrom.current;
              dragFrom.current = undefined;
              if (from !== undefined && from !== index) move(from, index);
            }}
          >
            <span
              draggable
              title="Drag to reorder"
              aria-hidden="true"
              className="cursor-grab touch-none select-none text-ink-muted"
              onDragStart={(event) => {
                dragFrom.current = index;
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                dragFrom.current = undefined;
              }}
            >
              ⋮⋮
            </span>
            <Badge tone={index === 0 ? 'ok' : 'neutral'}>
              {index === 0 ? '1 · Primary' : `${String(index + 1)} · Fallback`}
            </Badge>
            <div className={stacked ? 'min-w-0 w-full' : 'min-w-0 flex-1'}>
              {renderItem(item, index)}
            </div>
            <div
              className={stacked ? 'flex items-center gap-1' : 'flex shrink-0 items-center gap-1'}
            >
              <button
                type="button"
                aria-label={`Move ${name} up`}
                disabled={index === 0}
                onClick={(event) => move(index, index - 1, event)}
                className="rounded-sm border border-line px-2 py-0.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                ▲
              </button>
              <button
                type="button"
                aria-label={`Move ${name} down`}
                disabled={index === items.length - 1}
                onClick={(event) => move(index, index + 1, event)}
                className="rounded-sm border border-line px-2 py-0.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                ▼
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
