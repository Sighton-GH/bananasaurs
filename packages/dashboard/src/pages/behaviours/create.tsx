import { useId, useState } from 'react';
import { Link } from 'wouter';
import { behaviourUrl, type AssistantData } from '../../api/assistant.js';
import { fieldError } from '../../api/describe-error.js';
import { type Session } from '../../app/session.js';
import { Button } from '../../ui/Button.js';
import { ErrorNotice } from '../../ui/ErrorNotice.js';
import { Checkbox, Field, Input } from '../../ui/Field.js';
import { FormSection } from '../../ui/FormSection.js';
import { HelpTip } from '../../ui/HelpTip.js';
import { Select } from '../../ui/Select.js';
import { Textarea } from '../../ui/Textarea.js';
import { useToast } from '../../ui/Toast.js';
import { RoleChecklist, skillEffectLabel, toggleIn } from '../assistant-shared.js';

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
export function CreateBehaviourForm({
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
  const titleId = useId();
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
          preferredSkillIds: skillIds,
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
    // The dialog already supplies panel chrome. Keep the original nested card
    // spacing on desktop, but spend the narrow column on fields, not padding.
    <section
      aria-labelledby={titleId}
      className="min-w-0 sm:rounded-panel sm:border sm:border-line sm:bg-panel sm:p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id={titleId} className="text-section font-semibold">
            Create a behaviour
          </h2>
        </div>
      </div>
      <p className="mb-3 text-sm text-ink-muted">
        A behaviour is one way members can use the assistant - its own tag, instructions and rules
        about who may use it. New behaviours start turned off.
      </p>
      <form
        className="min-w-0 max-w-full [overflow-wrap:anywhere] [&_.grid>div]:min-w-0"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void submit();
        }}
      >
        <div className="flex min-w-0 flex-col gap-6">
          <FormSection
            title="Basics"
            description="What it is called, which tag it answers, and who mentions it."
          >
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
              <Select
                value={surface}
                onValueChange={(value) => setSurface(value as TagSurface)}
                options={TAG_SURFACES.map((option) => ({
                  value: option.value,
                  label: `${option.label} - ${option.blurb}`,
                }))}
              />
            </Field>
            <div>
              <Field
                label="Mention role"
                {...(mentionRoleProblem === undefined ? {} : { error: mentionRoleProblem })}
              >
                <Select
                  value={mentionRoleId === '' ? undefined : mentionRoleId}
                  placeholder="Choose a role…"
                  onValueChange={(value) => setMentionRoleId(value === '__none' ? '' : value)}
                  options={[
                    { value: '__none', label: 'Choose a role…' },
                    ...[...(data.roles ?? [])]
                      .sort((a, b) => b.position - a.position)
                      .map((role) => ({ value: role.id, label: `@${role.name}` })),
                  ]}
                />
              </Field>
              <p className="mt-1 text-xs text-ink-muted">
                Members reach this behaviour by mentioning this role in Discord, for example @IT
                Services. Each role can belong to only one behaviour that is turned on.{' '}
                <HelpTip label="mention role">
                  Discord roles can be mentioned like @Club Assistant. The bot watches for that
                  mention and routes it to this behaviour. Only roles Discord reports for this
                  server are offered.
                </HelpTip>
              </p>
              {!rolesReady && (
                <p className="mt-1 text-xs text-ink-muted">
                  The role directory did not load, so no mention role can be chosen and the
                  behaviour cannot be created yet. Nothing is changed.
                </p>
              )}
            </div>
          </FormSection>
          <FormSection
            title="Instructions"
            description="What the behaviour follows when it answers."
          >
            <Field
              label="Instructions for the new behaviour"
              hint="Members do not see these operator instructions. 1 to 4,000 characters."
              htmlFor="new-behaviour-prompt"
              {...(promptProblem === undefined ? {} : { error: promptProblem })}
            >
              <Textarea
                id="new-behaviour-prompt"
                showCount
                value={prompt}
                maxLength={4_000}
                onChange={(e) => setPrompt(e.target.value)}
                required
              />
            </Field>
          </FormSection>
          <FormSection title="Skills it may use">
            <section aria-label="Skills the new behaviour may use">
              <p className="mt-1 text-xs text-ink-muted">
                You can change this later on the{' '}
                <Link className="underline" href="/assistant/skills">
                  Skills page
                </Link>
                . With nothing selected the behaviour can answer from its instructions but cannot do
                anything.
              </p>
              <ul className="mt-2 grid min-w-0 gap-1 sm:grid-cols-2">
                {data.skills
                  .filter((skill) => skill.ownerOnly !== true)
                  .map((skill) => (
                    <li key={skill.id} className="min-w-0">
                      <Checkbox
                        label={skill.name}
                        checked={skillIds.includes(skill.id)}
                        onChange={() => setSkillIds((ids) => toggleIn(ids, skill.id))}
                      />
                      <span className="block text-xs text-ink-muted">
                        {skillEffectLabel(skill)}
                      </span>
                    </li>
                  ))}
              </ul>
            </section>
          </FormSection>
          <FormSection title="Who may use it">
            <section
              aria-label="Who may use the new behaviour"
              className="min-w-0 [&_ul]:min-w-0 [&_li]:min-w-0 [&_label]:min-w-0 [&_input]:shrink-0 [&_span]:whitespace-normal [&_span]:overflow-visible [&_span]:[overflow-wrap:anywhere]"
            >
              <RoleChecklist
                label="Who may use the new behaviour"
                roles={data.roles}
                selected={callerRoleIds}
                onToggle={(id) => setCallerRoleIds((ids) => toggleIn(ids, id))}
              />
              <p className="mt-2 text-xs text-ink-muted">
                If no role is ticked, nobody can use it.
              </p>
            </section>
          </FormSection>
          {error !== undefined && (
            <div className="mt-3">
              <ErrorNotice error={error} />
            </div>
          )}
          <div className="flex min-w-0 flex-col flex-wrap gap-2 sm:flex-row">
            <Button variant="primary" busy={busy} disabled={!canSubmit} type="submit">
              Create behaviour
            </Button>
            <Button onClick={onCancel}>Cancel</Button>
          </div>
        </div>
      </form>
    </section>
  );
}
