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
const userMention = (userId: string): RegExp => new RegExp(`<@!?${userId}>`, 'g');

/**
 * Resolve a member message to one reviewed mention behaviour.
 *
 * A message naming both assistant roles never merges prompts or skill sets. It
 * is rejected locally, before retrieval or a provider can see its contents.
 *
 * Tagging the bot user itself (not a mapped role) routes to the one enabled
 * behaviour flagged `answersBotTag` (ADR 0063), or nowhere when none is. Like
 * `/ask`, that path leaves the caller-role check to the service, which exempts
 * the owner and answers with a visible refusal. A mapped role tag in the same
 * message wins, so a member can still pick a specialised desk.
 */
export const routeAssistantMention = (
  event: MessageEvent,
  behaviours: readonly AssistantBehaviour[],
  botUserId: string,
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
  const botTagged = event.mentionedUserIds.includes(botUserId);
  if (mentioned.size === 0 && !botTagged) return { kind: 'not-addressed' };

  let behaviour: AssistantBehaviour;
  if (mentioned.size === 0) {
    const flagged = behaviours.filter(
      (candidate) =>
        candidate.enabled &&
        candidate.guildId === event.guildId &&
        candidate.answersBotTag === true,
    );
    // The database allows one flag per guild; anything else is not ours to guess.
    if (flagged.length !== 1) return { kind: 'not-addressed' };
    behaviour = flagged[0]!;
  } else {
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
  }

  if (
    mentioned.size > 0 &&
    !behaviour.callerRoleIds.some((roleId) => (event.authorRoleIds ?? []).includes(roleId))
  ) {
    return {
      kind: 'ambiguous',
      message: 'Your server role is not allowed to use that assistant tag.',
    };
  }

  let prompt = (event.content ?? '').replace(userMention(botUserId), ' ');
  for (const roleId of mentioned) prompt = prompt.replace(roleMention(roleId), ' ');
  prompt = prompt.replace(/\s+/g, ' ').trim();
  if (prompt.length === 0) {
    return { kind: 'ambiguous', message: 'Add a question after the assistant tag.' };
  }
  return { kind: 'routed', behaviour, prompt };
};
