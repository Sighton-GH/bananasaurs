import { useUnsavedGuard } from '../hooks/useUnsavedGuard.js';
import { Empty } from '../ui/states.js';
import { mappedErrors } from './messages-assistant/field-summary.js';
import { DraftFooter } from './messages-assistant/draft-footer.js';
import { FormSection } from '../ui/FormSection.js';
import { Textarea } from '../ui/Textarea.js';
import { ErrorNotice } from '../ui/ErrorNotice.js';
import { ErrorSummary } from '../ui/ErrorSummary.js';
import { useFieldErrors } from '../hooks/useFieldErrors.js';
import { useCallback, useMemo, useState } from 'react';
import { AssistantDigestSettings } from '../components/assistant-digest-settings.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { Field, Input } from '../ui/Field.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

interface MemoryRow {
  readonly id: string;
  readonly section: string;
  readonly content: string;
  readonly subjectId?: string;
}
interface MemoryData {
  readonly members?: readonly { id: string; name: string }[];
  readonly serverCard: string;
  readonly memories: readonly MemoryRow[];
}

export function AssistantMemoryPage() {
  const session = useSession();
  const toast = useToast();
  const load = useCallback(() => session.read<MemoryData>('/api/assistant'), [session]);
  const memory = useResource('assistant memory', load);
  const [editing, setEditing] = useState<MemoryRow | 'new' | undefined>();
  const [section, setSection] = useState('Club goals');
  const [content, setContent] = useState('');
  const [serverCard, setServerCard] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const fields = useFieldErrors();
  const cardFields = useFieldErrors();
  const [cardError, setCardError] = useState<unknown>();
  const [entryBaseline, setEntryBaseline] = useState({ section: 'Club goals', content: '' });
  const entryDirty =
    editing !== undefined &&
    (section !== entryBaseline.section || content !== entryBaseline.content);
  const cardDirty =
    memory.resource.state === 'ready' &&
    serverCard !== undefined &&
    serverCard !== memory.resource.data.serverCard;
  const dirtyGuard = useUnsavedGuard(entryDirty || cardDirty);
  const [filter, setFilter] = useState('');
  const [memberFilter, setMemberFilter] = useState('');
  const sections = useMemo(
    () =>
      memory.resource.state === 'ready'
        ? [
            ...new Set(
              memory.resource.data.memories
                .filter((row) =>
                  `${row.section} ${row.content}`.toLowerCase().includes(filter.toLowerCase()),
                )
                .map((row) => row.section),
            ),
          ]
        : [],
    [memory.resource, filter],
  );
  const open = (row: MemoryRow | 'new') => {
    fields.clear();
    setError(undefined);
    setEntryBaseline({
      section: row === 'new' ? 'Club goals' : row.section,
      content: row === 'new' ? '' : row.content,
    });
    setEditing(row);
    setSection(row === 'new' ? 'Club goals' : row.section);
    setContent(row === 'new' ? '' : row.content);
  };
  const save = async () => {
    if (content.trim() === '' || busy) return;
    setBusy(true);
    setError(undefined);
    fields.clear();
    try {
      const id = editing === 'new' ? crypto.randomUUID() : editing?.id;
      if (id === undefined) return;
      const result = await session.writeOrThrow(
        `/api/assistant/memories/${encodeURIComponent(id)}`,
        {
          id,
          section: section.trim(),
          content: content.trim(),
          ...(editing !== undefined && editing !== 'new' && editing.subjectId !== undefined
            ? { subjectId: editing.subjectId }
            : {}),
        },
        'PUT',
        [400, 409, 500, 503],
      );
      if (result === undefined) return;
      setEditing(undefined);
      memory.reload();
      toast({ tone: 'ok', title: 'Memory saved' });
    } catch (err) {
      fields.capture(err);
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {dirtyGuard}
      <PageHeader
        title="Memory"
        purpose="Facts you have reviewed that the assistant may use."
        actions={
          <Button variant="primary" onClick={() => open('new')}>
            Add memory
          </Button>
        }
      />
      <DataState resource={memory.resource}>
        {(data) => (
          <div className="space-y-4">
            <AssistantDigestSettings />
            <Card title="Server card">
              <form
                id="server-card-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (busy) return;
                  void (async () => {
                    setBusy(true);
                    cardFields.clear();
                    setCardError(undefined);
                    try {
                      const result = await session.writeOrThrow(
                        '/api/assistant/server-card',
                        { content: serverCard ?? data.serverCard },
                        'PUT',
                      );
                      if (result !== undefined) {
                        setServerCard(undefined);
                        memory.reload();
                      }
                    } catch (err) {
                      cardFields.capture(err);
                      setCardError(err);
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              >
                <FormSection title="Server context">
                  <ErrorSummary
                    errors={mappedErrors(cardFields.summary, () => 'field-server-card')}
                  />
                  {cardError !== undefined && <ErrorNotice error={cardError} />}
                  <p className="mb-2 text-sm text-ink-muted">
                    Stable identity and operating context included in every API system prompt.
                  </p>
                  <Textarea
                    id="field-server-card"
                    aria-invalid={cardFields.errorFor('content') !== undefined}
                    aria-describedby="server-card-error"
                    aria-label="Server card"
                    className="min-h-28 w-full rounded-sm border border-line bg-canvas p-2 text-sm"
                    value={serverCard ?? data.serverCard}
                    onChange={(e) => setServerCard(e.target.value)}
                  />
                  <span
                    id="server-card-error"
                    role={cardFields.errorFor('content') === undefined ? undefined : 'alert'}
                  >
                    {cardFields.errorFor('content')}
                  </span>
                  <DraftFooter
                    guardEnabled={false}
                    dirty={serverCard !== undefined && serverCard !== data.serverCard}
                    busy={busy}
                    onDiscard={() => {
                      setServerCard(undefined);
                      cardFields.clear();
                      setCardError(undefined);
                    }}
                    onSave={() => {
                      const form = document.getElementById('server-card-form');
                      if (form instanceof HTMLFormElement) form.requestSubmit();
                    }}
                  />
                  <Button
                    type="submit"
                    hidden={serverCard !== undefined && serverCard !== data.serverCard}
                    busy={busy}
                  >
                    Save server card
                  </Button>
                </FormSection>
              </form>
            </Card>
            {data.memories.length > 20 && (
              <Field label="Filter loaded memory">
                <Input value={filter} onChange={(e) => setFilter(e.target.value)} />
              </Field>
            )}
            {filter !== '' && sections.length > 0 && (
              <Button onClick={() => setFilter('')}>Clear filters</Button>
            )}
            {sections.length === 0 && filter !== '' && (
              <Empty
                title="No loaded memory matches"
                action={<Button onClick={() => setFilter('')}>Clear filters</Button>}
              />
            )}
            {sections.map((name) => (
              <Card key={name} title={name}>
                <ul className="space-y-2">
                  {data.memories
                    .filter(
                      (row) =>
                        row.section === name &&
                        `${row.section} ${row.content}`
                          .toLowerCase()
                          .includes(filter.toLowerCase()),
                    )
                    .map((row) => (
                      <li key={row.id} className="rounded border border-line p-3">
                        <p className="whitespace-pre-wrap text-sm">{row.content}</p>
                        <div className="mt-2 flex gap-2">
                          {row.subjectId !== undefined && <Badge>member-specific</Badge>}
                          <Button onClick={() => open(row)}>Edit</Button>
                          <Button
                            onClick={() =>
                              void (async () => {
                                await session.write(
                                  `/api/assistant/memories/${encodeURIComponent(row.id)}`,
                                  undefined,
                                  'DELETE',
                                );
                                memory.reload();
                              })()
                            }
                          >
                            Delete
                          </Button>
                        </div>
                      </li>
                    ))}
                </ul>
              </Card>
            ))}
            <Card title="Member memory privacy">
              <p className="mb-2 text-sm text-ink-muted">
                Opt a member out of memory, or delete all member-specific memory and opt them out in
                one action. Club-wide memory is untouched.
              </p>
              {(data.members?.length ?? 0) > 20 && (
                <Field label="Filter loaded members">
                  <Input value={memberFilter} onChange={(e) => setMemberFilter(e.target.value)} />
                </Field>
              )}
              {memberFilter !== '' &&
                data.members?.some((member) =>
                  member.name.toLowerCase().includes(memberFilter.toLowerCase()),
                ) && <Button onClick={() => setMemberFilter('')}>Clear member filters</Button>}
              {data.members?.filter((member) =>
                member.name.toLowerCase().includes(memberFilter.toLowerCase()),
              ).length === 0 && (
                <Empty
                  title={memberFilter === '' ? 'No members loaded' : 'No loaded members match'}
                  action={
                    memberFilter === '' ? undefined : (
                      <Button onClick={() => setMemberFilter('')}>Clear member filters</Button>
                    )
                  }
                />
              )}
              <ul className="grid gap-2 sm:grid-cols-2">
                {data.members
                  ?.filter((member) =>
                    member.name.toLowerCase().includes(memberFilter.toLowerCase()),
                  )
                  .map((member) => (
                    <li
                      key={member.id}
                      className="flex items-center justify-between gap-2 rounded border border-line p-2"
                    >
                      <span>{member.name}</span>
                      <span className="flex gap-1">
                        <Button
                          onClick={() =>
                            void session.write(
                              `/api/assistant/memory-preferences/${encodeURIComponent(member.id)}`,
                              { optedOut: true },
                              'PUT',
                            )
                          }
                        >
                          Opt out
                        </Button>
                        <Button
                          onClick={() =>
                            void session
                              .write(
                                `/api/assistant/member-memory/${encodeURIComponent(member.id)}`,
                                undefined,
                                'DELETE',
                              )
                              .then(() => memory.reload())
                          }
                        >
                          Delete memory
                        </Button>
                      </span>
                    </li>
                  ))}
              </ul>
            </Card>
            {data.memories.length === 0 && (
              <Card title="No memory yet">
                <p className="text-sm text-ink-muted">
                  Add the club's goals, each team's current work, and exec tasks. The assistant can
                  add reviewed entries through its memory skill when enabled.
                </p>
              </Card>
            )}
          </div>
        )}
      </DataState>
      {editing !== undefined && (
        <Card title={editing === 'new' ? 'Add memory' : 'Edit memory'}>
          <FormSection title="Reviewed fact">
            <ErrorSummary errors={fields.summary} />
            {error !== undefined && <ErrorNotice error={error} />}
            <Field
              label="Section"
              htmlFor="field-section"
              {...(fields.errorFor('section') === undefined
                ? {}
                : { error: fields.errorFor('section')! })}
              hint="Examples: Club goals, Exec team, Events team"
            >
              <Input value={section} onChange={(e) => setSection(e.target.value)} />
            </Field>
            <Field
              label="Memory"
              htmlFor="field-content"
              {...(fields.errorFor('content') === undefined
                ? {}
                : { error: fields.errorFor('content')! })}
              hint="A concise fact or current work item"
            >
              <Textarea
                className="min-h-24 w-full rounded-sm border border-line bg-canvas p-2 text-sm"
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </Field>
            <DraftFooter
              guardEnabled={false}
              dirty={section !== entryBaseline.section || content !== entryBaseline.content}
              busy={busy}
              onSave={() => void save()}
              onDiscard={() => {
                setSection(entryBaseline.section);
                setContent(entryBaseline.content);
                fields.clear();
                setError(undefined);
              }}
            />
            <div className="flex gap-2">
              <Button
                hidden={section !== entryBaseline.section || content !== entryBaseline.content}
                variant="primary"
                busy={busy}
                onClick={() => void save()}
              >
                Save
              </Button>
              <Button
                onClick={() => {
                  if (
                    (section === entryBaseline.section && content === entryBaseline.content) ||
                    window.confirm('Discard memory changes?')
                  )
                    setEditing(undefined);
                }}
              >
                Cancel
              </Button>
            </div>
          </FormSection>
        </Card>
      )}
    </>
  );
}
