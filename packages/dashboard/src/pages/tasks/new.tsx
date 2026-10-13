import { taskErrorSummary } from './form-errors.js';
import { useCallback, useMemo, useState } from 'react';
import { renderTaskCard } from '@bananasaurs/core';
import { useLocation } from 'wouter';
import { useResource } from '../../hooks/useResource.js';
import { useFieldErrors } from '../../hooks/useFieldErrors.js';
import { useSession } from '../../app/session.js';
import { ApiError, mayManageTasks } from '../../api.js';
import { Button } from '../../ui/Button.js';
import { DataState } from '../../ui/DataState.js';
import { DiscordCardPreview } from '../../ui/DiscordCardPreview.js';
import { ErrorSummary } from '../../ui/ErrorSummary.js';
import { Checkbox, Field, Input } from '../../ui/Field.js';
import { FormSection } from '../../ui/FormSection.js';
import { InlineAlert } from '../../ui/InlineAlert.js';
import { Link } from '../../ui/Link.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { RadioGroup } from '../../ui/RadioGroup.js';
import { Select } from '../../ui/Select.js';
import { Textarea } from '../../ui/Textarea.js';
import { TaskPostsBanner, type TaskPosts } from '../../ui/TaskPostsBanner.js';
import { describeError } from '../../api/describe-error.js';
import { COMMON_TIME_ZONES, zonedLocalToUtc } from '../../lib/zoned-time.js';
import { destinationLabel } from '../../lib/task-form.js';
import {
  cleanLinks,
  LinkListEditor,
  validateLinks,
  type LinkRow,
} from '../../ui/LinkListEditor.js';
import { buildPreviewView, guardedDueAt, previewLinks } from './preview-view.js';

type Team = { teamId: string; name: string; categoryId: string };
type Snapshot = { teams: Team[]; taskPosts?: TaskPosts };
type Destination = { channelId: string; name: string; kind: string; parentName?: string };
type Problem = { readonly path: string; readonly message: string };

const MAX_ASSIGNEES = 25;
const DESCRIPTION_MAX = 5000;
const fieldId = (path: string): string => `field-${path.replaceAll('.', '-')}`;

