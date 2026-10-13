import { Card } from '../../ui/Card.js';
import { DataState } from '../../ui/DataState.js';
import { DataTable } from '../../ui/DataTable.js';
import { MCP_SCOPE_INFO, mcpScopeLabel } from '@bananasaurs/core';
import type { McpConnection, McpToken } from '../../api/ops.js';
import type { UseResource } from '../../hooks/useResource.js';
import { Button } from '../../ui/Button.js';
import { Badge } from '../../ui/Badge.js';
const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 12)}…` : id);

export function ConnectionsSection({
  connections,
  tokens,
  setCleaning,
  setDisconnecting,
  setDeletingConnection,
  setDeletingToken,
}: {
  connections: UseResource<McpConnection[]>;
  tokens: UseResource<McpToken[]>;
  setCleaning: (cleaning: boolean) => void;
  setDisconnecting: (connection: McpConnection) => void;
  setDeletingConnection: (connection: McpConnection) => void;
  setDeletingToken: (token: McpToken) => void;
}) {
  return (
    <Card title="Connections" action={<Button onClick={() => setCleaning(true)}>Clean up</Button>}>
      <DataState
        resource={connections.resource}
        isEmpty={(rows) => rows.length === 0}
        empty={<p className="text-small text-ink-muted">No apps have connected yet.</p>}
      >
        {(rows) => (
          <DataTable
            caption="Each sign-in an app made. Disconnect stops it working; Delete also removes its rows."
            rows={rows}
            rowKey={(c) => c.connectionId}
            columns={[
              {
                key: 'account',
                header: 'Account',
                cell: (c) => c.accountUsername ?? <span className="text-ink-muted">deleted</span>,
              },
              {
                key: 'app',
                header: 'App',
                cell: (c) => (
                  <span className="whitespace-nowrap">
                    {c.clientName ?? 'deleted app'}{' '}
                    <span className="text-ink-muted">({shortId(c.clientId)})</span>
                  </span>
                ),
              },
              {
                key: 'can',
                header: 'Can',
                cell: (c) => (
                  <span className="flex flex-wrap gap-1">
                    {c.scopes.map((scope) => (
                      <span key={scope} title={MCP_SCOPE_INFO[scope]?.description}>
                        <Badge>{mcpScopeLabel(scope)}</Badge>
                      </span>
                    ))}
                  </span>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                cell: (c) => (
                  <Badge tone={c.status === 'connected' ? 'ok' : 'neutral'}>{c.status}</Badge>
                ),
              },
              {
                key: 'connected',
                header: 'Connected',
                cell: (c) => new Date(c.createdAt).toLocaleDateString(),
              },
              {
                key: 'lastUsed',
                header: 'Last used',
                cell: (c) =>
                  c.lastUsedAt === null ? (
                    <span className="text-ink-muted">never</span>
                  ) : (
                    new Date(c.lastUsedAt).toLocaleString()
                  ),
              },
              {
                key: 'actions',
                header: '',
                cell: (c) => (
                  <span className="flex gap-2">
                    {c.status === 'connected' && (
                      <Button onClick={() => setDisconnecting(c)}>Disconnect</Button>
                    )}
                    <Button variant="danger" onClick={() => setDeletingConnection(c)}>
                      Delete
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        )}
      </DataState>
      <details className="mt-3">
        <summary className="cursor-pointer text-small text-ink-muted">
          Individual tokens (advanced)
        </summary>
        <div className="mt-2">
          <DataState
            resource={tokens.resource}
            isEmpty={(rows) => rows.length === 0}
            empty={<p className="text-small text-ink-muted">No tokens minted yet.</p>}
          >
            {(rows) => (
              <DataTable
                caption="App access tokens - identifiers only; secret values are never shown"
                rows={rows}
                rowKey={(t) => t.tokenId}
                columns={[
                  { key: 'id', header: 'Token', cell: (t) => t.tokenId },
                  { key: 'kind', header: 'Kind', cell: (t) => t.kind },
                  { key: 'client', header: 'Client', cell: (t) => t.clientId },
                  { key: 'account', header: 'Account', cell: (t) => t.accountId },
                  {
                    key: 'expires',
                    header: 'Expires',
                    cell: (t) => new Date(t.expiresAt).toLocaleString(),
                  },
                  {
                    key: 'state',
                    header: 'State',
                    cell: (t) =>
                      t.revokedAt !== null ? (
                        <Badge tone="danger">revoked</Badge>
                      ) : t.expiresAt <= Date.now() ? (
                        <Badge tone="neutral">expired</Badge>
                      ) : (
                        <Badge tone="ok">live</Badge>
                      ),
                  },
                  {
                    key: 'lastUsed',
                    header: 'Last used',
                    cell: (t) =>
                      t.lastUsedAt === null ? (
                        <span className="text-ink-muted">never</span>
                      ) : (
                        new Date(t.lastUsedAt).toLocaleString()
                      ),
                  },
                  {
                    key: 'actions',
                    header: '',
                    cell: (t) => (
                      <Button variant="danger" onClick={() => setDeletingToken(t)}>
                        Delete
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </DataState>
        </div>
      </details>
    </Card>
  );
}
