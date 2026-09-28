import { useCallback, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { ApiError } from '../api.js';
import {
  ASSISTANT_URL,
  BOT_TAG_URL,
  LOG_CHANNEL_URL,
  behaviourPreviewUrl,
  behaviourTryUrl,
  behaviourUrl,
  decisionReviewUrl,
  decisionSaveUrl,
  type AssistantBehaviourView,
  type AssistantData,
  type BehaviourPreview,
  type DecisionRow,
  type TicketRow,
  type TryItResponse,
} from '../api/assistant.js';
import { historyUrl } from '../api/traces.js';
import { fieldError } from '../api/describe-error.js';
import { useSession, type Session } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorNotice } from '../ui/ErrorNotice.js';
import { Field, Input } from '../ui/Field.js';
import { HelpTip } from '../ui/HelpTip.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';
import { SetupTracker } from './assistant-setup-tracker.js';
import {
  behaviourBody,
  decisionTone,
  RoleChecklist,
  skillEffectLabel,
  ticketTone,
  toggleIn,
} from './assistant-shared.js';

/**
 * `/assistant`: the invocation behaviours - how members reach the assistant
 * (tag or direct command), the instructions each one follows, who may use
 * it, and what it hands to people. Skills, schedules and resources have
 * their own pages now (ADR 0060); this page links to them rather than
 * repeating them.
 */

const TAG_SURFACES = [
  { value: 'bananasaurs', label: '@bananasaurs', blurb: 'The general club assistant tag.' },
  {
    value: 'it-services',
    label: '@it-services',
    blurb: 'IT help; can hand requests to people as tickets.',
  },
  { value: 'help', label: '@help', blurb: 'A separate help tag for member questions.' },
] as const;

type TagSurface = (typeof TAG_SURFACES)[number]['value'];

/**
 * Create a brand-new tag behaviour through the existing PUT create path
 * (audit action assistant_behaviour.created). New behaviours are always
 * created disabled - enabling is a separate deliberate act on the behaviour
 * itself - and every identity comes from the live directories. An empty
 * caller-role allowlist fails closed, and that is stated where the choice is
 * made.
 */
