import { DraftFooter } from './draft-footer.js';
import { FormSection } from '../../ui/FormSection.js';
import { ErrorSummary } from '../../ui/ErrorSummary.js';
import { useSections, KeptSection } from './section-tabs.js';
import { Empty } from '../../ui/states.js';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { fieldError } from '../../api/describe-error.js';
import {
  TUNING_URL,
  tuningKeyUrl,
  type TuningListResponse,
  type TuningSetResponse,
  type TuningSetting,
} from '../../api/tuning.js';
import { useSession } from '../../app/session.js';
import { useResource } from '../../hooks/useResource.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { DataState } from '../../ui/DataState.js';
import { ErrorNotice } from '../../ui/ErrorNotice.js';
import { Field, Input } from '../../ui/Field.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { useToast } from '../../ui/Toast.js';

/** The current base-unit value as the control's draft text. Secrets are never pre-filled. */
const toDraft = (setting: TuningSetting): string => {
  switch (setting.display) {
    case 'seconds':
      return typeof setting.value === 'number' ? String(setting.value / 1000) : '';
    case 'milliseconds':
    case 'minutes':
    case 'count':
      return typeof setting.value === 'number' ? String(setting.value) : '';
    case 'seconds-list':
      return Array.isArray(setting.value)
        ? (setting.value as readonly number[]).map((ms) => String(ms / 1000)).join(', ')
        : '';
    case 'text':
      return typeof setting.value === 'string' ? setting.value : '';
    case 'secret':
      return '';
    case 'host-list':
      return Array.isArray(setting.value) ? (setting.value as readonly string[]).join(', ') : '';
  }
};

type Parsed =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/** The draft back to a base-unit value, or a short message when it does not parse. */
const parseDraft = (setting: TuningSetting, draft: string): Parsed => {
  const trimmed = draft.trim();
  const number = (unit: string): Parsed => {
    const n = Number(trimmed);
    if (trimmed === '' || !Number.isFinite(n))
      return { ok: false, error: `Enter a number of ${unit}.` };
    return { ok: true, value: n };
  };
  switch (setting.display) {
    case 'seconds': {
      const parsed = number('seconds');
      return parsed.ok ? { ok: true, value: Math.round((parsed.value as number) * 1000) } : parsed;
    }
    case 'milliseconds':
    case 'minutes':
      return number(setting.display === 'minutes' ? 'minutes' : 'milliseconds');
    case 'count': {
      const n = Number(trimmed);
      if (trimmed === '' || !Number.isFinite(n) || !Number.isInteger(n))
        return { ok: false, error: 'Enter a whole number.' };
      return { ok: true, value: n };
    }
    case 'seconds-list': {
      if (trimmed === '') return { ok: true, value: [] };
      const parts = trimmed.split(',');
      const seconds: number[] = [];
      for (const part of parts) {
        const n = Number(part.trim());
        if (part.trim() === '' || !Number.isFinite(n))
          return { ok: false, error: 'Enter seconds separated by commas, for example 10, 30, 90.' };
        seconds.push(Math.round(n * 1000));
      }
      return { ok: true, value: seconds };
    }
    case 'text':
      return { ok: true, value: trimmed === '' ? null : trimmed };
    case 'secret':
      return { ok: true, value: draft };
    case 'host-list': {
      if (trimmed === '') return { ok: true, value: [] };
      return {
        ok: true,
        value: trimmed
          .split(',')
          .map((host) => host.trim().toLowerCase())
          .filter((host) => host !== ''),
      };
    }
  }
};

const isConfigured = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  (value as { configured?: unknown }).configured === true;

/** The default in the unit the control shows; null and [] read as None. */
const formatDefault = (setting: TuningSetting): string => {
  const value = setting.defaultValue;
  switch (setting.display) {
    case 'seconds':
      return typeof value === 'number' ? `${value / 1000} seconds` : 'None';
    case 'milliseconds':
      return typeof value === 'number' ? `${value} ms` : 'None';
    case 'minutes':
      return typeof value === 'number' ? `${value} minutes` : 'None';
    case 'count':
      return typeof value === 'number' ? String(value) : 'None';
    case 'seconds-list':
      return Array.isArray(value) && (value as readonly number[]).length > 0
        ? `${(value as readonly number[]).map((ms) => ms / 1000).join(', ')} seconds`
        : 'None';
    case 'text':
      return typeof value === 'string' && value !== '' ? value : 'None';
    case 'secret':
      return isConfigured(value) ? 'Configured' : 'None';
    case 'host-list':
      return Array.isArray(value) && (value as readonly string[]).length > 0
        ? (value as readonly string[]).join(', ')
        : 'None';
  }
};

