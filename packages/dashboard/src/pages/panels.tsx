import { useCallback } from 'react';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';

interface PanelSummary {
  panelId: string;
  kind: string;
  component: string;
  behaviour: string;
  status: string;
  messageId: string | undefined;
  optionCount: number;
}

/** The former Panels section: `GET /api/panels`, read-only here as before. */
export function PanelsPage() {
  const session = useSession();
  const load = useCallback(() => session.read<PanelSummary[]>('/api/panels'), [session]);
  const panels = useResource('the role panels', load);
  return (
    <>
      <PageHeader
        title="Role panels"
        purpose="Self-service role menus posted in Discord. Configuration is read-only here — use the operator CLI (panel show / panel sync)."
      />
      <DataState
        resource={panels.resource}
        isEmpty={(p) => p.length === 0}
        empty={
          <p className="text-sm text-ink-muted">
            No panels configured. Create one with the operator CLI.
          </p>
        }
      >
        {(rows) => (
          <DataTable
            caption="Role panels"
            rows={rows}
            rowKey={(p) => p.panelId}
            columns={[
              { key: 'id', header: 'Panel', cell: (p) => p.panelId },
              {
                key: 'shape',
                header: 'Kind',
                cell: (p) => `${p.kind}/${p.component}/${p.behaviour}`,
              },
              { key: 'status', header: 'Status', cell: (p) => p.status },
              { key: 'options', header: 'Options', cell: (p) => p.optionCount, numeric: true },
            ]}
          />
        )}
      </DataState>
    </>
  );
}
