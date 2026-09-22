import { useCallback, useMemo, useState } from 'react';
import { Link } from 'wouter';
import type {
  ArchiveAttachmentPolicy,
  ArchiveChannelStatus,
  ArchiveStatus,
  GuildChannelInfo,
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
import { useToast } from '../ui/Toast.js';

/**
 * `/permissions`: the central Permissions section (Bryan's lane). One place
 * answers "where may Bananasaurs operate" and controls it directly:
 *
 * - **Archive** decides which channels and categories the bot collects and
 *   keeps (`/api/archive/channels`, `/api/archive/categories`).
 * - **Send** decides where the MCP connector may post
 *   (`/api/send-allowlist`).
 * - **Excluded** channels are out of scope for sending, logging, and archiving
 *   (`/api/log-exclusions`) and override everything else.
 *
 * Every row shows its EFFECTIVE state, not just its stored row: a channel
 * covered by an enabled category reads "via <category>", and an excluded
 * channel reads Excluded even when a row exists. Category enablement covers
 * the channels under it; stopping a category is the lever for those
 * channels, which is why a covered channel offers no per-channel "off".
 *
 * The specialised controls that hang off these scopes stay on their own
 * pages — the connector's tokens and clients on MCP, browsing and backfill
 * on Archive, log routing on Logging, dashboard access on Accounts — and
 * are linked below rather than duplicated here.
 */

/** One display row: a category heading or a channel, with its effective state. */
interface ScopeRow {
  readonly id: string;
  readonly kind: 'channel' | 'category';
  readonly name: string;
  readonly channelKind?: string;
  /** Effective archive state. */
  readonly archive: 'on' | 'via-category' | 'off' | 'excluded';
  /** Name of the category a `via-category` state comes from. */
  readonly archiveVia?: string;
  /** Own-row message count, for the destroy confirmation. */
  readonly archiveMessages?: number;
  readonly send: 'on' | 'via-category' | 'off' | 'excluded';
  readonly sendVia?: string;
  readonly excluded: boolean;
  readonly depth: 0 | 1;
}

/** Build the display rows from the four reads, categories first with their channels beneath. */
const buildRows = (
  channels: readonly GuildChannelInfo[],
  archiveChannels: readonly ArchiveChannelStatus[],
  allowlist: readonly SendAllowlistEntry[],
  excludedChannels: readonly string[],
): ScopeRow[] => {
  const archiveById = new Map(archiveChannels.map((a) => [a.channelId, a]));
  const allowById = new Map(allowlist.map((e) => [e.channelId, e]));
  const nameOf = (id: string): string => channels.find((c) => c.channelId === id)?.name ?? id;
  const categoryArchiveOn = (id: string | undefined): boolean =>
    id !== undefined && (archiveById.get(id)?.scopeKind ?? 'channel') === 'category';
  const categorySendOn = (id: string | undefined): boolean =>
    id !== undefined && (allowById.get(id)?.scopeKind ?? 'channel') === 'category';

  const rows: ScopeRow[] = [];
  const categories = channels.filter((c) => c.kind === 'category');
  const texts = channels.filter((c) => c.kind !== 'category');

  const channelRow = (channel: GuildChannelInfo, depth: 0 | 1): ScopeRow => {
    const excluded = excludedChannels.includes(channel.channelId);
    const own = archiveById.get(channel.channelId);
    const ownRow = own !== undefined && (own.scopeKind ?? 'channel') === 'channel';
    const viaArchive =
      (own?.scopeKind === 'derived' ? own.derivedFrom : undefined) ??
      (categoryArchiveOn(channel.parentId) ? channel.parentId : undefined);
    const allowOwn = allowById.get(channel.channelId);
    const viaSend = categorySendOn(channel.parentId) ? channel.parentId : undefined;
    return {
      id: channel.channelId,
      kind: 'channel',
      name: channel.name,
      channelKind: channel.kind,
      archive: excluded
        ? 'excluded'
        : ownRow
          ? 'on'
          : viaArchive !== undefined
            ? 'via-category'
            : 'off',
      ...(viaArchive !== undefined ? { archiveVia: nameOf(viaArchive) } : {}),
      ...(ownRow && own !== undefined ? { archiveMessages: own.messageCount } : {}),
      send: excluded
        ? 'excluded'
        : allowOwn !== undefined
          ? 'on'
          : viaSend !== undefined
            ? 'via-category'
            : 'off',
      ...(!excluded && viaSend !== undefined && allowOwn === undefined
        ? { sendVia: nameOf(viaSend) }
        : {}),
      excluded,
      depth,
    };
  };

  const grouped = new Set<string>();
  for (const category of categories) {
    const arch = archiveById.get(category.channelId);
    const allow = allowById.get(category.channelId);
    const archiveOn = (arch?.scopeKind ?? 'channel') === 'category';
    rows.push({
      id: category.channelId,
      kind: 'category',
      name: category.name,
      archive: archiveOn ? 'on' : 'off',
      ...(archiveOn && arch !== undefined ? { archiveMessages: arch.messageCount } : {}),
      send: (allow?.scopeKind ?? 'channel') === 'category' ? 'on' : 'off',
      excluded: false,
      depth: 0,
    });
    for (const channel of texts.filter((c) => c.parentId === category.channelId)) {
      grouped.add(channel.channelId);
      rows.push(channelRow(channel, 1));
    }
  }
  for (const channel of texts.filter((c) => !grouped.has(c.channelId))) {
    rows.push(channelRow(channel, 0));
  }
  return rows;
};

/** A pending archive stop, channel or category, for the destroy confirmation. */
interface PendingArchiveStop {
  readonly id: string;
  readonly kind: 'channel' | 'category';
  readonly name: string;
  readonly messages: number;
}

export function PermissionsPage() {
  const session = useSession();
  const toast = useToast();
  // One combined load: the page's effective state only makes sense with all
  // three scope sources plus the channel list together. Exclusions ride the
  // logging read; an account without logging.manage simply cannot manage
  // that dimension, so it degrades to `undefined` and the column hides its
  // controls honestly.
  const load = useCallback(async () => {
    const [channelList, archiveStatus, allow, excluded] = await Promise.all([
      session.read<{ channels: GuildChannelInfo[] }>('/api/guild/channels'),
      session.read<ArchiveStatus>('/api/archive/status'),
      session.read<{ entries: SendAllowlistEntry[] }>('/api/send-allowlist'),
      session
        .read<{ excludedChannels?: string[] }>('/api/log-routes')
        .then((r) => r.excludedChannels ?? [])
        .catch(() => undefined),
    ]);
    return {
      channels: channelList.channels,
      archiveChannels: archiveStatus.channels,
      allowlist: allow.entries,
      excluded,
    };
  }, [session]);
  const scope = useResource('the operating scope', load);

  const [stopping, setStopping] = useState<PendingArchiveStop | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Attachment policy applies when a channel's archiving is switched on here
  // (categories always enable text-only, matching the CLI). It cannot change
  // after enablement anywhere, so the choice sits beside the controls.
  const [policy, setPolicy] = useState<ArchiveAttachmentPolicy>('none');

  const rows = useMemo(
    () =>
      scope.resource.state === 'ready'
        ? buildRows(
            scope.resource.data.channels,
            scope.resource.data.archiveChannels,
            scope.resource.data.allowlist,
            scope.resource.data.excluded ?? [],
          )
        : undefined,
    [scope.resource],
  );

  const reloadAll = () => scope.reload();

  const archiveEnable = async (row: ScopeRow) => {
    setBusy(true);
    const result = await session.write<{ outcome: string }>(
      row.kind === 'category' ? '/api/archive/categories' : '/api/archive/channels',
      row.kind === 'category'
        ? { channelId: row.id }
        : { channelId: row.id, attachmentPolicy: policy },
    );
    setBusy(false);
    if (result !== undefined) {
      toast({
        tone: 'ok',
        title:
          row.kind === 'category'
            ? `Archiving on for the ${row.name} category`
            : `Archiving on for #${row.name}`,
      });
      reloadAll();
    }
  };

  const confirmArchiveStop = async () => {
    if (stopping === undefined) return;
    setBusy(true);
    const result = await session.write<{ messageCount?: number }>(
      `/api/archive/${stopping.kind === 'category' ? 'categories' : 'channels'}/${encodeURIComponent(stopping.id)}`,
      undefined,
      'DELETE',
    );
    setBusy(false);
    setStopping(undefined);
    if (result !== undefined) {
      toast({
        tone: 'ok',
        title:
          result.messageCount !== undefined && result.messageCount > 0
            ? `Archiving stopped — ${String(result.messageCount)} archived messages destroyed`
            : 'Archiving stopped',
      });
      reloadAll();
    }
  };

  const sendAllow = async (row: ScopeRow) => {
    setBusy(true);
    const result = await session.write<{ outcome: string }>(
      row.kind === 'category' ? '/api/send-allowlist/categories' : '/api/send-allowlist',
      { channelId: row.id, accountId: session.info.accountId },
    );
    setBusy(false);
    if (result !== undefined) {
      toast({
        tone: 'ok',
        title:
          row.kind === 'category'
            ? `The connector may post anywhere under ${row.name}`
            : `The connector may post in #${row.name}`,
      });
      reloadAll();
    }
  };

  const sendDisallow = async (row: ScopeRow) => {
    setBusy(true);
    const result = await session.write<{ ok: boolean }>(
      `/api/send-allowlist/${row.kind === 'category' ? 'categories/' : ''}${encodeURIComponent(row.id)}`,
      undefined,
      'DELETE',
    );
    setBusy(false);
    if (result !== undefined) {
      toast({
        tone: 'ok',
        title:
          row.kind === 'category'
            ? 'Category removed from the send scope'
            : `#${row.name} removed from the send scope`,
      });
      reloadAll();
    }
  };

  const toggleExclusion = async (row: ScopeRow) => {
    setBusy(true);
    const result = await session.write<{ ok: boolean }>(
      row.excluded ? `/api/log-exclusions/${encodeURIComponent(row.id)}` : '/api/log-exclusions',
      row.excluded ? undefined : { channelId: row.id },
      row.excluded ? 'DELETE' : 'POST',
    );
    setBusy(false);
    if (result !== undefined) {
      toast({
        tone: 'ok',
        title: row.excluded
          ? `#${row.name} is in scope again`
          : `#${row.name} excluded from sending, logging, and archiving`,
      });
      reloadAll();
    }
  };

  return (
    <>
      <PageHeader
        title="Permissions"
        purpose="Where Bananasaurs may operate, channel by channel and category by category. Archive decides what the bot collects and keeps; Send decides where the MCP connector may post; an excluded channel is out of both. Changes apply as soon as you make them."
      />
      <DataState
        resource={scope.resource}
        isEmpty={(data) => data.channels.length === 0}
        empty={
          <Card title="No channels yet">
            <p className="text-sm text-ink-muted">
              The bot cannot see any channels in this server. Check its Discord permissions, then
              reload.
            </p>
          </Card>
        }
      >
        {(data) => (
          <Card title="Operating scope">
            <p className="mb-3 text-sm text-ink-muted">
              A channel covered by an enabled category follows the category - stop the category to
              switch those channels off. Backfill, browsing and retention stay on the Archive page.
            </p>
            <label className="mb-3 flex items-center gap-2 text-sm">
              New channels archive attachments as
              <select
                aria-label="Attachment policy"
                value={policy}
                onChange={(e) => setPolicy(e.target.value as ArchiveAttachmentPolicy)}
                className="rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
              >
                <option value="none">text only</option>
                <option value="bytes">text + attachment bytes</option>
              </select>
            </label>
            <DataTable
              caption="Operating scope by channel and category"
              rows={rows ?? []}
              rowKey={(row) => row.id}
              columns={[
                {
                  key: 'name',
                  header: 'Channel',
                  cell: (row) => (
                    <span className={row.depth === 1 ? 'pl-4' : 'font-medium'}>
                      {row.kind === 'category' ? row.name : `#${row.name}`}
                      {row.channelKind === 'announcement' && (
                        <span className="text-ink-muted"> (announcement)</span>
                      )}
                    </span>
                  ),
                },
                {
                  key: 'archive',
                  header: 'Archive',
                  cell: (row) =>
                    row.archive === 'on' ? (
                      <Badge tone="ok">On</Badge>
                    ) : row.archive === 'via-category' ? (
                      <Badge tone="ok">On, via {row.archiveVia}</Badge>
                    ) : row.archive === 'excluded' ? (
                      <Badge tone="hold">Excluded</Badge>
                    ) : (
                      <Badge>Off</Badge>
                    ),
                },
                {
                  key: 'send',
                  header: 'Send',
                  cell: (row) =>
                    row.send === 'excluded' ? (
                      <Badge tone="hold">Excluded</Badge>
                    ) : row.send === 'on' ? (
                      <Badge tone="ok">On</Badge>
                    ) : row.send === 'via-category' ? (
                      <Badge tone="ok">On, via {row.sendVia}</Badge>
                    ) : (
                      <Badge>Off</Badge>
                    ),
                },
                {
                  key: 'actions',
                  header: 'Change',
                  cell: (row) => (
                    <span className="flex flex-wrap gap-1">
                      {row.archive === 'off' && (
                        <Button busy={busy} onClick={() => void archiveEnable(row)}>
                          {row.kind === 'category' ? 'Archive category' : 'Archive'}
                        </Button>
                      )}
                      {row.archive === 'on' && (
                        <Button
                          busy={busy}
                          onClick={() =>
                            setStopping({
                              id: row.id,
                              kind: row.kind,
                              name: row.name,
                              messages: row.archiveMessages ?? 0,
                            })
                          }
                        >
                          Stop archiving
                        </Button>
                      )}
                      {row.send === 'off' && (
                        <Button busy={busy} onClick={() => void sendAllow(row)}>
                          Allow send
                        </Button>
                      )}
                      {row.send === 'on' && (
                        <Button busy={busy} onClick={() => void sendDisallow(row)}>
                          Stop send
                        </Button>
                      )}
                      {row.kind === 'channel' && data.excluded !== undefined && (
                        <Button busy={busy} onClick={() => void toggleExclusion(row)}>
                          {row.excluded ? 'Include again' : 'Exclude'}
                        </Button>
                      )}
                    </span>
                  ),
                },
              ]}
            />
            {data.excluded === undefined && (
              <p className="mt-2 text-sm text-ink-muted">
                This account cannot see or change exclusions (that needs the logging capability);
                the Excluded state is shown without its controls.
              </p>
            )}
          </Card>
        )}
      </DataState>

      <Card title="Specialised controls">
        <ul className="grid gap-2 text-sm">
          <li>
            <Link href="/mcp" className="text-accent underline">
              MCP connector
            </Link>{' '}
            — the connector&apos;s tokens and clients, and the ledger of what it posted. The send
            scope itself is managed above.
          </li>
          <li>
            <Link href="/archive" className="text-accent underline">
              Archive
            </Link>{' '}
            — browse archived messages, run backfills, set attachment policy and retention. Which
            channels archive is managed above.
          </li>
          <li>
            <Link href="/logging" className="text-accent underline">
              Logging
            </Link>{' '}
            — which events get logged and where the log posts.
          </li>
          <li>
            <Link href="/accounts" className="text-accent underline">
              Accounts
            </Link>{' '}
            — who may sign in to this dashboard and what each account may change.
          </li>
          <li>
            <Link href="/assistant" className="text-accent underline">
              Assistant
            </Link>{' '}
            — which assistant skills the server allows at all, before any per-member check.
          </li>
          <li>
            <Link href="/panels" className="text-accent underline">
              Self-granted roles
            </Link>{' '}
            — per-panel limits on who may pick up roles.
          </li>
        </ul>
      </Card>

      <ConfirmDialog
        open={stopping !== undefined}
        title={
          stopping?.kind === 'category'
            ? `Stop archiving the ${stopping.name} category?`
            : `Stop archiving #${stopping?.name ?? ''}?`
        }
        scope={
          <p>
            {stopping !== undefined && stopping.messages > 0
              ? `This permanently destroys the ${String(stopping.messages)} archived messages ${stopping.kind === 'category' ? 'under this category' : 'in this channel'}.`
              : 'Nothing has been archived here yet, so nothing is destroyed.'}{' '}
            New messages stop being collected immediately.
          </p>
        }
        confirmLabel="Stop archiving"
        danger
        busy={busy}
        onConfirm={() => void confirmArchiveStop()}
        onCancel={() => setStopping(undefined)}
      />
    </>
  );
}