function CreateBehaviourForm({
  data,
  session,
  onCreated,
  onCancel,
}: {
  readonly data: AssistantData;
  readonly session: Session;
  readonly onCreated: (id: string) => void;
  readonly onCancel: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [surface, setSurface] = useState<TagSurface>('bananasaurs');
  const [mentionRoleId, setMentionRoleId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [skillIds, setSkillIds] = useState<readonly string[]>([]);
  const [callerRoleIds, setCallerRoleIds] = useState<readonly string[]>([]);
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  const rolesReady = data.roles !== undefined && data.roles.length > 0;
  const canSubmit =
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    mentionRoleId !== '' &&
    rolesReady &&
    !busy;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    const slug =
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'behaviour';
    const id = `${slug}-${Date.now().toString(36)}`;
    try {
      const result = await session.writeOrThrow(
        behaviourUrl(id),
        {
          id,
          surface,
          mentionRoleId,
          name: name.trim(),
          systemPrompt: prompt.trim(),
          promptVersion: 0,
          allowedSkillIds: skillIds,
          resourceIds: [],
          callerRoleIds,
          enabled: false,
        },
        'PUT',
      );
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: `${name.trim()} created`,
          message: 'It is off. Turn it on from its behaviour card when you are ready.',
        });
        onCreated(id);
      }
    } catch (err) {
      // writeOrThrow lets the server's 400/409 answers through; everything
      // else already became a toast. Render the answer with its field
      // problems rather than translating the refusal here.
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const nameProblem = fieldError(error, 'name');
  const mentionRoleProblem = fieldError(error, 'mentionRoleId');
  const promptProblem = fieldError(error, 'systemPrompt');

  return (
    <Card title="Create a behaviour">
      <p className="mb-3 text-sm text-ink-muted">
        A behaviour is one way members can use the assistant - its own tag, instructions and rules
        about who may use it. New behaviours start turned off.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void submit();
        }}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field
            label="Name"
            hint="Shown to operators only, for example New member help."
            {...(nameProblem === undefined ? {} : { error: nameProblem })}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
            />
          </Field>
          <Field
            label="Tag"
            hint="Which kind of helper this is. It decides the safety rules it follows, for example IT help can open tickets."
          >
            <select
              value={surface}
              onChange={(e) => setSurface(e.target.value as TagSurface)}
              className="mt-1 block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
            >
              {TAG_SURFACES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} - {option.blurb}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="mt-3">
          <Field
            label="Mention role"
            {...(mentionRoleProblem === undefined ? {} : { error: mentionRoleProblem })}
          >
            <select
              value={mentionRoleId}
              onChange={(e) => setMentionRoleId(e.target.value)}
              className="mt-1 block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
            >
              <option value="">Choose a role…</option>
              {[...(data.roles ?? [])]
                .sort((a, b) => b.position - a.position)
                .map((role) => (
                  <option key={role.id} value={role.id}>
                    @{role.name}
                  </option>
                ))}
            </select>
          </Field>
          <p className="mt-1 text-xs text-ink-muted">
            Members reach this behaviour by mentioning this role in Discord, for example @IT
            Services. Each role can belong to only one behaviour that is turned on.{' '}
            <HelpTip label="mention role">
              Discord roles can be mentioned like @Club Assistant. The bot watches for that mention
              and routes it to this behaviour. Only roles Discord reports for this server are
              offered.
            </HelpTip>
          </p>
          {!rolesReady && (
            <p className="mt-1 text-xs text-ink-muted">
              The role directory did not load, so no mention role can be chosen and the behaviour
              cannot be created yet. Nothing is changed.
            </p>
          )}
        </div>
        <div className="mt-3">
          <Field
            label="Instructions for the new behaviour"
            hint="Members do not see these operator instructions. 1 to 4,000 characters."
            {...(promptProblem === undefined ? {} : { error: promptProblem })}
          >
            <textarea
              value={prompt}
              maxLength={4_000}
              onChange={(e) => setPrompt(e.target.value)}
              required
              className="mt-1 min-h-24 w-full rounded-sm border border-line bg-canvas p-2 text-sm text-ink"
            />
          </Field>
        </div>
        <section aria-label="Skills the new behaviour may use" className="mt-4">
          <h3 className="text-sm font-medium">Skills it may use</h3>
          <p className="mt-1 text-xs text-ink-muted">
            You can change this later on the{' '}
            <Link className="underline" href="/assistant/skills">
              Skills page
            </Link>
            . With nothing selected the behaviour can answer from its instructions but cannot do
            anything.
          </p>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {data.skills
              .filter((skill) => skill.ownerOnly !== true)
              .map((skill) => (
                <li key={skill.id}>
                  <label className="flex items-start gap-2 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={skillIds.includes(skill.id)}
                      onChange={() => setSkillIds((ids) => toggleIn(ids, skill.id))}
                    />
                    <span>
                      <span className="block">{skill.name}</span>
                      <span className="text-xs text-ink-muted">{skillEffectLabel(skill)}</span>
                    </span>
                  </label>
                </li>
              ))}
          </ul>
        </section>
        <section aria-label="Who may use the new behaviour" className="mt-4">
          <h3 className="text-sm font-medium">Who may use it</h3>
          <RoleChecklist
            label="Who may use the new behaviour"
            roles={data.roles}
            selected={callerRoleIds}
            onToggle={(id) => setCallerRoleIds((ids) => toggleIn(ids, id))}
          />
          <p className="mt-2 text-xs text-ink-muted">If no role is ticked, nobody can use it.</p>
        </section>
        {error !== undefined && (
          <div className="mt-3">
            <ErrorNotice error={error} />
          </div>
        )}
        <div className="mt-4 flex gap-2">
          <Button variant="primary" busy={busy} disabled={!canSubmit} type="submit">
            Create behaviour
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Access and routing for one behaviour: caller-role allowlist, attached
 * resources, and ticket escalation where the server exposes it. Skill
 * allowlists moved to the Skills page (ADR 0060); saving here preserves the
 * behaviour's current allowlist because the write is the whole object.
 */
