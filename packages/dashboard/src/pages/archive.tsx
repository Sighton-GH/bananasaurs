import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearch } from 'wouter';
import { ApiError } from '../api.js';
import type {
  ArchiveAttachmentPolicy,
  ArchiveCategoryEnableOutcome,
  ArchiveChannelStatus,
  ArchiveMessage,
  ArchiveDisableOutcome,
  ArchiveEnableOutcome,
  ArchiveLinkCaseOutcome,
  ArchivePreserveOutcome,
  ArchiveStatus,
  ArchiveThreadsValue,
  Enqueued,
} from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { ChannelPicker } from '../ui/ChannelPicker.js';
import { Field, Input } from '../ui/Field.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

const backfillTone = (state: ArchiveChannelStatus['backfillState']): 'ok' | 'neutral' =>
  state === 'done' ? 'ok' : 'neutral';

const LINK_CASE_TEXT: Record<ArchiveLinkCaseOutcome, string> = {
  linked: 'Message linked to the case',
  'already-linked': 'That message was already linked to a case',
  preserved: 'Message preserved as part of the case',
  'case-closed': 'That case is closed — reopen it or choose another',
};

/**
 * `/archive`: the archive controls as a page (ADR 0051 D7) — exactly what
 * `archive status`, `enable-channel`, `disable-channel`, `preserve`,
 * `link-case`, `reindex` and the backfill enqueue do today, no more. The
 * three vetoes of ADR 0046 (guild allowlist, per-channel enable,
 * log-exclusion) stay server-side; disabling a channel destroys its archived
 * messages, so that confirmation names the count.
 */
