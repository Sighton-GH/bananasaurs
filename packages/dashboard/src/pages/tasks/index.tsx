import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useResource } from '../../hooks/useResource.js';
import { useSession } from '../../app/session.js';
import { mayManageTasks } from '../../api.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { DataState } from '../../ui/DataState.js';
import { DataTable, type Column } from '../../ui/DataTable.js';
import { DropdownMenu } from '../../ui/DropdownMenu.js';
import { Field, Input } from '../../ui/Field.js';
import { Link } from '../../ui/Link.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Select } from '../../ui/Select.js';
import { InlineAlert } from '../../ui/InlineAlert.js';
import { Empty } from '../../ui/states.js';
import type { TaskPosts } from '../../ui/TaskPostsBanner.js';
import { formatInZone } from '../../lib/zoned-time.js';
import { TaskPostsSwitch } from './posts-switch.js';
import { relativeWhen, STATUS_TONE, STATUS_WORDS } from './format.js';

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
  createdAt?: number;
  updatedAt?: number;
};
export type Snapshot = {
  teams: Team[];
  tasks: Task[];
  presidentRoleId: string | null;
  taskPosts?: TaskPosts;
};

const ALL = '__all';
type StatusFilter = 'open' | 'done' | 'archived' | 'all';
const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All' },
] as const;

const byUrgencyThenDue = (a: Task, b: Task): number => {
  if (a.priority !== b.priority) return a.priority === 'urgent' ? -1 : 1;
  return a.dueAt - b.dueAt;
};

const matchesStatus = (task: Task, filter: StatusFilter): boolean =>
  filter === 'all'
    ? true
    : filter === 'archived'
      ? task.archivedAt !== null
      : filter === 'done'
        ? task.archivedAt === null && task.status === 'done'
        : task.archivedAt === null && task.status !== 'done';

