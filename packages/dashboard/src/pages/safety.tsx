import { useState } from 'react';
import { useHealth } from '../app/health.js';
import { useSession } from '../app/session.js';
import { Button } from '../ui/Button.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

/**
 * The former Kill switch section. Same request (`POST /api/killswitch`
 * `{ on }`); turning it on now states its scope first (`docs/06`), and turning
 * it off still needs re-auth, which `apiFetch` handles.
 */
export function SafetyPage() {
  const session = useSession();
  const health = useHealth();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const setKillswitch = async (on: boolean) => {
    setBusy(true);
    try {
      const result = await session.write<{ ok: boolean; killswitch: boolean }>('/api/killswitch', {
        on,
      });
      if (result !== undefined) {
        toast({ tone: 'ok', title: on ? 'Kill switch turned on' : 'Kill switch turned off' });
        health.reload();
      }
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Safety"
        purpose="The kill switch stops every Discord side effect for this guild. Events are still received and logged."
      />
      <div className="flex gap-2">
        <Button variant="danger" busy={busy} onClick={() => setConfirming(true)}>
          Turn kill switch on
        </Button>
        <Button busy={busy} onClick={() => void setKillswitch(false)}>
          Turn kill switch off
        </Button>
      </div>
      <p className="mt-2 text-sm text-ink-muted">Turning it off asks for your password again.</p>
      <ConfirmDialog
        open={confirming}
        title="Turn the kill switch on?"
        scope={
          <p>
            Stops every Discord side effect for guild {session.info.guildId} until it is turned off
            again. Events are still received and logged.
          </p>
        }
        confirmLabel="Turn kill switch on"
        danger
        busy={busy}
        onConfirm={() => void setKillswitch(true)}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
