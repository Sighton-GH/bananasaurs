import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import { useResource } from '../hooks/useResource.js';
import { useSession } from '../app/session.js';
import { ApiError } from '../api.js';
import { describeError } from '../api/describe-error.js';
import { Button } from '../ui/Button.js';
import { DataState } from '../ui/DataState.js';
import { PageHeader } from '../ui/PageHeader.js';
import { COMMON_TIME_ZONES, zonedLocalToUtc } from '../lib/zoned-time.js';
import { destinationLabel, inputClass } from '../lib/task-form.js';

type Team = { teamId: string; name: string; categoryId: string };
type Snapshot = { teams: Team[] };
type Destination = { channelId: string; name: string; kind: string; parentName?: string };

const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** Owner-only task creation. Members use Discord; saving never posts to Discord itself. */
export function TaskCreatePage() {
  const session = useSession();
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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState('');

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

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamId) {
      setError('Choose a team for the task.');
      return;
    }
    if (!title.trim()) {
      setError('Enter a title for the task.');
      return;
    }
    if (!due) {
      setError('Choose a due date and time.');
      return;
    }
    if (!destination) {
      setError('Choose a destination channel or thread.');
      return;
    }
    if (assignmentKind === 'individual' && assigneeIds.length === 0) {
      setError('Choose at least one assignee, or assign the whole team.');
      return;
    }
    if (extras.some((extra) => !extra)) {
      setError('Fill in every extra reminder time, or remove the empty rows.');
      return;
    }
    setBusy(true);
    setError('');
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
        ...(extras.length > 0
          ? { extraReminderAt: extras.map((extra) => zonedLocalToUtc(extra, timezone)) }
          : {}),
      });
      if (result === undefined) return;
      setCreatedId(result.taskId);
    } catch (err) {
      setError(err instanceof ApiError ? describeError(err).message : 'Could not save the task.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="New task"
        purpose="Assign a task to a team or member. Posts go out only when the operator turns on task posts."
        actions={
          <Link href="/tasks" className="text-sm underline">
            Back to tasks
          </Link>
        }
      />
      {session.info.instanceOwner !== true ? (
        <p role="status">
          Only the instance owner can set up tasks until member identity and role checks are
          complete.
        </p>
      ) : (
        <DataState resource={teams.resource}>
          {(data) => (
            <>
              {createdId ? (
                <p role="status" className="rounded border border-line bg-panel p-3 text-sm">
                  Task saved.{' '}
                  <Link href={`/tasks/${createdId}`} className="underline">
                    View task
                  </Link>
                </p>
              ) : (
                <form
                  onSubmit={(e) => void save(e)}
                  className="grid max-w-xl gap-3 rounded border border-line bg-panel p-4 text-sm"
                >
                  {error && <p role="alert">{error}</p>}
                  <label className="grid gap-1">
                    Team
                    <select
                      value={teamId}
                      onChange={(e) => {
                        setTeamId(e.target.value);
                        setDestination('');
                        setAssigneeIds([]);
                      }}
                      className={inputClass}
                    >
                      <option value="">Choose team</option>
                      {data.teams.map((t) => (
                        <option key={t.teamId} value={t.teamId}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1">
                    Task title
                    <input
                      maxLength={180}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      className={inputClass}
                    />
                  </label>
                  <label className="grid gap-1">
                    Description
                    <textarea
                      maxLength={5000}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className={inputClass}
                    />
                  </label>
                  <label className="grid gap-1">
                    Due date and time
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
                    Destination
                    <select
                      value={destination}
                      onChange={(e) => setDestination(e.target.value)}
                      className={inputClass}
                    >
                      <option value="">Choose channel or thread</option>
                      {destinations.resource.state === 'ready' &&
                        destinations.resource.data.destinations.map((d) => (
                          <option key={d.channelId} value={d.channelId}>
                            {destinationLabel(d)}
                          </option>
                        ))}
                    </select>
                  </label>
                  {destinations.resource.state === 'error' && (
                    <p role="alert">Could not load destinations for this team.</p>
                  )}
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
                          setAssigneeIds(
                            Array.from(e.target.selectedOptions, (option) => option.value),
                          )
                        }
                        className={inputClass}
                      >
                        {assignees.resource.state === 'ready' &&
                          assignees.resource.data.assignees.map((m) => (
                            <option key={m.memberId} value={m.memberId}>
                              {m.displayName}
                            </option>
                          ))}
                      </select>
                      {assignees.resource.state === 'error' && (
                        <span role="alert">Could not check team membership.</span>
                      )}
                    </label>
                  )}
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
                  <fieldset className="grid gap-2">
                    <legend className="font-medium">Extra reminders (up to 20)</legend>
                    {extras.map((extra, index) => (
                      <div key={index} className="grid gap-2">
                        <label className="grid gap-1">
                          Extra reminder {index + 1}
                          <input
                            type="datetime-local"
                            value={extra}
                            onChange={(e) =>
                              setExtras((prev) =>
                                prev.map((row, i) => (i === index ? e.target.value : row)),
                              )
                            }
                            className={inputClass}
                          />
                        </label>
                        <Button
                          onClick={() => setExtras((prev) => prev.filter((_, i) => i !== index))}
                          className="min-h-10 justify-self-start"
                        >
                          Remove reminder {index + 1}
                        </Button>
                      </div>
                    ))}
                    {extras.length < 20 && (
                      <Button
                        onClick={() => setExtras((prev) => [...prev, ''])}
                        className="min-h-10 justify-self-start"
                      >
                        Add reminder
                      </Button>
                    )}
                  </fieldset>
                  <p className="text-xs text-ink-muted">
                    Times are entered in the timezone above. Saving does not post to Discord; posts
                    go out only when the operator turns on task posts.
                  </p>
                  <Button type="submit" variant="primary" busy={busy} className="min-h-10">
                    Save task
                  </Button>
                </form>
              )}
            </>
          )}
        </DataState>
      )}
    </>
  );
}
