import { Field, Input } from '../ui/Field.js';
import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import { ASSISTANT_URL, type AssistantData } from '../api/assistant.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { EmptyState } from '../ui/EmptyState.js';
import { PageHeader } from '../ui/PageHeader.js';
import { scopeLabel } from './assistant-shared.js';

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
  {
    id: 'find_member',
    name: 'Find a member',
    detail: 'Looks up a member by name; returns display names, never ids.',
  },
] as const;

/**
 * ADR 0067: the read-only tools the assistant can call on its own. They
 * are not skills: every behaviour has them, nothing they do writes.
 */
function ToolsCard({ data }: { readonly data: AssistantData }) {
  const webOn = data.aiStatus?.webSearch?.enabled === true;
  const webSource = data.aiStatus?.webSearch?.source ?? 'brave';
  const webDetail =
    webSource === 'tavily'
      ? 'Sends a short query to the Tavily search API. Queries that look like they carry personal data are refused.'
      : webSource === 'parallel'
        ? 'Sends a short query to the Parallel search API. Parallel may use queries to train its models.'
        : 'Sends a short query to the Brave Search API. Queries that look like they carry personal data are refused.';
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
            <p className="mt-1 text-xs text-ink-muted">
              {tool.id === 'web_search' ? webDetail : tool.detail}
            </p>
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
 * detail page, `/assistant/skills/:skillId`), the look-up tools, and the one
 * rule for who can use them. A skill's scope is its only gate (ADR 0087);
 * behaviours prefer skills on the Behaviours tab.
 */
export function AssistantSkillsPage() {
  const session = useSession();
  const [filter, setFilter] = useState('');
  const load = useCallback(() => session.read<AssistantData>(ASSISTANT_URL), [session]);
  const assistant = useResource('assistant skills', load);
  return (
    <>
      <PageHeader
        title="Skills"
        purpose="What the assistant can do and who can use it."
        actions={
          <Link href="/assistant/history">
            <Button>Assistant history</Button>
          </Link>
        }
      />
      <div className="mb-3 max-w-2xl">
        <Field label="Filter skills">
          <Input value={filter} onChange={(event) => setFilter(event.target.value)} />
        </Field>
      </div>
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
          const rows = data.skills.filter((skill) =>
            `${skill.name} ${skill.description}`.toLowerCase().includes(filter.toLowerCase()),
          );
          return (
            <div className="space-y-5">
              <Card title="Skill catalogue">
                <p className="mb-3 text-sm text-ink-muted">
                  Every skill the assistant could use in this server. Open one to see who can use it
                  and its recent runs.
                </p>
                {rows.length === 0 && (
                  <EmptyState
                    title="No skills match these filters"
                    action={<Button onClick={() => setFilter('')}>Clear filters</Button>}
                  />
                )}
                <ul className="grid gap-3 md:grid-cols-2">
                  {rows.map((skill) => {
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
