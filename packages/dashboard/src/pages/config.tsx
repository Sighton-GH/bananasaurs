import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.js';
import type { RedactedConfig, SettingBody } from '../api/ops.js';
import { fieldError } from '../api/describe-error.js';
import { useHealth } from '../app/health.js';
import { useSession } from '../app/session.js';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { ErrorNotice } from '../ui/ErrorNotice.js';
import { Field, Input } from '../ui/Field.js';
import { HelpTip } from '../ui/HelpTip.js';
import { CodeBlock } from '../ui/CodeBlock.js';
import { DescriptionList } from '../ui/DescriptionList.js';
import { ErrorSummary } from '../ui/ErrorSummary.js';
import { FormSection } from '../ui/FormSection.js';
import { KeyValueTable, type KeyValue } from '../ui/KeyValueTable.js';
import { InlineAlert } from '../ui/InlineAlert.js';
import { SaveBar } from '../ui/SaveBar.js';
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
    label: 'Role changes per minute',
    hint: 'The most role changes the bot may send to Discord each minute.',
    integer: false,
  },
  {
    key: 'reconcile_budget',
    label: 'Repair changes per run',
    hint: 'The most Discord changes one automatic repair run may make.',
    integer: true,
  },
  {
    key: 'breaker_threshold',
    label: 'Safety stop threshold',
    hint: 'How many failed Discord actions in a row pause further changes.',
    integer: true,
  },
];

/**
 * `/config`: `bananasaurs config get` (redacted — secrets never cross this
 * boundary) beside the live safety settings `config set` owns (ADR 0051 D3).
 * Dry run off and a breaker reset both move the guild toward enforcement, so
 * each states its exact scope before it can be confirmed. Nothing here
 * changes the automod switch (ADR 0121).
 */
