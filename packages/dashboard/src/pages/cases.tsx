import { useCallback } from 'react';
import { Link } from 'wouter';
import { useHealth } from '../app/health.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';

/** One row of the `/cases` list and the `/members/:memberId` history. */
export interface ModCase {
  readonly caseId: string;
  readonly memberId: string;
  readonly openedAt: number;
  readonly violationCount: number;
  readonly escalationTier: number;
  readonly status: 'open' | 'closed';
}

export const CASES_DEGRADED =
  'Gateway disconnected: this list is served from the database and may be behind Discord.';

export const statusBadge = (status: ModCase['status']) =>
  status === 'open' ? <Badge tone="hold">open</Badge> : <Badge>closed</Badge>;

/**
 * `/cases`: open and recent moderation cases, newest first.
 * `GET /api/mod/cases?limit=50`. When the gateway is disconnected the list is
 * still served from the database, so the page says so through `degraded` —
 * the first producer of the `DataState` degraded state.
 */
export function CasesPage() {
  const session = useSession();
  const health = useHealth();
  const load = useCallback(
    () => session.read<{ cases: ModCase[] }>('/api/mod/cases?limit=50').then((r) => r.cases),
    [session],
  );
  const cases = useResource('the moderation cases', load);

  const resource =
    cases.resource.state === 'ready' &&
    health.resource.state === 'ready' &&
    !health.resource.data.gateway.connected
      ? { ...cases.resource, degraded: CASES_DEGRADED }
      : cases.resource;

  return (
    <>
      <PageHeader title="Cases" purpose="Open and recent moderation cases, newest first." />
      <DataState
        resource={resource}
        isEmpty={(c) => c.length === 0}
        empty={
          <p className="text-sm text-ink-muted">
            No cases. Nothing has matched or been actioned yet.
          </p>
        }
      >
        {(rows) => (
          <DataTable
            caption="Moderation cases"
            rows={rows}
            rowKey={(c) => c.caseId}
            columns={[
              {
                key: 'case',
                header: 'Case',
                cell: (c) => <Link href={`/cases/${c.caseId}`}>{c.caseId}</Link>,
              },
              {
                key: 'member',
                header: 'Member',
                cell: (c) => <Link href={`/members/${c.memberId}`}>{c.memberId}</Link>,
              },
              {
                key: 'opened',
                header: 'Opened',
                cell: (c) => new Date(c.openedAt).toLocaleString(),
              },
              {
                key: 'violations',
                header: 'Violations',
                numeric: true,
                cell: (c) => c.violationCount,
              },
              { key: 'tier', header: 'Tier', numeric: true, cell: (c) => c.escalationTier },
              { key: 'status', header: 'Status', cell: (c) => statusBadge(c.status) },
            ]}
          />
        )}
      </DataState>
    </>
  );
}
