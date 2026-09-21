import { useCallback, useState } from 'react';
import { ApiError } from '../api.js';
import type { JobRow } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Checkbox } from '../ui/Field.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { EmptyState } from '../ui/EmptyState.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

const stateTone = (state: string): 'danger' | 'ok' | 'neutral' =>
  state === 'failed' ? 'danger' : state === 'done' ? 'ok' : 'neutral';

/** What a 409 from `jobs retry` asks the operator for (the port's own words). */
const retryRefusalText = (err: ApiError): string => {
  const body = err.body as { error: string; state?: string; blockingJobId?: number };
  if (body.error === 'not-failed') {
    return `Job is not failed — it is ${body.state ?? 'in another state'}. Only a failed job can be retried.`;
  }
  if (body.error === 'dedupe-blocked') {
    return `A pending job already covers this work (job #${String(body.blockingJobId ?? '?')}). The retry was not queued.`;
  }
  return err.message;
};

/**
 * `/jobs`: `bananasaurs jobs list [--failed]`, `jobs show` and
 * `jobs retry <id> --confirm` as a page (ADR 0051 D3). Retry re-queues real
 * work, so it states its scope first; the 409 refusals render inline because
 * they ask the operator for something specific (patience, or nothing).
 */
export function JobsPage() {
  const session = useSession();
  const toast = useToast();
  const [failedOnly, setFailedOnly] = useState(false);
  const load = useCallback(
    () => session.read<JobRow[]>(`/api/jobs?limit=100${failedOnly ? '&failedOnly=true' : ''}`),
    [session, failedOnly],
  );
  const jobs = useResource('the jobs', load);

  const [selected, setSelected] = useState<JobRow | undefined>(undefined);
  const [detailError, setDetailError] = useState<string | undefined>(undefined);
  const [retrying, setRetrying] = useState<JobRow | undefined>(undefined);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const view = async (job: JobRow) => {
    setDetailError(undefined);
    try {
      setSelected(await session.read<JobRow>(`/api/jobs/${String(job.jobId)}`));
    } catch (err) {
      setSelected(undefined);
      setDetailError(err instanceof Error ? err.message : String(err));
    }
  };

  const retry = async () => {
    if (retrying === undefined) return;
    setBusy(true);
    setRefusal(undefined);
    try {
      const result = await session.writeOrThrow<{ ok: boolean }>(
        `/api/jobs/${String(retrying.jobId)}/retry`,
        {},
      );
      if (result === undefined) return;
      toast({ tone: 'ok', title: `Job #${String(retrying.jobId)} re-queued` });
      setRetrying(undefined);
      jobs.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setRefusal(retryRefusalText(err));
      } else if (err instanceof ApiError && err.status === 404) {
        setRefusal('That job no longer exists. Reload the list.');
      } else {
        throw err;
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Jobs"
        purpose="Background work the bot has queued, is running or could not finish. Failed work can be retried here."
      />
      <div className="mb-3">
        <Checkbox
          label="Failed only"
          checked={failedOnly}
          onChange={(e) => setFailedOnly(e.target.checked)}
        />
      </div>
      <DataState
        resource={jobs.resource}
        isEmpty={(rows) => rows.length === 0}
        empty={
          <EmptyState
            title={failedOnly ? 'No failed jobs' : 'The queue is clear'}
            detail={
              failedOnly
                ? 'Nothing needs a retry. Show the full queue to see queued, running and completed work.'
                : 'There is no queued or running work right now. New durable work will appear here automatically.'
            }
            action={
              failedOnly ? (
                <Button onClick={() => setFailedOnly(false)}>Show all jobs</Button>
              ) : undefined
            }
          />
        }
      >
        {(rows) => (
          <DataTable
            caption="Jobs"
            rows={rows}
            rowKey={(j) => String(j.jobId)}
            columns={[
              { key: 'id', header: 'Job', cell: (j) => `#${String(j.jobId)}` },
              { key: 'kind', header: 'Kind', cell: (j) => j.kind },
              {
                key: 'state',
                header: 'State',
                cell: (j) => <Badge tone={stateTone(j.state)}>{j.state}</Badge>,
              },
              {
                key: 'attempts',
                header: 'Attempts',
                cell: (j) => `${String(j.attempts)}/${String(j.maxAttempts)}`,
                numeric: true,
              },
              {
                key: 'runAfter',
                header: 'Run after',
                cell: (j) => new Date(j.runAfter).toLocaleString(),
              },
              {
                key: 'error',
                header: 'Last error',
                cell: (j) =>
                  j.lastError === null ? (
                    <span className="text-ink-muted">—</span>
                  ) : (
                    <span className="text-danger">{j.lastError}</span>
                  ),
              },
              {
                key: 'actions',
                header: '',
                cell: (j) => (
                  <span className="flex gap-2">
                    <Button onClick={() => void view(j)}>View</Button>
                    {j.state === 'failed' && (
                      <Button
                        variant="primary"
                        onClick={() => {
                          setRefusal(undefined);
                          setRetrying(j);
                        }}
                      >
                        Retry
                      </Button>
                    )}
                  </span>
                ),
              },
            ]}
          />
        )}
      </DataState>
      {detailError !== undefined && (
        <p role="alert" className="mt-3 text-sm text-danger">
          Could not load the job: {detailError}
        </p>
      )}
      {selected !== undefined && (
        <div className="mt-4 max-w-2xl">
          <Card title={`Job #${String(selected.jobId)}`}>
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-ink-muted">Kind</dt>
              <dd>{selected.kind}</dd>
              <dt className="text-ink-muted">State</dt>
              <dd>{selected.state}</dd>
              <dt className="text-ink-muted">Attempts</dt>
              <dd>
                {String(selected.attempts)} of {String(selected.maxAttempts)}
              </dd>
              <dt className="text-ink-muted">Run after</dt>
              <dd>{new Date(selected.runAfter).toLocaleString()}</dd>
              <dt className="text-ink-muted">Duplicate-work key</dt>
              <dd className="break-all">{selected.dedupeKey}</dd>
              <dt className="text-ink-muted">Last error</dt>
              <dd className="break-all">{selected.lastError ?? '—'}</dd>
            </dl>
          </Card>
        </div>
      )}
      <ConfirmDialog
        open={retrying !== undefined}
        title={`Retry job #${String(retrying?.jobId ?? '')}?`}
        scope={
          <p>
            Re-queues {retrying?.kind ?? ''} job #{String(retrying?.jobId ?? '')} in guild{' '}
            {session.info.guildId}. Its side effects run again under the current kill switch and
            dry-run state.
          </p>
        }
        confirmLabel="Retry job"
        busy={busy}
        onConfirm={() => void retry()}
        onCancel={() => setRetrying(undefined)}
      >
        {refusal !== undefined && (
          <p role="alert" className="mt-3 rounded-sm border border-danger px-3 py-2 text-sm">
            {refusal}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
