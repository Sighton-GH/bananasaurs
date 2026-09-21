import { Link } from 'wouter';
import { useHealth } from '../app/health.js';
import { OperatorPulse } from './overview-pulse.js';
import { Badge } from '../ui/Badge.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { HelpTip } from '../ui/HelpTip.js';
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
        purpose="How the bot is connected, what needs a decision right now, and what just happened — each card leads to the page that acts on it."
      />
      <DataState resource={health.resource}>
        {(h) => (
          <div className="grid max-w-4xl gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Card title="Server">
              <p className="text-sm font-medium">{h.guildName ?? '(name not yet known)'}</p>
              <p className="text-sm text-ink-muted">
                ID {h.guildId}
                <HelpTip label="the server ID">
                  Discord&apos;s numeric ID for this server; useful when talking to Discord support
                  or reading logs.
                </HelpTip>
              </p>
            </Card>
            <Card title="Discord connection">
              <p className="text-sm">
                {h.gateway.connected ? (
                  <Badge tone="ok">connected</Badge>
                ) : (
                  <Badge tone="danger">disconnected</Badge>
                )}
                {h.gateway.pingMs !== undefined && (
                  <span className="ml-2 text-ink-muted">{h.gateway.pingMs} ms</span>
                )}
                <HelpTip label="the Discord connection">
                  The bot&apos;s live link to Discord. The number is the round-trip time; a lower
                  number is healthier.
                </HelpTip>
              </p>
              <p className="mt-1 text-sm text-ink-muted">
                in {String(h.gateway.guildCount)}{' '}
                {h.gateway.guildCount === 1 ? 'server' : 'servers'}
              </p>
              <CardLink href="/doctor">Doctor checks this →</CardLink>
            </Card>
            <Card title="Safety">
              <p className="flex flex-wrap items-center gap-1 text-sm">
                {h.safety?.dryRun === true && (
                  <>
                    <Badge tone="hold">dry run on</Badge>
                    <HelpTip label="dry run">
                      Actions are rehearsed and recorded, but nothing is sent to Discord.
                    </HelpTip>
                  </>
                )}
                {h.safety?.killswitch === true && (
                  <>
                    <Badge tone="hold">kill switch on</Badge>
                    <HelpTip label="the kill switch">
                      Every action is held until the switch is turned off on the Safety page.
                    </HelpTip>
                  </>
                )}
                {h.safety?.breakerOpen === true && (
                  <>
                    <Badge tone="hold">safety stop on</Badge>
                    <HelpTip label="the automatic safety stop">
                      The circuit breaker paused changes after repeated Discord failures. Fix the
                      cause, then reset it from Configuration.
                    </HelpTip>
                  </>
                )}
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
                  .map(([k, v]) => `${String(v)} ${k}`)
                  .join(', ') || 'none'}
                <HelpTip label="jobs">
                  Background work the bot has scheduled, such as backfills and repairs, by state.
                </HelpTip>
              </p>
              {h.oldestDueJobAtMs !== undefined && (
                <p className="mt-1 text-sm">
                  <Badge tone="hold">
                    running late since {new Date(h.oldestDueJobAtMs).toLocaleString()}
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
      {health.resource.state === 'ready' && <OperatorPulse health={health.resource.data} />}
    </>
  );
}
