import { taskErrorSummary } from '../form-errors.js';
import { useState } from 'react';
import { useSession } from '../../../app/session.js';
import { ApiError } from '../../../api.js';
import { describeError } from '../../../api/describe-error.js';
import { Button } from '../../../ui/Button.js';
import { ErrorSummary } from '../../../ui/ErrorSummary.js';
import { Checkbox, Field, Input } from '../../../ui/Field.js';
import { FormSection } from '../../../ui/FormSection.js';
import { InlineAlert } from '../../../ui/InlineAlert.js';
import { RadioGroup } from '../../../ui/RadioGroup.js';
import { Select } from '../../../ui/Select.js';
import { Textarea } from '../../../ui/Textarea.js';
import { useFieldErrors } from '../../../hooks/useFieldErrors.js';
import { COMMON_TIME_ZONES, utcToZonedLocal, zonedLocalToUtc } from '../../../lib/zoned-time.js';
import { destinationLabel } from '../../../lib/task-form.js';
import {
  cleanLinks,
  LinkListEditor,
  validateLinks,
  type LinkRow,
} from '../../../ui/LinkListEditor.js';
import { type Task, type Assignee, type Destination } from './types.js';

type Problem = { readonly path: string; readonly message: string };
const fieldId = (path: string): string => `field-${path.replaceAll('.', '-')}`;

export function EditForm({
  task,
  links: initialLinks,
  assignees,
  destinations,
  onReload,
  onStale,
}: {
  task: Task;
  links: LinkRow[];
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
  const [links, setLinks] = useState<LinkRow[]>(initialLinks);
  const [linkErrors, setLinkErrors] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<readonly Problem[]>([]);
  const [summaryKey, setSummaryKey] = useState(0);
  const fieldErrors = useFieldErrors();
  const [busy, setBusy] = useState(false);
  const zones = COMMON_TIME_ZONES.includes(timezone)
    ? COMMON_TIME_ZONES
    : [...COMMON_TIME_ZONES, timezone];

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    fieldErrors.clear();
    const found: Problem[] = [];
    if (!title.trim()) found.push({ path: 'title', message: 'Enter a title for the task.' });
    if (!due) found.push({ path: 'dueAt', message: 'Choose a due date and time.' });
    if (!destinationId)
      found.push({ path: 'destinationId', message: 'Choose a destination channel or thread.' });
    if (assignmentKind === 'individual' && assigneeIds.length === 0)
      found.push({
        path: 'assigneeIds',
        message: 'Choose at least one assignee, or assign the whole team.',
      });
    const linkValidation = validateLinks(links);
    setLinkErrors(linkValidation);
    linkValidation.forEach((message, index) => {
      if (message !== '')
        found.push({
          path: `links.${index}.${/URL|https/.test(message) ? 'url' : 'label'}`,
          message,
        });
    });
    if (found.length > 0) {
      setProblems(found);
      setError('');
      setSummaryKey((k) => k + 1);
      return;
    }
    setBusy(true);
    setError('');
    setProblems([]);
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
          links: cleanLinks(links),
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
      const hadFields = fieldErrors.capture(err);
      setSummaryKey((k) => k + 1);
      setError(
        hadFields
          ? ''
          : err instanceof ApiError
            ? describeError(err).message
            : 'Could not save the task.',
      );
    } finally {
      setBusy(false);
    }
  };
  const errorFor = (path: string): string | undefined =>
    fieldErrors.errorFor(path) ?? problems.find((p) => p.path === path)?.message;
  const eProps = (path: string): { error?: string } => {
    const m = errorFor(path);
    return m === undefined ? {} : { error: m };
  };
  const memberIdList: string[] = assignees.map((m) => m.memberId);
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
    assignees,
  );
  const edited = (path: string) => {
    fieldErrors.clear(path);
    setProblems((c) => c.filter((p) => p.path !== path));
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

  return (
    <form
      id="edit-task"
      onSubmit={(event) => void save(event)}
      className="grid min-w-0 gap-6"
      noValidate
    >
      <h2 className="text-section font-semibold">Edit task</h2>
      <ErrorSummary key={summaryKey} errors={summary} />
      {error && (
        <InlineAlert tone="danger" title="The task was not saved">
          {error}
        </InlineAlert>
      )}
      <FormSection title="What" description="What needs doing.">
        <Field label="Title" {...eProps('title')}>
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
            maxLength={5000}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              edited('description');
            }}
          />
        </Field>
      </FormSection>
      <FormSection title="Who" description="Who it is for, and where it is posted.">
        <RadioGroup
          legend="Audience"
          name="edit-audience"
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
            <legend className="mb-1 text-small text-ink-muted">People (up to 25)</legend>
            {assignees.map((m, index) => (
              <div key={m.memberId}>
                <Checkbox
                  id={fieldId(`assigneeIds.${String(index)}`)}
                  label={m.displayName}
                  checked={assigneeIds.includes(m.memberId)}
                  disabled={!assigneeIds.includes(m.memberId) && assigneeIds.length >= 25}
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
                  errorFor(`assigneeIds.${String(assigneeIds.indexOf(m.memberId))}`) !==
                    undefined && (
                    <p role="alert" className="ml-6 text-small text-tone-danger-ink">
                      {errorFor(`assigneeIds.${String(assigneeIds.indexOf(m.memberId))}`)}
                    </p>
                  )}
              </div>
            ))}
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
            value={destinationId === '' ? undefined : destinationId}
            placeholder="Choose channel or thread"
            onValueChange={(value) => {
              setDestinationId(value);
              edited('destinationId');
            }}
            options={destinations.map((d) => ({
              value: d.channelId,
              label: destinationLabel(d),
            }))}
          />
        </Field>
      </FormSection>
      <FormSection title="When" description="Due time and priority.">
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
          hint="The due time is read in this timezone."
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
          name="edit-priority"
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
      </FormSection>
      <FormSection title="Links" description="Buttons on the task card.">
        <p className="text-small text-ink-muted">Link labels can be 34 characters or fewer.</p>
        <LinkListEditor
          value={links}
          onChange={(rows) => {
            setLinks(rows);
            setLinkErrors([]);
            setProblems((c) => c.filter((p) => !p.path.startsWith('links.')));
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
          Save changes
        </Button>
      </div>
    </form>
  );
}
