import { DraftFooter } from './draft-footer.js';
import { FormSection } from '../../ui/FormSection.js';
import { GroupErrors } from './field-summary.js';
import { useFieldErrors } from '../../hooks/useFieldErrors.js';
import { Empty } from '../../ui/states.js';
import { Moment } from './time.js';
import { Select } from '../../ui/Select.js';
import { useState } from 'react';
import { Link } from '../../ui/Link.js';
import {
  decisionReviewUrl,
  decisionSaveUrl,
  reminderCancelUrl,
  reminderUrl,
  type DecisionRow,
  type ReminderRecurrencePatternView,
  type ReminderView,
  type SkillItems,
} from '../../api/assistant.js';
import { useSession, type Session } from '../../app/session.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { DataTable } from '../../ui/DataTable.js';
import { ErrorNotice } from '../../ui/ErrorNotice.js';
import { Field, Input } from '../../ui/Field.js';
import { useToast } from '../../ui/Toast.js';
import { decisionTone, reminderTone } from '../assistant-shared.js';

/**
 * One skill's live items (Task E2): the reminders skill's reminders with
 * edit and cancel, the memory skill's proposals to review, and the decision
 * skill's draft and reviewed records. Rendered on the skill detail page
 * under the scope card; `none` renders nothing.
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** `repeats daily`, `repeats weekly on Mon, Wed`, … — the repeat in plain words. */
const recurrenceWords = (pattern: ReminderRecurrencePatternView): string => {
  switch (pattern.kind) {
    case 'daily':
      return 'daily';
    case 'weekdays':
      return 'weekdays';
    case 'weekly': {
      const days = [...pattern.days]
        .sort((a, b) => a - b)
        .map((day) => DAY_NAMES[day] ?? String(day))
        .join(', ');
      return pattern.everyWeeks > 1
        ? `weekly on ${days} every ${pattern.everyWeeks} weeks`
        : `weekly on ${days}`;
    }
    case 'monthly':
      return `monthly on day ${pattern.dayOfMonth}`;
  }
};

