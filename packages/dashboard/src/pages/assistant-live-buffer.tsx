import { useCallback, useRef, type JSX } from 'react';
import { ApiError } from '../api.js';
import { useSession } from '../app/session.js';
import { useLiveResource } from '../hooks/useLiveResource.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { runLiveUrl, type LiveTextResponse } from '../api/runs.js';

/** `/live` data plus a flag for "this viewer may not read it": render nothing, stop polling. */
interface LiveState extends LiveTextResponse {
  readonly unavailable: boolean;
}

const UNAVAILABLE_STATUSES: readonly number[] = [401, 403, 404];
const isEmptyText = (d: LiveTextResponse): boolean => d.answer === '' && d.thinking === '';
const TEXT_BOX = 'max-h-64 min-w-0 overflow-y-auto whitespace-pre-wrap break-words text-sm';

/**
 * Live answer plus collapsed thinking for one run (ADR 0148). Polls; no SSE.
 *
 * The daemon drops the live buffer when the run finishes, so an empty reply
 * never replaces text already shown, and once `finished` is set the last text
 * stays on screen with no further requests.
 */
export function LiveText(props: {
  readonly runId: string;
  /** True once the run's step log has seen its `finished` event. */
  readonly finished?: boolean;
}): JSX.Element | null {
  const session = useSession();
  const { runId, finished = false } = props;
  const finishedRef = useRef(finished);
  finishedRef.current = finished;
  const last = useRef<LiveState | null>(null);
  const lastRun = useRef(runId);
  if (lastRun.current !== runId) {
    lastRun.current = runId;
    last.current = null;
  }

  const load = useCallback(async (): Promise<LiveState> => {
    const cached = last.current;
    if (finishedRef.current && cached !== null) return cached;
    try {
      const data = await session.read<LiveTextResponse>(runLiveUrl(runId));
      if (isEmptyText(data) && cached !== null && !cached.unavailable) return cached;
      const next = { ...data, unavailable: false };
      last.current = next;
      return next;
    } catch (err) {
      if (err instanceof ApiError && UNAVAILABLE_STATUSES.includes(err.status)) {
        const next = { answer: '', thinking: '', unavailable: true };
        last.current = next;
        return next;
      }
      throw err;
    }
  }, [session, runId]);

  const live = useLiveResource<LiveState>('live text', load, {
    fastMs: 2000,
    slowMs: 15000,
    isFast: () => true,
    isDone: (d) => finished || d.unavailable,
  });

  const data = live.resource.state === 'ready' ? live.resource.data : null;
  if (data !== null && (data.unavailable || (finished && isEmptyText(data)))) return null;

  return (
    <Card title="Live answer">
      <DataState
        resource={live.resource}
        isEmpty={isEmptyText}
        empty={<p className="text-sm text-ink-muted">Waiting for the first streamed text.</p>}
      >
        {(d) => (
          <>
            <p className={TEXT_BOX}>{d.answer}</p>
            {d.thinking !== '' && (
              <details>
                <summary>Thinking</summary>
                <p className={`${TEXT_BOX} text-ink-muted`}>{d.thinking}</p>
              </details>
            )}
          </>
        )}
      </DataState>
      {live.stale && (
        <p role="status" className="mt-2 text-xs text-ink-muted">
          Reconnecting…
        </p>
      )}
    </Card>
  );
}
