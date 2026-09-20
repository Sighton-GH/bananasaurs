import { useCallback, useState } from 'react';
import type { RedactedConfig, SettingBody } from '../api/ops.js';
import { useHealth } from '../app/health.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { Field, Input } from '../ui/Field.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

interface LimitField {
  readonly key: 'role_rate_per_min' | 'reconcile_budget' | 'breaker_threshold';
  readonly label: string;
  readonly hint: string;
  readonly integer: boolean;
}

const LIMIT_FIELDS: readonly LimitField[] = [
  {
    key: 'role_rate_per_min',
    label: 'Role rate per minute',
    hint: 'How many role changes the gateway may make per minute.',
    integer: false,
  },
  {
    key: 'reconcile_budget',
    label: 'Reconcile budget',
    hint: 'How many operations one reconcile run may spend.',
    integer: true,
  },
  {
    key: 'breaker_threshold',
    label: 'Breaker threshold',
    hint: 'How many consecutive refusals open the circuit breaker.',
    integer: true,
  },
];

/**
 * `/config`: `bananasaurs config get` (redacted — secrets never cross this
 * boundary) beside the live safety settings `config set` owns (ADR 0051 D3).
 * Dry run off and a breaker reset both move the guild toward enforcement, so
 * each states its exact scope before it can be confirmed; the observe freeze
 * is untouched — nothing here changes any rule's mode.
 */
