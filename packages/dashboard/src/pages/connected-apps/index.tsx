import { useCallback, useEffect, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { Content as TabsContent } from '@radix-ui/react-tabs';
import type { UseResource } from '../../hooks/useResource.js';
import type {
  McpClient,
  McpConnection,
  McpSend,
  McpToken,
  RolePolicyResponse,
  SendAllowlistEntry,
} from '../../api/ops.js';
import { useSession } from '../../app/session.js';
import { useResource } from '../../hooks/useResource.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Tabs, TabPanel } from '../../ui/Tabs.js';
import { useToast } from '../../ui/Toast.js';
import { SendAllowlistSection } from './send-allowlist.js';
import { RolePolicySection } from './role-policy.js';
import { RegisteredClientsSection } from './registered-clients.js';
import { ConnectionsSection } from './connections.js';
import { SendLedgerSection } from './send-ledger.js';

const CONNECTED_APP_TABS = [
  { value: 'connections', label: 'Connections' },
  { value: 'send-allowlist', label: 'Send allowlist' },
  { value: 'role-policy', label: 'Role policy' },
  { value: 'registered-clients', label: 'Registered clients' },
  { value: 'send-ledger', label: 'Send ledger' },
] as const;

/** Mount on first visit, then retain drafts and loaded roles while inactive. */
function PersistentRolePolicyPanel({
  active,
  rolePolicy,
}: {
  readonly active: boolean;
  readonly rolePolicy: UseResource<RolePolicyResponse>;
}) {
  const [visited, setVisited] = useState(active);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  if (!visited && !active) return null;
  return (
    <TabsContent
      value="role-policy"
      forceMount
      hidden={!active}
      tabIndex={active ? 0 : -1}
      className="focus-visible:outline-accent"
    >
      <RolePolicySection rolePolicy={rolePolicy} />
    </TabsContent>
  );
}

export function McpPage() {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const requestedTab = new URLSearchParams(search).get('tab');
  const tab = CONNECTED_APP_TABS.some((item) => item.value === requestedTab)
    ? requestedTab!
    : 'connections';
  const selectTab = (next: string) => {
    const params = new URLSearchParams(search);
    params.set('tab', next);
    navigate(`${location}?${params.toString()}${window.location.hash}`);
  };
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
  const loadConnections = useCallback(
    () =>
      session
        .read<{ connections: McpConnection[] }>('/api/mcp/connections')
        .then((r) => r.connections),
    [session],
  );
  const loadAllowlist = useCallback(
    () =>
      session.read<{ entries: SendAllowlistEntry[] }>('/api/send-allowlist').then((r) => r.entries),
    [session],
  );
  const clients = useResource('the MCP clients', loadClients);
  const tokens = useResource('the MCP tokens', loadTokens);
  const connections = useResource('the MCP connections', loadConnections);
  const allowlist = useResource('the send allowlist', loadAllowlist);
  const loadSends = useCallback(
    () => session.read<{ sends: McpSend[] }>('/api/mcp/sends?since=7d').then((r) => r.sends),
    [session],
  );
  const sends = useResource('the send ledger', loadSends);
  const loadRolePolicy = useCallback(
    () => session.read<RolePolicyResponse>('/api/role-policy'),
    [session],
  );
  const rolePolicy = useResource('the role policy', loadRolePolicy);

  const [disconnecting, setDisconnecting] = useState<McpConnection | undefined>(undefined);
  const [deletingConnection, setDeletingConnection] = useState<McpConnection | undefined>(
    undefined,
  );
  const [deletingToken, setDeletingToken] = useState<McpToken | undefined>(undefined);
  const [cleaning, setCleaning] = useState(false);
  const [revokingClient, setRevokingClient] = useState<McpClient | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const reloadConnections = () => {
    connections.reload();
    tokens.reload();
  };

  const disconnect = async () => {
    if (disconnecting === undefined) return;
    setBusy(true);
    try {
      const result = await session.write<{ connectionId: string; tokensRevoked: number }>(
        `/api/mcp/connections/${encodeURIComponent(disconnecting.connectionId)}/disconnect`,
        {},
      );
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: `Disconnected — ${String(result.tokensRevoked)} token(s) revoked`,
        });
        reloadConnections();
      }
    } finally {
      setBusy(false);
      setDisconnecting(undefined);
    }
  };

  const deleteConnection = async () => {
    if (deletingConnection === undefined) return;
    setBusy(true);
    try {
      const result = await session.write<{ connectionId: string; tokensDeleted: number }>(
        `/api/mcp/connections/${encodeURIComponent(deletingConnection.connectionId)}/delete`,
        {},
      );
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: `Connection deleted — ${String(result.tokensDeleted)} token row(s) removed`,
        });
        reloadConnections();
      }
    } finally {
      setBusy(false);
      setDeletingConnection(undefined);
    }
  };

  const deleteToken = async () => {
    if (deletingToken === undefined) return;
    setBusy(true);
    try {
      const result = await session.write<{ tokenId: string; tokensDeleted: number }>(
        `/api/mcp/tokens/${encodeURIComponent(deletingToken.tokenId)}/delete`,
        {},
      );
      if (result !== undefined) {
        toast({ tone: 'ok', title: 'Token row deleted' });
        reloadConnections();
      }
    } finally {
      setBusy(false);
      setDeletingToken(undefined);
    }
  };

  const cleanUp = async () => {
    setBusy(true);
    try {
      const result = await session.write<{ tokensDeleted: number; clientsDeleted: number }>(
        '/api/mcp/cleanup',
        {},
      );
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: `Cleaned up — ${String(result.tokensDeleted)} token rows and ${String(result.clientsDeleted)} unused apps deleted`,
        });
        reloadConnections();
        clients.reload();
      }
    } finally {
      setBusy(false);
      setCleaning(false);
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
        reloadConnections();
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
      <div className="min-w-0 max-w-full">
        <Tabs
          value={tab}
          onValueChange={selectTab}
          tabs={CONNECTED_APP_TABS}
          aria-label="Connected apps sections"
        >
          <TabPanel value="send-allowlist">
            <SendAllowlistSection allowlist={allowlist} />
          </TabPanel>
          <PersistentRolePolicyPanel active={tab === 'role-policy'} rolePolicy={rolePolicy} />
          <TabPanel value="registered-clients">
            <RegisteredClientsSection
              clients={clients}
              connections={connections}
              setRevokingClient={setRevokingClient}
            />
          </TabPanel>
          <TabPanel value="connections">
            <ConnectionsSection
              connections={connections}
              tokens={tokens}
              setCleaning={setCleaning}
              setDisconnecting={setDisconnecting}
              setDeletingConnection={setDeletingConnection}
              setDeletingToken={setDeletingToken}
            />
          </TabPanel>
          <TabPanel value="send-ledger">
            <SendLedgerSection sends={sends} />
          </TabPanel>
        </Tabs>
      </div>
      <ConfirmDialog
        open={disconnecting !== undefined}
        title={`Disconnect ${disconnecting?.clientName ?? 'this app'}?`}
        scope={
          <p>
            Every token from this sign-in stops working at once; the app has to sign in again. The
            rows are kept.
          </p>
        }
        confirmLabel="Disconnect app"
        danger
        busy={busy}
        onConfirm={() => void disconnect()}
        onCancel={() => setDisconnecting(undefined)}
      />
      <ConfirmDialog
        open={deletingConnection !== undefined}
        title={`Delete this ${deletingConnection?.clientName ?? 'app'} connection?`}
        scope={
          <p>
            Any live token is revoked first, then every token row of this connection is deleted.
            This cannot be undone.
          </p>
        }
        confirmLabel="Delete connection"
        danger
        busy={busy}
        onConfirm={() => void deleteConnection()}
        onCancel={() => setDeletingConnection(undefined)}
      />
      <ConfirmDialog
        open={deletingToken !== undefined}
        title={`Delete token ${deletingToken?.tokenId ?? ''}?`}
        scope={
          <p>
            If this token&apos;s connection is still connected, the whole connection is disconnected
            first (the app has to sign in again), then this one row is deleted.
          </p>
        }
        confirmLabel="Delete token"
        danger
        busy={busy}
        onConfirm={() => void deleteToken()}
        onCancel={() => setDeletingToken(undefined)}
      />
      <ConfirmDialog
        open={cleaning}
        title="Clean up connections?"
        scope={
          <p>
            This deletes every connection that no longer works (expired or revoked) with all its
            tokens, and every registered app that has no tokens, no sign-in in progress, and was
            registered over an hour ago. Working connections are not touched; their revoked tokens
            are kept until 14 days after they expire, so a stolen one is still caught.
          </p>
        }
        confirmLabel="Clean up"
        danger
        busy={busy}
        onConfirm={() => void cleanUp()}
        onCancel={() => setCleaning(false)}
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
