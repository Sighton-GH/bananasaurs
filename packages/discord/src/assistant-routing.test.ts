import { describe, expect, it } from 'vitest';
import type { AssistantBehaviour, MessageEvent } from '@bananasaurs/core';
import { routeAssistantMention } from './assistant-routing.js';

const guildId = '234567890123456789';
const bananaRole = '345678901234567890';
const itRole = '456789012345678901';
const botUserId = '901234567890123456';
const behaviours: AssistantBehaviour[] = [
  {
    id: 'club',
    guildId,
    surface: 'bananasaurs',
    mentionRoleId: bananaRole,
    name: 'Club assistant',
    systemPrompt: 'club',
    promptVersion: 1,
    allowedSkillIds: ['club-search'],
    reviewerRoleIds: [],
    callerRoleIds: ['333333333333333333'],
    resourceIds: [],
    enabled: true,
  },
  {
    id: 'it',
    guildId,
    surface: 'it-services',
    mentionRoleId: itRole,
    name: 'IT services',
    systemPrompt: 'it',
    promptVersion: 1,
    allowedSkillIds: ['reviewed-links'],
    reviewerRoleIds: [],
    callerRoleIds: ['333333333333333333'],
    resourceIds: [],
    enabled: true,
  },
  {
    id: 'direct',
    guildId,
    surface: 'direct-command',
    name: 'Direct commands',
    systemPrompt: 'direct',
    promptVersion: 1,
    allowedSkillIds: ['club-search'],
    reviewerRoleIds: [],
    callerRoleIds: ['333333333333333333'],
    resourceIds: [],
    enabled: true,
  },
];
const event = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  kind: 'messageCreate',
  parentChannelId: undefined,
  categoryId: undefined,
  isPrivateThread: false,
  guildId,
  receivedAtMs: 1,
  channelId: '567890123456789012',
  messageId: '678901234567890123',
  authorId: '789012345678901234',
  authorIsBot: false,
  content: `<@&${bananaRole}> where is the handbook?`,
  editedTimestampMs: undefined,
  mentionedUserIds: [],
  authorRoleIds: ['333333333333333333'],
  mentionedRoleIds: [bananaRole],
  mentionsEveryone: false,
  attachments: [],
  ...over,
});

