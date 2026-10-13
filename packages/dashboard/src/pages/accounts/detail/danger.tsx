import { useState } from 'react';
import {
  type Account,
  type AccountDeleteResult,
  type AccountDisableResult,
  type AccountGuildOutcome,
} from '../../../api/ops.js';
import { type Session } from '../../../app/session.js';
import { Button } from '../../../ui/Button.js';
import { ConfirmDialog } from '../../../ui/ConfirmDialog.js';
import { useToast } from '../../../ui/Toast.js';

export function DangerSection({
  session,
  account,
  isOwnAccount,
  onChanged,
  onDeleted,
}: {
  readonly session: Session;
  readonly account: Account;
  /** True when the viewer is looking at their own row: revoking guild access locks them out. */
  readonly isOwnAccount: boolean;
  readonly onChanged: () => void;
  readonly onDeleted: () => void;
}) {
  const toast = useToast();
  const [pending, setPending] = useState<'disable' | 'revoke-guild' | 'delete' | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false);

  const run = async (): Promise<void> => {
    if (pending === undefined || busy) return;
    setBusy(true);
    const kind = pending;
    const name = encodeURIComponent(account.username);
    try {
      if (kind === 'disable') {
        const result = await session.write<AccountDisableResult>(`/api/accounts/${name}/disabled`, {
          disabled: !account.disabled,
        });
        if (result !== undefined) {
          toast({
            tone: 'ok',
            title: `${result.username} ${result.disabled ? 'disabled' : 'enabled'}`,
          });
          onChanged();
        }
      } else if (kind === 'revoke-guild') {
        const result = await session.write<{ outcome: AccountGuildOutcome }>(
          `/api/accounts/${name}/revoke-guild`,
          {},
        );
        if (result !== undefined) {
          toast({ tone: 'ok', title: `${account.username} removed from this server` });
          onChanged();
        }
      } else {
        const result = await session.write<AccountDeleteResult>(
          `/api/accounts/${name}`,
          undefined,
          'DELETE',
        );
        if (result !== undefined) {
          toast({ tone: 'ok', title: `${result.username} deleted` });
          onDeleted();
          return;
        }
      }
    } finally {
      setBusy(false);
      setPending(undefined);
    }
  };

  const scopeText =
    pending === 'disable'
      ? account.disabled
        ? `${account.username} can sign in again.`
        : `Every dashboard session for ${account.username} stops verifying while the account stays disabled — a pause, not a rotation.`
      : pending === 'revoke-guild'
        ? `Removes ${account.username} from this server; its permissions here go with it.${
            isOwnAccount
              ? ' This is your own account — revoking signs you out with no way back in. Recovery is delete plus re-bootstrap.'
              : ''
          }`
        : pending === 'delete'
          ? `Deletes ${account.username} and revokes its connected apps. Not reversible.`
          : '';

  // Re-enabling is a benign, reversible step back to normal — not a danger
  // action — so it gets the default button and a non-danger confirmation.
  const enabling = pending === 'disable' && account.disabled;

  return (
    <section
      aria-labelledby="danger-zone-heading"
      className="rounded-panel border border-tone-danger bg-panel p-3"
    >
      <div className="mb-2">
        <h2 id="danger-zone-heading" className="text-section font-semibold">
          Danger zone
        </h2>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant={account.disabled ? 'default' : 'danger'}
          onClick={() => setPending('disable')}
        >
          {account.disabled ? 'Enable' : 'Disable'}
        </Button>
        <Button variant="danger" onClick={() => setPending('revoke-guild')}>
          Remove from this server
        </Button>
        <Button variant="danger" onClick={() => setPending('delete')}>
          Delete
        </Button>
      </div>
      <ConfirmDialog
        open={pending !== undefined}
        title={
          pending === 'disable'
            ? `${account.disabled ? 'Enable' : 'Disable'} ${account.username}?`
            : pending === 'revoke-guild'
              ? `Remove ${account.username} from this server?`
              : pending === 'delete'
                ? `Delete ${account.username}?`
                : ''
        }
        scope={<p>{scopeText}</p>}
        confirmLabel={
          pending === 'disable'
            ? `${account.disabled ? 'Enable' : 'Disable'} account`
            : pending === 'revoke-guild'
              ? 'Remove from this server'
              : 'Delete account'
        }
        danger={!enabling}
        busy={busy}
        onConfirm={() => void run()}
        onCancel={() => setPending(undefined)}
      />
    </section>
  );
}
