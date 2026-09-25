import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import { ApiError } from '../api.js';
import { ASSISTANT_URL, type ActivityRow, type AssistantData } from '../api/assistant.js';
import {
  EMPTY_TRACE_FILTERS,
  historyUrl,
  traceListUrl,
  usageUrl,
  type TraceFilters,
  type TraceListResponse,
  type TraceRow,
  type UsageResponse,
} from '../api/traces.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { EmptyState } from '../ui/EmptyState.js';
import { Field, Input } from '../ui/Field.js';
import { MemberRef } from '../ui/MemberRef.js';
import { PageHeader } from '../ui/PageHeader.js';

const USAGE_DAYS = 14;

const outcomeTone = (outcome: TraceRow['outcome']): 'ok' | 'hold' | 'danger' =>
  outcome === 'answered' ? 'ok' : outcome === 'refused' ? 'hold' : 'danger';

const durationText = (ms: number): string =>
  ms < 1000 ? `${String(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

/** 403 carries `no-grant`; the sentence names the plain meaning, the id second. */
const historyError = (err: unknown): Error => {
  if (err instanceof ApiError && err.status === 403) {
    return new Error('your account does not hold the audit view grant (audit.read)');
  }
  return err instanceof Error ? err : new Error(String(err));
};

/**
 * The 14-day strip above the table: one plain bar per day, widths
 * proportional to that day's answers, no chart library. A load that fails
 * (usually the same missing grant) hides the strip rather than the table —
 * the table carries its own error state.
 */
function UsageStrip() {
  const session = useSession();
  const load = useCallback(() => session.read<UsageResponse>(usageUrl(USAGE_DAYS)), [session]);
  const usage = useResource('assistant usage', load);
  if (usage.resource.state !== 'ready') return null;
  const days = usage.resource.data.days;
  if (days.length === 0) return null;
  const max = Math.max(1, ...days.map((d) => d.answers));
  return (
    <section aria-label="Assistant use in the last 14 days" className="mb-4">
      <div className="flex items-end gap-1.5" role="list">
        {days.map((d) => (
          <div key={d.day} role="listitem" className="min-w-0 flex-1">
            <div
              role="img"
              aria-label={`${d.day}: ${d.answers} answers, ${d.failures} failures`}
              title={`${d.day}: ${d.answers} answers, ${d.failures} failures, ${d.fallbacks} fallbacks, ${d.tokens} tokens`}
              className="h-10 rounded-sm bg-panel"
            >
              <div
                className="h-full rounded-sm bg-hold"
                style={{ width: `${String(Math.round((d.answers / max) * 100))}%` }}
              />
            </div>
            <p className="mt-0.5 truncate text-center text-[0.625rem] text-ink-muted">
              {d.day.slice(5)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The skill-activity rows from before per-run traces existed. They stay
 * reachable in a collapsed section so no information disappears; a load that
 * fails (usually a missing config grant) omits the section silently.
 */
function OlderActivity() {
  const session = useSession();
  const load = useCallback(() => session.read<AssistantData>(ASSISTANT_URL), [session]);
  const activity = useResource('assistant skill activity', load);
  if (activity.resource.state !== 'ready' || activity.resource.data.activity.length === 0) {
    return null;
  }
  const data = activity.resource.data;
  const behaviourName = (id: string) => data.behaviours.find((b) => b.id === id)?.name ?? id;
  const skillName = (id: string) => data.skills.find((s) => s.id === id)?.name ?? id;
  return (
    <details className="mt-6 rounded-md border border-line bg-panel/60 px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">
        Older activity (before detailed history)
      </summary>
      <p className="mt-1 text-sm text-ink-muted">
        Skill attempts recorded before each run kept its own trace. Behaviour and skill names are
        shown when the behaviour still exists; otherwise the stored id.
      </p>
      <div className="mt-2">
        <DataTable
          caption="Older assistant skill activity"
          rows={data.activity}
          rowKey={(r: ActivityRow) => r.id}
          columns={[
            {
              key: 'time',
              header: 'Time',
              cell: (r) => new Date(r.at).toLocaleString('en-CA'),
            },
            { key: 'behaviour', header: 'Behaviour', cell: (r) => behaviourName(r.behaviourId) },
            { key: 'skill', header: 'Skill', cell: (r) => skillName(r.skillId) },
            {
              key: 'outcome',
              header: 'Outcome',
              cell: (r) => (
                <>
                  <Badge
                    tone={
                      r.outcome === 'refused' ? 'hold' : r.outcome === 'failed' ? 'danger' : 'ok'
                    }
                  >
                    {r.outcome}
                  </Badge>
                  {r.detail !== undefined && (
                    <span className="ml-2 text-xs text-ink-muted">{r.detail}</span>
                  )}
                </>
              ),
            },
          ]}
        />
      </div>
    </details>
  );
}

/**
 * `/assistant/history` (also `/assistant/activity`): every stored assistant
 * run, newest first, with outcome/behaviour/member filters and a "Load older"
 * cursor. A row opens its detail page at `/assistant/history/:traceId`.
 */
export function AssistantHistoryPage() {
  const session = useSession();
  const [draft, setDraft] = useState<TraceFilters>(EMPTY_TRACE_FILTERS);
  const [applied, setApplied] = useState<TraceFilters>(EMPTY_TRACE_FILTERS);
  const [appended, setAppended] = useState<readonly TraceRow[]>([]);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [olderError, setOlderError] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    return session.read<TraceListResponse>(traceListUrl(applied)).catch((err: unknown) => {
      throw historyError(err);
    });
  }, [session, applied]);
  const first = useResource('assistant history', load);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    setApplied(draft);
    setAppended([]);
    setCursor(undefined);
    setAdvanced(false);
    setOlderError(undefined);
  };

  const loadOlder = async () => {
    const at =
      advanced || first.resource.state !== 'ready' ? cursor : first.resource.data.nextBefore;
    if (at === undefined || busy) return;
    setBusy(true);
    setOlderError(undefined);
    try {
      const page = await session.read<TraceListResponse>(traceListUrl(applied, at));
      setAppended((rows) => [...rows, ...page.traces]);
      setAdvanced(true);
      setCursor(page.nextBefore);
    } catch (err: unknown) {
      setOlderError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loaded: readonly TraceRow[] =
    first.resource.state === 'ready' ? [...first.resource.data.traces, ...appended] : [];
  const behaviours = [...new Set(loaded.map((r) => r.behaviourId))].sort();
  const behaviourOptions = [
    ...new Set([...behaviours, applied.behaviourId].filter((b) => b !== '')),
  ].sort();
  const more =
    first.resource.state === 'ready' &&
    (advanced ? cursor : first.resource.data.nextBefore) !== undefined;

  return (
    <>
      <PageHeader
        title="History"
        purpose="Every assistant run, with the details you need to see why it answered the way it did."
      />
      <UsageStrip />
      <form onSubmit={apply} className="mb-4 flex max-w-3xl flex-wrap items-end gap-3">
        <Field label="Outcome">
          <select
            value={draft.outcome}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                outcome: e.target.value as TraceFilters['outcome'],
              }))
            }
            className="mt-1 block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
          >
            <option value="">All outcomes</option>
            <option value="answered">answered</option>
            <option value="refused">refused</option>
            <option value="failed">failed</option>
          </select>
        </Field>
        <Field label="Behaviour">
          <select
            value={draft.behaviourId}
            onChange={(e) => setDraft((d) => ({ ...d, behaviourId: e.target.value }))}
            className="mt-1 block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
          >
            <option value="">All behaviours</option>
            {behaviourOptions.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Member" hint="The member id who asked. Empty means everyone.">
          <Input
            value={draft.userId}
            placeholder="Member id"
            onChange={(e) => setDraft((d) => ({ ...d, userId: e.target.value }))}
          />
        </Field>
        <Button type="submit" variant="primary">
          Apply
        </Button>
      </form>
      <DataState
        resource={first.resource}
        isEmpty={(page) => page.traces.length === 0 && appended.length === 0}
        empty={
          <EmptyState
            title="No assistant runs yet"
            detail="Tag @Bananasaurs in Discord or use Try it on a behaviour."
          />
        }
      >
        {() => (
          <>
            <DataTable
              caption="Assistant history"
              rows={loaded}
              rowKey={(r) => r.traceId}
              columns={[
                {
                  key: 'time',
                  header: 'Time',
                  cell: (r) => new Date(r.at).toLocaleString('en-CA'),
                },
                {
                  key: 'who',
                  header: 'Who asked',
                  cell: (r) => <MemberRef id={r.userId} member={r.member} />,
                },
                {
                  key: 'channel',
                  header: 'Channel',
                  cell: (r) =>
                    r.channelId === undefined ? (
                      <span className="text-ink-muted">—</span>
                    ) : (
                      <span className="font-mono text-xs">{r.channelId}</span>
                    ),
                },
                { key: 'behaviour', header: 'Behaviour', cell: (r) => r.behaviourId },
                {
                  key: 'outcome',
                  header: 'Outcome',
                  cell: (r) => <Badge tone={outcomeTone(r.outcome)}>{r.outcome}</Badge>,
                },
                {
                  key: 'model',
                  header: 'Model',
                  cell: (r) =>
                    r.model === undefined ? (
                      <span className="text-ink-muted">—</span>
                    ) : (
                      <span className="font-mono text-xs">{r.model}</span>
                    ),
                },
                {
                  key: 'duration',
                  header: 'Duration',
                  numeric: true,
                  cell: (r) => durationText(r.durationMs),
                },
                {
                  key: 'tokens',
                  header: 'Tokens',
                  numeric: true,
                  cell: (r) =>
                    r.totalTokens === null ? (
                      <span className="text-ink-muted">—</span>
                    ) : (
                      r.totalTokens
                    ),
                },
                {
                  key: 'run',
                  header: '',
                  cell: (r) => <Link href={historyUrl(r.traceId)}>Open</Link>,
                },
              ]}
            />
            {more && (
              <div className="mt-3">
                <Button onClick={() => void loadOlder()} busy={busy}>
                  Load older
                </Button>
              </div>
            )}
            {olderError !== undefined && (
              <p role="alert" className="mt-2 text-sm text-danger">
                Could not load older runs: {olderError}
              </p>
            )}
          </>
        )}
      </DataState>
      <OlderActivity />
    </>
  );
}
