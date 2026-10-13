import { useState } from 'react';
import { useSession } from '../../../app/session.js';
import { ApiError } from '../../../api.js';
import { describeError } from '../../../api/describe-error.js';
import { Button } from '../../../ui/Button.js';
import { formatInZone, zonedLocalToUtc } from '../../../lib/zoned-time.js';
import { Input } from '../../../ui/Field.js';
import { InlineAlert } from '../../../ui/InlineAlert.js';
import { type Task, type Reminder } from './types.js';

export function RemindersSection({
  task,
  reminders,
  onReload,
  onStale,
}: {
  task: Task;
  reminders: Reminder[];
  onReload: () => void;
  onStale: () => void;
}) {
  const session = useSession();
  const [at, setAt] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!at) {
      setError('Choose a date and time for the reminder.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await session.writeOrThrow(`/api/tasks/${task.taskId}/reminders`, {
        at: zonedLocalToUtc(at, task.timezone),
      });
      if (result === undefined) return;
      setAt('');
      onReload();
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.body.error === 'stale-task-version'
      ) {
        onStale();
        return;
      }
      setError(
        err instanceof ApiError ? describeError(err).message : 'Could not add the reminder.',
      );
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (slotId: string) => {
    setBusy(true);
    setError('');
    try {
      await session.writeOrThrow(
        `/api/tasks/${task.taskId}/reminders/${slotId}`,
        undefined,
        'DELETE',
      );
      onReload();
    } catch (err) {
      setError(
        err instanceof ApiError ? describeError(err).message : 'Could not cancel the reminder.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-3 rounded-panel border border-line bg-panel p-4 text-body">
      <h2 className="font-semibold">Reminders</h2>
      {error && (
        <InlineAlert tone="danger" title="That did not work">
          {error}
        </InlineAlert>
      )}
      {reminders.length === 0 ? (
        <p className="mt-1 text-ink-muted">No reminders scheduled.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {reminders.map((reminder) => (
            <li key={reminder.slotId} className="rounded border border-line px-3 py-2">
              <p>
                {reminder.kind} · Due {formatInZone(reminder.dueAt, task.timezone)} ·{' '}
                {reminder.state}
              </p>
              {reminder.kind === 'custom' && reminder.state === 'pending' && (
                <Button
                  busy={busy}
                  onClick={() => void cancel(reminder.slotId)}
                  className="mt-2 min-h-10"
                >
                  Cancel
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(event) => void add(event)} className="mt-3 grid gap-2">
        <h3 className="font-medium">Add reminder</h3>
        <label className="grid gap-1">
          Reminder date and time ({task.timezone})
          <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </label>
        <Button type="submit" busy={busy} className="min-h-10">
          Add reminder
        </Button>
      </form>
    </section>
  );
}