describe('routeAssistantMention', () => {
  it('selects the behaviour attached to the one mentioned role and strips the tag', () => {
    expect(routeAssistantMention(event(), behaviours, botUserId)).toMatchObject({
      kind: 'routed',
      behaviour: { id: 'club' },
      prompt: 'where is the handbook?',
    });
  });

  it('fails closed when both assistant tags are present', () => {
    expect(
      routeAssistantMention(
        event({
          content: `<@&${bananaRole}> <@&${itRole}> reset my access`,
          authorRoleIds: ['333333333333333333'],
          mentionedRoleIds: [bananaRole, itRole],
        }),
        behaviours,
        botUserId,
      ),
    ).toEqual({
      kind: 'ambiguous',
      message: 'Please tag either @bananasaurs or @it-services, not both.',
    });
  });

  it('routes a role tag from a member outside Who can ask so the service can refuse visibly (ADR 0064)', () => {
    expect(
      routeAssistantMention(event({ authorRoleIds: [] }), behaviours, botUserId),
    ).toMatchObject({ kind: 'routed', behaviour: { id: 'club' } });
  });

  it('ignores bot messages and unrelated role mentions', () => {
    expect(routeAssistantMention(event({ authorIsBot: true }), behaviours, botUserId)).toEqual({
      kind: 'not-addressed',
    });
    expect(
      routeAssistantMention(
        event({ authorRoleIds: [], mentionedRoleIds: ['890123456789012345'] }),
        behaviours,
        botUserId,
      ),
    ).toEqual({ kind: 'not-addressed' });
  });

  describe('a tag of the bot user itself (ADR 0063)', () => {
    const botMention = (content: string, over: Partial<MessageEvent> = {}): MessageEvent =>
      event({ content, mentionedRoleIds: [], mentionedUserIds: [botUserId], ...over });
    // The all-round club assistant answers the bot tag; /ask stays on 'direct'.
    const flagged = behaviours.map((b) => (b.id === 'club' ? { ...b, answersBotTag: true } : b));

    it('routes to the flagged behaviour and strips the tag', () => {
      expect(
        routeAssistantMention(
          botMention(`<@${botUserId}> where is the handbook?`),
          flagged,
          botUserId,
        ),
      ).toMatchObject({
        kind: 'routed',
        behaviour: { id: 'club' },
        prompt: 'where is the handbook?',
      });
    });

    it('strips the legacy nickname form of the tag too', () => {
      expect(
        routeAssistantMention(
          botMention(`hey <@!${botUserId}> when is the meeting`),
          flagged,
          botUserId,
        ),
      ).toMatchObject({ kind: 'routed', prompt: 'hey when is the meeting' });
    });

    it('lets a mapped role tag win over the bot user tag', () => {
      expect(
        routeAssistantMention(
          event({
            content: `<@${botUserId}> <@&${itRole}> reset my access`,
            mentionedUserIds: [botUserId],
            mentionedRoleIds: [itRole],
          }),
          flagged,
          botUserId,
        ),
      ).toMatchObject({ kind: 'routed', behaviour: { id: 'it' }, prompt: 'reset my access' });
    });

    it('leaves the caller-role check to the service, as /ask does', () => {
      expect(
        routeAssistantMention(
          botMention(`<@${botUserId}> hi there`, { authorRoleIds: [] }),
          flagged,
          botUserId,
        ),
      ).toMatchObject({ kind: 'routed', behaviour: { id: 'club' } });
    });

    it('refuses an empty question', () => {
      expect(routeAssistantMention(botMention(`<@${botUserId}>`), flagged, botUserId)).toEqual({
        kind: 'ambiguous',
        message: 'Add a question after the assistant tag.',
      });
    });

    it('is not addressed when the flagged behaviour is disabled', () => {
      const disabled = flagged.map((b) => (b.id === 'club' ? { ...b, enabled: false } : b));
      expect(
        routeAssistantMention(botMention(`<@${botUserId}> hi there`), disabled, botUserId),
      ).toEqual({ kind: 'not-addressed' });
    });

    it('is not addressed when no behaviour is flagged', () => {
      expect(
        routeAssistantMention(botMention(`<@${botUserId}> hi there`), behaviours, botUserId),
      ).toEqual({ kind: 'not-addressed' });
    });

    it('can route to a flagged direct-command behaviour', () => {
      const direct = behaviours.map((b) => (b.id === 'direct' ? { ...b, answersBotTag: true } : b));
      expect(
        routeAssistantMention(botMention(`<@${botUserId}> hi there`), direct, botUserId),
      ).toMatchObject({ kind: 'routed', behaviour: { id: 'direct' }, prompt: 'hi there' });
    });

    it('ignores a mention of some other user', () => {
      expect(
        routeAssistantMention(
          botMention('<@111111111111111111> hi', { mentionedUserIds: ['111111111111111111'] }),
          flagged,
          botUserId,
        ),
      ).toEqual({ kind: 'not-addressed' });
    });
  });

  describe('an untagged Discord Reply to a known bot answer (ADR 0072)', () => {
    const untaggedReply = (over: Partial<MessageEvent> = {}): MessageEvent =>
      event({
        content: 'and what about parking?',
        mentionedRoleIds: [],
        mentionedUserIds: [],
        referencedMessageId: '567890123456789099',
        referencedAuthorId: botUserId,
        ...over,
      });

    it("routes to the conversation's own behaviour", () => {
      const lookupMessage = (id: string) =>
        id === '567890123456789099'
          ? {
              conversationId: 'conv-1',
              role: 'assistant' as const,
              channelId: event().channelId,
              behaviourId: 'club',
            }
          : undefined;
      expect(
        routeAssistantMention(untaggedReply(), behaviours, botUserId, lookupMessage),
      ).toMatchObject({
        kind: 'routed',
        behaviour: { id: 'club' },
        prompt: 'and what about parking?',
      });
    });

    it('is not addressed when the replied-to message is unknown', () => {
      const lookupMessage = () => undefined;
      expect(routeAssistantMention(untaggedReply(), behaviours, botUserId, lookupMessage)).toEqual({
        kind: 'not-addressed',
      });
    });

    it('is not addressed when no lookupMessage was given at all', () => {
      expect(routeAssistantMention(untaggedReply(), behaviours, botUserId)).toEqual({
        kind: 'not-addressed',
      });
    });

    it('is not addressed when the conversation belongs to a disabled behaviour', () => {
      const disabled = behaviours.map((b) => (b.id === 'club' ? { ...b, enabled: false } : b));
      const lookupMessage = () => ({
        conversationId: 'conv-1',
        role: 'assistant' as const,
        channelId: event().channelId,
        behaviourId: 'club',
      });
      expect(routeAssistantMention(untaggedReply(), disabled, botUserId, lookupMessage)).toEqual({
        kind: 'not-addressed',
      });
    });

    it('is not addressed when the reply targets a different channel', () => {
      const lookupMessage = () => ({
        conversationId: 'conv-1',
        role: 'assistant' as const,
        channelId: '999999999999999999',
        behaviourId: 'club',
      });
      expect(routeAssistantMention(untaggedReply(), behaviours, botUserId, lookupMessage)).toEqual({
        kind: 'not-addressed',
      });
    });

    it('is not addressed when the known message is a user turn, not an assistant one', () => {
      const lookupMessage = () => ({
        conversationId: 'conv-1',
        role: 'user' as const,
        channelId: event().channelId,
        behaviourId: 'club',
      });
      expect(routeAssistantMention(untaggedReply(), behaviours, botUserId, lookupMessage)).toEqual({
        kind: 'not-addressed',
      });
    });

    it('still requires a tag when the reply is to someone other than the bot', () => {
      const lookupMessage = () => ({
        conversationId: 'conv-1',
        role: 'assistant' as const,
        channelId: event().channelId,
        behaviourId: 'club',
      });
      expect(
        routeAssistantMention(
          untaggedReply({ referencedAuthorId: '890123456789012345' }),
          behaviours,
          botUserId,
          lookupMessage,
        ),
      ).toEqual({ kind: 'not-addressed' });
    });
  });
});
