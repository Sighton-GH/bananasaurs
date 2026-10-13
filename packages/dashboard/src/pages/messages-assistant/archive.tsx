import { ApiError } from '../../api.js';
import { Empty, Loading, NotFound, Unavailable } from '../../ui/states.js';
import { DropdownMenu } from '../../ui/DropdownMenu.js';
import { FormSection } from '../../ui/FormSection.js';
import { GroupErrors } from './field-summary.js';
import { useFieldErrors } from '../../hooks/useFieldErrors.js';
import { ErrorNotice } from '../../ui/ErrorNotice.js';
import { Moment } from './time.js';
import { useSections, KeptSection } from './section-tabs.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearch } from 'wouter';
import { Link } from '../../ui/Link.js';
import type {
  ArchiveChannelStatus,
  ArchiveMessage,
  ArchiveLinkCaseOutcome,
  ArchivePreserveOutcome,
  ArchiveStatus,
  ArchiveThreadsValue,
  Enqueued,
} from '../../api/ops.js';
import { useSession } from '../../app/session.js';
import { useResource } from '../../hooks/useResource.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { DataState } from '../../ui/DataState.js';
import { DataTable } from '../../ui/DataTable.js';
import { Field, Input } from '../../ui/Field.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { useToast } from '../../ui/Toast.js';

const backfillTone = (state: ArchiveChannelStatus['backfillState']): 'ok' | 'neutral' =>
  state === 'done' ? 'ok' : 'neutral';

const LINK_CASE_TEXT: Record<ArchiveLinkCaseOutcome, string> = {
  linked: 'Message linked to the case',
  'already-linked': 'That message was already linked to a case',
  preserved: 'Message preserved as part of the case',
  'case-closed': 'That case is closed — reopen it or choose another',
};

/**
 * `/archive`: the archive's specialised controls as a page (ADR 0051 D7) —
 * browse, backfill, per-channel thread inclusion, `preserve`, `link-case`
 * and `reindex`, no more. The three vetoes of ADR 0046 (guild allowlist,
 * per-channel enable, log-exclusion) stay server-side.
 *
 * Which channels and categories archive at all is owned by the central
 * Permissions section (Bryan's lane): one page makes every operating-scope
 * change, so no second surface can quietly conflict with it. This page
 * links there instead of duplicating enable/disable.
 */
