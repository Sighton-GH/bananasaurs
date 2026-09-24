import { useCallback, useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ApiError } from '../api.js';
import {
  ASSISTANT_URL,
  PROVIDERS,
  PROVIDER_MODELS_URL,
  PROVIDER_URL,
  type ModelInfo,
  providerTermsUrl,
  type AiStatus,
  type AssistantData,
  type AssistantSetup,
  type ProviderId,
  type ProviderTerms,
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
import { PageHeader } from '../ui/PageHeader.js';
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

/** The setup steps the status line reads, in the order the owner meets them. */
const STATUS_STEP_IDS = ['connect', 'terms', 'cost'] as const;

/** One badge plus one sentence: answering, or what still blocks answers. */
function StatusLine({ setup }: { readonly setup: AssistantSetup | undefined }) {
  if (setup === undefined) return null;
  // A warning step works (ADR 0062): it is shown, never treated as unfinished.
  const warnings = setup.steps.filter((s) => s.state === 'warning');
  if (setup.answering) {
    return (
      <div className="space-y-2">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="ok">Answering</Badge>
          <span>The assistant can answer members.</span>
        </p>
        {warnings.map((step) => (
          <p key={step.id} role="note" className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="hold">Warning</Badge>
            <span>{step.detail}</span>
          </p>
        ))}
      </div>
    );
  }
  const next = STATUS_STEP_IDS.map((id) => setup.steps.find((s) => s.id === id)).find(
    (s) => s !== undefined && s.state !== 'done' && s.state !== 'warning',
  );
  if (next === undefined) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="hold">Not answering yet</Badge>
        <span>
          Finish setup on the{' '}
          <Link href="/assistant" className="underline">
            Assistant page
          </Link>
          .
        </span>
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <Badge tone="hold">Not answering yet</Badge>
      <span>{next.detail}</span>
    </p>
  );
}

/**
 * The saved AI service, prefilled from `aiStatus` and never reset: after a
 * save the fields keep what the owner entered, and a reload re-reads the same
 * saved values. The key input stays empty and write-only throughout.
 */
