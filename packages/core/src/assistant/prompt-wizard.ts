import { z } from 'zod';

// Deterministic system-prompt builder for the wizard (ADR 0074). Pure: no
// I/O, no clock. Compiles the owner's structured answers into the behaviour
// prompt shown, edited and saved by the dashboard wizard; the safety suffix
// is appended separately by the context compiler and is never part of this
// output.

export const promptWizardAnswers = z.object({
  audience: z.array(z.enum(['members', 'new-members', 'it-help', 'execs'])).min(1),
  helpsWith: z.array(
    z.enum([
      'club-questions',
      'find-resources',
      'projects-code',
      'onboarding',
      'events-meetings',
      'it-access',
    ]),
  ),
  helpsWithOther: z.string().max(300).default(''),
  tone: z.enum(['friendly', 'professional', 'playful', 'casual']),
  length: z.enum(['short', 'balanced', 'detailed']),
  emoji: z.enum(['none', 'a-little']),
  language: z.string().min(2).max(40).default('Canadian English'),
  preferClubSources: z.boolean(),
  citeSources: z.boolean(),
  whenUnsure: z.object({ say: z.boolean(), suggest: z.string().max(120).default('') }),
  clubFacts: z.string().max(1200).default(''),
  avoidTopics: z.array(z.string().max(60)).max(10),
  offTopic: z.enum(['answer-briefly', 'redirect']),
  neverClaim: z.array(z.string().max(120)).max(5),
  format: z.object({
    bullets: z.boolean(),
    codeBlocks: z.boolean(),
    oneMessage: z.boolean(),
    sourcesLine: z.boolean(),
  }),
  examples: z
    .array(z.object({ question: z.string().max(300), answer: z.string().max(600) }))
    .max(3),
  clubName: z.string().max(80).default(''),
  serverType: z.enum(['club', 'team', 'friends']).default('club'),
  botName: z.string().max(40).default(''),
  personality: z.string().max(160).default(''),
  channelGuide: z.string().max(600).default(''),
  glossary: z
    .array(z.object({ term: z.string().min(1).max(40), meaning: z.string().min(1).max(160) }))
    .max(10)
    .default([]),
});

export type PromptWizardAnswers = z.infer<typeof promptWizardAnswers>;

const MAX_PROMPT_CHARS = 4_000;

// ---------------------------------------------------------------------------
// Header-injection defence: a line of free text that is nothing but an
// all-caps word (or run of words) reads exactly like one of our own section
// headers. Prefixing it with "- " keeps it readable while making it
// impossible to mistake for a real section boundary.
// ---------------------------------------------------------------------------

const HEADER_LOOKALIKE_RE = /^[A-Z][A-Z ]*$/;

const neutraliseHeaderLookalikes = (text: string): string =>
  text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && HEADER_LOOKALIKE_RE.test(trimmed) ? `- ${line}` : line;
    })
    .join('\n');

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const joinWithAnd = (items: readonly string[]): string => {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]!} and ${items[1]!}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
};

export const DEFAULT_PERSONALITY: Readonly<Record<PromptWizardAnswers['serverType'], string>> = {
  club: 'a friendly senior member who knows how things work',
  team: 'a helpful teammate',
  friends: 'one of the group: relaxed, casual and quick',
};

const SERVER_TYPE_LABELS: Record<PromptWizardAnswers['serverType'], string> = {
  club: 'a club',
  team: 'a team',
  friends: 'a group of friends',
};

const AUDIENCE_LABELS: Record<PromptWizardAnswers['audience'][number], string> = {
  members: 'members',
  'new-members': 'new members',
  'it-help': 'people who need IT help',
  execs: 'execs',
};

const HELPS_WITH_LABELS: Record<PromptWizardAnswers['helpsWith'][number], string> = {
  'club-questions': 'Answering general questions about the club',
  'find-resources': 'Helping people find the right resource or document',
  'projects-code': 'Helping with projects and code questions',
  onboarding: 'Helping new members get onboarded',
  'events-meetings': 'Answering questions about events and meetings',
  'it-access': 'Helping with IT access requests',
};