export function ConfigPage() {
  const session = useSession();
  const toast = useToast();
  const health = useHealth();
  const load = useCallback(() => session.read<RedactedConfig>('/api/config'), [session]);
  const config = useResource('the redacted configuration', load);

  const [confirming, setConfirming] = useState<'dry_run' | 'breaker' | undefined>(undefined);
  const [limitErrors, setLimitErrors] = useState<Partial<Record<string, string | undefined>>>({});
  const [limitsError, setLimitsError] = useState<unknown>(undefined);
  const [saveStatus, setSaveStatus] = useState<string | undefined>(undefined);
  const [failedField, setFailedField] = useState<string | undefined>(undefined);
  const [baseline, setBaseline] = useState<Record<LimitField['key'], number> | undefined>(
    undefined,
  );
  const [draft, setDraft] = useState<Partial<Record<LimitField['key'], string>>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);

  const safety = health.resource.state === 'ready' ? health.resource.data.safety : undefined;

  useEffect(() => {
    if (
      baseline !== undefined ||
      safety === undefined ||
      safety.roleRatePerMin === undefined ||
      safety.reconcileBudget === undefined ||
      safety.breakerThreshold === undefined
    )
      return;
    setBaseline({
      role_rate_per_min: safety.roleRatePerMin,
      reconcile_budget: safety.reconcileBudget,
      breaker_threshold: safety.breakerThreshold,
    });
  }, [baseline, safety]);
  const dirtyCount = LIMIT_FIELDS.filter((f) => {
    const raw = (draft[f.key] ?? '').trim();
    return baseline !== undefined && raw !== '' && Number(raw) !== baseline[f.key];
  }).length;
  const guard = useUnsavedGuard(dirtyCount > 0);
  const discard = () => {
    setDraft({});
    setLimitErrors({});
    setLimitsError(undefined);
    setSaveStatus(undefined);
    setFailedField(undefined);
  };

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
    if (safety === undefined || !limitsKnown || baseline === undefined || busy) return;
    const data = new FormData(e.currentTarget);
    const current = baseline;
    const errors: Partial<Record<string, string>> = {};
    const changes: SettingBody[] = [];
    for (const field of LIMIT_FIELDS) {
      const entry = data.get(field.key);
      const raw = (typeof entry === 'string' ? entry : '').trim();
      if (raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0 || (field.integer && !Number.isInteger(value))) {
        errors[field.key] = field.integer
          ? `${field.label} needs a positive whole number.`
          : `${field.label} needs a positive number.`;
        continue;
      }
      if (value !== current[field.key]) changes.push({ key: field.key, value });
    }
    setLimitErrors(errors);
    setLimitsError(undefined);
    setSaveStatus(undefined);
    setFailedField(undefined);
    if (Object.keys(errors).length > 0 || changes.length === 0) return;
    setBusy(true);
    let applied = 0;
    const savedLabels: string[] = [];
    try {
      for (const change of changes) {
        // `writeOrThrow` (not `write`) so a 400 reaches this form's inline
        // error and field problems instead of a toast; anything else is the
        // session's toast contract, like every other write.
        try {
          const updated = await session.writeOrThrow<{ ok: boolean }>('/api/settings', change);
          if (updated === undefined) {
            setLimitsError(
              new Error(
                `${LIMIT_FIELDS.find((f) => f.key === change.key)?.label ?? change.key} wasn't saved. Earlier saved changes remain applied. The remaining inputs are kept; check the notice and try again.`,
              ),
            );
            break;
          }
        } catch (err) {
          if (err instanceof ApiError && (err.status === 400 || err.status === 409)) {
            setFailedField(change.key);
            setLimitsError(err);
            break;
          }
          throw err;
        }
        const label = LIMIT_FIELDS.find((f) => f.key === change.key)?.label ?? change.key;
        toast({ tone: 'ok', title: `${label} set to ${String(change.value)}` });
        applied += 1;
        savedLabels.push(label);
        const key = change.key as LimitField['key'];
        const value = change.value as number;
        setBaseline((previous) =>
          previous === undefined ? previous : { ...previous, [key]: value },
        );
        setDraft((previous) => ({ ...previous, [key]: String(value) }));
      }
    } catch (err) {
      setLimitsError(err);
    } finally {
      if (applied > 0) {
        if (applied < changes.length)
          setSaveStatus(`Saved ${savedLabels.join(', ')}. Remaining changes were not saved.`);
        health.reload();
      }
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Configuration"
        purpose="Review the redacted process configuration and change the server's live safety settings and limits."
      />
      <div className="grid max-w-4xl gap-3">
        <Card title="Safety settings">
          {safety === undefined ? (
            <DataState resource={health.resource}>
              {() => (
                <p className="text-small text-ink-muted">
                  The server does not send the safety state. Settings stay read-only.
                </p>
              )}
            </DataState>
          ) : (
            <>
              <DescriptionList
                items={[
                  {
                    term: 'Dry run',
                    value: (
                      <>
                        {safety.dryRun ? (
                          <Badge wrap tone="hold">
                            on — effects are rehearsed, not sent
                          </Badge>
                        ) : (
                          <Badge tone="neutral">off</Badge>
                        )}{' '}
                        <HelpTip label="dry run">
                          While on, every action is rehearsed and recorded but nothing is sent to
                          Discord.
                        </HelpTip>
                      </>
                    ),
                  },
                  {
                    term: 'Circuit breaker',
                    value: (
                      <>
                        <Badge tone={safety.breakerOpen ? 'hold' : 'neutral'}>
                          {safety.breakerOpen ? 'open' : 'closed'}
                        </Badge>
                        {safety.breakerReason != null && (
                          <span className="ml-2 text-ink-muted">{safety.breakerReason}</span>
                        )}{' '}
                        <HelpTip label="the circuit breaker">
                          After too many failed Discord actions in a row it opens and pauses further
                          changes until it is reset.
                        </HelpTip>
                      </>
                    ),
                  },
                ]}
              />
              <div className="mt-3 flex flex-wrap gap-2">
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
            <DataState resource={health.resource}>
              {() => (
                <p className="text-small text-ink-muted">
                  The server does not send the safety state. Settings stay read-only.
                </p>
              )}
            </DataState>
          ) : !limitsKnown ? (
            <p className="text-sm text-ink-muted">
              This server does not send the current limits, so they stay read-only here. The runtime
              keys are BANANASAURS_ROLE_RATE_PER_MIN, BANANASAURS_RECONCILE_BUDGET and
              BANANASAURS_BREAKER_THRESHOLD in the guild's live settings.
            </p>
          ) : (
            <form
              ref={formRef}
              onSubmit={(e) => void applyLimits(e)}
              className="grid max-w-md gap-3"
            >
              <DescriptionList
                items={LIMIT_FIELDS.map((field) => ({
                  term: field.label,
                  value: String(baseline?.[field.key] ?? currentValue(safety, field.key)),
                }))}
              />
              <FormSection
                title="Edit limits"
                description="Blank fields stay unchanged. Changes are saved separately in the order shown; saving stops at the first refusal."
              >
                <ErrorSummary
                  errors={LIMIT_FIELDS.flatMap((f) => {
                    const problem =
                      limitErrors[f.key] ??
                      (failedField === f.key ? fieldError(limitsError, 'value') : undefined);
                    return problem === undefined
                      ? []
                      : [{ fieldId: `field-${f.key}`, message: problem }];
                  })}
                />
                {LIMIT_FIELDS.map((field) => {
                  // Client-side validation wins; the server's field problem
                  // shows once the shape is right but the value is refused.
                  const problem =
                    limitErrors[field.key] ??
                    (failedField === field.key ? fieldError(limitsError, 'value') : undefined);
                  return (
                    <Field
                      key={field.key}
                      htmlFor={`field-${field.key}`}
                      label={field.label}
                      hint={field.hint}
                      {...(problem === undefined ? {} : { error: problem })}
                    >
                      <Input
                        name={field.key}
                        inputMode="decimal"
                        disabled={busy}
                        value={
                          draft[field.key] ??
                          String(baseline?.[field.key] ?? currentValue(safety, field.key))
                        }
                        onBlur={(e) => {
                          const raw = e.target.value.trim();
                          const value = Number(raw);
                          const problem =
                            raw !== '' &&
                            (!Number.isFinite(value) ||
                              value <= 0 ||
                              (field.integer && !Number.isInteger(value)))
                              ? `${field.label} needs a positive ${field.integer ? 'whole number' : 'number'}.`
                              : undefined;
                          setLimitErrors((previous) => ({ ...previous, [field.key]: problem }));
                        }}
                        onChange={(e) =>
                          setDraft((previous) => ({ ...previous, [field.key]: e.target.value }))
                        }
                      />
                    </Field>
                  );
                })}
              </FormSection>
              {saveStatus !== undefined && <InlineAlert tone="hold" title={saveStatus} />}
              {limitsError !== undefined && <ErrorNotice error={limitsError} />}
              <div>
                <Button type="submit" busy={busy}>
                  Apply changes
                </Button>
              </div>
              <SaveBar
                dirtyCount={dirtyCount}
                busy={busy}
                onDiscard={discard}
                onSave={() => formRef.current?.requestSubmit()}
              />
            </form>
          )}
        </Card>
        <Card title="Runtime settings, editable here">
          <DescriptionList
            items={[
              {
                term: 'Dry run',
                value:
                  'Safety settings above - confirmed before it changes, and every change writes an audit row.',
              },
              {
                term: 'Reset automatic safety stop',
                value: 'Safety settings above, when the breaker is open.',
              },
              {
                term: 'Role, repair and safety limits',
                value: 'Limits above - applied separately in order, validated and audited.',
              },
            ]}
          />
        </Card>
        <Card title="Process configuration">
          <p className="mb-2 text-sm text-ink-muted">
            Read at startup from the instance's environment file on the host. Changing one means
            editing that file and restarting the daemon — that is a host action, so this page shows
            them read-only. Secrets are redacted by the server before anything crosses this
            boundary.
          </p>
          <DataState
            resource={config.resource}
            isEmpty={(data) => Object.keys(data).length === 0}
            emptyTitle="No process configuration values were returned."
            emptyAction={<Button onClick={config.reload}>Refresh configuration</Button>}
          >
            {(data) => (
              <>
                <KeyValueTable
                  data={Object.fromEntries(
                    Object.entries(data).map(([key, value]) => [key, configValue(value)]),
                  )}
                  labels={CONFIG_LABELS}
                  caption="Process configuration"
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge wrap tone="neutral">
                    environment — restart to change
                  </Badge>
                  {Object.keys(data).some((key) => /token|secret|key|password/i.test(key)) && (
                    <Badge wrap tone="danger">
                      secret — redacted
                    </Badge>
                  )}
                </div>
                <details className="mt-3 min-w-0">
                  <summary className="cursor-pointer text-small text-ink-muted">Advanced</summary>
                  <CodeBlock
                    code={JSON.stringify(data, null, 2)}
                    label="Redacted process configuration"
                    language="json"
                    maxHeight={320}
                  />
                </details>
              </>
            )}
          </DataState>
        </Card>
      </div>
      {guard}
      <ConfirmDialog
        open={confirming === 'dry_run'}
        title={safety?.dryRun === true ? 'Turn dry run off?' : 'Turn dry run on?'}
        scope={
          safety?.dryRun === true ? (
            <p>
              Effects for guild {session.info.guildId} stop being rehearsed and start being sent to
              Discord for real. Automod acts only when its switch on the Automod page is On.
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

const CONFIG_LABELS: Readonly<Record<string, string>> = {
  DISCORD_BOT_TOKEN: 'Discord bot token (redacted)',
  DISCORD_APPLICATION_ID: 'Discord application',
  BANANASAURS_GUILD_ALLOWLIST: 'Allowed guilds',
  BANANASAURS_ARCHIVE_GUILDS: 'Guilds allowed to archive',
  BANANASAURS_OWNER_USER_ID: 'Owner Discord user',
  BANANASAURS_ENV: 'Instance environment',
  BANANASAURS_READONLY: 'Read-only instance',
  DASHBOARD_PORT: 'Dashboard port',
  DASHBOARD_BIND: 'Dashboard bind address',
  BANANASAURS_DRY_RUN: 'Dry run at startup',
  BANANASAURS_ROLE_RATE_LIMIT_PER_MIN: 'Role changes per minute at startup',
  BANANASAURS_RECONCILE_BUDGET: 'Repair changes per run at startup',
  BANANASAURS_ERROR_BREAKER_THRESHOLD: 'Safety stop threshold at startup',
  MCP_PUBLIC_URL: 'Public connector URL',
  token: 'Token (redacted)',
  guilds: 'Allowed guilds',
};

/** Only the server-redacted response is displayed; never retrieve secret values. */
function configValue(value: unknown): KeyValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (Array.isArray(value)) return value.map((entry: unknown) => configValue(entry));
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, configValue(entry)]),
    );
  return 'Unavailable';
}
