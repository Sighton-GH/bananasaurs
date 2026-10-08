import { useCallback, useState } from 'react';
import { MCP_SCOPE_INFO, mcpScopeLabel } from '@bananasaurs/core';
import { Link } from 'wouter';
import { ApiError } from '../api.js';
import { describeError } from '../api/describe-error.js';
import type {
  GuildRoleInfo,
  McpClient,
  McpConnection,
  McpSend,
  McpToken,
  RoleAllowlistEntry,
  RoleAllowlistPurpose,
  RolePolicyMode,
  RolePolicyResponse,
  RolePolicyUpdate,
  SendAllowlistEntry,
} from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';
import { RolePicker } from '../ui/RolePicker.js';
import { useToast } from '../ui/Toast.js';

/**
 * `/mcp`: the connector's standing state as a page (ADR 0051 D3) —
 * `mcp clients`, `mcp connections` and `mcp tokens` (ADR 0130), revocation
 * and cleanup (`mcp disconnect`, `mcp delete-connection`, `mcp delete-token`,
 * `mcp cleanup`, `mcp revoke-client`), the send allowlist as READ-ONLY state, the send
 * ledger (`mcp sends`), and the role policy (`mcp role-policy`,
 * `mcp allow-role`, `mcp disallow-role`, ADR 0117 §2). Write (ADR 0126)
 * decides where a connector may post; the role allowlists decide which roles
 * it may grant or ping.
 *
 * The send allowlist's writers moved to the central Permissions section
 * (Bryan's lane): one page owns every operating-scope change so no second
 * surface can quietly conflict with it. This page links there instead of
 * duplicating the controls. The role allowlist's writers live here, on the
 * Role policy card below, because no other page owns them.
 */