function BehaviourAccessEditor({
  behaviour,
  data,
  onSaved,
}: {
  readonly behaviour: AssistantBehaviourView;
  readonly data: AssistantData;
  readonly onSaved: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const [roleIds, setRoleIds] = useState<readonly string[]>(behaviour.callerRoleIds ?? []);
  const [resourceIds, setResourceIds] = useState<readonly string[]>(behaviour.resourceIds);
  const [channelId, setChannelId] = useState(behaviour.ticket?.channelId ?? '');
  const [reviewerRoleIds, setReviewerRoleIds] = useState<readonly string[]>(
    behaviour.ticket?.reviewerRoleIds ?? [],
  );
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const result = await session.write(
        behaviourUrl(behaviour.id),
        behaviourBody(behaviour, {
          callerRoleIds: roleIds,
          resourceIds,
          ticket: {
            ...(channelId === '' ? {} : { channelId }),
            reviewerRoleIds,
          },
        }),
        'PUT',
      );
      if (result !== undefined) {
        toast({ tone: 'ok', title: `${behaviour.name} access saved` });
        onSaved();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Access and routing">
      <section aria-label="Caller roles">
        <h3 className="text-sm font-medium">Who can ask the assistant</h3>
        {behaviour.callerRoleIds === undefined ? (
          <p className="mt-2 text-xs text-ink-muted">
            Role allowlists are not exposed by this server build yet; the server's current policy
            keeps applying and nothing here can be edited.
          </p>
        ) : (
          <>
            <RoleChecklist
              label="Who can ask the assistant"
              roles={data.roles}
              selected={roleIds}
              onToggle={(id) => setRoleIds((ids) => toggleIn(ids, id))}
            />
            <p className="mt-2 text-xs text-ink-muted">If no role is ticked, nobody can use it.</p>
          </>
        )}
      </section>
      <section aria-label="Emphasised resources" className="mt-4">
        <h3 className="text-sm font-medium">Resources to emphasise</h3>
        <p className="mt-1 text-xs text-ink-muted">
          Every enabled resource is available to every behaviour. Tick the ones this behaviour
          should prefer.
        </p>
        {data.resources.length === 0 ? (
          <p className="mt-2 text-xs text-ink-muted">
            No resources configured yet. Add them on the{' '}
            <Link className="underline" href="/assistant/resources">
              Resources page
            </Link>
            .
          </p>
        ) : (
          <ul aria-label="Resources to emphasise" className="mt-2 grid gap-1 sm:grid-cols-2">
            {data.resources.map((resource) => (
              <li key={resource.id}>
                <label className="flex items-center gap-2 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={resourceIds.includes(resource.id)}
                    onChange={() => setResourceIds((ids) => toggleIn(ids, resource.id))}
                  />
                  <span className="min-w-0 truncate">{resource.title}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>
      {behaviour.surface === 'it-services' && behaviour.ticket === undefined && (
        <p className="mt-4 text-xs text-ink-muted">
          Ticket routing is not exposed by this server build yet; unanswered IT requests stay
          unanswered rather than guessing a destination.
        </p>
      )}
      {behaviour.ticket !== undefined && behaviour.surface === 'it-services' && (
        <section aria-label="Ticket routing" className="mt-4">
          <h3 className="text-sm font-medium">Ticket routing</h3>
          <p className="mt-1 text-xs text-ink-muted">
            Questions are answered directly when the reviewed sources cover them; anything needing a
            person becomes a ticket message in the chosen channel. Tickets never carry credentials.
          </p>
          {data.channels === undefined ? (
            <p className="mt-2 text-xs text-ink-muted">
              The channel directory did not load, so no ticket channel can be chosen. Nothing is
              changed.
            </p>
          ) : (
            <Field label="Ticket channel" hint="Only channels Discord reports for this server.">
              <select
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                className="mt-1 block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
              >
                <option value="">No channel selected</option>
                {[...data.channels]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      #{channel.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          {channelId === '' && (
            <p role="status" className="mt-2 text-xs text-hold">
              No ticket channel selected: ticket creation fails closed until one is chosen.
            </p>
          )}
          <h4 className="mt-3 text-sm font-medium">Reviewer roles notified on a new ticket</h4>
          <RoleChecklist
            label="Ticket reviewer roles"
            roles={data.roles}
            selected={reviewerRoleIds}
            onToggle={(id) => setReviewerRoleIds((ids) => toggleIn(ids, id))}
          />
        </section>
      )}
      <div className="mt-4">
        <Button variant="primary" busy={busy} onClick={() => void save()}>
          Save access
        </Button>
      </div>
    </Card>
  );
}

/** Escalation tickets for behaviours that create them, with honest status. */
function TicketsCard({
  tickets,
  behaviour,
  data,
}: {
  readonly tickets: readonly TicketRow[];
  readonly behaviour: AssistantBehaviourView;
  readonly data: AssistantData;
}) {
  const rows = tickets.filter((t) => t.behaviourId === behaviour.id);
  const channelName = (id: string) => data.channels?.find((c) => c.id === id)?.name;
  const memberName = (id: string) => data.members?.find((m) => m.id === id)?.name;
  return (
    <Card title="Tickets">
      <p className="mb-3 text-sm text-ink-muted">
        Requests this behaviour handed to people instead of answering. IT members review them in
        Discord; this table only reports.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">No tickets yet.</p>
      ) : (
        <DataTable
          caption="Escalation tickets"
          rows={rows}
          rowKey={(t) => t.id}
          columns={[
            { key: 'summary', header: 'Ticket', cell: (t) => t.summary },
            {
              key: 'requester',
              header: 'Requested by',
              cell: (t) =>
                memberName(t.requesterId) ?? (
                  <span className="font-mono text-xs">{t.requesterId}</span>
                ),
            },
            {
              key: 'channel',
              header: 'Channel',
              cell: (t) => {
                const name = channelName(t.channelId);
                return name === undefined ? (
                  <span className="font-mono text-xs">{t.channelId}</span>
                ) : (
                  `#${name}`
                );
              },
            },
            {
              key: 'status',
              header: 'Status',
              cell: (t) => <Badge tone={ticketTone(t.status)}>{t.status}</Badge>,
            },
            {
              key: 'when',
              header: 'Opened',
              cell: (t) => new Date(t.at).toLocaleString('en-CA'),
            },
          ]}
        />
      )}
    </Card>
  );
}

/** /decision and /review-plan records. Draft-first: analysis is visible as analysis until a person confirms and the record is saved in Discord. */
function DecisionsCard({
  decisions,
  data,
  session,
  onSaved,
}: {
  readonly decisions: readonly DecisionRow[];
  readonly data: AssistantData;
  readonly session: Session;
  readonly onSaved: () => void;
}) {
  const [memoryDrafts, setMemoryDrafts] = useState<
    Record<string, { section: string; content: string; subjectId: string }>
  >({});
  const memberName = (id: string) => data.members?.find((m) => m.id === id)?.name;
  return (
    <Card title="Decisions and plans">
      <p className="mb-3 text-sm text-ink-muted">
        What /decision and /review-plan produced. A draft is analysis, not club policy; a record
        becomes durable only after a person confirms it in Discord.
      </p>
      {decisions.length === 0 ? (
        <p className="text-sm text-ink-muted">No decision or plan records yet.</p>
      ) : (
        <DataTable
          caption="Decision and plan records"
          rows={decisions}
          rowKey={(d) => d.id}
          columns={[
            {
              key: 'kind',
              header: 'Kind',
              cell: (d) =>
                d.kind === 'decision'
                  ? 'Decision'
                  : d.kind === 'memory'
                    ? 'Memory proposal'
                    : 'Plan review',
            },
            { key: 'summary', header: 'Summary', cell: (d) => d.summary },
            {
              key: 'status',
              header: 'State',
              cell: (d) => <Badge tone={decisionTone(d.status)}>{d.status}</Badge>,
            },
            {
              key: 'requester',
              header: 'Requested by',
              cell: (d) =>
                memberName(d.requesterId) ?? (
                  <span className="font-mono text-xs">{d.requesterId}</span>
                ),
            },
            { key: 'provenance', header: 'Provenance', cell: (d) => d.provenance },
            { key: 'when', header: 'When', cell: (d) => new Date(d.at).toLocaleString('en-CA') },
            {
              key: 'action',
              header: 'Action',
              cell: (d) =>
                d.status === 'saved' ? (
                  <span className="text-xs text-ink-muted">Saved</span>
                ) : d.kind === 'memory' && d.status === 'reviewed' ? (
                  <div className="grid min-w-64 gap-2">
                    <Input
                      aria-label={`Memory section ${d.id}`}
                      placeholder="Section"
                      value={memoryDrafts[d.id]?.section ?? ''}
                      onChange={(e) =>
                        setMemoryDrafts((all) => ({
                          ...all,
                          [d.id]: {
                            section: e.target.value,
                            content: all[d.id]?.content ?? d.summary,
                            subjectId: all[d.id]?.subjectId ?? '',
                          },
                        }))
                      }
                    />
                    <textarea
                      aria-label={`Memory content ${d.id}`}
                      className="min-h-20 rounded-sm border border-line bg-canvas p-2 text-sm"
                      value={memoryDrafts[d.id]?.content ?? d.summary}
                      onChange={(e) =>
                        setMemoryDrafts((all) => ({
                          ...all,
                          [d.id]: {
                            section: all[d.id]?.section ?? '',
                            content: e.target.value,
                            subjectId: all[d.id]?.subjectId ?? '',
                          },
                        }))
                      }
                    />
                    <select
                      aria-label={`Memory subject ${d.id}`}
                      className="rounded-sm border border-line bg-canvas px-2 py-1 text-sm"
                      value={memoryDrafts[d.id]?.subjectId ?? ''}
                      onChange={(e) =>
                        setMemoryDrafts((all) => ({
                          ...all,
                          [d.id]: {
                            section: all[d.id]?.section ?? '',
                            content: all[d.id]?.content ?? d.summary,
                            subjectId: e.target.value,
                          },
                        }))
                      }
                    >
                      <option value="">Club-wide</option>
                      {data.members?.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.name}
                        </option>
                      ))}
                    </select>
                    <Button
                      disabled={(memoryDrafts[d.id]?.section ?? '').trim() === ''}
                      onClick={() => {
                        const draft = memoryDrafts[d.id];
                        if (draft === undefined) return;
                        void session
                          .write(decisionSaveUrl(d.id), {
                            section: draft.section.trim(),
                            content: draft.content.trim(),
                            ...(draft.subjectId === '' ? {} : { subjectId: draft.subjectId }),
                          })
                          .then((result) => result !== undefined && onSaved());
                      }}
                    >
                      Save memory
                    </Button>
                  </div>
                ) : (
                  <Button
                    onClick={() =>
                      void session
                        .write(
                          d.status === 'draft' ? decisionReviewUrl(d.id) : decisionSaveUrl(d.id),
                          {},
                        )
                        .then((result) => result !== undefined && onSaved())
                    }
                  >
                    {d.status === 'draft' ? 'Mark reviewed' : 'Save record'}
                  </Button>
                ),
            },
          ]}
        />
      )}
    </Card>
  );
}

export function AssistantPage() {
  const session = useSession();
  const load = useCallback(() => session.read<AssistantData>(ASSISTANT_URL), [session]);
  const assistant = useResource('assistant settings', load);
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title="Behaviours"
        purpose="Behaviours decide who answers, how they sound, and who may ask."
        actions={
          <>
            <Link href="/assistant/history">
              <Button>Assistant history</Button>
            </Link>
            <Button variant="primary" onClick={() => setCreating(true)} disabled={creating}>
              Create a behaviour
            </Button>
          </>
        }
      />
      {assistant.resource.state === 'ready' && assistant.resource.data.setup !== undefined && (
        <div className="mb-5">
          <SetupTracker
            data={assistant.resource.data}
            session={session}
            reload={assistant.reload}
          />
        </div>
      )}
      <DataState resource={assistant.resource}>
        {(data) =>
          data.behaviours.length === 0 ? (
            <div className="space-y-3">
              <EmptyState
                title="No behaviours yet"
                detail="Step 4 creates the club assistant, which members reach by tagging @Bananasaurs. To set up a tagged helper like @it-services instead, create a behaviour."
              />
              {creating && (
                <CreateBehaviourForm
                  data={data}
                  session={session}
                  onCreated={(id) => {
                    setCreating(false);
                    setSelected(id);
                    assistant.reload();
                  }}
                  onCancel={() => setCreating(false)}
                />
              )}
            </div>
          ) : (
            <AssistantReady
              data={data}
              session={session}
              reload={assistant.reload}
              {...(selected === undefined ? {} : { selected })}
              onSelect={setSelected}
              creating={creating}
              onCreate={() => setCreating(false)}
              onCreated={(id) => {
                setCreating(false);
                setSelected(id);
                assistant.reload();
              }}
            />
          )
        }
      </DataState>
    </>
  );
}

/**
 * The prompt editor for ONE behaviour. Rendered with `key={behaviour.id}` so
 * switching behaviours remounts it: an editor whose state outlived the
 * selection would save behaviour A's prompt onto behaviour B (B3). Every
 * piece of draft state in here belongs to exactly one behaviour id.
 */
/**
 * ADR 0063: which behaviour answers when a member tags the bot user itself
 * (not a mapped role). One at a time; the server enforces it and refuses a
 * disabled behaviour, so only enabled ones are offered.
 */
function BotTagCard({
  data,
  session,
  reload,
}: {
  readonly data: AssistantData;
  readonly session: Session;
  readonly reload: () => void;
}) {
  const toast = useToast();
  const current = data.behaviours.find((b) => b.answersBotTag === true)?.id ?? '';
  const [choice, setChoice] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const offered = data.behaviours.filter((b) => b.enabled);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const behaviourId = choice === '' ? null : choice;
      const result = await session.writeOrThrow(BOT_TAG_URL, { behaviourId }, 'PUT');
      if (result === undefined) return;
      const name = data.behaviours.find((b) => b.id === choice)?.name;
      toast({
        tone: 'ok',
        title:
          name === undefined
            ? 'Tagging @Bananasaurs is off'
            : `Tag @Bananasaurs now answers with ${name}`,
      });
      reload();
    } catch (err: unknown) {
      // writeOrThrow throws only 400 and 409; the session reports the rest.
      // Render the server's answer rather than translating the refusal here.
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const behaviourProblem = fieldError(error, 'behaviourId');

  return (
    <Card title="Tagging @Bananasaurs">
      <p className="text-sm text-ink-muted">
        Members can tag the bot itself to ask a question. Tags of a mapped role, such as
        @it-services, still go to that role&apos;s behaviour.
      </p>
      <div className="mt-3">
        <Field
          label="When someone tags @Bananasaurs, answer with"
          {...(behaviourProblem === undefined ? {} : { error: behaviourProblem })}
        >
          <select
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className="mt-1 block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
          >
            <option value="">Nobody</option>
            {offered.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {current === '' && (
        <p className="mt-2 text-xs text-hold">
          Tagging the bot does nothing until you pick a behaviour.
        </p>
      )}
      {error !== undefined && (
        <div className="mt-3">
          <ErrorNotice error={error} />
        </div>
      )}
      <div className="mt-3">
        <Button busy={busy} disabled={choice === current || busy} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </Card>
  );
}

/**
 * ADR 0065: the channel every assistant request is logged to, with the full
 * question and answer. Picked from the live channel directory, never typed.
 */
function LogChannelCard({
  data,
  session,
  reload,
}: {
  readonly data: AssistantData;
  readonly session: Session;
  readonly reload: () => void;
}) {
  const toast = useToast();
  const current = data.settings?.logChannelId ?? '';
  const [choice, setChoice] = useState(current);
  const [busy, setBusy] = useState(false);
  const channels = data.channels ?? [];

  const save = async () => {
    setBusy(true);
    try {
      const channelId = choice === '' ? null : choice;
      const result = await session.write(LOG_CHANNEL_URL, { channelId }, 'PUT');
      if (result === undefined) return;
      const name = channels.find((c) => c.id === choice)?.name;
      toast({
        tone: 'ok',
        title:
          name === undefined
            ? 'Assistant logging is off'
            : `Assistant requests now log to #${name}`,
      });
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="AI log channel">
      <p className="text-sm text-ink-muted">
        Each request is posted with who asked, the question, the answer, the tools and sources used,
        the model, and whether it worked.
      </p>
      <p className="mt-1 text-xs text-hold">
        Members&apos; questions are copied there in full. Choose a staff-only channel.
      </p>
      <div className="mt-3">
        <Field label="Post every assistant request to">
          <select
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className="mt-1 block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
          >
            <option value="">No log channel</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="mt-3">
        <Button busy={busy} disabled={choice === current || busy} onClick={() => void save()}>
          Save log channel
        </Button>
      </div>
    </Card>
  );
}

function BehaviourPromptCard({
  behaviour,
  session,
  reload,
  onToggle,
}: {
  readonly behaviour: AssistantData['behaviours'][number];
  readonly session: Session;
  readonly reload: () => void;
  readonly onToggle: () => void;
}) {
  const toast = useToast();
  const [prompt, setPrompt] = useState(behaviour.systemPrompt);
  const [promptBusy, setPromptBusy] = useState(false);
  const savePrompt = async () => {
    const cleaned = prompt.trim();
    if (cleaned.length < 1 || cleaned.length > 4_000) {
      toast({ tone: 'danger', title: 'Prompt not saved', message: 'Use 1 to 4,000 characters.' });
      return;
    }
    setPromptBusy(true);
    try {
      const result = await session.writeOrThrow(
        behaviourUrl(behaviour.id),
        behaviourBody(behaviour, { systemPrompt: cleaned }),
        'PUT',
      );
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: `${behaviour.name} prompt saved`,
          message: `Saved as revision ${String(behaviour.promptVersion + 1)}.`,
        });
        reload();
      }
    } catch {
      toast({
        tone: 'hold',
        title: 'Prompt changed elsewhere',
        message: 'Reloaded the latest revision. Review it before saving again.',
      });
      reload();
    } finally {
      setPromptBusy(false);
    }
  };

  return (
    <Card title={`${behaviour.name} behaviour`}>
      <p className="text-sm text-ink-muted">
        These are the instructions this behaviour follows. Bananasaurs adds its own safety rules,
        your server card and the club resources, and always treats messages and web pages as
        information, never as instructions.
      </p>
      <Field
        label="Instructions the assistant follows"
        hint="Members do not see these operator instructions. Saved resources and messages cannot change them."
      >
        <textarea
          value={prompt}
          maxLength={4_000}
          onChange={(event) => setPrompt(event.target.value)}
          className="mt-3 min-h-32 w-full rounded-sm border border-line bg-canvas p-2 text-sm text-ink"
        />
      </Field>
      <p className="mt-1 text-xs text-ink-muted">
        Revision {behaviour.promptVersion} · {prompt.length.toLocaleString('en-CA')}/4,000
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button className="max-w-full shrink-0 whitespace-nowrap" onClick={onToggle}>
          {behaviour.enabled ? 'Turn off - members will get no answer' : 'Turn on assistant'}
        </Button>
        <Button
          busy={promptBusy}
          disabled={prompt === behaviour.systemPrompt}
          onClick={() => void savePrompt()}
        >
          Save instructions
        </Button>
      </div>
    </Card>
  );
}

