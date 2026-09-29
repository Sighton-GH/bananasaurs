import { describe, expect, it } from 'vitest';
import {
  FOLLOW_UP_WINDOW_MS,
  resolveConversation,
  stripNewTopic,
  type KnownMessage,
} from './conversation.js';

const CHANNEL = '111111111111111111';
const OTHER_CHANNEL = '222222222222222222';
const AUTHOR = '333333333333333333';
const BOT = '444444444444444444';
const NOW = 1_700_000_000_000;

const noKnownMessage = (): undefined => undefined;
const noLatest = (): undefined => undefined;
const noBotReply = (): undefined => undefined;
const noBotRepliesSince = (): readonly string[] => [];
const withResolverDefaults = <T extends Record<string, unknown>>(input: T) => ({
  inThread: false,
  latestWithBotReply: noBotReply,
  withBotReplySince: noBotRepliesSince,
  ...input,
});

describe('resolveConversation', () => {
  it('a new-topic prefix always starts a fresh conversation', () => {
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'new topic: how do I join?',
          lookupMessage: noKnownMessage,
          // Even with a recent open conversation, the prefix wins.
          latestForAuthor: () => ({ conversationId: 'conv-old', lastActivityAt: NOW - 1_000 }),
        }),
      ),
    ).toEqual({ kind: 'new', rule: 'new-topic' });
  });

  it('stripNewTopic leaves the real question behind', () => {
    expect(stripNewTopic('new topic: how do I join?')).toBe('how do I join?');
    expect(stripNewTopic('New Question, when is the meeting')).toBe('when is the meeting');
    expect(stripNewTopic('what time is it')).toBe('what time is it');
  });

  it('a reply to a known assistant message in the same channel continues via reply-to-bot', () => {
    const known: KnownMessage = {
      conversationId: 'conv-1',
      role: 'assistant',
      channelId: CHANNEL,
      behaviourId: 'club',
    };
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'and what about parking?',
          inThread: false,
          referencedMessageId: 'msg-1',
          referencedAuthorId: BOT,
          lookupMessage: (id) => (id === 'msg-1' ? known : undefined),
          latestForAuthor: noLatest,
          latestWithBotReply: noBotReply,
          withBotReplySince: noBotRepliesSince,
        }),
      ),
    ).toEqual({ kind: 'continue', conversationId: 'conv-1', rule: 'reply-to-bot' });
  });

  it('a reply to a known user (or quote) turn in the same channel continues via reply-to-turn', () => {
    const known: KnownMessage = {
      conversationId: 'conv-2',
      role: 'user',
      channelId: CHANNEL,
      behaviourId: 'club',
    };
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'actually I meant the second one',
          inThread: false,
          referencedMessageId: 'msg-2',
          lookupMessage: (id) => (id === 'msg-2' ? known : undefined),
          latestForAuthor: noLatest,
          latestWithBotReply: noBotReply,
          withBotReplySince: noBotRepliesSince,
        }),
      ),
    ).toEqual({ kind: 'continue', conversationId: 'conv-2', rule: 'reply-to-turn' });
  });

  it('a reply to a known message in another channel falls through to follow-up', () => {
    const known: KnownMessage = {
      conversationId: 'conv-3',
      role: 'assistant',
      channelId: OTHER_CHANNEL,
      behaviourId: 'club',
    };
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'ignored reference',
          inThread: false,
          referencedMessageId: 'msg-3',
          lookupMessage: (id) => (id === 'msg-3' ? known : undefined),
          latestForAuthor: () => ({ conversationId: 'conv-active', lastActivityAt: NOW - 1_000 }),
          latestWithBotReply: noBotReply,
          withBotReplySince: noBotRepliesSince,
        }),
      ),
    ).toEqual({ kind: 'continue', conversationId: 'conv-active', rule: 'follow-up' });
  });

  it('a reply to a known message in another channel falls through to fresh when there is no recent conversation', () => {
    const known: KnownMessage = {
      conversationId: 'conv-3',
      role: 'assistant',
      channelId: OTHER_CHANNEL,
      behaviourId: 'club',
    };
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'ignored reference',
          inThread: false,
          referencedMessageId: 'msg-3',
          lookupMessage: (id) => (id === 'msg-3' ? known : undefined),
          latestForAuthor: noLatest,
          latestWithBotReply: noBotReply,
          withBotReplySince: noBotRepliesSince,
        }),
      ),
    ).toEqual({ kind: 'new', rule: 'fresh' });
  });

  // Review Focus 1.
  it('a reply to an unknown bot message starts a quoted conversation', () => {
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'what did you mean by that?',
          referencedMessageId: 'msg-4',
          referencedAuthorId: BOT,
          lookupMessage: noKnownMessage,
          latestForAuthor: noLatest,
        }),
      ),
    ).toEqual({ kind: 'new', rule: 'reply-to-unknown-bot-message', quotedMessageId: 'msg-4' });
  });

  it('a reply to an unknown message from another member starts a quoted conversation', () => {
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'is this true?',
          referencedMessageId: 'msg-5',
          referencedAuthorId: '555555555555555555',
          lookupMessage: noKnownMessage,
          latestForAuthor: noLatest,
        }),
      ),
    ).toEqual({ kind: 'new', rule: 'quoted-reply', quotedMessageId: 'msg-5' });
  });

  it('continues the latest open conversation for this author in this channel inside the follow-up window', () => {
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'one more thing',
          lookupMessage: noKnownMessage,
          latestForAuthor: () => ({
            conversationId: 'conv-6',
            lastActivityAt: NOW - FOLLOW_UP_WINDOW_MS,
          }),
        }),
      ),
    ).toEqual({ kind: 'continue', conversationId: 'conv-6', rule: 'follow-up' });
  });

  it('is fresh exactly one millisecond past the follow-up window', () => {
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'one more thing',
          lookupMessage: noKnownMessage,
          latestForAuthor: () => ({
            conversationId: 'conv-6',
            lastActivityAt: NOW - FOLLOW_UP_WINDOW_MS - 1,
          }),
        }),
      ),
    ).toEqual({ kind: 'new', rule: 'fresh' });
  });

  it('is fresh with no reference and no recent conversation', () => {
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'hello there',
          lookupMessage: noKnownMessage,
          latestForAuthor: noLatest,
        }),
      ),
    ).toEqual({ kind: 'new', rule: 'fresh' });
  });

  it('joins a thread conversation for a new member regardless of age', () => {
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'hello',
          inThread: true,
          lookupMessage: noKnownMessage,
          latestForAuthor: noLatest,
          latestWithBotReply: () => ({ conversationId: 'thread-conv' }),
        }),
      ),
    ).toEqual({ kind: 'continue', conversationId: 'thread-conv', rule: 'thread' });
  });

  it('falls through when a thread has no bot reply', () => {
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'hello',
          inThread: true,
          lookupMessage: noKnownMessage,
          latestForAuthor: noLatest,
        }),
      ),
    ).toEqual({ kind: 'new', rule: 'fresh' });
  });

  it('prefers a known reply over the thread rule', () => {
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'hello',
          inThread: true,
          referencedMessageId: 'msg',
          lookupMessage: () => ({
            conversationId: 'reply-conv',
            role: 'user',
            channelId: CHANNEL,
            behaviourId: 'club',
          }),
          latestForAuthor: noLatest,
          latestWithBotReply: () => ({ conversationId: 'thread-conv' }),
        }),
      ),
    ).toEqual({ kind: 'continue', conversationId: 'reply-conv', rule: 'reply-to-turn' });
  });

  it('prefers a new topic over a thread', () => {
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'new topic: hello',
          inThread: true,
          lookupMessage: noKnownMessage,
          latestForAuthor: noLatest,
          latestWithBotReply: () => ({ conversationId: 'thread-conv' }),
        }),
      ),
    ).toEqual({ kind: 'new', rule: 'new-topic' });
  });

  it('joins the only recent channel conversation with a bot reply', () => {
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'hello',
          inThread: false,
          lookupMessage: noKnownMessage,
          latestForAuthor: noLatest,
          latestWithBotReply: noBotReply,
          withBotReplySince: (channel, since) => {
            expect(channel).toBe(CHANNEL);
            expect(since).toBe(NOW - 10 * 60_000);
            return ['channel-conv'];
          },
        }),
      ),
    ).toEqual({ kind: 'continue', conversationId: 'channel-conv', rule: 'channel-follow-up' });
  });

  it('starts fresh with multiple recent channel conversations', () => {
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'hello',
          lookupMessage: noKnownMessage,
          latestForAuthor: noLatest,
          withBotReplySince: () => ['first', 'second'],
        }),
      ),
    ).toEqual({ kind: 'new', rule: 'fresh' });
  });

  it('starts fresh when the channel reply is older than ten minutes', () => {
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'hello',
          inThread: false,
          lookupMessage: noKnownMessage,
          latestForAuthor: noLatest,
          latestWithBotReply: noBotReply,
          withBotReplySince: (_channel, since) => (NOW - 10 * 60_000 - 1 >= since ? ['old'] : []),
        }),
      ),
    ).toEqual({ kind: 'new', rule: 'fresh' });
  });

  it('prefers the author follow-up over the channel rule', () => {
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'hello',
          lookupMessage: noKnownMessage,
          latestForAuthor: () => ({
            conversationId: 'author-conv',
            lastActivityAt: NOW - FOLLOW_UP_WINDOW_MS,
          }),
          withBotReplySince: () => ['channel-conv'],
        }),
      ),
    ).toEqual({ kind: 'continue', conversationId: 'author-conv', rule: 'follow-up' });
  });

  it('honours a custom follow-up window', () => {
    expect(
      resolveConversation(
        withResolverDefaults({
          now: NOW,
          channelId: CHANNEL,
          authorId: AUTHOR,
          botUserId: BOT,
          text: 'ping',
          lookupMessage: noKnownMessage,
          latestForAuthor: () => ({ conversationId: 'conv-7', lastActivityAt: NOW - 5_000 }),
          followUpWindowMs: 1_000,
        }),
      ),
    ).toEqual({ kind: 'new', rule: 'fresh' });
  });
});
