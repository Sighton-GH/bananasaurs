import { useState } from 'react';
import {
  ASSISTANT_KEYS_URL,
  providerName,
  PROVIDERS,
  assistantKeyUrl,
  type AssistantSetupData,
  type SetupKeyRow,
} from '../../api/assistant.js';
import { useSession } from '../../app/session.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { Field, Input } from '../../ui/Field.js';
import { InlineAlert } from '../../ui/InlineAlert.js';
import { RadioGroup } from '../../ui/RadioGroup.js';
import { Select } from '../../ui/Select.js';
import { HelpTip } from '../../ui/HelpTip.js';
import { StatusPill } from '../../ui/StatusPill.js';
import { useToast } from '../../ui/Toast.js';

/** ADR 0062: the training warning the provider cards show when `may-train`. */
const MAY_TRAIN_COPY =
  'This service’s terms record says it may train on your data. Member questions and server excerpts sent to it may be used for training.';

const costWords = (costClass: string): string =>
  costClass === 'free' ? 'Free' : costClass === 'paid' ? 'Paid' : 'Not sure';

/** API keys: the list with Edit / Disable / Delete plus the "Add a key" form. */
export function KeysSection({
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
              className="grid gap-1.5 rounded-panel border border-line bg-canvas px-2 py-1.5 text-sm"
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
                  <RadioGroup
                    legend="Cost"
                    name={`cost-${key.keyId}`}
                    value={editCost}
                    onChange={(value) => setEditCost(value as 'free' | 'paid' | 'unknown')}
                    options={[
                      { value: 'free', label: 'Free' },
                      { value: 'paid', label: 'Paid' },
                      { value: 'unknown', label: 'Not sure' },
                    ]}
                  />
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
          <Field label="Service">
            <Select
              value={provider}
              onValueChange={(value) =>
                setProvider(value as 'gemini' | 'openrouter' | 'nvidia-nim')
              }
              options={PROVIDERS.map((p) => ({ value: p.id, label: p.name }))}
              aria-label="Service"
            />
          </Field>
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
        <RadioGroup
          legend="Is this key free to use?"
          name="cost-new"
          value={cost}
          onChange={(value) => setCost(value as 'free' | 'paid' | 'unknown')}
          options={[
            { value: 'free', label: 'Free' },
            { value: 'paid', label: 'Paid' },
            { value: 'unknown', label: 'Not sure' },
          ]}
        />
        <p className="text-xs text-ink-muted">
          Bananasaurs has a $0 spending limit, so only free models can be used.
        </p>
        {addError !== undefined && <InlineAlert tone="danger" title="The key could not be added.">{addError}</InlineAlert>}
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
export function ProvidersSection({ setup }: { readonly setup: AssistantSetupData }) {
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
              className="grid gap-1.5 rounded-panel border border-line bg-canvas px-2 py-1.5 text-sm"
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
    </Card>
  );
}