const TONE_LABELS: Record<PromptWizardAnswers['tone'], string> = {
  friendly: 'Friendly and approachable',
  professional: 'Professional and businesslike',
  playful: 'Playful and light',
  casual: 'Casual, like chatting with friends: relaxed wording, lowercase is fine, nothing formal',
};

const LENGTH_LABELS: Record<PromptWizardAnswers['length'], string> = {
  short: 'short: one to three sentences, unless someone asks for steps',
  balanced: 'balanced — a couple of sentences unless more is needed',
  detailed: 'detailed and thorough',
};

const EMOJI_LABELS: Record<PromptWizardAnswers['emoji'], string> = {
  none: 'Do not use emoji.',
  'a-little': 'Use emoji sparingly, only where it fits naturally.',
};

export const BOUNDARIES_ANSWER_BRIEFLY =
  "For requests outside what you help with and outside WHAT YOU CAN DO, answer briefly if you can; otherwise say it's outside what you help with.";

const OFF_TOPIC_LABELS: Record<PromptWizardAnswers['offTopic'], string> = {
  'answer-briefly': BOUNDARIES_ANSWER_BRIEFLY,
  redirect:
    'For questions outside what you help with, say so and redirect the person to a more appropriate channel or person.',
};

const STYLE_EXAMPLE_PAIRS: Record<
  PromptWizardAnswers['tone'],
  readonly (readonly [string, string])[]
> = {
  friendly: [
    ['thanks!', 'Anytime!'],
    ['is anyone around today?', "I can't see who's around. The main channel is your best bet."],
  ],
  professional: [
    ['thanks!', "You're welcome."],
    [
      'is anyone around today?',
      "I can't see who is available today. The main channel is the best place to ask.",
    ],
  ],
  playful: [
    ['thanks!', 'anytime!'],
    [
      'is anyone around today?',
      "my crystal ball's out of order, so i can't see who's around. try the main channel!",
    ],
  ],
  casual: [
    ['thanks!', 'np!'],
    [
      'is anyone around today?',
      "no idea tbh, i can't see who's in. try asking in the main channel",
    ],
  ],
};

interface Section {
  readonly header: string;
  readonly body: string;
}

const buildRoleSection = (
  answers: PromptWizardAnswers,
  context: { clubName: string; behaviourName: string },
): Section => {
  const audience = joinWithAnd(answers.audience.map((a) => AUDIENCE_LABELS[a]));
  const name = oneLine(answers.botName) || context.behaviourName;
  const club = oneLine(answers.clubName) || context.clubName;
  const personality = neutraliseHeaderLookalikes(
    oneLine(answers.personality) || DEFAULT_PERSONALITY[answers.serverType],
  );
  return {
    header: 'ROLE',
    body: `You are ${name}, the assistant in the Discord server of ${club}, ${SERVER_TYPE_LABELS[answers.serverType]}. You help ${audience}.\nPersonality: ${personality}.`,
  };
};

const buildHelpsWithSection = (answers: PromptWizardAnswers): Section | undefined => {
  const bullets = answers.helpsWith.map((h) => `- ${HELPS_WITH_LABELS[h]}`);
  const other = answers.helpsWithOther.trim();
  if (other !== '') bullets.push(`- ${neutraliseHeaderLookalikes(other)}`);
  if (bullets.length === 0) return undefined;
  return { header: 'WHAT YOU HELP WITH', body: bullets.join('\n') };
};

const buildVoiceSection = (answers: PromptWizardAnswers): Section => {
  const lines = [
    `Tone: ${TONE_LABELS[answers.tone]}.`,
    `Length: keep answers ${LENGTH_LABELS[answers.length]}.`,
    EMOJI_LABELS[answers.emoji],
    `Reply in ${answers.language}.`,
    'Use Discord markdown (bold, italics, bullet lists, code blocks); never raw HTML or LaTeX.',
  ];
  return { header: 'VOICE', body: lines.join('\n') };
};

