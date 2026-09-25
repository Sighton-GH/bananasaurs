import type { ConversationResolution, GenerationMessage } from '@bananasaurs/core';
import { conversationRepo, type GuildScope } from '@bananasaurs/storage';

/**
 * Builds the conversation half of a provider request (Task 14, ADR 0072).
 *
 * Pure mapping over stored turns plus the live quote: the recent window (12
 * turns / 6,000 characters, pinned opening quote counted inside the cap —
 * `conversationRepo.recentTurns`) becomes provider messages, and a quoted
 * message becomes the untrusted envelope. Nothing here touches
 * `systemInstruction`: quoted text is untrusted evidence and travels only in
 * the user turn.
 *
 * The current user turn is already stored when this runs — the job creates
 * the conversation row and the user turn before invoking — so the history
 * always ends with the question being answered, and the participant count
 * naturally includes its author. That is what makes a reply by another
 * member label both speakers.
 */

/** The recent-turn window, verbatim from the spec (global constraints). */
const HISTORY_TURNS = 12;
const HISTORY_CHARS = 6_000;

export interface QuotedMessage {
  readonly authorName: string;
  readonly content: string;
}

export interface ConversationContextInput {
  readonly scope: GuildScope;
  readonly resolution: ConversationResolution;
  readonly quoted?: QuotedMessage | undefined;
  readonly botDisplayName: string;
}

export interface ConversationContext {
  readonly history: GenerationMessage[];
  readonly quoteEnvelope?: string;
  /** Distinct human speakers across the history and the quote. */
  readonly participants: number;
}

/** A quoted message as untrusted evidence inside the user turn. */
export const quoteEnvelopeFor = (quoted: QuotedMessage): string =>
  `[UNTRUSTED QUOTED MESSAGE author=${JSON.stringify(quoted.authorName)}]\n${quoted.content}\n[/UNTRUSTED QUOTED MESSAGE]`;

export const buildConversationContext = (input: ConversationContextInput): ConversationContext => {
  const conversationId =
    input.resolution.kind === 'continue' ? input.resolution.conversationId : undefined;
  const turns =
    conversationId === undefined
      ? []
      : conversationRepo.recentTurns(input.scope, conversationId, {
          maxTurns: HISTORY_TURNS,
          maxChars: HISTORY_CHARS,
        });

  // The bot is the assistant, never a participant: a turn mislabelled with
  // its name must not mint a phantom second speaker and switch prefixes on.
  const names = new Set<string>();
  for (const turn of turns) {
    if (
      (turn.role === 'user' || turn.role === 'quote') &&
      turn.authorName !== input.botDisplayName
    ) {
      names.add(turn.authorName);
    }
  }
  if (input.quoted !== undefined && input.quoted.authorName !== input.botDisplayName) {
    names.add(input.quoted.authorName);
  }
  const participants = names.size;

  const history: GenerationMessage[] = turns.map((turn) => {
    if (turn.role === 'assistant') return { role: 'assistant', text: turn.text };
    if (turn.role === 'quote') {
      return {
        role: 'user',
        text: quoteEnvelopeFor({ authorName: turn.authorName, content: turn.text }),
      };
    }
    return {
      role: 'user',
      text: participants > 1 ? `${turn.authorName}: ${turn.text}` : turn.text,
    };
  });

  return {
    history,
    ...(input.quoted === undefined ? {} : { quoteEnvelope: quoteEnvelopeFor(input.quoted) }),
    participants,
  };
};
