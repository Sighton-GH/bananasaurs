import * as Dialog from '@radix-ui/react-dialog';
import type { ReactElement, ReactNode } from 'react';
import { Button } from './Button.js';

/**
 * A destructive or dangerous action states its exact scope before it can be
 * confirmed (`docs/06`). Radix supplies the focus trap, escape handling and
 * ARIA wiring; escape and the backdrop both cancel.
 */
export function ConfirmDialog({
  open,
  title,
  scope,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly scope: ReactNode;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-md border border-line bg-panel p-4 text-ink">
          <Dialog.Title className="text-lg">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 text-sm">{scope}</div>
          </Dialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
