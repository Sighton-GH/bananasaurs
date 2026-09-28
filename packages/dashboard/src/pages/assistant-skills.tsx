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
import { behaviourBody, scopeLabel, skillEffectLabel, toggleIn } from './assistant-shared.js';

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
  const [preferredSkillIds, setAllowedSkillIds] = useState<readonly string[]>(
    behaviour.preferredSkillIds,
  );
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const result = await session.write(
        behaviourUrl(behaviour.id),
        behaviourBody(behaviour, { preferredSkillIds }),
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
                checked={preferredSkillIds.includes(skill.id)}
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
      {preferredSkillIds.length === 0 && (
        <p role="status" className="mt-2 text-xs text-hold">
          Nothing is allowed: this behaviour can answer from its instructions and reviewed sources,
          but cannot do anything.
        </p>
      )}
      <div className="mt-2">
        <Button
          busy={busy}
          disabled={preferredSkillIds.join('|') === behaviour.preferredSkillIds.join('|')}
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

/**
 * `/assistant/skills`: the skill catalogue (each skill links to its own
 * detail page, `/assistant/skills/:skillId`), the look-up tools, the
 * per-behaviour allowlists and the one rule for who can use them (ADR 0060,
 * 0064, 0067).
 */
export function AssistantSkillsPage() {
  const session = useSession();
  const load = useCallback(() => session.read<AssistantData>(ASSISTANT_URL), [session]);
  const assistant = useResource('assistant skills', load);
  return (
    <>
      <PageHeader
        title="Skills"
        purpose="What the assistant can do, where each skill is on, and who can use it."
        actions={
          <Link href="/assistant/history">
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
          return (
            <div className="space-y-5">
              <Card title="Skill catalogue">
                <p className="mb-3 text-sm text-ink-muted">
                  Every skill the assistant could use in this server. Open one to see where it is
                  allowed, who can use it and its recent runs.
                </p>
                <ul className="grid gap-3 md:grid-cols-2">
                  {data.skills.map((skill) => {
                    const scope = data.skillScopes?.[skill.id];
                    const activeCount = data.skillItemCounts?.[skill.id] ?? 0;
                    const roleName = (id: string) =>
                      data.roles?.find((role) => role.id === id)?.name;
                    return (
                      <li key={skill.id}>
                        <Link
                          href={`/assistant/skills/${encodeURIComponent(skill.id)}`}
                          aria-label={skill.name}
                          className="block w-full rounded-md border border-line bg-canvas p-3 text-left"
                        >
                          <span className="flex items-start justify-between gap-3">
                            <span className="text-sm font-medium">{skill.name}</span>
                            <span className="flex shrink-0 gap-1">
                              {scope !== undefined ? (
                                <Badge tone="neutral">{scopeLabel(scope, roleName)}</Badge>
                              ) : (
                                skill.ownerOnly === true && <Badge tone="neutral">owner only</Badge>
                              )}
                              {activeCount > 0 && (
                                <Badge tone="ok">{`${String(activeCount)} active`}</Badge>
                              )}
                            </span>
                          </span>
                          <span className="mt-1 block text-xs text-ink-muted">
                            {skill.description}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
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
                  Each skill&apos;s scope decides who can use it; the owner can always use every
                  skill.
                </p>
              </Card>
              <p className="text-sm text-ink-muted">
                Recent runs, with what the assistant did and how each turn ended, are on{' '}
                <Link className="underline" href="/assistant/history">
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
