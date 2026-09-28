import { useCallback, useState } from 'react';
import { Link, useParams } from 'wouter';
import { ApiError } from '../api.js';
import {
  ASSISTANT_URL,
  behaviourUrl,
  skillScopeUrl,
  skillUrl,
  type AssistantData,
  type GuildRoleInfo,
  type SkillDetail,
  type SkillScopeMode,
  type SkillScopeView,
  type SkillTool,
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
import { behaviourBody, RoleChecklist, skillEffectLabel, toggleIn } from './assistant-shared.js';
import { SkillItemsCard } from './skill-items.js';

/** Loaded (found or not): a 404 renders the empty state through `DataState`, not a thrown error. */
type SkillDetailResource = { readonly found: false } | ({ readonly found: true } & SkillDetail);

/** Plain words for a tool parameter's JSON Schema constraints. */
function limitsText(prop: SkillTool['parameters']['properties'][string]): string {
  const parts: string[] = [];
  if (prop.enum !== undefined) return `one of ${prop.enum.join(', ')}`;
  if (prop.minLength !== undefined || prop.maxLength !== undefined) {
    parts.push(
      prop.minLength !== undefined && prop.maxLength !== undefined
        ? `${prop.minLength}–${prop.maxLength} characters`
        : prop.maxLength !== undefined
          ? `up to ${prop.maxLength} characters`
          : `at least ${prop.minLength} characters`,
    );
  }
  if (prop.minimum !== undefined || prop.maximum !== undefined) {
    parts.push(
      prop.minimum !== undefined && prop.maximum !== undefined
        ? `${prop.minimum}–${prop.maximum}`
        : prop.maximum !== undefined
          ? `up to ${prop.maximum}`
          : `at least ${prop.minimum}`,
    );
  }
  return parts.length === 0 ? '—' : parts.join(', ');
}

function ToolCard({ tool }: { readonly tool: SkillTool }) {
  const params = Object.entries(tool.parameters.properties);
  const required = new Set(tool.parameters.required ?? []);
  return (
    <li className="rounded-md border border-line bg-canvas p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="font-mono text-sm font-medium">{tool.name}</p>
        <Badge tone="neutral">{tool.rounds === 'first' ? 'First round only' : 'Any round'}</Badge>
      </div>
      <p className="mt-1 text-xs text-ink-muted">{tool.description}</p>
      {params.length === 0 ? (
        <p className="mt-2 text-xs text-ink-muted">No parameters.</p>
      ) : (
        <table className="mt-2 w-full text-left text-xs">
          <caption className="sr-only">{`${tool.name} parameters`}</caption>
          <thead>
            <tr className="text-ink-muted">
              <th scope="col" className="pr-3 font-normal">
                Parameter
              </th>
              <th scope="col" className="pr-3 font-normal">
                Type
              </th>
              <th scope="col" className="pr-3 font-normal">
                Required
              </th>
              <th scope="col" className="font-normal">
                Limits
              </th>
            </tr>
          </thead>
          <tbody>
            {params.map(([name, prop]) => (
              <tr key={name}>
                <td className="py-0.5 pr-3 font-mono">{name}</td>
                <td className="py-0.5 pr-3">{prop.type}</td>
                <td className="py-0.5 pr-3">{required.has(name) ? 'Yes' : 'No'}</td>
                <td className="py-0.5">{limitsText(prop)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </li>
  );
}

/** One behaviour's checkbox: writes the whole behaviour object, like every other allowlist edit (ADR 0060). */
function BehaviourToggle({
  row,
  skillId,
  behaviours,
  session,
  onSaved,
}: {
  readonly row: { readonly id: string; readonly name: string; readonly allowed: boolean };
  readonly skillId: string;
  readonly behaviours: AssistantData['behaviours'];
  readonly session: Session;
  readonly onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const full = behaviours.find((b) => b.id === row.id);
  const toggle = async () => {
    if (full === undefined) return;
    setBusy(true);
    try {
      const allowedSkillIds = toggleIn(full.allowedSkillIds, skillId);
      const result = await session.write(
        behaviourUrl(full.id),
        behaviourBody(full, { allowedSkillIds }),
        'PUT',
      );
      if (result !== undefined) {
        toast({ tone: 'ok', title: `${full.name} updated` });
        onSaved();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <li>
      <label className="flex items-center gap-2 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm">
        <input
          type="checkbox"
          checked={row.allowed}
          disabled={busy || full === undefined}
          onChange={() => void toggle()}
        />
        <span>{row.name}</span>
      </label>
    </li>
  );
}

/** One skill's scope editor: everyone, specific roles, or owner only (ADR 0086 decision 1). */
function ScopeEditor({
  skillId,
  scope,
  roles,
  session,
  onSaved,
}: {
  readonly skillId: string;
  readonly scope: SkillScopeView;
  readonly roles: readonly GuildRoleInfo[] | undefined;
  readonly session: Session;
  readonly onSaved: () => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<SkillScopeView['mode']>(scope.mode);
  const [roleIds, setRoleIds] = useState<readonly string[]>(scope.roleIds);
  const [busy, setBusy] = useState(false);
  const changed = mode !== scope.mode || roleIds.join('|') !== [...scope.roleIds].join('|');
  const canSave = changed && (mode !== 'roles' || roleIds.length > 0) && !busy;

  const save = async () => {
    setBusy(true);
    try {
      const result = await session.write(
        skillScopeUrl(skillId),
        { mode, roleIds: mode === 'roles' ? [...roleIds] : [] },
        'PUT',
      );
      if (result !== undefined) {
        toast({ tone: 'ok', title: 'Saved' });
        onSaved();
      }
    } finally {
      setBusy(false);
    }
  };

  const defaultNote = (forMode: SkillScopeView['mode']): string =>
    scope.isDefault && scope.mode === forMode ? ' Default for this skill.' : '';
  return (
    <div className="mt-3">
      <div role="radiogroup" aria-label="Who can use this" className="grid gap-1">
        <label className="flex items-center gap-2 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm">
          <input
            type="radio"
            name="skill-scope"
            checked={mode === 'everyone'}
            onChange={() => setMode('everyone')}
          />
          Everyone who can ask{defaultNote('everyone')}
        </label>
        <label className="flex items-center gap-2 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm">
          <input
            type="radio"
            name="skill-scope"
            checked={mode === 'roles'}
            onChange={() => setMode('roles')}
          />
          Specific roles{defaultNote('roles')}
        </label>
        <label className="flex items-center gap-2 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm">
          <input
            type="radio"
            name="skill-scope"
            checked={mode === 'owner'}
            onChange={() => setMode('owner')}
          />
          Owner only{defaultNote('owner')}
        </label>
      </div>
      {mode === 'roles' && (
        <RoleChecklist
          roles={roles}
          selected={roleIds}
          onToggle={(id) => setRoleIds((ids) => toggleIn(ids, id))}
          label="Roles that may use this skill"
        />
      )}
      <div className="mt-2">
        <Button busy={busy} disabled={!canSave} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}

/**
 * `/assistant/skills/:skillId`: one skill in full - its exact instruction,
 * where it is on, who can use it, its live items and its recent runs
 * (Task 9, Task E2).
 */
export function AssistantSkillPage() {
  const { skillId } = useParams<{ skillId: string }>();
  const session = useSession();

  const loadDetail = useCallback(
    (): Promise<SkillDetailResource> =>
      session
        .read<SkillDetail>(skillUrl(skillId))
        .then((data): SkillDetailResource => ({ found: true, ...data }))
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) return { found: false };
          throw err;
        }),
    [session, skillId],
  );
  const detail = useResource('skill', loadDetail);
  const loadAssistant = useCallback(() => session.read<AssistantData>(ASSISTANT_URL), [session]);
  const assistant = useResource('assistant behaviours', loadAssistant);

  return (
    <>
      <PageHeader
        title="Skill"
        purpose="One skill: what it does, where it's on, who can use it, and its recent runs."
        actions={
          <Link href="/assistant/skills">
            <Button>Skills</Button>
          </Link>
        }
      />
      <DataState
        resource={detail.resource}
        isEmpty={(data) => !data.found}
        empty={
          <EmptyState
            title="That skill doesn't exist."
            detail="It may have been renamed or removed."
            action={
              <Link
                className="text-sm font-medium underline underline-offset-4"
                href="/assistant/skills"
              >
                Back to Skills
              </Link>
            }
          />
        }
      >
        {(data) => {
          if (!data.found) return null;
          return (
            <div className="space-y-5">
              <Card title="Overview">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-base font-medium">{data.skill.name}</h2>
                  {data.skill.ownerOnly === true && (
                    <span className="flex shrink-0 gap-1">
                      <Badge tone="neutral">owner only</Badge>
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm">{data.skill.description}</p>
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
                  <dt className="text-ink-muted">What it does</dt>
                  <dd>{skillEffectLabel(data.skill)}</dd>
                </dl>
              </Card>
              <Card title="Where it's on">
                <p className="mb-2 text-sm text-ink-muted">
                  Turn this skill on or off per behaviour. The model only sees the skills allowed
                  here.
                </p>
                <DataState resource={assistant.resource}>
                  {(assistantData) => (
                    <ul className="grid gap-1 sm:grid-cols-2">
                      {data.behaviours.map((row) => (
                        <BehaviourToggle
                          key={row.id}
                          row={row}
                          skillId={data.skill.id}
                          behaviours={assistantData.behaviours}
                          session={session}
                          onSaved={() => {
                            detail.reload();
                            assistant.reload();
                          }}
                        />
                      ))}
                    </ul>
                  )}
                </DataState>
              </Card>
              <Card title="Who can use this">
                <p className="text-sm">{data.whoCanUse}</p>
                {data.skill.acts === true && (
                  <p className="mt-2 text-sm text-ink-muted">
                    This skill acts (it sets reminders or files proposals). It runs as soon as
                    someone allowed asks, with no confirmation step.
                  </p>
                )}
                <DataState resource={assistant.resource}>
                  {(assistantData) => (
                    <ScopeEditor
                      key={`${data.scope.mode}|${[...data.scope.roleIds].join(',')}|${String(data.scope.isDefault)}`}
                      skillId={data.skill.id}
                      scope={data.scope}
                      roles={assistantData.roles}
                      session={session}
                      onSaved={() => {
                        detail.reload();
                        assistant.reload();
                      }}
                    />
                  )}
                </DataState>
              </Card>
              <SkillItemsCard items={data.items} reload={detail.reload} />
              <Card title="What the AI is told">
                <pre className="overflow-x-auto rounded-sm border border-line bg-panel p-3 font-mono text-xs whitespace-pre-wrap">
                  {data.instructionLine}
                </pre>
              </Card>
              <Card title="Tools">
                {data.tools.length === 0 ? (
                  <p className="text-sm text-ink-muted">
                    This skill does not call any look-up tool on its own.
                  </p>
                ) : (
                  <ul className="grid gap-2 md:grid-cols-2">
                    {data.tools.map((tool) => (
                      <ToolCard key={tool.name} tool={tool} />
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="Recent runs">
                {data.recentRuns.length === 0 ? (
                  <p className="text-sm text-ink-muted">No runs yet.</p>
                ) : (
                  <ul className="grid gap-1 text-sm">
                    {data.recentRuns.map((row) => (
                      <li key={row.id}>
                        {new Date(row.at).toLocaleString('en-CA')} · {row.behaviourId} ·{' '}
                        {row.outcome}
                        {row.detail === undefined ? '' : ` (${row.detail})`}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-sm">
                  <Link className="underline" href="/assistant/history">
                    Assistant history
                  </Link>
                </p>
              </Card>
            </div>
          );
        }}
      </DataState>
    </>
  );
}
