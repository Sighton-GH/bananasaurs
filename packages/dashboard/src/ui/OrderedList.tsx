import { useRef, type ReactNode } from 'react';
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
}

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
}: OrderedListProps<T>) {
  const nameOf = (item: T, index: number): string => itemLabel?.(item, index) ?? itemKey(item);
  const dragFrom = useRef<number | undefined>(undefined);

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [taken] = next.splice(from, 1);
    if (taken === undefined) return;
    next.splice(to, 0, taken);
    onReorder(next);
  };

  return (
    <ol aria-label={label} className="grid gap-2">
      {items.map((item, index) => {
        const name = nameOf(item, index);
        return (
          <li
            key={itemKey(item)}
            className="flex items-center gap-2 rounded-sm border border-line bg-canvas px-2 py-1.5"
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
            <div className="min-w-0 flex-1">{renderItem(item, index)}</div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label={`Move ${name} up`}
                disabled={index === 0}
                onClick={() => move(index, index - 1)}
                className="rounded-sm border border-line px-2 py-0.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                ▲
              </button>
              <button
                type="button"
                aria-label={`Move ${name} down`}
                disabled={index === items.length - 1}
                onClick={() => move(index, index + 1)}
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
