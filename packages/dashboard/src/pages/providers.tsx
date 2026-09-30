import { useCallback, useEffect, useState } from 'react';
import {
  ASSISTANT_PROVIDERS_URL,
  ASSISTANT_URL,
  ASSISTANT_KEYS_URL,
  GITHUB_TOKEN_URL,
  MODEL_CHAIN_TEST_URL,
  MODEL_CHAIN_URL,
  PROVIDER_MODELS_URL,
  PROVIDER_URL,
  SEARCH_KEYS_URL,
  providerName,
  PROVIDERS,
  providerTermsUrl,
  assistantKeyUrl,
  searchKeyMoveUrl,
  searchKeyUrl,
  type AssistantData,
  type AssistantSetupData,
  type AiStatus,
  type ModelInfo,
  type ProviderTerms,
  type SearchKeyRow,
  type SearchKeysData,
  type SearchSource,
  type SetupChainRow,
  type SetupKeyRow,
} from '../api/assistant.js';
import type { EligibilityWarning, ProviderReviewResult } from '../api/ops.js';
import { ApiError } from '../api.js';
import { fieldError } from '../api/describe-error.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { ErrorNotice, DescribedNotice } from '../ui/ErrorNotice.js';
import { Checkbox, Field, Input } from '../ui/Field.js';
import { HelpTip } from '../ui/HelpTip.js';
import { OrderedList } from '../ui/OrderedList.js';
import { PageHeader } from '../ui/PageHeader.js';
import { StatusPill } from '../ui/StatusPill.js';
import { useToast } from '../ui/Toast.js';

const REASON_TEXT: Record<EligibilityWarning['reason'], string> = {
  'not-no':
    'This service has not confirmed that it will keep your server data out of model training',
  stale: 'The terms review is old. Check the source again before using this service',
  'not-production': 'This service is not approved for live member questions',
  unverified:
    'No verified eligibility record — assistant answers are intentionally disabled until the owner verifies this provider’s terms and adds the record',
};

const trainsTone = (trainsOnInput: string): 'hold' | 'danger' | 'ok' =>
  trainsOnInput === 'no' ? 'ok' : trainsOnInput === 'unknown' ? 'hold' : 'danger';

const trainsLabel = (trainsOnInput: string): string =>
  trainsOnInput === 'no'
    ? "Doesn't train on your data"
    : trainsOnInput === 'yes'
      ? 'May train on your data'
      : 'Not stated';

/** ADR 0062: the training warning the provider cards show when `may-train`. */
const MAY_TRAIN_COPY =
  'This service’s terms record says it may train on your data. Member questions and server excerpts sent to it may be used for training.';

const CHAIN_REASON: Record<Exclude<SetupChainRow['status'], 'ready' | 'allowance-used'>, string> = {
  'no-key': 'This key is gone. Choose another key or add it again.',
  'key-unreadable': "The saved key can't be read on this host. Paste it again.",
  disabled: 'This key is disabled.',
  ineligible: "This service's terms do not allow answering member questions.",
  unverified: 'No terms record for this service yet. Record the terms below.',
};

const costWords = (costClass: string): string =>
  costClass === 'free' ? 'Free' : costClass === 'paid' ? 'Paid' : 'Not sure';

