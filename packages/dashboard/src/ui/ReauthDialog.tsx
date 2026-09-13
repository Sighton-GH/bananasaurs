import * as Dialog from '@radix-ui/react-dialog';
import { useState, type ReactElement } from 'react';
import { Button } from './Button.js';
import { Field, Input } from './Field.js';

/**
 * ADR 0029: a sensitive write asks for the password again without leaving the
 * page. Cancelling (button, escape, backdrop) abandons the write; `apiFetch`
 * receives `undefined` and does not retry.
 */
export function ReauthDialog({
  open,
  onSubmit,
  onCancel,
}: {
  readonly open: boolean;
  readonly onSubmit: (password: string) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const [password, setPassword] = useState('');
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-[24rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-md border border-line bg-panel p-4 text-ink">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit(password);
              setPassword('');
            }}
          >
            <Dialog.Title className="text-lg">Confirm your password</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-ink-muted">
              This action needs a recent password entry.
            </Dialog.Description>
            <div className="mt-3">
              <Field label="Password">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                />
              </Field>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={onCancel}>Cancel</Button>
              <Button type="submit" variant="primary">
                Confirm
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
