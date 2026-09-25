import { useCallback, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import {
  buildSystemPrompt,
  DEFAULT_WIZARD_ANSWERS,
  type PromptWizardAnswers,
} from '@bananasaurs/core';
import { ApiError } from '../api.js';
import {
  ASSISTANT_URL,
  behaviourUrl,
  SAFETY_SUFFIX_URL,
  type AssistantBehaviourView,
  type AssistantData,
  type SafetySuffix,
} from '../api/assistant.js';
import { useSession, type Session } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { EmptyState } from '../ui/EmptyState.js';
import { Field, Input } from '../ui/Field.js';
import { HelpTip } from '../ui/HelpTip.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';
import { behaviourBody, toggleIn } from './assistant-shared.js';

/**
 * `/assistant/behaviours/:id/wizard`: the beginner-friendly way to write a
 * behaviour's instructions. Seven short steps compile into the same prompt
 * the hand-written editor saves; the locked safety suffix is shown read-only
 * and is never part of the editable text.
 */

type Audience = PromptWizardAnswers['audience'][number];
type HelpsWith = PromptWizardAnswers['helpsWith'][number];

const AUDIENCE_OPTIONS: readonly { readonly value: Audience; readonly label: string }[] = [
  { value: 'members', label: 'Members' },
  { value: 'new-members', label: 'New members' },
  { value: 'it-help', label: 'People who need IT help' },
  { value: 'execs', label: 'Execs' },
];

const HELPS_WITH_OPTIONS: readonly { readonly value: HelpsWith; readonly label: string }[] = [
  { value: 'club-questions', label: 'Answering general questions about the club' },
  { value: 'find-resources', label: 'Helping people find a resource or document' },
  { value: 'projects-code', label: 'Helping with projects and code' },
  { value: 'onboarding', label: 'Helping new members get onboarded' },
  { value: 'events-meetings', label: 'Answering questions about events and meetings' },
  { value: 'it-access', label: 'Helping with IT access requests' },
];

const TONE_OPTIONS: readonly {
  readonly value: PromptWizardAnswers['tone'];
  readonly label: string;
}[] = [
  { value: 'friendly', label: 'Friendly and approachable' },
  { value: 'professional', label: 'Professional and businesslike' },
  { value: 'playful', label: 'Playful and light' },
];

const LENGTH_OPTIONS: readonly {
  readonly value: PromptWizardAnswers['length'];
  readonly label: string;
}[] = [
  { value: 'short', label: 'Short and to the point' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'detailed', label: 'Detailed and thorough' },
];

const EMOJI_OPTIONS: readonly {
  readonly value: PromptWizardAnswers['emoji'];
  readonly label: string;
}[] = [
  { value: 'none', label: 'No emoji' },
  { value: 'a-little', label: 'A little emoji' },
];

const OFF_TOPIC_OPTIONS: readonly {
  readonly value: PromptWizardAnswers['offTopic'];
  readonly label: string;
}[] = [
  { value: 'answer-briefly', label: 'Answer briefly' },
  { value: 'redirect', label: 'Redirect to a person or channel' },
];

const FORMAT_OPTIONS: readonly {
  readonly key: keyof PromptWizardAnswers['format'];
  readonly label: string;
}[] = [
  { key: 'bullets', label: 'Use bullet points for lists' },
  { key: 'codeBlocks', label: 'Use fenced code blocks for code' },
  { key: 'oneMessage', label: 'Keep the whole answer in one Discord message' },
  { key: 'sourcesLine', label: 'End with a Sources line' },
];

const STEPS: readonly { readonly heading: string; readonly purpose: string }[] = [
  {
    heading: 'Who it helps',
    purpose: 'Pick who this behaviour answers. You can pick more than one.',
  },
  {
    heading: 'What it helps with',
    purpose: 'Pick what members can ask about. Anything else gets a brief redirect.',
  },
  { heading: 'Voice', purpose: 'How the assistant sounds when it answers.' },
  { heading: 'Sources', purpose: 'Where answers come from, and what to say when unsure.' },
  {
    heading: 'Club facts',
    purpose: 'Facts the assistant should always know, like meeting times or dues.',
  },
  {
    heading: 'Boundaries',
    purpose: 'Topics to avoid, and things the assistant must never claim it did.',
  },
  { heading: 'Review', purpose: 'Check the instructions the wizard wrote, then save them.' },
];

const stepValid = (step: number, answers: PromptWizardAnswers): boolean => {
  switch (step) {
    case 0:
      return answers.audience.length >= 1;
    case 1:
      return answers.helpsWithOther.length <= 300;
    case 2: {
      const length = answers.language.trim().length;
      return length >= 2 && length <= 40;
    }
    case 3:
      return answers.whenUnsure.suggest.length <= 120;
    case 4:
      return answers.clubFacts.length <= 1200;
    case 5:
      return (
        answers.avoidTopics.length <= 10 &&
        answers.avoidTopics.every((topic) => topic.length <= 60) &&
        answers.neverClaim.length <= 5 &&
        answers.neverClaim.every((claim) => claim.length <= 120)
      );
    default:
      return true;
  }
};

function CheckRow({
  label,
  checked,
  onToggle,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li>
      <label className="flex items-center gap-2 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span>{label}</span>
      </label>
    </li>
  );
}

function RadioRow({
  name,
  label,
  checked,
  onPick,
}: {
  readonly name: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onPick: () => void;
}) {
  return (
    <li>
      <label className="flex items-center gap-2 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm">
        <input type="radio" name={name} checked={checked} onChange={onPick} />
        <span>{label}</span>
      </label>
    </li>
  );
}

function Wizard({
  behaviour,
  suffix,
  clubName,
  session,
  reload,
}: {
  readonly behaviour: AssistantBehaviourView;
  readonly suffix: SafetySuffix;
  readonly clubName: string;
  readonly session: Session;
  readonly reload: () => void;
}) {
  const toast = useToast();
  const [, navigate] = useLocation();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<PromptWizardAnswers>(
    () =>
      behaviour.promptWizard ??
      (behaviour.surface === 'it-services'
        ? DEFAULT_WIZARD_ANSWERS['it-services']
        : DEFAULT_WIZARD_ANSWERS.club),
  );
  const [editedPrompt, setEditedPrompt] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [topicDraft, setTopicDraft] = useState('');
  const [claimDraft, setClaimDraft] = useState('');
  const [exampleQuestion, setExampleQuestion] = useState('');
  const [exampleAnswer, setExampleAnswer] = useState('');

  const generated = buildSystemPrompt(answers, { clubName, behaviourName: behaviour.name });
  const prompt = editedPrompt ?? generated;
  const cleaned = prompt.trim();
  const saveable = cleaned.length >= 1 && cleaned.length <= 4_000;

  const update = (next: PromptWizardAnswers): void => {
    setAnswers(next);
    // The textarea shows the fresh wording until the operator edits it by hand.
    setEditedPrompt(undefined);
  };

  const save = async (): Promise<void> => {
    if (!saveable) {
      toast({
        tone: 'danger',
        title: 'Instructions not saved',
        message: 'Use 1 to 4,000 characters.',
      });
      return;
    }
    setBusy(true);
    try {
      const result = await session.writeOrThrow(
        behaviourUrl(behaviour.id),
        {
          ...behaviourBody(behaviour, { systemPrompt: cleaned }),
          promptWizard: answers,
        },
        'PUT',
      );
      if (result !== undefined) {
        toast({ tone: 'ok', title: `${behaviour.name} prompt saved` });
        navigate('/assistant');
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast({
          tone: 'hold',
          title: 'Prompt changed elsewhere',
          message: 'Reloaded the latest revision. Review it before saving again.',
        });
        reload();
      } else {
        toast({
          tone: 'danger',
          title: 'Instructions not saved',
          message: 'The server refused these instructions. Check the fields and try again.',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const meta = STEPS[step]!;

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-ink-muted">Step {step + 1} of 7</p>
      <p className="text-sm text-ink-muted">Building instructions for {behaviour.name}.</p>
      <Card title={meta.heading}>
        <p className="mb-3 text-sm text-ink-muted">{meta.purpose}</p>
        {step === 0 && (
          <ul className="grid gap-1 sm:grid-cols-2">
            {AUDIENCE_OPTIONS.map((option) => (
              <CheckRow
                key={option.value}
                label={option.label}
                checked={answers.audience.includes(option.value)}
                onToggle={() =>
                  update({
                    ...answers,
                    audience: toggleIn(
                      answers.audience,
                      option.value,
                    ) as PromptWizardAnswers['audience'],
                  })
                }
              />
            ))}
          </ul>
        )}
        {step === 1 && (
          <>
            <ul className="grid gap-1 sm:grid-cols-2">
              {HELPS_WITH_OPTIONS.map((option) => (
                <CheckRow
                  key={option.value}
                  label={option.label}
                  checked={answers.helpsWith.includes(option.value)}
                  onToggle={() =>
                    update({
                      ...answers,
                      helpsWith: toggleIn(
                        answers.helpsWith,
                        option.value,
                      ) as PromptWizardAnswers['helpsWith'],
                    })
                  }
                />
              ))}
            </ul>
            <div className="mt-3">
              <Field
                label="Anything else it helps with"
                hint="One short line, for example 3D-printer bookings. Leave it empty if the list above covers everything."
              >
                <Input
                  value={answers.helpsWithOther}
                  maxLength={300}
                  onChange={(e) => update({ ...answers, helpsWithOther: e.target.value })}
                />
              </Field>
            </div>
          </>
        )}
        {step === 2 && (
          <div className="grid gap-4">
            <section aria-label="Tone">
              <h3 className="text-sm font-medium">Tone</h3>
              <ul className="mt-1 grid gap-1 sm:grid-cols-3">
                {TONE_OPTIONS.map((option) => (
                  <RadioRow
                    key={option.value}
                    name="wizard-tone"
                    label={option.label}
                    checked={answers.tone === option.value}
                    onPick={() => update({ ...answers, tone: option.value })}
                  />
                ))}
              </ul>
            </section>
            <section aria-label="Length">
              <h3 className="text-sm font-medium">Length</h3>
              <ul className="mt-1 grid gap-1 sm:grid-cols-3">
                {LENGTH_OPTIONS.map((option) => (
                  <RadioRow
                    key={option.value}
                    name="wizard-length"
                    label={option.label}
                    checked={answers.length === option.value}
                    onPick={() => update({ ...answers, length: option.value })}
                  />
                ))}
              </ul>
            </section>
            <section aria-label="Emoji">
              <h3 className="text-sm font-medium">Emoji</h3>
              <ul className="mt-1 grid gap-1 sm:grid-cols-2">
                {EMOJI_OPTIONS.map((option) => (
                  <RadioRow
                    key={option.value}
                    name="wizard-emoji"
                    label={option.label}
                    checked={answers.emoji === option.value}
                    onPick={() => update({ ...answers, emoji: option.value })}
                  />
                ))}
              </ul>
            </section>
            <Field label="Language" hint="2 to 40 characters. The default is Canadian English.">
              <Input
                value={answers.language}
                maxLength={40}
                onChange={(e) => update({ ...answers, language: e.target.value })}
              />
            </Field>
          </div>
        )}
        {step === 3 && (
          <div className="grid gap-3">
            <ul className="grid gap-1 sm:grid-cols-2">
              <CheckRow
                label="Prefer club sources"
                checked={answers.preferClubSources}
                onToggle={() =>
                  update({ ...answers, preferClubSources: !answers.preferClubSources })
                }
              />
              <CheckRow
                label="Cite sources"
                checked={answers.citeSources}
                onToggle={() => update({ ...answers, citeSources: !answers.citeSources })}
              />
            </ul>
            <p className="text-xs text-ink-muted">
              Club sources are the reviewed links and documents on the Resources page. The assistant
              checks them before answering from general knowledge.{' '}
              <HelpTip label="club sources">
                Preferring club sources keeps answers grounded in what the club already reviewed,
                instead of guessing.
              </HelpTip>
            </p>
            <CheckRow
              label="Say so instead of guessing"
              checked={answers.whenUnsure.say}
              onToggle={() =>
                update({
                  ...answers,
                  whenUnsure: { ...answers.whenUnsure, say: !answers.whenUnsure.say },
                })
              }
            />
            <Field
              label="What to suggest when unsure"
              hint="Where to point members, for example asking in the club channel. At most 120 characters."
            >
              <Input
                value={answers.whenUnsure.suggest}
                maxLength={120}
                onChange={(e) =>
                  update({
                    ...answers,
                    whenUnsure: { ...answers.whenUnsure, suggest: e.target.value },
                  })
                }
              />
            </Field>
          </div>
        )}
        {step === 4 && (
          <Field
            label="Club facts"
            hint="Meeting times, dues, room numbers — anything members ask about often. At most 1,200 characters."
          >
            <textarea
              value={answers.clubFacts}
              maxLength={1200}
              onChange={(e) => update({ ...answers, clubFacts: e.target.value })}
              className="mt-1 min-h-32 w-full rounded-sm border border-line bg-canvas p-2 text-sm text-ink"
            />
          </Field>
        )}
        {step === 5 && (
          <div className="grid gap-4">
            <section aria-label="Topics to avoid">
              <h3 className="text-sm font-medium">Topics to avoid</h3>
              <div className="mt-1 flex gap-2">
                <Input
                  aria-label="Add a topic to avoid"
                  value={topicDraft}
                  maxLength={60}
                  placeholder="For example politics"
                  onChange={(e) => setTopicDraft(e.target.value)}
                />
                <Button
                  disabled={topicDraft.trim() === '' || answers.avoidTopics.length >= 10}
                  onClick={() => {
                    update({
                      ...answers,
                      avoidTopics: [...answers.avoidTopics, topicDraft.trim()],
                    });
                    setTopicDraft('');
                  }}
                >
                  Add topic
                </Button>
              </div>
              {answers.avoidTopics.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1">
                  {answers.avoidTopics.map((topic) => (
                    <li
                      key={topic}
                      className="flex items-center gap-1 rounded-sm border border-line bg-panel px-2 py-1 text-sm"
                    >
                      {topic}
                      <Button
                        className="px-1.5 py-0 text-xs"
                        aria-label={`Remove ${topic}`}
                        onClick={() =>
                          update({
                            ...answers,
                            avoidTopics: answers.avoidTopics.filter((t) => t !== topic),
                          })
                        }
                      >
                        ×
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="Off topic">
              <h3 className="text-sm font-medium">When a question is off topic</h3>
              <ul className="mt-1 grid gap-1 sm:grid-cols-2">
                {OFF_TOPIC_OPTIONS.map((option) => (
                  <RadioRow
                    key={option.value}
                    name="wizard-off-topic"
                    label={option.label}
                    checked={answers.offTopic === option.value}
                    onPick={() => update({ ...answers, offTopic: option.value })}
                  />
                ))}
              </ul>
            </section>
            <section aria-label="Never claim">
              <h3 className="text-sm font-medium">
                Things it must never claim it did{' '}
                <HelpTip label="never claim">
                  The assistant sometimes sounds sure about actions it never took, like changing a
                  role. Naming them here keeps members&apos; trust.
                </HelpTip>
              </h3>
              <div className="mt-1 flex gap-2">
                <Input
                  aria-label="Add something it must never claim"
                  value={claimDraft}
                  maxLength={120}
                  placeholder="For example that a role was changed"
                  onChange={(e) => setClaimDraft(e.target.value)}
                />
                <Button
                  disabled={claimDraft.trim() === '' || answers.neverClaim.length >= 5}
                  onClick={() => {
                    update({ ...answers, neverClaim: [...answers.neverClaim, claimDraft.trim()] });
                    setClaimDraft('');
                  }}
                >
                  Add never-claim
                </Button>
              </div>
              {answers.neverClaim.length > 0 && (
                <ul className="mt-2 grid gap-1">
                  {answers.neverClaim.map((claim) => (
                    <li
                      key={claim}
                      className="flex items-center justify-between gap-2 rounded-sm border border-line bg-panel px-2 py-1 text-sm"
                    >
                      <span>{claim}</span>
                      <Button
                        className="px-1.5 py-0 text-xs"
                        aria-label={`Remove ${claim}`}
                        onClick={() =>
                          update({
                            ...answers,
                            neverClaim: answers.neverClaim.filter((c) => c !== claim),
                          })
                        }
                      >
                        ×
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
        {step === 6 && (
          <div className="grid gap-4">
            <section aria-label="Formatting">
              <h3 className="text-sm font-medium">Formatting</h3>
              <ul className="mt-1 grid gap-1 sm:grid-cols-2">
                {FORMAT_OPTIONS.map((option) => (
                  <CheckRow
                    key={option.key}
                    label={option.label}
                    checked={answers.format[option.key]}
                    onToggle={() =>
                      update({
                        ...answers,
                        format: { ...answers.format, [option.key]: !answers.format[option.key] },
                      })
                    }
                  />
                ))}
              </ul>
            </section>
            <section aria-label="Examples">
              <h3 className="text-sm font-medium">Examples</h3>
              <p className="mt-1 text-xs text-ink-muted">
                Up to three. Each one shows the assistant a good answer to copy.
              </p>
              {answers.examples.length > 0 && (
                <ul className="mt-2 grid gap-2">
                  {answers.examples.map((example, index) => (
                    <li key={index} className="rounded-sm border border-line bg-panel p-2 text-sm">
                      <p>
                        <strong>Q:</strong> {example.question}
                      </p>
                      <p className="mt-1">
                        <strong>A:</strong> {example.answer}
                      </p>
                      <Button
                        className="mt-2 px-1.5 py-0 text-xs"
                        aria-label={`Remove example ${index + 1}`}
                        onClick={() =>
                          update({
                            ...answers,
                            examples: answers.examples.filter((_, i) => i !== index),
                          })
                        }
                      >
                        Remove example {index + 1}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {answers.examples.length < 3 && (
                <div className="mt-2 grid gap-2">
                  <Field label="Example question">
                    <Input
                      value={exampleQuestion}
                      maxLength={300}
                      onChange={(e) => setExampleQuestion(e.target.value)}
                    />
                  </Field>
                  <Field label="Example answer">
                    <Input
                      value={exampleAnswer}
                      maxLength={600}
                      onChange={(e) => setExampleAnswer(e.target.value)}
                    />
                  </Field>
                  <div>
                    <Button
                      disabled={exampleQuestion.trim() === '' || exampleAnswer.trim() === ''}
                      onClick={() => {
                        update({
                          ...answers,
                          examples: [
                            ...answers.examples,
                            {
                              question: exampleQuestion.trim(),
                              answer: exampleAnswer.trim(),
                            },
                          ],
                        });
                        setExampleQuestion('');
                        setExampleAnswer('');
                      }}
                    >
                      Add example
                    </Button>
                  </div>
                </div>
              )}
            </section>
            <Field
              label="Instructions to save"
              hint="Edit anything the wizard got wrong. Members do not see these operator instructions."
            >
              <textarea
                value={prompt}
                maxLength={4_000}
                onChange={(e) => setEditedPrompt(e.target.value)}
                className="mt-1 min-h-48 w-full rounded-sm border border-line bg-canvas p-2 text-sm text-ink"
              />
            </Field>
            <p className="text-xs text-ink-muted">
              {prompt.length.toLocaleString('en-CA')} / 4,000 characters
            </p>
            <section
              aria-label="Locked safety rules"
              className="rounded-sm border border-line bg-panel p-3"
            >
              <h3 className="text-sm font-medium">
                Always added by Bananasaurs — can&apos;t be changed
              </h3>
              <p className="mt-1 text-xs text-ink-muted">
                It keeps the bot from revealing its model, harassing anyone, or leaking its
                instructions.
              </p>
              <pre className="mt-2 overflow-x-auto font-mono text-xs whitespace-pre-wrap text-ink-muted">
                {suffix.text}
              </pre>
            </section>
          </div>
        )}
        <div className="mt-4 flex gap-2">
          <Button disabled={step === 0 || busy} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            Back
          </Button>
          {step < 6 && (
            <Button
              variant="primary"
              disabled={!stepValid(step, answers) || busy}
              onClick={() => setStep((s) => Math.min(6, s + 1))}
            >
              Next
            </Button>
          )}
          {step === 6 && (
            <Button variant="primary" busy={busy} disabled={!saveable} onClick={() => void save()}>
              Save instructions
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

export function AssistantPromptWizardPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const load = useCallback(() => session.read<AssistantData>(ASSISTANT_URL), [session]);
  const assistant = useResource('assistant settings', load);
  const loadSuffix = useCallback(() => session.read<SafetySuffix>(SAFETY_SUFFIX_URL), [session]);
  const suffix = useResource('safety rules', loadSuffix);
  const clubName = session.info.guildName ?? 'the club';

  return (
    <>
      <PageHeader
        title="Build the prompt"
        purpose="Answer seven short steps and the wizard writes the instructions for you."
        actions={
          <Link href="/assistant">
            <Button>Behaviours</Button>
          </Link>
        }
      />
      <DataState resource={assistant.resource}>
        {(data) => {
          const behaviour = data.behaviours.find((item) => item.id === id);
          if (behaviour === undefined) {
            return (
              <EmptyState
                title="That behaviour doesn't exist."
                detail="It may have been renamed or removed."
                action={
                  <Link
                    className="text-sm font-medium underline underline-offset-4"
                    href="/assistant"
                  >
                    Back to Behaviours
                  </Link>
                }
              />
            );
          }
          return (
            <DataState resource={suffix.resource}>
              {(locked) => (
                <Wizard
                  key={behaviour.id}
                  behaviour={behaviour}
                  suffix={locked}
                  clubName={clubName}
                  session={session}
                  reload={() => {
                    assistant.reload();
                    suffix.reload();
                  }}
                />
              )}
            </DataState>
          );
        }}
      </DataState>
    </>
  );
}