function ServiceForm({
  status,
  connectDetail,
  isOwner,
  service,
  onServiceChange,
  onSaved,
}: {
  readonly status: AiStatus | undefined;
  readonly connectDetail: string | undefined;
  readonly isOwner: boolean;
  readonly service: ProviderId;
  readonly onServiceChange: (service: ProviderId) => void;
  readonly onSaved: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  // ADR 0068: the first, second and third model to try, in order.
  const [choices, setChoices] = useState<readonly [string, string, string]>([
    status?.model ?? '',
    status?.fallbackModels?.[0] ?? '',
    status?.fallbackModels?.[1] ?? '',
  ]);
  const setChoice = (index: 0 | 1 | 2, value: string) =>
    setChoices((current) => {
      const next: [string, string, string] = [...current];
      next[index] = value;
      return next;
    });
  const [models, setModels] = useState<readonly ModelInfo[] | undefined>(undefined);
  const [modelsNote, setModelsNote] = useState<string | undefined>(undefined);
  const [choiceError, setChoiceError] = useState<string | undefined>(undefined);
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(status?.enabled ?? false);
  const [cost, setCost] = useState<'free' | 'paid' | 'unknown'>(status?.costClass ?? 'unknown');
  const [busy, setBusy] = useState(false);

  const chosen = PROVIDERS.find((p) => p.id === service);
  const secretMissing = status?.secretSource === 'missing';
  const keyUnreadable = status?.keyConfigured === true && !status.keyReadable;
  // The saved key belongs to the saved service: switching service drops it
  // (the server clears key, model and cost), so the "Saved" placeholder and
  // the prefilled model and cost only apply while the chosen radio matches.
  const isSameService = status?.provider === service;
  const switchedService = chosen !== undefined && !isSameService;
  const savedService = status?.provider;
  useEffect(() => {
    if (savedService !== undefined && service !== savedService) {
      setChoices(['', '', '']);
      setModels(undefined);
      setModelsNote(undefined);
      setCost('unknown');
    }
  }, [service, savedService]);
  const keyPlaceholder =
    secretMissing === true
      ? undefined
      : isSameService && status?.keyConfigured === true && status.keyReadable
        ? 'Saved. Leave blank to keep it'
        : switchedService && chosen !== undefined
          ? `Paste the API key for ${chosen.name}`
          : undefined;

  const loadModels = async (pastedKey?: string): Promise<void> => {
    setModelsNote('Loading the models this key can use…');
    try {
      const result = await session.writeOrThrow<{ models: readonly ModelInfo[] }>(
        PROVIDER_MODELS_URL,
        { provider: 'gemini', ...(pastedKey === undefined ? {} : { apiKey: pastedKey }) },
        'POST',
      );
      if (result === undefined) {
        setModelsNote("Couldn't load the models. Type the model names instead.");
        return;
      }
      setModels(result.models);
      const top = result.models[0]?.id;
      if (top !== undefined) setChoices((c) => (c[0] === '' ? [top, c[1], c[2]] : c));
      setModelsNote(
        result.models.length === 0
          ? 'This key has no text models. Type the model names instead.'
          : 'Models this key can see. A model your plan has no quota for is skipped like a busy one.',
      );
    } catch (err: unknown) {
      const body = err instanceof ApiError ? err.body : undefined;
      setModelsNote(
        body?.error === 'no-key'
          ? 'Paste the API key to load its models.'
          : body?.error === 'provider-refused' &&
              (body as { kind?: string }).kind === 'authentication'
            ? "Gemini refused this key, so its models couldn't be loaded."
            : "Couldn't load the models. Type the model names instead.",
      );
    }
  };
  const canList = service === 'gemini' && secretMissing !== true;
  const savedKeyUsable = isSameService && status?.keyConfigured === true && status.keyReadable;
  useEffect(() => {
    if (canList && savedKeyUsable) void loadModels();
    // Only when the service or the saved key changes.
  }, [canList, savedKeyUsable]);

  const submit = async (): Promise<void> => {
    const picked = choices.map((c) => c.trim()).filter((c) => c !== '');
    if (new Set(picked).size !== picked.length) {
      setChoiceError('Choose a different model for each place.');
      return;
    }
    setChoiceError(undefined);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { provider: service, enabled };
      const trimmed = choices[0].trim();
      if (trimmed !== '') body.model = trimmed;
      // Sent only when the order changed: empty clears the backups.
      const backups = [choices[1].trim(), choices[2].trim()].filter((m) => m !== '');
      const savedBackups = isSameService ? (status?.fallbackModels ?? []) : [];
      if (backups.join('\n') !== savedBackups.join('\n')) body.fallbackModels = backups;
      if (apiKey !== '') body.apiKey = apiKey;
      if (isOwner) body.costClass = cost;
      const result = await session.write<AiStatus>(PROVIDER_URL, body, 'PUT');
      if (result === undefined) return;
      // The key is write-only: drop it from the page the moment it is stored.
      setApiKey('');
      onSaved();
      let message = 'Your changes are saved.';
      try {
        const fresh = await session.read<AssistantData>(ASSISTANT_URL);
        const detail = fresh.setup?.steps.find((s) => s.id === 'connect')?.detail;
        if (detail !== undefined && detail !== '') message = detail;
      } catch {
        // The reload above already shows the fresh state; keep the generic note.
      }
      toast({ tone: 'ok', title: 'AI setup saved', message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="AI service">
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset>
          <legend className="mb-1 block text-sm text-ink-muted">Service</legend>
          <div className="grid gap-2">
            <div className="flex items-start gap-2 text-sm">
              <input
                id="service-off"
                type="radio"
                name="ai-service"
                value="off"
                checked={service === 'off'}
                onChange={() => onServiceChange('off')}
                className="mt-1"
              />
              <label htmlFor="service-off">None (AI off)</label>
            </div>
            {PROVIDERS.map((p) => (
              <div key={p.id} className="flex items-start gap-2 text-sm">
                <input
                  id={`service-${p.id}`}
                  type="radio"
                  name="ai-service"
                  value={p.id}
                  checked={service === p.id}
                  onChange={() => onServiceChange(p.id)}
                  className="mt-1"
                />
                <div>
                  <label htmlFor={`service-${p.id}`} className="font-medium">
                    {p.name}
                  </label>
                  <p className="text-ink-muted">{p.summary}</p>
                  <p>
                    <a className="underline" href={p.termsUrl} target="_blank" rel="noreferrer">
                      Read the terms
                    </a>{' '}
                    ·{' '}
                    <a className="underline" href={p.keyUrl} target="_blank" rel="noreferrer">
                      Get an API key
                    </a>
                  </p>
                </div>
              </div>
            ))}
          </div>
        </fieldset>
        {switchedService && (
          <p className="text-sm text-ink-muted">
            Switching service clears the saved key, model and cost answer.
          </p>
        )}
        {chosen !== undefined && (
          <div className="grid gap-1">
            {keyUnreadable && (
              <p role="alert" className="text-sm text-danger">
                The saved key can&apos;t be read on this host. Paste it again.
              </p>
            )}
            <Field
              label="API key"
              {...(secretMissing === true && connectDetail !== undefined
                ? { hint: connectDetail }
                : {})}
            >
              <Input
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={() => {
                  if (canList && apiKey !== '') void loadModels(apiKey);
                }}
                disabled={secretMissing}
                {...(keyPlaceholder !== undefined ? { placeholder: keyPlaceholder } : {})}
              />
            </Field>
          </div>
        )}
        {chosen !== undefined && (
          <fieldset className="grid gap-2">
            <legend className="mb-1 block text-sm text-ink-muted">
              Models to try, in order. If one is busy the next is used. Changing the order asks the
              cost question again.
            </legend>
            {modelsNote !== undefined && <p className="text-xs text-ink-muted">{modelsNote}</p>}
            {([0, 1, 2] as const).map((index) => {
              const label =
                index === 0
                  ? 'First choice'
                  : index === 1
                    ? 'Second choice (optional)'
                    : 'Third choice (optional)';
              if (models === undefined || models.length === 0)
                return (
                  <Field
                    key={index}
                    label={label}
                    {...(index === 0 ? { hint: chosen.modelHint } : {})}
                  >
                    <Input
                      value={choices[index]}
                      onChange={(e) => setChoice(index, e.target.value)}
                    />
                  </Field>
                );
              // A saved model the list no longer shows stays selectable.
              const saved = choices[index];
              const options =
                saved !== '' && !models.some((m) => m.id === saved)
                  ? [...models, { id: saved, name: 'Saved model' }]
                  : models;
              return (
                <Field key={index} label={label}>
                  <select
                    value={saved}
                    onChange={(e) => setChoice(index, e.target.value)}
                    className="mt-1 block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
                  >
                    {index !== 0 && <option value="">None</option>}
                    {options.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.id})
                      </option>
                    ))}
                  </select>
                </Field>
              );
            })}
            {choiceError !== undefined && (
              <p role="alert" className="text-sm text-danger">
                {choiceError}
              </p>
            )}
          </fieldset>
        )}
        <div className="text-sm">
          <Checkbox
            label="Use this service for member questions"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <p className="mt-1 text-xs text-ink-muted">
            Nothing is sent until the terms are recorded and the cost is confirmed below.
          </p>
        </div>
        <fieldset>
          <legend className="mb-1 block text-sm text-ink-muted">Is this model free to use?</legend>
          <div className="flex flex-col gap-1 text-sm">
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="cost-class"
                value="free"
                checked={cost === 'free'}
                onChange={() => setCost('free')}
                disabled={!isOwner}
              />
              Yes, it&apos;s free
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="cost-class"
                value="paid"
                checked={cost === 'paid'}
                onChange={() => setCost('paid')}
                disabled={!isOwner}
              />
              No, it costs money
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="cost-class"
                value="unknown"
                checked={cost === 'unknown'}
                onChange={() => setCost('unknown')}
                disabled={!isOwner}
              />
              Not sure
            </label>
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            Bananasaurs has a $0 spending limit, so only free models can be used. Marking a paid
            model as free could put charges on your account.
          </p>
          {!isOwner && (
            <p className="mt-1 text-xs text-ink-muted">Only the server owner can change this.</p>
          )}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            type="submit"
            busy={busy}
            disabled={secretMissing}
            title={
              secretMissing === true
                ? 'Saving is unavailable until the key store is configured on the host'
                : undefined
            }
          >
            Save AI setup
          </Button>
          {secretMissing === true && connectDetail !== undefined && (
            <span className="text-sm text-ink-muted">{connectDetail}</span>
          )}
        </div>
      </form>
    </Card>
  );
}

