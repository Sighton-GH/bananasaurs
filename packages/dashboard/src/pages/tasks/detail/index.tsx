import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderTaskCard } from '@bananasaurs/core';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import { useResource } from '../../../hooks/useResource.js';
import { useSession } from '../../../app/session.js';
import { ApiError, mayManageTasks } from '../../../api.js';
import { describeError } from '../../../api/describe-error.js';
import { useToast } from '../../../ui/Toast.js';
import { Badge, type BadgeTone } from '../../../ui/Badge.js';
import { Button } from '../../../ui/Button.js';
import { ConfirmDialog } from '../../../ui/ConfirmDialog.js';
import { DescriptionList } from '../../../ui/DescriptionList.js';
import { DiscordCardPreview } from '../../../ui/DiscordCardPreview.js';
import { InlineAlert } from '../../../ui/InlineAlert.js';
import { TabPanel, Tabs } from '../../../ui/Tabs.js';
import { buildPreviewView, previewLinks } from '../preview-view.js';
import { DataState } from '../../../ui/DataState.js';
import { PageHeader } from '../../../ui/PageHeader.js';
import { formatInZone } from '../../../lib/zoned-time.js';
import { type Detail, type Assignee, type Destination, STATUS_LABEL } from './types.js';
import { EditForm } from './edit-form.js';
import { StepsSection } from './steps.js';
import { ReportsSection } from './progress.js';
import { RemindersSection } from './reminders.js';

