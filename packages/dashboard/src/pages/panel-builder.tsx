import { useCallback, useMemo, useState } from 'react';
import {
  customEmojiKey,
  emojiKeySchema,
  isCustomEmojiKey,
  panelDefinitionSchema,
  unicodeEmojiChars,
  unicodeEmojiKey,
  type PanelBehaviour,
  type PanelComponent,
} from '@bananasaurs/core';
import { ApiError } from '../api.js';
import type { GuildChannelInfo, GuildRoleInfo } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ChannelPicker } from '../ui/ChannelPicker.js';
import { DataTable } from '../ui/DataTable.js';
import { Field, Input } from '../ui/Field.js';
import { HelpTip } from '../ui/HelpTip.js';

/**
 * The self-granted roles builder (ADRs 0053 and 0054, Bryan's roles lane):
 * the dashboard's creation path, offered in plain language. The first
 * question is the type - a **reaction role** (members react with an emoji
 * on a message that already exists, attached by channel + message id and
 * validated against live Discord before anything is written) or a **role
 * panel** (the bot posts a message with buttons or a dropdown) - and each
 * type gets its own form instead of one mixed form. Configure, then review;
 * the submit is `POST /api/panels`, validated with the same
 * `panelDefinitionSchema` the CLI's `panel create` uses.
 *
 * Creating never publishes. The created state points at the publish lever
 * rather than pulling it: going live stays a separate, confirmed action.
 */

const MAX_OPTIONS = 25;
const MAX_CONTENT = 2000;

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