/** "Allowed: <min>–<max> <unit>" for numeric settings with bounds, in the shown unit. */
const allowedText = (setting: TuningSetting): string | undefined => {
  const bounds = setting.bounds;
  if (bounds === undefined) return undefined;
  const range = (
    min: number | undefined,
    max: number | undefined,
    unit: string,
  ): string | undefined => {
    if (min === undefined && max === undefined) return undefined;
    const span = `${min ?? '…'}–${max ?? '…'}`;
    return unit === '' ? `Allowed: ${span}` : `Allowed: ${span} ${unit}`;
  };
  switch (setting.display) {
    case 'seconds':
      return range(
        bounds.min === undefined ? undefined : bounds.min / 1000,
        bounds.max === undefined ? undefined : bounds.max / 1000,
        'seconds',
      );
    case 'milliseconds':
      return range(bounds.min, bounds.max, 'ms');
    case 'minutes':
      return range(bounds.min, bounds.max, 'minutes');
    case 'count':
      return range(bounds.min, bounds.max, '');
    default:
      return undefined;
  }
};

function TuningRow({
  setting,
  onUpdated,
}: {
  readonly setting: TuningSetting;
  readonly onUpdated: (next: TuningSetting) => void;
}): ReactElement {
  const session = useSession();
  const toast = useToast();
  const [draft, setDraft] = useState(() => toDraft(setting));
  const [baseline, setBaseline] = useState(() => toDraft(setting));
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  // A replaced row (after a save or reset) starts from the fresh value.
  useEffect(() => {
    setDraft(toDraft(setting));
    setBaseline(toDraft(setting));
    setLocalError(undefined);
    setError(undefined);
  }, [setting]);

  const configured = setting.display === 'secret' && isConfigured(setting.value);
  const fieldProblem = error === undefined ? undefined : fieldError(error, '');
  const problem = localError ?? fieldProblem;
  const allowed = allowedText(setting);

  const save = async (): Promise<void> => {
    if (busy) return;
    const parsed = parseDraft(setting, draft);
    if (!parsed.ok) {
      setLocalError(parsed.error);
      setError(undefined);
      return;
    }
    setBusy(true);
    try {
      // `writeOrThrow` (not `write`) so a 400/404/503 reaches this row's
      // inline error instead of a toast; anything else is the session's
      // toast contract, like every other write.
      let updated: TuningSetResponse | undefined;
      try {
        updated = await session.writeOrThrow<TuningSetResponse>(
          tuningKeyUrl(setting.key),
          { value: parsed.value },
          'PUT',
          [400, 404, 503],
        );
      } catch (err) {
        setLocalError(undefined);
        setError(err);
        return;
      }
      if (updated === undefined) return;
      setLocalError(undefined);
      setError(undefined);
      onUpdated(updated.setting);
      toast({ tone: 'ok', title: 'Saved', message: setting.label });
    } finally {
      setBusy(false);
    }
  };

  const reset = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      // The API accepts a bodiless DELETE; `writeOrThrow` leaves the body
      // off when it is undefined, like every other dashboard DELETE.
      let updated: TuningSetResponse | undefined;
      try {
        updated = await session.writeOrThrow<TuningSetResponse>(
          tuningKeyUrl(setting.key),
          undefined,
          'DELETE',
          [404, 503],
        );
      } catch (err) {
        setLocalError(undefined);
        setError(err);
        return;
      }
      if (updated === undefined) return;
      setLocalError(undefined);
      setError(undefined);
      onUpdated(updated.setting);
      toast({ tone: 'ok', title: 'Reset to default', message: setting.label });
    } finally {
      setBusy(false);
    }
  };

  const removeSecret = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      let updated: TuningSetResponse | undefined;
      try {
        updated = await session.writeOrThrow<TuningSetResponse>(
          tuningKeyUrl(setting.key),
          { value: null },
          'PUT',
          [400, 404, 503],
        );
      } catch (err) {
        setLocalError(undefined);
        setError(err);
        return;
      }
      if (updated === undefined) return;
      setLocalError(undefined);
      setError(undefined);
      onUpdated(updated.setting);
      toast({ tone: 'ok', title: 'Removed', message: setting.label });
    } finally {
      setBusy(false);
    }
  };

  const numeric =
    setting.display === 'seconds' ||
    setting.display === 'milliseconds' ||
    setting.display === 'minutes' ||
    setting.display === 'count';
  const secret = setting.display === 'secret';
  const placeholder = secret
    ? configured
      ? 'Configured — type to replace'
      : 'Not set'
    : undefined;

  return (
    <div
      data-testid={`tuning-row-${setting.key}`}
      className="grid gap-2 rounded-sm border border-line bg-canvas/60 px-3 py-2"
    >
      <form
        id={`tuning-form-${setting.key}`}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <FormSection title={`Edit ${setting.label}`}>
          <ErrorSummary
            errors={
              problem === undefined
                ? []
                : [{ fieldId: `field-${setting.key.replaceAll('.', '-')}`, message: problem }]
            }
          />
          <Field
            htmlFor={`field-${setting.key.replaceAll('.', '-')}`}
            label={setting.label}
            hint={setting.help}
            {...(problem === undefined ? {} : { error: problem })}
          >
            <Input
              type={numeric ? 'number' : secret ? 'password' : 'text'}
              {...(numeric ? { step: 1 } : {})}
              {...(placeholder === undefined ? {} : { placeholder })}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </Field>
          <p className="text-xs text-ink-muted">
            Default: {formatDefault(setting)}
            {allowed !== undefined ? ` · ${allowed}` : ''}
          </p>
          <DraftFooter
            dirty={draft !== baseline}
            busy={busy}
            onSave={() => {
              const form = document.getElementById(`tuning-form-${setting.key}`);
              if (form instanceof HTMLFormElement) form.requestSubmit();
            }}
            onDiscard={() => {
              setDraft(baseline);
              setLocalError(undefined);
              setError(undefined);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              hidden={draft !== baseline}
              busy={busy}
              disabled={secret && draft === ''}
              onClick={() => void save()}
            >
              Save
            </Button>
            <Button busy={busy} disabled={setting.isDefault} onClick={() => void reset()}>
              Reset
            </Button>
            {secret && configured && (
              <Button variant="danger" busy={busy} onClick={() => void removeSecret()}>
                Remove
              </Button>
            )}
          </div>
          {error !== undefined && <ErrorNotice error={error} compact />}
        </FormSection>
      </form>
    </div>
  );
}

function TuningCards({ initial }: { readonly initial: readonly TuningSetting[] }): ReactElement {
  const [settings, setSettings] = useState(initial);
  const sections = useSections([
    { value: 'all', label: 'All settings' },
    { value: 'assistant', label: 'Assistant' },
    { value: 'resources', label: 'Resources' },
    { value: 'other', label: 'Network and connector' },
  ]);
  // Browser Back restores the selected tab but leaves focus on the old
  // trigger. When the tab changes without a click or keyboard on the tabs
  // (those already leave focus on the new trigger) and focus is on one of
  // this list's triggers, follow it to the newly selected trigger. Focus
  // anywhere else is left alone, as is first mount.
  const tabsRef = useRef<HTMLDivElement>(null);
  const prevSection = useRef(sections.value);
  useEffect(() => {
    if (prevSection.current === sections.value) return;
    prevSection.current = sections.value;
    const root = tabsRef.current;
    const active = document.activeElement;
    if (root === null || !(active instanceof HTMLElement) || !root.contains(active)) return;
    if (active.getAttribute('role') !== 'tab') return;
    const selected = root.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (selected === null || selected === active) return;
    selected.focus();
  }, [sections.value]);
  const onUpdated = useCallback(
    (next: TuningSetting) =>
      setSettings((all) => all.map((setting) => (setting.key === next.key ? next : setting))),
    [],
  );
  const byGroup = new Map<string, TuningSetting[]>();
  for (const setting of settings) {
    const items = byGroup.get(setting.group);
    if (items === undefined) byGroup.set(setting.group, [setting]);
    else items.push(setting);
  }
  const groups = [...byGroup].map(([name, items]) => ({ name, items }));
  return (
    <div ref={tabsRef}>
      {sections.render(
        <>
          {groups.map((group) => (
            <KeptSection
              key={group.name}
              hidden={
                sections.value !== 'all' &&
                (group.name.startsWith('Assistant')
                  ? sections.value !== 'assistant'
                  : group.name === 'Resources'
                    ? sections.value !== 'resources'
                    : sections.value !== 'other')
              }
            >
              <Card title={group.name}>
                <div className="grid gap-2">
                  {group.items.map((setting) => (
                    <TuningRow key={setting.key} setting={setting} onUpdated={onUpdated} />
                  ))}
                </div>
              </Card>
            </KeptSection>
          ))}
        </>,
      )}
    </div>
  );
}

/**
 * Assistant → AI tuning (ADR 0080): every bot-wide setting with its help,
 * current value, default and limits. Instance owner only — the nav hides the
 * entry from anyone else and the API answers `owner-only` regardless, which
 * renders here as the load error.
 */
export function AssistantTuningPage(): ReactElement {
  const session = useSession();
  const load = useCallback(() => session.read<TuningListResponse>(TUNING_URL), [session]);
  const tuning = useResource('the AI tuning settings', load);
  return (
    <>
      <PageHeader
        title="AI tuning"
        purpose="These settings apply to every server this bot is in. Changes take effect at once."
      />
      <div className="grid max-w-4xl gap-3">
        <DataState
          resource={tuning.resource}
          isEmpty={(data) => data.settings.length === 0}
          empty={
            <Empty
              title="No tuning settings reported"
              detail="The current configuration stays in effect. Refresh when settings are available."
              action={<Button onClick={tuning.reload}>Refresh</Button>}
            />
          }
        >
          {(data) => <TuningCards initial={data.settings} />}
        </DataState>
      </div>
    </>
  );
}
