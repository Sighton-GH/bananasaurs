import { useState } from 'react';
import { useSession } from '../../../app/session.js';
import { ApiError } from '../../../api.js';
import { describeError } from '../../../api/describe-error.js';
import { useToast } from '../../../ui/Toast.js';
import { InlineAlert } from '../../../ui/InlineAlert.js';
import { Button } from '../../../ui/Button.js';
import { ConfirmDialog } from '../../../ui/ConfirmDialog.js';
import { formatInZone } from '../../../lib/zoned-time.js';
import { type Task, type Report } from './types.js';

export function ReportsSection({
  task,
  reports,
  nameOf,
  onReload,
  onRemoved,
}: {
  task: Task;
  reports: Report[];
  nameOf: (memberId: string) => string | undefined;
  onReload: () => void;
  onRemoved?: (headingId: string) => void;
}) {
  const session = useSession();
  const toast = useToast();
  // apiFetch returns undefined for HTTP 204, so every HTTP refusal must throw
  // here instead of sharing Session's handled-error/undefined return value.
  const deleteFailureStatuses = Array.from({ length: 300 }, (_, i) => i + 300);
  const toastDeleteRefusal = (err: unknown): boolean => {
    if (!(err instanceof ApiError) || err.status === 400 || err.status === 409) return false;
    // Session already displayed the expired-session notice and logged out.
    if (err.status === 401 && err.body.error === 'unauthenticated') return true;
    const d = describeError(err);
    const cancelled = err.status === 401 && err.body.error === 'reauth-required';
    const rejectedPassword = err.status === 401 && err.body.error === 'invalid-credentials';
    toast({
      tone: cancelled ? 'neutral' : err.status === 503 ? 'hold' : 'danger',
      title: cancelled
        ? 'Cancelled'
        : rejectedPassword
          ? 'Password not accepted'
          : err.status === 503
            ? 'This instance is read-only'
            : d.title,
      message: cancelled
        ? 'Nothing was changed.'
        : rejectedPassword
          ? 'Nothing was changed. Try again.'
          : [d.message, d.hint].filter(Boolean).join(' '),
      ...(cancelled
        ? {}
        : {
            detail: [
              d.code,
              `HTTP ${err.status}`,
              d.requestId !== undefined ? `request ${d.requestId}` : undefined,
            ]
              .filter(Boolean)
              .join(' · '),
          }),
    });
    return true;
  };
  const [confirming, setConfirming] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const remove = async (reportId: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await session.writeOrThrow(
        `/api/tasks/${task.taskId}/reports/${reportId}`,
        undefined,
        'DELETE',
        deleteFailureStatuses,
      );
      onRemoved?.('task-reports-heading');
      onReload();
    } catch (err) {
      if (toastDeleteRefusal(err)) return;
      setError(
        err instanceof ApiError ? describeError(err).message : 'Could not delete the update.',
      );
    } finally {
      setConfirming('');
      setBusy(false);
    }
  };

  const sorted = [...reports].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <section className="grid gap-3 rounded-panel border border-line bg-panel p-4 text-body">
      <h2 id="task-reports-heading" tabIndex={-1} className="font-semibold">
        Progress reports
      </h2>
      {error && (
        <InlineAlert tone="danger" title="That did not work">
          {error}
        </InlineAlert>
      )}
      {sorted.length === 0 ? (
        <p className="mt-1 text-ink-muted">No reports yet.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {sorted.map((report) => (
            <li key={report.reportId} className="rounded border border-line px-3 py-2">
              <p className="text-xs text-ink-muted">
                {nameOf(report.authorId) ?? report.authorId} ·{' '}
                {formatInZone(report.createdAt, task.timezone)}
              </p>
              <p className="mt-1 whitespace-pre-wrap">{report.body}</p>
              <Button onClick={() => setConfirming(report.reportId)} className="mt-2 min-h-10">
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirming !== ''}
        title="Delete this update?"
        scope={<p>This progress report is removed from the task. This cannot be undone.</p>}
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={() => void remove(confirming)}
        onCancel={() => {
          if (!busy) setConfirming('');
        }}
      />
    </section>
  );
}
