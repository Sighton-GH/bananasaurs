import { useCallback, useEffect, useState } from 'react';
import { routeRun } from '@bananasaurs/core';
import { ApiError } from '../api.js';
import { TUNING_URL, tuningKeyUrl, type TuningListResponse } from '../api/tuning.js';
import { useSession } from '../app/session.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Checkbox, Field, Input } from '../ui/Field.js';
import { InlineAlert } from '../ui/InlineAlert.js';
import { Select } from '../ui/Select.js';

const K = {
  enabled: 'assistant.routerEnabled',
  maxChars: 'assistant.routerMaxChars',
  keywords: 'assistant.routerFullModelKeywords',
  greetings: 'assistant.routerGreetingPatterns',
  longThread: 'assistant.routerLongThreadTurns',
  escalate: 'assistant.routerEscalateOnTool',
  summaryTier: 'assistant.routerSummaryTier',
  digestTier: 'assistant.routerDailyDigestTier',
} as const;

type Tier = 'light' | 'standard';

interface Values {
  enabled: boolean;
  maxChars: number;
  keywords: readonly string[];
  greetings: readonly string[];
  longThread: number;
  escalate: boolean;
  summaryTier: Tier;
  digestTier: Tier;
}

/** Same defaults as the server registry; used until the saved values arrive. */
const DEFAULTS: Values = {
  enabled: true,
  maxChars: 80,
  keywords: [
    'remind',
    'schedule',
    'task',
    'ping',
    'search',
    'look up',
    'summar',
    'explain',
    'why',
    'how',
    'write',
    'story',
    'code',
    'plan',
    'compare',
    'translate',
    'fix',
  ],
  greetings: ['hi', 'hello', 'hey', 'thanks', 'thank you', 'thx', 'good morning', 'good night'],
  longThread: 4,
  escalate: true,
  summaryTier: 'light',
  digestTier: 'light',
};

/**
 * The try-box runs the daemon's own deterministic router (`routeRun` from
 * core), so it needs no request, spends no AI call and cannot drift from the
 * server's checks or reasons.
 */
export const tryRoute = (
  text: string,
  v: Values,
  earlierTurns = 0,
  flags: { readonly hasAttachments?: boolean; readonly hasQuoteOrReply?: boolean } = {},
): { tier: Tier; reason: string } =>
  routeRun(
    {
      text,
      hasAttachments: flags.hasAttachments === true,
      hasQuoteOrReply: flags.hasQuoteOrReply === true,
      earlierTurns,
    },
    {
      enabled: v.enabled,
      maxChars: v.maxChars,
      fullModelKeywords: v.keywords,
      greetingPatterns: v.greetings,
      longThreadTurns: v.longThread,
      escalateOnTool: v.escalate,
    },
  );

const asTier = (x: unknown, fallback: Tier): Tier =>
  x === 'light' || x === 'standard' ? x : fallback;
const asList = (x: unknown, fallback: readonly string[]): readonly string[] =>
  Array.isArray(x) && x.every((i) => typeof i === 'string') ? x : fallback;
const asNum = (x: unknown, fallback: number): number => (typeof x === 'number' ? x : fallback);

