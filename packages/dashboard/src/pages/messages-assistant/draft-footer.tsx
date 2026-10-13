import { SaveBar } from '../../ui/SaveBar.js';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard.js';
/** One existing write boundary. Discard is local, never Reset/Delete. */
export function DraftFooter({
  dirty,
  busy,
  onSave,
  onDiscard,
  show = true,
  guardEnabled = true,
}: {
  show?: boolean;
  guardEnabled?: boolean;
  dirty: boolean;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const guard = useUnsavedGuard(dirty && guardEnabled);
  return (
    <>
      {guard}
      <SaveBar
        dirtyCount={dirty && show ? 1 : 0}
        busy={busy}
        onSave={onSave}
        onDiscard={onDiscard}
      />
    </>
  );
}
