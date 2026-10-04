import { useCallback, useState, type ReactNode } from 'react';
import {
  AUTOMOD_STATE_LABEL,
  AUTOMOD_STATE_MEANING,
  AUTOMOD_STATES,
  type AutomodState,
  type AutomodStateView,
} from '../api/automod.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { useToast } from '../ui/Toast.js';

const DRY_RUN_NOTE =
  'Dry run is on for this server, so matches are logged, not acted on, until dry run is turned off on the Configuration page.';
const TITLE: Record<AutomodState, string> = {
  off: 'Turn automod off?',
  watch: 'Switch automod to Watch?',
  on: 'Turn automod on?',
};
const CONFIRM: Record<AutomodState, string> = {
  off: 'Turn automod off',
  watch: 'Switch to Watch',
  on: 'Turn automod on',
};

/** What the confirmation says will happen if the switch moves to `target`. */
function Consequence({ target, view }: { target: AutomodState; view: AutomodStateView }): ReactNode {
  if (target === 'off') return <p>Automod stops checking messages. Nothing new is recorded.</p>;
  if (target === 'watch') return <p>Automod records matches for review and deletes nothing.</p>;
  const n = view.enabledRules.length;
  return (
    <>
      {n === 0 ? (
        <p>No rules are enabled, so nothing will happen until you enable one.</p>
      ) : (
        <>
          <p>
            {n === 1 ? 'This 1 enabled rule will' : `These ${String(n)} enabled rules will`} delete
            matching messages and escalate repeat offenders:
          </p>
          <ul className="mt-1 list-disc pl-5">
            {view.enabledRules.map((r) => (
              <li key={r.ruleId}>{r.name}</li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-2">
        Turn off the matching Carl-bot or Dyno automod first, so two bots don&apos;t act on the
        same message.
      </p>
      {view.dryRun && <p className="mt-2">{DRY_RUN_NOTE}</p>}
    </>
  );
}

/** ADR 0121: the one guild-wide automod switch, at the top of /automod. */
export function AutomodSwitch() {
  const session = useSession();
  const toast = useToast();
  const load = useCallback(() => session.read<AutomodStateView>('/api/automod/state'), [session]);
  const view = useResource('the automod switch', load);
  const [target, setTarget] = useState<AutomodState | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const apply = async (state: AutomodState) => {
    setBusy(true);
    try {
      const result = await session.write<{ ok: boolean; state: AutomodState }>(
        '/api/automod/state',
        { state },
        'PUT',
      );
      if (result !== undefined) {
        toast({ tone: 'ok', title: `Automod is now ${AUTOMOD_STATE_LABEL[state]}` });
        view.reload();
      }
    } finally {
      setBusy(false);
      setTarget(undefined);
    }
  };

  return (
    <DataState resource={view.resource}>
      {(v) => (
        <Card title="Automod">
          <div role="group" aria-label="Automod" className="inline-flex gap-1">
            {AUTOMOD_STATES.map((s) => (
              <Button
                key={s}
                variant={v.state === s ? 'primary' : 'default'}
                aria-pressed={v.state === s}
                disabled={busy}
                onClick={() => {
                  if (s !== v.state) setTarget(s);
                }}
              >
                {AUTOMOD_STATE_LABEL[s]}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-sm">{AUTOMOD_STATE_MEANING[v.state]}</p>
          {v.state === 'on' && v.dryRun && (
            <p className="mt-1 text-sm text-ink-muted">{DRY_RUN_NOTE}</p>
          )}
          {v.killswitch && (
            <p className="mt-1 text-sm text-ink-muted">
              The kill switch is on: nothing is sent to Discord.
            </p>
          )}
          <ConfirmDialog
            open={target !== undefined}
            title={target === undefined ? '' : TITLE[target]}
            scope={target === undefined ? null : <Consequence target={target} view={v} />}
            confirmLabel={target === undefined ? '' : CONFIRM[target]}
            danger={target === 'on'}
            busy={busy}
            onConfirm={() => {
              if (target !== undefined) void apply(target);
            }}
            onCancel={() => setTarget(undefined)}
          />
        </Card>
      )}
    </DataState>
  );
}
