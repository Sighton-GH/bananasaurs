import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type {
  AssistantBehaviour,
  AssistantInvokePayload,
  ChannelAccess,
  DomainEvent,
  KnownMessage,
  MessageEvent,
  ReactionEvent,
} from '@bananasaurs/core';
import { ProviderError, RetryAfterError } from '@bananasaurs/core';
import { cardTexts, type OutgoingMessage } from '@bananasaurs/core';
import {
  createAssistantCommandSubscriber,
  type AssistantCommandService,
  type AssistantInvocationResult,
} from './commands.js';
import { assistantInvokeHandler } from '../jobs/assistant.js';
import { createInteractionTokenSealer } from './interaction-token.js';
import { PROVIDER_FAILURE_LOG_REASON } from './provider-failure.js';
import { FakeDiscord } from '@bananasaurs/testkit';

const guildId = '234567890123456789';
const channelId = '345678901234567890';
const userId = '456789012345678901';
const direct: AssistantBehaviour = {
  id: 'direct',
  guildId,
  surface: 'direct-command',
  name: 'Direct',
  reviewerRoleIds: [],
  callerRoleIds: [],
  systemPrompt: 'direct',
  promptVersion: 1,
  preferredSkillIds: ['club-search', 'reminder-create'],
  resourceIds: [],
  enabled: true,
};
const club: AssistantBehaviour = {
  id: 'club',
  guildId,
  surface: 'bananasaurs',
  mentionRoleId: '567890123456789012',
  name: 'Club',
  reviewerRoleIds: [],
  callerRoleIds: [],
  systemPrompt: 'club',
  promptVersion: 1,
  preferredSkillIds: ['club-search'],
  resourceIds: [],
  enabled: true,
};

/**
 * The B2 split under test: the subscriber does cheap routing inline and
 * enqueues; the job handler does the invoke and answers. `flush()` drains
 * the captured queue through the real handler, so these tests exercise the
 * whole path a production event travels.
 */
const harness = (
  behaviours: readonly AssistantBehaviour[] = [direct, club],
  lookupMessage?: (messageId: string) => KnownMessage | undefined,
  reportEnqueued = true,
  isTaskPost?: (messageId: string) => boolean,
  channelAccess?: Pick<ChannelAccess, 'check'>,
  botRoleId?: () => string | undefined,
  recordQueued?: (run: {
    readonly runId: string;
    readonly userId: string;
    readonly channelId: string;
    readonly behaviourId: string;
    readonly via: 'mention' | 'reply';
  }) => void,
) => {
  const invoke = vi.fn<AssistantCommandService['invoke']>(
    async (): Promise<AssistantInvocationResult> => ({
      ok: true,
      content: 'Grounded answer.',
    }),
  );
  const service: AssistantCommandService = {
    behavioursForGuild: vi.fn(async () => behaviours),
    invoke,
  };
  const respond = vi.fn(async () => undefined);
  const send = vi.fn(async () => undefined);
  const sendTyping = vi.fn(async () => undefined);
  const queued: AssistantInvokePayload[] = [];
  const enqueuedInputs: { readonly orderingKey: string }[] = [];
  const sealer = createInteractionTokenSealer();
  const handler = assistantInvokeHandler({
    guildId,
    service,
    openToken: (token) => sealer.open(token),
    respond,
    send,
    sendTyping,
    logger: pino({ level: 'silent' }),
    logChannelId: () => undefined,
    now: () => 1,
  });
  const flush = async (): Promise<void> => {
    for (const payload of queued.splice(0)) {
      await handler.run(handler.payload.parse(payload), {
        jobId: 1,
        attempts: 1,
        cursor: null,
        saveCursor: () => undefined,
      });
    }
  };
  return {
    invoke,
    respond,
    send,
    sendTyping,
    queued,
    enqueuedInputs,
    flush,
    subscriber: createAssistantCommandSubscriber({
      botUserId: '901234567890123456',
      guildId,
      service,
      enqueue: (input) => {
        queued.push(input.payload);
        enqueuedInputs.push(input);
        return { enqueued: reportEnqueued };
      },
      now: () => 1,
      logger: pino({ level: 'silent' }),
      sendTyping,
      ...(lookupMessage === undefined ? {} : { lookupMessage }),
      ...(isTaskPost === undefined ? {} : { isTaskPost }),
      ...(channelAccess === undefined ? {} : { channelAccess }),
      ...(botRoleId === undefined ? {} : { botRoleId }),
      ...(recordQueued === undefined ? {} : { recordQueued }),
    }),
  };
};