/** `@everyone`, `@here`, and the role and user counts — never parsed from the text. */
const pingsText = (mentions: ReminderView['mentions']): string => {
  const parts: string[] = [];
  if (mentions.everyone) parts.push('@everyone');
  if (mentions.here) parts.push('@here');
  if (mentions.roleIds.length > 0)
    parts.push(
      `${String(mentions.roleIds.length)} role${mentions.roleIds.length === 1 ? '' : 's'}`,
    );
  if (mentions.userIds.length > 0)
    parts.push(
      `${String(mentions.userIds.length)} user${mentions.userIds.length === 1 ? '' : 's'}`,
    );
  return parts.length === 0 ? '—' : parts.join(' · ');
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** ms since epoch as a `datetime-local` value in the operator's own time zone. */
const toLocalInput = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const fromLocalInput = (value: string): number | undefined => {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
};

type RecurrenceKind = ReminderRecurrencePatternView['kind'];

interface RecurrenceDraft {
  readonly kind: RecurrenceKind;
  readonly days: readonly number[];
  readonly everyWeeks: number;
  readonly dayOfMonth: number;
  readonly endAt: string;
  readonly maxCount: string;
}

const draftOf = (reminder: ReminderView): RecurrenceDraft | undefined => {
  if (reminder.recurrence === undefined) return undefined;
  const { pattern, endAt, maxCount } = reminder.recurrence;
  return {
    kind: pattern.kind,
    days: pattern.kind === 'weekly' ? pattern.days : [1],
    everyWeeks: pattern.kind === 'weekly' ? pattern.everyWeeks : 1,
    dayOfMonth: pattern.kind === 'monthly' ? pattern.dayOfMonth : 1,
    endAt: endAt === undefined ? '' : toLocalInput(endAt),
    maxCount: maxCount === undefined ? '' : String(maxCount),
  };
};

const patternOf = (draft: RecurrenceDraft): ReminderRecurrencePatternView => {
  switch (draft.kind) {
    case 'daily':
      return { kind: 'daily' };
    case 'weekdays':
      return { kind: 'weekdays' };
    case 'weekly':
      return {
        kind: 'weekly',
        days: [...draft.days].sort((a, b) => a - b),
        everyWeeks: draft.everyWeeks,
      };
    case 'monthly':
      return { kind: 'monthly', dayOfMonth: draft.dayOfMonth };
  }
};

const recurrenceBodyOf = (
  draft: RecurrenceDraft,
  original: ReminderView['recurrence'],
): { pattern: ReminderRecurrencePatternView; endAt?: number; maxCount?: number } => {
  const initialEndAtInput = original?.endAt === undefined ? '' : toLocalInput(original.endAt);
  const endAt =
    draft.endAt === initialEndAtInput
      ? original?.endAt
      : draft.endAt === ''
        ? undefined
        : fromLocalInput(draft.endAt);
  const parsedMax = Number.parseInt(draft.maxCount, 10);
  return {
    pattern: patternOf(draft),
    ...(endAt === undefined ? {} : { endAt }),
    ...(draft.maxCount.trim() === '' || Number.isNaN(parsedMax) ? {} : { maxCount: parsedMax }),
  };
};

/** The inline edit form for one scheduled reminder. PATCHes only the changed fields. */
function ReminderEditForm({
  reminder,
  session,
  onDone,
}: {
  readonly reminder: ReminderView;
  readonly session: Session;
  readonly onDone: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState(reminder.text);
  const [context, setContext] = useState(reminder.context ?? '');
  const [dueInput, setDueInput] = useState(toLocalInput(reminder.dueAt));
  const [draft, setDraft] = useState<RecurrenceDraft | undefined>(() => draftOf(reminder));
  const [initialRecurrence] = useState(() =>
    draftOf(reminder) === undefined
      ? undefined
      : JSON.stringify(recurrenceBodyOf(draftOf(reminder)!, reminder.recurrence)),
  );
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  const fields = useFieldErrors();
  const dirty =
    text !== reminder.text ||
    context !== (reminder.context ?? '') ||
    dueInput !== toLocalInput(reminder.dueAt) ||
    JSON.stringify(draft) !== JSON.stringify(draftOf(reminder));
  const discard = () => {
    setText(reminder.text);
    setContext(reminder.context ?? '');
    setDueInput(toLocalInput(reminder.dueAt));
    setDraft(draftOf(reminder));
    fields.clear();
    setError(undefined);
  };
  const weeklyValid = draft === undefined || draft.kind !== 'weekly' || draft.days.length > 0;

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setError(undefined);
    fields.clear();
    try {
      const result = await session.writeOrThrow(reminderUrl(reminder.id), patch, 'PATCH');
      if (result !== undefined) {
        toast({ tone: 'ok', title: 'Saved' });
        onDone();
      }
    } catch (err) {
      fields.capture(err);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const saveChanges = () => {
    const patch: Record<string, unknown> = {};
    if (text !== reminder.text) patch['text'] = text;
    const nextContext = context === '' ? null : context;
    if (nextContext !== (reminder.context ?? null)) patch['context'] = nextContext;
    const nextDue =
      dueInput === toLocalInput(reminder.dueAt) ? undefined : fromLocalInput(dueInput);
    if (nextDue !== undefined) patch['dueAt'] = nextDue;
    if (draft !== undefined && reminder.recurrence !== undefined) {
      const next = recurrenceBodyOf(draft, reminder.recurrence);
      if (JSON.stringify(next) !== initialRecurrence) patch['recurrence'] = next;
    }
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    void save(patch);
  };

  return (
    <Card title="Edit reminder">
      <FormSection title="Reminder details">
        <form
          id={`reminder-edit-${reminder.id}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (weeklyValid) saveChanges();
          }}
        >
          <GroupErrors
            errors={fields.summary}
            id="field-reminder-details"
            direct={{
              'field-text': 'field-reminder-text',
              'field-context': 'field-reminder-context',
              'field-dueAt': 'field-reminder-dueAt',
            }}
          />
          <div
            id="field-reminder-details"
            tabIndex={-1}
            aria-describedby="reminder-errors"
            className="grid gap-3"
          >
            <Field label="Message" htmlFor="field-reminder-text">
              <Input value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            <Field
              label="Context"
              htmlFor="field-reminder-context"
              hint="Why it was set. Empty clears it."
            >
              <Input value={context} onChange={(e) => setContext(e.target.value)} />
            </Field>
            <Field label="Date and time" htmlFor="field-reminder-dueAt">
              <Input
                type="datetime-local"
                value={dueInput}
                onChange={(e) => setDueInput(e.target.value)}
              />
            </Field>
            {draft !== undefined && (
              <>
                <Field label="Repeat">
                  <Select
                    value={draft.kind}
                    onValueChange={(next) => setDraft({ ...draft, kind: next as RecurrenceKind })}
                    options={['daily', 'weekdays', 'weekly', 'monthly'].map((value) => ({
                      value,
                      label: value[0]!.toUpperCase() + value.slice(1),
                    }))}
                  />
                </Field>
                {draft.kind === 'weekly' && (
                  <>
                    <fieldset>
                      <legend className="mb-1 block text-sm text-ink-muted">Days</legend>
                      <ul className="grid gap-1 sm:grid-cols-4">
                        {DAY_NAMES.map((name, day) => (
                          <li key={name}>
                            <label className="flex items-center gap-2 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm">
                              <input
                                type="checkbox"
                                checked={draft.days.includes(day)}
                                onChange={() =>
                                  setDraft({
                                    ...draft,
                                    days: draft.days.includes(day)
                                      ? draft.days.filter((d) => d !== day)
                                      : [...draft.days, day],
                                  })
                                }
                              />
                              {name}
                            </label>
                          </li>
                        ))}
                      </ul>
                    </fieldset>
                    <Field label="Every N weeks" hint="1 means every week.">
                      <Input
                        type="number"
                        min={1}
                        max={12}
                        value={String(draft.everyWeeks)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            everyWeeks: Math.min(
                              12,
                              Math.max(1, Number.parseInt(e.target.value, 10) || 1),
                            ),
                          })
                        }
                      />
                    </Field>
                  </>
                )}
                {draft.kind === 'monthly' && (
                  <Field label="Day of month" hint="1 to 31. Short months use their last day.">
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      value={String(draft.dayOfMonth)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          dayOfMonth: Math.min(
                            31,
                            Math.max(1, Number.parseInt(e.target.value, 10) || 1),
                          ),
                        })
                      }
                    />
                  </Field>
                )}
                <Field label="Repeat ends" hint="Empty means no end date.">
                  <Input
                    type="datetime-local"
                    value={draft.endAt}
                    onChange={(e) => setDraft({ ...draft, endAt: e.target.value })}
                  />
                </Field>
                <Field label="Max deliveries" hint="Empty means no limit.">
                  <Input
                    type="number"
                    min={1}
                    max={1000}
                    value={draft.maxCount}
                    onChange={(e) => setDraft({ ...draft, maxCount: e.target.value })}
                  />
                </Field>
                <div>
                  <Button busy={busy} onClick={() => void save({ recurrence: null })}>
                    Stop repeating
                  </Button>
                </div>
              </>
            )}
          </div>
          {error !== undefined && (
            <div className="mt-3">
              <ErrorNotice error={error} />
            </div>
          )}
          <p className="sr-only" id="reminder-errors">
            {fields.summary.map((e) => e.message).join(' ')}
          </p>
          <DraftFooter
            dirty={dirty}
            busy={busy}
            onDiscard={discard}
            onSave={() => {
              const form = document.getElementById(`reminder-edit-${reminder.id}`);
              if (form instanceof HTMLFormElement) form.requestSubmit();
            }}
          />
          <div className="mt-3 flex gap-2">
            <Button
              hidden={dirty}
              variant="primary"
              busy={busy}
              disabled={!weeklyValid}
              onClick={saveChanges}
            >
              Save
            </Button>
            <Button
              onClick={() => {
                if (!dirty || window.confirm('Discard reminder changes?')) onDone();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </FormSection>
    </Card>
  );
}

function RemindersCard({
  reminders,
  session,
  reload,
}: {
  readonly reminders: readonly ReminderView[];
  readonly session: Session;
  readonly reload: () => void;
}) {
  const toast = useToast();
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [cancelling, setCancelling] = useState<ReminderView | undefined>(undefined);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const visible = reminders.filter((r) =>
    `${r.text} ${r.context ?? ''} ${r.destinationName ?? r.destinationId} ${r.status}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const live = visible.filter((r) => r.status === 'scheduled' || r.status === 'delivering');
  const finished = visible.filter((r) => r.status !== 'scheduled' && r.status !== 'delivering');
  const editing = reminders.find((r) => r.id === editingId);

  const cancel = async () => {
    if (cancelling === undefined) return;
    setCancelBusy(true);
    try {
      const result = await session.write(reminderCancelUrl(cancelling.id), {}, 'POST');
      if (result !== undefined) {
        toast({ tone: 'ok', title: 'Reminder cancelled' });
        setCancelling(undefined);
        reload();
      }
    } finally {
      setCancelBusy(false);
    }
  };

  const table = (rows: readonly ReminderView[], liveActions: boolean) => (
    <DataTable
      caption={liveActions ? 'Active reminders' : 'Past reminders'}
      rows={rows}
      rowKey={(r) => r.id}
      columns={[
        {
          key: 'when',
          header: 'When',
          cell: (r) => (
            <span>
              {<Moment at={r.dueAt} />}
              {r.recurrence !== undefined && (
                <span className="block text-xs text-ink-muted">
                  repeats {recurrenceWords(r.recurrence.pattern)}
                </span>
              )}
            </span>
          ),
        },
        {
          key: 'message',
          header: 'Message',
          cell: (r) => (
            <span>
              {r.text}
              {r.context !== undefined && (
                <span className="block text-xs text-ink-muted">{r.context}</span>
              )}
            </span>
          ),
        },
        {
          key: 'where',
          header: 'Where',
          cell: (r) =>
            r.destinationName === undefined ? (
              <span className="font-mono text-xs">{r.destinationId}</span>
            ) : (
              `#${r.destinationName}`
            ),
        },
        { key: 'pings', header: 'Pings', cell: (r) => pingsText(r.mentions) },
        {
          key: 'setby',
          header: 'Set by',
          cell: (r) =>
            r.creatorName === undefined ? (
              <span className="font-mono text-xs">{r.creatorId}</span>
            ) : (
              r.creatorName
            ),
        },
        {
          key: 'status',
          header: 'Status',
          cell: (r) => <Badge tone={reminderTone(r.status)}>{r.status}</Badge>,
        },
        ...(liveActions
          ? [
              {
                key: 'action',
                header: 'Action',
                cell: (r: ReminderView) => (
                  <span className="flex flex-wrap gap-1">
                    {r.status === 'scheduled' && (
                      <Button onClick={() => setEditingId(r.id)}>Edit</Button>
                    )}
                    {r.status === 'scheduled' && (
                      <Button onClick={() => setCancelling(r)}>Cancel</Button>
                    )}
                  </span>
                ),
              },
            ]
          : []),
      ]}
    />
  );

  return (
    <div className="space-y-4">
      <Card title="Reminders">
        {reminders.length > 20 && (
          <Field label="Filter loaded reminders">
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} />
          </Field>
        )}
        {filter !== '' && visible.length > 0 && (
          <Button onClick={() => setFilter('')}>Clear filters</Button>
        )}
        {visible.length === 0 && filter !== '' && (
          <Empty
            title="No loaded reminders match"
            action={<Button onClick={() => setFilter('')}>Clear filters</Button>}
          />
        )}
        {live.length === 0 ? (
          <Empty
            title="No active reminders."
            action={<Button onClick={reload}>Refresh reminders</Button>}
          />
        ) : (
          table(live, true)
        )}
        {finished.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm underline">History</summary>
            <div className="mt-2">{table(finished, false)}</div>
          </details>
        )}
      </Card>
      {editing !== undefined && (
        <ReminderEditForm
          reminder={editing}
          session={session}
          onDone={() => {
            setEditingId(undefined);
            reload();
          }}
        />
      )}
      <ConfirmDialog
        open={cancelling !== undefined}
        title="Cancel reminder"
        scope={
          <p>
            Cancel this reminder? {cancelling !== undefined && `“${cancelling.text}”`} It will not
            be delivered.
          </p>
        }
        confirmLabel="Yes, cancel"
        danger
        busy={cancelBusy}
        onConfirm={() => void cancel()}
        onCancel={() => setCancelling(undefined)}
      />
    </div>
  );
}

function DecisionsCard({
  title,
  rows,
  kind,
  session,
  reload,
}: {
  readonly title: string;
  readonly rows: readonly DecisionRow[];
  readonly kind: 'memory-proposals' | 'decisions';
  readonly session: Session;
  readonly reload: () => void;
}) {
  const [filter, setFilter] = useState('');
  const visible = rows.filter((row) =>
    `${row.summary} ${row.requesterId} ${row.status}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <Card title={title}>
      {rows.length > 20 && (
        <Field label={`Filter loaded ${title.toLowerCase()}`}>
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} />
        </Field>
      )}
      {filter !== '' && visible.length > 0 && (
        <Button onClick={() => setFilter('')}>Clear filters</Button>
      )}
      {visible.length === 0 ? (
        <Empty
          title={filter === '' ? 'Nothing waiting for review.' : 'No loaded decisions match'}
          action={
            <Button onClick={() => (filter === '' ? reload() : setFilter(''))}>
              {filter === '' ? 'Refresh decisions' : 'Clear filters'}
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-2">
          {visible.map((row) => (
            <li key={row.id} className="rounded-md border border-line bg-canvas p-3">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 text-sm">{row.summary}</p>
                <Badge tone={decisionTone(row.status)}>{row.status}</Badge>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                Requested by <span className="font-mono">{row.requesterId}</span> ·{' '}
                {<Moment at={row.at} />}
              </p>
              <div className="mt-2">
                {kind === 'memory-proposals' ? (
                  <Link className="text-sm underline" href="/memory">
                    Review in Memory
                  </Link>
                ) : row.status === 'draft' ? (
                  <Button
                    onClick={() =>
                      void session
                        .write(decisionReviewUrl(row.id), {}, 'POST')
                        .then((result) => result !== undefined && reload())
                    }
                  >
                    Review
                  </Button>
                ) : row.status === 'reviewed' ? (
                  <Button
                    onClick={() =>
                      void session
                        .write(decisionSaveUrl(row.id), {}, 'POST')
                        .then((result) => result !== undefined && reload())
                    }
                  >
                    Save
                  </Button>
                ) : (
                  <span className="text-xs text-ink-muted">Saved</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function SkillItemsCard({
  items,
  reload,
}: {
  readonly items: SkillItems;
  readonly reload: () => void;
}) {
  const session = useSession();
  if (items.kind === 'none') return null;
  if (items.kind === 'reminders')
    return <RemindersCard reminders={items.reminders} session={session} reload={reload} />;
  if (items.kind === 'memory-proposals')
    return (
      <DecisionsCard
        title="Memory proposals"
        rows={items.proposals}
        kind="memory-proposals"
        session={session}
        reload={reload}
      />
    );
  return (
    <DecisionsCard
      title="Decisions"
      rows={items.decisions}
      kind="decisions"
      session={session}
      reload={reload}
    />
  );
}