export function ConfigPage() {
  const session = useSession();
  const toast = useToast();
  const health = useHealth();
  const load = useCallback(() => session.read<RedactedConfig>('/api/config'), [session]);
  const config = useResource('the redacted configuration', load);

  const [confirming, setConfirming] = useState<'dry_run' | 'breaker' | undefined>(undefined);
  const [limitErrors, setLimitErrors] = useState<Partial<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);

  const safety = health.resource.state === 'ready' ? health.resource.data.safety : undefined;

  const applySetting = async (body: SettingBody, success: string): Promise<boolean> => {
    const result = await session.write<{ ok: boolean }>('/api/settings', body);
    if (result === undefined) return false;
    toast({ tone: 'ok', title: success });
    return true;
  };

  const confirmScoped = async () => {
    if (confirming === undefined || safety === undefined) return;
    setBusy(true);
    try {
      const ok =
        confirming === 'dry_run'
          ? await applySetting(
              { key: 'dry_run', value: !safety.dryRun },
              safety.dryRun ? 'Dry run turned off' : 'Dry run turned on',
            )
          : await applySetting({ key: 'breaker', value: 'closed' }, 'Breaker reset to closed');
      if (ok) health.reload();
    } finally {
      setBusy(false);
      setConfirming(undefined);
    }
  };

  const limitsKnown =
    safety !== undefined &&
    safety.roleRatePerMin !== undefined &&
    safety.reconcileBudget !== undefined &&
    safety.breakerThreshold !== undefined;

  const applyLimits = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (safety === undefined || !limitsKnown) return;
    const data = new FormData(e.currentTarget);
    const current: Record<LimitField['key'], number> = {
      role_rate_per_min: safety.roleRatePerMin as number,
      reconcile_budget: safety.reconcileBudget as number,
      breaker_threshold: safety.breakerThreshold as number,
    };
    const errors: Partial<Record<string, string>> = {};
    const changes: SettingBody[] = [];
    for (const field of LIMIT_FIELDS) {
      const entry = data.get(field.key);
      const raw = (typeof entry === 'string' ? entry : '').trim();
      if (raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0 || (field.integer && !Number.isInteger(value))) {
        errors[field.key] = field.integer
          ? 'A positive whole number is required.'
          : 'A positive number is required.';
        continue;
      }
      if (value !== current[field.key]) changes.push({ key: field.key, value });
    }
    setLimitErrors(errors);
    if (Object.keys(errors).length > 0 || changes.length === 0) return;
    setBusy(true);
    try {
      let applied = 0;
      for (const change of changes) {
        const ok = await applySetting(
          change,
          `${LIMIT_FIELDS.find((f) => f.key === change.key)?.label ?? change.key} set to ${String(change.value)}`,
        );
        if (!ok) break;
        applied += 1;
      }
      if (applied > 0) health.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Configuration"
        purpose="The instance's redacted configuration, and this guild's live safety settings with the changes the CLI would ask you to --confirm."
      />
      <div className="grid max-w-4xl gap-3">
        <Card title="Safety settings">
          {safety === undefined ? (
            <p className="text-sm text-ink-muted">Loading the safety state…</p>
          ) : (
            <>
              <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-ink-muted">Dry run</dt>
                <dd>
                  {safety.dryRun ? (
                    <Badge tone="hold">on — effects are rehearsed, not sent</Badge>
                  ) : (
                    'off'
                  )}
                </dd>
                <dt className="text-ink-muted">Circuit breaker</dt>
                <dd>
                  {safety.breakerOpen ? (
                    <>
                      <Badge tone="hold">open</Badge>
                      {safety.breakerReason !== null && (
                        <span className="ml-2 text-ink-muted">{safety.breakerReason}</span>
                      )}
                    </>
                  ) : (
                    'closed'
                  )}
                </dd>
              </dl>
              <div className="mt-3 flex gap-2">
                <Button
                  variant={safety.dryRun ? 'danger' : 'default'}
                  busy={busy}
                  onClick={() => setConfirming('dry_run')}
                >
                  {safety.dryRun ? 'Turn dry run off' : 'Turn dry run on'}
                </Button>
                {safety.breakerOpen && (
                  <Button variant="primary" busy={busy} onClick={() => setConfirming('breaker')}>
                    Reset breaker
                  </Button>
                )}
              </div>
            </>
          )}
        </Card>
        <Card title="Limits">
          {safety === undefined ? (
            <p className="text-sm text-ink-muted">Loading the safety state…</p>
          ) : !limitsKnown ? (
            <p className="text-sm text-ink-muted">
              This server does not send the current limits. Set them on the host with{' '}
              <code className="text-xs">config set --confirm</code>.
            </p>
          ) : (
            <form
              key={JSON.stringify(safety)}
              onSubmit={(e) => void applyLimits(e)}
              className="grid max-w-md gap-3"
            >
              {LIMIT_FIELDS.map((field) => (
                <Field
                  key={field.key}
                  label={field.label}
                  hint={field.hint}
                  {...(limitErrors[field.key] !== undefined
                    ? { error: limitErrors[field.key] }
                    : {})}
                >
                  <Input
                    name={field.key}
                    inputMode="decimal"
                    defaultValue={String(currentValue(safety, field.key))}
                  />
                </Field>
              ))}
              <div>
                <Button type="submit" variant="primary" busy={busy}>
                  Apply changes
                </Button>
              </div>
            </form>
          )}
        </Card>
        <Card title="Redacted configuration">
          <p className="mb-2 text-sm text-ink-muted">
            As <code className="text-xs">bananasaurs config get</code> prints it — secrets are
            redacted by the server before anything crosses this boundary. Changes are made on the
            host with <code className="text-xs">config set --confirm</code>.
          </p>
          <DataState resource={config.resource}>
            {(data) => (
              <pre className="overflow-x-auto text-xs break-words whitespace-pre-wrap">
                {JSON.stringify(data, null, 2)}
              </pre>
            )}
          </DataState>
        </Card>
      </div>
      <ConfirmDialog
        open={confirming === 'dry_run'}
        title={safety?.dryRun === true ? 'Turn dry run off?' : 'Turn dry run on?'}
        scope={
          safety?.dryRun === true ? (
            <p>
              Effects for guild {session.info.guildId} stop being rehearsed and start being sent to
              Discord for real. Rule modes do not change — a rule in observe still only observes.
            </p>
          ) : (
            <p>
              Every effect for guild {session.info.guildId} is rehearsed and recorded but not sent
              to Discord, until dry run is turned off again.
            </p>
          )
        }
        confirmLabel={safety?.dryRun === true ? 'Turn dry run off' : 'Turn dry run on'}
        danger={safety?.dryRun === true}
        busy={busy}
        onConfirm={() => void confirmScoped()}
        onCancel={() => setConfirming(undefined)}
      />
      <ConfirmDialog
        open={confirming === 'breaker'}
        title="Reset the circuit breaker?"
        scope={
          <p>
            Closes the breaker for guild {session.info.guildId} and lets effects flow again
            {safety?.breakerReason != null ? ` — it opened because: ${safety.breakerReason}` : ''}.
            Reset it only after that cause is fixed.
          </p>
        }
        confirmLabel="Reset breaker"
        busy={busy}
        onConfirm={() => void confirmScoped()}
        onCancel={() => setConfirming(undefined)}
      />
    </>
  );
}

const currentValue = (
  safety: {
    roleRatePerMin?: number;
    reconcileBudget?: number;
    breakerThreshold?: number;
  },
  key: LimitField['key'],
): number => {
  switch (key) {
    case 'role_rate_per_min':
      return safety.roleRatePerMin ?? 0;
    case 'reconcile_budget':
      return safety.reconcileBudget ?? 0;
    case 'breaker_threshold':
      return safety.breakerThreshold ?? 0;
  }
};
