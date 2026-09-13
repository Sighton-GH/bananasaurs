import { useCallback } from 'react';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';

interface AuditRow {
  auditId: number;
  at: number;
  actorType: string;
  actorId: string | null;
  actorUnixUserClaimed: string | null;
  via: string | null;
  action: string;
  subjectType: string;
  subjectId: string | null;
  dryRun: boolean;
}

/** The former Audit section: `GET /api/audit?limit=50`, same four columns and formatting. */
export function AuditPage() {
  const session = useSession();
  const load = useCallback(() => session.read<AuditRow[]>('/api/audit?limit=50'), [session]);
  const audit = useResource('the audit log', load);
  return (
    <>
      <PageHeader
        title="Audit"
        purpose="The last fifty things the bot did or refused to do, and who asked."
      />
      <DataState
        resource={audit.resource}
        isEmpty={(a) => a.length === 0}
        empty={<p className="text-sm text-ink-muted">Nothing has been audited yet.</p>}
      >
        {(rows) => (
          <DataTable
            caption="Audit log"
            rows={rows}
            rowKey={(r) => String(r.auditId)}
            columns={[
              { key: 'when', header: 'When', cell: (r) => new Date(r.at).toLocaleString() },
              {
                key: 'actor',
                header: 'Actor',
                cell: (r) =>
                  `${r.actorType}${r.actorUnixUserClaimed !== null ? ` (${r.actorUnixUserClaimed}, claimed)` : ''}`,
              },
              { key: 'action', header: 'Action', cell: (r) => r.action },
              {
                key: 'subject',
                header: 'Subject',
                cell: (r) => `${r.subjectType}${r.subjectId !== null ? `:${r.subjectId}` : ''}`,
              },
            ]}
          />
        )}
      </DataState>
    </>
  );
}
