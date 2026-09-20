import { useCallback, useState } from 'react';
import type { McpClient, McpToken, SendAllowlistEntry, SendAllowOutcome } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { Field, Input } from '../ui/Field.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

/**
 * `/mcp`: the connector's standing state as a page (ADR 0051 D3) —
 * `mcp clients`, `mcp tokens` and the send allowlist (`mcp allowlist`,
 * `allow-channel`, `disallow-channel`). Nothing is allowlisted by default,
 * and the allowlist is the only thing that decides where the connector may
 * post. Token and client revocation and the send ledger stay on the CLI for
 * now (`mcp revoke`, `mcp revoke-client`, `mcp sends`) — no HTTP route
 * exists for them yet, and the page says so rather than hiding it.
 */
export function McpPage() {
  const session = useSession();
  const toast = useToast();
  const loadClients = useCallback(
    () => session.read<{ clients: McpClient[] }>('/api/mcp/clients').then((r) => r.clients),
    [session],
  );
  const loadTokens = useCallback(
    () => session.read<{ tokens: McpToken[] }>('/api/mcp/tokens').then((r) => r.tokens),
    [session],
  );
  const loadAllowlist = useCallback(
    () =>
      session.read<{ entries: SendAllowlistEntry[] }>('/api/send-allowlist').then((r) => r.entries),
    [session],
  );
  const clients = useResource('the MCP clients', loadClients);
  const tokens = useResource('the MCP tokens', loadTokens);
  const allowlist = useResource('the send allowlist', loadAllowlist);

  const [channelId, setChannelId] = useState('');
  const [removing, setRemoving] = useState<SendAllowlistEntry | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const allow = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    // A 404 `no-such-channel` is the session's toast contract, the same as
    // every other write on this surface — only 400/409 answers render inline.
    const result = await session.write<{ outcome: SendAllowOutcome }>('/api/send-allowlist', {
      channelId: channelId.trim(),
      accountId: session.info.accountId,
    });
    setBusy(false);
    if (result !== undefined) {
      toast({
        tone: 'ok',
        title:
          result.outcome === 'already-allowed'
            ? 'That channel was already allowlisted'
            : 'Channel allowlisted',
      });
      setChannelId('');
      allowlist.reload();
    }
  };

  const disallow = async () => {
    if (removing === undefined) return;
    setBusy(true);
    try {
      const result = await session.write<{ ok: boolean; removed: boolean }>(
        `/api/send-allowlist/${encodeURIComponent(removing.channelId)}`,
        undefined,
        'DELETE',
      );
      if (result !== undefined) {
        toast({
          tone: result.removed ? 'ok' : 'neutral',
          title: result.removed
            ? 'Channel removed from the allowlist'
            : 'That channel was not on the allowlist',
        });
        allowlist.reload();
      }
    } finally {
      setBusy(false);
      setRemoving(undefined);
    }
  };

  return (
    <>
      <PageHeader
        title="MCP connector"
        purpose="The clients and tokens the connector holds, and the allowlist that decides where it may post — which is nowhere, until a channel is added."
      />
      <div className="grid max-w-4xl gap-3">
        <Card title="Send allowlist">
          <DataState
            resource={allowlist.resource}
            isEmpty={(rows) => rows.length === 0}
            empty={
              <p className="text-sm text-ink-muted">
                No channels allowlisted — the connector can post nowhere. Add one below.
              </p>
            }
          >
            {(rows) => (
              <DataTable
                caption="Channels the connector may post to"
                rows={rows}
                rowKey={(e2) => e2.channelId}
                columns={[
                  { key: 'channel', header: 'Channel', cell: (e2) => e2.channelId },
                  { key: 'addedBy', header: 'Added by', cell: (e2) => e2.addedByAccountId },
                  {
                    key: 'addedAt',
                    header: 'Added',
                    cell: (e2) => new Date(e2.addedAt).toLocaleString(),
                  },
                  {
                    key: 'actions',
                    header: '',
                    cell: (e2) => <Button onClick={() => setRemoving(e2)}>Remove</Button>,
                  },
                ]}
              />
            )}
          </DataState>
          <form onSubmit={(e) => void allow(e)} className="mt-3 grid max-w-md gap-3">
            <Field
              label="Allow a channel"
              hint="The channel's snowflake ID. Mentions never ping and the ten-per-hour guild limit applies."
            >
              <Input value={channelId} onChange={(e) => setChannelId(e.target.value)} />
            </Field>
            <div>
              <Button
                type="submit"
                variant="primary"
                busy={busy}
                disabled={channelId.trim() === ''}
              >
                Allow channel
              </Button>
            </div>
          </form>
        </Card>
        <Card title="Registered clients">
          <DataState
            resource={clients.resource}
            isEmpty={(rows) => rows.length === 0}
            empty={<p className="text-sm text-ink-muted">No clients registered yet.</p>}
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
                      c.registrationSource === 'dynamic' ? 'dynamic (RFC 7591)' : 'via CLI',
                  },
                  {
                    key: 'redirects',
                    header: 'Redirect URIs',
                    cell: (c) => c.redirectUriCount,
                    numeric: true,
                  },
                  {
                    key: 'created',
                    header: 'Created',
                    cell: (c) => new Date(c.createdAt).toLocaleDateString(),
                  },
                ]}
              />
            )}
          </DataState>
        </Card>
        <Card title="Tokens">
          <DataState
            resource={tokens.resource}
            isEmpty={(rows) => rows.length === 0}
            empty={<p className="text-sm text-ink-muted">No tokens minted yet.</p>}
          >
            {(rows) => (
              <DataTable
                caption="OAuth token rows — ids only, values are never retrievable"
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
                ]}
              />
            )}
          </DataState>
        </Card>
        <Card title="Still on the CLI">
          <p className="text-sm">
            Revoking a token lineage or a whole client, and the send ledger (
            <code className="text-xs">mcp sends</code>), have no HTTP route yet — use{' '}
            <code className="text-xs">mcp revoke</code>,{' '}
            <code className="text-xs">mcp revoke-client</code> and{' '}
            <code className="text-xs">mcp sends</code> from the operator CLI.
          </p>
        </Card>
      </div>
      <ConfirmDialog
        open={removing !== undefined}
        title={`Remove ${removing?.channelId ?? ''} from the allowlist?`}
        scope={
          <p>
            The connector can no longer post to channel {removing?.channelId ?? ''}. Nothing else
            changes — the allowlist alone decides where it may post.
          </p>
        }
        confirmLabel="Remove channel"
        danger
        busy={busy}
        onConfirm={() => void disallow()}
        onCancel={() => setRemoving(undefined)}
      />
    </>
  );
}