const FORMATS: readonly { value: PanelComponent; label: string; help: string }[] = [
  {
    value: 'reaction',
    label: 'Emoji reactions',
    help: 'Members add an emoji reaction on the message to get the role, and remove their reaction to give it up. The classic reaction-role style; every option needs an emoji.',
  },
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
  // Honesty check: a unicode emoji needs at least one codepoint beyond
  // printable ASCII — a pictograph, or the keycap/variation-selector marks
  // that turn 1, # or * into a keycap emoji. Without it, "banana" would
  // convert to a structurally valid key for six Latin letters — the schema
  // cannot tell the difference either.
  if (!/[^\x20-\x7e]/u.test(trimmed)) return `invalid:${trimmed}`;
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
  // Channel names for the review step; the picker owns the picking, but an
  // ID alone means nothing on the confirmation card.
  const loadChannels = useCallback(
    () => session.read<{ channels: readonly GuildChannelInfo[] }>('/api/guild/channels'),
    [session],
  );
  const channels = useResource('the channel list', loadChannels);
  const channelName = (id: string) =>
    (channels.resource.state === 'ready'
      ? channels.resource.data.channels.find((c) => c.channelId === id)?.name
      : undefined) ?? id;

  // The first question: which kind of self-granted role setup (Bryan's
  // lane). `undefined` shows the type-choice step.
  const [choice, setChoice] = useState<'reaction' | 'panel' | undefined>(undefined);
  const [panelId, setPanelId] = useState('');
  const [channelId, setChannelId] = useState('');
  // Reaction role: the existing message members react to, plus the live
  // check's verdict. 'failed' blocks review - attaching to a guessed id is
  // exactly what the check exists to prevent.
  const [messageId, setMessageId] = useState('');
  const [messageCheck, setMessageCheck] = useState<'idle' | 'checking' | 'ok' | 'failed'>('idle');
  const [content, setContent] = useState('');
  const [behaviour, setBehaviour] = useState<PanelBehaviour>('toggle');
  const [format, setFormat] = useState<PanelComponent>('reaction');
  const [maxRoles, setMaxRoles] = useState('');
  const [requiredRoleId, setRequiredRoleId] = useState('');
  const [blockedRoleIds, setBlockedRoleIds] = useState<readonly string[]>([]);
  const [options, setOptions] = useState<readonly DraftOption[]>([emptyOption()]);
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [created, setCreated] = useState<CreatedState | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // The selects are controlled and always match an entry; the '' fallback is
  // unreachable but keeps the types honest under noUncheckedIndexedAccess.
  const behaviourHelp = BEHAVIOURS.find((b) => b.value === behaviour)?.help ?? '';
  const formatHelp = FORMATS.find((f) => f.value === format)?.help ?? '';
  const isReaction = choice === 'reaction';
  // single_choice cannot work on somebody else's message: clearing a stale
  // reaction needs Manage Messages, which the bot deliberately does not hold.
  const behaviours = isReaction
    ? BEHAVIOURS.filter((b) => b.value !== 'single_choice')
    : BEHAVIOURS;
  const formats = FORMATS.filter((f) => f.value !== 'reaction');

  /** The live target check for a reaction role's existing message. */
  const checkMessage = async (): Promise<void> => {
    setMessageCheck('checking');
    try {
      const result = await session.read<{ lookup: string }>(
        `/api/guild/channels/${channelId.trim()}/messages/${messageId.trim()}`,
      );
      setMessageCheck(result?.lookup === 'ok' ? 'ok' : 'failed');
    } catch {
      setMessageCheck('failed');
    }
  };

  const roleList = roles.resource.state === 'ready' ? roles.resource.data.roles : undefined;
  const roleById = useMemo(() => new Map((roleList ?? []).map((r) => [r.roleId, r])), [roleList]);
  const roleName = (roleId: string) => roleById.get(roleId)?.name ?? roleId;

  const updateOption = (index: number, patch: Partial<DraftOption>) => {
    setOptions((current) => current.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  };

  const toggleBlocked = (roleId: string) => {
    setBlockedRoleIds((current) =>
      current.includes(roleId) ? current.filter((r) => r !== roleId) : [...current, roleId],
    );
  };

  /** Assemble the definition exactly as the submit will send it. */
  const assemble = () => ({
    panelId: panelId.trim(),
    kind: isReaction ? ('adopted' as const) : ('managed' as const),
    channelId: channelId.trim(),
    behaviour,
    component: isReaction ? ('reaction' as const) : format,
    ...(isReaction ? { messageId: messageId.trim() } : {}),
    // An adopted message keeps its own text; content is the bot-posted
    // panel's copy only.
    ...(!isReaction && content.trim() !== '' ? { content: content.trim() } : {}),
    ...(maxRoles.trim() !== '' ? { maxRoles: Number(maxRoles) } : {}),
    ...(requiredRoleId !== '' ? { requiredRoleId } : {}),
    blockedRoleIds: [...blockedRoleIds],
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
      found.push('Name: lowercase letters, numbers, dashes and underscores, at most 64.');
    }
    if (!SNOWFLAKE.test(channelId.trim())) {
      found.push('Channel: pick a channel or paste its snowflake ID.');
    }
    if (isReaction && !SNOWFLAKE.test(messageId.trim())) {
      found.push(
        'Message ID: the numeric id of the existing message members react to - in Discord, right-click the message and Copy Message ID.',
      );
    }
    if (isReaction && messageCheck === 'failed') {
      found.push(
        'That message was not found in the picked channel - check the message id and run the check again.',
      );
    }
    if (content.length > MAX_CONTENT) {
      found.push(`Message text: at most ${String(MAX_CONTENT)} characters (Discord's limit).`);
    }
    const usable = options.filter(
      (o) =>
        o.optionId.trim() !== '' ||
        o.roleId !== '' ||
        o.label.trim() !== '' ||
        o.emoji.trim() !== '',
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
    // Discord requires a label on buttons and dropdown options; reactions
    // need an emoji instead. The shared schema refuses either way, so say it
    // here first.
    if (!isReaction && usable.some((o) => o.label.trim() === '')) {
      found.push('Every option needs a label — Discord requires one on buttons and dropdowns.');
    }
    if (isReaction && usable.some((o) => o.emoji.trim() === '')) {
      found.push('Every option needs an emoji — members react with it to get the role.');
    }
    const roleIds = usable.map((o) => o.roleId).filter((r) => r !== '');
    if (new Set(roleIds).size !== roleIds.length) {
      found.push('Each role can appear once — two options cannot grant the same role.');
    }
    for (const o of usable) {
      if (o.emoji.trim() === '') continue;
      const key = emojiToKey(o.emoji);
      if (
        key === undefined ||
        key.startsWith('invalid:') ||
        !emojiKeySchema.safeParse(key).success
      ) {
        found.push(
          `"${o.emoji.trim()}" is not a usable emoji — paste one emoji or a custom emoji ID.`,
        );
        break;
      }
    }
    const notOptionable = usable.filter((o) => {
      const role = roleById.get(o.roleId);
      return role !== undefined && !role.optionable;
    });
    if (notOptionable.length > 0) {
      found.push(
        `Not available to grant: ${notOptionable
          .map((o) => roleById.get(o.roleId)?.name ?? o.roleId)
          .join(', ')} — an option must be a role Bananasaurs manages.`,
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
            `The name "${panelId.trim()}" is already taken — names are immutable. ` +
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
      <Card title="Saved — nothing is live yet">
        <p className="text-sm">
          <strong>{created.panelId}</strong> is configured. Publishing posts its message in Discord
          and starts granting roles — a separate, confirmed action on its page.
        </p>
        <div className="mt-3 flex gap-2">
          <Button variant="primary" onClick={() => onCreated(created.panelId)}>
            Open it
          </Button>
          <Button
            onClick={() => {
              setCreated(undefined);
              setStep('edit');
              setChoice(undefined);
              setPanelId('');
              setMessageId('');
              setMessageCheck('idle');
              setContent('');
              setRequiredRoleId('');
              setBlockedRoleIds([]);
              setOptions([emptyOption()]);
            }}
          >
            Build another
          </Button>
        </div>
      </Card>
    );
  }

  if (step === 'edit' && choice === undefined) {
    // The type comes first, then the type-specific form (Bryan's lane): no
    // mixed form where a message-text field quietly does nothing for one
    // kind and an emoji field is required for another.
    return (
      <Card title="New self-granted role setup">
        <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setChoice('reaction')}
            className="grid gap-1 rounded border border-line p-4 text-left hover:border-accent"
          >
            <span className="text-sm font-medium">Reaction role</span>
            <span className="text-sm text-ink-muted">
              Members add an emoji reaction on a message that already exists. You attach it by
              channel and message ID; each option is an emoji.
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setChoice('panel');
              // The panel format select no longer offers reactions; land on
              // a real option.
              setFormat('button');
            }}
            className="grid gap-1 rounded border border-line p-4 text-left hover:border-accent"
          >
            <span className="text-sm font-medium">Role panel</span>
            <span className="text-sm text-ink-muted">
              The bot posts a new message with buttons or a dropdown. Best when the message should
              say something specific.
            </span>
          </button>
        </div>
        <div className="mt-3">
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title={
        step === 'edit'
          ? isReaction
            ? 'New reaction role'
            : 'New role panel'
          : 'Review before creating'
      }
    >
      {step === 'edit' ? (
        <form onSubmit={review} className="grid max-w-2xl gap-4">
          <Field
            label="Name"
            hint="Lowercase letters, numbers, dashes. Only you see it, and it cannot change later."
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
            hint={
              isReaction
                ? 'The channel the existing message lives in.'
                : 'Where the message will be posted when you publish.'
            }
            value={channelId}
            onChange={(id) => {
              setChannelId(id);
              setMessageCheck('idle');
            }}
          />
          {isReaction && (
            <Field
              label="Message ID"
              hint="The existing message members react to. In Discord: right-click the message, Copy Message ID."
            >
              <div>
                <div className="flex items-center gap-2">
                  <Input
                    value={messageId}
                    onChange={(e) => {
                      setMessageId(e.target.value);
                      setMessageCheck('idle');
                    }}
                    inputMode="numeric"
                    placeholder="1234567890123456789"
                    autoComplete="off"
                  />
                  <Button
                    onClick={() => void checkMessage()}
                    disabled={
                      !SNOWFLAKE.test(messageId.trim()) || !SNOWFLAKE.test(channelId.trim())
                    }
                    busy={messageCheck === 'checking'}
                  >
                    Check
                  </Button>
                </div>
                {messageCheck === 'ok' && (
                  <p className="mt-1 text-sm text-ok">Found - the bot can see that message.</p>
                )}
                {messageCheck === 'failed' && (
                  <p role="alert" className="mt-1 text-sm text-danger">
                    Not found in the picked channel - check the message ID.
                  </p>
                )}
              </div>
            </Field>
          )}
          {!isReaction && (
            <>
              <Field
                label="Message text"
                hint="What the message says above the buttons or dropdown. Leave empty for a short default."
              >
                <textarea
                  aria-label="Message text"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={3}
                  maxLength={MAX_CONTENT}
                  placeholder="Pick your colour below!"
                  className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
                />
              </Field>
              <Field label="How members pick">
                <div className="flex items-center gap-1">
                  <select
                    aria-label="How members pick"
                    value={format}
                    onChange={(e) => setFormat(e.target.value as PanelComponent)}
                    className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
                  >
                    {formats.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <HelpTip label="how members pick">{formatHelp}</HelpTip>
                </div>
              </Field>
            </>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Behaviour">
              <div className="flex items-center gap-1">
                <select
                  aria-label="Behaviour"
                  value={behaviour}
                  onChange={(e) => setBehaviour(e.target.value as PanelBehaviour)}
                  className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
                >
                  {behaviours.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </select>
                <HelpTip label="behaviour">{behaviourHelp}</HelpTip>
              </div>
            </Field>
          </div>
          <Field label="Max roles per member" hint="Optional. Leave empty for no limit.">
            <Input
              value={maxRoles}
              onChange={(e) => setMaxRoles(e.target.value)}
              inputMode="numeric"
              placeholder="No limit"
              autoComplete="off"
            />
          </Field>

          <fieldset className="grid gap-3">
            <legend className="text-sm font-medium text-ink">
              Who can use it{' '}
              <HelpTip label="who can use it">
                Optional limits on who may pick up roles here. A required role means only members
                already holding it can use this; blocked roles can never use it, whatever else they
                hold. Neither limit ever grants or removes those roles.
              </HelpTip>
            </legend>
            <Field
              label="Require a role first"
              hint="Optional. Only members already holding this role can pick up roles here."
            >
              <select
                aria-label="Require a role first"
                value={requiredRoleId}
                onChange={(e) => setRequiredRoleId(e.target.value)}
                className="block w-full rounded-sm border border-line bg-canvas px-2 py-1 text-ink"
              >
                <option value="">No requirement — everyone</option>
                {(roleList ?? []).map((role) => (
                  <option key={role.roleId} value={role.roleId}>
                    {role.name}
                  </option>
                ))}
              </select>
            </Field>
            {roleList !== undefined && roleList.length > 0 && (
              <Field
                label="Block roles"
                hint="Optional. Members holding any of these cannot use it."
              >
                <div
                  role="group"
                  aria-label="Blocked roles"
                  className="grid max-h-40 gap-1 overflow-y-auto rounded-sm border border-line p-2"
                >
                  {roleList.map((role) => (
                    <label key={role.roleId} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={blockedRoleIds.includes(role.roleId)}
                        onChange={() => toggleBlocked(role.roleId)}
                      />
                      {role.name}
                    </label>
                  ))}
                </div>
              </Field>
            )}
          </fieldset>

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
                      {role.optionable
                        ? ''
                        : role.managed
                          ? ' (Discord-managed)'
                          : " (above the bot's role)"}
                    </option>
                  ))}
                </select>
                <Input
                  aria-label={`Option ${String(index + 1)} label`}
                  value={option.label}
                  onChange={(e) => updateOption(index, { label: e.target.value })}
                  placeholder={isReaction ? 'label (optional)' : 'label'}
                  autoComplete="off"
                />
                <Input
                  aria-label={`Option ${String(index + 1)} emoji`}
                  value={option.emoji}
                  onChange={(e) => updateOption(index, { emoji: e.target.value })}
                  placeholder={isReaction ? 'emoji (required)' : 'emoji'}
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
            <dt className="text-ink-muted">Name</dt>
            <dd>{panelId.trim()}</dd>
            <dt className="text-ink-muted">Channel</dt>
            <dd>#{channelName(channelId.trim())}</dd>
            {isReaction ? (
              <>
                <dt className="text-ink-muted">Attaches to</dt>
                <dd>the existing message {messageId.trim()} — verified the bot can see it</dd>
                <dt className="text-ink-muted">How members pick</dt>
                <dd>Emoji reactions on that message</dd>
              </>
            ) : (
              <>
                <dt className="text-ink-muted">Message text</dt>
                <dd className="whitespace-pre-wrap">
                  {content.trim() === '' ? 'Pick your roles. (the default)' : content.trim()}
                </dd>
                <dt className="text-ink-muted">How members pick</dt>
                <dd>{FORMATS.find((f) => f.value === format)?.label}</dd>
              </>
            )}
            <dt className="text-ink-muted">Behaviour</dt>
            <dd>{BEHAVIOURS.find((b) => b.value === behaviour)?.label}</dd>
            <dt className="text-ink-muted">Max roles per member</dt>
            <dd>{maxRoles.trim() === '' ? 'no limit' : maxRoles.trim()}</dd>
            <dt className="text-ink-muted">Who can use it</dt>
            <dd>
              {requiredRoleId === ''
                ? 'everyone'
                : `only members with the ${roleName(requiredRoleId)} role`}
              {blockedRoleIds.length > 0 && `; blocked: ${blockedRoleIds.map(roleName).join(', ')}`}
            </dd>
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
                cell: (o) => roleName(o.roleId),
              },
              {
                key: 'face',
                header: 'Shown as',
                // Review shows what members will see: the emoji itself for
                // unicode keys, the key for custom ones (their image needs a
                // live guild), the label otherwise.
                cell: (o) =>
                  o.emojiKey !== undefined
                    ? isCustomEmojiKey(o.emojiKey)
                      ? o.emojiKey
                      : unicodeEmojiChars(o.emojiKey)
                    : (o.label ?? '—'),
              },
            ]}
          />
          <p className="text-sm text-ink-muted">
            Creating saves the configuration only.{' '}
            <HelpTip label="when this goes live">
              Nothing reaches Discord yet. Publishing — a separate, confirmed action on the saved
              page —{' '}
              {isReaction
                ? 'starts granting and removing roles as members react to that message.'
                : 'posts the message and starts granting and removing roles as members use it.'}
            </HelpTip>
          </p>
          {submitError !== undefined && (
            <p role="alert" className="text-sm text-danger">
              {submitError}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="primary" busy={busy} onClick={() => void submit()}>
              Create
            </Button>
            <Button onClick={() => setStep('edit')}>Back</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
