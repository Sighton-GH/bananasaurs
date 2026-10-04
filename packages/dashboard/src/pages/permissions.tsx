import { useCallback, useMemo, useState } from 'react';
import { Link } from 'wouter';
import type {
  ArchiveAttachmentPolicy,
  ArchiveChannelStatus,
  ArchiveStatus,
  GuildChannelInfo,
  ReadScopeEntry,
  SendAllowlistEntry,
} from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

/**
 * `/permissions`: the central Permissions section (Bryan's lane). One place
 * answers "what may Bananasaurs do here" and controls it directly:
 *
 * - **Read** decides which channels and categories the bot may look up live
 *   from Discord (`/api/read-scope`).
 * - **Write** decides where the bot may post
 *   (`/api/send-allowlist`).
 * - **Archive** decides which channels and categories the bot records into a
 *   searchable copy (`/api/archive/channels`, `/api/archive/categories`).
 *   Turning it off pauses recording; nothing is deleted here — deleting
 *   archived messages stays on the Archive page.
 * - **No access** channels are out of scope for read, write and archive
 *   (`/api/log-exclusions`) and override everything else.
 *
 * Every row shows its EFFECTIVE state, not just its stored row: a channel
 * covered by an enabled category reads "via <category>", and an excluded
 * channel reads No access even when a row exists. Category enablement covers
 * the channels under it; changing a category is the lever for those
 * channels, which is why a covered channel offers no per-channel switch.
 *
 * The specialised controls that hang off these scopes stay on their own
 * pages — the assistant's access and skill grants on Assistant, browsing and
 * backfill on Archive, log routing on Logging, dashboard access on Accounts —
 * and are linked below rather than duplicated here.
 */

/** One display row: a category heading or a channel, with its effective state. */
interface ScopeRow {
  readonly id: string;
  readonly kind: 'channel' | 'category';
  readonly name: string;
  readonly channelKind?: string;
  /** Effective archive state. `paused` is collecting === false: off, history kept. */
  readonly archive: 'on' | 'via-category' | 'off' | 'paused' | 'paused-via-category' | 'excluded';
  /** Name of the category a `via-category` or `paused-via-category` state comes from. */
  readonly archiveVia?: string;
  readonly read: 'on' | 'via-category' | 'off' | 'excluded';
  readonly readVia?: string;
  readonly send: 'on' | 'via-category' | 'off' | 'excluded';
  readonly sendVia?: string;
  readonly excluded: boolean;
  readonly depth: 0 | 1;
}

