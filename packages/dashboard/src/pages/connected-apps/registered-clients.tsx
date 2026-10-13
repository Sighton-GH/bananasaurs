import { Card } from '../../ui/Card.js';
import { DataState } from '../../ui/DataState.js';
import { DataTable } from '../../ui/DataTable.js';
import type { McpClient, McpConnection } from '../../api/ops.js';
import type { UseResource } from '../../hooks/useResource.js';
import { Button } from '../../ui/Button.js';

export function RegisteredClientsSection({
  clients,
  connections,
  setRevokingClient,
}: {
  clients: UseResource<McpClient[]>;
  connections: UseResource<McpConnection[]>;
  setRevokingClient: (client: McpClient) => void;
}) {
  return (
    <Card title="Registered clients">
      <DataState
        resource={clients.resource}
        isEmpty={(rows) => rows.length === 0}
        empty={<p className="text-small text-ink-muted">No clients registered yet.</p>}
      >
        {(rows) => (
          <DataTable
            caption="Registered OAuth clients"
            rows={rows}
            rowKey={(c) => c.clientId}
            columns={[
              { key: 'name', header: 'Name', cell: (c) => c.clientName },
              { key: 'id', header: 'Client ID', cell: (c) => c.clientId },
              {
                key: 'source',
                header: 'Registered',
                cell: (c) =>
                  c.registrationSource === 'dynamic' ? 'by the app' : 'by an administrator',
              },
              {
                key: 'redirects',
                header: 'Redirect URIs',
                cell: (c) => c.redirectUriCount,
                numeric: true,
              },
              {
                key: 'connections',
                header: 'Connections',
                cell: (c) =>
                  connections.resource.state === 'ready'
                    ? connections.resource.data.filter((x) => x.clientId === c.clientId).length
                    : '',
                numeric: true,
              },
              {
                key: 'created',
                header: 'Created',
                cell: (c) => new Date(c.createdAt).toLocaleDateString(),
              },
              {
                key: 'actions',
                header: '',
                cell: (c) => <Button onClick={() => setRevokingClient(c)}>Revoke</Button>,
              },
            ]}
          />
        )}
      </DataState>
    </Card>
  );
}
