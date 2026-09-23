import { useCallback, useMemo, useState } from 'react';
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
  const sections = useMemo(
    () =>
      memory.resource.state === 'ready'
        ? [...new Set(memory.resource.data.memories.map((row) => row.section))]
        : [],
    [memory.resource],
  );
  const open = (row: MemoryRow | 'new') => {
    setEditing(row);
    setSection(row === 'new' ? 'Club goals' : row.section);
    setContent(row === 'new' ? '' : row.content);
  };
  const save = async () => {
    if (content.trim() === '') return;
    setBusy(true);
    const id = editing === 'new' ? crypto.randomUUID() : editing?.id;
    if (id !== undefined)
      await session.write(
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
      );
    setBusy(false);
    setEditing(undefined);
    memory.reload();
    toast({ tone: 'ok', title: 'Memory saved' });
  };
  return (
    <>
      <PageHeader
        title="Memory"
        purpose="What the assistant remembers about your club: goals, teams and ongoing work. Operators review every entry. Members can be opted out, and their entries deleted, below."
        actions={
          <Button variant="primary" onClick={() => open('new')}>
            Add memory
          </Button>
        }
      />
      <DataState resource={memory.resource}>
        {(data) => (
          <div className="space-y-4">
            <Card title="Server card">
              <p className="mb-2 text-sm text-ink-muted">
                Stable identity and operating context included in every API system prompt.
              </p>
              <textarea
                className="min-h-28 w-full rounded-sm border border-line bg-canvas p-2 text-sm"
                value={serverCard ?? data.serverCard}
                onChange={(e) => setServerCard(e.target.value)}
              />
              <Button
                busy={busy}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    await session.write(
                      '/api/assistant/server-card',
                      { content: serverCard ?? data.serverCard },
                      'PUT',
                    );
                    setBusy(false);
                    memory.reload();
                  })()
                }
              >
                Save server card
              </Button>
            </Card>
            {sections.map((name) => (
              <Card key={name} title={name}>
                <ul className="space-y-2">
                  {data.memories
                    .filter((row) => row.section === name)
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
              <ul className="grid gap-2 sm:grid-cols-2">
                {data.members?.map((member) => (
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
          <Field label="Section" hint="Examples: Club goals, Exec team, Events team">
            <Input value={section} onChange={(e) => setSection(e.target.value)} />
          </Field>
          <Field label="Memory" hint="A concise fact or current work item">
            <textarea
              className="min-h-24 w-full rounded-sm border border-line bg-canvas p-2 text-sm"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </Field>
          <div className="flex gap-2">
            <Button variant="primary" busy={busy} onClick={() => void save()}>
              Save
            </Button>
            <Button onClick={() => setEditing(undefined)}>Cancel</Button>
          </div>
        </Card>
      )}
    </>
  );
}
