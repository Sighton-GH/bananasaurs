import { useState } from 'react';
import { useSession } from '../../../app/session.js';
import { ApiError } from '../../../api.js';
import { describeError } from '../../../api/describe-error.js';
import { useToast } from '../../../ui/Toast.js';
import { Button } from '../../../ui/Button.js';
import { ConfirmDialog } from '../../../ui/ConfirmDialog.js';
import { formatInZone, utcToZonedLocal, zonedLocalToUtc } from '../../../lib/zoned-time.js';
import { Input } from '../../../ui/Field.js';
import { InlineAlert } from '../../../ui/InlineAlert.js';
import { type Task, type Child, STATUS_LABEL } from './types.js';

export function StepsSection({
  task,
  children,
  onReload,
  onStale,
  onRemoved,
}: {
  task: Task;
  children: Child[];
  onReload: () => void;
  onStale: () => void;
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
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editDue, setEditDue] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Child | undefined>(undefined);

  const fail = (err: unknown, fallback: string): void => {
    if (err instanceof ApiError && err.status === 409 && err.body.error === 'stale-task-version') {
      onStale();
      return;
    }
    setError(err instanceof ApiError ? describeError(err).message : fallback);
  };

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      setError('Enter a name for the step.');
      return;
    }
    if (!due) {
      setError('Choose a date and time for the step.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await session.writeOrThrow(`/api/tasks/${task.taskId}/children`, {
        version: task.version,
        title: title.trim(),
        dueAt: zonedLocalToUtc(due, task.timezone),
      });
      if (result === undefined) return;
      setTitle('');
      setDue('');
      onReload();
    } catch (err) {
      fail(err, 'Could not add the step.');
    } finally {
      setBusy(false);
    }
  };

  const complete = async (childId: string) => {
    setBusy(true);
    setError('');
    try {
      const result = await session.writeOrThrow(
        `/api/tasks/${task.taskId}/children/${childId}/complete`,
        { version: task.version },
      );
      if (result === undefined) return;
      onReload();
    } catch (err) {
      fail(err, 'Could not complete the step.');
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (event: React.FormEvent, childId: string) => {
    event.preventDefault();
    if (!editTitle.trim()) {
      setError('Enter a name for the step.');
      return;
    }
    if (!editDue) {
      setError('Choose a date and time for the step.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await session.writeOrThrow(
        `/api/tasks/${task.taskId}/children/${childId}`,
        {
          version: task.version,
          title: editTitle.trim(),
          dueAt: zonedLocalToUtc(editDue, task.timezone),
        },
        'PUT',
      );
      if (result === undefined) return;
      setEditingId('');
      onReload();
    } catch (err) {
      fail(err, 'Could not save the step.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (childId: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await session.writeOrThrow(
        `/api/tasks/${task.taskId}/children/${childId}`,
        { version: task.version },
        'DELETE',
        deleteFailureStatuses,
      );
      onRemoved?.('task-steps-heading');
      onReload();
    } catch (err) {
      if (toastDeleteRefusal(err)) return;
      fail(err, 'Could not delete the step.');
    } finally {
      setPendingDelete(undefined);
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-3 rounded-panel border border-line bg-panel p-4 text-body">
      <h2 id="task-steps-heading" tabIndex={-1} className="font-semibold">
        Dated steps
      </h2>
      {error && (
        <InlineAlert tone="danger" title="That did not work">
          {error}
        </InlineAlert>
      )}
      {children.length === 0 ? (
        <p className="mt-1 text-ink-muted">No steps yet.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {children.map((child) =>
            editingId === child.childId ? (
              <li key={child.childId} className="rounded border border-line px-3 py-2">
                <form
                  onSubmit={(event) => void saveEdit(event, child.childId)}
                  className="grid gap-2"
                >
                  <label className="grid gap-1">
                    Step name
                    <Input
                      value={editTitle}
                      maxLength={180}
                      onChange={(e) => setEditTitle(e.target.value)}
                    />
                  </label>
                  <label className="grid gap-1">
                    Step date and time
                    <Input
                      type="datetime-local"
                      value={editDue}
                      onChange={(e) => setEditDue(e.target.value)}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" busy={busy} className="min-h-10">
                      Save step
                    </Button>
                    <Button onClick={() => setEditingId('')} className="min-h-10">
                      Cancel
                    </Button>
                  </div>
                </form>
              </li>
            ) : (
              <li key={child.childId} className="rounded border border-line px-3 py-2">
                <p className="font-medium">{child.title}</p>
                <p className="mt-1 text-xs text-ink-muted">
                  Due {formatInZone(child.dueAt, task.timezone)} ·{' '}
                  {child.completedAt !== null
                    ? 'Completed'
                    : (STATUS_LABEL[child.status] ?? child.status)}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {child.completedAt === null && (
                    <Button
                      busy={busy}
                      onClick={() => void complete(child.childId)}
                      className="min-h-10"
                    >
                      Complete
                    </Button>
                  )}
                  <Button
                    onClick={() => {
                      setEditingId(child.childId);
                      setEditTitle(child.title);
                      setEditDue(utcToZonedLocal(child.dueAt, task.timezone));
                    }}
                    className="min-h-10"
                  >
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    busy={busy}
                    onClick={() => setPendingDelete(child)}
                    className="min-h-10"
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      <form onSubmit={(event) => void add(event)} className="mt-3 grid gap-2">
        <h3 className="font-medium">Add step</h3>
        <label className="grid gap-1">
          Step name
          <Input value={title} maxLength={180} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="grid gap-1">
          Step date and time ({task.timezone})
          <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <Button type="submit" busy={busy} className="min-h-10">
          Add step
        </Button>
      </form>
      <ConfirmDialog
        open={pendingDelete !== undefined}
        title={`Delete step "${pendingDelete?.title ?? ''}"?`}
        scope={<p>This step is removed from the task. This cannot be undone.</p>}
        confirmLabel="Delete step"
        danger
        busy={busy}
        onConfirm={() => {
          if (pendingDelete !== undefined) void remove(pendingDelete.childId);
        }}
        onCancel={() => {
          if (!busy) setPendingDelete(undefined);
        }}
      />
    </section>
  );
}
