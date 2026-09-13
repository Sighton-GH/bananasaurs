import { useCallback, useState } from 'react';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../ui/Button.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { Checkbox, Field, Input } from '../ui/Field.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

interface LogRoute {
  eventKind: string;
  channelId: string;
  enabled: boolean;
  includeContent: boolean;
}

/** The former Log routing section: `GET /api/log-routes` and `POST /api/log-routes`. */
export function LoggingPage() {
  const session = useSession();
  const toast = useToast();
  const load = useCallback(
    () => session.read<{ routes: LogRoute[] }>('/api/log-routes').then((r) => r.routes),
    [session],
  );
  const routes = useResource('the log routes', load);

  const [eventKind, setEventKind] = useState('');
  const [channelId, setChannelId] = useState('');
  const [includeContent, setIncludeContent] = useState(true);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await session.write<{ ok: boolean }>('/api/log-routes', {
        eventKind,
        channelId,
        includeContent,
      });
      if (result !== undefined) {
        toast({ tone: 'ok', title: `Route set for ${eventKind}` });
        routes.reload();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Logging"
        purpose="Which Discord events are posted to which channel, and whether message content goes with them."
      />
      <DataState
        resource={routes.resource}
        isEmpty={(r) => r.length === 0}
        empty={
          <p className="text-sm text-ink-muted">
            No routes yet. Set one below to start logging an event kind to a channel.
          </p>
        }
      >
        {(rows) => (
          <DataTable
            caption="Log routes"
            rows={rows}
            rowKey={(r) => r.eventKind}
            columns={[
              { key: 'event', header: 'Event', cell: (r) => r.eventKind },
              { key: 'channel', header: 'Channel', cell: (r) => r.channelId },
              {
                key: 'content',
                header: 'Content',
                cell: (r) => (r.includeContent ? 'included' : 'redacted'),
              },
            ]}
          />
        )}
      </DataState>
      <form onSubmit={(e) => void submit(e)} className="mt-6 grid max-w-md gap-3">
        <h2 className="text-lg">Set a route</h2>
        <Field label="Event kind">
          <Input
            value={eventKind}
            onChange={(e) => setEventKind(e.target.value)}
            placeholder="e.g. message_delete"
          />
        </Field>
        <Field label="Channel ID">
          <Input value={channelId} onChange={(e) => setChannelId(e.target.value)} />
        </Field>
        <Checkbox
          label="Include message content"
          checked={includeContent}
          onChange={(e) => setIncludeContent(e.target.checked)}
        />
        <div>
          <Button type="submit" variant="primary" busy={busy}>
            Set route
          </Button>
        </div>
      </form>
    </>
  );
}