/** Task detail for the owner and accounts with Manage club tasks (ADR 0130). Members use Discord; nothing here posts to Discord. */
const TAB_IDS = ['overview', 'steps', 'progress', 'reminders'] as const;
type TabId = (typeof TAB_IDS)[number];
const STATUS_TONE: Record<string, BadgeTone> = {
  not_started: 'neutral',
  in_progress: 'progress',
  awaiting_approval: 'hold',
  done: 'ok',
};

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const session = useSession();
  const detailLoad = useCallback(
    () => session.read<Detail>(`/api/tasks/${taskId}`),
    [session, taskId],
  );
  const detail = useResource('task', detailLoad);
  // Removing a step or report reloads the task, which remounts the sections;
  // the page keeps the heading to land on and focuses it once the data is back.
  const landOn = useRef('');
  useEffect(() => {
    if (detail.resource.state !== 'ready' || landOn.current === '') return;
    const target = document.getElementById(landOn.current);
    landOn.current = '';
    target?.focus();
  }, [detail.resource.state]);
  const [notice, setNotice] = useState('');
  const [location, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const rawTab = params.get('tab');
  const tab: TabId = TAB_IDS.includes(rawTab as TabId) ? (rawTab as TabId) : 'overview';
  const selectTab = (next: string) => {
    const nextParams = new URLSearchParams(search);
    nextParams.set('tab', next);
    const hash = typeof window === 'undefined' ? '' : window.location.hash;
    navigate(`${location}?${nextParams.toString()}${hash}`);
  };

  if (!mayManageTasks(session.info)) {
    return (
      <>
        <PageHeader
          title="Task"
          purpose="One piece of club work, with its steps and progress."
          crumbs={[{ label: 'Tasks', href: '/tasks' }]}
        />
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
        title={detail.resource.state === 'ready' ? detail.resource.data.task.title : 'Task'}
        purpose="One piece of club work, with its steps and progress."
        crumbs={[{ label: 'Tasks', href: '/tasks' }]}
        actions={
          <Link href="/tasks" className="text-small text-accent underline underline-offset-2">
            Back to tasks
          </Link>
        }
        status={
          detail.resource.state === 'ready' ? (
            <Badge tone={STATUS_TONE[detail.resource.data.task.status] ?? 'neutral'}>
              {STATUS_LABEL[detail.resource.data.task.status] ?? detail.resource.data.task.status}
              {detail.resource.data.task.archivedAt !== null && ' (archived)'}
            </Badge>
          ) : undefined
        }
      />
      {notice && (
        <InlineAlert tone="info" title="Reloaded">
          {notice}
        </InlineAlert>
      )}
      <DataState resource={detail.resource}>
        {(data) => (
          <TaskDetail
            onRemoved={(headingId) => {
              landOn.current = headingId;
            }}
            key={`${data.task.taskId}:${data.task.version}`}
            data={data}
            tab={tab}
            onTab={selectTab}
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
  tab,
  onTab,
  onReload,
  onStale,
  onRemoved,
}: {
  data: Detail;
  tab: TabId;
  onTab: (tab: string) => void;
  onReload: () => void;
  onStale: () => void;
  onRemoved: (headingId: string) => void;
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
    if (actionBusy !== '') return;
    setActionBusy('delete');
    setActionError('');
    try {
      await session.writeOrThrow(
        `/api/tasks/${task.taskId}`,
        { version: task.version },
        'DELETE',
        deleteFailureStatuses,
      );
      navigate('/tasks');
    } catch (err) {
      if (toastDeleteRefusal(err)) return;
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
      setConfirmingDelete(false);
      setActionBusy('');
    }
  };

  const editable = !archived && task.status !== 'done';
  const [clock] = useState(() => Date.now());
  const previewComponents = useMemo(
    () =>
      task.updatedAt === undefined
        ? []
        : renderTaskCard(
            buildPreviewView({
              title: task.title,
              description: task.description,
              teamName: team?.name ?? '',
              priority: task.priority,
              dueAt: task.dueAt,
              audience:
                task.assignmentKind === 'individual' && task.assigneeIds.length > 0
                  ? { kind: 'users', userIds: task.assigneeIds }
                  : { kind: 'team' },
              links: previewLinks(data.links),
              now: clock,
              saved: {
                taskId: task.taskId,
                version: task.version,
                status: task.status,
                updatedAt: task.updatedAt,
              },
            }),
          ).components,
    [task, team, data.links, clock],
  );
  const editHere = () => {
    const form = document.getElementById('edit-task');
    form?.scrollIntoView?.({ block: 'start' });
    document.getElementById('field-title')?.focus();
  };

  return (
    <div className="grid min-w-0 gap-4">
      <Tabs
        value={tab}
        onValueChange={onTab}
        aria-label="Task sections"
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'steps', label: 'Steps' },
          { value: 'progress', label: 'Progress' },
          { value: 'reminders', label: 'Reminders' },
        ]}
      >
        <TabPanel value="overview">
          <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
            <div className="grid min-w-0 content-start gap-6">
              <section className="grid gap-3 rounded-panel border border-line bg-panel p-4 text-body">
                <h2 className="text-section font-semibold">{task.title}</h2>
                {task.description && (
                  <p className="whitespace-pre-wrap text-ink-muted">{task.description}</p>
                )}
                {data.links.length > 0 && (
                  <ul className="flex flex-wrap gap-2" aria-label="Links">
                    {data.links.map((link, index) => (
                      <li key={`${link.url}:${index}`}>
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline"
                        >
                          {link.label} ↗
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                <DescriptionList
                  columns={2}
                  items={[
                    { term: 'Team', value: team?.name ?? task.teamId },
                    {
                      term: 'Status',
                      value: `${STATUS_LABEL[task.status] ?? task.status}${archived ? ' (archived)' : ''}`,
                    },
                    { term: 'Priority', value: task.priority === 'urgent' ? 'Urgent' : 'Normal' },
                    { term: 'Due', value: formatInZone(task.dueAt, task.timezone) },
                    ...(task.createdAt === undefined
                      ? []
                      : [{ term: 'Created', value: formatInZone(task.createdAt, task.timezone) }]),
                    ...(task.updatedAt === undefined
                      ? []
                      : [{ term: 'Updated', value: formatInZone(task.updatedAt, task.timezone) }]),
                    {
                      term: 'Assignees',
                      value:
                        task.assignmentKind === 'team' ? (
                          'Whole team'
                        ) : (
                          <DataState resource={assignees.resource}>
                            {(names) =>
                              task.assigneeIds.length === 0
                                ? 'None'
                                : task.assigneeIds
                                    .map(
                                      (id) =>
                                        names.assignees.find((a) => a.memberId === id)
                                          ?.displayName ?? id,
                                    )
                                    .join(', ')
                            }
                          </DataState>
                        ),
                    },
                    {
                      term: 'Destination',
                      value: (
                        <DataState resource={destinations.resource}>
                          {(destData) =>
                            destData.destinations.find((d) => d.channelId === task.destinationId)
                              ?.name ?? task.destinationId
                          }
                        </DataState>
                      ),
                    },
                  ]}
                />
                {actionError && (
                  <InlineAlert tone="danger" title="That did not work">
                    {actionError}
                  </InlineAlert>
                )}
                <div className="flex flex-wrap gap-2">
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
                          void act('reject', `/api/tasks/${task.taskId}/reject`, {
                            version: task.version,
                          })
                        }
                        className="min-h-10"
                      >
                        Send back
                      </Button>
                    </>
                  )}
                  {(task.status === 'not_started' || task.status === 'in_progress') &&
                    !archived && (
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
                  <Button
                    variant="danger"
                    onClick={() => setConfirmingDelete(true)}
                    className="min-h-10"
                  >
                    Delete task
                  </Button>
                </div>
                {editable && (
                  <div>
                    <Button onClick={editHere}>Edit</Button>
                  </div>
                )}
                <ConfirmDialog
                  open={confirmingDelete}
                  title={`Delete task "${task.title}"?`}
                  scope={<p>Delete this task and all its updates? This cannot be undone.</p>}
                  confirmLabel="Delete"
                  danger
                  busy={actionBusy === 'delete'}
                  onConfirm={() => void removeTask()}
                  onCancel={() => {
                    if (actionBusy !== 'delete') setConfirmingDelete(false);
                  }}
                />
              </section>
              {editable && (
                <DataState resource={assignees.resource}>
                  {(assigneeData) => (
                    <DataState resource={destinations.resource}>
                      {(destData) => (
                        <EditForm
                          task={task}
                          links={data.links}
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
            </div>
            <aside aria-labelledby="task-preview-heading" className="min-w-0">
              <h2 id="task-preview-heading" className="mb-2 text-section font-semibold">
                Preview
              </h2>
              <p className="mb-2 text-small text-ink-muted">
                How the card may look in Discord. Nothing is posted from this page.
              </p>
              {task.updatedAt === undefined ? (
                <p>Updated time was not recorded; the saved Discord card preview is unavailable.</p>
              ) : (
                <DiscordCardPreview
                  components={previewComponents}
                  now={clock}
                  timeZone={task.timezone}
                  userNames={
                    assignees.resource.state === 'ready'
                      ? Object.fromEntries(
                          assignees.resource.data.assignees.map((m) => [m.memberId, m.displayName]),
                        )
                      : {}
                  }
                  indicateExternalLinks
                />
              )}
            </aside>
          </div>
        </TabPanel>
        <TabPanel value="steps">
          <StepsSection
            task={task}
            children={data.children}
            onReload={onReload}
            onStale={onStale}
            onRemoved={onRemoved}
          />
        </TabPanel>
        <TabPanel value="progress">
          <ReportsSection
            task={task}
            reports={data.reports}
            nameOf={nameOf}
            onReload={onReload}
            onRemoved={onRemoved}
          />
        </TabPanel>
        <TabPanel value="reminders">
          <RemindersSection
            task={task}
            reminders={data.reminders}
            onReload={onReload}
            onStale={onStale}
          />
        </TabPanel>
      </Tabs>
    </div>
  );
}
