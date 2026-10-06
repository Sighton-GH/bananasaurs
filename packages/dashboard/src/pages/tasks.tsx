import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import { useResource } from '../hooks/useResource.js';
import { useSession } from '../app/session.js';
import { mayManageTasks } from '../api.js';
import { Button } from '../ui/Button.js';
import { DataState } from '../ui/DataState.js';
import { PageHeader } from '../ui/PageHeader.js';
import { formatInZone } from '../lib/zoned-time.js';

type Team = {
  teamId: string;
  name: string;
  kind: 'subteam' | 'exec';
  categoryId: string;
  announcementChannelId?: string | null;
  leadRoleId?: string | null;
  memberRoleId?: string | null;
};
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
type Snapshot = {
  teams: Team[];
  tasks: Task[];
  presidentRoleId: string | null;
};

const STATUS_LABEL: Record<Task['status'], string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  awaiting_approval: 'Awaiting approval',
  done: 'Done',
};

const byUrgencyThenDue = (a: Task, b: Task): number => {
  if (a.priority !== b.priority) return a.priority === 'urgent' ? -1 : 1;
  return a.dueAt - b.dueAt;
};

/** Owner-only board. Members use Discord; the dashboard never promises live sends. */
export function TasksPage() {
  const session = useSession();
  const [teamId, setTeamId] = useState('');
  const [archiveBusy, setArchiveBusy] = useState('');
  const load = useCallback(
    () => session.read<Snapshot>('/api/tasks?include=done,archived'),
    [session],
  );
  const resource = useResource('tasks', load);

  if (!mayManageTasks(session.info)) {
    return (
      <>
        <PageHeader
          title="Tasks"
          purpose="A place to check what is due, who owns it, and what needs review."
        />
        <p role="status">
          Viewing tasks here needs the owner, or the Manage club tasks permission. Members use
          Discord.
        </p>
      </>
    );
  }

  const archive = async (task: Task) => {
    setArchiveBusy(task.taskId);
    try {
      const result = await session.write(
        `/api/tasks/${task.taskId}/archive`,
        { version: task.version },
        'POST',
      );
      if (result) resource.reload();
    } finally {
      setArchiveBusy('');
    }
  };

  return (
    <>
      <PageHeader
        title="Tasks"
        purpose="A place to check what is due, who owns it, and what needs review."
        actions={
          <>
            <Link href="/tasks/new" className="text-sm text-blue-700 underline">
              New task
            </Link>
            <Link href="/tasks/teams" className="text-sm text-blue-700 underline">
              Teams &amp; members
            </Link>
            <Link href="/docs#tasks" className="text-sm text-blue-700 underline">
              How tasks work
            </Link>
          </>
        }
      />
      <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-slate-800">
        A task belongs to one team and may have dated steps. Members use Discord for their
        team&apos;s tasks; the owner sees every team here.
      </div>
      <div
        className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-slate-800"
        role="status"
      >
        Discord posts (announcements, reminders, review requests) go out only when the operator
        turns on task posts.
      </div>
      <DataState resource={resource.resource}>
        {(data) => {
          const visibleTasks = data.tasks.filter((t) => !teamId || t.teamId === teamId);
          const openTasks = visibleTasks.filter(
            (t) => t.archivedAt === null && t.status !== 'done',
          );
          return (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <label htmlFor="task-team" className="text-sm font-medium">
                  Team
                </label>
                <select
                  id="task-team"
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                  className="min-h-10 rounded border border-line bg-panel px-2 py-1 text-sm"
                >
                  <option value="">All teams</option>
                  {data.teams.map((t) => (
                    <option key={t.teamId} value={t.teamId}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-ink-muted">{openTasks.length} open</span>
              </div>
              {data.teams.length === 0 ? (
                <p className="rounded border border-line bg-panel p-4 text-sm">
                  No teams have been configured. Add one under Teams &amp; members.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {data.teams
                    .filter((t) => !teamId || t.teamId === teamId)
                    .map((team) => {
                      const open = data.tasks
                        .filter(
                          (t) =>
                            t.teamId === team.teamId &&
                            t.archivedAt === null &&
                            t.status !== 'done',
                        )
                        .sort(byUrgencyThenDue);
                      const done = data.tasks
                        .filter(
                          (t) =>
                            t.teamId === team.teamId &&
                            t.archivedAt === null &&
                            t.status === 'done',
                        )
                        .sort(byUrgencyThenDue);
                      const archived = data.tasks
                        .filter((t) => t.teamId === team.teamId && t.archivedAt !== null)
                        .sort(byUrgencyThenDue);
                      return (
                        <section
                          key={team.teamId}
                          className="min-w-0 rounded border border-line bg-panel p-3"
                        >
                          <h2 className="mb-2 text-base font-semibold">
                            {team.name}{' '}
                            <span className="text-xs font-normal text-ink-muted">
                              {team.kind === 'exec' ? 'Exec' : 'Subteam'} · {open.length} open
                            </span>
                          </h2>
                          {open.length === 0 && done.length === 0 && archived.length === 0 ? (
                            <p className="text-sm text-ink-muted">No tasks yet</p>
                          ) : (
                            <>
                              <ul className="space-y-2">
                                {open.map((task) => (
                                  <TaskCard key={task.taskId} task={task} />
                                ))}
                              </ul>
                              {done.length > 0 && (
                                <details className="mt-2">
                                  <summary className="min-h-10 cursor-pointer text-sm text-blue-700 underline">
                                    Done ({done.length})
                                  </summary>
                                  <ul className="mt-1 space-y-2">
                                    {done.map((task) => (
                                      <li
                                        key={task.taskId}
                                        className="rounded border border-line px-3 py-2 text-sm"
                                      >
                                        <Link
                                          href={`/tasks/${task.taskId}`}
                                          className="block min-h-10 font-medium text-blue-700 underline"
                                        >
                                          {task.title}
                                        </Link>
                                        <p className="mt-1 text-xs text-ink-muted">
                                          {STATUS_LABEL[task.status]} · Due{' '}
                                          {formatInZone(task.dueAt, task.timezone)}
                                        </p>
                                        <Button
                                          busy={archiveBusy === task.taskId}
                                          onClick={() => void archive(task)}
                                          className="mt-2 min-h-10"
                                        >
                                          Archive
                                        </Button>
                                      </li>
                                    ))}
                                  </ul>
                                </details>
                              )}
                              {archived.length > 0 && (
                                <details className="mt-2">
                                  <summary className="min-h-10 cursor-pointer text-sm text-blue-700 underline">
                                    Archived ({archived.length})
                                  </summary>
                                  <ul className="mt-1 space-y-2">
                                    {archived.map((task) => (
                                      <li
                                        key={task.taskId}
                                        className="rounded border border-line px-3 py-2 text-sm"
                                      >
                                        <Link
                                          href={`/tasks/${task.taskId}`}
                                          className="block min-h-10 font-medium text-blue-700 underline"
                                        >
                                          {task.title}
                                        </Link>
                                        <p className="mt-1 text-xs text-ink-muted">
                                          {STATUS_LABEL[task.status]} · Archived{' '}
                                          {task.archivedAt !== null
                                            ? formatInZone(task.archivedAt, task.timezone)
                                            : ''}
                                        </p>
                                      </li>
                                    ))}
                                  </ul>
                                </details>
                              )}
                            </>
                          )}
                        </section>
                      );
                    })}
                </div>
              )}
            </>
          );
        }}
      </DataState>
    </>
  );
}

function TaskCard({ task }: { task: Task }) {
  const overdue = task.dueAt < Date.now();
  return (
    <li className="rounded border border-line px-3 py-2 text-sm">
      <Link
        href={`/tasks/${task.taskId}`}
        className="block min-h-10 font-medium text-blue-700 underline"
      >
        {task.title}
      </Link>
      <p className="mt-1 text-xs text-ink-muted">
        {STATUS_LABEL[task.status]} ·{' '}
        {task.priority === 'urgent' ? (
          <strong className="text-ink">Urgent</strong>
        ) : (
          <span>Normal</span>
        )}{' '}
        · Due {formatInZone(task.dueAt, task.timezone)} ·{' '}
        {task.assignmentKind === 'team' ? (
          <span>Whole team</span>
        ) : (
          <span>{task.assigneeIds.length} member(s)</span>
        )}{' '}
        {overdue && <strong className="text-ink">(overdue)</strong>}
      </p>
    </li>
  );
}
