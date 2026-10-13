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
  discardFocusTarget,
}: {
  show?: boolean;
  guardEnabled?: boolean;
  dirty: boolean;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /**
   * Focused when Discard unmounts its own button. Defaults to the section
   * heading (or first field) the draft belongs to.
   */
  discardFocusTarget?: () => HTMLElement | null;
}) {
  const guard = useUnsavedGuard(dirty && guardEnabled);
  const discard = (): void => {
    // The SaveBar unmounts with the Discard button; move focus first, while
    // the button and its section are still mounted.
    const scope =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.closest('section, form')
        : null;
    const fallback = scope?.querySelector<HTMLElement>('h1, h2, h3, input, select, textarea');
    const target = discardFocusTarget?.() ?? fallback ?? null;
    if (target !== null) {
      if (/^H[1-6]$/.test(target.tagName)) target.setAttribute('tabindex', '-1');
      target.focus();
    }
    onDiscard();
  };
  return (
    <>
      {guard}
      <SaveBar
        dirtyCount={dirty && show ? 1 : 0}
        busy={busy}
        onSave={onSave}
        onDiscard={discard}
      />
    </>
  );
}
