import { useCallback } from 'react';
import { Link, useParams } from 'wouter';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';
import { statusBadge, type ModCase } from './cases.js';

/**
 * `/members/:memberId`: every case for this member, open first.
 * `GET /api/mod/members/:memberId/cases`. The same table as `/cases` without
 * the Member column.
 */
export function MemberPage() {
  const { memberId } = useParams<{ memberId: string }>();
  const session = useSession();
  const load = useCallback(
    () =>
      session.read<{ cases: ModCase[] }>(`/api/mod/members/${memberId}/cases`).then((r) => r.cases),
    [session, memberId],
  );
  const cases = useResource(`the cases for member ${memberId}`, load);

  return (
    <>
      <PageHeader
        title="Member moderation history"
        purpose="Every case for this member, open first."
      />
      <DataState
        resource={cases.resource}
        isEmpty={(c) => c.length === 0}
        empty={
          <p className="text-sm text-ink-muted">
            No cases for this member. Nothing has matched or been actioned yet.
          </p>
        }
      >
        {(rows) => (
          <DataTable
            caption="Member cases"
            rows={rows}
            rowKey={(c) => c.caseId}
            columns={[
              {
                key: 'case',
                header: 'Case',
                cell: (c) => <Link href={`/cases/${c.caseId}`}>{c.caseId}</Link>,
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
              {
                key: 'status',
                header: 'Status',
                cell: (c) => statusBadge(c.status),
              },
            ]}
          />
        )}
      </DataState>
    </>
  );
}
