import { useHealth } from '../app/health.js';
import { Badge } from '../ui/Badge.js';
import { DataState } from '../ui/DataState.js';
import { PageHeader } from '../ui/PageHeader.js';

/** The former Health section. Same fields, same source (`GET /api/health`). */
export function OverviewPage() {
  const health = useHealth();
  return (
    <>
      <PageHeader
        title="Overview"
        purpose="How the bot is connected and what it is doing right now."
      />
      <DataState resource={health.resource}>
        {(h) => (
          <dl className="grid max-w-2xl grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-muted">Guild</dt>
            <dd>
              {h.guildName ?? '(name not yet known)'}{' '}
              <span className="text-ink-muted">({h.guildId})</span>
            </dd>
            <dt className="text-ink-muted">Gateway</dt>
            <dd>
              {h.gateway.connected ? (
                <Badge tone="ok">connected</Badge>
              ) : (
                <Badge tone="danger">disconnected</Badge>
              )}
              {h.gateway.pingMs !== undefined && (
                <span className="ml-2 text-ink-muted">{h.gateway.pingMs} ms</span>
              )}
            </dd>
            <dt className="text-ink-muted">Dry run</dt>
            <dd>{h.safety?.dryRun === true ? <Badge tone="hold">on</Badge> : 'off'}</dd>
            <dt className="text-ink-muted">Kill switch</dt>
            <dd>{h.safety?.killswitch === true ? <Badge tone="hold">on</Badge> : 'off'}</dd>
            <dt className="text-ink-muted">Circuit breaker</dt>
            <dd>{h.safety?.breakerOpen === true ? <Badge tone="hold">open</Badge> : 'closed'}</dd>
            <dt className="text-ink-muted">Jobs</dt>
            <dd>
              {Object.entries(h.jobCounts)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(', ') || 'none'}
            </dd>
            {h.oldestDueJobAtMs !== undefined && (
              <>
                <dt className="text-ink-muted">Scheduler lag</dt>
                <dd>since {new Date(h.oldestDueJobAtMs).toLocaleString()}</dd>
              </>
            )}
          </dl>
        )}
      </DataState>
    </>
  );
}
