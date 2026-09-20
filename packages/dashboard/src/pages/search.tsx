import { useCallback, useState } from 'react';
import type { ArchiveSearchResult } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../ui/Button.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { Field, Input } from '../ui/Field.js';
import { PageHeader } from '../ui/PageHeader.js';

interface SearchParams {
  readonly q: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly limit: string;
}

const toQueryString = (params: SearchParams): string => {
  const search = new URLSearchParams();
  search.set('q', params.q);
  if (params.channelId.trim() !== '') search.set('channelId', params.channelId.trim());
  if (params.authorId.trim() !== '') search.set('authorId', params.authorId.trim());
  const limit = Number(params.limit);
  if (Number.isInteger(limit) && limit > 0) search.set('limit', String(limit));
  return search.toString();
};

/**
 * `/search`: `archive search` as a page (ADR 0051 D7). The visibility set is
 * every archive-enabled channel in this guild — the operator searches what
 * the archive holds, nothing wider — and results come back best match first.
 * Nothing is searched until the form is submitted.
 */
export function SearchPage() {
  const session = useSession();
  const [draft, setDraft] = useState<SearchParams>({
    q: '',
    channelId: '',
    authorId: '',
    limit: '50',
  });
  const [submitted, setSubmitted] = useState<SearchParams | undefined>(undefined);

  const load = useCallback(
    () =>
      submitted === undefined
        ? Promise.resolve(undefined)
        : session.read<ArchiveSearchResult>(`/api/archive/search?${toQueryString(submitted)}`),
    [session, submitted],
  );
  const results = useResource('the search results', load);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (draft.q.trim() === '') return;
    setSubmitted({ ...draft, q: draft.q.trim() });
  };

  const set = (patch: Partial<SearchParams>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <>
      <PageHeader
        title="Search"
        purpose="Full-text search over the archived messages of this guild's archive-enabled channels."
      />
      <form onSubmit={submit} className="mb-4 grid max-w-2xl gap-3">
        <Field label="Search for">
          <Input
            value={draft.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder="Words or a phrase"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Channel ID" hint="Optional">
            <Input value={draft.channelId} onChange={(e) => set({ channelId: e.target.value })} />
          </Field>
          <Field label="Author ID" hint="Optional">
            <Input value={draft.authorId} onChange={(e) => set({ authorId: e.target.value })} />
          </Field>
          <Field label="Limit" hint="At most 500">
            <Input value={draft.limit} onChange={(e) => set({ limit: e.target.value })} />
          </Field>
        </div>
        <div>
          <Button type="submit" variant="primary" disabled={draft.q.trim() === ''}>
            Search
          </Button>
        </div>
      </form>
      {submitted === undefined ? (
        <p className="text-sm text-ink-muted">
          Nothing searched yet. Results stay within this guild&apos;s archive-enabled channels.
        </p>
      ) : (
        <DataState
          resource={results.resource}
          isEmpty={(r) => r === undefined || r.hits.length === 0}
          empty={<p className="text-sm text-ink-muted">No archived messages matched.</p>}
        >
          {(result) =>
            result === undefined ? null : (
              <>
                <p className="mb-2 text-sm text-ink-muted">
                  {String(result.total)} {result.total === 1 ? 'match' : 'matches'}, best match
                  first.
                </p>
                <DataTable
                  caption="Archive search results"
                  rows={result.hits}
                  rowKey={(h) => h.messageId}
                  columns={[
                    {
                      key: 'excerpt',
                      header: 'Excerpt',
                      cell: (h) => <span className="break-words">{h.excerpt}</span>,
                    },
                    { key: 'channel', header: 'Channel', cell: (h) => h.channelId },
                    {
                      key: 'author',
                      header: 'Author',
                      cell: (h) => h.authorId ?? <span className="text-ink-muted">—</span>,
                    },
                    {
                      key: 'when',
                      header: 'Sent',
                      cell: (h) => new Date(h.createdAt).toLocaleString(),
                    },
                    { key: 'message', header: 'Message', cell: (h) => h.messageId },
                  ]}
                />
              </>
            )
          }
        </DataState>
      )}
    </>
  );
}
