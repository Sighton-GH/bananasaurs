import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Link } from 'wouter';
import type { RunEventRow } from '@bananasaurs/core';
import { ApiError } from '../api.js';
import { useSession } from '../app/session.js';
import { useLiveResource } from '../hooks/useLiveResource.js';
import { Badge } from '../ui/Badge.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { MemberRef } from '../ui/MemberRef.js';
import { LiveText } from './assistant-live-buffer.js';
import {
  activeRunsUrl,
  describeRunEvent,
  runEventsUrl,
  type LiveRun,
  type RunEventsResponse,
  type RunListResponse,
} from '../api/runs.js';

/**
 * The live side of the dashboard (ADR 0129 §7): the In progress panel on
 * History and Conversations, the pending bot turn on an open transcript, and
 * the Step log on the trace page. All three poll every 2 s while anything
 * runs, every 15 s otherwise, through `useLiveResource`.
 */

/** Re-renders every second while `active`, so stopwatches tick without a fetch. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

const elapsedText = (since: number, now: number): string => {
  const total = Math.max(0, Math.floor((now - since) / 1000));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
};

/** The active-runs poll both live components share, filtered to one conversation when set. */
function useActiveRuns(conversationId?: string) {
  const session = useSession();
  const load = useCallback(() => session.read<RunListResponse>(activeRunsUrl()), [session]);
  const live = useLiveResource<RunListResponse>('active runs', load, {
    fastMs: 2000,
    slowMs: 15000,
    // ADR 0129: stalled runs stay listed but poll slow; only a non-stalled
    // run keeps the fast cadence.
    isFast: (d) => d.runs.some((r) => !r.stalled),
  });
  const runs = useMemo<readonly LiveRun[]>(
    () =>
      live.resource.state === 'ready'
        ? live.resource.data.runs.filter(
            (r) => conversationId === undefined || r.conversationId === conversationId,
          )
        : [],
    [live.resource, conversationId],
  );
  return { live, runs };
}

function RunRow({ run, now }: { readonly run: LiveRun; readonly now: number }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <MemberRef id={run.userId} member={run.member} />
      {run.source === 'dashboard-test' ? (
        <span className="text-ink-muted">Dashboard test</span>
      ) : run.channelId !== undefined ? (
        <span className="font-mono text-xs">#{run.channelId}</span>
      ) : null}
      <span>{run.label}</span>
      <span className="font-mono text-xs text-ink-muted">
        {elapsedText(run.startedAt ?? run.queuedAt, now)}
      </span>
      {run.attempt > 1 && <span className="text-xs text-ink-muted">attempt {run.attempt}</span>}
      {run.stalled && <Badge tone="hold">Stalled</Badge>}
      {run.conversationId !== undefined && (
        <Link href={`/assistant/conversations/${encodeURIComponent(run.conversationId)}`}>
          Open conversation
        </Link>
      )}
    </li>
  );
}

export function InProgressPanel(props: {
  /** Only runs of this conversation, when set. */
  readonly conversationId?: string;
  /** Called once per run id that was active and is no longer, so the page can reload. */
  readonly onFinished?: (runId: string) => void;
}): JSX.Element {
  const { live, runs } = useActiveRuns(props.conversationId);
  const now = useNow(runs.length > 0);
  const { onFinished } = props;

  // The previous poll's run ids; each id that disappears fired `onFinished` once.
  const prevIds = useRef<readonly string[] | undefined>(undefined);
  useEffect(() => {
    if (live.resource.state !== 'ready') return;
    const ids = runs.map((r) => r.runId);
    const prev = prevIds.current;
    prevIds.current = ids;
    if (prev === undefined || onFinished === undefined) return;
    for (const id of prev) {
      if (!ids.includes(id)) onFinished(id);
    }
  }, [live.resource, runs, onFinished]);

  return (
    <Card title="In progress">
      <DataState
        resource={live.resource}
        isEmpty={() => runs.length === 0}
        empty={<p className="text-sm text-ink-muted">Nothing running right now.</p>}
      >
        {() => (
          <ul className="grid gap-2">
            {runs.map((run) => (
              <RunRow key={run.runId} run={run} now={now} />
            ))}
          </ul>
        )}
      </DataState>
      {live.stale && <p className="mt-2 text-xs text-ink-muted">Reconnecting…</p>}
    </Card>
  );
}

