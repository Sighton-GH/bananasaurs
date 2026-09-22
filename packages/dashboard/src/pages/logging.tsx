import { useCallback, useState } from 'react';
import { LOG_EVENT_KINDS, type GuildChannelInfo, type LogRoutesResponse } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ChannelPicker } from '../ui/ChannelPicker.js';
import { Checkbox, Field } from '../ui/Field.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

/**
 * `/logging`: `log routing list` and `log routing set` as a page, plus the
 * per-channel log exclusions the same route group owns. A route on an event
 * kind nothing emits is an inert module that looks configured (WP4 §5), so
 * the form offers only the kinds the subscriber actually routes. Content
 * routing is a member-privacy decision: the table says "included" or
 * "redacted" for every route, never hides it.
 */
export function LoggingPage() {
  const session = useSession();
  const toast = useToast();
  const load = useCallback(() => session.read<LogRoutesResponse>('/api/log-routes'), [session]);
  const routes = useResource('the log routes', load);
  const loadChannels = useCallback(
    () => session.read<{ channels: readonly GuildChannelInfo[] }>('/api/guild/channels'),
    [session],
  );
  const channelDirectory = useResource('the channel list', loadChannels);
  const channelName = (id: string): string => {
    if (channelDirectory.resource.state !== 'ready') return id;
    const found = channelDirectory.resource.data.channels.find((c) => c.channelId === id);
    return found === undefined ? id : `#${found.name}`;
  };

  const [eventKind, setEventKind] = useState(LOG_EVENT_KINDS[0] ?? '');
  const [channelId, setChannelId] = useState('');
  // On by default (owner decision 2026-09-21): a route exists so the log is
  // useful, and the checkbox + the table's included/redacted column keep the
  // privacy choice visible either way.
  const [includeContent, setIncludeContent] = useState(true);
  const [excludeId, setExcludeId] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await session.write<{ ok: boolean }>('/api/log-routes', {
        eventKind,
        channelId: channelId.trim(),
        includeContent,
      });
      if (result !== undefined) {
        toast({ tone: 'ok', title: `Route set for ${eventKind}` });
        setChannelId('');
        routes.reload();
      }
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (kind: string, enabled: boolean) => {
    const result = await session.write<{ ok: boolean }>(
      `/api/log-routes/${encodeURIComponent(kind)}/enabled`,
      { enabled },
    );
    if (result !== undefined) {
      toast({
        tone: 'ok',
        title: `${kind} route ${enabled ? 'enabled' : 'disabled'}`,
      });
      routes.reload();
    }
  };

  const exclude = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await session.write<{ ok: boolean; added: boolean }>('/api/log-exclusions', {
        channelId: excludeId.trim(),
      });
      if (result !== undefined) {
        toast({
          tone: result.added ? 'ok' : 'neutral',
          title: result.added
            ? 'Channel excluded from logging'
            : 'That channel was already excluded',
        });
        setExcludeId('');
        routes.reload();
      }
    } finally {
      setBusy(false);
    }
  };

  const unexclude = async (id: string) => {
    const result = await session.write<{ ok: boolean; removed: boolean }>(
      `/api/log-exclusions/${encodeURIComponent(id)}`,
      undefined,
      'DELETE',
    );
    if (result !== undefined) {
      toast({
        tone: result.removed ? 'ok' : 'neutral',
        title: result.removed ? 'Exclusion removed' : 'That channel was not excluded',
      });
      routes.reload();
    }
  };

  return (
    <>
      <PageHeader
        title="Logging"
        purpose="Which Discord events are posted to which channel, whether message content goes with them, and the channels logging never touches."
      />
      <div className="grid max-w-4xl gap-3">
        <Card title="Routes">
          <DataState
            resource={routes.resource}
            isEmpty={(data) => data.routes.length === 0}
            empty={
              <p className="text-sm text-ink-muted">
                No routes yet. Set one below to start logging an event kind to a channel.
              </p>
            }
          >
            {(data) => (
              <DataTable
                caption="Log routes"
                rows={data.routes}
                rowKey={(r) => r.eventKind}
                columns={[
                  { key: 'event', header: 'Event', cell: (r) => r.eventKind },
                  {
                    key: 'channel',
                    header: 'Channel',
                    cell: (r) => (
                      <span title={r.channelId}>
                        {channelName(r.channelId)}
                        {channelName(r.channelId) === r.channelId ? (
                          ''
                        ) : (
                          <span className="text-xs text-ink-muted"> {r.channelId}</span>
                        )}
                      </span>
                    ),
                  },
                  {
                    key: 'content',
                    header: 'Content',
                    cell: (r) =>
                      r.includeContent ? <Badge tone="hold">included</Badge> : 'redacted',
                  },
                  {
                    key: 'state',
                    header: 'State',
                    cell: (r) => (r.enabled ? 'enabled' : <Badge tone="neutral">disabled</Badge>),
                  },
                  {
                    key: 'actions',
                    header: '',
                    cell: (r) => (
                      <Button onClick={() => void setEnabled(r.eventKind, !r.enabled)}>
                        {r.enabled ? 'Disable' : 'Enable'}
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </DataState>
          <form onSubmit={(e) => void submit(e)} className="mt-3 grid max-w-md gap-3">
            <Field
              label="Event kind"
              hint="Only the kinds the subscriber actually routes — anything else would be an inert route that looks configured."
            >
              <select
                aria-label="Event kind"
                value={eventKind}
                onChange={(e) => setEventKind(e.target.value)}
                className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
              >
                {LOG_EVENT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </Field>
            <ChannelPicker label="Channel" value={channelId} onChange={setChannelId} />
            <div>
              <Checkbox
                label="Include message content"
                checked={includeContent}
                onChange={(e) => setIncludeContent(e.target.checked)}
              />
              <p className="mt-1 text-xs text-ink-muted">
                On by default so the log is useful. Unticked, the route posts the event with the
                message text redacted.
              </p>
            </div>
            <div>
              <Button
                type="submit"
                variant="primary"
                busy={busy}
                disabled={channelId.trim() === ''}
              >
                Set route
              </Button>
            </div>
          </form>
        </Card>
        <Card title="Log exclusions">
          <DataState resource={routes.resource}>
            {(data) =>
              (data.excludedChannels ?? []).length === 0 ? (
                <p className="text-sm text-ink-muted">
                  No exclusions — every channel the routes match is logged.
                </p>
              ) : (
                <DataTable
                  caption="Channels excluded from logging"
                  rows={data.excludedChannels ?? []}
                  rowKey={(id) => id}
                  columns={[
                    {
                      key: 'channel',
                      header: 'Channel',
                      cell: (id) => (
                        <span title={id}>
                          {channelName(id)}
                          {channelName(id) === id ? (
                            ''
                          ) : (
                            <span className="text-xs text-ink-muted"> {id}</span>
                          )}
                        </span>
                      ),
                    },
                    {
                      key: 'actions',
                      header: '',
                      cell: (id) => <Button onClick={() => void unexclude(id)}>Remove</Button>,
                    },
                  ]}
                />
              )
            }
          </DataState>
          <form onSubmit={(e) => void exclude(e)} className="mt-3 grid max-w-md gap-3">
            <ChannelPicker
              label="Exclude a channel"
              hint="Search for the channel logging never touches."
              value={excludeId}
              onChange={setExcludeId}
            />
            <div>
              <Button type="submit" busy={busy} disabled={excludeId.trim() === ''}>
                Exclude channel
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
