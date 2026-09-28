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

/**
 * Task G3: the slash commands are gone (ADR 0086), so a mention or bot-tag
 * invocation gets no surface section — the compiler drops empty text. Only
 * the `direct-command` drain path keeps a line, and it names no slash era.
 */
export const surfaceInstruction = (surface: AssistantSurface): string => {
  if (surface === 'direct-command') {
    return "Answer the member's message; use what you can do when they ask for it.";
  }
  return '';
};
