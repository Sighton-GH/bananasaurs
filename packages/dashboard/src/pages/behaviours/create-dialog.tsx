import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import type { AssistantData } from '../../api/assistant.js';
import type { Session } from '../../app/session.js';
import { CreateBehaviourForm } from './create.js';

/**
 * New behaviour in a dialog. The form and its PUT create body are the
 * existing `CreateBehaviourForm`, unchanged; this only frames it. Escape,
 * the backdrop and Cancel all close without creating anything.
 */
export function NewBehaviourDialog({
  data,
  session,
  onCreated,
  onCancel,
}: {
  readonly data: AssistantData;
  readonly session: Session;
  readonly onCreated: (id: string) => void;
  readonly onCancel: () => void;
}) {
  // This conditional dialog has no Radix Trigger. Capture the actual opener
  // before the focus scope mounts, including when its parent disables it.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
  );
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            // A successful create may navigate away and remove the opener.
            // Never focus a detached element or replace the new page's focus.
            event.preventDefault();
            if (opener?.isConnected && !opener.matches(':disabled')) {
              opener.focus();
            }
          }}
          className="fixed left-1/2 top-1/2 z-50 min-w-0 max-h-[85vh] w-[calc(100vw-1rem)] sm:w-[calc(100vw-2rem)] max-w-[760px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-panel border border-line bg-panel p-2 sm:p-4 text-ink focus:outline-none"
        >
          <Dialog.Title className="mb-3 text-section font-semibold">New behaviour</Dialog.Title>
          <CreateBehaviourForm
            data={data}
            session={session}
            onCreated={onCreated}
            onCancel={onCancel}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