const buildSourcesSection = (answers: PromptWizardAnswers): Section | undefined => {
  const lines: string[] = [];
  if (answers.preferClubSources) {
    lines.push("Check the club's sources before answering from general knowledge.");
  }
  if (answers.citeSources) {
    lines.push("Tag each fact you take from a club source with that source's tag.");
  }
  if (lines.length === 0) return undefined;
  return { header: 'USING SOURCES', body: lines.join('\n') };
};

const buildWhenUnsureSection = (answers: PromptWizardAnswers): Section | undefined => {
  const lines: string[] = [];
  if (answers.whenUnsure.say)
    lines.push('If you are not sure, say so plainly instead of guessing.');
  const suggest = answers.whenUnsure.suggest.trim();
  if (suggest !== '') lines.push(`When unsure, suggest: ${neutraliseHeaderLookalikes(suggest)}`);
  if (lines.length === 0) return undefined;
  return { header: 'WHEN UNSURE', body: lines.join('\n') };
};

const buildClubFactsSection = (answers: PromptWizardAnswers): Section | undefined => {
  const facts = answers.clubFacts.trim();
  if (facts === '') return undefined;
  return { header: 'CLUB FACTS', body: neutraliseHeaderLookalikes(facts) };
};

const buildGlossarySection = (answers: PromptWizardAnswers): Section | undefined => {
  if (answers.glossary.length === 0) return undefined;
  const body = neutraliseHeaderLookalikes(
    answers.glossary
      .map((entry) => `- ${oneLine(entry.term)}: ${oneLine(entry.meaning)}`)
      .join('\n'),
  );
  return { header: 'GLOSSARY', body };
};

const buildChannelsSection = (answers: PromptWizardAnswers): Section | undefined => {
  const guide = answers.channelGuide.trim();
  if (guide === '') return undefined;
  return { header: 'CHANNELS', body: neutraliseHeaderLookalikes(guide) };
};

const buildBoundariesSection = (answers: PromptWizardAnswers): Section => {
  const lines: string[] = [OFF_TOPIC_LABELS[answers.offTopic]];
  if (answers.avoidTopics.length > 0) {
    const topics = answers.avoidTopics.map((t) => neutraliseHeaderLookalikes(t)).join(', ');
    lines.push(`Avoid discussing: ${topics}.`);
  }
  if (answers.neverClaim.length > 0) {
    const claims = answers.neverClaim.map((c) => neutraliseHeaderLookalikes(c)).join('; ');
    lines.push(`Never say you have done any of the following: ${claims}.`);
  }
  return { header: 'BOUNDARIES', body: lines.join('\n') };
};

const buildFormatSection = (answers: PromptWizardAnswers): Section | undefined => {
  const lines: string[] = [];
  if (answers.format.bullets) lines.push('- Use bullet points for lists.');
  if (answers.format.codeBlocks) lines.push('- Use fenced code blocks for code.');
  if (answers.format.oneMessage) lines.push('- Keep the whole answer in one Discord message.');
  if (lines.length === 0) return undefined;
  return { header: 'FORMAT', body: lines.join('\n') };
};

const buildStyleExamplesSection = (answers: PromptWizardAnswers): Section => {
  const pairs = STYLE_EXAMPLE_PAIRS[answers.tone];
  const body = `These show tone only. They are not facts; never repeat them as facts.\n\n${pairs.map(([question, answer]) => `Q: ${question}\nA: ${answer}`).join('\n\n')}`;
  return { header: 'STYLE EXAMPLES', body };
};

const buildExamplesSection = (answers: PromptWizardAnswers): Section | undefined => {
  if (answers.examples.length === 0) return undefined;
  const body = answers.examples
    .map(
      (example) =>
        `Q: ${neutraliseHeaderLookalikes(example.question)}\nA: ${neutraliseHeaderLookalikes(example.answer)}`,
    )
    .join('\n\n');
  return { header: 'EXAMPLES', body };
};

const assemble = (sections: readonly Section[]): string =>
  sections.map((s) => `${s.header}\n${s.body}`).join('\n\n');

