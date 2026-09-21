import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { AssistantBehaviour, DomainEvent } from '@bananasaurs/core';
import { createAssistantCommandSubscriber, type AssistantCommandService } from './commands.js';

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
  allowedSkillIds: ['club-search'],
  resourceIds: [],
  enabled: true,
};

const harness = (behaviours: readonly AssistantBehaviour[] = [direct, club]) => {
  const invoke = vi.fn(async () => ({ ok: true as const, content: 'Grounded answer.' }));
  const service: AssistantCommandService = {
    behavioursForGuild: vi.fn(async () => behaviours),
    invoke,
  };
  const defer = vi.fn(async () => undefined);
  const respond = vi.fn(async () => undefined);
  const send = vi.fn(async () => undefined);
  return {
    invoke,
    defer,
    respond,
    send,
    subscriber: createAssistantCommandSubscriber({
      guildId,
      service,
      defer,
      respond,
      send,
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
  ])('defers and routes /%s through the service', async (name, options) => {
    const h = harness();
    await h.subscriber.handle(slash(name, options));
    expect(h.defer).toHaveBeenCalledTimes(1);
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

  it('does not expose removed privacy commands', async () => {
    const h = harness();
    await h.subscriber.handle(slash('mydata', []));
    await h.subscriber.handle(slash('forgetme', []));
    expect(h.defer).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
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
    expect(h.send).toHaveBeenCalledWith(
      channelId,
      expect.objectContaining({
        content: 'Please tag either @bananasaurs or @it-services, not both.',
      }),
    );
  });
});
