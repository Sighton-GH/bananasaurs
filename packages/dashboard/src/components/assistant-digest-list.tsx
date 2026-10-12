import { useCallback, useState } from 'react';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';

interface DigestRow {
  readonly day: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly topics: string;
}
interface DigestDetail {
  readonly day: string;
  readonly daySummary: string;
  readonly proposals: readonly { text: string; why: string }[];
  readonly conversations: readonly { conversationId: string; title: string }[];
}

/** The "Daily digests" list under Conversations (ADR 0150 decision 4). */
export function AssistantDigestList() {
  const session = useSession();
  const [open, setOpen] = useState<string | undefined>(undefined);
  const load = useCallback(
    () => session.read<{ digests: readonly DigestRow[] }>('/api/assistant/digests'),
    [session],
  );
  const list = useResource('daily digests', load);
  return (
    <Card title="Daily digests">
      <p className="mb-2 text-sm text-ink-muted">
        One summary per day of what members talked about with the assistant. Memory proposals wait
        for review on the assistant page.
      </p>
      <DataState
        resource={list.resource}
        isEmpty={(d) => d.digests.length === 0}
        empty={
          <p className="text-sm text-ink-muted">
            No digests yet - the first runs at the configured daily digest hour.
          </p>
        }
      >
        {(data) => (
          <DataTable
            caption="Daily digests"
            rows={data.digests}
            rowKey={(r) => r.day}
            columns={[
              { key: 'day', header: 'Day', cell: (r) => r.day },
              { key: 'topics', header: 'Topics', cell: (r) => r.topics },
              {
                key: 'open',
                header: 'Detail',
                cell: (r) => (
                  <button
                    type="button"
                    className="text-sm underline"
                    onClick={() => setOpen(r.day)}
                  >
                    Open
                  </button>
                ),
              },
            ]}
          />
        )}
      </DataState>
      {open !== undefined && <DigestDetailPanel key={open} day={open} />}
    </Card>
  );
}

/** Remount for each selected day: never label an old response with a new day. */
function DigestDetailPanel({ day }: { readonly day: string }) {
  const session = useSession();
  const load = useCallback(
    () =>
      session.read<{ digest: DigestDetail }>(`/api/assistant/digests/${encodeURIComponent(day)}`),
    [session, day],
  );
  const detail = useResource('daily digest detail', load);
  return (
    <div className="mt-3 rounded border border-line p-3">
      <h3 className="font-medium">{day}</h3>
      <DataState resource={detail.resource}>
        {({ digest }) => <p className="whitespace-pre-wrap text-sm">{digest.daySummary}</p>}
      </DataState>
    </div>
  );
}
