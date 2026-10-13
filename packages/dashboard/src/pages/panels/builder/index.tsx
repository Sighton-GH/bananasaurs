import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  customEmojiKey,
  emojiKeySchema,
  panelDefinitionSchema,
  unicodeEmojiKey,
  type PanelBehaviour,
  type PanelComponent,
} from '@bananasaurs/core';
import { Select } from '../../../ui/Select.js';
import { ApiError } from '../../../api.js';
import type { GuildChannelInfo, GuildEmojiInfo, GuildRoleInfo } from '../../../api/ops.js';
import { useSession } from '../../../app/session.js';
import { useResource } from '../../../hooks/useResource.js';
import { Button } from '../../../ui/Button.js';
import { Card } from '../../../ui/Card.js';
import { ChannelPicker } from '../../../ui/ChannelPicker.js';
import { DataTable } from '../../../ui/DataTable.js';
import { EmojiGlyph } from '../../../ui/EmojiGlyph.js';
import { ErrorNotice } from '../../../ui/ErrorNotice.js';
import { Field, Input, Checkbox } from '../../../ui/Field.js';
import { HelpTip } from '../../../ui/HelpTip.js';
import { BuilderPreview } from './preview.js';
import { BuilderOptions } from './options.js';
import { BuilderBehaviour } from './behaviour.js';
import { FormSection } from '../../../ui/FormSection.js';
import { PageHeader } from '../../../ui/PageHeader.js';
import { Textarea } from '../../../ui/Textarea.js';
import { SaveBar } from '../../../ui/SaveBar.js';
import { InlineAlert } from '../../../ui/InlineAlert.js';
import { ErrorSummary } from '../../../ui/ErrorSummary.js';
import { useUnsavedGuard } from '../../../hooks/useUnsavedGuard.js';
import { useFieldErrors } from '../../../hooks/useFieldErrors.js';
import { ConfirmDialog } from '../../../ui/ConfirmDialog.js';

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
const problemField = (message: string): string => {
  if (message.startsWith('Name:')) return 'field-panelId';
  if (message.startsWith('Channel:')) return 'field-channelId';
  if (message.startsWith('Message ID:') || message.startsWith('That message'))
    return 'field-messageId';
  if (message.startsWith('Message text:')) return 'field-content';
  if (message.startsWith('Max roles')) return 'field-maxRoles';
  return 'field-options';
};
/** One entry per real focus destination; retain every instruction at that destination. */
const groupSummary = (errors: readonly { fieldId: string; message: string }[]) => {
  const grouped = new Map<string, string[]>();
  for (const { fieldId, message } of errors) {
    const messages = grouped.get(fieldId) ?? [];
    messages.push(message);
    grouped.set(fieldId, messages);
  }
  return [...grouped].map(([fieldId, messages]) => ({ fieldId, message: messages.join(' ') }));
};

const MAX_CONTENT = 2000;

export interface DraftOption {
  /** Numbered by the form (`option-1`, `option-2`, ...); the operator never types it. */
  readonly optionId: string;
  readonly roleId: string;
  /** Buttons and dropdown options only; a reaction has no label. */
  readonly label: string;
  /** The picker's value: unicode emoji characters, or a custom emoji snowflake. */
  readonly emoji: string;
}

const emptyOption = (number: number): DraftOption => ({
  optionId: `option-${String(number)}`,
  roleId: '',
  label: '',
  emoji: '',
});

/**
 * What the Name box keeps while typing: spaces become dashes, capitals become
 * lowercase, and anything the name rules refuse is dropped. A pasted
 * "Colour Roles!" lands as "colour-roles".
 */
export const toPanelName = (typed: string): string =>
  typed
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 64);

import { BEHAVIOURS, FORMATS } from './behaviour.js';

const IDENTIFIER = /^[a-z0-9_-]{1,64}$/;
const SNOWFLAKE = /^\d{17,20}$/;

