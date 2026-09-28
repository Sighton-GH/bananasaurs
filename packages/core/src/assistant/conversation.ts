/**
 * Which conversation a Discord message belongs to (ADR 0072, spec D3).
 *
 * Pure and deterministic: every input the resolver needs is passed in, and
 * `lookupMessage`/`latestForAuthor` are plain functions rather than a
 * database handle, so the whole rule set is testable without storage. The
 * storage-backed implementations of those two functions live in
 * `packages/storage/src/repos/conversations.ts`.
 */

/** A follow-up within this window continues the author's latest open conversation. */
export const FOLLOW_UP_WINDOW_MS = 30 * 60_000;
export const CHANNEL_FOLLOW_UP_WINDOW_MS = 10 * 60_000;
export const SAME_CHANNEL_LINK_WINDOW_MS = 30 * 60_000;

/**
 * A member typed "new topic:" or "new question:" to force a fresh conversation.
 *
 * Matches a leading "new topic"/"new question" prefix, one optional punctuation mark, then whitespace.
 */
export const NEW_TOPIC = /^\s*new (topic|question)\b[:,.!-]?\s*/i;

/**
 * What a message id resolves to, once it has been linked to a conversation.
 *
 * `role` is only ever `'user'` or `'assistant'` — a quoted message that
 * started a new conversation is recorded as opening context (a `quote` turn)
 * but is never itself linked as a known message, so it can never make this
 * type. See `packages/storage/src/repos/conversations.ts`'s `lookupMessage`.
 */
export interface KnownMessage {
  readonly conversationId: string;
  readonly role: 'user' | 'assistant';
  readonly channelId: string;
  readonly behaviourId: string;
}

export const CONTINUE_RULES = [
  'reply-to-bot',
  'reply-to-turn',
  'follow-up',
  'thread',
  'channel-follow-up',
] as const;
export const NEW_RULES = [
  'quoted-reply',
  'reply-to-unknown-bot-message',
  'new-topic',
  'fresh',
] as const;
export const JOIN_RULES = [...CONTINUE_RULES, ...NEW_RULES] as const;
export type ContinueRule = (typeof CONTINUE_RULES)[number];
export type NewRule = (typeof NEW_RULES)[number];
export type JoinRule = ContinueRule | NewRule;

export type ConversationResolution =
  | {
      readonly kind: 'continue';
      readonly conversationId: string;
      readonly rule: ContinueRule;
    }
  | {
      readonly kind: 'new';
      readonly rule: NewRule;
      readonly quotedMessageId?: string;
    };

/**
 * Resolves which conversation a message belongs to, in the rule order spec D3
 * fixes:
 *
 * 1. A "new topic"/"new question" prefix always starts a fresh conversation,
 *    even mid follow-up window.
 * 2. A reply to a message we know about, in the *same* channel, continues
 *    that conversation — `reply-to-bot` when the known message was ours,
 *    `reply-to-turn` otherwise.
 * 3. A reply to a message we know about in a *different* channel is not a
 *    valid continuation (Discord conversations do not span channels), so the
 *    reference is ignored entirely and resolution falls through to 6/7 as if
 *    there had been no reply.
 * 4. A reply to a message we do *not* know about, whose author Discord says
 *    is this bot, starts a new conversation seeded with that quoted content
 *    — we cannot know which conversation it belonged to (if any), so a fresh
 *    one is the only correct answer.
 * 5. A reply to a message we do not know about, from anyone else, also
 *    starts a new conversation seeded with the quote.
 * 6. In a thread, the latest conversation in that channel with a bot reply
 *    continues it, regardless of author or age.
 * 7. Otherwise, the author's most recent open conversation in this channel
 *    continues it if it is still within the follow-up window.
 * 8. Otherwise, the only conversation in this channel with a bot reply in the
 *    channel follow-up window continues it; zero or multiple candidates fall
 *    through to a fresh conversation.
 * 9. Otherwise, a fresh conversation.
 *
 * Rule 3 depends on knowing the referenced message's channel, which is only
 * possible when it is a *known* message (`KnownMessage.channelId` comes from
 * the conversation it belongs to). An unknown referenced message carries no
 * channel of its own in `MessageEvent`, so cross-channel detection cannot
 * apply to it — rules 4/5 run regardless of which channel it was really
 * posted in.
 */
export const resolveConversation = (input: {
  readonly now: number;
  readonly channelId: string;
  readonly authorId: string;
  readonly botUserId: string;
  readonly text: string;
  readonly inThread: boolean;
  readonly referencedMessageId?: string;
  readonly referencedAuthorId?: string;
  readonly lookupMessage: (messageId: string) => KnownMessage | undefined;
  readonly latestForAuthor: (
    authorId: string,
    channelId: string,
  ) => { conversationId: string; lastActivityAt: number } | undefined;
  readonly latestWithBotReply: (channelId: string) => { conversationId: string } | undefined;
  readonly withBotReplySince: (channelId: string, sinceMs: number) => readonly string[];
  readonly followUpWindowMs?: number;
  readonly channelFollowUpWindowMs?: number;
}): ConversationResolution => {
  if (NEW_TOPIC.test(input.text)) {
    return { kind: 'new', rule: 'new-topic' };
  }

  if (input.referencedMessageId !== undefined) {
    const known = input.lookupMessage(input.referencedMessageId);
    if (known !== undefined) {
      if (known.channelId === input.channelId) {
        return {
          kind: 'continue',
          conversationId: known.conversationId,
          rule: known.role === 'assistant' ? 'reply-to-bot' : 'reply-to-turn',
        };
      }
      // A known message in another channel: the reference does not name a
      // valid continuation, so it is ignored and resolution falls through.
    } else if (input.referencedAuthorId === input.botUserId) {
      return {
        kind: 'new',
        rule: 'reply-to-unknown-bot-message',
        quotedMessageId: input.referencedMessageId,
      };
    } else {
      return {
        kind: 'new',
        rule: 'quoted-reply',
        quotedMessageId: input.referencedMessageId,
      };
    }
  }

  if (input.inThread) {
    const latestThread = input.latestWithBotReply(input.channelId);
    if (latestThread !== undefined) {
      return { kind: 'continue', conversationId: latestThread.conversationId, rule: 'thread' };
    }
  }

  const windowMs = input.followUpWindowMs ?? FOLLOW_UP_WINDOW_MS;
  const latest = input.latestForAuthor(input.authorId, input.channelId);
  if (latest !== undefined && input.now - latest.lastActivityAt <= windowMs) {
    return { kind: 'continue', conversationId: latest.conversationId, rule: 'follow-up' };
  }

  const channelCandidates = input.withBotReplySince(
    input.channelId,
    input.now - (input.channelFollowUpWindowMs ?? CHANNEL_FOLLOW_UP_WINDOW_MS),
  );
  if (channelCandidates.length === 1) {
    return { kind: 'continue', conversationId: channelCandidates[0]!, rule: 'channel-follow-up' };
  }

  return { kind: 'new', rule: 'fresh' };
};

/** Removes a leading "new topic"/"new question" prefix, leaving the real question. */
export const stripNewTopic = (text: string): string => text.replace(NEW_TOPIC, '');