const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** Task creation for the owner and accounts with Manage club tasks (ADR 0130). Members use Discord; creating a task here never posts to Discord itself. */
export function TaskCreatePage() {
  const session = useSession();
  const [, navigate] = useLocation();
  const load = useCallback(() => session.read<Snapshot>('/api/tasks'), [session]);
  const teams = useResource('teams', load);
  const [teamId, setTeamId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [due, setDue] = useState('');
  const [timezone, setTimezone] = useState(browserZone);
  const [destination, setDestination] = useState('');
  const [assignmentKind, setAssignmentKind] = useState<'team' | 'individual'>('team');
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [priority, setPriority] = useState<'normal' | 'urgent'>('normal');
  const [extras, setExtras] = useState<string[]>([]);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [linkErrors, setLinkErrors] = useState<string[]>([]);
  const [problems, setProblems] = useState<readonly Problem[]>([]);
  const [summaryKey, setSummaryKey] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState('');
  const fieldErrors = useFieldErrors();
  // One explicit clock for the card preview, so it does not flicker as time passes.
  const [clock] = useState(() => Date.now());

  const destinationsLoad = useCallback(
    () =>
      teamId
        ? session.read<{ destinations: Destination[] }>(`/api/tasks/teams/${teamId}/destinations`)
        : Promise.resolve({ destinations: [] as Destination[] }),
    [session, teamId],
  );
  const destinations = useResource('destinations', destinationsLoad);
  const assigneesLoad = useCallback(
    () =>
      teamId
        ? session.read<{ assignees: { memberId: string; displayName: string }[] }>(
            `/api/tasks/teams/${teamId}/assignees`,
          )
        : Promise.resolve({ assignees: [] }),
    [session, teamId],
  );
  const assignees = useResource('team assignees', assigneesLoad);

  const zones = COMMON_TIME_ZONES.includes(timezone)
    ? COMMON_TIME_ZONES
    : [...COMMON_TIME_ZONES, timezone];

  const errorFor = (path: string): string | undefined =>
    fieldErrors.errorFor(path) ?? problems.find((p) => p.path === path)?.message;
  const eProps = (path: string): { error?: string } => {
    const message = errorFor(path);
    return message === undefined ? {} : { error: message };
  };
  const memberIdList: string[] =
    assignees.resource.state === 'ready'
      ? assignees.resource.data.assignees.map((m) => m.memberId)
      : [];
  /** The server's assigneeIds.<n> indexes the POSTed (selected) ids; point it at that person's checkbox. */
  const mapAssigneeTarget = (entry: { fieldId: string; message: string }) => {
    const hit = /^field-assigneeIds-(\d+)$/.exec(entry.fieldId);
    if (!hit) return entry;
    const selected = assigneeIds[Number(hit[1])];
    const at = selected === undefined ? -1 : memberIdList.indexOf(selected);
    return {
      ...entry,
      fieldId: at >= 0 ? fieldId(`assigneeIds.${String(at)}`) : fieldId('assigneeIds'),
    };
  };
  const summary = taskErrorSummary(
    [
      ...fieldErrors.summary.map(mapAssigneeTarget),
      ...problems.map((p) => ({ fieldId: fieldId(p.path), message: p.message })),
    ],
    assignees.resource.state === 'ready' ? assignees.resource.data.assignees : [],
  );
  /** Clears the problem on one field the moment the person edits it. */
  const edited = (path: string) => {
    fieldErrors.clear(path);
    setProblems((current) => current.filter((p) => p.path !== path));
  };
  /** Selection changed, so every assigneeIds.<n> index is stale. */
  const editedAssignees = () => {
    edited('assigneeIds');
    for (const entry of fieldErrors.summary) {
      const hit = /^field-assigneeIds-(\d+)$/.exec(entry.fieldId);
      if (hit) fieldErrors.clear(`assigneeIds.${hit[1] ?? ''}`);
    }
  };
  const linkFieldErrors = (index: number): { label?: string; url?: string } => {
    const client = linkErrors[index] ?? '';
    const clientOnUrl = /URL|https/.test(client);
    const label =
      (clientOnUrl ? '' : client) || fieldErrors.errorFor(`links.${String(index)}.label`) || '';
    const url =
      (clientOnUrl ? client : '') || fieldErrors.errorFor(`links.${String(index)}.url`) || '';
    return { ...(label ? { label } : {}), ...(url ? { url } : {}) };
  };

  const teamName = (id: string, data: Snapshot): string =>
    data.teams.find((t) => t.teamId === id)?.name ?? '';
  const previewDue = guardedDueAt(due, timezone);
  const previewComponents = useMemo(
    () => (data: Snapshot) =>
      previewDue === undefined
        ? []
        : renderTaskCard(
            buildPreviewView({
              title,
              description,
              teamName: teamName(teamId, data),
              priority,
              dueAt: previewDue,
              audience:
                assignmentKind === 'individual' && assigneeIds.length > 0
                  ? { kind: 'users', userIds: assigneeIds }
                  : { kind: 'team' },
              links: previewLinks(links),
              now: clock,
            }),
          ).components,
    [title, description, teamId, priority, previewDue, assignmentKind, assigneeIds, links, clock],
  );

  const reject = (found: readonly Problem[], message = '') => {
    setProblems(found);
    setError(message);
    setSummaryKey((k) => k + 1);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    fieldErrors.clear();
    const found: Problem[] = [];
    if (!teamId) found.push({ path: 'teamId', message: 'Choose a team for the task.' });
    if (!title.trim()) found.push({ path: 'title', message: 'Enter a title for the task.' });
    if (!due) found.push({ path: 'dueAt', message: 'Choose a due date and time.' });
    if (!destination)
      found.push({ path: 'destinationId', message: 'Choose a destination channel or thread.' });
    if (assignmentKind === 'individual' && assigneeIds.length === 0)
      found.push({
        path: 'assigneeIds',
        message: 'Choose at least one person, or assign the whole team.',
      });
    const emptyExtra = extras.findIndex((extra) => !extra);
    if (emptyExtra >= 0)
      found.push({
        path: `extraReminderAt.${String(emptyExtra)}`,
        message: 'Fill in every extra reminder time, or remove the empty rows.',
      });
    const errors = validateLinks(links);
    setLinkErrors(errors);
    errors.forEach((message, index) => {
      if (message !== '')
        found.push({
          path: `links.${index}.${/URL|https/.test(message) ? 'url' : 'label'}`,
          message,
        });
    });
    if (found.length > 0) {
      reject(found);
      return;
    }
    setBusy(true);
    setError('');
    setProblems([]);
    try {
      const result = await session.writeOrThrow<{ taskId: string }>('/api/tasks', {
        teamId,
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        priority,
        assignmentKind,
        ...(assignmentKind === 'individual' ? { assigneeIds } : {}),
        dueAt: zonedLocalToUtc(due, timezone),
        timezone,
        destinationId: destination,
        ...(cleanLinks(links).length > 0 ? { links: cleanLinks(links) } : {}),
        ...(extras.length > 0
          ? { extraReminderAt: extras.map((extra) => zonedLocalToUtc(extra, timezone)) }
          : {}),
      });
      if (result === undefined) return;
      setCreatedId(result.taskId);
    } catch (err) {
      // Input stays exactly as typed; only the explanation changes.
      const hadFields = fieldErrors.capture(err);
      setSummaryKey((k) => k + 1);
      setError(
        hadFields
          ? ''
          : err instanceof ApiError
            ? describeError(err).message
            : 'Could not create the task.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="New task"
        purpose="Assign a task to a team or to specific people."
        crumbs={[{ label: 'Tasks', href: '/tasks' }]}
        actions={<Button onClick={() => navigate('/tasks')}>Back to tasks</Button>}
      />
      {!mayManageTasks(session.info) ? (
        <p role="status">
          Setting up tasks needs the owner, or the Manage club tasks permission. Members use
          Discord.
        </p>
      ) : (
        <DataState
          resource={teams.resource}
          isEmpty={(data) => data.teams.length === 0}
          empty={
            <InlineAlert tone="hold" title="No teams yet">
              A task belongs to a team. <Link href="/tasks/teams">Add a team</Link> first.
            </InlineAlert>
          }
        >
          {(data) => (
            <>
              <TaskPostsBanner posts={data.taskPosts} />
              {createdId ? (
                <p role="status" className="rounded-panel border border-line bg-panel p-3">
                  Task saved. <Link href={`/tasks/${createdId}`}>View task</Link>
                </p>
              ) : (
                <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
                  <form onSubmit={(e) => void save(e)} className="grid min-w-0 gap-6" noValidate>
                    <ErrorSummary key={summaryKey} errors={summary} />
                    {error && (
                      <InlineAlert tone="danger" title="The task was not created">
                        {error}
                      </InlineAlert>
                    )}
                    <FormSection title="What" description="What needs doing.">
                      <Field label="Task title" {...eProps('title')}>
                        <Input
                          id={fieldId('title')}
                          maxLength={180}
                          value={title}
                          onChange={(e) => {
                            setTitle(e.target.value);
                            edited('title');
                          }}
                        />
                      </Field>
                      <Field
                        label="Description"
                        hint="Descriptions can be 5000 characters or fewer."
                        optional
                        htmlFor={fieldId('description')}
                        {...eProps('description')}
                      >
                        <Textarea
                          showCount
                          maxLength={DESCRIPTION_MAX}
                          value={description}
                          onChange={(e) => {
                            setDescription(e.target.value);
                            edited('description');
                          }}
                        />
                      </Field>
                    </FormSection>
                    <FormSection title="Who" description="Which team, and who on it.">
                      <Field label="Team" {...eProps('teamId')}>
                        <Select
                          id={fieldId('teamId')}
                          value={teamId === '' ? undefined : teamId}
                          placeholder="Choose team"
                          onValueChange={(value) => {
                            setTeamId(value);
                            setDestination('');
                            setAssigneeIds([]);
                            edited('teamId');
                          }}
                          options={data.teams.map((t) => ({ value: t.teamId, label: t.name }))}
                        />
                      </Field>
                      <RadioGroup
                        legend="Audience"
                        name="audience"
                        id={fieldId('assignmentKind')}
                        {...eProps('assignmentKind')}
                        value={assignmentKind}
                        onChange={(value) => {
                          setAssignmentKind(value as 'team' | 'individual');
                          setAssigneeIds([]);
                          editedAssignees();
                          edited('assignmentKind');
                        }}
                        options={[
                          { value: 'team', label: 'Whole team' },
                          { value: 'individual', label: 'Specific people' },
                        ]}
                      />
                      {assignmentKind === 'individual' && (
                        <fieldset id={fieldId('assigneeIds')} tabIndex={-1} className="grid gap-2">
                          <legend className="mb-1 text-small text-ink-muted">
                            People (up to {MAX_ASSIGNEES})
                          </legend>
                          {assignees.resource.state === 'ready' &&
                            assignees.resource.data.assignees.map((m, index) => (
                              <div key={m.memberId}>
                                <Checkbox
                                  id={fieldId(`assigneeIds.${String(index)}`)}
                                  label={m.displayName}
                                  checked={assigneeIds.includes(m.memberId)}
                                  disabled={
                                    !assigneeIds.includes(m.memberId) &&
                                    assigneeIds.length >= MAX_ASSIGNEES
                                  }
                                  onChange={(e) => {
                                    setAssigneeIds((prev) =>
                                      e.target.checked
                                        ? [...prev, m.memberId]
                                        : prev.filter((id) => id !== m.memberId),
                                    );
                                    editedAssignees();
                                  }}
                                />
                                {assigneeIds.includes(m.memberId) &&
                                  errorFor(
                                    `assigneeIds.${String(assigneeIds.indexOf(m.memberId))}`,
                                  ) !== undefined && (
                                    <p
                                      role="alert"
                                      className="ml-6 text-small text-tone-danger-ink"
                                    >
                                      {errorFor(
                                        `assigneeIds.${String(assigneeIds.indexOf(m.memberId))}`,
                                      )}
                                    </p>
                                  )}
                              </div>
                            ))}
                          {assignees.resource.state === 'ready' &&
                            assignees.resource.data.assignees.length === 0 && (
                              <p className="text-small text-ink-muted">
                                {teamId === ''
                                  ? 'Choose a team to see its people.'
                                  : 'No verified members on this team yet.'}
                              </p>
                            )}
                          {assignees.resource.state === 'error' && (
                            <p role="alert" className="text-small text-tone-danger-ink">
                              Could not check team membership.
                            </p>
                          )}
                          {errorFor('assigneeIds') !== undefined && (
                            <p role="alert" className="text-small text-tone-danger-ink">
                              {errorFor('assigneeIds')}
                            </p>
                          )}
                        </fieldset>
                      )}
                      <Field label="Destination" {...eProps('destinationId')}>
                        <Select
                          id={fieldId('destinationId')}
                          value={destination === '' ? undefined : destination}
                          placeholder="Choose channel or thread"
                          onValueChange={(value) => {
                            setDestination(value);
                            edited('destinationId');
                          }}
                          options={
                            destinations.resource.state === 'ready'
                              ? destinations.resource.data.destinations.map((d) => ({
                                  value: d.channelId,
                                  label: destinationLabel(d),
                                }))
                              : []
                          }
                        />
                      </Field>
                      {destinations.resource.state === 'error' && (
                        <p role="alert" className="text-small text-tone-danger-ink">
                          Could not load destinations for this team.
                        </p>
                      )}
                    </FormSection>
                    <FormSection title="When" description="Due time, priority and reminders.">
                      <Field label="Due date and time" {...eProps('dueAt')}>
                        <Input
                          id={fieldId('dueAt')}
                          type="datetime-local"
                          value={due}
                          onChange={(e) => {
                            setDue(e.target.value);
                            edited('dueAt');
                          }}
                        />
                      </Field>
                      <Field
                        label="Timezone"
                        hint="Times on this form are entered in this timezone."
                        {...eProps('timezone')}
                      >
                        <Select
                          id={fieldId('timezone')}
                          value={timezone}
                          onValueChange={(value) => {
                            setTimezone(value);
                            edited('timezone');
                          }}
                          options={zones.map((zone) => ({ value: zone, label: zone }))}
                        />
                      </Field>
                      <RadioGroup
                        legend="Priority"
                        name="priority"
                        id={fieldId('priority')}
                        {...eProps('priority')}
                        orientation="horizontal"
                        value={priority}
                        onChange={(value) => {
                          setPriority(value as 'normal' | 'urgent');
                          edited('priority');
                        }}
                        options={[
                          { value: 'normal', label: 'Normal' },
                          { value: 'urgent', label: 'Urgent' },
                        ]}
                      />
                      <fieldset className="grid gap-2">
                        <legend className="mb-1 text-small text-ink-muted">
                          Extra reminders (up to 20)
                        </legend>
                        {extras.map((extra, index) => (
                          <div key={index} className="grid gap-2">
                            <Field
                              label={`Extra reminder ${String(index + 1)}`}
                              {...eProps(`extraReminderAt.${String(index)}`)}
                            >
                              <Input
                                id={fieldId(`extraReminderAt.${String(index)}`)}
                                type="datetime-local"
                                value={extra}
                                onChange={(e) => {
                                  setExtras((prev) =>
                                    prev.map((row, i) => (i === index ? e.target.value : row)),
                                  );
                                  edited(`extraReminderAt.${String(index)}`);
                                }}
                              />
                            </Field>
                            <Button
                              onClick={() => {
                                setExtras((prev) => prev.filter((_, i) => i !== index));
                                setProblems([]);
                                fieldErrors.clear();
                              }}
                              className="justify-self-start"
                            >
                              Remove reminder {index + 1}
                            </Button>
                          </div>
                        ))}
                        {extras.length < 20 && (
                          <Button
                            onClick={() => setExtras((prev) => [...prev, ''])}
                            className="justify-self-start"
                          >
                            Add reminder
                          </Button>
                        )}
                      </fieldset>
                    </FormSection>
                    <FormSection title="Links" description="Buttons on the task card.">
                      <p className="text-small text-ink-muted">
                        Link labels can be 34 characters or fewer.
                      </p>
                      <LinkListEditor
                        value={links}
                        onChange={(rows) => {
                          setLinks(rows);
                          setLinkErrors([]);
                          setProblems((current) =>
                            current.filter((p) => !p.path.startsWith('links.')),
                          );
                          for (const entry of fieldErrors.summary)
                            if (entry.fieldId.startsWith('field-links-'))
                              fieldErrors.clear(entry.fieldId.slice(6).replaceAll('-', '.'));
                        }}
                        errors={[]}
                        fieldErrors={links.map((_, index) => linkFieldErrors(index))}
                      />
                    </FormSection>
                    <div>
                      <Button type="submit" variant="primary" busy={busy}>
                        Create task
                      </Button>
                    </div>
                  </form>
                  <aside aria-labelledby="task-preview-heading" className="min-w-0">
                    <h2 id="task-preview-heading" className="mb-2 text-section font-semibold">
                      Preview
                    </h2>
                    <p className="mb-2 text-small text-ink-muted">
                      How the card may look in Discord. Nothing is posted from this page.
                    </p>
                    {previewDue === undefined ? (
                      <div className="rounded-panel border border-line bg-panel p-3">
                        <p>
                          Choose a complete due date and timezone to see the Discord card. No due
                          date is shown yet.
                        </p>
                        <h3 className="font-semibold">{title.trim() || 'Untitled task'}</h3>
                        <p className="whitespace-pre-wrap">{description}</p>
                        <p>{teamName(teamId, data) || 'Team not chosen'}</p>
                        <p>
                          {assignmentKind === 'team'
                            ? 'Whole team'
                            : assigneeIds
                                .map((id) =>
                                  assignees.resource.state === 'ready'
                                    ? (assignees.resource.data.assignees.find(
                                        (m) => m.memberId === id,
                                      )?.displayName ?? `Unresolved user ${id}`)
                                    : `Unresolved user ${id}`,
                                )
                                .join(', ') || 'No people chosen'}
                        </p>
                        {previewLinks(links).map((link, i) => (
                          <a
                            key={i}
                            className="mr-2 underline"
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {link.label} (opens in a new tab)
                          </a>
                        ))}
                        <p className="text-small text-ink-muted">
                          Art shown here is a stand-in; Discord shows the card art.
                        </p>
                      </div>
                    ) : (
                      <DiscordCardPreview
                        components={previewComponents(data)}
                        now={clock}
                        timeZone={timezone}
                        userNames={
                          assignees.resource.state === 'ready'
                            ? Object.fromEntries(
                                assignees.resource.data.assignees.map((m) => [
                                  m.memberId,
                                  m.displayName,
                                ]),
                              )
                            : {}
                        }
                        indicateExternalLinks
                      />
                    )}
                  </aside>
                </div>
              )}
            </>
          )}
        </DataState>
      )}
    </>
  );
}
