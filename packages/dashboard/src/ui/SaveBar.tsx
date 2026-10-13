import type { ReactElement } from 'react';
import { Button } from './Button.js';

/** Stays in page flow so controls above it remain reachable when space is tight. */
export function SaveBar({
  dirtyCount,
  onSave,
  onDiscard,
  busy = false,
}: {
  dirtyCount: number;
  onSave: () => void;
  onDiscard: () => void;
  busy?: boolean;
}): ReactElement | null {
  if (dirtyCount === 0) return null;
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className="sticky bottom-0 flex min-w-0 flex-wrap items-center gap-3 rounded-panel border border-line bg-panel p-3 text-body text-ink"
    >
      <p aria-live="polite" className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {dirtyCount} unsaved {dirtyCount === 1 ? 'change' : 'changes'}
      </p>
      <div className="flex min-w-0 max-w-full flex-wrap gap-2">
        <Button onClick={onDiscard} busy={busy}>
          Discard
        </Button>
        <Button variant="primary" onClick={onSave} busy={busy}>
          Save
        </Button>
      </div>
    </div>
  );
}
