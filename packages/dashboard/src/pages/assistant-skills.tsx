import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import {
  ASSISTANT_URL,
  behaviourUrl,
  type AssistantBehaviourView,
  type AssistantData,
} from '../api/assistant.js';
import { useSession, type Session } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { EmptyState } from '../ui/EmptyState.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';
import { behaviourBody, skillEffectLabel, toggleIn } from './assistant-shared.js';

/**
 * One behaviour's skill allowlist - the ONLY place allowlists are edited
 * (ADR 0060). Writes the whole behaviour object with everything else
 * preserved, so an allowlist save can never clobber a prompt edit.
 */
function BehaviourAllowlistEditor({
  behaviour,
  data,
  session,
  onSaved,
}: {
  readonly behaviour: AssistantBehaviourView;
  readonly data: AssistantData;
  readonly session: Session;
  readonly onSaved: () => void;
}) {
  const toast = useToast();
  const [allowedSkillIds, setAllowedSkillIds] = useState<readonly string[]>(
    behaviour.allowedSkillIds,
  );
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const result = await session.write(
        behaviourUrl(behaviour.id),
        behaviourBody(behaviour, { allowedSkillIds }),
        'PUT',
      );
      if (result !== undefined) {
        toast({ tone: 'ok', title: `${behaviour.name} allowlist saved` });
        onSaved();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label={`Allowlist for ${behaviour.name}`}
      className="border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0"
    >
      <h3 className="text-sm font-medium">
        {behaviour.name}{' '}
        <span className="font-normal text-ink-muted">
          ({behaviour.surface === 'direct-command' ? 'direct command' : `@${behaviour.surface}`})
        </span>
      </h3>
      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
        {data.skills.map((skill) => (
          <li key={skill.id}>
            <label className="flex items-start gap-2 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm">
              <input
                type="checkbox"
                checked={allowedSkillIds.includes(skill.id)}
                onChange={() => setAllowedSkillIds((ids) => toggleIn(ids, skill.id))}
              />
              <span>
                <span className="block">{skill.name}</span>
                <span className="text-xs text-ink-muted">{skillEffectLabel(skill)}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {allowedSkillIds.length === 0 && (
        <p role="status" className="mt-2 text-xs text-hold">
          Nothing is allowed: this behaviour can answer from its instructions and reviewed sources,
          but cannot do anything.
        </p>
      )}
      <div className="mt-2">
        <Button
          busy={busy}
          disabled={allowedSkillIds.join('|') === behaviour.allowedSkillIds.join('|')}
          onClick={() => void save()}
        >
          Save allowlist
        </Button>
      </div>
    </section>
  );
}

const TOOLS = [
  {
    id: 'search_archive',
    name: 'Search the Discord archive',
    detail:
      'Searches messages in archived channels the asking member can see. Private threads are never searched.',
  },
  {
    id: 'open_resource',
    name: 'Open a club resource',
    detail: "Reads any enabled resource. A behaviour's emphasised resources are read first.",
  },
  {
    id: 'web_search',
    name: 'Search the web',
    detail:
      'Sends a short query to the Brave Search API. Queries that look like they carry personal data are refused.',
  },
  {
    id: 'server_info',
    name: 'Server and channels',
    detail: 'Reads the server card and the channels the asking member can see.',
  },
  {
    id: 'current_time',
    name: 'Date and time',
    detail: "Today's date and time in the club's time zone.",
  },
  {
    id: 'my_reminders',
    name: 'My reminders',
    detail: "The asking member's own upcoming reminders.",
  },
] as const;

/**
 * ADR 0067: the read-only tools the assistant can call on its own. They
 * are not skills: every behaviour has them, nothing they do writes.
 */
function ToolsCard({ data }: { readonly data: AssistantData }) {
  const webOn = data.aiStatus?.webSearch?.enabled === true;
  return (
    <Card title="Look-up tools">
      <p className="mb-3 text-sm text-ink-muted">
        Besides its skills, the assistant can look things up on its own while it answers. These
        tools only read; none of them can change anything.
      </p>
      <ul className="grid gap-2 md:grid-cols-2">
        {TOOLS.map((tool) => (
          <li key={tool.id} className="rounded-md border border-line bg-canvas p-3">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium">{tool.name}</p>
              {tool.id === 'web_search' && (
                <Badge tone={webOn ? 'ok' : 'neutral'}>{webOn ? 'On' : 'Off'}</Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-ink-muted">{tool.detail}</p>
            {tool.id === 'web_search' && !webOn && (
              <Link className="mt-1 inline-block text-xs underline" href="/providers">
                Set up web search
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** One skill in full: what it does, where it is allowed, who can use it, recent runs. */
function SkillDetails({
  skill,
  data,
  onClose,
}: {
  readonly skill: AssistantData['skills'][number];
  readonly data: AssistantData;
  readonly onClose: () => void;
}) {
  const allowedOn = data.behaviours.filter((b) => b.allowedSkillIds.includes(skill.id));
  const roleName = (id: string) => data.roles?.find((r) => r.id === id)?.name;
  const roleIds = [...new Set(allowedOn.flatMap((b) => b.callerRoleIds ?? []))];
  const roles = roleIds.map((id) => `@${roleName(id) ?? 'a role that left the server'}`);
  const who =
    skill.ownerOnly === true
      ? 'Only the server owner.'
      : roles.length === 0
        ? 'Only the server owner, until a behaviour that allows it has Who can ask roles.'
        : `${roles.join(', ')}, and the server owner`;
  const runs = data.activity
    .filter((row) => row.skillId === skill.id)
    .sort((a, b) => b.at - a.at)
    .slice(0, 20);
  const behaviourName = (id: string) => data.behaviours.find((b) => b.id === id)?.name ?? id;
  return (
    <section
      aria-label={`${skill.name} details`}
      className="mt-3 rounded-md border border-ink bg-panel p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium">{skill.name}</h3>
        <Button onClick={onClose}>Close</Button>
      </div>
      <p className="mt-1 text-sm">{skill.description}</p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-ink-muted">What it does</dt>
        <dd>{skillEffectLabel(skill)}</dd>
        <dt className="text-ink-muted">Allowed on</dt>
        <dd>
          {allowedOn.length === 0 ? (
            'No behaviour allows it yet.'
          ) : (
            <ul>
              {allowedOn.map((b) => (
                <li key={b.id}>{b.name}</li>
              ))}
            </ul>
          )}
        </dd>
        <dt className="text-ink-muted">Who can use it</dt>
        <dd>{who}</dd>
        <dt className="text-ink-muted">Recent runs</dt>
        <dd>
          {runs.length === 0 ? (
            'No runs yet.'
          ) : (
            <ul className="grid gap-1">
              {runs.map((row) => (
                <li key={row.id}>
                  {new Date(row.at).toLocaleString('en-CA')} · {behaviourName(row.behaviourId)} ·{' '}
                  {row.outcome}
                  {row.detail === undefined ? '' : ` (${row.detail})`}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
    </section>
  );
}

/**
 * `/assistant/skills`: the skill catalogue (each skill opens its details),
 * the look-up tools, the per-behaviour allowlists and the one rule for who
 * can use them (ADR 0060, 0064, 0067).
 */
export function AssistantSkillsPage() {
  const session = useSession();
  const load = useCallback(() => session.read<AssistantData>(ASSISTANT_URL), [session]);
  const assistant = useResource('assistant skills', load);
  const [open, setOpen] = useState<string | undefined>(undefined);
  return (
    <>
      <PageHeader
        title="Skills"
        purpose="Everything the assistant can do in this server, the tools it can look things up with, and which behaviours may use each skill."
        actions={
          <Link href="/assistant/activity">
            <Button>Assistant history</Button>
          </Link>
        }
      />
      <DataState
        resource={assistant.resource}
        isEmpty={(data) => data.skills.length === 0}
        empty={
          <EmptyState
            title="No skills reported"
            detail="This server build did not report a skill catalogue. Nothing here is editable and the assistant's current policy keeps applying."
          />
        }
      >
        {(data) => {
          const openSkill = data.skills.find((skill) => skill.id === open);
          return (
            <div className="space-y-5">
              <Card title="Skill catalogue">
                <p className="mb-3 text-sm text-ink-muted">
                  Every skill the assistant could use in this server. Select one to see where it is
                  allowed, who can use it and its recent runs.
                </p>
                <ul className="grid gap-3 md:grid-cols-2">
                  {data.skills.map((skill) => (
                    <li key={skill.id}>
                      <button
                        type="button"
                        aria-label={skill.name}
                        aria-expanded={open === skill.id}
                        onClick={() => setOpen((id) => (id === skill.id ? undefined : skill.id))}
                        className={`w-full rounded-md border bg-canvas p-3 text-left ${open === skill.id ? 'border-ink' : 'border-line'}`}
                      >
                        <span className="flex items-start justify-between gap-3">
                          <span className="text-sm font-medium">{skill.name}</span>
                          <span className="flex shrink-0 gap-1">
                            {skill.ownerOnly === true && <Badge tone="neutral">owner only</Badge>}
                            <Badge tone={skill.requiresConfirmation ? 'hold' : 'ok'}>
                              {skill.requiresConfirmation
                                ? 'You confirm first'
                                : 'Runs without asking'}
                            </Badge>
                          </span>
                        </span>
                        <span className="mt-1 block text-xs text-ink-muted">
                          {skill.description}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {openSkill !== undefined && (
                  <SkillDetails skill={openSkill} data={data} onClose={() => setOpen(undefined)} />
                )}
              </Card>
              <ToolsCard data={data} />
              <Card title="Allowlists per behaviour">
                <p className="mb-1 text-sm text-ink-muted">
                  For each behaviour, choose the skills it may use. The model only sees the skills
                  allowed here.
                </p>
                {data.behaviours.length === 0 ? (
                  <p className="text-sm text-ink-muted">
                    No behaviours configured yet. Create one on the{' '}
                    <Link className="underline" href="/assistant">
                      Assistant page
                    </Link>
                    .
                  </p>
                ) : (
                  data.behaviours.map((behaviour) => (
                    <BehaviourAllowlistEditor
                      key={behaviour.id}
                      behaviour={behaviour}
                      data={data}
                      session={session}
                      onSaved={assistant.reload}
                    />
                  ))
                )}
              </Card>
              <Card title="Who can use skills">
                <p className="text-sm text-ink-muted">
                  Anyone a behaviour lets ask (its Who can ask roles on the Assistant page) can use
                  every skill that behaviour allows. Owner-only skills stay with the server owner.
                </p>
              </Card>
              <p className="text-sm text-ink-muted">
                Recent runs, with what the assistant did and how each turn ended, are on{' '}
                <Link className="underline" href="/assistant/activity">
                  Assistant history
                </Link>
                .
              </p>
            </div>
          );
        }}
      </DataState>
    </>
  );
}