describe('assistant command subscriber', () => {
  it('enqueues nothing for an untagged task-keyword message', async () => {
    const h = harness([direct, { ...club, answersBotTag: true }]);
    await h.subscriber.handle({
      kind: 'messageCreate',
      guildId,
      receivedAtMs: 1,
      channelId,
      parentChannelId: undefined,
      categoryId: '333333333333333333',
      isPrivateThread: false,
      messageId: '890123456789012345',
      authorId: userId,
      authorIsBot: false,
      authorDisplayName: undefined,
      content: 'Task update: blocked',
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      mentionedRoleIds: [],
      authorRoleIds: [],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(h.queued).toHaveLength(0);
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it.each(['ask', 'remind'])('ignores the removed /%s command', async (name) => {
    const h = harness();
    const event: DomainEvent = {
      kind: 'slashCommand',
      guildId,
      receivedAtMs: 1,
      interactionId: '678901234567890123',
      token: 'secret',
      commandName: name,
      subcommandPath: [],
      options: [],
      channelId,
      userId,
    };
    await h.subscriber.handle(event);
    expect(h.queued).toHaveLength(0);
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it('sets messageId and reply references for mentions', async () => {
    const h = harness();
    await h.subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012345',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId}> where is the handbook?`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [club.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
      referencedMessageId: '890123456789012399',
      referencedAuthorId: '901234567890123456',
    });
    expect(h.queued[0]).toMatchObject({
      invocationId: '890123456789012345',
      messageId: '890123456789012345',
      referencedMessageId: '890123456789012399',
      referencedAuthorId: '901234567890123456',
    });
  });

  it('carries the asker’s mentions into the payload, capped at 50', async () => {
    const h = harness();
    const users = Array.from({ length: 60 }, (_, i) => `7${String(i).padStart(17, '0')}`);
    await h.subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012349',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId}> ping them`,
      editedTimestampMs: undefined,
      mentionedUserIds: users,
      authorRoleIds: [],
      mentionedRoleIds: [club.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    const payload = h.queued[0] as { mentionedUserIds?: string[]; mentionedRoleIds?: string[] };
    expect(payload.mentionedUserIds).toEqual(users.slice(0, 50));
    expect(payload.mentionedRoleIds).toEqual([club.mentionRoleId]);
  });

  it('marks the payload when the asker message has an attachment', async () => {
    const h = harness();
    await h.subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012350',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId}> see attached`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [club.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [{ fileName: 'photo.png', contentType: 'image/png', sizeBytes: 10 }],
    });
    expect(h.queued[0]).toMatchObject({ hasAttachments: true });
  });

  it('carries the thread parent only for a thread mention', async () => {
    const h = harness();
    await h.subscriber.handle({
      kind: 'messageCreate',
      guildId,
      receivedAtMs: 1,
      channelId,
      parentChannelId: '678901234567890123',
      categoryId: undefined,
      isPrivateThread: false,
      messageId: '890123456789012346',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId}> thread question`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [club.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(h.queued[0]?.threadParentId).toBe('678901234567890123');
  });

  it('enqueues a channel mention with the channel ordering key', async () => {
    const h = harness();
    await h.subscriber.handle({
      kind: 'messageCreate',
      guildId,
      receivedAtMs: 1,
      channelId,
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      messageId: '890123456789012347',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId}> channel question`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [club.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(h.enqueuedInputs[0]?.orderingKey).toBe(`chan:${channelId}`);
  });

  it('enqueues a thread mention with the parent-channel ordering key', async () => {
    const h = harness();
    await h.subscriber.handle({
      kind: 'messageCreate',
      guildId,
      receivedAtMs: 1,
      channelId: '789012345678901234',
      parentChannelId: '678901234567890123',
      categoryId: undefined,
      isPrivateThread: true,
      messageId: '890123456789012348',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId}> thread question`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [club.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(h.enqueuedInputs[0]?.orderingKey).toBe('chan:678901234567890123');
  });

  it('posts one safe IT escalation to the configured channel and reviewer roles', async () => {
    const h = harness([{ ...club, surface: 'it-services', callerRoleIds: ['987654321098765432'] }]);
    h.invoke.mockResolvedValueOnce({
      ok: true as const,
      content: 'Reset the lab account permission.',
      escalation: {
        channelId: '987654321098765430',
        reviewerRoleIds: ['987654321098765431'],
        ticketId: 'it-1',
      },
    });
    await h.subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012345',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId}> reset it`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: ['987654321098765432'],
      mentionedRoleIds: [club.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    await h.flush();
    expect(h.send).toHaveBeenLastCalledWith(
      '987654321098765430',
      expect.objectContaining({
        flags: 32768,
        allowedMentions: { parse: [], roles: ['987654321098765431'] },
      }),
    );
    const escalation = (h.send.mock.lastCall as unknown as [string, OutgoingMessage])[1];
    expect(cardTexts(escalation.components ?? [])).toContain('IT request it-1');
  });

  it('routes a tag of the bot user through the queue to the flagged behaviour', async () => {
    const h = harness([direct, { ...club, answersBotTag: true }]);
    await h.subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012346',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: '<@901234567890123456> when is the meeting?',
      editedTimestampMs: undefined,
      mentionedUserIds: ['901234567890123456'],
      authorRoleIds: [],
      mentionedRoleIds: [],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(h.queued).toEqual([
      expect.objectContaining({
        behaviourId: 'club',
        command: 'ask',
        input: { question: 'when is the meeting?' },
        source: 'mention',
      }),
    ]);
  });

  it('carries the member display name into the mention payload as authorName', async () => {
    const h = harness();
    await h.subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012347',
      authorId: userId,
      authorDisplayName: 'Ama',
      authorIsBot: false,
      content: `<@&${club.mentionRoleId}> where is the handbook?`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [club.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(h.queued[0]).toMatchObject({ authorName: 'Ama' });
  });

  it('carries the fake display name into the mention payload as authorName', async () => {
    const h = harness();
    const discord = new FakeDiscord({ guildId });
    discord.onEvent((event) => h.subscriber.handle(event));
    await discord.emitMessageCreate({
      channelId,
      messageId: '890123456789012351',
      authorId: userId,
      authorDisplayName: 'Ama',
      content: `<@&${club.mentionRoleId}> where is the handbook?`,
      mentionedRoleIds: [club.mentionRoleId!],
    });
    expect(h.queued[0]).toMatchObject({ authorName: 'Ama' });
  });

  it('starts typing after an addressed mention is queued', async () => {
    const h = harness();
    await h.subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012346',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId}> where is the handbook?`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [club.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(h.queued).toHaveLength(1);
    expect(h.sendTyping).toHaveBeenCalledWith(channelId);
  });

  it('starts typing once when the mention queues a new job', async () => {
    const h = harness([direct, club], undefined, true);
    await h.subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012348',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId}> where is the handbook?`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [club.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(h.queued).toHaveLength(1);
    expect(h.sendTyping).toHaveBeenCalledTimes(1);
  });

  it('does not start typing when the mention was already queued', async () => {
    const h = harness([direct, club], undefined, false);
    await h.subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012349',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId}> where is the handbook?`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [club.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(h.queued).toHaveLength(1);
    expect(h.sendTyping).not.toHaveBeenCalled();
  });

  it('does not start typing for an unaddressed or ambiguous mention', async () => {
    const h = harness();
    await h.subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012348',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: 'hello',
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(h.sendTyping).not.toHaveBeenCalled();

    const itBehaviour: AssistantBehaviour = {
      ...club,
      id: 'it',
      mentionRoleId: '789012345678901234',
    };
    const ambiguous = harness([direct, club, itBehaviour]);
    await ambiguous.subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012349',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId}> <@&${itBehaviour.mentionRoleId}> help`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [club.mentionRoleId!, itBehaviour.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(ambiguous.sendTyping).not.toHaveBeenCalled();
  });

  it('does not delay or fail the mention when typing rejects', async () => {
    const h = harness();
    h.sendTyping.mockRejectedValueOnce(new Error('typing failed'));
    await expect(
      h.subscriber.handle({
        kind: 'messageCreate',
        parentChannelId: undefined,
        categoryId: undefined,
        isPrivateThread: false,
        guildId,
        receivedAtMs: 1,
        channelId,
        messageId: '890123456789012350',
        authorId: userId,
        authorDisplayName: undefined,
        authorIsBot: false,
        content: `<@&${club.mentionRoleId}> where is the handbook?`,
        editedTimestampMs: undefined,
        mentionedUserIds: [],
        authorRoleIds: [],
        mentionedRoleIds: [club.mentionRoleId!],
        mentionsEveryone: false,
        attachments: [],
      }),
    ).resolves.toBeUndefined();
    expect(h.queued).toHaveLength(1);
  });

  it('routes an untagged Discord Reply to a known bot answer, via lookupMessage (ADR 0072)', async () => {
    const repliedTo = '890123456789012399';
    const lookupMessage = (id: string): KnownMessage | undefined =>
      id === repliedTo
        ? { conversationId: 'conv-1', role: 'assistant', channelId, behaviourId: 'club' }
        : undefined;
    const h = harness([direct, club], lookupMessage);
    await h.subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012347',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: 'and what about parking?',
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [],
      mentionsEveryone: false,
      attachments: [],
      referencedMessageId: repliedTo,
      referencedAuthorId: '901234567890123456',
    });
    expect(h.queued).toEqual([
      expect.objectContaining({
        behaviourId: 'club',
        command: 'ask',
        input: { question: 'and what about parking?' },
        source: 'mention',
      }),
    ]);
  });

  it('enqueues nothing for a pinged reply to a task post, unless the text tags the bot (ADR 0112)', async () => {
    const taskPost = '777777777777777777';
    const isTaskPost = (id: string): boolean => id === taskPost;
    const h = harness([direct, { ...club, answersBotTag: true }], undefined, true, isTaskPost);
    const pinged = (content: string) => ({
      kind: 'messageCreate' as const,
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012347',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content,
      editedTimestampMs: undefined,
      mentionedUserIds: ['901234567890123456'],
      authorRoleIds: [],
      mentionedRoleIds: [],
      mentionsEveryone: false,
      attachments: [],
      referencedMessageId: taskPost,
      referencedAuthorId: '901234567890123456',
    });
    await h.subscriber.handle(pinged('finished the left panel'));
    expect(h.queued).toHaveLength(0);
    expect(h.invoke).not.toHaveBeenCalled();
    await h.subscriber.handle(pinged('<@901234567890123456> is this clear?'));
    expect(h.queued).toHaveLength(1);
  });

  it("answers a tag of the bot's integration role like a bot tag (ADR 0125)", async () => {
    const botRole = '912345678901234567';
    const h = harness(
      [direct, { ...club, answersBotTag: true }],
      undefined,
      true,
      undefined,
      undefined,
      () => botRole,
    );
    await h.subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012348',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${botRole}> when is the next meeting?`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [botRole],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(h.queued).toEqual([
      expect.objectContaining({
        behaviourId: 'club',
        input: { question: 'when is the next meeting?' },
        source: 'mention',
      }),
    ]);
  });

  it('fails closed on an ambiguous mention without calling the service', async () => {
    const it: AssistantBehaviour = {
      ...club,
      id: 'it',
      surface: 'it-services',
      mentionRoleId: '789012345678901234',
    };
    const h = harness([direct, club, it]);
    await h.subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012345',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId}> <@&${it.mentionRoleId}> help`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [club.mentionRoleId!, it.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.queued).toHaveLength(0);
    // Hard rule 6: the subscriber has no idempotency key of its own, so it
    // may not post. A gateway replay of the same message must stay silent too.
    expect(h.send).not.toHaveBeenCalled();
    await h.subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 2,
      channelId,
      messageId: '890123456789012345',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId}> <@&${it.mentionRoleId}> help`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [club.mentionRoleId!, it.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('swallows an enqueue failure without posting or throwing', async () => {
    const sendTyping = vi.fn(async () => undefined);
    const subscriber = createAssistantCommandSubscriber({
      botUserId: '901234567890123456',
      guildId,
      service: { behavioursForGuild: vi.fn(async () => [club]), invoke: vi.fn() },
      enqueue: () => {
        throw new Error('disk full');
      },
      now: () => 1,
      logger: pino({ level: 'silent' }),
      sendTyping,
    });
    const handled = subscriber.handle({
      kind: 'messageCreate',
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      guildId,
      receivedAtMs: 1,
      channelId,
      messageId: '890123456789012345',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId!}> where is the handbook?`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [club.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    // The subscriber no longer has a send port at all (hard rule 6), so the
    // only observable is that the failure does not escape into the chain.
    await expect(handled).resolves.toBeUndefined();
    expect(sendTyping).not.toHaveBeenCalled();
  });
});

describe('assistant mention failure path', () => {
  it('answers the member when the service throws instead of going silent', async () => {
    const h = harness([{ ...club, callerRoleIds: ['987654321098765432'] }]);
    h.invoke.mockRejectedValueOnce(new Error('provider outage'));
    await h.subscriber.handle({
      kind: 'messageCreate',
      guildId,
      receivedAtMs: 1,
      channelId,
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      messageId: '890123456789012345',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId!}> where is the handbook?`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: ['987654321098765432'],
      mentionedRoleIds: [club.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    await h.flush();
    expect(h.send).toHaveBeenCalledWith(
      channelId,
      expect.objectContaining({
        content: expect.stringContaining("couldn't finish that answer"),
      }),
    );
  });

  it('never re-invokes when answer delivery fails after the invoke succeeded', async () => {
    const h = harness([{ ...club, callerRoleIds: ['987654321098765432'] }]);
    await h.subscriber.handle({
      kind: 'messageCreate',
      guildId,
      receivedAtMs: 1,
      channelId,
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      messageId: '890123456789012345',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId!}> where is the handbook?`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: ['987654321098765432'],
      mentionedRoleIds: [club.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    const payload = h.queued[0]!;
    const sealer = createInteractionTokenSealer();
    const handler = assistantInvokeHandler({
      guildId,
      service: { behavioursForGuild: vi.fn(async () => [{ ...club }]), invoke: h.invoke },
      openToken: (token) => sealer.open(token),
      respond: h.respond,
      send: h.send,
      logger: pino({ level: 'silent' }),
      logChannelId: () => undefined,
      now: () => 1,
    });
    // Attempt 1: invoke succeeds, the answer send throws (Discord blip).
    let cursor: string | null = null;
    h.send.mockRejectedValueOnce(new Error('discord 500'));
    await expect(
      handler.run(handler.payload.parse(payload), {
        jobId: 1,
        attempts: 1,
        cursor: null,
        saveCursor: (c) => {
          cursor = c;
        },
      }),
    ).rejects.toThrow('discord 500');
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(cursor).not.toBeNull();
    // Attempt 2 (the worker's retry): the stored result is delivered; the
    // provider is NOT called again and no duplicate effects can occur.
    await handler.run(handler.payload.parse(payload), {
      jobId: 1,
      attempts: 2,
      cursor,
      saveCursor: () => undefined,
    });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(
      channelId,
      expect.objectContaining({ content: 'Grounded answer.' }),
    );
  });

  it('answers the member when the behaviour was deleted between enqueue and run', async () => {
    const h = harness([{ ...club, callerRoleIds: ['987654321098765432'] }]);
    await h.subscriber.handle({
      kind: 'messageCreate',
      guildId,
      receivedAtMs: 1,
      channelId,
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      messageId: '890123456789012345',
      authorId: userId,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: `<@&${club.mentionRoleId!}> where is the handbook?`,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: ['987654321098765432'],
      mentionedRoleIds: [club.mentionRoleId!],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(h.queued).toHaveLength(1);
    // The behaviour vanishes before the worker picks the job up: fail closed,
    // never act on the stale copy.
    h.invoke.mockClear();
    const payload = h.queued[0]!;
    const handler = assistantInvokeHandler({
      guildId,
      service: { behavioursForGuild: vi.fn(async () => []), invoke: h.invoke },
      openToken: (t) => t,
      respond: h.respond,
      send: h.send,
      logger: pino({ level: 'silent' }),
      logChannelId: () => undefined,
      now: () => 1,
    });
    await handler.run(handler.payload.parse(payload), {
      jobId: 1,
      attempts: 1,
      cursor: null,
      saveCursor: () => undefined,
    });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledWith(
      channelId,
      expect.objectContaining({
        content: expect.stringContaining('switched off or removed'),
      }),
    );
  });

  it('drops a slash job before the invoke when the sealed token is from a previous process', async () => {
    // Restart semantics: the sealer's key is per-process, so a queued job
    // surviving a restart carries a token this process cannot open. Running
    // the invoke anyway would spend provider quota and write durable
    // ticket/activity effects whose answer can never be delivered (audit,
    // round 2). The job must fail closed BEFORE the invoke, and complete
    // (the token is long expired; no retry can help).
    const h = harness([{ ...club, callerRoleIds: ['987654321098765432'] }]);
    const staleSealer = createInteractionTokenSealer();
    const currentSealer = createInteractionTokenSealer();
    const handler = assistantInvokeHandler({
      guildId,
      service: { behavioursForGuild: vi.fn(async () => [{ ...club }]), invoke: h.invoke },
      openToken: (token) => currentSealer.open(token),
      respond: h.respond,
      send: h.send,
      logger: pino({ level: 'silent' }),
      logChannelId: () => undefined,
      now: () => 1,
    });
    const payload = handler.payload.parse({
      schemaVersion: 1,
      invocationId: 'int-stale-token',
      behaviourId: club.id,
      command: 'ask',
      channelId,
      userId,
      callerRoleIds: ['987654321098765432'],
      input: { question: 'When are meetings?' },
      source: 'slash-command',
      interaction: {
        interactionId: '678901234567890123',
        sealedToken: staleSealer.seal('secret-token-from-before-restart'),
      },
    });
    await handler.run(payload, {
      jobId: 1,
      attempts: 1,
      cursor: null,
      saveCursor: () => undefined,
    });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('does not repeat the member answer when a completed job is retried', async () => {
    // Completion retry: the worker finished the job but the completion write
    // was lost, so the job fires again with the final cursor. Nothing may be
    // re-sent.
    const h = harness([{ ...club, callerRoleIds: ['987654321098765432'] }]);
    const sealer = createInteractionTokenSealer();
    const handler = assistantInvokeHandler({
      guildId,
      service: { behavioursForGuild: vi.fn(async () => [{ ...club }]), invoke: h.invoke },
      openToken: (token) => sealer.open(token),
      respond: h.respond,
      send: h.send,
      logger: pino({ level: 'silent' }),
      logChannelId: () => undefined,
      now: () => 1,
    });
    const payload = handler.payload.parse({
      schemaVersion: 1,
      invocationId: 'int-completion-retry',
      behaviourId: club.id,
      command: 'ask',
      channelId,
      userId,
      callerRoleIds: ['987654321098765432'],
      input: { question: 'When are meetings?' },
      source: 'mention',
    });
    const cursors: string[] = [];
    const context = {
      jobId: 1,
      attempts: 1,
      cursor: null as string | null,
      saveCursor: (c: string): void => {
        cursors.push(c);
      },
    };
    await handler.run(payload, context);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    // Every stage was persisted: the invoke, each posted part, then 'answered'.
    expect(cursors.map((c) => (JSON.parse(c) as { stage: string }).stage)).toEqual([
      'invoke-done',
      'invoke-done',
      'answered',
    ]);
    // The completion retry: the provider is not called and nothing is re-sent.
    await handler.run(payload, { ...context, attempts: 2, cursor: cursors.at(-1)! });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('resumes an escalation result after the answer without re-sending it or duplicating the post', async () => {
    // Crash between the member answer and the escalation post, then a
    // completion retry after everything landed.
    const escBehaviour = {
      ...club,
      callerRoleIds: ['987654321098765432'],
      escalation: undefined,
    };
    const h = harness([escBehaviour]);
    const escalateResult: AssistantInvocationResult = {
      ok: true,
      content: 'I could not confirm that.',
      escalation: { ticketId: 'ticket-1', channelId, reviewerRoleIds: ['111222333444555666'] },
    };
    h.invoke.mockResolvedValue(escalateResult);
    const sealer = createInteractionTokenSealer();
    const handler = assistantInvokeHandler({
      guildId,
      service: { behavioursForGuild: vi.fn(async () => [escBehaviour]), invoke: h.invoke },
      openToken: (token) => sealer.open(token),
      respond: h.respond,
      send: h.send,
      logger: pino({ level: 'silent' }),
      logChannelId: () => undefined,
      now: () => 1,
    });
    const payload = handler.payload.parse({
      schemaVersion: 1,
      invocationId: 'int-esc-retry',
      behaviourId: club.id,
      command: 'ask',
      channelId,
      userId,
      callerRoleIds: ['987654321098765432'],
      input: { question: 'Refund my membership.' },
      source: 'mention',
    });
    const cursors: string[] = [];
    const context = {
      jobId: 1,
      attempts: 1,
      cursor: null as string | null,
      saveCursor: (c: string): void => {
        cursors.push(c);
      },
    };
    // Attempt 1: the answer lands, the escalation send throws.
    let calls = 0;
    h.send.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) throw new Error('discord 500');
    });
    await expect(handler.run(payload, context)).rejects.toThrow('discord 500');
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(cursors.map((c) => (JSON.parse(c) as { stage: string }).stage)).toEqual([
      'invoke-done',
      'invoke-done',
      'answered',
    ]);
    // Attempt 2: only the escalation post is sent.
    await handler.run(payload, { ...context, attempts: 2, cursor: cursors.at(-1)! });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(3);
    expect((h.send.mock.calls[2] as unknown[] | undefined)?.[1]).toMatchObject({
      allowedMentions: { parse: [], roles: ['111222333444555666'] },
    });
    expect(cursors.map((c) => (JSON.parse(c) as { stage: string }).stage)).toEqual([
      'invoke-done',
      'invoke-done',
      'answered',
      'escalation-sent',
    ]);
    // Completion retry: nothing at all.
    await handler.run(payload, { ...context, attempts: 3, cursor: cursors.at(-1)! });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(3);
  });
});

describe('assistant answer feedback reactions (Task 20)', () => {
  const BOT = '901234567890123456';
  const MESSAGE = '890123456789012345';
  const TRACE = 'trace_feedback_1';
  const assistantLink = (messageId: string): KnownMessage | undefined =>
    messageId === MESSAGE
      ? { conversationId: 'conv-1', role: 'assistant', channelId, behaviourId: 'club' }
      : undefined;
  const userLink = (messageId: string): KnownMessage | undefined =>
    messageId === MESSAGE
      ? { conversationId: 'conv-1', role: 'user', channelId, behaviourId: 'club' }
      : undefined;
  const feedbackHarness = (
    lookupMessage: (messageId: string) => KnownMessage | undefined = assistantLink,
  ) => {
    const setFeedback = vi.fn(
      (
        _messageId: string,
        _feedback: 'up' | 'down' | null,
      ): {
        updated: boolean;
        traceId: string | undefined;
      } => ({ updated: true, traceId: TRACE }),
    );
    const addTraceFlag = vi.fn((_traceId: string, _flag: string): boolean => true);
    const subscriber = createAssistantCommandSubscriber({
      botUserId: BOT,
      guildId,
      service: {
        behavioursForGuild: vi.fn(async () => [direct, club]),
        invoke: vi.fn(async () => ({ ok: true as const, content: 'unused' })),
      },
      enqueue: vi.fn(),
      now: () => 1,
      logger: pino({ level: 'silent' }),
      lookupMessage,
      feedback: { setFeedback, addTraceFlag },
    });
    return { setFeedback, addTraceFlag, subscriber };
  };
  // Overrides are the real reaction event shape, partial: a single-kind
  // `Extract` would narrow to `never` (the event's kind is a union), so the
  // helper takes `Partial<ReactionEvent>` and returns the full event.
  const reaction = (over: Partial<ReactionEvent> = {}): ReactionEvent => ({
    kind: 'reactionAdd',
    guildId,
    receivedAtMs: 1,
    channelId,
    messageId: MESSAGE,
    userId,
    emoji: 'u:1f44d',
    wasPartial: false,
    ...over,
  });

  it('records a thumbs-up and flags the trace', async () => {
    const h = feedbackHarness();
    await h.subscriber.handle(reaction());
    expect(h.setFeedback).toHaveBeenCalledWith(MESSAGE, 'up');
    expect(h.addTraceFlag).toHaveBeenCalledWith(TRACE, 'feedback:up');
  });

  it('records a thumbs-down and flags the trace', async () => {
    const h = feedbackHarness();
    await h.subscriber.handle(reaction({ emoji: 'u:1f44e' }));
    expect(h.setFeedback).toHaveBeenCalledWith(MESSAGE, 'down');
    expect(h.addTraceFlag).toHaveBeenCalledWith(TRACE, 'feedback:down');
  });

  it('clears feedback when the reaction is removed, without touching trace flags', async () => {
    const h = feedbackHarness();
    await h.subscriber.handle(reaction({ kind: 'reactionRemove' }));
    expect(h.setFeedback).toHaveBeenCalledWith(MESSAGE, null);
    expect(h.addTraceFlag).not.toHaveBeenCalled();
  });

  it('does nothing for a reaction on an unlinked message', async () => {
    const h = feedbackHarness(() => undefined);
    await h.subscriber.handle(reaction());
    expect(h.setFeedback).not.toHaveBeenCalled();
    expect(h.addTraceFlag).not.toHaveBeenCalled();
  });

  it('does nothing for a reaction on a user-role message', async () => {
    const h = feedbackHarness(userLink);
    await h.subscriber.handle(reaction());
    expect(h.setFeedback).not.toHaveBeenCalled();
    expect(h.addTraceFlag).not.toHaveBeenCalled();
  });

  it('counts only thumbs-up and thumbs-down', async () => {
    const h = feedbackHarness();
    await h.subscriber.handle(reaction({ emoji: 'u:2714' }));
    expect(h.setFeedback).not.toHaveBeenCalled();
    expect(h.addTraceFlag).not.toHaveBeenCalled();
  });

  it('ignores the bot’s own reactions', async () => {
    const h = feedbackHarness();
    await h.subscriber.handle(reaction({ userId: BOT }));
    expect(h.setFeedback).not.toHaveBeenCalled();
    expect(h.addTraceFlag).not.toHaveBeenCalled();
  });

  it('adds no trace flag when the message link is gone', async () => {
    const h = feedbackHarness();
    h.setFeedback.mockReturnValueOnce({ updated: false, traceId: undefined });
    await h.subscriber.handle(reaction());
    expect(h.setFeedback).toHaveBeenCalledWith(MESSAGE, 'up');
    expect(h.addTraceFlag).not.toHaveBeenCalled();
  });
});

describe('assistant invoke job: retries, cursor hygiene and stranded stages', () => {
  const mentionPayload: AssistantInvokePayload = {
    channelId,
    userId,
    callerRoleIds: [],
    behaviourId: club.id,
    command: 'ask',
    input: { question: 'where is the handbook?' },
    source: 'mention',
    invocationId: '890123456789012345',
  };
  const jobDeps = (invoke: AssistantCommandService['invoke'], logChannelId?: string) => {
    const send = vi.fn(async (_channelId: string, _message: unknown) => undefined);
    const respond = vi.fn(async () => undefined);
    const saved: (string | null)[] = [];
    const handler = assistantInvokeHandler({
      guildId,
      service: { behavioursForGuild: vi.fn(async () => [club]), invoke },
      openToken: () => undefined,
      respond,
      send,
      logger: pino({ level: 'silent' }),
      logChannelId: () => logChannelId,
      now: () => 1_790_000_000_000,
    });
    const run = (attempts: number, cursor: string | null) =>
      handler.run(handler.payload.parse(mentionPayload), {
        jobId: 1,
        attempts,
        cursor,
        saveCursor: (c) => {
          saved.push(c);
        },
      });
    return { send, respond, saved, run };
  };

  it.each([
    [1, 10_000],
    [2, 30_000],
    [3, 90_000],
  ])(
    'retries a busy provider after attempt %i with a %i ms delay, silently',
    async (attempt, delay) => {
      const invoke = vi.fn(async () => {
        throw new ProviderError('outage', 'Gemini request failed with HTTP 503', true);
      });
      const d = jobDeps(invoke);
      const thrown = await Promise.resolve()
        .then(() => d.run(attempt, null))
        .catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(RetryAfterError);
      expect((thrown as RetryAfterError).retryAfterMs).toBe(delay);
      expect(d.send).not.toHaveBeenCalled();
      expect(d.saved).toHaveLength(0);
    },
  );

  it('tells the member the AI service is busy after the last attempt', async () => {
    const invoke = vi.fn(async () => {
      throw new ProviderError('outage', 'Gemini request failed with HTTP 503', true);
    });
    const d = jobDeps(invoke);
    await d.run(4, null);
    expect(d.send).toHaveBeenCalledWith(
      channelId,
      expect.objectContaining({
        content: 'The AI is busy right now, so nothing was done. Try again in a minute.',
      }),
    );
  });

  it('answers immediately on a non-retryable provider error', async () => {
    const invoke = vi.fn(async () => {
      throw new ProviderError('safety-refusal', 'refused', false);
    });
    const d = jobDeps(invoke);
    await d.run(1, null);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it('treats a malformed cursor as no cursor rather than crashing every retry', async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, content: 'Grounded answer.' }));
    const d = jobDeps(invoke);
    await d.run(2, JSON.stringify({ stage: 'answered', result: { ok: true } }));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(d.send).toHaveBeenCalledWith(
      channelId,
      expect.objectContaining({ content: 'Grounded answer.' }),
    );
  });

  it('still posts the escalation from a stranded invoke-done cursor when the token is gone', async () => {
    const invoke = vi.fn();
    const d = jobDeps(invoke);
    const result = {
      ok: true as const,
      content: 'Escalated.',
      escalation: { channelId: '111111111111111111', reviewerRoleIds: [], ticketId: 't1' },
    };
    const handler = assistantInvokeHandler({
      guildId,
      service: { behavioursForGuild: vi.fn(async () => [club]), invoke },
      openToken: () => undefined,
      respond: d.respond,
      send: d.send,
      logger: pino({ level: 'silent' }),
      logChannelId: () => undefined,
      now: () => 1,
    });
    await handler.run(
      handler.payload.parse({
        ...mentionPayload,
        source: 'slash-command',
        interaction: { interactionId: '678901234567890123', sealedToken: 'not-ours' },
      }),
      {
        jobId: 1,
        attempts: 2,
        cursor: JSON.stringify({ stage: 'invoke-done', result }),
        saveCursor: () => undefined,
      },
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(d.respond).not.toHaveBeenCalled();
    expect(d.send).toHaveBeenCalledWith(
      '111111111111111111',
      expect.objectContaining({ flags: 32768 }),
    );
    const stranded = d.send.mock.calls.find(
      (call) => call[0] === '111111111111111111',
    )?.[1] as OutgoingMessage;
    expect(cardTexts(stranded.components ?? [])).toContain('IT request t1');
  });
});

describe('assistant invoke job: the AI log channel (ADR 0065)', () => {
  const LOG = '999999999999999990';
  const payload: AssistantInvokePayload = {
    channelId,
    userId,
    callerRoleIds: [],
    behaviourId: club.id,
    command: 'ask',
    input: { question: 'where is the handbook?' },
    source: 'mention',
    invocationId: '890123456789012399',
  };
  const setup = (invoke: AssistantCommandService['invoke'], logChannelId?: string) => {
    const send = vi.fn(async (_channelId: string, _message: unknown) => undefined);
    const saved: (string | null)[] = [];
    const handler = assistantInvokeHandler({
      guildId,
      service: { behavioursForGuild: vi.fn(async () => [club]), invoke },
      openToken: () => undefined,
      respond: vi.fn(async () => undefined),
      send,
      logger: pino({ level: 'silent' }),
      logChannelId: () => logChannelId,
      now: () => 1_790_000_000_000,
    });
    const run = (attempts: number, cursor: string | null) =>
      handler.run(handler.payload.parse(payload), {
        jobId: 1,
        attempts,
        cursor,
        saveCursor: (c) => {
          saved.push(c);
        },
      });
    return { send, saved, run };
  };
  const logPosts = (send: ReturnType<typeof setup>['send']) =>
    send.mock.calls.filter(([channel]) => channel === LOG);
  const card = (call: [string, unknown]): string =>
    cardTexts((call[1] as OutgoingMessage).components ?? []);

  it('posts one log after the answer, with the trace, and marks the stage', async () => {
    const d = setup(
      vi.fn(async () => ({
        ok: true as const,
        content: 'Top shelf.',
        trace: { latencyMs: 900, model: 'm', tools: [{ name: 'current_time', ok: true }] },
      })),
      LOG,
    );
    await d.run(1, null);
    expect(d.send.mock.calls.map(([channel]) => channel)).toEqual([channelId, LOG]);
    const logged = card(logPosts(d.send)[0]!);
    expect(logged).toContain('-# 🤖 MENTION · ANSWERED');
    expect(logged).toContain('**Question**\n> where is the handbook?');
    expect(logged).toContain('**Answer**\n> Top shelf.');
    expect(logged).toContain('Tools: current_time ✓');
    expect(logged).toContain(`Behaviour: ${club.name}`);
    expect(JSON.parse(d.saved.at(-1)!)).toMatchObject({ stage: 'logged' });
  });

  it('never posts the log twice when a retry resumes after it', async () => {
    const invoke = vi.fn();
    const d = setup(invoke, LOG);
    await d.run(
      2,
      JSON.stringify({ stage: 'logged', result: { ok: true, content: 'Top shelf.' } }),
    );
    expect(d.send).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('retries only the log when it failed after the answer landed', async () => {
    const d = setup(vi.fn(), LOG);
    await d.run(
      2,
      JSON.stringify({ stage: 'answered', result: { ok: false, content: 'Refused.' } }),
    );
    expect(d.send.mock.calls.map(([channel]) => channel)).toEqual([LOG]);
    expect(card(logPosts(d.send)[0]!)).toContain('-# 🤖 MENTION · REFUSED');
  });

  it('posts nothing when no log channel is set', async () => {
    const d = setup(vi.fn(async () => ({ ok: true as const, content: 'Hi.' })));
    await d.run(1, null);
    expect(d.send.mock.calls.map(([channel]) => channel)).toEqual([channelId]);
  });
  it('logs a failure with its reason, and a broken log channel never re-answers', async () => {
    const d = setup(
      vi.fn(async () => {
        throw new ProviderError('outage', 'Gemini request failed with HTTP 503', true);
      }),
      LOG,
    );
    d.send.mockImplementation(async (channel: string) => {
      if (channel === LOG) throw new Error('Missing Access');
      return undefined;
    });
    await expect(d.run(4, null)).resolves.toBeUndefined();
    const logged = card(logPosts(d.send)[0]!);
    expect(logged).toContain('-# 🤖 MENTION · FAILED');
    // Hard rule 4: the log channel gets the fixed sentence, never the
    // provider's text.
    expect(logged).toContain(`**Reason**\n> ${PROVIDER_FAILURE_LOG_REASON}`);
  });
});

describe('assistant mention channel permissions (ADR 0126)', () => {
  const tagged = (messageId: string): MessageEvent => ({
    kind: 'messageCreate',
    guildId,
    receivedAtMs: 1,
    channelId,
    parentChannelId: undefined,
    categoryId: undefined,
    isPrivateThread: false,
    messageId,
    authorId: userId,
    authorDisplayName: undefined,
    authorIsBot: false,
    content: `<@&${club.mentionRoleId}> where is the handbook?`,
    editedTimestampMs: undefined,
    mentionedUserIds: [],
    authorRoleIds: [],
    mentionedRoleIds: [club.mentionRoleId!],
    mentionsEveryone: false,
    attachments: [],
  });
  /** Write denied (or the channel No access); Read stays allowed. */
  const denyWrite = (
    reason: 'no-access' | 'not-granted' | 'unknown-channel',
  ): Pick<ChannelAccess, 'check'> => ({
    check: async (purpose) =>
      purpose === 'write' ? { allowed: false, reason } : { allowed: true, grantedBy: 'grant' },
  });

  it('a mention in a Write-denied channel enqueues nothing and sends no typing', async () => {
    const h = harness([direct, club], undefined, true, undefined, denyWrite('not-granted'));
    await h.subscriber.handle(tagged('890123456789012401'));
    expect(h.queued).toHaveLength(0);
    expect(h.sendTyping).not.toHaveBeenCalled();
  });

  it('a mention in a No-access channel enqueues nothing', async () => {
    const h = harness([direct, club], undefined, true, undefined, denyWrite('no-access'));
    await h.subscriber.handle(tagged('890123456789012402'));
    expect(h.queued).toHaveLength(0);
    expect(h.sendTyping).not.toHaveBeenCalled();
  });

  it('without channelAccess a mention still enqueues (legacy callers unchanged)', async () => {
    const h = harness();
    await h.subscriber.handle(tagged('890123456789012403'));
    expect(h.queued).toHaveLength(1);
  });
});

describe('assistant mention run ledger (ADR 0129 §6)', () => {
  const mentionEvent = (over: Record<string, unknown> = {}) => ({
    kind: 'messageCreate' as const,
    parentChannelId: undefined,
    categoryId: undefined,
    isPrivateThread: false,
    guildId,
    receivedAtMs: 1,
    channelId,
    messageId: '890123456789012345',
    authorId: userId,
    authorDisplayName: undefined,
    authorIsBot: false,
    content: `<@&${club.mentionRoleId}> where is the handbook?`,
    editedTimestampMs: undefined,
    mentionedUserIds: [],
    authorRoleIds: [],
    mentionedRoleIds: [club.mentionRoleId!],
    mentionsEveryone: false,
    attachments: [],
    ...over,
  });

  it('a routed mention calls recordQueued once with via mention', async () => {
    const recordQueued = vi.fn();
    const h = harness(undefined, undefined, true, undefined, undefined, undefined, recordQueued);
    await h.subscriber.handle(mentionEvent());
    expect(h.queued).toHaveLength(1);
    expect(recordQueued).toHaveBeenCalledTimes(1);
    expect(recordQueued).toHaveBeenCalledWith({
      runId: '890123456789012345',
      userId,
      channelId,
      behaviourId: 'club',
      via: 'mention',
    });
  });

  it('a reply mention calls recordQueued with via reply', async () => {
    const recordQueued = vi.fn();
    const h = harness(undefined, undefined, true, undefined, undefined, undefined, recordQueued);
    await h.subscriber.handle(
      mentionEvent({
        referencedMessageId: '890123456789012399',
        referencedAuthorId: '901234567890123456',
      }),
    );
    expect(h.queued).toHaveLength(1);
    expect(recordQueued).toHaveBeenCalledWith(
      expect.objectContaining({ via: 'reply', runId: '890123456789012345' }),
    );
  });

  it('a duplicate mention does not call recordQueued', async () => {
    const recordQueued = vi.fn();
    const h = harness(undefined, undefined, false, undefined, undefined, undefined, recordQueued);
    await h.subscriber.handle(mentionEvent());
    expect(recordQueued).not.toHaveBeenCalled();
  });
});