/** A client id is long; the first characters tell two apps with the same name apart. */
const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 12)}…` : id);

const ROLE_POLICY_MODES: readonly RolePolicyMode[] = ['below-bot', 'allowlist'];
const ROLE_ALLOWLIST_PURPOSES: readonly RoleAllowlistPurpose[] = ['grant', 'ping'];

/**
 * Owner decision 2026-10-03: rows the Write seed wrote carry no human
 * author. The sentinel value is `WRITE_SEED_ACCOUNT_ID` in
 * `packages/storage/src/repos/mcp-send.ts` (compared by value here — the
 * dashboard bundle must not import storage); it renders as `Initial setup`.
 */
const formatSendAddedBy = (addedByAccountId: string): string =>
  addedByAccountId === 'system:write-seed' ? 'Initial setup' : addedByAccountId;

/**
 * A server refusal from the allow-role write, as one inline sentence. The
 * route answers 404 `no-such-role` and 409 `role-everyone` / `role-managed` /
 * `role-dangerous`; anything else falls back to the catalogued error text.
 */
const describeRoleRefusal = (err: unknown): string => {
  if (err instanceof ApiError) {
    if (err.body.error === 'no-such-role')
      return 'That role is not in this server — nothing was allowlisted.';
    if (err.body.error === 'role-everyone')
      return '@everyone can never be allowlisted — nothing was allowlisted.';
    if (err.body.error === 'role-managed')
      return 'That role is managed by an integration and can never be allowlisted — nothing was allowlisted.';
    if (err.body.error === 'role-dangerous')
      return (
        'That role holds a dangerous permission (ADR 0117 floor) and can never ' +
        'be allowlisted — nothing was allowlisted.'
      );
  }
  const described = describeError(err);
  return [described.message, described.hint].filter(Boolean).join(' ');
};

/**
 * The "Role policy" card: `mcp role-policy` / `mcp allow-role` /
 * `mcp disallow-role` through the same ports the CLI calls
 * (`GET /api/role-policy`, `POST /api/role-policy`,
 * `POST /api/role-allowlist`, `DELETE /api/role-allowlist/:roleId`).
 *
 * Mounted only once the policy has loaded, so the mode selectors seed
 * directly from `policy` and a `reload()` remounts this view with fresh
 * values — the same shape the automod rule page's mode section uses. Ids
 * and purposes only cross the API; role names come from the live role list
 * and degrade to bare ids when it is unavailable.
 */
function RolePolicyControls({
  policy,
  reload,
}: {
  readonly policy: RolePolicyResponse;
  readonly reload: () => void;
}) {
  const session = useSession();
  const toast = useToast();

  const [grantMode, setGrantMode] = useState<RolePolicyMode>(policy.grantMode);
  const [pingMode, setPingMode] = useState<RolePolicyMode>(policy.pingMode);
  const [roleId, setRoleId] = useState('');
  const [purpose, setPurpose] = useState<RoleAllowlistPurpose>('grant');
  const [addRefusal, setAddRefusal] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const loadRoles = useCallback(
    () =>
      session
        .read<{ roles: GuildRoleInfo[] }>('/api/guild/roles')
        .catch((): { roles: GuildRoleInfo[] } => ({ roles: [] })),
    [session],
  );
  const roles = useResource('the role list', loadRoles);
  const nameOf = (id: string): string =>
    roles.resource.state === 'ready'
      ? (roles.resource.data.roles.find((r) => r.roleId === id)?.name ?? id)
      : id;

  const saveModes = async () => {
    setBusy(true);
    const result = await session.write<RolePolicyUpdate>('/api/role-policy', {
      grant: grantMode,
      ping: pingMode,
    });
    setBusy(false);
    if (result !== undefined) {
      toast({
        tone: 'ok',
        title: result.changed
          ? `Role policy is now grant=${result.after.grantMode} ping=${result.after.pingMode}`
          : 'Role policy already had those modes — nothing changed',
      });
      reload();
    }
  };

  const allowRole = async () => {
    const trimmed = roleId.trim();
    if (trimmed === '') {
      setAddRefusal('Choose a role first — nothing was allowlisted.');
      return;
    }
    setAddRefusal(undefined);
    setBusy(true);
    try {
      const result = await session.writeOrThrow<{ outcome: string }>(
        '/api/role-allowlist',
        { roleId: trimmed, purpose, accountId: session.info.accountId },
        'POST',
        [404],
      );
      if (result === undefined) return;
      toast({
        tone: 'ok',
        title:
          result.outcome === 'already-allowed'
            ? 'That role was already allowlisted — nothing changed'
            : 'Role allowlisted',
      });
      setRoleId('');
      reload();
    } catch (err) {
      // `writeOrThrow` lets the server's 400/404/409 answers through; the
      // session toasts and resolves `undefined` for everything else, which
      // the early return above already handled.
      if (err instanceof ApiError) setAddRefusal(describeRoleRefusal(err));
      else throw err;
    } finally {
      setBusy(false);
    }
  };

  const disallowRole = async (entry: RoleAllowlistEntry) => {
    setBusy(true);
    const result = await session.write<{ ok: boolean }>(
      `/api/role-allowlist/${encodeURIComponent(entry.roleId)}?purpose=${entry.purpose}`,
      undefined,
      'DELETE',
    );
    setBusy(false);
    if (result !== undefined) {
      toast({ tone: 'ok', title: 'Role removed from the allowlist' });
      reload();
    }
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          Grant mode
          <select
            aria-label="Grant mode"
            value={grantMode}
            onChange={(e) => setGrantMode(e.target.value as RolePolicyMode)}
            className="rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
          >
            {ROLE_POLICY_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Ping mode
          <select
            aria-label="Ping mode"
            value={pingMode}
            onChange={(e) => setPingMode(e.target.value as RolePolicyMode)}
            className="rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
          >
            {ROLE_POLICY_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>
        <Button busy={busy} onClick={() => void saveModes()}>
          Save modes
        </Button>
      </div>
      <p className="text-sm text-ink-muted">
        below-bot passes every role below the bot; allowlist passes only the roles in the table.
        Above-bot roles may still be allowlisted — hierarchy is checked at use time, not here.
      </p>
      <DataState
        resource={{ state: 'ready', data: policy.entries }}
        isEmpty={(rows) => rows.length === 0}
        empty={
          <p className="text-sm text-ink-muted">
            No roles allowlisted — under allowlist modes the connector may grant or ping nothing.
          </p>
        }
      >
        {(rows) => (
          <DataTable
            caption="Roles the connector may grant or ping"
            rows={[...rows]}
            rowKey={(e) => `${e.purpose}:${e.roleId}`}
            columns={[
              {
                key: 'role',
                header: 'Role',
                cell: (e) => <span className="whitespace-nowrap">{nameOf(e.roleId)}</span>,
              },
              { key: 'id', header: 'Role ID', cell: (e) => e.roleId },
              { key: 'purpose', header: 'Purpose', cell: (e) => e.purpose },
              {
                key: 'addedBy',
                header: 'Added by',
                cell: (e) => <span className="whitespace-nowrap">{e.addedByAccountId}</span>,
              },
              {
                key: 'addedAt',
                header: 'Added',
                cell: (e) => (
                  <span className="whitespace-nowrap">{new Date(e.addedAt).toLocaleString()}</span>
                ),
              },
              {
                key: 'actions',
                header: '',
                cell: (e) => (
                  <Button busy={busy} onClick={() => void disallowRole(e)}>
                    Remove
                  </Button>
                ),
              },
            ]}
          />
        )}
      </DataState>
      <div className="grid max-w-md gap-2">
        <RolePicker label="Role" value={roleId} onChange={setRoleId} />
        <label className="grid gap-1 text-sm">
          Purpose
          <select
            aria-label="Purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as RoleAllowlistPurpose)}
            className="rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
          >
            {ROLE_ALLOWLIST_PURPOSES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <div>
          <Button busy={busy} onClick={() => void allowRole()}>
            Allow role
          </Button>
        </div>
        {addRefusal !== undefined && (
          <p role="alert" className="text-sm text-danger">
            {addRefusal}
          </p>
        )}
      </div>
    </div>
  );
}

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
        <Card title="Role policy">
          <DataState resource={rolePolicy.resource} isEmpty={() => false} empty={null}>
            {(policy) => <RolePolicyControls policy={policy} reload={rolePolicy.reload} />}
          </DataState>
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
        <Card
          title="Connections"
          action={<Button onClick={() => setCleaning(true)}>Clean up</Button>}
        >
          <DataState
            resource={connections.resource}
            isEmpty={(rows) => rows.length === 0}
            empty={<p className="text-sm text-ink-muted">No apps have connected yet.</p>}
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
                    cell: (c) =>
                      c.accountUsername ?? <span className="text-ink-muted">deleted</span>,
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
            <summary className="cursor-pointer text-sm text-ink-muted">
              Individual tokens (advanced)
            </summary>
            <div className="mt-2">
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
