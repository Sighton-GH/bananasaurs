import { useState } from 'react';
import { Link } from 'wouter';
import {
  behaviourUrl,
  decisionReviewUrl,
  decisionSaveUrl,
  type AssistantBehaviourView,
  type AssistantData,
  type DecisionRow,
  type TicketRow,
} from '../../api/assistant.js';
import { useSession, type Session } from '../../app/session.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { DataTable } from '../../ui/DataTable.js';
import { Checkbox, Field, Input } from '../../ui/Field.js';
import { Select } from '../../ui/Select.js';
import { Textarea } from '../../ui/Textarea.js';
import { useToast } from '../../ui/Toast.js';
import {
  behaviourBody,
  decisionTone,
  RoleChecklist,
  skillEffectLabel,
  ticketTone,
  toggleIn,
} from '../assistant-shared.js';

/**
 * Access and routing for one behaviour: caller-role allowlist, preferred
 * skills and resources, and ticket escalation where the server exposes it.
 * Skill scope is the only gate (ADR 0087); saving here preserves the
 * behaviour's current preferences because the write is the whole object.
 */
export function BehaviourAccessEditor({
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
  const [preferredSkillIds, setPreferredSkillIds] = useState<readonly string[]>(
    behaviour.preferredSkillIds,
  );
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
          preferredSkillIds,
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
      <section aria-label="Preferred skills" className="mt-4">
        <h3 className="text-sm font-medium">Preferred skills</h3>
        <p className="mt-1 text-xs text-ink-muted">
          Skills this assistant should lean on first. This doesn&apos;t grant or block anything: who
          can use a skill is set on the Skills page.
        </p>
        {data.skills.length === 0 ? (
          <p className="mt-2 text-xs text-ink-muted">
            No skills reported yet. Nothing here is editable and the assistant&apos;s current policy
            keeps applying.
          </p>
        ) : (
          <ul aria-label="Preferred skills" className="mt-2 grid gap-1 sm:grid-cols-2">
            {data.skills.map((skill) => (
              <li key={skill.id}>
                <Checkbox
                  label={`${skill.name} — ${skillEffectLabel(skill)}`}
                  checked={preferredSkillIds.includes(skill.id)}
                  onChange={() => setPreferredSkillIds((ids) => toggleIn(ids, skill.id))}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Preferred resources" className="mt-4">
        <h3 className="text-sm font-medium">Preferred resources</h3>
        <p className="mt-1 text-xs text-ink-muted">Resources this assistant should check first.</p>
        {data.resources.length === 0 ? (
          <p className="mt-2 text-xs text-ink-muted">
            No resources configured yet. Add them on the{' '}
            <Link className="underline" href="/assistant/resources">
              Resources page
            </Link>
            .
          </p>
        ) : (
          <ul aria-label="Preferred resources" className="mt-2 grid gap-1 sm:grid-cols-2">
            {data.resources.map((resource) => (
              <li key={resource.id}>
                <Checkbox
                  label={resource.title}
                  checked={resourceIds.includes(resource.id)}
                  onChange={() => setResourceIds((ids) => toggleIn(ids, resource.id))}
                />
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
              <Select
                value={channelId === '' ? undefined : channelId}
                placeholder="No channel selected"
                onValueChange={(value) => setChannelId(value === '__none' ? '' : value)}
                options={[
                  { value: '__none', label: 'No channel selected' },
                  ...[...data.channels]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((channel) => ({ value: channel.id, label: `#${channel.name}` })),
                ]}
              />
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
export function TicketsCard({
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
export function DecisionsCard({
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
                    <Textarea
                      aria-label={`Memory content ${d.id}`}
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
                    <Select
                      aria-label={`Memory subject ${d.id}`}
                      value={
                        (memoryDrafts[d.id]?.subjectId ?? '') === ''
                          ? '__none'
                          : (memoryDrafts[d.id]?.subjectId ?? '')
                      }
                      onValueChange={(value) =>
                        setMemoryDrafts((all) => ({
                          ...all,
                          [d.id]: {
                            section: all[d.id]?.section ?? '',
                            content: all[d.id]?.content ?? d.summary,
                            subjectId: value === '__none' ? '' : value,
                          },
                        }))
                      }
                      options={[
                        { value: '__none', label: 'Club-wide' },
                        ...(data.members ?? []).map((member) => ({
                          value: member.id,
                          label: member.name,
                        })),
                      ]}
                    />
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
