import { Card } from '../../ui/Card.js';
import { DataState } from '../../ui/DataState.js';
import { DataTable } from '../../ui/DataTable.js';
import type { SendAllowlistEntry } from '../../api/ops.js';
import type { UseResource } from '../../hooks/useResource.js';
import { Link } from '../../ui/Link.js';
const formatSendAddedBy = (id: string): string =>
  id === 'system:write-seed' ? 'Initial setup' : id;

export function SendAllowlistSection({
  allowlist,
}: {
  allowlist: UseResource<SendAllowlistEntry[]>;
}) {
  return (
    <Card title="Send allowlist">
      <DataState
        resource={allowlist.resource}
        isEmpty={(rows) => rows.length === 0}
        empty={
          <p className="text-small text-ink-muted">
            No channels allowlisted — the connector can post nowhere. Manage channels in
            Permissions.
          </p>
        }
      >
        {(rows) => (
          <DataTable
            caption="Channels the connector may post to"
            rows={rows}
            rowKey={(e2) => e2.channelId}
            columns={[
              {
                key: 'channel',
                header: 'Channel',
                cell: (e2) => <span className="whitespace-nowrap">{e2.channelId}</span>,
              },
              {
                key: 'kind',
                header: 'Kind',
                cell: (e2) =>
                  (e2.scopeKind ?? 'channel') === 'category'
                    ? `category — covers ${String(e2.coverage ?? 0)} channels`
                    : 'channel',
              },
              {
                key: 'addedBy',
                header: 'Added by',
                cell: (e2) => (
                  <span className="whitespace-nowrap">
                    {formatSendAddedBy(e2.addedByAccountId)}
                  </span>
                ),
              },
              {
                key: 'addedAt',
                header: 'Added',
                cell: (e2) => (
                  <span className="whitespace-nowrap">{new Date(e2.addedAt).toLocaleString()}</span>
                ),
              },
            ]}
          />
        )}
      </DataState>
      <p className="mt-3 text-small text-ink-muted">
        Where the connector may post is managed on the{' '}
        <Link href="/permissions" className="text-accent underline">
          Permissions
        </Link>{' '}
        page, alongside the archive scope - one place owns every operating-scope change.
      </p>
    </Card>
  );
}