/** The emoji input, spelled as an EmojiKey: all digits is a custom id, anything else is unicode. */
const emojiToKey = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (/^\d{17,20}$/.test(trimmed)) return customEmojiKey(trimmed);
  // Honesty check: a unicode emoji needs at least one codepoint beyond
  // printable ASCII - a pictograph, or the keycap/variation-selector marks
  // that turn 1, # or * into a keycap emoji. Without it, "banana" would
  // convert to a structurally valid key for six Latin letters - the schema
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
  readonly newlyAllowlistedRoleIds: readonly string[];
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
  // The guild's custom emoji for the picker and the preview. A failed load
  // only means the picker offers Unicode emoji alone.
  const loadEmojis = useCallback(
    () => session.read<{ emojis: readonly GuildEmojiInfo[] }>('/api/guild/emojis'),
    [session],
  );
  const emojis = useResource('the custom emoji list', loadEmojis);
  const customEmojis = emojis.resource.state === 'ready' ? emojis.resource.data.emojis : [];

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
  // The checked message's author and text, for the preview.
  const messageCheckGeneration = useRef(0);
  const [messagePreview, setMessagePreview] = useState<
    { readonly authorName: string; readonly content: string } | undefined
  >(undefined);
  const [content, setContent] = useState('');
  const [behaviour, setBehaviour] = useState<PanelBehaviour>('toggle');
  const [format, setFormat] = useState<PanelComponent>('reaction');
  const [maxRoles, setMaxRoles] = useState('');
  const [requiredRoleId, setRequiredRoleId] = useState('');
  const [blockedRoleIds, setBlockedRoleIds] = useState<readonly string[]>([]);
  const [options, setOptions] = useState<readonly DraftOption[]>([emptyOption(1)]);
  // Next option number; only ever counts up, so removing an option never
  // hands its id to a new one.
  const nextOptionNumber = useRef(2);
  const addOption = () => {
    // Build the option before queueing the update: React runs the updater
    // later, after the counter has already moved on.
    const added = emptyOption(nextOptionNumber.current);
    nextOptionNumber.current += 1;
    setOptions((current) => [...current, added]);
  };
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [submitText, setSubmitText] = useState<string | undefined>(undefined);
  const [submitError, setSubmitError] = useState<unknown>(undefined);
  const [created, setCreated] = useState<CreatedState | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const fieldErrors = useFieldErrors();
  // Keyboard focus follows the step: each view change lands on the new
  // step's heading. First mount never moves focus; a freshly mounted error
  // summary keeps its own focus (it announces every problem).
  const stepKey = created !== undefined ? 'saved' : choice === undefined ? 'type' : step;
  const viewRef = useRef<HTMLDivElement>(null);
  const prevStepKey = useRef(stepKey);
  useEffect(() => {
    if (prevStepKey.current === stepKey) return;
    prevStepKey.current = stepKey;
    const view = viewRef.current;
    if (view === null) return;
    if (view.querySelector('[role="alert"] a[href^="#"]') !== null) return;
    const heading = view.querySelector<HTMLElement>('h1, h2');
    if (heading === null) return;
    heading.setAttribute('tabindex', '-1');
    heading.focus();
  }, [stepKey]);
  const dirtyCount = [
    panelId !== '',
    channelId !== '',
    messageId !== '',
    content !== '',
    behaviour !== 'toggle',
    format !== (choice === 'panel' ? 'button' : 'reaction'),
    maxRoles !== '',
    requiredRoleId !== '',
    blockedRoleIds.length > 0,
    options.length !== 1 ||
      options.some((o) => o.roleId !== '' || o.label !== '' || o.emoji !== ''),
  ].filter(Boolean).length;
  const dirty = choice !== undefined && created === undefined && dirtyCount > 0;
  const guard = useUnsavedGuard(dirty);
  const cancel = () => {
    if (dirty) setCancelPending(true);
    else onCancel();
  };
  const discard = () => {
    messageCheckGeneration.current += 1;
    setPanelId('');
    setChannelId('');
    setMessageId('');
    setMessageCheck('idle');
    setMessagePreview(undefined);
    setContent('');
    setBehaviour('toggle');
    setFormat(choice === 'panel' ? 'button' : 'reaction');
    setMaxRoles('');
    setRequiredRoleId('');
    setBlockedRoleIds([]);
    setOptions([emptyOption(nextOptionNumber.current)]);
    nextOptionNumber.current += 1;
    setStep('edit');
    setProblems([]);
    setSubmitText(undefined);
    setSubmitError(undefined);
    fieldErrors.clear();
  };

  // The selects are controlled and always match an entry; the '' fallback is
  // unreachable but keeps the types honest under noUncheckedIndexedAccess.
  const isReaction = choice === 'reaction';
  // single_choice cannot work on somebody else's message: clearing a stale
  // reaction needs Manage Messages, which the bot deliberately does not hold.
  /** The live target check for a reaction role's existing message. */
  const checkMessage = async (): Promise<void> => {
    const generation = ++messageCheckGeneration.current;
    setMessageCheck('checking');
    setMessagePreview(undefined);
    try {
      const result = await session.read<{
        lookup: string;
        message?: { authorName: string; content: string };
      }>(`/api/guild/channels/${channelId.trim()}/messages/${messageId.trim()}`);
      if (generation !== messageCheckGeneration.current) return;
      setMessageCheck(result?.lookup === 'ok' ? 'ok' : 'failed');
      if (result?.lookup === 'ok') setMessagePreview(result.message);
    } catch {
      if (generation !== messageCheckGeneration.current) return;
      setMessageCheck('failed');
    }
  };

  const clientError = (id: string): string | undefined =>
    problems.find((p) => problemField(p) === id);
  const errorProps = (path: string) => {
    const error = fieldErrors.errorFor(path) ?? clientError(`field-${path}`);
    return error === undefined ? {} : { error };
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

  /** Rows the operator actually started; an untouched blank row is ignored, not an error. */
  const usableOptions = options.filter(
    (o) => o.roleId !== '' || o.emoji !== '' || (!isReaction && o.label.trim() !== ''),
  );

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
    options: usableOptions.map((o, index) => ({
      optionId: o.optionId,
      roleId: o.roleId,
      ...(!isReaction && o.label.trim() !== '' ? { label: o.label.trim() } : {}),
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
      found.push('Channel: search for and choose a channel.');
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
    const usable = usableOptions;
    if (usable.length === 0) found.push('Add at least one option.');
    if (usable.length > MAX_OPTIONS) found.push(`At most ${String(MAX_OPTIONS)} options.`);
    if (usable.some((o) => !SNOWFLAKE.test(o.roleId))) {
      found.push('Every option needs a role.');
    }
    // Discord requires a label on buttons and dropdown options; reactions
    // need an emoji instead. The shared schema refuses either way, so say it
    // here first.
    if (!isReaction && usable.some((o) => o.label.trim() === '')) {
      found.push('Every option needs a label - Discord requires one on buttons and dropdowns.');
    }
    if (isReaction && usable.some((o) => o.emoji.trim() === '')) {
      found.push('Every option needs an emoji - members react with it to get the role.');
    }
    const roleIds = usable.map((o) => o.roleId).filter((r) => r !== '');
    if (new Set(roleIds).size !== roleIds.length) {
      found.push('Each role can appear once - two options cannot grant the same role.');
    }
    for (const o of usable) {
      if (o.emoji.trim() === '') continue;
      const key = emojiToKey(o.emoji);
      if (
        key === undefined ||
        key.startsWith('invalid:') ||
        !emojiKeySchema.safeParse(key).success
      ) {
        found.push(`"${o.emoji.trim()}" is not a usable emoji - pick one from the emoji list.`);
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
          .join(', ')} - an option must be a role Bananasaurs manages.`,
      );
    }
    if (maxRoles.trim() !== '' && (!/^\d+$/.test(maxRoles.trim()) || Number(maxRoles) < 1)) {
      found.push('Max roles per member: a whole number of 1 or more, or leave it empty.');
    }
    return found;
  };

  const reviewDraft = () => {
    fieldErrors.clear();
    const found = [...validate()];
    // The same schema the server runs - disagreements between this list and
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
    setSubmitText(undefined);
    setSubmitError(undefined);
    try {
      const result = await session.writeOrThrow<{
        ok: boolean;
        panelId: string;
        newlyAllowlistedRoleIds?: readonly string[];
      }>('/api/panels', assemble());
      if (result !== undefined) {
        setCreated({
          panelId: result.panelId,
          newlyAllowlistedRoleIds: result.newlyAllowlistedRoleIds ?? [],
        });
      }
    } catch (err) {
      // writeOrThrow lets the server's 400/409 answers through; everything
      // else already became a toast. The three branches stay: each names
      // what the operator must change (the roles, the problems, the taken
      // name) - more than the catalog text. Anything else renders as the
      // server's answer below.
      if (fieldErrors.capture(err)) {
        setStep('edit');
        return;
      }
      if (err instanceof ApiError && (err.status === 400 || err.status === 409)) {
        const body = err.body as { error?: string; problems?: string; roleIds?: string[] };
        if (body.error === 'unmanageable-role') {
          setSubmitText(
            `Bananasaurs cannot manage these roles in Discord: ${(body.roleIds ?? []).map(roleName).join(', ')}. ` +
              "Move them below the bot's highest role or pick different roles.",
          );
        } else if (body.error === 'invalid-definition') {
          setSubmitText(body.problems ?? 'The definition failed validation.');
        } else if (body.error === 'already-exists') {
          setSubmitText(
            `The name "${panelId.trim()}" is already taken - names are immutable. ` +
              'Go back and pick a new one.',
          );
        } else {
          setSubmitError(err);
        }
      } else {
        setSubmitError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  if (created !== undefined) {
    return (
      <div ref={viewRef}>
        <Card title="Saved">
          <InlineAlert tone="hold" title="Saved - nothing is live yet">
            <p className="text-sm">
              <strong>{created.panelId}</strong> is configured. Publishing posts its message in
              Discord and starts granting roles - a separate, confirmed action on its page.
            </p>
            {created.newlyAllowlistedRoleIds.length > 0 && (
              <p className="mt-2 text-sm text-ink-muted">
                Added to Bananasaurs&apos; managed-role scope:{' '}
                {created.newlyAllowlistedRoleIds
                  .map((roleId) => `${roleName(roleId)} (${roleId})`)
                  .join(', ')}
                .
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <Button variant="primary" onClick={() => onCreated(created.panelId)}>
                Publish
              </Button>
              <Button
                onClick={() => {
                  discard();
                  setCreated(undefined);
                  setChoice(undefined);
                }}
              >
                Build another
              </Button>
            </div>
          </InlineAlert>
        </Card>
      </div>
    );
  }

  if (step === 'edit' && choice === undefined) {
    // The type comes first, then the type-specific form (Bryan's lane): no
    // mixed form where a message-text field quietly does nothing for one
    // kind and an emoji field is required for another.
    return (
      <div ref={viewRef}>
        <Card title="New self-granted role setup">
          <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
            <Button
              onClick={() => setChoice('reaction')}
              className="grid h-auto gap-1 p-4 text-left"
            >
              <span className="text-sm font-medium">Reaction role</span>
              <span className="text-sm text-ink-muted">
                Members add an emoji reaction on a message that already exists. You attach it by
                channel and message ID; each option is an emoji.
              </span>
            </Button>
            <Button
              onClick={() => {
                setChoice('panel');
                // The panel format select no longer offers reactions; land on
                // a real option.
                setFormat('button');
              }}
              className="grid h-auto gap-1 p-4 text-left"
            >
              <span className="text-sm font-medium">Role panel</span>
              <span className="text-sm text-ink-muted">
                The bot posts a new message with buttons or a dropdown. Best when the message should
                say something specific.
              </span>
            </Button>
          </div>
          <div className="mt-3">
            <Button onClick={cancel}>Cancel</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div ref={viewRef}>
      {guard}
      <ConfirmDialog
        open={cancelPending}
        title="Leave without saving?"
        scope="Your draft will be lost."
        cancelLabel="Stay"
        confirmLabel="Leave"
        onCancel={() => setCancelPending(false)}
        onConfirm={onCancel}
      />
      <PageHeader
        title={
          step === 'edit'
            ? isReaction
              ? 'New reaction role'
              : 'New role panel'
            : 'Review before creating'
        }
        purpose="Build a role setup, review it, then save it before publishing separately."
        crumbs={[{ label: 'Role panels', href: '/panels' }]}
      />
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
          <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,42rem)_minmax(0,1fr)]">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                reviewDraft();
              }}
              className="grid min-w-0 gap-4"
            >
              <ErrorSummary
                errors={groupSummary([
                  ...problems.map((message) => ({ fieldId: problemField(message), message })),
                  ...fieldErrors.summary,
                ])}
              />
              <FormSection title="Where">
                <Field
                  label="Name"
                  htmlFor="field-panelId"
                  {...errorProps('panelId')}
                  hint="Only you see it, and it cannot change later. Spaces become dashes."
                >
                  <Input
                    value={panelId}
                    onChange={(e) => setPanelId(toPanelName(e.target.value))}
                    placeholder="colour-roles"
                    autoComplete="off"
                  />
                </Field>
                <div id="field-channelId" tabIndex={-1}>
                  <ChannelPicker
                    {...errorProps('channelId')}
                    label="Channel"
                    hint={
                      isReaction
                        ? 'The channel the existing message lives in.'
                        : 'Where the message will be posted when you publish.'
                    }
                    value={channelId}
                    onChange={(id) => {
                      messageCheckGeneration.current += 1;
                      setChannelId(id);
                      setMessageCheck('idle');
                    }}
                  />
                </div>
                {isReaction && (
                  <div className="grid min-w-0 gap-2">
                    <Field
                      label="Message ID"
                      htmlFor="field-messageId"
                      {...errorProps('messageId')}
                      hint="The existing message members react to. In Discord: right-click the message, Copy Message ID."
                    >
                      <Input
                        value={messageId}
                        onChange={(e) => {
                          messageCheckGeneration.current += 1;
                          setMessageId(e.target.value);
                          setMessageCheck('idle');
                        }}
                        inputMode="numeric"
                        placeholder="1234567890123456789"
                        autoComplete="off"
                      />
                    </Field>
                    <Button
                      onClick={() => void checkMessage()}
                      disabled={
                        !SNOWFLAKE.test(messageId.trim()) || !SNOWFLAKE.test(channelId.trim())
                      }
                      busy={messageCheck === 'checking'}
                    >
                      Check
                    </Button>
                    {messageCheck === 'ok' && (
                      <p className="text-small text-tone-ok-ink">
                        Found - the bot can see that message.
                      </p>
                    )}
                    {messageCheck === 'failed' && (
                      <p role="alert" className="text-small text-tone-danger-ink">
                        Not found in the picked channel - check the message ID.
                      </p>
                    )}
                  </div>
                )}
                {!isReaction && (
                  <>
                    <Field
                      label="Message text"
                      htmlFor="field-content"
                      {...errorProps('content')}
                      optional
                      hint="What the message says above the buttons or dropdown. Leave empty for a short default."
                    >
                      <Textarea
                        showCount
                        aria-label="Message text"
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        rows={3}
                        maxLength={MAX_CONTENT}
                        placeholder="Pick your colour below!"
                      />
                    </Field>
                  </>
                )}
              </FormSection>
              <BuilderOptions
                isReaction={isReaction}
                options={options}
                roleList={roleList}
                customEmojis={customEmojis}
                updateOption={updateOption}
                onRemove={(index) => setOptions((current) => current.filter((_, i) => i !== index))}
                onAdd={addOption}
                rolesResource={roles.resource}
                errorFor={fieldErrors.errorFor}
                optionsError={clientError('field-options')}
              />
              <BuilderBehaviour
                isReaction={isReaction}
                behaviour={behaviour}
                format={format}
                setBehaviour={setBehaviour}
                setFormat={setFormat}
              />
              <FormSection title="Limits">
                <Field
                  label="Max roles per member"
                  htmlFor="field-maxRoles"
                  {...errorProps('maxRoles')}
                  optional
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
                  <legend className="text-sm font-medium text-ink">
                    Who can use it{' '}
                    <HelpTip label="who can use it">
                      Optional limits on who may pick up roles here. A required role means only
                      members already holding it can use this; blocked roles can never use it,
                      whatever else they hold. Neither limit ever grants or removes those roles.
                    </HelpTip>
                  </legend>
                  <Field
                    label="Require a role first"
                    optional
                    hint="Optional. Only members already holding this role can pick up roles here."
                  >
                    <Select
                      aria-label="Require a role first"
                      value={requiredRoleId || '__none'}
                      onValueChange={(v) => setRequiredRoleId(v === '__none' ? '' : v)}
                      options={[
                        { value: '__none', label: 'No requirement - everyone' },
                        ...(roleList ?? []).map((role) => ({
                          value: role.roleId,
                          label: role.name,
                        })),
                      ]}
                    />
                  </Field>
                  {roleList !== undefined && roleList.length > 0 && (
                    <Field
                      label="Block roles"
                      optional
                      hint="Optional. Members holding any of these cannot use it."
                    >
                      <div
                        role="group"
                        aria-label="Blocked roles"
                        className="grid max-h-40 gap-1 overflow-y-auto rounded-sm border border-line p-2"
                      >
                        {roleList.map((role) => (
                          <Checkbox
                            key={role.roleId}
                            label={role.name}
                            checked={blockedRoleIds.includes(role.roleId)}
                            onChange={() => toggleBlocked(role.roleId)}
                          />
                        ))}
                      </div>
                    </Field>
                  )}
                </fieldset>
              </FormSection>
              <div className="flex flex-wrap gap-2">
                <Button type="submit">Review</Button>
                <Button onClick={cancel}>Cancel</Button>
              </div>
              <SaveBar
                dirtyCount={dirtyCount}
                onSave={reviewDraft}
                onDiscard={discard}
                busy={busy}
              />
            </form>
            <aside className="min-w-0 lg:sticky lg:top-4 lg:self-start">
              <BuilderPreview
                kind={isReaction ? 'reaction' : 'panel'}
                component={format === 'select' ? 'select' : 'button'}
                channelName={
                  SNOWFLAKE.test(channelId.trim()) ? channelName(channelId.trim()) : undefined
                }
                authorName={
                  isReaction
                    ? messageCheck === 'ok' && messagePreview !== undefined
                      ? messagePreview.authorName
                      : 'Message author'
                    : 'Bananasaurs'
                }
                content={
                  isReaction
                    ? messageCheck === 'ok' && messagePreview !== undefined
                      ? messagePreview.content
                      : ''
                    : content
                }
                contentPlaceholder={
                  isReaction
                    ? 'Enter the message ID and press Check to see the message here.'
                    : 'Pick your roles. (the default message)'
                }
                options={options.map((o) => ({
                  key: o.optionId,
                  emoji: o.emoji,
                  label: o.label,
                }))}
                customEmojis={customEmojis}
              />
            </aside>
          </div>
        ) : (
          <div className="grid max-w-2xl gap-4">
            <dl className="grid grid-cols-1 sm:grid-cols-[12rem_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-ink-muted">Name</dt>
              <dd>{panelId.trim()}</dd>
              <dt className="text-ink-muted">Channel</dt>
              <dd>#{channelName(channelId.trim())}</dd>
              {isReaction ? (
                <>
                  <dt className="text-ink-muted">Attaches to</dt>
                  <dd>the existing message {messageId.trim()} - verified the bot can see it</dd>
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
                {blockedRoleIds.length > 0 &&
                  `; blocked: ${blockedRoleIds.map(roleName).join(', ')}`}
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
                  // Review shows what members will see: the emoji itself
                  // (custom ones as their image), the label otherwise.
                  cell: (o) => {
                    const emoji = usableOptions.find((u) => u.optionId === o.optionId)?.emoji ?? '';
                    return emoji !== '' ? (
                      <EmojiGlyph value={emoji} customEmojis={customEmojis} />
                    ) : (
                      (o.label ?? '—')
                    );
                  },
                },
              ]}
            />
            {assemble().options.some(
              (option) => roleById.get(option.roleId)?.allowlisted === false,
            ) && (
              <p className="text-sm text-ink-muted">
                Creating will add these roles to Bananasaurs&apos; managed-role scope:{' '}
                {assemble()
                  .options.filter((option) => roleById.get(option.roleId)?.allowlisted === false)
                  .map((option) => `${roleName(option.roleId)} (${option.roleId})`)
                  .join(', ')}
                .
              </p>
            )}
            <p className="text-sm text-ink-muted">
              Creating saves the configuration only.{' '}
              <HelpTip label="when this goes live">
                Nothing reaches Discord yet. Publishing - a separate, confirmed action on the saved
                page —{' '}
                {isReaction
                  ? 'starts granting and removing roles as members react to that message.'
                  : 'posts the message and starts granting and removing roles as members use it.'}
              </HelpTip>
            </p>
            <ErrorSummary errors={groupSummary(fieldErrors.summary)} />
            {submitText !== undefined && (
              <p role="alert" className="text-sm text-tone-danger-ink">
                {submitText}
              </p>
            )}
            {submitError !== undefined && <ErrorNotice error={submitError} />}
            <div className="flex gap-2">
              <Button variant="primary" busy={busy} onClick={() => void submit()}>
                Create
              </Button>
              <Button onClick={() => setStep('edit')}>Back</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
