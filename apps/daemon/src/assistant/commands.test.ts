import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { AssistantBehaviour, AssistantInvokePayload, DomainEvent } from '@bananasaurs/core';
import {
  createAssistantCommandSubscriber,
  type AssistantCommandService,
  type AssistantInvocationResult,
} from './commands.js';
import { assistantInvokeHandler } from '../jobs/assistant.js';

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
  allowedSkillIds: ['club-search', 'reminder-create'],
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
  allowedSkillIds: ['club-search'],
  resourceIds: [],
  enabled: true,
};

/**
 * The B2 split under test: the subscriber does cheap routing inline and
 * enqueues; the job handler does the invoke and answers. `flush()` drains
 * the captured queue through the real handler, so these tests exercise the
 * whole path a production event travels.
 */
const harness = (behaviours: readonly AssistantBehaviour[] = [direct, club]) => {
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
  const defer = vi.fn(async () => undefined);
  const respond = vi.fn(async () => undefined);
  const send = vi.fn(async () => undefined);
  const queued: AssistantInvokePayload[] = [];
  const handler = assistantInvokeHandler({
    guildId,
    service,
    respond,
    send,
    logger: pino({ level: 'silent' }),
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
    defer,
    respond,
    send,
    queued,
    flush,
    subscriber: createAssistantCommandSubscriber({
      guildId,
      service,
      defer,
      respond,
      send,
      enqueue: (input) => {
        queued.push(input.payload);
      },
      now: () => 1,
      logger: pino({ level: 'silent' }),
    }),
  };
};
const slash = (name: string, options: { name: string; value: string }[]): DomainEvent => ({
  kind: 'slashCommand',
  guildId,
  receivedAtMs: 1,
  interactionId: '678901234567890123',
  token: 'secret',
  commandName: name,
  subcommandPath: [],
  options,
  channelId,
  userId,
});

describe('assistant command subscriber', () => {
  it.each([
    ['ask', [{ name: 'question', value: 'When is the meeting?' }]],
    ['find', [{ name: 'query', value: 'handbook' }]],
    [
      'remind',
      [
        { name: 'when', value: 'Monday 9 am' },
        { name: 'text', value: 'Bring cones' },
      ],
    ],
    ['decision', [{ name: 'topic', value: 'Battery supplier' }]],
    ['review-plan', [{ name: 'plan', value: 'Test on Friday' }]],
    ['onboard', [{ name: 'request', value: 'What should a new member do?' }]],
    ['agenda', [{ name: 'request', value: 'Monday tech meeting' }]],
    ['summarise', [{ name: 'request', value: 'Notes from the build session' }]],
    ['announce', [{ name: 'request', value: 'Battery workshop moved' }]],
    ['checklist', [{ name: 'request', value: 'Competition packing' }]],
    ['handoff', [{ name: 'request', value: 'Electrical to software' }]],
  ])('defers and routes /%s through the queue to the service', async (name, options) => {
    const h = harness();
    await h.subscriber.handle(slash(name, options));
    expect(h.defer).toHaveBeenCalledTimes(1);
    // The invoke must NOT happen inline (B2): the serial dispatch chain is
    // already free, and the queued job carries the whole invocation.
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0]).toEqual(
      expect.objectContaining({ command: name, source: 'slash-command' }),
    );
    await h.flush();
    expect(h.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ command: name, source: 'slash-command' }),
    );
    expect(h.respond).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        content: 'Grounded answer.',
        allowedMentions: { parse: [] },
      }),
    );
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
        content: expect.stringContaining('IT request it-1'),
        allowedMentions: { parse: [], roles: ['987654321098765431'] },
      }),
    );
  });

  it('does not expose removed privacy commands', async () => {
    const h = harness();
    await h.subscriber.handle(slash('mydata', []));
    await h.subscriber.handle(slash('forgetme', []));
    expect(h.defer).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.queued).toHaveLength(0);
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
    expect(h.send).toHaveBeenCalledWith(
      channelId,
      expect.objectContaining({
        content: 'Please tag either @bananasaurs or @it-services, not both.',
      }),
    );
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
        content: expect.stringContaining('could not complete'),
      }),
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
      respond: h.respond,
      send: h.send,
      logger: pino({ level: 'silent' }),
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
        content: expect.stringContaining('no longer available'),
      }),
    );
  });
});