/** Task list for the owner and accounts with Manage club tasks (ADR 0130). Members use Discord; the dashboard never promises live sends. */
export function TasksPage() {
  const session = useSession();
  const [, navigate] = useLocation();
  const [teamId, setTeamId] = useState(ALL);
  const [status, setStatus] = useState<StatusFilter>('open');
  const [search, setSearch] = useState('');
  const [archiveError, setArchiveError] = useState('');
  const [archiveBusy, setArchiveBusy] = useState('');
  const pendingArchive = useRef<Task | null>(null);
  const archiveRowId = useRef('');
  const [archiving, setArchiving] = useState<Task | null>(null);
  const load = useCallback(
    () => session.read<Snapshot>('/api/tasks?include=done,archived'),
    [session],
  );
  const resource = useResource('tasks', load);
  const restoreAfterReload = useRef(false);
  // Radix close autofocus can run from an unmount callback captured before reload.
  // Read current loading state through a ref, then restore the replacement row
  // once the snapshot finishes, rather than leaving focus on the fallback.
  const listLoading = useRef(false);
  listLoading.current = resource.resource.state === 'loading';
  const focusTarget = () =>
    document.getElementById(`task-actions-${archiveRowId.current}`)?.querySelector('button') ??
    document.getElementById('task-list-status') ??
    document.getElementById('task-list-new');
  useEffect(() => {
    if (archiving === null && resource.resource.state !== 'loading' && restoreAfterReload.current) {
      restoreAfterReload.current = false;
      focusTarget()?.focus();
    }
  }, [archiving, resource.resource]);

  if (!mayManageTasks(session.info)) {
    return (
      <>
        <PageHeader title="Tasks" purpose="Tasks your teams are working on" />
        <p role="status">
          Viewing tasks here needs the owner, or the Manage club tasks permission. Members use
          Discord.
        </p>
      </>
    );
  }

  const archive = async (task: Task) => {
    setArchiveBusy(task.taskId);
    setArchiveError('');
    try {
      const result = await session.write(
        `/api/tasks/${task.taskId}/archive`,
        { version: task.version },
        'POST',
      );
      if (result) resource.reload();
    } catch {
      setArchiveError('Could not archive the task.');
    } finally {
      setArchiveBusy('');
      setArchiving(null);
    }
  };

  const clearFilters = () => {
    setTeamId(ALL);
    setStatus('open');
    setSearch('');
  };
  const now = Date.now();

  return (
    <>
      <PageHeader
        title="Tasks"
        purpose="Tasks your teams are working on"
        actions={
          <div className="flex items-center gap-2">
            <Button id="task-list-new" variant="primary" onClick={() => navigate('/tasks/new')}>
              New task
            </Button>
            <DropdownMenu
              label="More task actions"
              items={[
                { label: 'Teams & members', onSelect: () => navigate('/tasks/teams') },
                { label: 'Guide', onSelect: () => navigate('/docs#tasks') },
              ]}
            />
          </div>
        }
      />
      <p className="mb-3 text-small text-ink-muted">
        Members use Discord. The owner sees every team. Accounts with Manage club tasks can use this
        dashboard according to their server permissions.
      </p>
      {archiveError && (
        <InlineAlert tone="danger" title="The task was not archived">
          {archiveError}
        </InlineAlert>
      )}
      <DataState resource={resource.resource}>
        {(data) => {
          const teamName = (id: string): string =>
            data.teams.find((t) => t.teamId === id)?.name ?? 'Unknown team';
          const needle = search.trim().toLowerCase();
          const shown = data.tasks
            .filter((t) => teamId === ALL || t.teamId === teamId)
            .filter((t) => matchesStatus(t, status))
            .filter((t) => needle === '' || t.title.toLowerCase().includes(needle))
            .sort(byUrgencyThenDue);
          const columns: Column<Task>[] = [
            {
              key: 'title',
              header: 'Title',
              cell: (task) => (
                <span className="flex flex-wrap items-center gap-2">
                  <Link href={`/tasks/${task.taskId}`}>{task.title}</Link>
                  {task.priority === 'urgent' && <Badge tone="danger">Urgent</Badge>}
                </span>
              ),
            },
            {
              key: 'team',
              header: 'Team',
              cell: (task) => (
                <span className="[overflow-wrap:normal] break-words">{teamName(task.teamId)}</span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (task) =>
                task.archivedAt !== null ? (
                  <span className="[overflow-wrap:normal] break-words">
                    <Badge tone="neutral">Archived</Badge>
                  </span>
                ) : (
                  <span className="[overflow-wrap:normal] break-words">
                    <Badge tone={STATUS_TONE[task.status]}>{STATUS_WORDS[task.status]}</Badge>
                  </span>
                ),
            },
            {
              key: 'due',
              header: 'Due',
              cell: (task) => {
                const overdue =
                  task.dueAt < now && task.status !== 'done' && task.archivedAt === null;
                return (
                  <span
                    className={`[overflow-wrap:normal] break-words ${overdue ? 'text-tone-danger-ink' : ''}`}
                  >
                    <time
                      dateTime={new Date(task.dueAt).toISOString()}
                      title={formatInZone(task.dueAt, task.timezone)}
                    >
                      {relativeWhen(task.dueAt, now)}
                    </time>
                    {overdue && <strong className="ml-1 font-medium">Overdue</strong>}
                  </span>
                );
              },
            },
            {
              key: 'updated',
              header: 'Updated',
              cell: (task) =>
                task.updatedAt === undefined ? (
                  'Not recorded'
                ) : (
                  <time
                    dateTime={new Date(task.updatedAt).toISOString()}
                    title={formatInZone(task.updatedAt, task.timezone)}
                  >
                    {relativeWhen(task.updatedAt, now)}
                  </time>
                ),
            },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              mobileLabel: 'Actions',
              cell: (task) => (
                <span id={`task-actions-${task.taskId}`}>
                  <DropdownMenu
                    label={`Actions for ${task.title}`}
                    onCloseAutoFocus={(event) => {
                      // Open only after menu close autofocus, so it cannot steal
                      // focus back from the dialog or capture a detached menu item.
                      const selected = pendingArchive.current;
                      if (selected === null) return;
                      event.preventDefault();
                      pendingArchive.current = null;
                      archiveRowId.current = selected.taskId;
                      setArchiving(selected);
                    }}
                    items={[
                      { label: 'Open', onSelect: () => navigate(`/tasks/${task.taskId}`) },
                      {
                        label: 'Archive',
                        disabled: task.archivedAt !== null || archiveBusy === task.taskId,
                        onSelect: () => {
                          pendingArchive.current = task;
                        },
                      },
                    ]}
                  />
                </span>
              ),
            },
          ];
          return (
            <>
              {data.taskPosts && (
                <TaskPostsSwitch posts={data.taskPosts} onChanged={resource.reload} />
              )}
              {data.teams.length === 0 ? (
                <Empty
                  title="No teams yet"
                  detail="Tasks belong to a team. Add a team first."
                  action={<Link href="/tasks/teams">Teams &amp; members</Link>}
                />
              ) : data.tasks.length === 0 ? (
                <Empty
                  title="No tasks yet"
                  detail="Tasks you create appear here, with their team, status and due date."
                  action={
                    <Button
                      id="task-list-new"
                      variant="primary"
                      onClick={() => navigate('/tasks/new')}
                    >
                      New task
                    </Button>
                  }
                />
              ) : (
                <>
                  <div className="mb-3 grid gap-3 sm:grid-cols-3">
                    <Field label="Team">
                      <Select
                        value={teamId}
                        onValueChange={setTeamId}
                        options={[
                          { value: ALL, label: 'All teams' },
                          ...data.teams.map((t) => ({ value: t.teamId, label: t.name })),
                        ]}
                      />
                    </Field>
                    <Field label="Status">
                      <Select
                        id="task-list-status"
                        value={status}
                        onValueChange={(v) => setStatus(v as StatusFilter)}
                        options={STATUS_OPTIONS}
                      />
                    </Field>
                    <Field label="Search by title">
                      <Input
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </Field>
                  </div>
                  <p role="status" className="mb-2 text-small text-ink-muted">
                    {shown.length} of {data.tasks.length} tasks shown
                  </p>
                  {shown.length === 0 ? (
                    <Empty
                      title="No tasks match these filters"
                      action={<Button onClick={clearFilters}>Clear filters</Button>}
                    />
                  ) : (
                    <DataTable
                      caption="Tasks"
                      columns={columns}
                      rows={shown}
                      rowKey={(task) => task.taskId}
                    />
                  )}
                </>
              )}
            </>
          );
        }}
      </DataState>
      <ConfirmDialog
        open={archiving !== null}
        returnFocus={() => {
          restoreAfterReload.current = listLoading.current;
          return focusTarget();
        }}
        title="Archive this task?"
        scope={
          archiving === null ? (
            ''
          ) : (
            <>
              Archives &ldquo;{archiving.title}&rdquo; ({teamNameFor(resource, archiving.teamId)}).
              It leaves the Open list and stays under Archived.
            </>
          )
        }
        confirmLabel="Archive task"
        busy={archiving !== null && archiveBusy === archiving.taskId}
        onConfirm={() => archiving !== null && void archive(archiving)}
        onCancel={() => setArchiving(null)}
      />
    </>
  );
}

function teamNameFor(resource: ReturnType<typeof useResource<Snapshot>>, teamId: string): string {
  const r = resource.resource;
  return r.state === 'ready'
    ? (r.data.teams.find((t) => t.teamId === teamId)?.name ?? 'Unknown team')
    : 'Unknown team';
}
