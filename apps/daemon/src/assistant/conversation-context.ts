import {
  relativeAgo,
  safeDisplayName,
  neutraliseMarkers,
  type ConversationResolution,
  type GenerationMessage,
} from '@bananasaurs/core';
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
 * the conversation row, the quote turn and the user turn before invoking —
 * so the caller names it via `excludeTurnId` and it is left out of the
 * history: the question travels as the request's user text, exactly once.
 * Its author still counts toward `participants`, so a reply by another
 * member keeps both speakers labelled.
 */

/** The recent-turn window, verbatim from the spec (global constraints). */
export const HISTORY_TURNS = 12;
export const HISTORY_CHARS = 6_000;

export interface QuotedMessage {
  readonly authorName: string;
  readonly content: string;
}

export interface ConversationContextInput {
  readonly scope: GuildScope;
  readonly resolution: ConversationResolution;
  readonly quoted?: QuotedMessage | undefined;
  readonly botDisplayName: string;
  /** The just-written current user turn: stored, but never history. */
  readonly excludeTurnId?: string | undefined;
  readonly now: number;
}

export interface ConversationContext {
  readonly history: GenerationMessage[];
  readonly quoteEnvelope?: string;
  /** Distinct human speakers across the history and the quote. */
  readonly participants: number;
  /** True when the replayed history includes a quote turn. */
  readonly quoteInHistory: boolean;
}

/** A quoted message as untrusted evidence inside the user turn. */
export const quoteEnvelopeFor = (quoted: QuotedMessage): string =>
  `[UNTRUSTED QUOTED MESSAGE author=${JSON.stringify(safeDisplayName(quoted.authorName) ?? 'a member')}]\n${neutraliseMarkers(quoted.content)}\n[/UNTRUSTED QUOTED MESSAGE]`;

/** ADR 0085: every earlier user turn reads `[Name, 3 min ago] …`. */
export const labelUserTurn = (
  turn: { readonly authorName: string; readonly at: number; readonly text: string },
  now: number,
): string => {
  const cleaned = safeDisplayName(turn.authorName);
  // Turns stored before display names existed hold the bare user id: never
  // print it as a speaker name.
  const speaker = cleaned === undefined || /^\d{17,20}$/.test(cleaned) ? 'a member' : cleaned;
  return `[${speaker}, ${relativeAgo(turn.at, now)}] ${neutraliseMarkers(turn.text)}`;
};

export const buildConversationContext = (input: ConversationContextInput): ConversationContext => {
  const conversationId =
    input.resolution.kind === 'continue' ? input.resolution.conversationId : undefined;
  const stored =
    conversationId === undefined
      ? []
      : conversationRepo.recentTurns(input.scope, conversationId, {
          maxTurns: HISTORY_TURNS,
          maxChars: HISTORY_CHARS,
        });
  // The just-written user turn is stored (hard rule 6) but excluded from the
  // history the model sees — the question travels as the request's user text.
  const turns =
    input.excludeTurnId === undefined
      ? stored
      : stored.filter((turn) => turn.turnId !== input.excludeTurnId);

  // The bot is the assistant, never a participant: a turn mislabelled with
  // its name must not mint a phantom second speaker and switch prefixes on.
  // Counted over every stored turn including the excluded current one, so a
  // reply by another member still labels both speakers.
  const names = new Set<string>();
  for (const turn of stored) {
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
    if (turn.role === 'assistant') return { role: 'assistant', text: neutraliseMarkers(turn.text) };
    if (turn.role === 'quote') {
      return {
        role: 'user',
        text: quoteEnvelopeFor({ authorName: turn.authorName, content: turn.text }),
      };
    }
    return {
      role: 'user',
      text: labelUserTurn(turn, input.now),
    };
  });

  return {
    history,
    ...(input.quoted === undefined ? {} : { quoteEnvelope: quoteEnvelopeFor(input.quoted) }),
    participants,
    quoteInHistory: turns.some((turn) => turn.role === 'quote'),
  };
};