export function PendingTurn(props: {
  readonly conversationId: string;
  readonly onFinished: () => void;
}): JSX.Element | null {
  const { runs } = useActiveRuns(props.conversationId);
  const now = useNow(runs.length > 0);
  const { onFinished } = props;
  const run = runs[0];

  // When the previously seen run leaves the matching set — finished or
  // replaced by another run — the transcript reloads once to show the real
  // (or failed) turn in its place.
  const prevId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const current = run?.runId;
    const prev = prevId.current;
    prevId.current = current;
    if (prev !== undefined && current !== prev) onFinished();
  }, [run?.runId, onFinished]);

  if (run === undefined) return null;
  return (
    <div aria-live="polite">
      <p className="text-sm">
        <span className="font-medium">Bananasaurs</span>{' '}
        <span className="text-xs text-ink-muted">
          {run.label} · {elapsedText(run.startedAt ?? run.queuedAt, now)}
        </span>
      </p>
      <p className="mt-1 text-sm whitespace-pre-wrap text-ink-muted">{run.label}…</p>
    </div>
  );
}

const timedMs = (row: RunEventRow): number | undefined =>
  row.event.kind === 'model-result' || row.event.kind === 'tool-result' ? row.event.ms : undefined;

export function StepLog(props: { readonly runId: string }): JSX.Element {
  const session = useSession();
  const [events, setEvents] = useState<readonly RunEventRow[]>([]);
  const lastSeq = useRef(0);
  const seenFinished = useRef(false);
  const { runId } = props;

  const load = useCallback(
    () => session.read<RunEventsResponse>(runEventsUrl(runId, lastSeq.current)),
    [session, runId],
  );
  const live = useLiveResource<RunEventsResponse>('step log', load, {
    fastMs: 2000,
    slowMs: 15000,
    isFast: (d) => !seenFinished.current && !d.events.some((e) => e.event.kind === 'finished'),
    // ADR 0129: once the run's `finished` event has been seen, the log stays
    // on screen with no further requests.
    isDone: (d) => d.events.some((e) => e.event.kind === 'finished'),
  });

  // A new run starts its log from seq 1: drop the previous run's rows
  // while rendering, so the first poll for the new run asks from after=0
  // and the previous run's finished event cannot slow the new cadence. This
  // must happen during render: an effect would run after the poll hook's
  // own effect, a fetch too late.
  const prevRunId = useRef(runId);
  if (prevRunId.current !== runId) {
    prevRunId.current = runId;
    lastSeq.current = 0;
    seenFinished.current = false;
    setEvents([]);
  }

  // Appends only events past the last seen seq, so a repeated poll never
  // duplicates a row.
  const resource = live.resource;
  useEffect(() => {
    if (resource.state !== 'ready') return;
    const fresh = resource.data.events.filter((e) => e.seq > lastSeq.current);
    if (fresh.length === 0) return;
    lastSeq.current = Math.max(...fresh.map((e) => e.seq));
    if (fresh.some((e) => e.event.kind === 'finished')) seenFinished.current = true;
    setEvents((prev) => [...prev, ...fresh]);
  }, [resource]);

  if (
    resource.state === 'error' &&
    resource.error instanceof ApiError &&
    resource.error.status === 404
  ) {
    return (
      <Card title="Step log">
        <p className="text-sm text-ink-muted">No step log is stored for this run.</p>
      </Card>
    );
  }

  const finished = events.some((e) => e.event.kind === 'finished');
  const firstAt = events.length > 0 ? (events[0]?.at ?? 0) : 0;
  const maxMs = Math.max(0, ...events.map((e) => timedMs(e) ?? 0));

  return (
    <div className="grid gap-3">
      <Card title="Step log">
        <DataState
          resource={resource}
          isEmpty={() => events.length === 0}
          empty={<p className="text-sm text-ink-muted">No steps recorded for this run.</p>}
        >
          {() => (
            <ol className="grid gap-2">
              {events.map((row) => {
                const ms = timedMs(row);
                return (
                  <li key={row.seq} className="text-sm">
                    <span className="font-mono text-xs text-ink-muted">
                      +{((row.at - firstAt) / 1000).toFixed(1)} s
                    </span>{' '}
                    <span className="font-mono text-xs">{row.event.kind}</span>{' '}
                    <span>{describeRunEvent(row.event)}</span>
                    {ms !== undefined && maxMs > 0 && (
                      <div className="mt-0.5 h-1 rounded-sm bg-canvas">
                        <div
                          className="h-full rounded-sm bg-hold"
                          style={{ width: `${String(Math.min(100, (ms / maxMs) * 100))}%` }}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </DataState>
        {live.stale && <p className="mt-2 text-xs text-ink-muted">Reconnecting…</p>}
      </Card>
      <LiveText runId={runId} finished={finished} />
    </div>
  );
}
