import {
  resolveAssistantBehaviour,
  type AssistantBehaviour,
  type KnownMessage,
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
 * behaviour flagged `answersBotTag` (ADR 0063), or nowhere when none is. A
 * mapped role tag in the same message wins, so a member can still pick a
 * specialised desk. Neither path checks caller roles here: like `/ask`, the
 * service does, exempting the owner and answering a refusal through the keyed
 * job instead of dropping it silently (ADR 0064).
 *
 * An untagged message that is a Discord Reply to a known bot answer also
 * routes, to that answer's own behaviour (ADR 0072): `lookupMessage`, when
 * given, is asked about `event.referencedMessageId` before falling back to
 * "not addressed". A reply to a bot message *unknown* to `lookupMessage`
 * does not route here — that case is the resolver's `reply-to-unknown-bot-
 * message` rule, which only ever applies to a tagged message (Task 13's
 * conversation resolver, `packages/core/src/assistant/conversation.ts`).
 */
export const routeAssistantMention = (
  event: MessageEvent,
  behaviours: readonly AssistantBehaviour[],
  botUserId: string,
  lookupMessage?: (messageId: string) => KnownMessage | undefined,
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
  if (mentioned.size === 0 && !botTagged) {
    if (
      lookupMessage !== undefined &&
      event.referencedMessageId !== undefined &&
      event.referencedAuthorId === botUserId
    ) {
      const known = lookupMessage(event.referencedMessageId);
      if (
        known !== undefined &&
        known.role === 'assistant' &&
        known.channelId === event.channelId
      ) {
        const behaviour = behaviours.find(
          (candidate) =>
            candidate.id === known.behaviourId &&
            candidate.enabled &&
            candidate.guildId === event.guildId,
        );
        if (behaviour !== undefined) {
          const prompt = (event.content ?? '').trim();
          if (prompt.length === 0) return { kind: 'not-addressed' };
          return { kind: 'routed', behaviour, prompt };
        }
      }
    }
    return { kind: 'not-addressed' };
  }

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

  let prompt = (event.content ?? '').replace(userMention(botUserId), ' ');
  for (const roleId of mentioned) prompt = prompt.replace(roleMention(roleId), ' ');
  prompt = prompt.replace(/\s+/g, ' ').trim();
  if (prompt.length === 0) {
    return { kind: 'ambiguous', message: 'Add a question after the assistant tag.' };
  }
  return { kind: 'routed', behaviour, prompt };
};