/** Build the display rows from the five reads, categories first with their channels beneath. */
const buildRows = (
  channels: readonly GuildChannelInfo[],
  archiveChannels: readonly ArchiveChannelStatus[],
  allowlist: readonly SendAllowlistEntry[],
  readScope: readonly ReadScopeEntry[],
  excludedChannels: readonly string[],
): ScopeRow[] => {
  const archiveById = new Map(archiveChannels.map((a) => [a.channelId, a]));
  const allowById = new Map(allowlist.map((e) => [e.channelId, e]));
  const readById = new Map(readScope.map((e) => [e.channelId, e]));
  const nameOf = (id: string): string => channels.find((c) => c.channelId === id)?.name ?? id;
  const categoryArchiveOn = (id: string | undefined): boolean =>
    id !== undefined && (archiveById.get(id)?.scopeKind ?? 'channel') === 'category';
  const categorySendOn = (id: string | undefined): boolean =>
    id !== undefined && (allowById.get(id)?.scopeKind ?? 'channel') === 'category';
  const categoryReadOn = (id: string | undefined): boolean =>
    id !== undefined && (readById.get(id)?.scopeKind ?? 'channel') === 'category';

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
    const ownPaused = ownRow && own?.collecting === false;
    const viaPaused = viaArchive !== undefined && archiveById.get(viaArchive)?.collecting === false;
    const allowOwn = allowById.get(channel.channelId);
    const viaSend = categorySendOn(channel.parentId) ? channel.parentId : undefined;
    const readOwn = readById.get(channel.channelId);
    const viaRead = categoryReadOn(channel.parentId) ? channel.parentId : undefined;
    const archive: ScopeRow['archive'] = excluded
      ? 'excluded'
      : ownPaused
        ? 'paused'
        : ownRow
          ? 'on'
          : viaPaused
            ? 'paused-via-category'
            : viaArchive !== undefined
              ? 'via-category'
              : 'off';
    return {
      id: channel.channelId,
      kind: 'channel',
      name: channel.name,
      channelKind: channel.kind,
      archive,
      ...(archive === 'via-category' || archive === 'paused-via-category'
        ? { archiveVia: nameOf(viaArchive as string) }
        : {}),
      read: excluded
        ? 'excluded'
        : readOwn !== undefined
          ? 'on'
          : viaRead !== undefined
            ? 'via-category'
            : 'off',
      ...(!excluded && viaRead !== undefined && readOwn === undefined
        ? { readVia: nameOf(viaRead) }
        : {}),
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
    const read = readById.get(category.channelId);
    const archiveOn = (arch?.scopeKind ?? 'channel') === 'category';
    rows.push({
      id: category.channelId,
      kind: 'category',
      name: category.name,
      archive: archiveOn ? (arch?.collecting === false ? 'paused' : 'on') : 'off',
      read: (read?.scopeKind ?? 'channel') === 'category' ? 'on' : 'off',
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

export function PermissionsPage() {
  const session = useSession();
  const toast = useToast();
  // One combined load: the page's effective state only makes sense with all
  // four scope sources plus the channel list together. Exclusions ride the
  // logging read; an account without logging.manage simply cannot manage
  // that dimension, so it degrades to `undefined` and the column hides its
  // controls honestly.
  const load = useCallback(async () => {
    const [channelList, archiveStatus, allow, read, excluded] = await Promise.all([
      session.read<{ channels: GuildChannelInfo[] }>('/api/guild/channels'),
      session.read<ArchiveStatus>('/api/archive/status'),
      session.read<{ entries: SendAllowlistEntry[] }>('/api/send-allowlist'),
      session.read<{ entries: ReadScopeEntry[] }>('/api/read-scope'),
      session
        .read<{ excludedChannels?: string[] }>('/api/log-routes')
        .then((r) => r.excludedChannels ?? [])
        .catch(() => undefined),
    ]);
    return {
      channels: channelList.channels,
      archiveChannels: archiveStatus.channels,
      allowlist: allow.entries,
      readScope: read.entries,
      excluded,
    };
  }, [session]);
  const scope = useResource('the operating scope', load);

  const [busy, setBusy] = useState(false);
  // Attachment policy applies when a channel's archiving is switched on here
  // (categories always enable text-only, matching the CLI). It cannot change
  // after enablement anywhere, so the choice sits beside the controls.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [policy, setPolicy] = useState<ArchiveAttachmentPolicy>('none');

  const rows = useMemo(
    () =>
      scope.resource.state === 'ready'
        ? buildRows(
            scope.resource.data.channels,
            scope.resource.data.archiveChannels,
            scope.resource.data.allowlist,
            scope.resource.data.readScope,
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

  const archivePause = async (row: ScopeRow) => {
    setBusy(true);
    const result = await session.write<{ outcome: string }>(
      `/api/archive/${row.kind === 'category' ? 'categories' : 'channels'}/${encodeURIComponent(row.id)}/pause`,
      undefined,
      'POST',
    );
    setBusy(false);
    if (result !== undefined) {
      toast({
        tone: 'ok',
        title:
          row.kind === 'category'
            ? `Archiving off for the ${row.name} category — history kept`
            : `Archiving off for #${row.name} — history kept`,
      });
      reloadAll();
    }
  };

  const archiveResume = async (row: ScopeRow) => {
    setBusy(true);
    const result = await session.write<{ outcome: string }>(
      `/api/archive/${row.kind === 'category' ? 'categories' : 'channels'}/${encodeURIComponent(row.id)}/resume`,
      undefined,
      'POST',
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

  const readAllow = async (row: ScopeRow) => {
    setBusy(true);
    const result = await session.write<{ outcome: string }>(
      row.kind === 'category' ? '/api/read-scope/categories' : '/api/read-scope',
      { channelId: row.id },
    );
    setBusy(false);
    if (result !== undefined) {
      toast({
        tone: 'ok',
        title:
          row.kind === 'category'
            ? `The bot may read anywhere under ${row.name}`
            : `The bot may read #${row.name}`,
      });
      reloadAll();
    }
  };

  const readDisallow = async (row: ScopeRow) => {
    setBusy(true);
    const result = await session.write<{ ok: boolean }>(
      `/api/read-scope/${row.kind === 'category' ? 'categories/' : ''}${encodeURIComponent(row.id)}`,
      undefined,
      'DELETE',
    );
    setBusy(false);
    if (result !== undefined) {
      toast({
        tone: 'ok',
        title:
          row.kind === 'category'
            ? 'Category removed from the read scope'
            : `#${row.name} removed from the read scope`,
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
        purpose="Choose what Bananasaurs may do in each channel or category. Read, Write and Archive are separate switches; No access overrides all three."
      />
      <Card title="What each switch means">
        <dl className="grid gap-2 text-sm">
          <div>
            <dt className="font-medium">Read</dt>
            <dd>
              May look up recent messages live from Discord. Off: the bot only sees the message that
              tagged it, the one it replies to, and the archive.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Write</dt>
            <dd>May post here, including answering when tagged. Off: the bot stays silent here.</dd>
          </div>
          <div>
            <dt className="font-medium">Archive</dt>
            <dd>
              Records new messages into a searchable copy. Turning it off stops recording; nothing
              is deleted. Delete archived messages on the Archive page.
            </dd>
          </div>
          <div>
            <dt className="font-medium">No access</dt>
            <dd>
              Overrides everything above and hides archived copies. Moderation and automod still
              work.
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-sm text-ink-muted">
          To switch one channel off inside a category that is on, turn the category off and turn on
          the channels you want, or mark the channel No access.
        </p>
      </Card>
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
              rows={(rows ?? []).filter(
                (row) =>
                  row.depth === 0 ||
                  [...expanded].some((categoryId) =>
                    data.channels.some(
                      (channel) => channel.channelId === row.id && channel.parentId === categoryId,
                    ),
                  ),
              )}
              rowKey={(row) => row.id}
              columns={[
                {
                  key: 'name',
                  header: 'Channel',
                  cell: (row) => (
                    <span className={row.depth === 1 ? 'pl-4' : 'font-medium'}>
                      {row.kind === 'category' ? (
                        <button
                          type="button"
                          className="font-medium"
                          aria-expanded={expanded.has(row.id)}
                          onClick={() =>
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (next.has(row.id)) next.delete(row.id);
                              else next.add(row.id);
                              return next;
                            })
                          }
                        >
                          {expanded.has(row.id) ? '▾ ' : '▸ '}
                          {row.name}
                        </button>
                      ) : (
                        `#${row.name}`
                      )}
                      {row.channelKind === 'announcement' && (
                        <span className="text-ink-muted"> (announcement)</span>
                      )}
                    </span>
                  ),
                },
                {
                  key: 'read',
                  header: 'Read',
                  cell: (row) =>
                    row.read === 'excluded' ? (
                      <Badge tone="hold">No access</Badge>
                    ) : row.read === 'on' ? (
                      <Badge tone="ok">On</Badge>
                    ) : row.read === 'via-category' ? (
                      <Badge tone="ok">On, via {row.readVia}</Badge>
                    ) : (
                      <Badge>Off</Badge>
                    ),
                },
                {
                  key: 'send',
                  header: 'Write',
                  cell: (row) =>
                    row.send === 'excluded' ? (
                      <Badge tone="hold">No access</Badge>
                    ) : row.send === 'on' ? (
                      <Badge tone="ok">On</Badge>
                    ) : row.send === 'via-category' ? (
                      <Badge tone="ok">On, via {row.sendVia}</Badge>
                    ) : (
                      <Badge>Off</Badge>
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
                    ) : row.archive === 'paused' ? (
                      <Badge>Off (history kept)</Badge>
                    ) : row.archive === 'paused-via-category' ? (
                      <Badge>Off (history kept), via {row.archiveVia}</Badge>
                    ) : row.archive === 'excluded' ? (
                      <Badge tone="hold">No access</Badge>
                    ) : (
                      <Badge>Off</Badge>
                    ),
                },
                {
                  key: 'noaccess',
                  header: 'No access',
                  cell: (row) => (row.excluded ? <Badge tone="hold">No access</Badge> : null),
                },
                {
                  key: 'actions',
                  header: 'Change',
                  cell: (row) => (
                    <span className="flex flex-wrap gap-1">
                      {row.read === 'off' && (
                        <Button busy={busy} onClick={() => void readAllow(row)}>
                          Allow read
                        </Button>
                      )}
                      {row.read === 'on' && (
                        <Button busy={busy} onClick={() => void readDisallow(row)}>
                          Stop read
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
                      {row.archive === 'off' && (
                        <Button busy={busy} onClick={() => void archiveEnable(row)}>
                          {row.kind === 'category' ? 'Archive category' : 'Archive'}
                        </Button>
                      )}
                      {row.archive === 'on' && (
                        <Button busy={busy} onClick={() => void archivePause(row)}>
                          Stop archiving
                        </Button>
                      )}
                      {row.archive === 'paused' && (
                        <Button busy={busy} onClick={() => void archiveResume(row)}>
                          Resume archiving
                        </Button>
                      )}
                      {row.kind === 'channel' && data.excluded !== undefined && (
                        <Button busy={busy} onClick={() => void toggleExclusion(row)}>
                          {row.excluded ? 'Restore access' : 'No access'}
                        </Button>
                      )}
                    </span>
                  ),
                },
              ]}
            />
            {data.excluded === undefined && (
              <p className="mt-2 text-sm text-ink-muted">
                This account cannot see or change channel access overrides (that needs the logging
                capability); the No access state is shown without its controls.
              </p>
            )}
          </Card>
        )}
      </DataState>

      <Card title="Not controlled here">
        <p className="text-sm">
          The assistant log channel, the escalation channel, panels and logging forwards post to the
          channels you picked for them. Moderation, automod and purge work in every channel.
        </p>
      </Card>

      <Card title="Assistant permissions">
        <p className="text-sm">
          Who may tag the assistant and which skills each role/member may use are permission-bearing
          controls. Manage them on the Assistant page, where the live role and member directories
          prevent raw-ID mistakes.
        </p>
        <Link href="/assistant" className="mt-2 inline-block text-sm text-accent underline">
          Open assistant access and skill grants
        </Link>
      </Card>

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
            — browse archived messages, run backfills, set retention, and delete archived messages.
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
    </>
  );
}