/** The six setup steps, in the order the owner meets them. */
function ChecklistSection({
  setup,
  assistant,
}: {
  readonly setup: AssistantSetupData;
  readonly assistant: AssistantData | undefined;
}) {
  const keyedProviders = new Set(setup.keys.map((key) => key.provider));
  const termsDone =
    setup.keys.length > 0 &&
    [...keyedProviders].every((provider) => {
      const eligibility = setup.providers.find((row) => row.provider === provider)?.eligibility;
      return eligibility === 'eligible' || eligibility === 'may-train';
    });
  const items: readonly { readonly name: string; readonly done: boolean }[] = [
    { name: 'Add a provider key', done: setup.keys.length > 0 },
    { name: 'Record the terms', done: termsDone },
    { name: 'Set the model order', done: setup.chain.length > 0 },
    { name: 'Build the behaviour prompt', done: (assistant?.behaviours.length ?? 0) > 0 },
    { name: 'Add resources', done: (assistant?.resources.length ?? 0) > 0 },
    { name: 'Answer a test question', done: (assistant?.activity.length ?? 0) > 0 },
  ];
  return (
    <Card title="Setup checklist">
      <ul className="grid gap-1.5">
        {items.map((item) => (
          <li key={item.name} className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={item.done ? 'ok' : 'neutral'}>{item.done ? 'Done' : 'To do'}</Badge>
            <span>{item.name}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface ChainDraft {
  readonly keyId: string;
  readonly model: string;
  readonly rpmLimit: string;
  readonly rpdLimit: string;
}

/** A limit input is blank (no limit) or a whole number of 1 or more. */
const validLimit = (text: string): boolean => text === '' || /^[1-9]\d*$/.test(text);

interface TestOutcome {
  readonly ok: boolean;
  readonly reply?: string;
  /** The server's fixed sentence on a 200 refusal, or the thrown `ApiError`. */
  readonly error?: unknown;
  readonly failure?: {
    readonly code: string;
    readonly title: string;
    readonly explanation: string;
    readonly hint: string;
    readonly host?: string;
    readonly httpStatus?: number;
    readonly netCode?: string;
  };
}

/** Model order: an OrderedList of key + model rows with a status pill and a Test button each. */
function ModelOrderSection({
  setup,
  onChanged,
}: {
  readonly setup: AssistantSetupData;
  readonly onChanged: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const [rows, setRows] = useState<readonly ChainDraft[]>(() =>
    setup.chain.map((entry) => ({
      keyId: entry.keyId,
      model: entry.model,
      rpmLimit: entry.rpmLimit?.toString() ?? '',
      rpdLimit: entry.rpdLimit?.toString() ?? '',
    })),
  );
  const [geminiModels, setGeminiModels] = useState<readonly ModelInfo[] | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<unknown>(undefined);
  const [testing, setTesting] = useState<number | undefined>(undefined);
  const [results, setResults] = useState<Readonly<Record<number, TestOutcome>>>({});

  const keyOf = (keyId: string): SetupKeyRow | undefined =>
    setup.keys.find((key) => key.keyId === keyId);
  const labelOf = (keyId: string): string => keyOf(keyId)?.label ?? keyId;

  useEffect(() => {
    if (!setup.keys.some((key) => key.provider === 'gemini')) return;
    let live = true;
    session
      .writeOrThrow<{ models: readonly ModelInfo[] }>(
        PROVIDER_MODELS_URL,
        { provider: 'gemini' },
        'POST',
      )
      .then((result) => {
        if (live && result !== undefined) setGeminiModels(result.models);
      })
      .catch(() => {
        // No list (no key yet, or the service refused it): the rows stay typed fields.
      });
    return () => {
      live = false;
    };
  }, [session, setup.keys]);

  const savedByPair = new Map(setup.chain.map((entry) => [`${entry.keyId} ${entry.model}`, entry]));

  const save = async (): Promise<void> => {
    setSaveError(undefined);
    if (rows.some((row) => row.model.trim() === '' || row.keyId === '')) {
      setError('Name a model and pick a key for every row.');
      return;
    }
    if (rows.some((row) => !validLimit(row.rpmLimit) || !validLimit(row.rpdLimit))) {
      setError('Limits must be whole numbers of 1 or more. Leave a limit blank for no limit.');
      return;
    }
    setError(undefined);
    setSaving(true);
    try {
      const result = await session.writeOrThrow<{ ok: boolean; count: number }>(
        MODEL_CHAIN_URL,
        {
          entries: rows.map((row) => ({
            keyId: row.keyId,
            model: row.model.trim(),
            rpmLimit: row.rpmLimit === '' ? null : Number(row.rpmLimit),
            rpdLimit: row.rpdLimit === '' ? null : Number(row.rpdLimit),
          })),
        },
        'PUT',
      );
      if (result === undefined) return;
      toast({ tone: 'ok', title: 'Model order saved' });
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) {
        setSaveError(err);
        return;
      }
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const testRow = async (index: number): Promise<void> => {
    setTesting(index);
    try {
      const result = await session.writeOrThrow<TestOutcome & { latencyMs: number }>(
        MODEL_CHAIN_TEST_URL,
        { position: index },
        'POST',
      );
      if (result === undefined) return;
      setResults((current) => ({ ...current, [index]: result }));
    } catch (err) {
      // writeOrThrow lets the server's answer through; render it rather
      // than translating the refusal here.
      setResults((current) => ({
        ...current,
        [index]: { ok: false, error: err },
      }));
    } finally {
      setTesting(undefined);
    }
  };

  return (
    <Card title="Model order">
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No models yet. Add a key below, then add a row here to choose what answers first.
        </p>
      ) : (
        <OrderedList
          items={rows}
          itemKey={(row) => `${row.keyId} ${row.model}`}
          itemLabel={(row) => `${row.model} on ${labelOf(row.keyId)}`}
          renderItem={(row, index) => {
            const number = index + 1;
            const key = keyOf(row.keyId);
            const saved = savedByPair.get(`${row.keyId} ${row.model}`);
            const result = results[index];
            const pill =
              saved === undefined ? (
                <StatusPill tone="attention">Needs attention</StatusPill>
              ) : saved.status === 'ready' ? (
                <StatusPill tone="ready">Ready</StatusPill>
              ) : saved.status === 'disabled' ? (
                <StatusPill tone="off">Off</StatusPill>
              ) : (
                <StatusPill tone="attention">Needs attention</StatusPill>
              );
            const reason =
              saved === undefined
                ? 'Not saved yet. Save the order to check this row.'
                : saved.status === 'ready' || saved.status === 'disabled'
                  ? undefined
                  : saved.status === 'allowance-used'
                    ? `Free allowance used — resets ${new Date(saved.allowanceResetsAt ?? 0).toLocaleString()}`
                    : CHAIN_REASON[saved.status];
            const rpmProblem = fieldError(saveError, `entries.${index}.rpmLimit`);
            const rpdProblem = fieldError(saveError, `entries.${index}.rpdLimit`);
            return (
              <div className="grid gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="grid gap-0.5 text-xs text-ink-muted">
                    Key for row {number}
                    <select
                      aria-label={`Key for row ${number}`}
                      value={row.keyId}
                      onChange={(event) => {
                        const keyId = event.target.value;
                        setRows((current) =>
                          current.map((r, i) => (i === index ? { ...r, keyId } : r)),
                        );
                      }}
                      className="mt-0.5 block rounded-sm border border-line bg-canvas px-2 py-1 text-sm text-ink"
                    >
                      {setup.keys.map((option) => (
                        <option key={option.keyId} value={option.keyId}>
                          {option.label} ({providerName(option.provider)})
                        </option>
                      ))}
                    </select>
                  </label>
                  {key?.provider === 'gemini' && geminiModels !== undefined ? (
                    <label className="grid min-w-40 flex-1 gap-0.5 text-xs text-ink-muted">
                      Model for row {number}
                      <select
                        aria-label={`Model for row ${number}`}
                        value={row.model}
                        onChange={(event) => {
                          const model = event.target.value;
                          setRows((current) =>
                            current.map((r, i) => (i === index ? { ...r, model } : r)),
                          );
                        }}
                        className="mt-0.5 block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-sm text-ink"
                      >
                        {row.model !== '' && !geminiModels.some((m) => m.id === row.model) && (
                          <option value={row.model}>{row.model}</option>
                        )}
                        {geminiModels.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} ({m.id})
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <Field label={`Model for row ${number}`}>
                      <Input
                        value={row.model}
                        onChange={(event) => {
                          const model = event.target.value;
                          setRows((current) =>
                            current.map((r, i) => (i === index ? { ...r, model } : r)),
                          );
                        }}
                        placeholder={
                          key?.provider === 'gemini'
                            ? 'For example gemini-2.5-flash'
                            : 'The model id'
                        }
                      />
                    </Field>
                  )}
                  <div className="w-24">
                    <Field label="RPM" {...(rpmProblem === undefined ? {} : { error: rpmProblem })}>
                      <Input
                        aria-label={`RPM limit for row ${number}`}
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        placeholder="no limit"
                        value={row.rpmLimit}
                        onChange={(event) => {
                          const rpmLimit = event.target.value;
                          setRows((current) =>
                            current.map((r, i) => (i === index ? { ...r, rpmLimit } : r)),
                          );
                        }}
                      />
                    </Field>
                  </div>
                  <div className="w-24">
                    <Field label="RPD" {...(rpdProblem === undefined ? {} : { error: rpdProblem })}>
                      <Input
                        aria-label={`RPD limit for row ${number}`}
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        placeholder="no limit"
                        value={row.rpdLimit}
                        onChange={(event) => {
                          const rpdLimit = event.target.value;
                          setRows((current) =>
                            current.map((r, i) => (i === index ? { ...r, rpdLimit } : r)),
                          );
                        }}
                      />
                    </Field>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {pill}
                  {reason !== undefined && <span className="text-ink-muted">{reason}</span>}
                </div>
                {saved?.usage !== undefined && (
                  <p className="text-xs text-ink-muted">
                    RPM {saved.usage.lastMinute}
                    {saved.rpmLimit !== null ? ` / ${saved.rpmLimit}` : ''} · today{' '}
                    {saved.usage.today}
                    {saved.rpdLimit !== null ? ` / ${saved.rpdLimit}` : ''}
                    {saved.usage.availableAt !== undefined
                      ? ` · frees up ${new Date(saved.usage.availableAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                      : ''}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    busy={testing === index}
                    onClick={() => void testRow(index)}
                    aria-label={
                      row.model === ''
                        ? `Test row ${number}`
                        : `Test ${row.model} on ${labelOf(row.keyId)}`
                    }
                  >
                    Test
                  </Button>
                  <Button
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                    aria-label={`Remove row ${number}`}
                  >
                    Remove
                  </Button>
                  {result !== undefined &&
                    (result.ok ? (
                      <span className="text-sm text-ink-muted">
                        Row {number} answered “{result.reply ?? 'ready'}”.
                      </span>
                    ) : result.failure !== undefined ? (
                      <DescribedNotice
                        described={{
                          title: result.failure.title,
                          message: result.failure.explanation,
                          hint: result.failure.hint,
                          code: result.failure.code,
                          ...(result.failure.httpStatus === undefined
                            ? {}
                            : { status: result.failure.httpStatus }),
                          fields: [],
                        }}
                        detail={[result.failure.host, result.failure.netCode].filter(
                          (part): part is string => part !== undefined && part !== '',
                        )}
                      />
                    ) : typeof result.error === 'string' ? (
                      <span role="alert" className="text-sm text-danger">
                        {result.error}
                      </span>
                    ) : result.error !== undefined ? (
                      <ErrorNotice error={result.error} compact />
                    ) : (
                      <span role="alert" className="text-sm text-danger">
                        The test request failed.
                      </span>
                    ))}
                </div>
              </div>
            );
          }}
          onReorder={(next) => setRows(next)}
          label="Model order"
        />
      )}
      {error !== undefined && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          onClick={() =>
            setRows((current) => [
              ...current,
              { keyId: setup.keys[0]?.keyId ?? '', model: '', rpmLimit: '', rpdLimit: '' },
            ])
          }
          disabled={setup.keys.length === 0}
          title={setup.keys.length === 0 ? 'Add a key first' : undefined}
        >
          Add a row
        </Button>
        <Button variant="primary" busy={saving} onClick={() => void save()}>
          Save order
        </Button>
        {saveError !== undefined &&
          !rows.some(
            (_, index) =>
              fieldError(saveError, `entries.${index}.rpmLimit`) !== undefined ||
              fieldError(saveError, `entries.${index}.rpdLimit`) !== undefined,
          ) && <ErrorNotice error={saveError} compact />}
      </div>
    </Card>
  );
}

/** API keys: the list with Edit / Disable / Delete plus the "Add a key" form. */
function KeysSection({
  setup,
  onChanged,
}: {
  readonly setup: AssistantSetupData;
  readonly onChanged: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const [provider, setProvider] = useState<'gemini' | 'openrouter' | 'nvidia-nim'>('gemini');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [cost, setCost] = useState<'free' | 'paid' | 'unknown'>('unknown');
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [editLabel, setEditLabel] = useState('');
  const [editKey, setEditKey] = useState('');
  const [editCost, setEditCost] = useState<'free' | 'paid' | 'unknown'>('unknown');
  const [confirmingDisable, setConfirmingDisable] = useState<SetupKeyRow | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState<SetupKeyRow | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const add = async (): Promise<void> => {
    if (label.trim() === '' || apiKey === '') {
      setAddError('Add a label and paste the key.');
      return;
    }
    setAddError(undefined);
    setAdding(true);
    try {
      const result = await session.write<{ keyId: string }>(
        ASSISTANT_KEYS_URL,
        { provider, label: label.trim(), apiKey, costClass: cost },
        'POST',
      );
      if (result === undefined) return;
      // The key is write-only: drop it from the page the moment it is stored.
      setApiKey('');
      setLabel('');
      toast({ tone: 'ok', title: 'Key added' });
      onChanged();
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (key: SetupKeyRow): void => {
    setEditing(key.keyId);
    setEditLabel(key.label);
    setEditKey('');
    setEditCost(key.costClass);
  };

  const saveEdit = async (key: SetupKeyRow): Promise<void> => {
    const body: Record<string, unknown> = {};
    if (editLabel.trim() !== '' && editLabel.trim() !== key.label) body.label = editLabel.trim();
    if (editKey !== '') body.apiKey = editKey;
    if (editCost !== key.costClass) body.costClass = editCost;
    if (Object.keys(body).length === 0) {
      setEditing(undefined);
      return;
    }
    setBusy(true);
    try {
      if (
        (await session.write<{ ok: boolean }>(assistantKeyUrl(key.keyId), body, 'PATCH')) ===
        undefined
      )
        return;
      setEditKey('');
      setEditing(undefined);
      toast({ tone: 'ok', title: 'Key saved' });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (key: SetupKeyRow, enabled: boolean): Promise<void> => {
    setBusy(true);
    try {
      if (
        (await session.write<{ ok: boolean }>(assistantKeyUrl(key.keyId), { enabled }, 'PATCH')) ===
        undefined
      )
        return;
      setConfirmingDisable(undefined);
      toast({ tone: 'ok', title: enabled ? 'Key enabled' : 'Key disabled' });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (key: SetupKeyRow): Promise<void> => {
    setBusy(true);
    try {
      const result = await session.write<{ ok: boolean }>(
        assistantKeyUrl(key.keyId),
        undefined,
        'DELETE',
      );
      if (result === undefined) return;
      setConfirmingDelete(undefined);
      toast({ tone: 'ok', title: 'Key deleted' });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="API keys">
      {setup.keys.length === 0 ? (
        <p className="text-sm text-ink-muted">No keys yet. Add one below.</p>
      ) : (
        <ul className="grid gap-2" aria-label="Saved keys">
          {setup.keys.map((key) => (
            <li
              key={key.keyId}
              className="grid gap-1.5 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm"
            >
              <p>
                <strong>{key.label}</strong> · {providerName(key.provider)} ·{' '}
                {costWords(key.costClass)} ·{' '}
                {!key.enabled ? 'Off' : !key.readable ? "Can't be read" : 'On'}
              </p>
              {key.allowanceResetsAt !== undefined && (
                <p className="text-ink-muted">
                  Free allowance used — resets {new Date(key.allowanceResetsAt).toLocaleString()}
                </p>
              )}
              {editing === key.keyId ? (
                <div className="grid gap-2">
                  <Field label="Label">
                    <Input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} />
                  </Field>
                  <Field label="API key">
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={editKey}
                      onChange={(e) => setEditKey(e.target.value)}
                      placeholder="Saved. Leave blank to keep it"
                    />
                  </Field>
                  <fieldset>
                    <legend className="mb-1 block text-sm text-ink-muted">Cost</legend>
                    <div className="flex flex-col gap-1 text-sm">
                      {(
                        [
                          ['free', 'Free'],
                          ['paid', 'Paid'],
                          ['unknown', 'Not sure'],
                        ] as const
                      ).map(([value, words]) => (
                        <label key={value} className="inline-flex items-center gap-2">
                          <input
                            type="radio"
                            name={`cost-${key.keyId}`}
                            value={value}
                            checked={editCost === value}
                            onChange={() => setEditCost(value)}
                          />
                          {words}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" busy={busy} onClick={() => void saveEdit(key)}>
                      Save key
                    </Button>
                    <Button onClick={() => setEditing(undefined)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => startEdit(key)} aria-label={`Edit ${key.label}`}>
                    Edit
                  </Button>
                  {key.enabled ? (
                    <Button
                      onClick={() => setConfirmingDisable(key)}
                      aria-label={`Disable ${key.label}`}
                    >
                      Disable
                    </Button>
                  ) : (
                    <Button
                      busy={busy}
                      onClick={() => void setEnabled(key, true)}
                      aria-label={`Enable ${key.label}`}
                    >
                      Enable
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    onClick={() => setConfirmingDelete(key)}
                    aria-label={`Delete ${key.label}`}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-4 grid gap-3 border-t border-line pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <p className="flex flex-wrap items-center gap-1 text-sm font-medium">
          Add a key{' '}
          <HelpTip label="API key allowances">
            Keys from the same provider account share that account’s allowance — add a key from a
            different account if you want a real backup.
          </HelpTip>
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-0.5 text-sm">
            <span className="mb-1 block text-ink-muted">Service</span>
            <select
              aria-label="Service"
              value={provider}
              onChange={(e) =>
                setProvider(e.target.value as 'gemini' | 'openrouter' | 'nvidia-nim')
              }
              className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <Field label="Label" hint="1–60 characters, so you can tell backups apart">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
          </Field>
        </div>
        <Field label="API key">
          <Input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Field>
        <fieldset>
          <legend className="mb-1 block text-sm text-ink-muted">Is this key free to use?</legend>
          <div className="flex flex-col gap-1 text-sm">
            {(
              [
                ['free', 'Free'],
                ['paid', 'Paid'],
                ['unknown', 'Not sure'],
              ] as const
            ).map(([value, words]) => (
              <label key={value} className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name="cost-new"
                  value={value}
                  checked={cost === value}
                  onChange={() => setCost(value)}
                />
                {words}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            Bananasaurs has a $0 spending limit, so only free models can be used.
          </p>
        </fieldset>
        {addError !== undefined && (
          <p role="alert" className="text-sm text-danger">
            {addError}
          </p>
        )}
        <div>
          <Button variant="primary" type="submit" busy={adding}>
            Add key
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirmingDisable !== undefined}
        title={`${confirmingDisable?.label ?? ''} — turn this key off?`}
        scope={
          <p>
            Rows in the model order that use {confirmingDisable?.label ?? 'this key'} stop answering
            until it is enabled again.
          </p>
        }
        confirmLabel="Disable key"
        busy={busy}
        onConfirm={() =>
          confirmingDisable !== undefined && void setEnabled(confirmingDisable, false)
        }
        onCancel={() => setConfirmingDisable(undefined)}
      />
      <ConfirmDialog
        open={confirmingDelete !== undefined}
        title={`Delete ${confirmingDelete?.label ?? ''}?`}
        scope={
          <p>
            This deletes the key and also removes its rows from the model order. This cannot be
            undone.
          </p>
        }
        confirmLabel="Delete key"
        danger
        busy={busy}
        onConfirm={() => confirmingDelete !== undefined && void remove(confirmingDelete)}
        onCancel={() => setConfirmingDelete(undefined)}
      />
    </Card>
  );
}

/** One provider card: status pill, terms status, the may-train warning, key count. */
function ProvidersSection({
  setup,
  providerTerms,
  isOwner,
  onChanged,
}: {
  readonly setup: AssistantSetupData;
  readonly providerTerms: ProviderTerms | null;
  readonly isOwner: boolean;
  readonly onChanged: () => void;
}) {
  const termsSentence = (eligibility: string): string => {
    if (eligibility === 'eligible')
      return 'Terms recorded: this service does not train on your data.';
    if (eligibility === 'may-train') return MAY_TRAIN_COPY;
    if (eligibility === 'ineligible')
      return "This service's terms do not allow answering member questions.";
    return 'No terms record yet. Record what the terms say before using this service.';
  };
  return (
    <Card title="Providers">
      <ul className="grid gap-2" aria-label="Providers">
        {setup.providers.map((row) => {
          const info = PROVIDERS.find((p) => p.id === row.provider);
          const pill =
            row.keyCount === 0 ? (
              <StatusPill tone="off">Off</StatusPill>
            ) : row.eligibility === 'eligible' ? (
              <StatusPill tone="ready">Ready</StatusPill>
            ) : (
              <StatusPill tone="attention">Needs attention</StatusPill>
            );
          return (
            <li
              key={row.provider}
              className="grid gap-1.5 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm"
            >
              <p className="flex flex-wrap items-center gap-2">
                <strong>{info?.name ?? row.provider}</strong>
                {pill}
              </p>
              <p className="text-ink-muted">{termsSentence(row.eligibility)}</p>
              <p className="text-ink-muted">
                {row.keyCount === 1 ? '1 key' : `${String(row.keyCount)} keys`}
              </p>
            </li>
          );
        })}
      </ul>
      {setup.providers
        .filter((row) => row.keyCount > 0)
        .map((row) => {
          const info = PROVIDERS.find((p) => p.id === row.provider);
          if (info === undefined) return null;
          return (
            <div key={row.provider} className="mt-4">
              <TermsCard
                info={info}
                terms={providerTerms?.provider === info.id ? providerTerms : null}
                isOwner={isOwner}
                onSaved={onChanged}
              />
            </div>
          );
        })}
    </Card>
  );
}

/** A search limit is blank (no limit) or a whole number from 1 to 1,000,000. */
const validSearchLimit = (text: string): boolean => {
  if (text === '') return true;
  if (!/^[1-9]\d*$/.test(text)) return false;
  return Number(text) <= 1_000_000;
};

const SEARCH_LIMIT_ERROR =
  'Limits must be whole numbers from 1 to 1,000,000. Leave a limit blank for no limit.';

/** One saved search key: usage, move, edit and remove. The key itself is write-only. */
function SearchKeyItem({
  keyRow,
  isFirst,
  isLast,
  onChanged,
}: {
  readonly keyRow: SearchKeyRow;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onChanged: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [editLabel, setEditLabel] = useState(keyRow.label);
  const [editKey, setEditKey] = useState('');
  const [editMonthly, setEditMonthly] = useState(keyRow.monthlyLimit?.toString() ?? '');
  const [editDaily, setEditDaily] = useState(keyRow.dailyLimit?.toString() ?? '');
  const [editEnabled, setEditEnabled] = useState(keyRow.enabled);
  const [editError, setEditError] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const startEdit = (): void => {
    setEditLabel(keyRow.label);
    setEditKey('');
    setEditMonthly(keyRow.monthlyLimit?.toString() ?? '');
    setEditDaily(keyRow.dailyLimit?.toString() ?? '');
    setEditEnabled(keyRow.enabled);
    setEditError(undefined);
    setEditing(true);
  };

  const saveEdit = async (): Promise<void> => {
    if (!validSearchLimit(editMonthly) || !validSearchLimit(editDaily)) {
      setEditError(SEARCH_LIMIT_ERROR);
      return;
    }
    const body: Record<string, unknown> = {};
    if (editLabel.trim() !== '' && editLabel.trim() !== keyRow.label)
      body.label = editLabel.trim();
    if (editKey !== '') body.apiKey = editKey;
    if (editEnabled !== keyRow.enabled) body.enabled = editEnabled;
    const monthly = editMonthly === '' ? null : Number(editMonthly);
    if (monthly !== keyRow.monthlyLimit) body.monthlyLimit = monthly;
    const daily = editDaily === '' ? null : Number(editDaily);
    if (daily !== keyRow.dailyLimit) body.dailyLimit = daily;
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    setEditError(undefined);
    setBusy(true);
    try {
      if ((await session.write<{ ok: boolean }>(searchKeyUrl(keyRow.keyId), body, 'PATCH')) === undefined)
        return;
      setEditKey('');
      setEditing(false);
      toast({ tone: 'ok', title: 'Key saved' });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const move = async (direction: 'up' | 'down'): Promise<void> => {
    setBusy(true);
    try {
      if (
        (await session.write<{ ok: boolean }>(
          searchKeyMoveUrl(keyRow.keyId),
          { direction },
          'POST',
        )) === undefined
      )
        return;
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      if (
        (await session.write<{ ok: boolean }>(searchKeyUrl(keyRow.keyId), undefined, 'DELETE')) ===
        undefined
      )
        return;
      setConfirming(false);
      toast({ tone: 'ok', title: 'Key removed' });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const monthlyText =
    keyRow.monthlyLimit !== null
      ? `${String(keyRow.usage.last31d)} / ${String(keyRow.monthlyLimit)} searches in the last 31 days`
      : `${String(keyRow.usage.last31d)} searches in the last 31 days`;

  return (
    <li className="grid gap-1.5 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <strong>{keyRow.label}</strong>
        <Badge tone={keyRow.enabled ? 'ok' : 'neutral'}>{keyRow.enabled ? 'On' : 'Off'}</Badge>
        {!keyRow.readable && <Badge>Unreadable</Badge>}
      </p>
      <p className="text-xs text-ink-muted">{monthlyText}</p>
      {keyRow.dailyLimit !== null && (
        <p className="text-xs text-ink-muted">
          {`${String(keyRow.usage.last24h)} / ${String(keyRow.dailyLimit)} today`}
        </p>
      )}
      {keyRow.usage.availableAt !== undefined && (
        <p className="text-xs text-ink-muted">
          Paused until {new Date(keyRow.usage.availableAt).toLocaleString()}
        </p>
      )}
      {editing ? (
        <div className="grid gap-2">
          <Field label="Label">
            <Input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} maxLength={60} />
          </Field>
          <Field label="Replace key" hint="Leave blank to keep the saved key">
            <Input
              type="password"
              autoComplete="new-password"
              value={editKey}
              onChange={(e) => setEditKey(e.target.value)}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Monthly limit" hint="Blank means no limit">
              <Input
                type="number"
                min={1}
                max={1_000_000}
                step={1}
                inputMode="numeric"
                value={editMonthly}
                onChange={(e) => setEditMonthly(e.target.value)}
              />
            </Field>
            <Field label="Daily limit" hint="Blank means no limit">
              <Input
                type="number"
                min={1}
                max={1_000_000}
                step={1}
                inputMode="numeric"
                value={editDaily}
                onChange={(e) => setEditDaily(e.target.value)}
              />
            </Field>
          </div>
          <Checkbox
            label="Use this key"
            checked={editEnabled}
            onChange={(e) => setEditEnabled(e.target.checked)}
          />
          {editError !== undefined && (
            <p role="alert" className="text-sm text-danger">
              {editError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" busy={busy} onClick={() => void saveEdit()}>
              Save key
            </Button>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void move('up')}
            aria-label={`Move ${keyRow.label} up`}
            disabled={isFirst}
          >
            ↑
          </Button>
          <Button
            onClick={() => void move('down')}
            aria-label={`Move ${keyRow.label} down`}
            disabled={isLast}
          >
            ↓
          </Button>
          <Button onClick={startEdit} aria-label={`Edit ${keyRow.label}`}>
            Edit
          </Button>
          <Button
            variant="danger"
            onClick={() => setConfirming(true)}
            aria-label={`Remove ${keyRow.label}`}
          >
            Remove
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Remove ${keyRow.label}?`}
        scope={<p>This deletes the key. This cannot be undone.</p>}
        confirmLabel="Remove key"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirming(false)}
      />
    </li>
  );
}

/**
 * ADR 0066, amended by ADR 0120: web search through Brave or Tavily, with
 * several labelled keys per source and per-key limits. Owner-only, because it
 * sends queries to a new outside service. Keys are write-only; the list shows
 * labels, limits and usage, never the keys.
 */
function WebSearchCard({
  status,
  isOwner,
  onSaved,
}: {
  readonly status: AiStatus | undefined;
  readonly isOwner: boolean;
  readonly onSaved: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const [source, setSource] = useState<SearchSource>(status?.webSearch?.source ?? 'brave');
  const [enabled, setEnabled] = useState(status?.webSearch?.enabled ?? false);
  const [busy, setBusy] = useState(false);
  const [addLabel, setAddLabel] = useState('');
  const [addKey, setAddKey] = useState('');
  const [addMonthly, setAddMonthly] = useState('1000');
  const [addDaily, setAddDaily] = useState('');
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);

  const loadKeys = useCallback((): Promise<SearchKeysData> => {
    if (!isOwner)
      return Promise.resolve({ enabled: false, source: 'brave' as SearchSource, keys: [] });
    return session.read<SearchKeysData>(SEARCH_KEYS_URL);
  }, [session, isOwner]);
  const keysResource = useResource('web search keys', loadKeys);

  const reloadKeys = (): void => {
    keysResource.reload();
    onSaved();
  };

  const submit = async (): Promise<void> => {
    if (status === undefined) return;
    setBusy(true);
    try {
      const result = await session.write<AiStatus>(
        PROVIDER_URL,
        {
          provider: status.provider,
          enabled: status.enabled,
          searchEnabled: enabled,
          searchSource: source,
        },
        'PUT',
      );
      if (result === undefined) return;
      toast({ tone: 'ok', title: enabled ? 'Web search is on' : 'Web search is off' });
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const add = async (): Promise<void> => {
    if (addLabel.trim() === '' || addKey === '') {
      setAddError('Add a label and paste the key.');
      return;
    }
    if (!validSearchLimit(addMonthly) || !validSearchLimit(addDaily)) {
      setAddError(SEARCH_LIMIT_ERROR);
      return;
    }
    setAddError(undefined);
    setAdding(true);
    try {
      const result = await session.write<{ keyId: string }>(
        SEARCH_KEYS_URL,
        {
          source,
          label: addLabel.trim(),
          apiKey: addKey,
          monthlyLimit: addMonthly === '' ? null : Number(addMonthly),
          ...(addDaily === '' ? {} : { dailyLimit: Number(addDaily) }),
        },
        'POST',
      );
      if (result === undefined) return;
      // The key is write-only: drop it from the page the moment it is stored.
      setAddKey('');
      setAddLabel('');
      setAddMonthly('1000');
      setAddDaily('');
      toast({ tone: 'ok', title: 'Key added' });
      reloadKeys();
    } finally {
      setAdding(false);
    }
  };

  const sourceName = source === 'brave' ? 'Brave' : 'Tavily';

  return (
    <Card title="Web search">
      <div className="grid gap-3">
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={!isOwner}>
            <legend className="mb-1 block text-sm font-medium">Search service</legend>
            <div className="grid gap-3">
              <div className="grid gap-1">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="search-source"
                    value="brave"
                    checked={source === 'brave'}
                    onChange={() => setSource('brave')}
                    disabled={!isOwner}
                  />
                  Brave Search
                </label>
                <p className="text-sm text-ink-muted">
                  About 1,000 free searches a month. Answers that use it end with &ldquo;Powered by
                  Brave Search&rdquo;. Brave’s terms forbid using results to train AI.{' '}
                  <a
                    className="underline"
                    href="https://api-dashboard.search.brave.com/terms-of-service"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Read the terms
                  </a>{' '}
                  ·{' '}
                  <a
                    className="underline"
                    href="https://api-dashboard.search.brave.com/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Get an API key
                  </a>
                </p>
              </div>
              <div className="grid gap-1">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="search-source"
                    value="tavily"
                    checked={source === 'tavily'}
                    onChange={() => setSource('tavily')}
                    disabled={!isOwner}
                  />
                  Tavily
                </label>
                <p className="text-sm text-ink-muted">
                  1,000 free searches a month, no card needed. Tavily may keep search queries and
                  use them to improve its services, including training AI.{' '}
                  <a
                    className="underline"
                    href="https://tavily.com/terms"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Read the terms
                  </a>{' '}
                  ·{' '}
                  <a className="underline" href="https://app.tavily.com" target="_blank" rel="noreferrer">
                    Get an API key
                  </a>
                </p>
              </div>
            </div>
          </fieldset>
          <Checkbox
            label="Let the assistant search the web"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={!isOwner}
          />
          {isOwner ? (
            <div>
              <Button type="submit" busy={busy}>
                Save web search
              </Button>
            </div>
          ) : (
            <p className="text-xs text-ink-muted">Only the server owner can change web search.</p>
          )}
        </form>
        {isOwner && (
          <div className="grid gap-3 border-t border-line pt-3">
            <DataState resource={keysResource.resource}>
              {(data) => {
                const rows = data.keys
                  .filter((key) => key.source === source)
                  .slice()
                  .sort((a, b) => a.position - b.position);
                if (rows.length === 0)
                  return <p className="text-sm text-ink-muted">No {sourceName} keys yet.</p>;
                return (
                  <ul className="grid gap-2" aria-label="Saved search keys">
                    {rows.map((key, index) => (
                      <SearchKeyItem
                        key={key.keyId}
                        keyRow={key}
                        isFirst={index === 0}
                        isLast={index === rows.length - 1}
                        onChanged={reloadKeys}
                      />
                    ))}
                  </ul>
                );
              }}
            </DataState>
            <form
              className="grid gap-3"
              // Native min/step validation would stop the submit before the
              // inline limit check below runs; the card reports bad limits
              // itself so the owner always sees the same message.
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void add();
              }}
            >
              <p className="text-sm font-medium">Add a key</p>
              <Field label="Label" hint="1–60 characters, so you can tell keys apart">
                <Input value={addLabel} onChange={(e) => setAddLabel(e.target.value)} maxLength={60} />
              </Field>
              <Field label="Key">
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={addKey}
                  onChange={(e) => setAddKey(e.target.value)}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Monthly limit" hint="Blank means no limit">
                  <Input
                    type="number"
                    min={1}
                    max={1_000_000}
                    step={1}
                    inputMode="numeric"
                    value={addMonthly}
                    onChange={(e) => setAddMonthly(e.target.value)}
                  />
                </Field>
                <Field label="Daily limit" hint="Blank means no limit">
                  <Input
                    type="number"
                    min={1}
                    max={1_000_000}
                    step={1}
                    inputMode="numeric"
                    value={addDaily}
                    onChange={(e) => setAddDaily(e.target.value)}
                  />
                </Field>
              </div>
              {addError !== undefined && (
                <p role="alert" className="text-sm text-danger">
                  {addError}
                </p>
              )}
              <div>
                <Button variant="primary" type="submit" busy={adding}>
                  Add key
                </Button>
              </div>
            </form>
            <p className="text-xs text-ink-muted">
              Several keys are for a spare or a paid key. Using several free accounts to get more
              searches breaks Brave’s and Tavily’s terms.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

/** The GitHub token: optional, write-only, cleared with null. */
function GithubSection({
  tokenConfigured,
  onChanged,
}: {
  readonly tokenConfigured: boolean;
  readonly onChanged: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (value: string | null): Promise<void> => {
    setBusy(true);
    try {
      const result = await session.write<{ ok: boolean; tokenConfigured: boolean }>(
        GITHUB_TOKEN_URL,
        { token: value },
        'PUT',
      );
      if (result === undefined) return;
      // The token is write-only: drop it from the page the moment it is stored.
      setToken('');
      toast({ tone: 'ok', title: value === null ? 'GitHub token cleared' : 'GitHub token saved' });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="GitHub token (optional)">
      <div className="grid gap-3">
        <p className="text-sm text-ink-muted">
          Without a token GitHub allows 60 requests an hour, so organisations refresh once a day and
          only README files are read.
        </p>
        <p className="text-sm text-ink-muted">
          To include private repositories, create a fine-grained token with Contents: Read-only
          access to the repositories you choose. Club members can then ask about those repositories,
          and their text is sent to your AI providers.
        </p>
        {tokenConfigured && (
          <p className="text-sm text-ink-muted">Saved. Saving a new token replaces it.</p>
        )}
        <Field label="GitHub token">
          <Input
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            {...(tokenConfigured ? { placeholder: 'Saved. Leave blank to keep it' } : {})}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            busy={busy}
            disabled={token === ''}
            onClick={() => void save(token)}
          >
            Save token
          </Button>
          {tokenConfigured && (
            <Button busy={busy} onClick={() => void save(null)}>
              Clear token
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function TermsForm({
  provider,
  providerName,
  defaultUrl,
  initial,
  onSaved,
}: {
  readonly provider: string;
  readonly providerName: string;
  readonly defaultUrl: string;
  readonly initial: ProviderTerms | null;
  readonly onSaved: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const [trains, setTrains] = useState<'no' | 'yes' | 'unknown'>(
    initial?.trainsOnInput ?? 'unknown',
  );
  const [clause, setClause] = useState(initial?.evidenceClause ?? '');
  const [url, setUrl] = useState(initial?.evidenceUrl ?? defaultUrl);
  const [production, setProduction] = useState(initial?.productionUseAllowed ?? false);
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await session.writeOrThrow<ProviderTerms>(
        providerTermsUrl(provider),
        {
          trainsOnInput: trains,
          evidenceClause: clause,
          evidenceUrl: url,
          productionUseAllowed: production,
        },
        'PUT',
      );
      if (result === undefined) return;
      toast({ tone: 'ok', title: 'Terms record saved' });
      onSaved();
    } catch (err: unknown) {
      // writeOrThrow lets the server's 400/409 answers through; everything
      // else already became a toast. Render the answer with its field
      // problems rather than translating the refusal here.
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const clauseProblem = fieldError(error, 'evidenceClause');
  const urlProblem = fieldError(error, 'evidenceUrl');

  return (
    <form
      className="mt-3 grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset>
        <legend className="mb-1 block text-sm text-ink-muted">
          Does {providerName} use your server&apos;s data to train its models?
        </legend>
        <div className="flex flex-col gap-1 text-sm">
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              name={`trains-${provider}`}
              value="no"
              checked={trains === 'no'}
              onChange={() => setTrains('no')}
            />
            No
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              name={`trains-${provider}`}
              value="yes"
              checked={trains === 'yes'}
              onChange={() => setTrains('yes')}
            />
            Yes
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              name={`trains-${provider}`}
              value="unknown"
              checked={trains === 'unknown'}
              onChange={() => setTrains('unknown')}
            />
            The terms don&apos;t say
          </label>
        </div>
      </fieldset>
      <Field
        label="Quote the sentence from the terms that says so"
        hint={`${clause.length}/2000 characters`}
        {...(clauseProblem === undefined ? {} : { error: clauseProblem })}
      >
        <textarea
          className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
          rows={3}
          value={clause}
          onChange={(e) => setClause(e.target.value)}
        />
      </Field>
      <Field
        label="Link to that part of the terms"
        {...(urlProblem === undefined ? {} : { error: urlProblem })}
      >
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://"
        />
      </Field>
      <div className="text-sm">
        <Checkbox
          label="The terms allow use for answering member questions"
          checked={production}
          onChange={(e) => setProduction(e.target.checked)}
        />
      </div>
      {error !== undefined && <ErrorNotice error={error} />}
      <div>
        <Button variant="primary" type="submit" busy={busy}>
          Save terms record
        </Button>
      </div>
    </form>
  );
}

/**
 * The stored terms record for one provider, plus the owner-only form.
 * A stored record reads as a summary; the form stays hidden until the
 * owner asks to update it, so a first-time reader sees what is true.
 */
function TermsCard({
  info,
  terms,
  isOwner,
  onSaved,
}: {
  readonly info: (typeof PROVIDERS)[number];
  readonly terms: ProviderTerms | null;
  readonly isOwner: boolean;
  readonly onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <Card title="Terms record">
      <p className="text-sm text-ink-muted">
        Discord&apos;s developer policy only allows sending server content to a service that
        doesn&apos;t train on it. Record what {info.name}&apos;s terms say. The assistant stays off
        unless they say it doesn&apos;t train on your data.
      </p>
      {terms !== null && (
        <div className="mt-3 text-sm">
          <p>
            Recorded {new Date(terms.reviewedAt).toLocaleDateString()}:{' '}
            {trainsLabel(terms.trainsOnInput)}
          </p>
          {terms.evidenceClause !== undefined && terms.evidenceClause !== '' && (
            <blockquote className="mt-2 border-l-2 border-line pl-3 text-ink-muted">
              {terms.evidenceClause}
            </blockquote>
          )}
          <a
            className="mt-2 inline-block underline"
            href={terms.evidenceUrl}
            target="_blank"
            rel="noreferrer"
          >
            Read the cited terms
          </a>
        </div>
      )}
      {!isOwner ? (
        <p className="mt-3 text-sm text-ink-muted">Only the server owner can record the terms.</p>
      ) : terms === null ? (
        <TermsForm
          key={info.id}
          provider={info.id}
          providerName={info.name}
          defaultUrl={info.termsUrl}
          initial={terms}
          onSaved={onSaved}
        />
      ) : editing ? (
        <TermsForm
          key={info.id}
          provider={info.id}
          providerName={info.name}
          defaultUrl={info.termsUrl}
          initial={terms}
          onSaved={() => {
            setEditing(false);
            onSaved();
          }}
        />
      ) : (
        <div className="mt-3">
          <Button onClick={() => setEditing(true)}>Update the terms record</Button>
        </div>
      )}
    </Card>
  );
}

/**
 * `/providers` and `/assistant/setup`: the AI setup page. The setup checklist
 * comes first, then the ordered model list with its fallbacks, the labelled
 * API keys, one card per provider, web search, and the optional GitHub token.
 * "I checked these terms today" records that the owner re-checked the row as
 * it stands — it writes the review date, never the row's claims. Changing a
 * provider's training flag or production eligibility stays a config change on
 * the host.
 */
export function ProvidersPage() {
  const session = useSession();
  const toast = useToast();
  const loadSetup = useCallback(
    () => session.read<AssistantSetupData>(ASSISTANT_PROVIDERS_URL),
    [session],
  );
  const setup = useResource('the AI setup', loadSetup);
  const loadAssistant = useCallback(() => session.read<AssistantData>(ASSISTANT_URL), [session]);
  const assistant = useResource('the assistant', loadAssistant);
  const loadWarnings = useCallback(
    () =>
      session
        .read<{ warnings: EligibilityWarning[] }>('/api/providers/eligibility')
        .then((r) => r.warnings),
    [session],
  );
  const warnings = useResource('the provider eligibility warnings', loadWarnings);

  const [reviewing, setReviewing] = useState<EligibilityWarning | undefined>(undefined);
  const [reviewBusy, setReviewBusy] = useState(false);

  const reloadAll = () => {
    setup.reload();
    assistant.reload();
    warnings.reload();
  };

  const review = async () => {
    if (reviewing === undefined) return;
    setReviewBusy(true);
    try {
      const result = await session.write<ProviderReviewResult>(
        `/api/providers/${encodeURIComponent(reviewing.provider)}/review`,
        {},
      );
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: `${result.provider} marked reviewed`,
          message: `Review date moved from ${new Date(result.previouslyReviewedAt).toLocaleDateString()} to ${new Date(result.reviewedAt).toLocaleDateString()}.`,
        });
        warnings.reload();
      }
    } finally {
      setReviewBusy(false);
      setReviewing(undefined);
    }
  };

  return (
    <>
      <PageHeader
        title="AI setup"
        purpose="Choose which AI models answer, in what order, and connect the services they need."
      />
      <div className="max-w-4xl">
        <DataState resource={setup.resource}>
          {(data) => (
            <SetupBody
              setup={data}
              assistant={assistant.resource.state === 'ready' ? assistant.resource.data : undefined}
              onChanged={reloadAll}
            />
          )}
        </DataState>
        <div className="mt-4">
          <DataState
            resource={warnings.resource}
            isEmpty={(rows) => rows.length === 0}
            empty={null}
          >
            {(rows) => (
              <Card title="Service terms to check">
                <DataTable
                  caption="Provider eligibility warnings"
                  rows={rows}
                  rowKey={(w) => `${w.provider}:${w.reason}`}
                  columns={[
                    { key: 'provider', header: 'Provider', cell: (w) => w.provider },
                    {
                      key: 'trains',
                      header: 'Uses server data for training',
                      cell: (w) => (
                        <Badge tone={trainsTone(w.trainsOnInput)}>
                          {w.trainsOnInput === 'no'
                            ? 'No'
                            : w.trainsOnInput === 'yes'
                              ? 'Yes'
                              : 'Not confirmed'}
                        </Badge>
                      ),
                    },
                    {
                      key: 'reason',
                      header: 'Why it is listed',
                      cell: (w) => REASON_TEXT[w.reason],
                    },
                    {
                      key: 'reviewed',
                      header: 'Last reviewed',
                      cell: (w) =>
                        w.reason === 'unverified'
                          ? 'never — no record exists'
                          : new Date(w.reviewedAt).toLocaleDateString(),
                    },
                    {
                      key: 'actions',
                      header: '',
                      // Nothing to review without a row: "I checked these terms today" writes
                      // the review date of a record, and this one does not exist.
                      cell: (w) =>
                        w.reason === 'unverified' ? null : (
                          <Button onClick={() => setReviewing(w)}>
                            I checked these terms today
                          </Button>
                        ),
                    },
                  ]}
                />
              </Card>
            )}
          </DataState>
        </div>
      </div>
      <ConfirmDialog
        open={reviewing !== undefined}
        title={`Mark ${reviewing?.provider ?? ''} reviewed?`}
        scope={
          <p>
            Records that you re-checked the training-eligibility row for {reviewing?.provider ?? ''}{' '}
            as it stands today. It writes the review date only — the row&apos;s claims do not
            change.
          </p>
        }
        confirmLabel="I checked these terms today"
        busy={reviewBusy}
        onConfirm={() => void review()}
        onCancel={() => setReviewing(undefined)}
      />
    </>
  );
}

function SetupBody({
  setup,
  assistant,
  onChanged,
}: {
  readonly setup: AssistantSetupData;
  readonly assistant: AssistantData | undefined;
  readonly onChanged: () => void;
}) {
  const chainSignature = JSON.stringify(
    setup.chain.map((c) => [c.keyId, c.model, c.rpmLimit, c.rpdLimit]),
  );
  return (
    <>
      <ChecklistSection setup={setup} assistant={assistant} />
      <div className="mt-4">
        <ModelOrderSection key={chainSignature} setup={setup} onChanged={onChanged} />
      </div>
      <div className="mt-4">
        <KeysSection setup={setup} onChanged={onChanged} />
      </div>
      <div className="mt-4">
        <ProvidersSection
          setup={setup}
          providerTerms={assistant?.providerTerms ?? null}
          isOwner={assistant?.viewerIsOwner ?? false}
          onChanged={onChanged}
        />
      </div>
      <div className="mt-4">
        <WebSearchCard
          key={`web-${String(assistant?.aiStatus?.webSearch?.enabled ?? false)}-${assistant?.aiStatus?.webSearch?.source ?? 'brave'}`}
          status={assistant?.aiStatus}
          isOwner={assistant?.viewerIsOwner ?? false}
          onSaved={onChanged}
        />
      </div>
      <div className="mt-4">
        <GithubSection tokenConfigured={setup.github.tokenConfigured} onChanged={onChanged} />
      </div>
    </>
  );
}
