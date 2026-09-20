import { Link } from 'wouter';
import { useHealth } from '../app/health.js';
import { Badge } from '../ui/Badge.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { PageHeader } from '../ui/PageHeader.js';

function CardLink({ href, children }: { readonly href: string; readonly children: string }) {
  return (
    <Link href={href} className="mt-2 inline-block text-sm text-ink-muted underline">
      {children}
    </Link>
  );
}

/**
 * `/`: actionable status cards leading to detail (docs/06 — "cards that lead
 * to actionable detail rather than decorative statistics"). Every number
 * still comes from the shell's one `/api/health` fetch; each card names the
 * page that acts on what it shows.
 */
export function OverviewPage() {
  const health = useHealth();
  return (
    <>
      <PageHeader
        title="Overview"
        purpose="How the bot is connected and what it is doing right now — each card leads to the page that acts on it."
      />
      <DataState resource={health.resource}>
        {(h) => (
          <div className="grid max-w-4xl gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Card title="Guild">
              <p className="text-sm font-medium">{h.guildName ?? '(name not yet known)'}</p>
              <p className="text-sm text-ink-muted">({h.guildId})</p>
            </Card>
            <Card title="Gateway">
              <p className="text-sm">
                {h.gateway.connected ? (
                  <Badge tone="ok">connected</Badge>
                ) : (
                  <Badge tone="danger">disconnected</Badge>
                )}
                {h.gateway.pingMs !== undefined && (
                  <span className="ml-2 text-ink-muted">{h.gateway.pingMs} ms</span>
                )}
              </p>
              <p className="mt-1 text-sm text-ink-muted">
                in {String(h.gateway.guildCount)} {h.gateway.guildCount === 1 ? 'guild' : 'guilds'}
              </p>
              <CardLink href="/doctor">Doctor checks this →</CardLink>
            </Card>
            <Card title="Safety">
              <p className="flex flex-wrap gap-1 text-sm">
                {h.safety?.dryRun === true && <Badge tone="hold">dry run on</Badge>}
                {h.safety?.killswitch === true && <Badge tone="hold">kill switch on</Badge>}
                {h.safety?.breakerOpen === true && <Badge tone="hold">breaker open</Badge>}
                {h.safety !== undefined &&
                  !h.safety.dryRun &&
                  !h.safety.killswitch &&
                  !h.safety.breakerOpen && (
                    <span className="text-ink-muted">nothing holding back</span>
                  )}
                {h.safety === undefined && <span className="text-ink-muted">unknown</span>}
              </p>
              <CardLink href="/safety">Open safety →</CardLink>
            </Card>
            <Card title="Jobs">
              <p className="text-sm">
                {Object.entries(h.jobCounts)
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join(', ') || 'none'}
              </p>
              {h.oldestDueJobAtMs !== undefined && (
                <p className="mt-1 text-sm">
                  <Badge tone="hold">
                    scheduler lag since {new Date(h.oldestDueJobAtMs).toLocaleString()}
                  </Badge>
                </p>
              )}
              <CardLink href="/jobs">Open the queue →</CardLink>
            </Card>
            <Card title="Instance">
              <p className="text-sm text-ink-muted">
                Doctor, backups, configuration, accounts and the connector.
              </p>
              <span className="mt-2 flex flex-wrap gap-3">
                <CardLink href="/doctor">Doctor →</CardLink>
                <CardLink href="/backups">Backups →</CardLink>
                <CardLink href="/config">Configuration →</CardLink>
              </span>
            </Card>
            <Card title="Archive">
              <p className="text-sm text-ink-muted">
                Channel archiving, the search index and message tools.
              </p>
              <span className="mt-2 flex flex-wrap gap-3">
                <CardLink href="/archive">Archive →</CardLink>
                <CardLink href="/search">Search →</CardLink>
              </span>
            </Card>
          </div>
        )}
      </DataState>
    </>
  );
}
