import { Card } from '../../ui/Card.js';
import { DataState } from '../../ui/DataState.js';
import { DataTable } from '../../ui/DataTable.js';
import type { McpSend } from '../../api/ops.js';
import type { UseResource } from '../../hooks/useResource.js';
import { Badge } from '../../ui/Badge.js';

export function SendLedgerSection({ sends }: { sends: UseResource<McpSend[]> }) {
  return (
    <Card title="Send ledger">
      <DataState
        resource={sends.resource}
        isEmpty={(rows) => rows.length === 0}
        empty={
          <p className="text-small text-ink-muted">No connector messages in the last 7 days.</p>
        }
      >
        {(rows) => (
          <DataTable
            caption="Recent connector messages - channels and outcomes, never message content"
            rows={rows}
            rowKey={(s2) => `${s2.tokenId}:${String(s2.sentAt)}:${s2.channelId}`}
            columns={[
              {
                key: 'sentAt',
                header: 'Sent',
                cell: (s2) => new Date(s2.sentAt).toLocaleString(),
              },
              {
                key: 'outcome',
                header: 'Outcome',
                cell: (s2) =>
                  s2.outcome === 'sent' && s2.messageId === null ? (
                    <Badge tone="neutral">sent (no message id)</Badge>
                  ) : s2.outcome === 'sent' ? (
                    <Badge tone="ok">sent</Badge>
                  ) : (
                    <Badge tone="neutral">dry run</Badge>
                  ),
              },
              { key: 'channel', header: 'Channel', cell: (s2) => s2.channelId },
              { key: 'token', header: 'Token', cell: (s2) => s2.tokenId },
              {
                key: 'message',
                header: 'Message',
                cell: (s2) => s2.messageId ?? <span className="text-ink-muted">—</span>,
              },
            ]}
          />
        )}
      </DataState>
    </Card>
  );
}
