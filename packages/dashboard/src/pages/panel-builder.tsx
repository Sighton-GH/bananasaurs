import { useCallback, useMemo, useState } from 'react';
import {
  customEmojiKey,
  emojiKeySchema,
  panelDefinitionSchema,
  unicodeEmojiKey,
  type PanelBehaviour,
} from '@bananasaurs/core';
import { ApiError } from '../api.js';
import type { GuildRoleInfo } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ChannelPicker } from '../ui/ChannelPicker.js';
import { DataTable } from '../ui/DataTable.js';
import { Field, Input } from '../ui/Field.js';

/**
 * The role-panel builder (ADR 0053): the dashboard's production creation
 * path for managed panels. Two steps — configure, then review — and the
 * submit is `POST /api/panels`, which validates the assembled definition
 * with the same `panelDefinitionSchema` the CLI's `panel create` uses. This
 * component validates against that schema too, at "review" time, so the
 * answer the operator reads here is the answer the server would give.
 *
 * Creating never publishes. The created state points at the publish lever
 * rather than pulling it: going live stays a separate, confirmed action.
 */

const MAX_OPTIONS = 25;

interface DraftOption {
  readonly optionId: string;
  readonly roleId: string;
  readonly label: string;
  /** Raw user input: unicode emoji characters, or a custom emoji snowflake. */
  readonly emoji: string;
}

const emptyOption = (): DraftOption => ({ optionId: '', roleId: '', label: '', emoji: '' });

const BEHAVIOURS: readonly { value: PanelBehaviour; label: string; help: string }[] = [
  {
    value: 'toggle',
    label: 'Toggle',
    help: 'Members pick any combination. Picking an option again removes that role.',
  },
  {
    value: 'add_only',
    label: 'Add only',
    help: 'Options only grant. Taking a role away stays an operator job.',
  },
  {
    value: 'remove_only',
    label: 'Remove only',
    help: 'Options only remove roles the member already has.',
  },
  {
    value: 'single_choice',
    label: 'Single choice',
    help: 'One option at a time. Picking another option clears the previous one.',
  },
];

const COMPONENTS: readonly { value: 'button' | 'select'; label: string; help: string }[] = [
  {
    value: 'button',
    label: 'Buttons',
    help: 'One button per option under the message. Best for a handful of short labels.',
  },
  {
    value: 'select',
    label: 'Dropdown',
    help: 'A single dropdown menu. Best when there are many options or long labels.',
  },
];

const IDENTIFIER = /^[a-z0-9_-]{1,64}$/;
const SNOWFLAKE = /^\d{17,20}$/;

/** The emoji input, spelled as an EmojiKey: all digits is a custom id, anything else is unicode. */
const emojiToKey = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (/^\d{17,20}$/.test(trimmed)) return customEmojiKey(trimmed);
  // Cheap honesty check: a unicode emoji contains no printable ASCII. Without
  // it, "banana" would convert to a structurally valid key for six Latin
  // letters — the schema cannot tell the difference either.
  if (/[\x20-\x7e]/.test(trimmed)) return `invalid:${trimmed}`;
  try {
    return unicodeEmojiKey(trimmed);
  } catch {
    return `invalid:${trimmed}`;
  }
};

interface CreatedState {
  readonly panelId: string;
}