/**
 * Task 18: the full compiled prompt for one behaviour, fetched from
 * `GET /api/assistant/behaviours/:id/preview`. Every section the model
 * receives, in plain words with its size, each expandable to its text.
 */
const PREVIEW_LABELS: Readonly<Record<string, string>> = {
  surface: 'How members reach it',
  'behaviour-prompt': 'Your prompt',
  'safety-suffix': 'Bananasaurs safety rules (locked)',
  'evidence-rule': 'Evidence rule',
  'server-card': 'Server card',
  resources: 'Club resources',
  skills: 'Allowed skills',
};

function BehaviourPreviewPanel({
  behaviourId,
  onClose,
}: {
  readonly behaviourId: string;
  readonly onClose: () => void;
}) {
  const session = useSession();
  const load = useCallback(
    () => session.read<BehaviourPreview>(behaviourPreviewUrl(behaviourId)),
    [session, behaviourId],
  );
  const preview = useResource('full prompt', load);
  return (
    <section
      aria-label="Full prompt preview"
      className="mt-2 rounded-sm border border-line bg-canvas p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Full prompt</h3>
        <Button className="px-1.5 py-0 text-xs" onClick={onClose}>
          Close preview
        </Button>
      </div>
      <DataState resource={preview.resource}>
        {(data) => (
          <>
            <ul className="mt-2 grid gap-1">
              {data.sections.map((section) => (
                <li key={section.name}>
                  <details className="rounded-sm border border-line bg-panel px-2 py-1">
                    <summary className="cursor-pointer text-sm">
                      <span>{PREVIEW_LABELS[section.name] ?? section.name}</span>{' '}
                      <span className="text-xs text-ink-muted">
                        {section.chars} characters · ~{section.estTokens} tokens
                      </span>
                    </summary>
                    <pre className="mt-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap">
                      {section.text}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-ink-muted">
              Total: {data.totalChars} characters · ~{data.totalEstTokens} tokens
            </p>
          </>
        )}
      </DataState>
    </section>
  );
}

/**
 * The answer as Discord-like text. There is no markdown renderer in the
 * dashboard (and no new dependency may be added), so this renders plain
 * text with its line breaks kept and fenced code blocks as `<pre>`.
 */
function AnswerText({ text }: { readonly text: string }) {
  const parts = text.split('```');
  if (parts.length === 1) return <p className="text-sm whitespace-pre-wrap">{text}</p>;
  // Only a part whose fence closes is code: an odd part count means every
  // opened fence closed; an even count leaves the last opened fence
  // unclosed, so its tail stays plain text instead of a `<pre>`.
  const closed = parts.length % 2 === 1;
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 && (closed || index < parts.length - 1) ? (
          <pre
            key={index}
            className="mt-1 overflow-x-auto rounded-sm bg-panel p-2 font-mono text-xs whitespace-pre-wrap"
          >
            {part}
          </pre>
        ) : part === '' ? null : (
          <p key={index} className="mt-1 text-sm whitespace-pre-wrap">
            {part}
          </p>
        ),
      )}
    </>
  );
}

