import { useCallback, useState } from 'react';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { Field, Input } from '../ui/Field.js';
import { PageHeader } from '../ui/PageHeader.js';

interface AuditRow {
  auditId: number;
  at: number;
  actorType: string;
  actorId: string | null;
  actorUnixUserClaimed: string | null;
  via: string | null;
  action: string;
  subjectType: string;
  subjectId: string | null;
  dryRun: boolean;
}

interface TailParams {
  readonly limit: string;
  readonly since: string;
}

/** `2h`, `30m`, `1d` → milliseconds, the way the CLI's `--since` reads them. */
const DURATION_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

const parseSince = (raw: string): number | undefined | 'invalid' => {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const match = /^(\d+)\s*([mhd])$/.exec(trimmed);
  if (match === null) return 'invalid';
  return Number(match[1]) * DURATION_MS[match[2]!]!;
};

const toUrl = (params: TailParams): string => {
  const search = new URLSearchParams();
  const limit = Number(params.limit);
  search.set('limit', String(Number.isInteger(limit) && limit > 0 ? limit : 50));
  const since = parseSince(params.since);
  if (since !== undefined && since !== 'invalid') {
    search.set('sinceMs', String(Date.now() - since));
  }
  return `/api/audit?${search.toString()}`;
};

/**
 * `/audit`: `audit tail -n 50 [--since 2h]` as a page (ADR 0051 D3). The
 * `dry run` badge is the one accent doing its one job: that action was
 * rehearsed, not done. The `via` column keeps `dashboard` rows honest beside
 * the CLI's — the trail attributes every row to how it arrived.
 */
export function AuditPage() {
  const session = useSession();
  const [draft, setDraft] = useState<TailParams>({ limit: '50', since: '' });
  const [applied, setApplied] = useState<TailParams>({ limit: '50', since: '' });
  const [sinceError, setSinceError] = useState<string | undefined>(undefined);

  const load = useCallback(() => session.read<AuditRow[]>(toUrl(applied)), [session, applied]);
  const audit = useResource('the audit log', load);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    if (parseSince(draft.since) === 'invalid') {
      setSinceError('Use a duration like 30m, 2h or 1d — or leave it empty.');
      return;
    }
    setSinceError(undefined);
    setApplied(draft);
  };

  return (
    <>
      <PageHeader
        title="Audit"
        purpose="What the bot did or refused to do, and who asked — CLI, dashboard or the Discord gateway itself."
      />
      <form onSubmit={apply} className="mb-4 flex max-w-2xl flex-wrap items-end gap-3">
        <Field label="Rows">
          <Input
            value={draft.limit}
            inputMode="numeric"
            onChange={(e) => setDraft((d) => ({ ...d, limit: e.target.value }))}
          />
        </Field>
        <Field
          label="Since"
          hint="A duration like 30m, 2h or 1d. Empty means everything."
          {...(sinceError !== undefined ? { error: sinceError } : {})}
        >
          <Input
            value={draft.since}
            placeholder="2h"
            onChange={(e) => setDraft((d) => ({ ...d, since: e.target.value }))}
          />
        </Field>
        <Button type="submit" variant="primary">
          Apply
        </Button>
      </form>
      <DataState
        resource={audit.resource}
        isEmpty={(a) => a.length === 0}
        empty={<p className="text-sm text-ink-muted">Nothing has been audited yet.</p>}
      >
        {(rows) => (
          <DataTable
            caption="Audit log"
            rows={rows}
            rowKey={(r) => String(r.auditId)}
            columns={[
              { key: 'when', header: 'When', cell: (r) => new Date(r.at).toLocaleString() },
              {
                key: 'actor',
                header: 'Actor',
                cell: (r) =>
                  `${r.actorType}${r.actorUnixUserClaimed !== null ? ` (${r.actorUnixUserClaimed}, claimed)` : ''}`,
              },
              {
                key: 'via',
                header: 'Via',
                cell: (r) => r.via ?? <span className="text-ink-muted">—</span>,
              },
              { key: 'action', header: 'Action', cell: (r) => r.action },
              {
                key: 'subject',
                header: 'Subject',
                cell: (r) => `${r.subjectType}${r.subjectId !== null ? `:${r.subjectId}` : ''}`,
              },
              {
                key: 'dryRun',
                header: '',
                cell: (r) => (r.dryRun ? <Badge tone="hold">dry run</Badge> : ''),
              },
            ]}
          />
        )}
      </DataState>
    </>
  );
}