export function PanelBuilder({
  onCreated,
  onCancel,
}: {
  readonly onCreated: (panelId: string) => void;
  readonly onCancel: () => void;
}) {
  const session = useSession();
  const loadRoles = useCallback(
    () => session.read<{ roles: readonly GuildRoleInfo[] }>('/api/guild/roles'),
    [session],
  );
  const roles = useResource('the role list', loadRoles);

  const [panelId, setPanelId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [behaviour, setBehaviour] = useState<PanelBehaviour>('toggle');
  const [component, setComponent] = useState<'button' | 'select'>('button');
  const [maxRoles, setMaxRoles] = useState('');
  const [options, setOptions] = useState<readonly DraftOption[]>([emptyOption()]);
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [created, setCreated] = useState<CreatedState | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // The selects are controlled and always match an entry; the '' fallback is
  // unreachable but keeps the types honest under noUncheckedIndexedAccess.
  const behaviourHelp = BEHAVIOURS.find((b) => b.value === behaviour)?.help ?? '';
  const componentHelp = COMPONENTS.find((c) => c.value === component)?.help ?? '';

  const roleList = roles.resource.state === 'ready' ? roles.resource.data.roles : undefined;
  const roleById = useMemo(
    () => new Map((roleList ?? []).map((r) => [r.roleId, r])),
    [roleList],
  );

  const updateOption = (index: number, patch: Partial<DraftOption>) => {
    setOptions((current) =>
      current.map((o, i) => (i === index ? { ...o, ...patch } : o)),
    );
  };

  /** Assemble the definition exactly as the submit will send it. */
  const assemble = () => ({
    panelId: panelId.trim(),
    kind: 'managed' as const,
    channelId: channelId.trim(),
    behaviour,
    component,
    ...(maxRoles.trim() !== '' ? { maxRoles: Number(maxRoles) } : {}),
    blockedRoleIds: [],
    options: options.map((o, index) => ({
      optionId: o.optionId.trim(),
      roleId: o.roleId,
      ...(o.label.trim() !== '' ? { label: o.label.trim() } : {}),
      ...(o.emoji.trim() !== '' ? { emojiKey: emojiToKey(o.emoji) } : {}),
      position: index,
    })),
  });

  /** Client-side answers, in the order the form asks the questions. */
  const validate = (): readonly string[] => {
    const found: string[] = [];
    if (!IDENTIFIER.test(panelId.trim())) {
      found.push('Panel id: lowercase letters, numbers, dashes and underscores, at most 64.');
    }
    if (!SNOWFLAKE.test(channelId.trim())) {
      found.push('Channel: pick a channel or paste its snowflake ID.');
    }
    const usable = options.filter(
      (o) => o.optionId.trim() !== '' || o.roleId !== '' || o.label.trim() !== '' || o.emoji.trim() !== '',
    );
    if (usable.length === 0) found.push('Add at least one option.');
    if (usable.length > MAX_OPTIONS) found.push(`At most ${String(MAX_OPTIONS)} options.`);
    const ids = usable.map((o) => o.optionId.trim());
    if (ids.some((id) => !IDENTIFIER.test(id))) {
      found.push('Every option needs an id: lowercase letters, numbers, dashes, at most 64.');
    }
    if (new Set(ids).size !== ids.length) found.push('Option ids must be unique.');
    if (usable.some((o) => !SNOWFLAKE.test(o.roleId))) {
      found.push('Every option needs a role.');
    }
    // Discord requires a label on buttons and dropdown options; the shared
    // schema refuses without one, so say it here first.
    if (usable.some((o) => o.label.trim() === '')) {
      found.push('Every option needs a label — Discord requires one on buttons and dropdowns.');
    }
    const roleIds = usable.map((o) => o.roleId).filter((r) => r !== '');
    if (new Set(roleIds).size !== roleIds.length) {
      found.push('Each role can appear once — two options cannot grant the same role.');
    }
    for (const o of usable) {
      if (o.emoji.trim() === '') continue;
      const key = emojiToKey(o.emoji);
      if (key === undefined || key.startsWith('invalid:') || !emojiKeySchema.safeParse(key).success) {
        found.push(`"${o.emoji.trim()}" is not a usable emoji — paste one emoji or a custom emoji ID.`);
        break;
      }
    }
    const notOptionable = usable.filter((o) => {
      const role = roleById.get(o.roleId);
      return role !== undefined && !role.optionable;
    });
    if (notOptionable.length > 0) {
      found.push(
        `Not available as panel options: ${notOptionable
          .map((o) => roleById.get(o.roleId)?.name ?? o.roleId)
          .join(', ')} — a panel option must be a role Bananasaurs manages.`,
      );
    }
    if (maxRoles.trim() !== '' && (!/^\d+$/.test(maxRoles.trim()) || Number(maxRoles) < 1)) {
      found.push('Max roles per member: a whole number of 1 or more, or leave it empty.');
    }
    return found;
  };

  const review = (e: React.FormEvent) => {
    e.preventDefault();
    const found = [...validate()];
    // The same schema the server runs — disagreements between this list and
    // that schema are bugs worth seeing twice, here and in the server logs.
    if (found.length === 0) {
      const parsed = panelDefinitionSchema.safeParse(assemble());
      if (!parsed.success) {
        found.push(
          ...parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
      }
    }
    setProblems(found);
    if (found.length === 0) setStep('review');
  };

  const submit = async () => {
    setBusy(true);
    setSubmitError(undefined);
    try {
      const result = await session.writeOrThrow<{ ok: boolean; panelId: string }>(
        '/api/panels',
        assemble(),
      );
      if (result !== undefined) setCreated({ panelId: result.panelId });
    } catch (err) {
      // writeOrThrow lets the server's 400/409 answers through; everything
      // else already became a toast. Render the answer, keep the draft.
      if (err instanceof ApiError && (err.status === 400 || err.status === 409)) {
        const body = err.body as { error?: string; problems?: string; roleIds?: string[] };
        if (body.error === 'unmanaged-role') {
          setSubmitError(
            `Not managed by Bananasaurs: ${(body.roleIds ?? []).join(', ')}. ` +
              'Go back and pick different roles.',
          );
        } else if (body.error === 'invalid-definition') {
          setSubmitError(body.problems ?? 'The definition failed validation.');
        } else if (body.error === 'already-exists') {
          setSubmitError(
            `A panel named "${panelId.trim()}" already exists — panel ids are immutable. ` +
              'Go back and pick a new one.',
          );
        } else {
          setSubmitError('The server could not use what the form produced.');
        }
      } else {
        setSubmitError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  if (created !== undefined) {
    return (
      <Card title="Panel created">
        <p className="text-sm">
          <strong>{created.panelId}</strong> is configured — and nothing is live yet. Publishing
          posts the panel&apos;s message in Discord, and stays a separate confirmed action.
        </p>
        <div className="mt-3 flex gap-2">
          <Button variant="primary" onClick={() => onCreated(created.panelId)}>
            Open the new panel
          </Button>
          <Button
            onClick={() => {
              setCreated(undefined);
              setStep('edit');
              setPanelId('');
              setOptions([emptyOption()]);
            }}
          >
            Build another
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card title={`New role panel — ${step === 'edit' ? 'configure' : 'review'}`}>
      {step === 'edit' ? (
        <form onSubmit={review} className="grid max-w-2xl gap-4">
          <Field
            label="Panel id"
            hint="Lowercase letters, numbers, dashes. Immutable once created — members never see it."
          >
            <Input
              value={panelId}
              onChange={(e) => setPanelId(e.target.value)}
              placeholder="colour-roles"
              autoComplete="off"
            />
          </Field>
          <ChannelPicker
            label="Channel"
            hint="Where the panel's message will be posted when you publish."
            value={channelId}
            onChange={setChannelId}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Behaviour" {...(behaviourHelp !== '' ? { hint: behaviourHelp } : {})}>
              <select
                aria-label="Behaviour"
                value={behaviour}
                onChange={(e) => setBehaviour(e.target.value as PanelBehaviour)}
                className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
              >
                {BEHAVIOURS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Shown as" {...(componentHelp !== '' ? { hint: componentHelp } : {})}>
              <select
                aria-label="Shown as"
                value={component}
                onChange={(e) => setComponent(e.target.value as 'button' | 'select')}
                className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
              >
                {COMPONENTS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field
            label="Max roles per member"
            hint="Optional. Leave empty for no limit."
          >
            <Input
              value={maxRoles}
              onChange={(e) => setMaxRoles(e.target.value)}
              inputMode="numeric"
              placeholder="No limit"
              autoComplete="off"
            />
          </Field>

          <fieldset className="grid gap-3">
            <legend className="text-sm font-medium text-ink">Options</legend>
            {roles.resource.state === 'error' && (
              <p className="text-xs text-ink-muted">
                The role list is unavailable — you can still paste role IDs, but the picker cannot
                check which roles Bananasaurs manages.
              </p>
            )}
            {options.map((option, index) => (
              <div
                key={index}
                className="grid gap-2 rounded-sm border border-line p-2 sm:grid-cols-[1fr_1.4fr_1fr_6rem_auto]"
              >
                <Input
                  aria-label={`Option ${String(index + 1)} id`}
                  value={option.optionId}
                  onChange={(e) => updateOption(index, { optionId: e.target.value })}
                  placeholder="option id"
                  autoComplete="off"
                />
                <select
                  aria-label={`Option ${String(index + 1)} role`}
                  value={option.roleId}
                  onChange={(e) => updateOption(index, { roleId: e.target.value })}
                  className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
                >
                  <option value="">role…</option>
                  {(roleList ?? []).map((role) => (
                    <option key={role.roleId} value={role.roleId} disabled={!role.optionable}>
                      {role.name}
                      {role.optionable ? '' : role.managed ? ' (Discord-managed)' : ' (not bot-managed)'}
                    </option>
                  ))}
                </select>
                <Input
                  aria-label={`Option ${String(index + 1)} label`}
                  value={option.label}
                  onChange={(e) => updateOption(index, { label: e.target.value })}
                  placeholder="label"
                  autoComplete="off"
                />
                <Input
                  aria-label={`Option ${String(index + 1)} emoji`}
                  value={option.emoji}
                  onChange={(e) => updateOption(index, { emoji: e.target.value })}
                  placeholder="emoji"
                  autoComplete="off"
                />
                <Button
                  onClick={() => setOptions((current) => current.filter((_, i) => i !== index))}
                  disabled={options.length === 1}
                >
                  Remove
                </Button>
              </div>
            ))}
            <div>
              <Button
                onClick={() => setOptions((current) => [...current, emptyOption()])}
                disabled={options.length >= MAX_OPTIONS}
              >
                Add option
              </Button>
            </div>
          </fieldset>

          {problems.length > 0 && (
            <ul role="alert" className="grid gap-1 text-sm text-danger">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary">
              Review
            </Button>
            <Button onClick={onCancel}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="grid max-w-2xl gap-4">
          <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-muted">Panel</dt>
            <dd>{panelId.trim()}</dd>
            <dt className="text-ink-muted">Channel</dt>
            <dd>{channelId.trim()}</dd>
            <dt className="text-ink-muted">Behaviour</dt>
            <dd>{BEHAVIOURS.find((b) => b.value === behaviour)?.label}</dd>
            <dt className="text-ink-muted">Shown as</dt>
            <dd>{COMPONENTS.find((c) => c.value === component)?.label}</dd>
            <dt className="text-ink-muted">Max roles per member</dt>
            <dd>{maxRoles.trim() === '' ? 'no limit' : maxRoles.trim()}</dd>
          </dl>
          <DataTable
            caption="Options to create"
            rows={assemble().options}
            rowKey={(o) => o.optionId}
            columns={[
              { key: 'id', header: 'Option', cell: (o) => o.optionId },
              {
                key: 'role',
                header: 'Role',
                cell: (o) => roleById.get(o.roleId)?.name ?? o.roleId,
              },
              {
                key: 'face',
                header: 'Shown as',
                cell: (o) => o.emojiKey ?? o.label ?? '—',
              },
            ]}
          />
          <p className="text-sm text-ink-muted">
            Creating writes the configuration only. The panel reaches Discord when you publish it —
            a separate, confirmed action.
          </p>
          {submitError !== undefined && (
            <p role="alert" className="text-sm text-danger">
              {submitError}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="primary" busy={busy} onClick={() => void submit()}>
              Create panel
            </Button>
            <Button onClick={() => setStep('edit')}>Back</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