function ChipList({
  label,
  noun,
  items,
  onChange,
}: {
  readonly label: string;
  readonly noun: string;
  readonly items: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = (): void => {
    const value = draft.trim();
    if (value === '' || items.includes(value)) return;
    setDraft('');
    onChange([...items, value]);
  };
  return (
    <div className="grid gap-1">
      <span className="text-ink-muted">{label}</span>
      <ul aria-label={label} className="flex flex-wrap gap-1">
        {items.map((item) => (
          <li
            key={item}
            className="inline-flex items-center gap-1 rounded-panel border border-line px-1.5 py-0.5"
          >
            <span>{item}</span>
            <button
              type="button"
              aria-label={`Remove ${noun} ${item}`}
              disabled={items.length <= 1}
              onClick={() => onChange(items.filter((i) => i !== item))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Input
          aria-label={`Add ${noun}`}
          maxLength={40}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button onClick={add}>Add {noun.split(' ').pop()}</Button>
      </div>
    </div>
  );
}

/** Keeps what is typed as a draft; saves on blur or Enter, and puts the saved value back if it is out of range. */
function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (): void => {
    const n = Number(draft);
    if (draft.trim() === '' || !Number.isInteger(n) || n < min || n > max) {
      setDraft(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <Field label={label}>
      <Input
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
      />
    </Field>
  );
}

/** Owner controls for complexity routing (ADR 0144): every router setting, plus a local try-box. */
export function AssistantRoutingSettings() {
  const session = useSession();
  const [values, setValues] = useState<Values>(DEFAULTS);
  const [error, setError] = useState<string | undefined>(undefined);
  const [sample, setSample] = useState('');
  const [sampleAttachments, setSampleAttachments] = useState(false);
  const [sampleQuote, setSampleQuote] = useState(false);
  const [routed, setRouted] = useState<{ tier: Tier; reason: string } | undefined>(undefined);

  useEffect(() => {
    let live = true;
    session
      .read<TuningListResponse>(TUNING_URL)
      .then((data) => {
        if (!live) return;
        const get = (key: string): unknown => data.settings.find((s) => s.key === key)?.value;
        setValues({
          enabled: asNum(get(K.enabled), 1) === 1,
          maxChars: asNum(get(K.maxChars), DEFAULTS.maxChars),
          keywords: asList(get(K.keywords), DEFAULTS.keywords),
          greetings: asList(get(K.greetings), DEFAULTS.greetings),
          longThread: asNum(get(K.longThread), DEFAULTS.longThread),
          escalate: asNum(get(K.escalate), 1) === 1,
          summaryTier: asTier(get(K.summaryTier), 'light'),
          digestTier: asTier(get(K.digestTier), 'light'),
        });
      })
      .catch(() => {
        // Keep the defaults; saving still works once the server answers.
      });
    return () => {
      live = false;
    };
  }, [session]);

  const save = useCallback(
    async (key: string, value: unknown, apply: () => void): Promise<void> => {
      setError(undefined);
      try {
        const result = await session.writeOrThrow(tuningKeyUrl(key), { value }, 'PUT');
        if (result !== undefined) apply();
      } catch (err) {
        setError(
          err instanceof ApiError && err.status === 400
            ? 'That value is not allowed. Check the limits and try again.'
            : 'The setting could not be saved. Try again.',
        );
      }
    },
    [session],
  );

  const numberField = (
    label: string,
    key: string,
    field: 'maxChars' | 'longThread',
    min: number,
    max: number,
  ) => (
    <NumberField
      label={label}
      value={values[field]}
      min={min}
      max={max}
      onCommit={(n) => void save(key, n, () => setValues((v) => ({ ...v, [field]: n })))}
    />
  );

  const tierField = (label: string, key: string, field: 'summaryTier' | 'digestTier') => (
    <Field label={label}>
      <Select
        value={values[field]}
        onValueChange={(value) => {
          const tier = asTier(value, 'light');
          void save(key, tier, () => setValues((v) => ({ ...v, [field]: tier })));
        }}
        options={[
          { value: 'light', label: 'Light' },
          { value: 'standard', label: 'Standard' },
        ]}
        aria-label={label}
      />
    </Field>
  );

  return (
    <Card title="Routing">
      <div className="grid gap-3 text-sm">
        <p className="text-xs text-ink-muted">
          Short, simple messages try the light models first so greetings do not use the standard
          daily allowance.
        </p>
        <Checkbox
          label="Route by message size and type"
          checked={values.enabled}
          onChange={(event) => {
            const on = event.target.checked;
            void save(K.enabled, on ? 1 : 0, () => setValues((v) => ({ ...v, enabled: on })));
          }}
        />
        {numberField('Longest light message (characters)', K.maxChars, 'maxChars', 10, 1000)}
        {numberField('Long-thread turns', K.longThread, 'longThread', 0, 50)}
        <Checkbox
          label="Switch to standard after a light run uses a tool"
          checked={values.escalate}
          onChange={(event) => {
            const on = event.target.checked;
            void save(K.escalate, on ? 1 : 0, () => setValues((v) => ({ ...v, escalate: on })));
          }}
        />
        {tierField('Tier for conversation summaries', K.summaryTier, 'summaryTier')}
        {tierField('Tier for the daily digest', K.digestTier, 'digestTier')}
        <ChipList
          label="Full-model keywords"
          noun="full-model keyword"
          items={values.keywords}
          onChange={(next) =>
            void save(K.keywords, next, () => setValues((v) => ({ ...v, keywords: next })))
          }
        />
        <ChipList
          label="Greeting patterns"
          noun="greeting pattern"
          items={values.greetings}
          onChange={(next) =>
            void save(K.greetings, next, () => setValues((v) => ({ ...v, greetings: next })))
          }
        />
        <div className="grid gap-1">
          <Field label="Message to try">
            <Input value={sample} onChange={(event) => setSample(event.target.value)} />
          </Field>
          <Checkbox
            label="Has attachments"
            checked={sampleAttachments}
            onChange={(event) => setSampleAttachments(event.target.checked)}
          />
          <Checkbox
            label="Is a reply or quote"
            checked={sampleQuote}
            onChange={(event) => setSampleQuote(event.target.checked)}
          />
          <div className="flex items-center gap-3">
            <Button
              onClick={() =>
                setRouted(
                  tryRoute(sample, values, 0, {
                    hasAttachments: sampleAttachments,
                    hasQuoteOrReply: sampleQuote,
                  }),
                )
              }
            >
              Try the router
            </Button>
            {routed !== undefined && (
              <span role="status">{`${routed.tier === 'light' ? 'Light' : 'Standard'} tier · ${routed.reason}`}</span>
            )}
          </div>
        </div>
        {error !== undefined && <InlineAlert tone="danger" title="The setting could not be saved.">{error}</InlineAlert>}
      </div>
    </Card>
  );
}
