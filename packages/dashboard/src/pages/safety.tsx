import { useState } from 'react';
import { Link } from 'wouter';
import { useHealth } from '../app/health.js';
import { useSession } from '../app/session.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

/**
 * `/safety`: the kill switch and the live read of what is holding the guild
 * back. The switch itself keeps the Release 1 semantics — turning it on
 * states its scope first, turning it off asks for the password again — and
 * the rest of the state (dry run, breaker, thresholds) is read here but
 * changed on the Configuration page, so there is exactly one place each
 * lever lives.
 */
export function SafetyPage() {
  const session = useSession();
  const health = useHealth();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const safety = health.resource.state === 'ready' ? health.resource.data.safety : undefined;

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
      <div className="grid max-w-4xl gap-3">
        <Card title="What is holding back right now">
          {safety === undefined ? (
            <p className="text-sm text-ink-muted">Loading the safety state…</p>
          ) : (
            <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-ink-muted">Kill switch</dt>
              <dd>{safety.killswitch ? <Badge tone="hold">on — nothing is sent</Badge> : 'off'}</dd>
              <dt className="text-ink-muted">Dry run</dt>
              <dd>
                {safety.dryRun ? <Badge tone="hold">on — effects are rehearsed</Badge> : 'off'}
              </dd>
              <dt className="text-ink-muted">Circuit breaker</dt>
              <dd>
                {safety.breakerOpen ? (
                  <>
                    <Badge tone="hold">open</Badge>
                    {safety.breakerReason != null && (
                      <span className="ml-2 text-ink-muted">{safety.breakerReason}</span>
                    )}
                  </>
                ) : (
                  'closed'
                )}
              </dd>
            </dl>
          )}
          <p className="mt-2 text-sm text-ink-muted">
            Dry run, the breaker reset and the thresholds live on{' '}
            <Link href="/config" className="underline">
              Configuration
            </Link>
            .
          </p>
        </Card>
        <Card title="Kill switch">
          <div className="flex gap-2">
            <Button variant="danger" busy={busy} onClick={() => setConfirming(true)}>
              Turn kill switch on
            </Button>
            <Button busy={busy} onClick={() => void setKillswitch(false)}>
              Turn kill switch off
            </Button>
          </div>
          <p className="mt-2 text-sm text-ink-muted">
            Turning it off asks for your password again.
          </p>
        </Card>
      </div>
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