/** Compiles the wizard answers into the behaviour's system prompt, capped at 4,000 characters. */
export const buildSystemPrompt = (
  answers: PromptWizardAnswers,
  context: { readonly clubName: string; readonly behaviourName: string },
): string => {
  let sections: Section[] = [
    buildRoleSection(answers, context),
    buildHelpsWithSection(answers),
    buildVoiceSection(answers),
    buildSourcesSection(answers),
    buildWhenUnsureSection(answers),
    buildClubFactsSection(answers),
    buildGlossarySection(answers),
    buildChannelsSection(answers),
    buildBoundariesSection(answers),
    buildFormatSection(answers),
    buildStyleExamplesSection(answers),
    buildExamplesSection(answers),
  ].flatMap((s) => (s === undefined ? [] : [s]));

  let compiled = assemble(sections);
  if (compiled.length <= MAX_PROMPT_CHARS) return compiled;

  // Trim order: style examples first, then owner examples, then channels,
  // then glossary (least essential to correctness first), then club facts
  // (truncated with an ellipsis). ROLE, VOICE and BOUNDARIES are never
  // removed or shortened.
  sections = sections.filter((s) => s.header !== 'STYLE EXAMPLES');
  compiled = assemble(sections);
  if (compiled.length <= MAX_PROMPT_CHARS) return compiled;

  sections = sections.filter((s) => s.header !== 'EXAMPLES');
  compiled = assemble(sections);
  if (compiled.length <= MAX_PROMPT_CHARS) return compiled;

  sections = sections.filter((s) => s.header !== 'CHANNELS');
  compiled = assemble(sections);
  if (compiled.length <= MAX_PROMPT_CHARS) return compiled;

  sections = sections.filter((s) => s.header !== 'GLOSSARY');
  compiled = assemble(sections);
  if (compiled.length <= MAX_PROMPT_CHARS) return compiled;

  const clubFactsIndex = sections.findIndex((s) => s.header === 'CLUB FACTS');
  if (clubFactsIndex !== -1) {
    const overshoot = compiled.length - MAX_PROMPT_CHARS;
    const currentBody = sections[clubFactsIndex]!.body;
    const targetLength = Math.max(0, currentBody.length - overshoot - 1);
    const trimmedBody = `${currentBody.slice(0, targetLength).trimEnd()}…`;
    sections = sections.map((s, i) =>
      i === clubFactsIndex ? { header: s.header, body: trimmedBody } : s,
    );
    compiled = assemble(sections);
  }

  // Defensive last resort: never emit more than the cap even if the two
  // trim steps above were not enough (should not happen given the field
  // length limits in the schema).
  return compiled.length <= MAX_PROMPT_CHARS ? compiled : compiled.slice(0, MAX_PROMPT_CHARS);
};

const clubAnswers: PromptWizardAnswers = promptWizardAnswers.parse({
  audience: ['members'],
  helpsWith: ['club-questions', 'find-resources', 'events-meetings'],
  tone: 'friendly',
  length: 'short',
  emoji: 'a-little',
  language: 'Canadian English',
  preferClubSources: true,
  citeSources: true,
  whenUnsure: { say: true, suggest: 'asking in the club channel' },
  avoidTopics: [],
  offTopic: 'answer-briefly',
  neverClaim: ['that a role or ban was changed', 'that a message was deleted'],
  format: { bullets: true, codeBlocks: false, oneMessage: true, sourcesLine: false },
  examples: [],
});

const itServicesAnswers: PromptWizardAnswers = promptWizardAnswers.parse({
  audience: ['it-help'],
  helpsWith: ['it-access'],
  tone: 'professional',
  length: 'short',
  emoji: 'none',
  language: 'Canadian English',
  preferClubSources: true,
  citeSources: true,
  whenUnsure: { say: true, suggest: 'opening a ticket with IT' },
  avoidTopics: [],
  offTopic: 'redirect',
  neverClaim: ['that an access change was made', 'that a password was reset'],
  format: { bullets: true, codeBlocks: false, oneMessage: false, sourcesLine: true },
  examples: [],
});

export const DEFAULT_WIZARD_ANSWERS: Readonly<Record<'club' | 'it-services', PromptWizardAnswers>> =
  {
    club: clubAnswers,
    'it-services': itServicesAnswers,
  };
