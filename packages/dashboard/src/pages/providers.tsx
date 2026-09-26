import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api.js';
import {
  ASSISTANT_PROVIDERS_URL,
  ASSISTANT_URL,
  ASSISTANT_KEYS_URL,
  GITHUB_TOKEN_URL,
  MODEL_CHAIN_TEST_URL,
  MODEL_CHAIN_URL,
  PROVIDER_MODELS_URL,
  PROVIDER_URL,
  providerName,
  PROVIDERS,
  providerTermsUrl,
  assistantKeyUrl,
  type AssistantData,
  type AssistantSetupData,
  type AiStatus,
  type ModelInfo,
  type ProviderTerms,
  type SetupChainRow,
  type SetupKeyRow,
} from '../api/assistant.js';
import type { EligibilityWarning, ProviderReviewResult } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
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
}

interface TestOutcome {
  readonly ok: boolean;
  readonly reply?: string;
  readonly error?: string;
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

/**
 * The classified chain-test failure, rendered where `ErrorNotice` would go:
 * no such component exists in this tree, so the page owns the small markup —
 * title, explanation and hint, plus the muted host line the caller adds.
 */
export function FailureNotice({
  failure,
}: {
  readonly failure: { readonly title: string; readonly explanation: string; readonly hint: string };
}) {
  return (
    <div role="alert" className="grid gap-1 text-sm">
      <strong>{failure.title}</strong>
      <p>{failure.explanation}</p>
      <p>
        <span className="text-ink-muted">What to do: </span>
        {failure.hint}
      </p>
    </div>
  );
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
    setup.chain.map((entry) => ({ keyId: entry.keyId, model: entry.model })),
  );
  const [geminiModels, setGeminiModels] = useState<readonly ModelInfo[] | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
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
    if (rows.some((row) => row.model.trim() === '' || row.keyId === '')) {
      setError('Name a model and pick a key for every row.');
      return;
    }
    setError(undefined);
    setSaving(true);
    try {
      const result = await session.write<{ ok: boolean; count: number }>(
        MODEL_CHAIN_URL,
        { entries: rows.map((row) => ({ keyId: row.keyId, model: row.model.trim() })) },
        'PUT',
      );
      if (result === undefined) return;
      toast({ tone: 'ok', title: 'Model order saved' });
      onChanged();
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
    } catch {
      setResults((current) => ({
        ...current,
        [index]: { ok: false, error: 'The test request failed.' },
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
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {pill}
                  {reason !== undefined && <span className="text-ink-muted">{reason}</span>}
                </div>
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
                      <div className="grid gap-1">
                        <FailureNotice failure={result.failure} />
                        {[
                          result.failure.host,
                          result.failure.httpStatus === undefined
                            ? undefined
                            : `HTTP ${String(result.failure.httpStatus)}`,
                          result.failure.netCode,
                        ].filter((part) => part !== undefined && part !== '').length > 0 && (
                          <p className="text-xs text-ink-muted">
                            {[
                              result.failure.host,
                              result.failure.httpStatus === undefined
                                ? undefined
                                : `HTTP ${String(result.failure.httpStatus)}`,
                              result.failure.netCode,
                            ]
                              .filter((part) => part !== undefined && part !== '')
                              .join(' · ')}
                          </p>
                        )}
                      </div>
                    ) : (
                      <span role="alert" className="text-sm text-danger">
                        {result.error ?? 'The test request failed.'}
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
            setRows((current) => [...current, { keyId: setup.keys[0]?.keyId ?? '', model: '' }])
          }
          disabled={setup.keys.length === 0}
          title={setup.keys.length === 0 ? 'Add a key first' : undefined}
        >
          Add a row
        </Button>
        <Button variant="primary" busy={saving} onClick={() => void save()}>
          Save order
        </Button>
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

/**
 * ADR 0066: web search through the Brave Search API. Owner-only, because it
 * sends queries to a new outside service. The key is write-only.
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
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(status?.webSearch?.enabled ?? false);
  const [busy, setBusy] = useState(false);
  const keySaved = status?.webSearch?.keyConfigured === true;

  const submit = async (): Promise<void> => {
    if (status === undefined) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        provider: status.provider,
        enabled: status.enabled,
        ...(apiKey === '' ? {} : { searchApiKey: apiKey }),
        searchEnabled: enabled,
      };
      const result = await session.write<AiStatus>(PROVIDER_URL, body, 'PUT');
      if (result === undefined) return;
      setApiKey('');
      toast({ tone: 'ok', title: enabled ? 'Web search is on' : 'Web search is off' });
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Web search">
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="text-sm text-ink-muted">
          Lets the assistant search the public web through the Brave Search API. Answers that use
          web results end with &ldquo;Powered by Brave Search&rdquo;. Brave&apos;s free allowance is
          about 1,000 searches a month.{' '}
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
        <p className="text-xs text-hold">
          Brave&apos;s terms forbid using results to train AI. While your AI service trains on what
          it is sent, search results sent to it may be used that way.
        </p>
        <Field label="Brave Search API key">
          <Input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={!isOwner}
            {...(keySaved ? { placeholder: 'Saved. Leave blank to keep it' } : {})}
          />
        </Field>
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
  const [error, setError] = useState<string | undefined>(undefined);
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
      if (err instanceof ApiError && err.status === 400) {
        setError(
          'Check the quote (at least 10 characters) and that the link starts with https://.',
        );
      } else if (err instanceof ApiError) {
        setError('The terms record was not saved. Try again.');
      } else {
        setError('The server refused this record. Check the fields and try again.');
      }
    } finally {
      setBusy(false);
    }
  };

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
        {...(error !== undefined ? { error } : {})}
      >
        <textarea
          className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
          rows={3}
          value={clause}
          onChange={(e) => setClause(e.target.value)}
        />
      </Field>
      <Field label="Link to that part of the terms">
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
  const chainSignature = JSON.stringify(setup.chain.map((c) => [c.keyId, c.model]));
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
          key={`web-${String(assistant?.aiStatus?.webSearch?.enabled ?? false)}`}
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