/** The owner-only terms form, prefilled from the stored record when one exists. */
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
 * The stored terms record for the saved service, plus the owner-only form.
 * Shown only for a service the dashboard knows; anything else (off, unknown)
 * has no record to show.
 */
function TermsCard({
  info,
  terms,
  isOwner,
  chosenService,
  onSaved,
}: {
  readonly info: (typeof PROVIDERS)[number];
  readonly terms: ProviderTerms | null;
  readonly isOwner: boolean;
  readonly chosenService: ProviderId;
  readonly onSaved: () => void;
}) {
  // A stored record reads as a summary; the form stays hidden until the
  // owner asks to update it, so a first-time reader sees what is true.
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
      ) : chosenService !== info.id ? (
        <p className="mt-3 text-sm text-ink-muted">
          Save the AI service first, then record its terms.
        </p>
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
 * `/providers`: the first-time AI setup page. The service form and the terms
 * record (docs/17, ADR 0061) sit above the training-eligibility rows `doctor`
 * warns about (`bananasaurs provider status` / `provider review`). "I checked
 * these terms today" records that the owner re-checked the row as it stands —
 * it writes the review date, never the row's claims. Changing a provider's
 * training flag or production eligibility stays a config change on the host.
 */
export function ProvidersPage() {
  const session = useSession();
  const toast = useToast();
  const loadAssistant = useCallback(() => session.read<AssistantData>(ASSISTANT_URL), [session]);
  const assistant = useResource('the AI setup', loadAssistant);
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
        <DataState resource={assistant.resource}>
          {(data) => {
            const saved = data.aiStatus?.provider;
            const initialService: ProviderId =
              saved === 'off' ||
              saved === 'gemini' ||
              saved === 'openrouter' ||
              saved === 'nvidia-nim'
                ? saved
                : 'off';
            return <SetupBody data={data} initialService={initialService} onChanged={reloadAll} />;
          }}
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

/**
 * The assistant-dependent half of the page, mounted once the setup loads so
 * the service choice starts at the saved value. A save reloads the resources,
 * which re-reads the same saved values — the fields are initialised from the
 * server, never from blank defaults.
 */
function SetupBody({
  data,
  initialService,
  onChanged,
}: {
  readonly data: AssistantData;
  readonly initialService: ProviderId;
  readonly onChanged: () => void;
}) {
  const [service, setService] = useState<ProviderId>(initialService);
  const status = data.aiStatus;
  const savedInfo = PROVIDERS.find((p) => p.id === status?.provider);
  return (
    <>
      <StatusLine setup={data.setup} />
      <div className="mt-4">
        <ServiceForm
          status={status}
          connectDetail={data.setup?.steps.find((s) => s.id === 'connect')?.detail}
          isOwner={data.viewerIsOwner ?? false}
          service={service}
          onServiceChange={setService}
          onSaved={onChanged}
        />
      </div>
      <div className="mt-4">
        <WebSearchCard
          key={`web-${String(status?.webSearch?.enabled ?? false)}`}
          status={status}
          isOwner={data.viewerIsOwner ?? false}
          onSaved={onChanged}
        />
      </div>
      {savedInfo !== undefined && (
        <div className="mt-4">
          <TermsCard
            key={savedInfo.id}
            info={savedInfo}
            terms={data.providerTerms ?? null}
            isOwner={data.viewerIsOwner ?? false}
            chosenService={service}
            onSaved={onChanged}
          />
        </div>
      )}
    </>
  );
}
