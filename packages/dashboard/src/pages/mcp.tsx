import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import type { McpClient, McpSend, McpToken, SendAllowlistEntry } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

/**
 * `/mcp`: the connector's standing state as a page (ADR 0051 D3) —
 * `mcp clients`, `mcp tokens`, revocation (`mcp revoke`,
 * `mcp revoke-client`), the send allowlist as READ-ONLY state, and the send
 * ledger (`mcp sends`). Nothing is allowlisted by default, and the
 * allowlist is the only thing that decides where the connector may post.
 *
 * The allowlist's writers moved to the central Permissions section
 * (Bryan's lane): one page owns every operating-scope change so no second
 * surface can quietly conflict with it. This page links there instead of
 * duplicating the controls.
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
  const loadSends = useCallback(
    () => session.read<{ sends: McpSend[] }>('/api/mcp/sends?since=7d').then((r) => r.sends),
    [session],
  );
  const sends = useResource('the send ledger', loadSends);

  const [revokingToken, setRevokingToken] = useState<McpToken | undefined>(undefined);
  const [revokingClient, setRevokingClient] = useState<McpClient | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const revokeToken = async () => {
    if (revokingToken === undefined) return;
    setBusy(true);
    try {
      const result = await session.write<{ tokenId: string; tokensRevoked: number }>(
        `/api/mcp/tokens/${encodeURIComponent(revokingToken.tokenId)}/revoke`,
        {},
      );
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: `Token revoked — ${String(result.tokensRevoked)} token(s) in its lineage`,
        });
        tokens.reload();
      }
    } finally {
      setBusy(false);
      setRevokingToken(undefined);
    }
  };

  const revokeClient = async () => {
    if (revokingClient === undefined) return;
    setBusy(true);
    try {
      const result = await session.write<{ clientId: string; tokensRevoked: number }>(
        `/api/mcp/clients/${encodeURIComponent(revokingClient.clientId)}/revoke`,
        {},
      );
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: `Client removed — ${String(result.tokensRevoked)} token(s) revoked`,
        });
        clients.reload();
        tokens.reload();
      }
    } finally {
      setBusy(false);
      setRevokingClient(undefined);
    }
  };

  return (
    <>
      <PageHeader
        title="Connected apps"
        purpose="Control which connected apps may use Bananasaurs and which Discord channels they may post in. New apps cannot post anywhere until you allow a channel."
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
                    cell: (e2) => <span className="whitespace-nowrap">{e2.addedByAccountId}</span>,
                  },
                  {
                    key: 'addedAt',
                    header: 'Added',
                    cell: (e2) => (
                      <span className="whitespace-nowrap">
                        {new Date(e2.addedAt).toLocaleString()}
                      </span>
                    ),
                  },
                ]}
              />
            )}
          </DataState>
          <p className="mt-3 text-sm text-ink-muted">
            Where the connector may post is managed on the{' '}
            <Link href="/permissions" className="text-accent underline">
              Permissions
            </Link>{' '}
            page, alongside the archive scope - one place owns every operating-scope change.
          </p>
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
                      c.registrationSource === 'dynamic' ? 'by the app' : 'by an administrator',
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
        <Card title="Tokens">
          <DataState
            resource={tokens.resource}
            isEmpty={(rows) => rows.length === 0}
            empty={<p className="text-sm text-ink-muted">No tokens minted yet.</p>}
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
                    cell: (t) =>
                      t.revokedAt !== null ? null : (
                        <Button onClick={() => setRevokingToken(t)}>Revoke</Button>
                      ),
                  },
                ]}
              />
            )}
          </DataState>
        </Card>
        <Card title="Send ledger">
          <DataState
            resource={sends.resource}
            isEmpty={(rows) => rows.length === 0}
            empty={
              <p className="text-sm text-ink-muted">No connector messages in the last 7 days.</p>
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
      </div>
      <ConfirmDialog
        open={revokingToken !== undefined}
        title={`Revoke token ${revokingToken?.tokenId ?? ''}?`}
        scope={
          <p>
            The token and its whole lineage stop working at once; anything holding it has to
            authorise again.
          </p>
        }
        confirmLabel="Revoke token"
        danger
        busy={busy}
        onConfirm={() => void revokeToken()}
        onCancel={() => setRevokingToken(undefined)}
      />
      <ConfirmDialog
        open={revokingClient !== undefined}
        title={`Remove client ${revokingClient?.clientName ?? ''}?`}
        scope={
          <p>
            The app is removed and every access token ever issued to it stops working immediately.
          </p>
        }
        confirmLabel="Remove client"
        danger
        busy={busy}
        onConfirm={() => void revokeClient()}
        onCancel={() => setRevokingClient(undefined)}
      />
    </>
  );
}