export function ArchivePage() {
  const session = useSession();
  const toast = useToast();
  const load = useCallback(() => session.read<ArchiveStatus>('/api/archive/status'), [session]);
  const status = useResource('the archive status', load);

  const [channelId, setChannelId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [categoryError, setCategoryError] = useState<string | undefined>(undefined);
  const [policy, setPolicy] = useState<ArchiveAttachmentPolicy>('none');
  const [enableError, setEnableError] = useState<string | undefined>(undefined);
  const [disabling, setDisabling] = useState<ArchiveChannelStatus | undefined>(undefined);
  const [preserveId, setPreserveId] = useState('');
  const [linkMessageId, setLinkMessageId] = useState('');
  const [linkCaseId, setLinkCaseId] = useState('');
  const [linkError, setLinkError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // Browse: the channel being read, the `before` cursor for its current
  // page, and the trail of cursors so "newer" can walk back. The detail
  // panel is a separate read, the way `archive get-message` answers one id.
  const [browseId, setBrowseId] = useState<string | undefined>(undefined);
  const [before, setBefore] = useState<string | undefined>(undefined);
  const [trail, setTrail] = useState<readonly (string | undefined)[]>([]);
  const [detail, setDetail] = useState<ArchiveMessage | undefined>(undefined);
  const detailRef = useRef<HTMLDivElement | null>(null);
  // A long first page pushes the detail below the fold; when one opens
  // (deep link or Open button), bring it into view.
  useEffect(() => {
    // jsdom has no scrollIntoView; optional-call keeps the tests honest.
    detailRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [detail]);
  const loadBrowse = useCallback(
    () =>
      browseId === undefined
        ? Promise.resolve({ messages: [] as readonly ArchiveMessage[] })
        : session.read<{ messages: readonly ArchiveMessage[] }>(
            `/api/archive/channels/${encodeURIComponent(browseId)}/messages?limit=25${before === undefined ? '' : `&before=${encodeURIComponent(before)}`}`,
          ),
    [session, browseId, before],
  );
  const browse = useResource('the archived messages', loadBrowse);

  const openBrowse = (channelId: string) => {
    setBrowseId(channelId);
    setBefore(undefined);
    setTrail([]);
    setDetail(undefined);
  };

  const openMessage = async (messageId: string) => {
    try {
      setDetail(
        await session.read<ArchiveMessage>(
          `/api/archive/messages/${encodeURIComponent(messageId)}`,
        ),
      );
    } catch {
      toast({ tone: 'danger', title: 'That message could not be loaded' });
    }
  };

  // A search hit links here as `/archive?browse=<channelId>&message=<id>`:
  // open that channel's history and the message itself, once, on arrival.
  const urlSearch = useSearch();
  const appliedDeepLink = useRef(false);
  useEffect(() => {
    if (appliedDeepLink.current) return;
    appliedDeepLink.current = true;
    const params = new URLSearchParams(urlSearch);
    const channel = params.get('browse');
    const message = params.get('message');
    if (channel !== null) openBrowse(channel);
    if (message !== null) void openMessage(message);
    // Mount-only: later browse state is the operator's, not the URL's.
  }, [urlSearch]);

  const enable = async (e: React.FormEvent) => {
    e.preventDefault();
    setEnableError(undefined);
    setBusy(true);
    try {
      const result = await session.writeOrThrow<{ outcome: ArchiveEnableOutcome }>(
        '/api/archive/channels',
        { channelId: channelId.trim(), attachmentPolicy: policy },
      );
      if (result === undefined) return;
      toast({
        tone: 'ok',
        title:
          result.outcome === 'already-enabled'
            ? 'That channel was already archiving'
            : 'Channel archiving enabled',
      });
      setChannelId('');
      status.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setEnableError(
          'This guild is not archive-enabled. The server-side allowlist decides that — the UI cannot widen it.',
        );
      } else {
        throw err;
      }
    } finally {
      setBusy(false);
    }
  };

  const enableCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setCategoryError(undefined);
    setBusy(true);
    try {
      const result = await session.writeOrThrow<{
        outcome: ArchiveCategoryEnableOutcome;
        coverage: { channels: number; messages: number };
      }>('/api/archive/categories', { channelId: categoryId.trim() });
      if (result === undefined) return;
      toast({
        tone: 'ok',
        title:
          result.outcome === 'already-enabled'
            ? 'That category was already archiving'
            : `Category archiving enabled — covers ${String(result.coverage.channels)} channels`,
      });
      setCategoryId('');
      status.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setCategoryError(
          'This guild is not archive-enabled. The server-side allowlist decides that — the UI cannot widen it.',
        );
      } else {
        throw err;
      }
    } finally {
      setBusy(false);
    }
  };

  const setThreads = async (channel: ArchiveChannelStatus, value: ArchiveThreadsValue) => {
    const result = await session.write<{ outcome: 'updated' }>(
      `/api/archive/channels/${encodeURIComponent(channel.channelId)}/threads`,
      { value },
    );
    if (result !== undefined) {
      toast({
        tone: 'ok',
        title:
          value === 'all'
            ? `Threads under ${channel.channelId} will be archived`
            : `Threads under ${channel.channelId} are no longer archived`,
      });
      status.reload();
    }
  };

  const disable = async () => {
    if (disabling === undefined) return;
    setBusy(true);
    try {
      const base =
        (disabling.scopeKind ?? 'channel') === 'category'
          ? '/api/archive/categories'
          : '/api/archive/channels';
      const result = await session.write<ArchiveDisableOutcome>(
        `${base}/${encodeURIComponent(disabling.channelId)}`,
        undefined,
        'DELETE',
      );
      if (result !== undefined) {
        toast({
          tone: result.outcome === 'disabled' ? 'danger' : 'neutral',
          title:
            result.outcome === 'disabled'
              ? `Archiving disabled — ${String(result.messageCount)} archived messages destroyed`
              : 'That channel was not archiving',
        });
        status.reload();
      }
    } finally {
      setBusy(false);
      setDisabling(undefined);
    }
  };

  const backfill = async (channel: ArchiveChannelStatus) => {
    const result = await session.write<Enqueued>(
      `/api/archive/channels/${encodeURIComponent(channel.channelId)}/backfill`,
      {},
    );
    if (result !== undefined) {
      toast({ tone: 'ok', title: `Backfill enqueued for ${channel.channelId}` });
      status.reload();
    }
  };

  const reindex = async () => {
    const result = await session.write<{ indexed: number }>('/api/archive/reindex', {});
    if (result !== undefined) {
      toast({ tone: 'ok', title: `Index rebuilt — ${String(result.indexed)} rows indexed` });
      status.reload();
    }
  };

  const preserve = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    // A 404 `not-found` is the session's toast contract, like every other write.
    const result = await session.write<{ outcome: ArchivePreserveOutcome }>(
      `/api/archive/messages/${encodeURIComponent(preserveId.trim())}/preserve`,
      {},
    );
    setBusy(false);
    if (result !== undefined) {
      toast({
        tone: 'ok',
        title:
          result.outcome === 'already-preserved'
            ? 'That message was already preserved'
            : 'Message preserved — retention will not delete it',
      });
      setPreserveId('');
    }
  };

  const linkCase = async (e: React.FormEvent) => {
    e.preventDefault();
    setLinkError(undefined);
    // A 404 `not-found` (no such message or case) is the session's toast
    // contract; only the 200-carried `case-closed` renders inline.
    setBusy(true);
    try {
      const result = await session.writeOrThrow<{ outcome: ArchiveLinkCaseOutcome }>(
        '/api/archive/link-case',
        { messageId: linkMessageId.trim(), caseId: linkCaseId.trim() },
      );
      if (result === undefined) return;
      if (result.outcome === 'case-closed') {
        setLinkError(LINK_CASE_TEXT['case-closed']);
      } else {
        toast({ tone: 'ok', title: LINK_CASE_TEXT[result.outcome] });
        setLinkMessageId('');
        setLinkCaseId('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Archive"
        purpose="The channels being archived, the search index over them, and the retention and case tools that act on what is stored."
      />
      <div className="grid max-w-6xl gap-3">
        <Card title="Search index">
          <DataState resource={status.resource}>
            {(data) => (
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm">
                  {String(data.index.indexed)} of {String(data.index.rows)} archived messages
                  indexed{' '}
                  {data.index.indexed < data.index.rows && (
                    <Badge tone="hold">behind — reindex to catch up</Badge>
                  )}
                </p>
                <Button onClick={() => void reindex()}>Reindex</Button>
              </div>
            )}
          </DataState>
        </Card>
        <Card title="Archived channels">
          <DataState
            resource={status.resource}
            isEmpty={(data) => data.channels.length === 0}
            empty={
              <p className="text-sm text-ink-muted">
                No channels archiving yet. Enable one below — nothing is archived until you do.
              </p>
            }
          >
            {(data) => (
              <DataTable
                caption="Archive-enabled channels"
                rows={data.channels}
                rowKey={(c) => c.channelId}
                columns={[
                  {
                    key: 'channel',
                    header: 'Channel',
                    cell: (c) => <span className="whitespace-nowrap">{c.channelId}</span>,
                  },
                  {
                    key: 'scope',
                    header: 'Scope',
                    cell: (c) =>
                      (c.scopeKind ?? 'channel') === 'category' ? (
                        <Badge tone="neutral">category</Badge>
                      ) : c.scopeKind === 'derived' ? (
                        <span className="text-xs text-ink-muted">
                          via category {c.derivedFrom ?? ''}
                        </span>
                      ) : (
                        'channel'
                      ),
                  },
                  {
                    key: 'threads',
                    header: 'Threads',
                    cell: (c) =>
                      c.threadsDone === undefined
                        ? '—'
                        : `${String(c.threadsDone)}/${c.threadsFound === undefined ? '?' : String(c.threadsFound)}`,
                  },
                  {
                    key: 'policy',
                    header: 'Attachments',
                    cell: (c) => (c.attachmentPolicy === 'bytes' ? 'bytes kept' : 'none'),
                  },
                  {
                    key: 'enabledAt',
                    header: 'Enabled',
                    cell: (c) => (
                      <span className="whitespace-nowrap">
                        {new Date(c.enabledAt).toLocaleDateString()}
                      </span>
                    ),
                  },
                  {
                    key: 'backfill',
                    header: 'Backfill',
                    cell: (c) => (
                      <Badge tone={backfillTone(c.backfillState)}>{c.backfillState}</Badge>
                    ),
                  },
                  {
                    key: 'messages',
                    header: 'Messages',
                    cell: (c) => c.messageCount,
                    numeric: true,
                  },
                  {
                    key: 'actions',
                    header: '',
                    cell: (c) =>
                      // A derived row is coverage materialised under a
                      // category: nothing here is the operator's to chase, so
                      // the actions stay on the rows they own.
                      c.scopeKind === 'derived' ? (
                        <span className="text-xs text-ink-muted">managed by its category</span>
                      ) : (
                        <span className="flex gap-1">
                          <Button onClick={() => openBrowse(c.channelId)}>Browse</Button>
                          {(c.scopeKind ?? 'channel') === 'channel' && (
                            <Button
                              onClick={() =>
                                void setThreads(c, (c.includeThreads ?? true) ? 'none' : 'all')
                              }
                            >
                              {(c.includeThreads ?? true) ? 'Exclude threads' : 'Include threads'}
                            </Button>
                          )}
                          <Button onClick={() => void backfill(c)}>Backfill</Button>
                          <Button variant="danger" onClick={() => setDisabling(c)}>
                            Disable
                          </Button>
                        </span>
                      ),
                  },
                ]}
              />
            )}
          </DataState>
          <form onSubmit={(e) => void enable(e)} className="mt-3 grid max-w-md gap-3">
            <ChannelPicker
              label="Enable archiving for a channel"
              {...(enableError !== undefined ? { error: enableError } : {})}
              value={channelId}
              onChange={setChannelId}
            />
            <Field
              label="Attachment policy"
              hint="'none' keeps text only; 'bytes' stores attachment bytes."
            >
              <select
                aria-label="Attachment policy"
                value={policy}
                onChange={(e) => setPolicy(e.target.value as ArchiveAttachmentPolicy)}
                className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
              >
                <option value="none">none</option>
                <option value="bytes">bytes</option>
              </select>
            </Field>
            <div>
              <Button
                type="submit"
                variant="primary"
                busy={busy}
                disabled={channelId.trim() === ''}
              >
                Enable archiving
              </Button>
            </div>
          </form>
          <form
            onSubmit={(e) => void enableCategory(e)}
            className="mt-3 grid max-w-md gap-3 border-t border-line pt-3"
          >
            <ChannelPicker
              label="Enable archiving for a category"
              hint="Every channel under the category is archived, including channels added to it later."
              {...(categoryError !== undefined ? { error: categoryError } : {})}
              value={categoryId}
              onChange={setCategoryId}
              kinds={['category']}
            />
            <div>
              <Button
                type="submit"
                variant="primary"
                busy={busy}
                disabled={categoryId.trim() === ''}
              >
                Enable category
              </Button>
            </div>
          </form>
        </Card>
        {browseId !== undefined && (
          <Card title={`Browsing ${browseId}`}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm text-ink-muted">
                Newest first, 25 at a time. A purged message keeps its metadata; its text is
                gone for good.
              </p>
              <Button onClick={() => setBrowseId(undefined)}>Close</Button>
            </div>
            <DataState
              resource={browse.resource}
              isEmpty={(data) => data.messages.length === 0}
              empty={
                <p className="text-sm text-ink-muted">
                  No archived messages here yet — a backfill fills the history over time.
                </p>
              }
            >
              {(data) => (
                <>
                  <DataTable
                    caption={`Archived messages in ${browseId}`}
                    rows={data.messages}
                    rowKey={(m) => m.messageId}
                    columns={[
                      {
                        key: 'created',
                        header: 'Posted',
                        cell: (m) => (
                          <span className="whitespace-nowrap">
                            {new Date(m.createdAt).toLocaleString()}
                          </span>
                        ),
                      },
                      {
                        key: 'author',
                        header: 'Author',
                        cell: (m) => m.authorId ?? 'unknown',
                      },
                      {
                        key: 'content',
                        header: 'Message',
                        cell: (m) => (
                          <span>
                            {m.content === null ? (
                              <span className="italic text-ink-muted">content purged</span>
                            ) : m.content.length > 120 ? (
                              `${m.content.slice(0, 120)}…`
                            ) : (
                              m.content
                            )}
                            {m.deletedAt !== undefined && (
                              <>
                                {' '}
                                <Badge tone="hold">deleted from Discord</Badge>
                              </>
                            )}
                          </span>
                        ),
                      },
                      {
                        key: 'actions',
                        header: '',
                        cell: (m) => <Button onClick={() => void openMessage(m.messageId)}>Open</Button>,
                      },
                    ]}
                  />
                  {(data.messages.length === 25 || trail.length > 0) && (
                    <div className="mt-3 flex gap-2">
                      <Button
                        disabled={trail.length === 0}
                        onClick={() => {
                          const previous = trail[trail.length - 1];
                          setTrail((t) => t.slice(0, -1));
                          setBefore(previous);
                        }}
                      >
                        Newer
                      </Button>
                      <Button
                        disabled={data.messages.length < 25}
                        onClick={() => {
                          const oldest = data.messages[data.messages.length - 1];
                          if (oldest === undefined) return;
                          setTrail((t) => [...t, before]);
                          setBefore(oldest.messageId);
                        }}
                      >
                        Older
                      </Button>
                    </div>
                  )}
                </>
              )}
            </DataState>
            {detail !== undefined && (
              <div
                ref={detailRef}
                role="region"
                aria-label={`Archived message ${detail.messageId}`}
                className="mt-3 grid gap-1 rounded-sm border border-line bg-canvas p-3 text-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">Message {detail.messageId}</span>
                  <Button onClick={() => setDetail(undefined)}>Close</Button>
                </div>
                <p className="text-ink-muted">
                  {detail.authorId ?? 'unknown author'} · posted{' '}
                  {new Date(detail.createdAt).toLocaleString()}
                  {detail.editedAt !== undefined &&
                    ` · edited ${new Date(detail.editedAt).toLocaleString()}`}
                  {detail.deletedAt !== undefined &&
                    ` · deleted from Discord ${new Date(detail.deletedAt).toLocaleString()}`}
                </p>
                {detail.content === null ? (
                  <p className="italic text-ink-muted">
                    Content purged by retention — the metadata above is all that remains.
                  </p>
                ) : (
                  <p className="whitespace-pre-wrap">{detail.content}</p>
                )}
              </div>
            )}
          </Card>
        )}
        <Card title="Message tools">
          <div className="grid gap-4 sm:grid-cols-2">
            <form onSubmit={(e) => void preserve(e)} className="grid content-start gap-3">
              <Field
                label="Preserve a message"
                hint="Retention will not delete a preserved message."
              >
                <Input
                  value={preserveId}
                  onChange={(e) => setPreserveId(e.target.value)}
                  placeholder="Message ID"
                />
              </Field>
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  busy={busy}
                  disabled={preserveId.trim() === ''}
                >
                  Preserve
                </Button>
              </div>
            </form>
            <form onSubmit={(e) => void linkCase(e)} className="grid content-start gap-3">
              <Field label="Message ID">
                <Input value={linkMessageId} onChange={(e) => setLinkMessageId(e.target.value)} />
              </Field>
              <Field
                label="Link to case"
                {...(linkError !== undefined ? { error: linkError } : {})}
              >
                <Input value={linkCaseId} onChange={(e) => setLinkCaseId(e.target.value)} />
              </Field>
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  busy={busy}
                  disabled={linkMessageId.trim() === '' || linkCaseId.trim() === ''}
                >
                  Link to case
                </Button>
              </div>
            </form>
          </div>
        </Card>
      </div>
      <ConfirmDialog
        open={disabling !== undefined}
        title={`Disable archiving for ${(disabling?.scopeKind ?? 'channel') === 'category' ? 'category' : 'channel'} ${disabling?.channelId ?? ''}?`}
        scope={
          <p>
            Stops archiving the {(disabling?.scopeKind ?? 'channel') === 'category' ? 'category and the channels it covers' : 'channel'} AND
            destroys its {String(disabling?.messageCount ?? 0)} archived messages, edits and
            attachments. The audit row is the only record that the destruction happened.
          </p>
        }
        confirmLabel="Disable and destroy"
        danger
        busy={busy}
        onConfirm={() => void disable()}
        onCancel={() => setDisabling(undefined)}
      />
    </>
  );
}
