import { useCallback, useMemo, useState } from 'react';
import type {
  ArchiveAttachmentPolicy,
  ArchiveStatus,
  GuildChannelInfo,
  ReadScopeEntry,
  SendAllowlistEntry,
} from '../../api/ops.js';
import { useSession } from '../../app/session.js';
import { useResource } from '../../hooks/useResource.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { DataState } from '../../ui/DataState.js';
import { DataTable } from '../../ui/DataTable.js';
import { ScopeHelp, ScopeHeader } from './scope-help.js';
import { RadioGroup } from '../../ui/RadioGroup.js';
import { DropdownMenu } from '../../ui/DropdownMenu.js';
import { buildRows, type ScopeRow } from './rows.js';
import { useToast } from '../../ui/Toast.js';

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
 *   Turning it off pauses recording; nothing is deleted here - deleting
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
 * pages - the assistant's access and skill grants on Assistant, browsing and
 * backfill on Archive, log routing on Logging, dashboard access on Accounts -
 * and are linked below rather than duplicated here.
 */

export function Channels() {
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
            ? `Archiving off for the ${row.name} category - history kept`
            : `Archiving off for #${row.name} - history kept`,
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
      <ScopeHelp />
      <DataState
        resource={scope.resource}
        isEmpty={(data) => data.channels.length === 0}
        empty={
          <Card title="No channels yet">
            <p className="text-body text-ink-muted">
              The bot cannot see any channels in this server. Check its Discord permissions, then
              reload.
            </p>
          </Card>
        }
      >
        {(data) => (
          <Card title="Operating scope">
            <RadioGroup
              legend="Attachment policy"
              name="permissions-attachment-policy"
              value={policy}
              onChange={(value) => setPolicy(value === 'bytes' ? 'bytes' : 'none')}
              options={[
                { value: 'none', label: 'text only' },
                { value: 'bytes', label: 'text + attachment bytes' },
              ]}
              orientation="horizontal"
            />
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
                        <Button
                          variant="subtle"
                          size="sm"
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
                        </Button>
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
                  header: <ScopeHeader name="Read" />,
                  mobileLabel: 'Read',
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
                  header: <ScopeHeader name="Write" />,
                  mobileLabel: 'Write',
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
                  header: <ScopeHeader name="Archive" />,
                  mobileLabel: 'Archive',
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
                ...(data.excluded === undefined
                  ? []
                  : [
                      {
                        key: 'noaccess',
                        header: <ScopeHeader name="No access" />,
                        mobileLabel: 'No access',
                        cell: (row: ScopeRow) =>
                          row.excluded ? <Badge tone="hold">No access</Badge> : null,
                      },
                    ]),
                {
                  key: 'actions',
                  header: 'Change',
                  cell: (row) => {
                    const items = [
                      ...(row.read === 'off'
                        ? [
                            {
                              label: 'Allow read',
                              onSelect: () => void readAllow(row),
                              disabled: busy,
                            },
                          ]
                        : []),
                      ...(row.read === 'on'
                        ? [
                            {
                              label: 'Stop read',
                              onSelect: () => void readDisallow(row),
                              disabled: busy,
                            },
                          ]
                        : []),
                      ...(row.send === 'off'
                        ? [
                            {
                              label: 'Allow send',
                              onSelect: () => void sendAllow(row),
                              disabled: busy,
                            },
                          ]
                        : []),
                      ...(row.send === 'on'
                        ? [
                            {
                              label: 'Stop send',
                              onSelect: () => void sendDisallow(row),
                              disabled: busy,
                            },
                          ]
                        : []),
                      ...(row.archive === 'off'
                        ? [
                            {
                              label: row.kind === 'category' ? 'Archive category' : 'Archive',
                              onSelect: () => void archiveEnable(row),
                              disabled: busy,
                            },
                          ]
                        : []),
                      ...(row.archive === 'on'
                        ? [
                            {
                              label: 'Stop archiving',
                              onSelect: () => void archivePause(row),
                              disabled: busy,
                            },
                          ]
                        : []),
                      ...(row.archive === 'paused'
                        ? [
                            {
                              label: 'Resume archiving',
                              onSelect: () => void archiveResume(row),
                              disabled: busy,
                            },
                          ]
                        : []),
                      ...(row.kind === 'channel' && data.excluded !== undefined
                        ? [
                            {
                              label: row.excluded ? 'Restore access' : 'No access',
                              onSelect: () => void toggleExclusion(row),
                              disabled: busy,
                            },
                          ]
                        : []),
                    ];
                    return items.length === 0 ? null : (
                      <DropdownMenu
                        label={`Change ${row.kind === 'channel' ? '#' : ''}${row.name}`}
                        items={items}
                      />
                    );
                  },
                },
              ]}
            />
            {data.excluded === undefined && (
              <p className="mt-2 text-body text-ink-muted">
                This account cannot see or change channel access overrides (that needs the logging
                capability). The other switches remain available; No access overrides are unknown.
              </p>
            )}
          </Card>
        )}
      </DataState>

      <Card title="Not controlled here">
        <p className="text-body">
          The assistant log channel, the escalation channel, panels and logging forwards post to the
          channels you picked for them. Moderation, automod and purge work in every channel.
        </p>
      </Card>
    </>
  );
}
