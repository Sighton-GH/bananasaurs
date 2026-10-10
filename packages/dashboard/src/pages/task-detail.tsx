import { useCallback, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { useResource } from '../hooks/useResource.js';
import { useSession } from '../app/session.js';
import { ApiError, mayManageTasks } from '../api.js';
import { describeError } from '../api/describe-error.js';
import { Button } from '../ui/Button.js';
import { DataState } from '../ui/DataState.js';
import { PageHeader } from '../ui/PageHeader.js';
import {
  COMMON_TIME_ZONES,
  formatInZone,
  utcToZonedLocal,
  zonedLocalToUtc,
} from '../lib/zoned-time.js';
import { destinationLabel, inputClass } from '../lib/task-form.js';

type Task = {
  taskId: string;
  teamId: string;
  title: string;
  description: string;
  status: 'not_started' | 'in_progress' | 'awaiting_approval' | 'done';
  priority: 'normal' | 'urgent';
  assignmentKind: 'team' | 'individual';
  assigneeId: string | null;
  assigneeIds: string[];
  dueAt: number;
  timezone: string;
  destinationId: string;
  version: number;
  archivedAt: number | null;
};
type Team = { teamId: string; name: string; kind: string };
type Child = {
  childId: string;
  title: string;
  dueAt: number;
  status: string;
  completedAt: number | null;
};
type Report = { reportId: string; authorId: string; body: string; createdAt: number };
type Reminder = { slotId: string; kind: string; dueAt: number; state: string };
type Detail = {
  task: Task;
  team: Team | null;
  children: Child[];
  reports: Report[];
  reminders: Reminder[];
};
type Assignee = { memberId: string; displayName: string };
type Destination = { channelId: string; name: string; kind: string; parentName?: string };

const STATUS_LABEL: Record<string, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  awaiting_approval: 'Awaiting approval',
  done: 'Done',
};

