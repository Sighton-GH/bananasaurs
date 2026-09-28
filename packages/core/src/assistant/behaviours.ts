import type { AssistantBehaviour, AssistantSurface } from './types.js';

export interface BehaviourRequest {
  readonly guildId: string;
  readonly mentionedRoleIds: ReadonlySet<string>;
  readonly directCommand?: boolean;
}

const matchesSurface = (behaviour: AssistantBehaviour, request: BehaviourRequest): boolean => {
  if (behaviour.surface === 'direct-command') return request.directCommand === true;
  return (
    behaviour.mentionRoleId !== undefined && request.mentionedRoleIds.has(behaviour.mentionRoleId)
  );
};

/** Resolve exactly one reviewed behaviour. Ambiguous tags fail closed instead of merging prompts. */
export const resolveAssistantBehaviour = (
  behaviours: readonly AssistantBehaviour[],
  request: BehaviourRequest,
): AssistantBehaviour => {
  const matches = behaviours.filter(
    (candidate) =>
      candidate.enabled &&
      candidate.guildId === request.guildId &&
      matchesSurface(candidate, request),
  );
  if (matches.length === 0)
    throw new Error('no enabled assistant behaviour matches this invocation');
  if (matches.length > 1)
    throw new Error('assistant invocation is ambiguous; use one configured tag');
  return matches[0]!;
};

/** Surface-specific guidance belongs to the behaviour; direct commands use the non-slash-era fallback. */
export const surfaceInstruction = (surface: AssistantSurface): string => {
  if (surface === 'it-services') {
    return 'Act as the club IT service desk. Prefer exact diagnostics, access steps and escalation paths. Never invent credentials or claim an access change happened.';
  }
  if (surface === 'help') {
    return 'Act as the club help desk. Give onboarding and club-process guidance from reviewed sources, cite them, and escalate when evidence is missing.';
  }
  if (surface === 'bananasaurs') {
    return 'Act as the club assistant. Answer concisely in Canadian English, cite club sources and say when current evidence is missing.';
  }
  return "Answer the member's message; use what you can do when they ask for it.";
};
