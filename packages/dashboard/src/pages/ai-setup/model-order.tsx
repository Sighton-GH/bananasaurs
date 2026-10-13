import { useCallback, useEffect, useState } from 'react';
import {
  MODEL_CHAIN_TEST_URL,
  MODEL_CHAIN_URL,
  PROVIDER_MODELS_URL,
  providerName,
  type AssistantSetupData,
  type ModelInfo,
  type SetupChainRow,
  type SetupKeyRow,
} from '../../api/assistant.js';
import { ApiError } from '../../api.js';
import { fieldError } from '../../api/describe-error.js';
import {
  formatRate,
  formatUsd,
  modelHealthUrl,
  type ModelHealthResponse,
} from '../../api/model-health.js';
import { useSession } from '../../app/session.js';
import { useResource } from '../../hooks/useResource.js';
import { relativeTime } from '../../lib/relative-time.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { ErrorNotice, DescribedNotice } from '../../ui/ErrorNotice.js';
import { Field, Input } from '../../ui/Field.js';
import { HelpTip } from '../../ui/HelpTip.js';
import { OrderedList } from '../../ui/OrderedList.js';
import { StatusPill } from '../../ui/StatusPill.js';
import { useToast } from '../../ui/Toast.js';

const CHAIN_REASON: Record<Exclude<SetupChainRow['status'], 'ready' | 'allowance-used'>, string> = {
  'no-key': 'This key is gone. Choose another key or add it again.',
  'key-unreadable': "The saved key can't be read on this host. Paste it again.",
  disabled: 'This key is disabled.',
  ineligible: "This service's terms do not allow answering member questions.",
  unverified: 'No terms record for this service yet. Record the terms below.',
};

interface ChainDraft {
  readonly keyId: string;
  readonly model: string;
  readonly rpmLimit: string;
  readonly rpdLimit: string;
  /** Carried through so saving the order never resets the pool or tier. */
  readonly pool?: 'key' | 'provider';
  readonly tier?: 'light' | 'standard';
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
export function ModelOrderSection({
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
      ...(entry.pool === undefined ? {} : { pool: entry.pool }),
      ...(entry.tier === undefined ? {} : { tier: entry.tier }),
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

  // ADR 0129 §8: one 24-hour health fetch for the page. A failure or 403
  // resolves to no models, so each row below shows — instead of an error.
  const healthLoad = useCallback(
    () =>
      session
        .read<ModelHealthResponse>(modelHealthUrl('24h'))
        .catch(() => ({ window: '24h', models: [] })),
    [session],
  );
  const health = useResource('model health', healthLoad);
  const healthByPair = new Map(
    health.resource.state === 'ready'
      ? health.resource.data.models.map((m) => [`${m.keyId} ${m.model}`, m] as const)
      : [],
  );

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
            ...(row.pool === undefined ? {} : { pool: row.pool }),
            ...(row.tier === undefined ? {} : { tier: row.tier }),
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
      <p className="flex flex-wrap items-center gap-1 text-xs text-ink-muted">
        Model capabilities
        <HelpTip label="Model capabilities">
          Read from OpenRouter&apos;s model list, refreshed hourly.
        </HelpTip>
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No models yet. Add a key below, then add a row here to choose what answers first.
        </p>
      ) : (
        <OrderedList
          stacked
          items={rows}
          itemKey={(row) => `${row.keyId} ${row.model}`}
          itemLabel={(row) => `${row.model} on ${labelOf(row.keyId)}`}
          renderItem={(row, index) => {
            const number = index + 1;
            const key = keyOf(row.keyId);
            const saved = savedByPair.get(`${row.keyId} ${row.model}`);
            const pairHealth = healthByPair.get(`${row.keyId} ${row.model}`);
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
                {/* Fit whole fields on each flex line, rather than shrinking Model beside a long Key. */}
                <div className="flex flex-wrap items-center gap-2">
                  <label className="grid w-64 min-w-0 max-w-full flex-none gap-0.5 text-xs text-ink-muted">
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
                      className="mt-0.5 block w-full max-w-full rounded-sm border border-line bg-canvas px-2 py-1 text-sm text-ink"
                    >
                      {setup.keys.map((option) => (
                        <option key={option.keyId} value={option.keyId}>
                          {option.label} ({providerName(option.provider)})
                        </option>
                      ))}
                    </select>
                  </label>
                  {key?.provider === 'gemini' && geminiModels !== undefined ? (
                    <label className="grid min-w-[min(16rem,100%)] max-w-full flex-1 basis-64 gap-0.5 text-xs text-ink-muted">
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
                    <div className="min-w-[min(16rem,100%)] max-w-full flex-1 basis-64">
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
                    </div>
                  )}
                  <div className="w-24 max-w-full shrink-0">
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
                  <div className="w-24 max-w-full shrink-0">
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
                  {pairHealth?.persistent !== undefined && (
                    <Badge tone="danger">Persistent failure</Badge>
                  )}
                  {reason !== undefined && <span className="text-ink-muted">{reason}</span>}
                </div>
                {saved?.listing?.listed === false && (
                  <p role="alert" className="text-sm text-danger">
                    OpenRouter no longer lists this model; requests to it will fail. Pick another
                    model.
                  </p>
                )}
                {saved?.listing?.listed !== false && saved?.listing !== undefined && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {saved.listing.image && <Badge>Reads images</Badge>}
                    {saved.listing.file && <Badge>Reads PDFs</Badge>}
                    {saved.listing.tools && <Badge>Uses tools</Badge>}
                    {saved.listing.reasoning && <Badge>Thinks</Badge>}
                  </div>
                )}
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
                {/* ADR 0129 §8: the row's 24-hour health; — in each slot with no match. */}
                {pairHealth === undefined ? (
                  <p className="text-xs text-ink-muted">
                    Success (24h) — · p50 / p95 — · Last error — · Cost (24h) —
                  </p>
                ) : (
                  <p className="text-xs text-ink-muted">
                    Success (24h) {formatRate(pairHealth.successRate)} ({pairHealth.calls} calls) ·
                    p50 / p95 {pairHealth.p50Ms === null ? '—' : `${String(pairHealth.p50Ms)} ms`} /{' '}
                    {pairHealth.p95Ms === null ? '—' : `${String(pairHealth.p95Ms)} ms`} · Last
                    error{' '}
                    {pairHealth.lastError === undefined ? (
                      '—'
                    ) : (
                      <span
                        {...(pairHealth.lastError.providerMessage === undefined
                          ? {}
                          : { title: pairHealth.lastError.providerMessage })}
                      >
                        {pairHealth.lastError.code}{' '}
                        {relativeTime(pairHealth.lastError.at, Date.now())}
                      </span>
                    )}{' '}
                    · Cost (24h) {formatUsd(pairHealth.costUsd)}
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