/**
 * Task 20: Try it — ask the selected behaviour a question from the
 * dashboard and read its answer. Nothing is posted to Discord. "Continue
 * this conversation" asks the follow-up in the same conversation; asking
 * with "Try it" starts over. Rendered with `key={behaviourId}` so switching
 * behaviours drops the previous answer and conversation.
 */
export function TryItBox({ behaviourId }: { readonly behaviourId: string }) {
  const session = useSession();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | undefined>(undefined);
  const [traceId, setTraceId] = useState<string | undefined>(undefined);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [quotaText, setQuotaText] = useState<string | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);

  const run = async (continuing: boolean): Promise<void> => {
    const cleaned = question.trim();
    if (cleaned === '' || busy) return;
    setBusy(true);
    setQuotaText(undefined);
    setError(undefined);
    try {
      // The 429 rethrows (rather than toasting and resolving `undefined`)
      // so the rate limit lands in this call's inline error below.
      const result = await session.writeOrThrow<TryItResponse>(
        behaviourTryUrl(behaviourId),
        {
          question: cleaned,
          ...(continuing && conversationId !== undefined ? { conversationId } : {}),
        },
        'POST',
        [429],
      );
      // `undefined` means the session already toasted the reason.
      if (result === undefined) return;
      setAnswer(result.answer);
      setTraceId(result.traceId);
      setConversationId(result.conversationId);
    } catch (err) {
      // The 429 branch stays: the hourly quota sentence says more than the
      // catalog text. Anything else renders as the server's answer.
      if (err instanceof ApiError && err.body.error === 'rate-limited') {
        setQuotaText('You have used your 20 tries for this hour. Try again later.');
      } else {
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Try it">
      <p className="mb-3 text-sm text-ink-muted">
        Ask this behaviour a question and read its answer here. Only you see it — nothing is posted
        to Discord.
      </p>
      <Field label="Try it question" hint="At most 2,000 characters. Twenty tries per hour.">
        <textarea
          value={question}
          maxLength={2_000}
          onChange={(e) => setQuestion(e.target.value)}
          className="mt-1 min-h-20 w-full rounded-sm border border-line bg-canvas p-2 text-sm text-ink"
        />
      </Field>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="primary"
          busy={busy}
          disabled={question.trim() === '' || busy}
          onClick={() => void run(false)}
        >
          Try it
        </Button>
        {conversationId !== undefined && (
          <Button
            busy={busy}
            disabled={question.trim() === '' || busy}
            onClick={() => void run(true)}
          >
            Continue this conversation
          </Button>
        )}
      </div>
      {quotaText !== undefined && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {quotaText}
        </p>
      )}
      {error !== undefined && (
        <div className="mt-3">
          <ErrorNotice error={error} />
        </div>
      )}
      {answer !== undefined && traceId !== undefined && (
        <section
          aria-label="Tried answer"
          className="mt-3 rounded-sm border border-line bg-canvas p-2"
        >
          <AnswerText text={answer} />
          <p className="mt-2">
            <Link className="text-sm underline underline-offset-4" href={historyUrl(traceId)}>
              View details
            </Link>
          </p>
        </section>
      )}
    </Card>
  );
}

