import { useCallback, useState } from 'react';
import {
  PROVIDER_URL,
  SEARCH_KEYS_URL,
  searchKeyMoveUrl,
  searchKeyUrl,
  type AiStatus,
  type SearchKeyRow,
  type SearchKeysData,
  type SearchSource,
} from '../../api/assistant.js';
import { useSession } from '../../app/session.js';
import { useResource } from '../../hooks/useResource.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { DataState } from '../../ui/DataState.js';
import { Checkbox, Field, Input } from '../../ui/Field.js';
import { useToast } from '../../ui/Toast.js';

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
    if (editLabel.trim() !== '' && editLabel.trim() !== keyRow.label) body.label = editLabel.trim();
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
      if (
        (await session.write<{ ok: boolean }>(searchKeyUrl(keyRow.keyId), body, 'PATCH')) ===
        undefined
      )
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
            <Input
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              maxLength={60}
            />
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
export function WebSearchCard({
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
  const [addMonthly, setAddMonthly] = useState(
    status?.webSearch?.source === 'parallel' ? '4500' : '1000',
  );
  const [addDaily, setAddDaily] = useState('');
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);

  const loadKeys = useCallback((): Promise<SearchKeysData> => {
    if (!isOwner) return Promise.resolve({ enabled: false, source: 'brave', keys: [] });
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
      setAddMonthly(source === 'parallel' ? '4500' : '1000');
      setAddDaily('');
      toast({ tone: 'ok', title: 'Key added' });
      reloadKeys();
    } finally {
      setAdding(false);
    }
  };

  const sourceName = source === 'brave' ? 'Brave' : source === 'tavily' ? 'Tavily' : 'Parallel';

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
                    onChange={() => {
                      setSource('brave');
                      setAddMonthly((v) => (v === '4500' ? '1000' : v));
                    }}
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
                    onChange={() => {
                      setSource('tavily');
                      setAddMonthly((v) => (v === '4500' ? '1000' : v));
                    }}
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
                  <a
                    className="underline"
                    href="https://app.tavily.com"
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
                    value="parallel"
                    checked={source === 'parallel'}
                    onChange={() => {
                      setSource('parallel');
                      setAddMonthly((v) => (v === '1000' ? '4500' : v));
                    }}
                    disabled={!isOwner}
                  />
                  Parallel
                </label>
                <p className="text-sm text-ink-muted">
                  Parallel offers 5,000 free searches a month, then $1 per 1,000. Parallel may use
                  search queries to train its models.{' '}
                  <a
                    className="underline"
                    href="https://parallel.ai/terms"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Read the terms
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
                <Input
                  value={addLabel}
                  onChange={(e) => setAddLabel(e.target.value)}
                  maxLength={60}
                />
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
