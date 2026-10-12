import { useCallback, type JSX } from 'react';
import { useSession } from '../app/session.js';
import { useLiveResource } from '../hooks/useLiveResource.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { runLiveUrl, type LiveTextResponse } from '../api/runs.js';

/** Live answer plus collapsed thinking for one run (ADR 0148). Polls; no SSE. */
export function LiveText(props: {
  readonly runId: string;
  /** True once the run's step log has seen its `finished` event: polling stops after the next load. */
  readonly finished?: boolean;
}): JSX.Element {
  const session = useSession();
  const { runId, finished = false } = props;
  const load = useCallback(
    () => session.read<LiveTextResponse>(runLiveUrl(runId)),
    [session, runId],
  );
  const live = useLiveResource<LiveTextResponse>('live text', load, {
    fastMs: 2000,
    slowMs: 15000,
    isFast: () => true,
    isDone: () => finished,
  });
  return (
    <Card title="Live answer">
      <DataState
        resource={live.resource}
        isEmpty={(d) => d.answer === '' && d.thinking === ''}
        empty={<p className="text-sm text-ink-muted">Waiting for the first streamed text.</p>}
      >
        {(data) => (
          <>
            <p className="text-sm">{data.answer}</p>
            {data.thinking !== '' && (
              <details>
                <summary>Thinking</summary>
                <p className="text-sm text-ink-muted">{data.thinking}</p>
              </details>
            )}
          </>
        )}
      </DataState>
      {live.stale && <p className="mt-2 text-xs text-ink-muted">Reconnecting…</p>}
    </Card>
  );
}