function AssistantReady({
  data,
  session,
  reload,
  selected,
  onSelect,
  creating,
  onCreate,
  onCreated,
}: {
  readonly data: AssistantData;
  readonly session: Session;
  readonly reload: () => void;
  readonly selected?: string;
  readonly onSelect: (id: string) => void;
  readonly creating: boolean;
  readonly onCreate: () => void;
  readonly onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [previewId, setPreviewId] = useState<string | undefined>(undefined);
  const current = useMemo(
    () => data.behaviours.find((b) => b.id === selected) ?? data.behaviours[0]!,
    [data.behaviours, selected],
  );
  const roleName = (id: string | undefined) =>
    id === undefined ? undefined : data.roles?.find((role) => role.id === id)?.name;

  const toggleEnabled = async () => {
    const result = await session.write(
      behaviourUrl(current.id),
      behaviourBody(current, { enabled: !current.enabled }),
      'PUT',
    );
    if (result !== undefined) {
      toast({
        tone: current.enabled ? 'hold' : 'ok',
        title: current.enabled ? `${current.name} disabled` : `${current.name} enabled`,
      });
      reload();
    }
  };

  return (
    <div className="space-y-5">
      <BotTagCard
        // Remount when the saved choice changes so the picker shows it.
        key={`bot-tag-${data.behaviours.find((b) => b.answersBotTag === true)?.id ?? 'none'}`}
        data={data}
        session={session}
        reload={reload}
      />
      <LogChannelCard
        key={`log-${data.settings?.logChannelId ?? 'none'}`}
        data={data}
        session={session}
        reload={reload}
      />
      <section aria-label="Invocation behaviours" className="grid gap-3 md:grid-cols-2">
        {data.behaviours.map((item) => {
          const mention =
            item.surface === 'direct-command'
              ? 'Members tag @Bananasaurs'
              : (() => {
                  const name = roleName(item.mentionRoleId);
                  return name === undefined ? 'Mention role not set' : `Members mention @${name}`;
                })();
          return (
            <div
              key={item.id}
              className={`rounded-md border bg-panel p-3 ${item.id === current.id ? 'border-ink' : 'border-line'}`}
            >
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                aria-pressed={item.id === current.id}
                className="block w-full text-left"
              >
                <span className="text-xs text-ink-muted">
                  {item.surface === 'direct-command' ? 'Direct command' : `Tag @${item.surface}`}
                </span>
                <span className="mt-1 block font-mono text-sm">{mention}</span>
                <span className="mt-2 flex items-center justify-between gap-2">
                  <strong>{item.name}</strong>
                  <span className="flex flex-wrap items-center gap-1">
                    {item.answersBotTag === true && <Badge tone="ok">Tag @Bananasaurs</Badge>}
                    <Badge tone={item.enabled ? 'ok' : 'neutral'}>
                      {item.enabled ? 'On' : 'Off'}
                    </Badge>
                  </span>
                </span>
              </button>
              <div className="mt-2 flex flex-wrap gap-2 border-t border-line pt-2">
                <Link href={`/assistant/behaviours/${item.id}/wizard`}>
                  <Button>Build with the wizard</Button>
                </Link>
                <Button
                  onClick={() => setPreviewId((open) => (open === item.id ? undefined : item.id))}
                >
                  Preview the full prompt
                </Button>
              </div>
              {previewId === item.id && (
                <BehaviourPreviewPanel
                  behaviourId={item.id}
                  onClose={() => setPreviewId(undefined)}
                />
              )}
            </div>
          );
        })}
      </section>
      {creating && (
        <CreateBehaviourForm
          data={data}
          session={session}
          onCreated={onCreated}
          onCancel={onCreate}
        />
      )}
      <BehaviourPromptCard
        // Distinct keys per editor: two adjacent siblings sharing a key leak
        // the first one's DOM on a key change (React's remaining-child map
        // keeps one fiber per key), which is exactly the B3 failure mode.
        key={`prompt-${current.id}`}
        behaviour={current}
        session={session}
        reload={reload}
        onToggle={() => void toggleEnabled()}
      />
      <TryItBox
        // The answer and conversation belong to exactly one behaviour: a
        // shared key would keep behaviour A's answer under behaviour B.
        key={`try-${current.id}`}
        behaviourId={current.id}
      />
      <BehaviourAccessEditor
        key={`access-${current.id}`}
        behaviour={current}
        data={data}
        onSaved={reload}
      />
      {data.tickets !== undefined && current.surface === 'it-services' && (
        <TicketsCard tickets={data.tickets} behaviour={current} data={data} />
      )}
      {data.decisions !== undefined && (
        <DecisionsCard decisions={data.decisions} data={data} session={session} onSaved={reload} />
      )}
    </div>
  );
}