/** Task detail for the owner and accounts with Manage club tasks (ADR 0130). Members use Discord; nothing here posts to Discord. */
export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const session = useSession();
  const detailLoad = useCallback(
    () => session.read<Detail>(`/api/tasks/${taskId}`),
    [session, taskId],
  );
  const detail = useResource('task', detailLoad);
  const [notice, setNotice] = useState('');

  if (!mayManageTasks(session.info)) {
    return (
      <>
        <PageHeader title="Task" purpose="One piece of club work, with its steps and progress." />
        <p role="status">
          Viewing tasks here needs the owner, or the Manage club tasks permission. Members use
          Discord.
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Task"
        purpose="One piece of club work, with its steps and progress."
        actions={
          <Link href="/tasks" className="text-sm text-blue-700 underline">
            Back to tasks
          </Link>
        }
      />
      {notice && (
        <p role="status" className="mb-3 rounded border border-line bg-panel px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      <DataState resource={detail.resource}>
        {(data) => (
          <TaskDetail
            key={`${data.task.taskId}:${data.task.version}`}
            data={data}
            onReload={detail.reload}
            onStale={() => {
              setNotice('This task changed; reloaded the latest version.');
              detail.reload();
            }}
          />
        )}
      </DataState>
    </>
  );
}

function TaskDetail({
  data,
  onReload,
  onStale,
}: {
  data: Detail;
  onReload: () => void;
  onStale: () => void;
}) {
  const session = useSession();
  const { task, team } = data;
  const [, navigate] = useLocation();
  const assigneesLoad = useCallback(
    () => session.read<{ assignees: Assignee[] }>(`/api/tasks/teams/${task.teamId}/assignees`),
    [session, task.teamId],
  );
  const assignees = useResource('team assignees', assigneesLoad);
  const destinationsLoad = useCallback(
    () =>
      session.read<{ destinations: Destination[] }>(`/api/tasks/teams/${task.teamId}/destinations`),
    [session, task.teamId],
  );
  const destinations = useResource('destinations', destinationsLoad);
  const [actionError, setActionError] = useState('');
  const [actionBusy, setActionBusy] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const act = async (label: string, url: string, body: unknown) => {
    setActionBusy(label);
    setActionError('');
    try {
      const result = await session.writeOrThrow(url, body, 'POST');
      if (result === undefined) return;
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
      setActionError(
        err instanceof ApiError ? describeError(err).message : 'Could not update the task.',
      );
    } finally {
      setActionBusy('');
    }
  };

  const archived = task.archivedAt !== null;
  const nameOf = (memberId: string): string | undefined =>
    assignees.resource.state === 'ready'
      ? assignees.resource.data.assignees.find((a) => a.memberId === memberId)?.displayName
      : undefined;

  const removeTask = async () => {
    setActionBusy('delete');
    setActionError('');
    try {
      const result = await session.writeOrThrow(
        `/api/tasks/${task.taskId}`,
        { version: task.version },
        'DELETE',
      );
      if (result === undefined) return;
      navigate('/tasks');
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.body.error === 'stale-task-version'
      ) {
        onStale();
        return;
      }
      setActionError(
        err instanceof ApiError ? describeError(err).message : 'Could not delete the task.',
      );
    } finally {
      setActionBusy('');
    }
  };

  return (
    <div className="grid max-w-3xl gap-4">
      <section className="rounded border border-line bg-panel p-4 text-sm">
        <h2 className="text-base font-semibold">{task.title}</h2>
        {task.description && (
          <p className="mt-1 whitespace-pre-wrap text-ink-muted">{task.description}</p>
        )}
        <dl className="mt-2 grid gap-1">
          <div className="flex gap-2">
            <dt className="font-medium">Team:</dt>
            <dd>{team?.name ?? task.teamId}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium">Status:</dt>
            <dd>
              {STATUS_LABEL[task.status] ?? task.status}
              {archived && ' (archived)'}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium">Priority:</dt>
            <dd>{task.priority === 'urgent' ? 'Urgent' : 'Normal'}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium">Due:</dt>
            <dd>{formatInZone(task.dueAt, task.timezone)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium">Assignees:</dt>
            <dd>
              {task.assignmentKind === 'team' ? (
                'Whole team'
              ) : (
                <DataState resource={assignees.resource}>
                  {(names) =>
                    task.assigneeIds.length === 0
                      ? 'None'
                      : task.assigneeIds
                          .map(
                            (id) =>
                              names.assignees.find((a) => a.memberId === id)?.displayName ?? id,
                          )
                          .join(', ')
                  }
                </DataState>
              )}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium">Destination:</dt>
            <dd>
              <DataState resource={destinations.resource}>
                {(destData) =>
                  destData.destinations.find((d) => d.channelId === task.destinationId)?.name ??
                  task.destinationId
                }
              </DataState>
            </dd>
          </div>
        </dl>
        {actionError && (
          <p role="alert" className="mt-2">
            {actionError}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {task.status === 'awaiting_approval' && !archived && (
            <>
              <Button
                busy={actionBusy === 'approve'}
                onClick={() =>
                  void act('approve', `/api/tasks/${task.taskId}/approve`, {
                    version: task.version,
                  })
                }
                className="min-h-10"
              >
                Approve
              </Button>
              <Button
                busy={actionBusy === 'reject'}
                onClick={() =>
                  void act('reject', `/api/tasks/${task.taskId}/reject`, { version: task.version })
                }
                className="min-h-10"
              >
                Send back
              </Button>
            </>
          )}
          {(task.status === 'not_started' || task.status === 'in_progress') && !archived && (
            <>
              {/* ADR 0138: a manager completes directly; a member's request still goes through Approve. */}
              <Button
                busy={actionBusy === 'complete'}
                onClick={() =>
                  void act('complete', `/api/tasks/${task.taskId}/complete`, {
                    version: task.version,
                  })
                }
                className="min-h-10"
              >
                Mark done
              </Button>
              <Button
                busy={actionBusy === 'progress'}
                onClick={() =>
                  void act('progress', `/api/tasks/${task.taskId}/status`, {
                    version: task.version,
                    status: 'in_progress',
                  })
                }
                className="min-h-10"
              >
                Mark in progress
              </Button>
              <Button
                busy={actionBusy === 'notstarted'}
                onClick={() =>
                  void act('notstarted', `/api/tasks/${task.taskId}/status`, {
                    version: task.version,
                    status: 'not_started',
                  })
                }
                className="min-h-10"
              >
                Mark not started
              </Button>
            </>
          )}
          {task.status === 'done' && !archived && (
            <>
              <Button
                busy={actionBusy === 'reopen'}
                onClick={() =>
                  void act('reopen', `/api/tasks/${task.taskId}/status`, {
                    version: task.version,
                    status: 'in_progress',
                  })
                }
                className="min-h-10"
              >
                Reopen
              </Button>
              <Button
                busy={actionBusy === 'archive'}
                onClick={() =>
                  void act('archive', `/api/tasks/${task.taskId}/archive`, {
                    version: task.version,
                  })
                }
                className="min-h-10"
              >
                Archive
              </Button>
            </>
          )}
          {archived && (
            <Button
              busy={actionBusy === 'unarchive'}
              onClick={() =>
                void act('unarchive', `/api/tasks/${task.taskId}/unarchive`, {
                  version: task.version,
                })
              }
              className="min-h-10"
            >
              Unarchive
            </Button>
          )}
          {confirmingDelete ? (
            <div className="rounded border border-line p-2">
              <p>Delete this task and all its updates? This cannot be undone.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  busy={actionBusy === 'delete'}
                  onClick={() => void removeTask()}
                  className="min-h-10"
                >
                  Delete
                </Button>
                <Button onClick={() => setConfirmingDelete(false)} className="min-h-10">
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="danger" onClick={() => setConfirmingDelete(true)} className="min-h-10">
              Delete task
            </Button>
          )}
        </div>
      </section>

      {!archived && task.status !== 'done' && (
        <DataState resource={assignees.resource}>
          {(assigneeData) => (
            <DataState resource={destinations.resource}>
              {(destData) => (
                <EditForm
                  task={task}
                  assignees={assigneeData.assignees}
                  destinations={destData.destinations}
                  onReload={onReload}
                  onStale={onStale}
                />
              )}
            </DataState>
          )}
        </DataState>
      )}

      <StepsSection task={task} children={data.children} onReload={onReload} onStale={onStale} />
      <ReportsSection task={task} reports={data.reports} nameOf={nameOf} onReload={onReload} />
      <RemindersSection
        task={task}
        reminders={data.reminders}
        onReload={onReload}
        onStale={onStale}
      />
    </div>
  );
}

function EditForm({
  task,
  assignees,
  destinations,
  onReload,
  onStale,
}: {
  task: Task;
  assignees: Assignee[];
  destinations: Destination[];
  onReload: () => void;
  onStale: () => void;
}) {
  const session = useSession();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [due, setDue] = useState(() => utcToZonedLocal(task.dueAt, task.timezone));
  const [timezone, setTimezone] = useState(task.timezone);
  const [priority, setPriority] = useState<'normal' | 'urgent'>(task.priority);
  const [assignmentKind, setAssignmentKind] = useState<'team' | 'individual'>(task.assignmentKind);
  const [assigneeIds, setAssigneeIds] = useState<string[]>(task.assigneeIds);
  const [destinationId, setDestinationId] = useState(task.destinationId);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const zones = COMMON_TIME_ZONES.includes(timezone)
    ? COMMON_TIME_ZONES
    : [...COMMON_TIME_ZONES, timezone];

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      setError('Enter a title for the task.');
      return;
    }
    if (!due) {
      setError('Choose a due date and time.');
      return;
    }
    if (!destinationId) {
      setError('Choose a destination channel or thread.');
      return;
    }
    if (assignmentKind === 'individual' && assigneeIds.length === 0) {
      setError('Choose at least one assignee, or assign the whole team.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await session.writeOrThrow(
        `/api/tasks/${task.taskId}`,
        {
          version: task.version,
          title: title.trim(),
          description,
          priority,
          assignmentKind,
          ...(assignmentKind === 'individual' ? { assigneeIds } : {}),
          dueAt: zonedLocalToUtc(due, timezone),
          timezone,
          destinationId,
        },
        'PUT',
      );
      if (result === undefined) return;
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
      setError(err instanceof ApiError ? describeError(err).message : 'Could not save the task.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void save(event)}
      className="grid gap-3 rounded border border-line bg-panel p-4 text-sm"
    >
      <h2 className="font-semibold">Edit task</h2>
      {error && <p role="alert">{error}</p>}
      <label className="grid gap-1">
        Title
        <input
          value={title}
          maxLength={180}
          onChange={(e) => setTitle(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="grid gap-1">
        Description
        <textarea
          value={description}
          maxLength={5000}
          onChange={(e) => setDescription(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="grid gap-1">
        Due date and time ({timezone})
        <input
          type="datetime-local"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="grid gap-1">
        Timezone
        <select
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className={inputClass}
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        Priority
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as 'normal' | 'urgent')}
          className={inputClass}
        >
          <option value="normal">Normal</option>
          <option value="urgent">Urgent</option>
        </select>
      </label>
      <label className="grid gap-1">
        Assignment
        <select
          value={assignmentKind}
          onChange={(e) => {
            setAssignmentKind(e.target.value as 'team' | 'individual');
            setAssigneeIds([]);
          }}
          className={inputClass}
        >
          <option value="team">Whole team</option>
          <option value="individual">Named members</option>
        </select>
      </label>
      {assignmentKind === 'individual' && (
        <label className="grid gap-1">
          Members
          <select
            multiple
            value={assigneeIds}
            onChange={(e) =>
              setAssigneeIds(Array.from(e.target.selectedOptions, (option) => option.value))
            }
            className={`${inputClass} min-h-20`}
          >
            {assignees.map((m) => (
              <option key={m.memberId} value={m.memberId}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="grid gap-1">
        Destination
        <select
          value={destinationId}
          onChange={(e) => setDestinationId(e.target.value)}
          className={inputClass}
        >
          <option value="">Choose channel or thread</option>
          {destinations.map((d) => (
            <option key={d.channelId} value={d.channelId}>
              {destinationLabel(d)}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" variant="primary" busy={busy} className="min-h-10">
        Save changes
      </Button>
    </form>
  );
}

function StepsSection({
  task,
  children,
  onReload,
  onStale,
}: {
  task: Task;
  children: Child[];
  onReload: () => void;
  onStale: () => void;
}) {
  const session = useSession();
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editDue, setEditDue] = useState('');

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
    setBusy(true);
    setError('');
    try {
      await session.writeOrThrow(
        `/api/tasks/${task.taskId}/children/${childId}`,
        { version: task.version },
        'DELETE',
      );
      onReload();
    } catch (err) {
      fail(err, 'Could not delete the step.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded border border-line bg-panel p-4 text-sm">
      <h2 className="font-semibold">Dated steps</h2>
      {error && (
        <p role="alert" className="mt-1">
          {error}
        </p>
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
                    <input
                      value={editTitle}
                      maxLength={180}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className={inputClass}
                    />
                  </label>
                  <label className="grid gap-1">
                    Step date and time
                    <input
                      type="datetime-local"
                      value={editDue}
                      onChange={(e) => setEditDue(e.target.value)}
                      className={inputClass}
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
                    onClick={() => void remove(child.childId)}
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
          <input
            value={title}
            maxLength={180}
            onChange={(e) => setTitle(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="grid gap-1">
          Step date and time ({task.timezone})
          <input
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className={inputClass}
          />
        </label>
        <Button type="submit" busy={busy} className="min-h-10">
          Add step
        </Button>
      </form>
    </section>
  );
}

function ReportsSection({
  task,
  reports,
  nameOf,
  onReload,
}: {
  task: Task;
  reports: Report[];
  nameOf: (memberId: string) => string | undefined;
  onReload: () => void;
}) {
  const session = useSession();
  const [confirming, setConfirming] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const remove = async (reportId: string) => {
    setBusy(true);
    setError('');
    try {
      await session.writeOrThrow(
        `/api/tasks/${task.taskId}/reports/${reportId}`,
        undefined,
        'DELETE',
      );
      setConfirming('');
      onReload();
    } catch (err) {
      setError(
        err instanceof ApiError ? describeError(err).message : 'Could not delete the update.',
      );
    } finally {
      setBusy(false);
    }
  };

  const sorted = [...reports].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <section className="rounded border border-line bg-panel p-4 text-sm">
      <h2 className="font-semibold">Progress reports</h2>
      {error && (
        <p role="alert" className="mt-1">
          {error}
        </p>
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
              {confirming === report.reportId ? (
                <div className="mt-2">
                  <p>Delete this update?</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      variant="danger"
                      busy={busy}
                      onClick={() => void remove(report.reportId)}
                      className="min-h-10"
                    >
                      Delete
                    </Button>
                    <Button onClick={() => setConfirming('')} className="min-h-10">
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button onClick={() => setConfirming(report.reportId)} className="mt-2 min-h-10">
                  Delete
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RemindersSection({
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
    <section className="rounded border border-line bg-panel p-4 text-sm">
      <h2 className="font-semibold">Reminders</h2>
      {error && (
        <p role="alert" className="mt-1">
          {error}
        </p>
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
          <input
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
            className={inputClass}
          />
        </label>
        <Button type="submit" busy={busy} className="min-h-10">
          Add reminder
        </Button>
      </form>
    </section>
  );
}
