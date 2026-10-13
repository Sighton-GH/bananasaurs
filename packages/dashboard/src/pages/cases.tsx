import { useCallback, useState } from 'react';
import { MemberRef } from '../ui/MemberRef.js';
import { Link } from 'wouter';
import { useHealth } from '../app/health.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { EmptyState } from '../ui/EmptyState.js';
import { RadioGroup } from '../ui/RadioGroup.js';
import { Button } from '../ui/Button.js';
import { Empty } from '../ui/states.js';
import { Moment } from './moderation/moment.js';
import { PageHeader } from '../ui/PageHeader.js';

/** One row of the `/cases` list and the `/members/:memberId` history. */
export interface ModCase {
  readonly caseId: string;
  readonly memberId: string;
  readonly openedAt: number;
  readonly violationCount: number;
  readonly escalationTier: number;
  readonly status: 'open' | 'closed';
  /** Live server identity; null when Discord no longer knows the id. */
  readonly member: { readonly username: string; readonly displayName: string } | null;
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
  const [status, setStatus] = useState<'all' | ModCase['status']>('all');

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
          <EmptyState
            title="No moderation cases yet"
            detail="Cases appear when a rule flags a message or an operator opens one."
            action={
              <Link href="/automod" className="text-sm font-medium underline underline-offset-4">
                Review Automod rules
              </Link>
            }
          />
        }
      >
        {(rows) => {
          const openCount = rows.filter((c) => c.status === 'open').length;
          const shown = status === 'all' ? rows : rows.filter((c) => c.status === status);
          return (
            <Card title={`${String(openCount)} open`}>
              <p className="mb-3 text-sm text-ink-muted">
                A case collects one member&apos;s violations; the tier rises as they add up.
              </p>
              <div className="mb-3 flex flex-wrap items-end gap-3">
                <RadioGroup
                  legend="Status"
                  name="case-status"
                  orientation="horizontal"
                  value={status}
                  onChange={(v) => setStatus(v as 'all' | ModCase['status'])}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'open', label: 'Open' },
                    { value: 'closed', label: 'Closed' },
                  ]}
                />
                <p className="text-sm text-ink-muted">
                  Showing {String(shown.length)} of {String(rows.length)} loaded.
                </p>
              </div>
              {shown.length === 0 ? (
                <Empty
                  art={false}
                  title="No cases match these filters"
                  action={<Button onClick={() => setStatus('all')}>Clear filters</Button>}
                />
              ) : (
                <DataTable
                  caption="Moderation cases"
                  rows={shown}
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
                      cell: (c) => <MemberRef id={c.memberId} member={c.member} />,
                    },
                    {
                      key: 'opened',
                      header: 'Opened',
                      cell: (c) => <Moment at={c.openedAt} />,
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
            </Card>
          );
        }}
      </DataState>
    </>
  );
}
