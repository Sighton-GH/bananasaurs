import {
  resolveAssistantBehaviour,
  type AssistantBehaviour,
  type MessageEvent,
} from '@bananasaurs/core';

export type MentionRoute =
  | { readonly kind: 'not-addressed' }
  | { readonly kind: 'ambiguous'; readonly message: string }
  | {
      readonly kind: 'routed';
      readonly behaviour: AssistantBehaviour;
      readonly prompt: string;
    };

const roleMention = (roleId: string): RegExp => new RegExp(`<@&${roleId}>`, 'g');

/**
 * Resolve a member message to one reviewed mention behaviour.
 *
 * A message naming both assistant roles never merges prompts or skill sets. It
 * is rejected locally, before retrieval or a provider can see its contents.
 */
export const routeAssistantMention = (
  event: MessageEvent,
  behaviours: readonly AssistantBehaviour[],
): MentionRoute => {
  if (event.kind !== 'messageCreate' || event.authorIsBot || event.authorId === undefined)
    return { kind: 'not-addressed' };

  const configuredRoleIds = new Set(
    behaviours.flatMap((behaviour) =>
      behaviour.enabled &&
      behaviour.guildId === event.guildId &&
      behaviour.surface !== 'direct-command' &&
      behaviour.mentionRoleId !== undefined
        ? [behaviour.mentionRoleId]
        : [],
    ),
  );
  const mentioned = new Set(event.mentionedRoleIds.filter((id) => configuredRoleIds.has(id)));
  if (mentioned.size === 0) return { kind: 'not-addressed' };

  let behaviour: AssistantBehaviour;
  try {
    behaviour = resolveAssistantBehaviour(behaviours, {
      guildId: event.guildId,
      mentionedRoleIds: mentioned,
    });
  } catch {
    return {
      kind: 'ambiguous',
      message: 'Please tag either @bananasaurs or @it-services, not both.',
    };
  }

  if (!behaviour.callerRoleIds.some((roleId) => (event.authorRoleIds ?? []).includes(roleId))) {
    return {
      kind: 'ambiguous',
      message: 'Your server role is not allowed to use that assistant tag.',
    };
  }

  let prompt = event.content ?? '';
  for (const roleId of mentioned) prompt = prompt.replace(roleMention(roleId), ' ');
  prompt = prompt.replace(/\s+/g, ' ').trim();
  if (prompt.length === 0) {
    return { kind: 'ambiguous', message: 'Add a question after the assistant tag.' };
  }
  return { kind: 'routed', behaviour, prompt };
};