export function ArchivePage() {
  const session = useSession();
  const toast = useToast();
  const sections = useSections([
    { value: 'all', label: 'All sections' },
    { value: 'channels', label: 'Channels and browse' },
    { value: 'tools', label: 'Message tools' },
  ]);
  const load = useCallback(() => session.read<ArchiveStatus>('/api/archive/status'), [session]);
  const status = useResource('the archive status', load);

  const [channelFilter, setChannelFilter] = useState('');
  const preserveFields = useFieldErrors();
  const linkFields = useFieldErrors();
  const [preserveError, setPreserveError] = useState<unknown>();
  const [linkFailure, setLinkFailure] = useState<unknown>();
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
  const [detailError, setDetailError] = useState<unknown>();
  const [detailBusy, setDetailBusy] = useState(false);
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
    setDetailError(undefined);
  };

  // A sequence token per request: two rapid opens (or the mount deep-link
  // racing a click) resolve out of order, and the slower older response
  // must never overwrite the message the operator asked for last.
  const openSeq = useRef(0);
  const openMessage = async (messageId: string) => {
    const seq = (openSeq.current += 1);
    setDetail(undefined);
    setDetailError(undefined);
    setDetailBusy(true);
    try {
      const message = await session.read<ArchiveMessage>(
        `/api/archive/messages/${encodeURIComponent(messageId)}`,
      );
      if (seq === openSeq.current) setDetail(message);
    } catch (err) {
      if (seq === openSeq.current) setDetailError(err);
    } finally {
      if (seq === openSeq.current) setDetailBusy(false);
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

  const backfill = async (channel: ArchiveChannelStatus) => {
    const result = await session.write<Enqueued>(
      `/api/archive/channels/${encodeURIComponent(channel.channelId)}/backfill`,
      {},
    );
    if (result !== undefined) {
      toast({ tone: 'ok', title: `Saving older messages started for ${channel.channelId}` });
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
    preserveFields.clear();
    setPreserveError(undefined);
    try {
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
    } catch (err) {
      preserveFields.capture(err);
      setPreserveError(err);
    } finally {
      setBusy(false);
    }
  };

  const linkCase = async (e: React.FormEvent) => {
    e.preventDefault();
    setLinkError(undefined);
    linkFields.clear();
    setLinkFailure(undefined);
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
    } catch (err) {
      linkFields.capture(err);
      setLinkFailure(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Archive"
        purpose="Archive means Bananasaurs collects and keeps a searchable copy of messages. It is separate from READ, which only lets the bot see current content. Choose what to save, browse saved messages, manage deletion, or repair search."
      />
      {sections.render(
        <div className="grid max-w-6xl gap-3">
          <KeptSection hidden={sections.value === 'tools'}>
            <Card title="Search index">
              <DataState resource={status.resource}>
                {(data) => (
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-sm">
                      {String(data.index.indexed)} of {String(data.index.rows)} archived messages
                      indexed{' '}
                      {data.index.indexed < data.index.rows && (
                        <Badge wrap tone="hold">
                          behind — reindex to catch up
                        </Badge>
                      )}
                    </p>
                    <Button onClick={() => void reindex()}>Update search results</Button>
                  </div>
                )}
              </DataState>
            </Card>
            <Card title="Archived channels">
              <DataState
                resource={status.resource}
                isEmpty={(data) => data.channels.length === 0}
                empty={
                  <Empty
                    title="No channels archiving yet"
                    detail="Enable channels in Permissions. Nothing is archived until you do."
                    action={<Link href="/permissions">Open Permissions</Link>}
                  />
                }
              >
                {(data) => (
                  <>
                    {data.channels.length > 20 && (
                      <Field label="Filter loaded archive channels">
                        <Input
                          value={channelFilter}
                          onChange={(e) => setChannelFilter(e.target.value)}
                        />
                      </Field>
                    )}
                    {channelFilter !== '' &&
                      data.channels.some((c) =>
                        c.channelId.toLowerCase().includes(channelFilter.toLowerCase()),
                      ) && <Button onClick={() => setChannelFilter('')}>Clear filters</Button>}
                    {data.channels.filter((c) =>
                      c.channelId.toLowerCase().includes(channelFilter.toLowerCase()),
                    ).length === 0 && (
                      <Empty
                        title="No loaded archive channels match"
                        action={<Button onClick={() => setChannelFilter('')}>Clear filters</Button>}
                      />
                    )}
                    <DataTable
                      caption="Archive-enabled channels"
                      rows={data.channels.filter((c) =>
                        c.channelId.toLowerCase().includes(channelFilter.toLowerCase()),
                      )}
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
                            <span className="whitespace-nowrap">{<Moment at={c.enabledAt} />}</span>
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
                              <span className="text-xs text-ink-muted">
                                managed by its category
                              </span>
                            ) : (
                              <DropdownMenu
                                label={`Actions for ${c.channelId}`}
                                items={[
                                  { label: 'Browse', onSelect: () => openBrowse(c.channelId) },
                                  ...((c.scopeKind ?? 'channel') === 'channel'
                                    ? [
                                        {
                                          label:
                                            (c.includeThreads ?? true)
                                              ? 'Do not archive threads'
                                              : 'Include threads',
                                          onSelect: () =>
                                            void setThreads(
                                              c,
                                              (c.includeThreads ?? true) ? 'none' : 'all',
                                            ),
                                        },
                                      ]
                                    : []),
                                  {
                                    label: 'Save older messages now',
                                    onSelect: () => void backfill(c),
                                  },
                                ]}
                              />
                            ),
                        },
                      ]}
                    />
                  </>
                )}
              </DataState>
              <p className="mt-3 text-sm text-ink-muted">
                Which channels and categories archive is managed on the{' '}
                <Link href="/permissions" className="text-accent underline">
                  Permissions
                </Link>{' '}
                page, alongside the send scope - one place owns every operating-scope change.
              </p>
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
                    <Empty
                      title="No archived messages here yet"
                      detail="A backfill fills the history over time."
                      action={<Button onClick={browse.reload}>Refresh messages</Button>}
                    />
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
                                {<Moment at={m.createdAt} />}
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
                                    <Badge wrap tone="hold">
                                      deleted from Discord
                                    </Badge>
                                  </>
                                )}
                              </span>
                            ),
                          },
                          {
                            key: 'actions',
                            header: '',
                            cell: (m) => (
                              <Button onClick={() => void openMessage(m.messageId)}>Open</Button>
                            ),
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
                {detailBusy && <Loading />}
                {detailError !== undefined &&
                  (detailError instanceof ApiError && detailError.status === 404 ? (
                    <NotFound what="Archived message" />
                  ) : (
                    <Unavailable what="archived message detail" error={detailError} />
                  ))}
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
                      {<Moment at={detail.createdAt} />}
                      {detail.editedAt !== undefined && (
                        <span>
                          {' '}
                          · edited <Moment at={detail.editedAt} />
                        </span>
                      )}
                      {detail.deletedAt !== undefined && (
                        <span>
                          {' '}
                          · deleted from Discord <Moment at={detail.deletedAt} />
                        </span>
                      )}
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
          </KeptSection>
          <KeptSection hidden={sections.value === 'channels'}>
            <Card title="Message tools">
              <div className="grid gap-4 sm:grid-cols-2">
                <form
                  id="archive-preserve-fields"
                  tabIndex={-1}
                  aria-describedby="preserve-errors"
                  onSubmit={(e) => void preserve(e)}
                  className="grid content-start gap-3"
                >
                  <FormSection title="Preserve message">
                    <GroupErrors
                      errors={preserveFields.summary}
                      id="archive-preserve-fields"
                      direct={{ 'field-messageId': 'preserve-messageId' }}
                    />
                    <p className="sr-only" id="preserve-errors">
                      {preserveFields.summary.map((e) => e.message).join(' ')}
                    </p>
                    {preserveError !== undefined && <ErrorNotice error={preserveError} />}
                    <Field
                      label="Preserve a message"
                      htmlFor="preserve-messageId"
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
                  </FormSection>
                </form>
                <form
                  id="archive-link-fields"
                  tabIndex={-1}
                  aria-describedby="link-errors"
                  onSubmit={(e) => void linkCase(e)}
                  className="grid content-start gap-3"
                >
                  <FormSection title="Link message to case">
                    <GroupErrors
                      errors={linkFields.summary}
                      id="archive-link-fields"
                      direct={{
                        'field-messageId': 'link-messageId',
                        'field-caseId': 'link-caseId',
                      }}
                    />
                    <p className="sr-only" id="link-errors">
                      {linkFields.summary.map((e) => e.message).join(' ')}
                    </p>
                    {linkFailure !== undefined && <ErrorNotice error={linkFailure} />}
                    <Field label="Message ID" htmlFor="link-messageId">
                      <Input
                        value={linkMessageId}
                        onChange={(e) => setLinkMessageId(e.target.value)}
                      />
                    </Field>
                    <Field
                      label="Link to case"
                      htmlFor="link-caseId"
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
                  </FormSection>
                </form>
              </div>
            </Card>
          </KeptSection>
        </div>,
      )}
    </>
  );
}
