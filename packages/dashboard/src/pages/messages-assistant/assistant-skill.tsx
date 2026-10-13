import { DraftFooter } from './draft-footer.js';
import { FormSection } from '../../ui/FormSection.js';
import { Moment } from './time.js';
import { NotFound, Empty } from '../../ui/states.js';
import { ErrorSummary } from '../../ui/ErrorSummary.js';
import { ErrorNotice } from '../../ui/ErrorNotice.js';
import { useFieldErrors } from '../../hooks/useFieldErrors.js';
import { DataTable } from '../../ui/DataTable.js';
import { CodeBlock } from '../../ui/CodeBlock.js';
import { useCallback, useState } from 'react';
import { useParams } from 'wouter';
import { Link } from '../../ui/Link.js';
import { ApiError } from '../../api.js';
import {
  ASSISTANT_URL,
  skillScopeUrl,
  skillUrl,
  type AssistantData,
  type GuildRoleInfo,
  type SkillDetail,
  type SkillScopeMode,
  type SkillScopeView,
  type SkillTool,
} from '../../api/assistant.js';
import { useSession, type Session } from '../../app/session.js';
import { useResource } from '../../hooks/useResource.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { DataState } from '../../ui/DataState.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { useToast } from '../../ui/Toast.js';
import { RoleChecklist, skillEffectLabel, toggleIn } from '../assistant-shared.js';
import { RadioGroup } from '../../ui/RadioGroup.js';
import { SkillItemsCard } from '../skill-items.js';

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

/** Plain words for a tool's round scope. */
const ROUNDS_LABEL: Record<SkillTool['rounds'], string> = {
  first: 'First round only',
  all: 'Any round',
  'returned-id': 'Round 1, or later with a returned id',
};

function ToolCard({ tool }: { readonly tool: SkillTool }) {
  const params = Object.entries(tool.parameters.properties);
  const required = new Set(tool.parameters.required ?? []);
  return (
    <li className="rounded-md border border-line bg-canvas p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="font-mono text-sm font-medium">{tool.name}</p>
        <Badge tone="neutral">{ROUNDS_LABEL[tool.rounds]}</Badge>
      </div>
      <p className="mt-1 text-xs text-ink-muted">{tool.description}</p>
      {params.length === 0 ? (
        <p className="mt-2 text-xs text-ink-muted">No parameters.</p>
      ) : (
        <DataTable
          caption={`${tool.name} parameters`}
          rows={params}
          rowKey={([name]) => name}
          columns={[
            {
              key: 'name',
              header: 'Parameter',
              cell: ([name]) => <span className="font-mono">{name}</span>,
            },
            { key: 'type', header: 'Type', cell: ([, prop]) => prop.type },
            {
              key: 'required',
              header: 'Required',
              cell: ([name]) => (required.has(name) ? 'Yes' : 'No'),
            },
            { key: 'limits', header: 'Limits', cell: ([, prop]) => limitsText(prop) },
          ]}
        />
      )}
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
  const fields = useFieldErrors();
  const [error, setError] = useState<unknown>();
  const [mode, setMode] = useState<SkillScopeMode>(scope.mode);
  const [roleIds, setRoleIds] = useState<readonly string[]>(scope.roleIds);
  const [busy, setBusy] = useState(false);
  const changed = mode !== scope.mode || roleIds.join('|') !== [...scope.roleIds].join('|');
  const canSave = changed && (mode !== 'roles' || roleIds.length > 0) && !busy;

  const save = async () => {
    setBusy(true);
    try {
      fields.clear();
      setError(undefined);
      const result = await session.writeOrThrow(
        skillScopeUrl(skillId),
        { mode, roleIds: mode === 'roles' ? [...roleIds] : [] },
        'PUT',
      );
      if (result !== undefined) {
        toast({ tone: 'ok', title: 'Saved' });
        onSaved();
      }
    } catch (err) {
      fields.capture(err);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const defaultNote = (forMode: SkillScopeMode): string =>
    scope.isDefault && scope.mode === forMode ? ' Default for this skill.' : '';
  const modeError = fields.errorFor('mode');
  return (
    <div className="mt-3">
      <form
        id="scope-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) void save();
        }}
      >
        <FormSection title="Skill scope">
          <ErrorSummary errors={fields.summary} />
          {error !== undefined && <ErrorNotice error={error} />}
          <RadioGroup
            legend="Who can use this"
            name="skill-scope"
            id="field-mode"
            value={mode}
            onChange={(value) => setMode(value as SkillScopeMode)}
            options={[
              { value: 'everyone', label: `Everyone who can ask${defaultNote('everyone')}` },
              { value: 'roles', label: `Specific roles${defaultNote('roles')}` },
              { value: 'owner', label: `Owner only${defaultNote('owner')}` },
            ]}
            {...(modeError === undefined ? {} : { error: modeError })}
          />
          {mode === 'roles' && (
            <div
              id="field-roleIds"
              tabIndex={-1}
              aria-describedby={
                fields.errorFor('roleIds') === undefined ? undefined : 'scope-roles-error'
              }
            >
              <RoleChecklist
                roles={roles}
                selected={roleIds}
                onToggle={(id) => setRoleIds((ids) => toggleIn(ids, id))}
                label="Roles that may use this skill"
              />
              {fields.errorFor('roleIds') !== undefined && (
                <p id="scope-roles-error" role="alert">
                  {fields.errorFor('roleIds')}
                </p>
              )}
            </div>
          )}
          <DraftFooter
            dirty={changed}
            show={canSave}
            busy={busy}
            onSave={() => {
              const form = document.getElementById('scope-form');
              if (form instanceof HTMLFormElement) form.requestSubmit();
            }}
            onDiscard={() => {
              setMode(scope.mode);
              setRoleIds(scope.roleIds);
              fields.clear();
              setError(undefined);
            }}
          />
          <div hidden={changed && canSave} className="mt-2">
            <Button busy={busy} disabled={!canSave} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </FormSection>
      </form>
    </div>
  );
}

/**
 * `/assistant/skills/:skillId`: one skill in full - its exact instruction,
 * who can use it, its live items and its recent runs (Task 9, Task E2). A
 * skill's scope is its only gate (ADR 0087); behaviours prefer it on the
 * Behaviours tab.
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
        title={
          detail.resource.state === 'ready' && detail.resource.data.found
            ? detail.resource.data.skill.name
            : 'Skill'
        }
        crumbs={[{ label: 'Skills', href: '/assistant/skills' }]}
        purpose="One skill: what it does, who can use it, and its recent runs."
        actions={
          <Link href="/assistant/skills">
            <Button>Skills</Button>
          </Link>
        }
      />
      <DataState
        resource={detail.resource}
        isEmpty={(data) => !data.found}
        empty={<NotFound what="skill" backHref="/assistant/skills" backLabel="Back to Skills" />}
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
              <Card title="Who can use this">
                <p className="text-sm">{data.whoCanUse}</p>
                <p className="mt-2 text-sm text-ink-muted">
                  Any assistant can use this skill for people allowed above. Assistants can prefer
                  it on the Behaviours tab.
                </p>
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
                <CodeBlock label="Skill instructions" code={data.instructionLine} />
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
                  <Empty
                    title="No runs yet."
                    action={<Link href="/assistant/history">Open assistant history</Link>}
                  />
                ) : (
                  <ul className="grid gap-1 text-sm">
                    {data.recentRuns.map((row) => (
                      <li key={row.id}>
                        {<Moment at={row.at} />} · {row.behaviourId} · {row.outcome}
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
