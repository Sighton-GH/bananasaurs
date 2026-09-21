import { useCallback, type ReactElement } from 'react';
import { Link } from 'wouter';
import type { ReviewQueue } from '../api/automod.js';
import type {
  ArchiveStatus,
  BackupListing,
  EligibilityWarning,
  JobRow,
  McpClient,
  McpSend,
} from '../api/ops.js';
import type { HealthInfo } from '../app/health.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { auditActorCompact, auditViaText } from '../ui/auditWords.js';
import { Badge } from '../ui/Badge.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';

interface AuditRow {
  readonly auditId: number;
  readonly at: number;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly via: string | null;
  readonly action: string;
  readonly subjectType: string;
}

interface AttentionItem {
  readonly tone: 'danger' | 'hold';
  readonly text: string;
  readonly href: string;
  readonly linkText: string;
}

const PROVIDER_REASON: Record<EligibilityWarning['reason'], string> = {
  'not-no': 'has not opted out of training',
  stale: 'review is stale',
  'not-production': 'is not the production provider',
};

/**
 * The operator summary the health cards cannot carry: what needs a decision
 * right now, what just happened, and how the archive and connector are
 * doing. Each source renders its own loading, error and empty state; one
 * failing endpoint never blanks the others.
 */
export function OperatorPulse({ health }: { readonly health: HealthInfo }): ReactElement {
  const session = useSession();
  const providers = useResource(
    'provider eligibility',
    useCallback(
      () =>
        session
          .read<{ warnings: EligibilityWarning[] }>('/api/providers/eligibility')
          .then((r) => r.warnings),
      [session],
    ),
  );
  const review = useResource(
    'the review queue',
    useCallback(() => session.read<ReviewQueue>('/api/automod/review'), [session]),
  );
  const failedJobs = useResource(
    'failed jobs',
    useCallback(() => session.read<JobRow[]>('/api/jobs?failedOnly=true&limit=100'), [session]),
  );
  const backups = useResource(
    'the backups',
    useCallback(
      () => session.read<{ backups: BackupListing[] }>('/api/backups').then((r) => r.backups),
      [session],
    ),
  );
  const auditTail = useResource(
    'recent activity',
    useCallback(() => session.read<AuditRow[]>('/api/audit?limit=8'), [session]),
  );
  const archive = useResource(
    'the archive status',
    useCallback(() => session.read<ArchiveStatus>('/api/archive/status'), [session]),
  );
  const connector = useResource(
    'the connector',
    useCallback(
      () =>
        Promise.all([
          session.read<{ clients: McpClient[] }>('/api/mcp/clients'),
          session.read<{ sends: McpSend[] }>('/api/mcp/sends?since=24h'),
        ]).then(([clients, sends]) => ({ clients: clients.clients, sends: sends.sends })),
      [session],
    ),
  );

  const items: AttentionItem[] = [];
  if (!health.gateway.connected) {
    items.push({
      tone: 'danger',
      text: "The bot's connection to Discord is down; it cannot see or act on the server.",
      href: '/doctor',
      linkText: 'Doctor',
    });
  }
  if (health.safety?.killswitch === true) {
    items.push({
      tone: 'hold',
      text: 'The kill switch is on — every effect is held.',
      href: '/safety',
      linkText: 'Safety',
    });
  }
  if (health.safety?.breakerOpen === true) {
    items.push({
      tone: 'hold',
      text: `The automatic safety stop is on${health.safety.breakerReason != null && health.safety.breakerReason !== '' ? `: ${health.safety.breakerReason}` : ''}.`,
      href: '/safety',
      linkText: 'Safety',
    });
  }
  if (health.oldestDueJobAtMs !== undefined) {
    items.push({
      tone: 'hold',
      text: `Some jobs have been waiting to run since ${new Date(health.oldestDueJobAtMs).toLocaleString()}.`,
      href: '/jobs',
      linkText: 'Jobs',
    });
  }
  if (failedJobs.resource.state === 'ready' && failedJobs.resource.data.length > 0) {
    items.push({
      tone: 'danger',
      text: `${String(failedJobs.resource.data.length)} failed ${failedJobs.resource.data.length === 1 ? 'job' : 'jobs'} waiting for a retry or a decision.`,
      href: '/jobs',
      linkText: 'Jobs',
    });
  }
  if (review.resource.state === 'ready') {
    const pending = review.resource.data.matches.length + review.resource.data.nativeBlocked;
    if (pending > 0) {
      items.push({
        tone: 'hold',
        text: `${String(pending)} moderation ${pending === 1 ? 'match needs' : 'matches need'} a verdict.`,
        href: '/review',
        linkText: 'Review',
      });
    }
  }
  if (providers.resource.state === 'ready') {
    for (const warning of providers.resource.data) {
      items.push({
        tone: 'hold',
        text: `Provider ${warning.provider} ${PROVIDER_REASON[warning.reason]}.`,
        href: '/providers',
        linkText: 'Providers',
      });
    }
  }
  if (backups.resource.state === 'ready') {
    const newest = backups.resource.data.reduce<number | undefined>(
      (best, b) => (best === undefined || b.createdAtMs > best ? b.createdAtMs : best),
      undefined,
    );
    if (newest === undefined) {
      items.push({
        tone: 'danger',
        text: 'No backups exist yet.',
        href: '/backups',
        linkText: 'Backups',
      });
    } else if (Date.now() - newest > 26 * 3_600_000) {
      items.push({
        tone: 'hold',
        text: `The newest backup is from ${new Date(newest).toLocaleString()}.`,
        href: '/backups',
        linkText: 'Backups',
      });
    }
  }

  const pendingChecks = [
    ['provider eligibility', providers.resource],
    ['the review queue', review.resource],
    ['failed jobs', failedJobs.resource],
    ['the backups', backups.resource],
  ] as const;
  const stillLoading = pendingChecks.filter(([, r]) => r.state === 'loading').map(([name]) => name);

  return (
    <div className="mt-6 grid max-w-6xl gap-3 lg:grid-cols-2">
      <div className="lg:col-span-2">
        <Card title="Needs attention">
          {items.length === 0 && stillLoading.length === 0 && (
            <p className="text-sm text-ink-muted">
              <Badge tone="ok">clear</Badge>
              <span className="ml-2">Nothing needs attention right now.</span>
            </p>
          )}
          {items.length > 0 && (
            <ul className="space-y-1.5 text-sm">
              {items.map((item) => (
                <li key={item.text} className="flex flex-wrap items-center gap-2">
                  <Badge tone={item.tone}>{item.tone === 'danger' ? 'act' : 'check'}</Badge>
                  <span>{item.text}</span>
                  <Link href={item.href} className="text-ink-muted underline">
                    {item.linkText} →
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {stillLoading.length > 0 && (
            <p className="mt-1 text-sm text-ink-muted">Still checking {stillLoading.join(', ')}…</p>
          )}
          {pendingChecks.map(([name, resource]) =>
            resource.state === 'error' ? (
              <p key={name} className="mt-1 text-sm text-ink-muted">
                Could not check {name}: {resource.message}
              </p>
            ) : null,
          )}
        </Card>
      </div>

      <Card title="Recent activity">
        <DataState
          resource={auditTail.resource}
          isEmpty={(rows) => rows.length === 0}
          empty={<p className="text-sm text-ink-muted">Nothing has been audited yet.</p>}
        >
          {(rows) => (
            <ul className="space-y-1.5 text-sm">
              {rows.map((row) => (
                <li key={row.auditId} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-ink-muted">
                    {new Date(row.at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="font-medium">{row.action}</span>
                  <span className="text-ink-muted">
                    {auditActorCompact(row)}
                    {auditViaText(row.via) !== null ? ` via ${auditViaText(row.via)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DataState>
        <Link href="/audit" className="mt-2 inline-block text-sm text-ink-muted underline">
          Full audit log →
        </Link>
      </Card>

      <Card title="Archive">
        <DataState
          resource={archive.resource}
          isEmpty={(status) => status.channels.length === 0}
          empty={
            <p className="text-sm text-ink-muted">
              No channels are archived yet — enable one to start keeping history.
            </p>
          }
        >
          {(status) => {
            const messages = status.channels.reduce((sum, c) => sum + c.messageCount, 0);
            const backfilling = status.channels.filter((c) => c.backfillState !== 'done').length;
            return (
              <div className="space-y-1.5 text-sm">
                <p>
                  <span className="font-medium">{status.channels.length}</span>{' '}
                  {status.channels.length === 1 ? 'channel' : 'channels'} archived,{' '}
                  <span className="font-medium">{messages.toLocaleString()}</span> messages kept.
                </p>
                <p className="text-ink-muted">
                  Search index: {status.index.indexed.toLocaleString()} of{' '}
                  {status.index.rows.toLocaleString()} rows indexed.
                </p>
                {backfilling > 0 && (
                  <p>
                    <Badge tone="hold">
                      {backfilling} backfill{backfilling === 1 ? '' : 's'} in progress
                    </Badge>
                  </p>
                )}
              </div>
            );
          }}
        </DataState>
        <span className="mt-2 flex flex-wrap gap-3">
          <Link href="/archive" className="text-sm text-ink-muted underline">
            Archive →
          </Link>
          <Link href="/search" className="text-sm text-ink-muted underline">
            Search →
          </Link>
        </span>
      </Card>

      <Card title="Connector">
        <DataState
          resource={connector.resource}
          isEmpty={({ clients, sends }) => clients.length === 0 && sends.length === 0}
          empty={
            <p className="text-sm text-ink-muted">
              Nothing is connected yet — register a client to let tools send through the connector.
            </p>
          }
        >
          {({ clients, sends }) => {
            const sent = sends.filter((s) => s.outcome === 'sent').length;
            const dryRun = sends.length - sent;
            return (
              <div className="space-y-1.5 text-sm">
                <p>
                  <span className="font-medium">{clients.length}</span> registered{' '}
                  {clients.length === 1 ? 'client' : 'clients'}
                  {clients.length > 0 && (
                    <span className="text-ink-muted">
                      {' '}
                      —{' '}
                      {clients
                        .slice(0, 3)
                        .map((c) => c.clientName)
                        .join(', ')}
                      {clients.length > 3 ? `, +${String(clients.length - 3)} more` : ''}
                    </span>
                  )}
                </p>
                <p className="text-ink-muted">
                  Sends in the last 24 hours: {sent} sent
                  {dryRun > 0 ? `, ${String(dryRun)} rehearsed (dry run)` : ''}.
                </p>
              </div>
            );
          }}
        </DataState>
        <span className="mt-2 flex flex-wrap gap-3">
          <Link href="/mcp" className="text-sm text-ink-muted underline">
            Connector →
          </Link>
          <Link href="/providers" className="text-sm text-ink-muted underline">
            Providers →
          </Link>
        </span>
      </Card>
    </div>
  );
}
