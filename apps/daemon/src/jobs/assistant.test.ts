import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import {
  assistantInvokeCursor,
  assistantSummarisePayload,
  JOB_KINDS,
  parseGuildId,
  ProviderError,
  RetryAfterError,
  scanOutboundRequest,
  type AssistantBehaviour,
  type ChannelAccess,
  type DiscordMessageRef,
  type JobContext,
  type Logger,
  type OutgoingMessage,
  type RecentMessage,
} from '@bananasaurs/core';
import { conversationRepo, guildRepo, jobRepo, runRepo, traceRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import type {
  AssistantCommandService,
  AssistantInvocation,
  AssistantInvocationResult,
  AssistantTraceDetail,
} from '../assistant/commands.js';
import { assistantInvokeHandler } from './assistant.js';
import { ChainFailedError } from '../assistant/chain-failed-error.js';
import { LocalLimitError, localLimitReply } from '../assistant/local-limit.js';
import { dailyQuotaReply } from '../assistant/fallback-replies.js';
import type { AssistantTrace } from '@bananasaurs/core';

const GUILD_ID = parseGuildId('111111111111111111');
const USER_ID = '222222222222222222';
const CHANNEL_ID = '333333333333333333';
const NOW = 1_700_000_000_000;

const behaviour: AssistantBehaviour = {
  id: 'behaviour-1',
  guildId: GUILD_ID,
  surface: 'bananasaurs',
  callerRoleIds: [],
  reviewerRoleIds: [],
  name: 'Ask',
  systemPrompt: 'sys',
  promptVersion: 1,
  preferredSkillIds: [],
  resourceIds: [],
  enabled: true,
};

const payload = {
  channelId: CHANNEL_ID,
  userId: USER_ID,
  callerRoleIds: [],
  behaviourId: behaviour.id,
  command: 'ask' as const,
  input: { question: 'hi' },
  source: 'mention' as const,
  invocationId: 'inv-1',
};

/** A pino instance whose emitted JSON lines are captured for assertion. */
const capturedLogger = (): { logger: Logger; lines: () => Record<string, unknown>[] } => {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  const logger = pino({ level: 'debug' }, stream);
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
};

const context = (over: Partial<JobContext> = {}): JobContext => ({
  jobId: 1,
  attempts: 1,
  cursor: null,
  saveCursor: () => undefined,
  ...over,
});

const service = (
  invoke: (input: AssistantInvocation) => Promise<AssistantInvocationResult>,
  calls: AssistantInvocation[] = [],
): AssistantCommandService => ({
  behavioursForGuild: async () => [behaviour],
  invoke: async (input) => {
    calls.push(input);
    return invoke(input);
  },
});

const baseDeps = (service_: AssistantCommandService, logger: Logger) => {
  const sent: { channelId: string; message: OutgoingMessage }[] = [];
  return {
    deps: {
      guildId: GUILD_ID,
      service: service_,
      openToken: () => undefined,
      respond: async () => undefined,
      send: async (channelId: string, message: OutgoingMessage) => {
        sent.push({ channelId, message });
        return undefined;
      },
      logger,
      logChannelId: () => undefined,
      now: () => NOW,
    },
    sent,
  };
};

describe('assistantInvokeHandler (ADR 0077)', () => {
  it('carries the provider error short reason into the retry-warning log line', async () => {
    const { logger, lines } = capturedLogger();
    const calls: AssistantInvocation[] = [];
    const svc = service(async () => {
      throw new ProviderError(
        'rate-limit',
        'openrouter request failed with HTTP 429 (code 429: Rate limit exceeded)',
        true,
      );
    }, calls);
    const { deps } = baseDeps(svc, logger);
    const handler = assistantInvokeHandler(deps);

    await expect(handler.run(payload, context({ attempts: 1 }))).rejects.toBeInstanceOf(
      RetryAfterError,
    );

    const warnLine = lines().find(
      (line) =>
        line['msg'] === 'assistant invocation hit a retryable provider error; job will retry',
    );
    expect(warnLine).toBeDefined();
    const err = warnLine?.['err'] as { message?: string } | undefined;
    expect(err?.message).toContain('code 429');
    expect(err?.message).toContain('Rate limit exceeded');
  });

  it('a provider failure keeps provider text out of the reply and the log channel, but in Pino', async () => {
    const { logger, lines } = capturedLogger();
    const svc = service(async () => {
      throw new ProviderError(
        'outage',
        'openrouter request failed with HTTP 503 (sk-or-v1-SECRETKEY-billed-detail)',
        false,
      );
    });
    const { deps, sent } = baseDeps(svc, logger);
    const handler = assistantInvokeHandler({ ...deps, logChannelId: () => '444444444444444444' });

    await handler.run(payload, context({ attempts: 1 }));

    // The member reply and the log-channel entry carry none of the
    // provider's text; the fixed failure copy stands in for it.
    expect(sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(sent)).not.toContain('SECRETKEY');
    expect(sent[0]?.message.content).toBe(
      'I could not complete that request. No action was taken.',
    );
    // The Pino error line still carries the provider's truncated reason.
    const errLine = lines().find(
      (line) => line['msg'] === 'assistant invocation failed before a response was produced',
    );
    expect(errLine).toBeDefined();
    expect(JSON.stringify(errLine)).toContain('SECRETKEY');
  });

  it('answers a daily quota cap at once, using resetAt for the unix time, with no retry', async () => {
    const resetAt = NOW + 3_600_000;
    const calls: AssistantInvocation[] = [];
    const svc = service(async () => {
      throw new ProviderError('quota', 'openrouter free-model daily limit reached', false, {
        quotaScope: 'daily-free',
        resetAt,
      });
    }, calls);
    const { deps, sent } = baseDeps(svc, pino({ level: 'silent' }));
    const handler = assistantInvokeHandler(deps);

    await expect(handler.run(payload, context({ attempts: 1 }))).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    const unix = Math.floor(resetAt / 1000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.content).toBe(
      `The bot's free AI allowance for today is used up. It resets <t:${unix}:t>. No action was taken.`,
    );
  });

  it('falls back to the next UTC midnight from deps.now() when resetAt is unknown', async () => {
    const calls: AssistantInvocation[] = [];
    const svc = service(async () => {
      throw new ProviderError('quota', 'openrouter free-model daily limit reached', false, {
        quotaScope: 'daily-free',
      });
    }, calls);
    const { deps, sent } = baseDeps(svc, pino({ level: 'silent' }));
    const handler = assistantInvokeHandler(deps);

    await handler.run(payload, context({ attempts: 1 }));

    expect(calls).toHaveLength(1);
    const d = new Date(NOW);
    const nextMidnight = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    );
    const unix = Math.floor(nextMidnight / 1000);
    expect(sent[0]?.message.content).toBe(
      `The bot's free AI allowance for today is used up. It resets <t:${unix}:t>. No action was taken.`,
    );
  });

  it('does not throw RetryAfterError for a daily quota cap', async () => {
    const svc = service(async () => {
      throw new ProviderError('quota', 'daily cap', false, { quotaScope: 'daily-free' });
    });
    const { deps } = baseDeps(svc, pino({ level: 'silent' }));
    const handler = assistantInvokeHandler(deps);

    await expect(handler.run(payload, context({ attempts: 1 }))).resolves.toBeUndefined();
  });

  it('answers a local limit at once with the free-up time and no retry', async () => {
    const availableAt = NOW + 15 * 60_000;
    const calls: AssistantInvocation[] = [];
    const svc = service(async () => {
      throw new LocalLimitError(availableAt, 'local-rpm-limit');
    }, calls);
    const { deps, sent } = baseDeps(svc, pino({ level: 'silent' }));
    const handler = assistantInvokeHandler(deps);

    await expect(handler.run(payload, context({ attempts: 1 }))).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.content).toBe(localLimitReply(availableAt, NOW, 'UTC'));
    expect(sent[0]?.message.content).toBe(
      'All AI models have reached the limits set for them. The next one frees up in about 15 minutes.',
    );
  });

  it('does not throw RetryAfterError for a local limit, and logs the failure', async () => {
    const availableAt = NOW + 5 * 3_600_000;
    const svc = service(async () => {
      throw new LocalLimitError(availableAt, 'local-rpd-limit');
    });
    const { deps, sent } = baseDeps(svc, pino({ level: 'silent' }));
    const handler = assistantInvokeHandler({
      ...deps,
      logChannelId: () => '444444444444444444',
      timeZone: () => 'America/Vancouver',
    });

    await expect(handler.run(payload, context({ attempts: 1 }))).resolves.toBeUndefined();

    expect(sent).toHaveLength(2);
    expect(sent[0]?.message.content).toBe(localLimitReply(availableAt, NOW, 'America/Vancouver'));
    expect(sent[0]?.message.content).toContain('frees up at ');
  });

  it('still retries a transient 429 with the existing per-attempt delay', async () => {
    const svc = service(async () => {
      throw new ProviderError('rate-limit', 'HTTP 429', true);
    });
    const { deps } = baseDeps(svc, pino({ level: 'silent' }));
    const handler = assistantInvokeHandler(deps);

    const err = await Promise.resolve(handler.run(payload, context({ attempts: 1 }))).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetryAfterError);
    expect((err as RetryAfterError).retryAfterMs).toBe(10_000);
  });

  it('uses the injected retry delays: [5000] retries once at 5000 then answers busy', async () => {
    const svc = service(async () => {
      throw new ProviderError('rate-limit', 'HTTP 429', true);
    });
    const { deps, sent } = baseDeps(svc, pino({ level: 'silent' }));
    const handler = assistantInvokeHandler({ ...deps, retryDelaysMs: () => [5000] });

    const err = await Promise.resolve(handler.run(payload, context({ attempts: 1 }))).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetryAfterError);
    expect((err as RetryAfterError).retryAfterMs).toBe(5000);

    await handler.run(payload, context({ attempts: 2 }));
    expect(sent[0]?.message.content).toBe(
      'The AI service is busy right now. Try again in a minute. No action was taken.',
    );
  });

  it('with empty retry delays the first retryable failure answers the busy reply at once', async () => {
    const svc = service(async () => {
      throw new ProviderError('outage', 'HTTP 503', true);
    });
    const { deps, sent } = baseDeps(svc, pino({ level: 'silent' }));
    const handler = assistantInvokeHandler({ ...deps, retryDelaysMs: () => [] });

    await handler.run(payload, context({ attempts: 1 }));

    expect(sent[0]?.message.content).toBe(
      'The AI service is busy right now. Try again in a minute. No action was taken.',
    );
  });

  it('answers BUSY_REPLY, not the daily-cap wording, for a genuine transient error past the retry ceiling', async () => {
    const svc = service(async () => {
      throw new ProviderError('outage', 'HTTP 503', true);
    });
    const { deps, sent } = baseDeps(svc, pino({ level: 'silent' }));
    const handler = assistantInvokeHandler(deps);

    await handler.run(payload, context({ attempts: 4 }));

    expect(sent[0]?.message.content).toBe(
      'The AI service is busy right now. Try again in a minute. No action was taken.',
    );
  });
});

/**
 * Task 14: every answer joins a conversation, posts as Discord replies in
 * parts with a staged cursor, shows typing best-effort, and writes a trace.
 * Real storage (in-memory migrated database), faked service and Discord.
 */
describe('assistantInvokeHandler (Task 14: conversations, replies, typing, traces)', () => {
  const BOT_ID = '901234567890123456';
  const OTHER_ID = '666666666666666666';
  const AMA = '444444444444444444';
  const BO = '555555555555555555';

  let t: MigratedTestDatabase;
  let nowMs: number;

  beforeEach(() => {
    t = openMigratedTestDatabase();
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD_ID), { name: 'fixture', now: NOW });
    nowMs = NOW;
  });
  afterEach(() => t.close());

  const scope = () => t.scopes.forGuild(GUILD_ID);

  interface Posted {
    channelId: string;
    message: OutgoingMessage;
  }

  const harness = (
    answer: (
      input: AssistantInvocation,
    ) => AssistantInvocationResult | Promise<AssistantInvocationResult>,
    channelAccess?: Pick<ChannelAccess, 'check'>,
    guildReady?: () => boolean,
  ) => {
    const inputs: AssistantInvocation[] = [];
    const svc: AssistantCommandService = {
      behavioursForGuild: async () => [behaviour],
      invoke: async (input) => {
        inputs.push(input);
        return await answer(input);
      },
    };
    const sent: Posted[] = [];
    let idSeq = 0;
    // Linked message ids must satisfy the storage snowflake CHECK.
    const nextRef = (channelId: string): DiscordMessageRef => {
      idSeq += 1;
      return { channelId, messageId: `8290000000000000${String(idSeq).padStart(2, '0')}` };
    };
    const send = vi.fn(async (channelId: string, message: OutgoingMessage) => {
      sent.push({ channelId, message: message });
      return nextRef(channelId);
    });
    const respond = vi.fn(async () => nextRef(CHANNEL_ID));
    const sendTyping = vi.fn(async () => undefined);
    const fetchMessageContent = vi.fn(
      async (): Promise<{ authorId: string; authorName: string; content: string } | undefined> =>
        undefined,
    );
    const fetchChannelMessages = vi.fn(
      async (): Promise<readonly RecentMessage[] | undefined> => undefined,
    );
    // ADR 0089: the channel-context window. Off by default so the older
    // tests above exercise the history-only path unchanged.
    const channelContextMessages = vi.fn((): number => 0);
    const handler = assistantInvokeHandler({
      guildId: GUILD_ID,
      service: svc,
      openToken: () => undefined,
      respond,
      send,
      logger: pino({ level: 'silent' }),
      logChannelId: () => undefined,
      now: () => nowMs,
      conversations: { scope: scope(), botUserId: BOT_ID, botDisplayName: 'bananasaurs' },
      sendTyping,
      fetchMessageContent,
      fetchChannelMessages,
      channelContextMessages,
      ...(channelAccess === undefined ? {} : { channelAccess }),
      ...(guildReady === undefined ? {} : { guildReady }),
    });
    const run = async (
      input: Record<string, unknown>,
      cursor: string | null = null,
    ): Promise<{ cursor: string | null; error?: unknown }> => {
      let saved: string | null = cursor;
      try {
        await handler.run(handler.payload.parse(input), {
          jobId: 1,
          attempts: cursor === null ? 1 : 2,
          cursor,
          saveCursor: (c) => {
            saved = c;
          },
        });
      } catch (error) {
        return { cursor: saved, error };
      }
      return { cursor: saved };
    };
    return {
      inputs,
      sent,
      send,
      respond,
      sendTyping,
      fetchMessageContent,
      fetchChannelMessages,
      channelContextMessages,
      run,
    };
  };

  const mention = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    channelId: CHANNEL_ID,
    userId: AMA,
    callerRoleIds: [],
    behaviourId: behaviour.id,
    command: 'ask',
    input: { question: 'first question' },
    source: 'mention',
    invocationId: 'inv-1',
    messageId: '810000000000000001',
    authorName: 'Ama',
    ...over,
  });

  it('records thread and channel-follow-up join rules on user turns', async () => {
    const h = harness(() => ({ ok: true, content: 'answer' }));
    await h.run(
      mention({
        channelId: '888888888888888888',
        invocationId: 'thread-first',
        messageId: '810000000000000071',
        threadParentId: CHANNEL_ID,
      }),
    );
    nowMs += 31 * 60_000;
    await h.run(
      mention({
        channelId: '888888888888888888',
        invocationId: 'thread-second',
        messageId: '810000000000000072',
        threadParentId: CHANNEL_ID,
        userId: OTHER_ID,
      }),
    );
    expect(
      conversationRepo
        .listTurns(scope(), 'conv_thread-first')
        .find((turn) => turn.turnId === 'turn_thread-second_u')?.joinRule,
    ).toBe('thread');
    await h.run(mention({ invocationId: 'channel-first', messageId: '810000000000000073' }));
    nowMs += 1_000;
    await h.run(
      mention({
        invocationId: 'channel-second',
        messageId: '810000000000000074',
        userId: OTHER_ID,
      }),
    );
    expect(
      conversationRepo
        .listTurns(scope(), 'conv_channel-first')
        .find((turn) => turn.turnId === 'turn_channel-second_u')?.joinRule,
    ).toBe('channel-follow-up');
  });

  it('writes same-channel and thread-parent links once on a retry', async () => {
    const h = harness(() => ({ ok: true, content: 'answer' }));
    await h.run(
      mention({
        channelId: '777777777777777777',
        invocationId: 'parent',
        messageId: '888888888888888888',
      }),
    );
    await h.run(
      mention({
        invocationId: 'another',
        messageId: '810000000000000075',
        input: { question: 'new topic: another' },
      }),
    );
    const input = mention({
      channelId: '888888888888888888',
      threadParentId: '777777777777777777',
      invocationId: 'child',
      messageId: '810000000000000076',
    });
    const first = await h.run(input);
    expect(first.error).toBeUndefined();
    expect(conversationRepo.listLinks(scope(), 'conv_child')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ otherConversationId: 'conv_parent', kind: 'thread-parent' }),
      ]),
    );
    const sameInput = mention({
      invocationId: 'same',
      messageId: '810000000000000077',
      input: { question: 'new topic: separate' },
    });
    const sameFirst = await h.run(sameInput);
    const before = conversationRepo.listLinks(scope(), 'conv_same');
    expect(before.map((link) => link.otherConversationId).sort()).toEqual(['conv_another']);
    const turnsBefore = conversationRepo.listTurns(scope(), 'conv_same').length;
    await h.run(sameInput, sameFirst.cursor);
    expect(conversationRepo.listLinks(scope(), 'conv_same')).toEqual(before);
    expect(conversationRepo.listTurns(scope(), 'conv_same')).toHaveLength(turnsBefore);
    await h.run(input, first.cursor);
    expect(conversationRepo.listLinks(scope(), 'conv_child')).toHaveLength(1);
  });

  it('a re-run after the conversation row exists still writes the new-conversation links exactly once', async () => {
    const h = harness(() => ({ ok: true, content: 'answer' }));
    await h.run(
      mention({
        channelId: '777777777777777777',
        invocationId: 'crash-parent',
        messageId: '888888888888888888',
      }),
    );
    // Simulate a crash after the row write but before the links: the row
    // exists, the links do not.
    conversationRepo.createConversation(scope(), {
      conversationId: 'conv_crash-child',
      channelId: '888888888888888888',
      behaviourId: behaviour.id,
      startedBy: AMA,
      title: 'crashed run',
      source: 'discord',
      at: NOW,
    });
    const input = mention({
      channelId: '888888888888888888',
      threadParentId: '777777777777777777',
      invocationId: 'crash-child',
      messageId: '810000000000000078',
    });
    const first = await h.run(input);
    expect(first.error).toBeUndefined();
    expect(conversationRepo.listLinks(scope(), 'conv_crash-child')).toEqual([
      expect.objectContaining({
        otherConversationId: 'conv_crash-parent',
        kind: 'thread-parent',
      }),
    ]);
    await h.run(input, first.cursor);
    expect(conversationRepo.listLinks(scope(), 'conv_crash-child')).toHaveLength(1);
  });

  it('writes recalled links for the run detail once, and a retry adds none', async () => {
    conversationRepo.createConversation(scope(), {
      conversationId: 'conv_hit',
      channelId: CHANNEL_ID,
      behaviourId: behaviour.id,
      startedBy: AMA,
      title: 'an earlier conversation',
      source: 'discord',
      at: NOW,
    });
    const h = harness(() => ({
      ok: true as const,
      content: 'answer',
      detail: {
        sections: [],
        history: [],
        attempts: [],
        toolCalls: [],
        usage: {},
        guard: { removed: [] },
        recalled: ['conv_hit'],
      },
    }));
    const input = mention({ invocationId: 'recall', messageId: '810000000000000080' });
    const first = await h.run(input);
    expect(first.error).toBeUndefined();
    // The job tells the service which conversation is being answered, so
    // recall can exclude it.
    expect(h.inputs.at(-1)?.conversationId).toBe('conv_recall');
    expect(conversationRepo.listLinks(scope(), 'conv_recall')).toEqual([
      expect.objectContaining({
        otherConversationId: 'conv_hit',
        kind: 'recalled',
        direction: 'outgoing',
      }),
    ]);
    await h.run(input, first.cursor);
    expect(conversationRepo.listLinks(scope(), 'conv_recall')).toHaveLength(1);
  });

  it('a thread-rule resolution resumes from the cursor after a post-invoke failure', async () => {
    const h = harness(() => ({ ok: true, content: 'answer' }));
    // Seed the thread channel with a bot reply so the next message resolves by the thread rule.
    await h.run(
      mention({
        channelId: '888888888888888888',
        invocationId: 'thread-seed',
        messageId: '810000000000000071',
        threadParentId: CHANNEL_ID,
      }),
    );
    const input = mention({
      channelId: '888888888888888888',
      invocationId: 'thread-retry',
      messageId: '810000000000000072',
      threadParentId: CHANNEL_ID,
      userId: OTHER_ID,
    });

    // The first attempt invokes, saves invoke-done, then fails posting the answer.
    h.send.mockRejectedValueOnce(new Error('discord 500'));
    const attempt1 = await h.run(input);
    expect(attempt1.error).toBeInstanceOf(Error);
    expect(attempt1.cursor).not.toBeNull();
    const invokesAfterAttempt1 = h.inputs.length;

    // The saved cursor carries the thread-rule resolution: with the old
    // hard-coded enum this parse threw and the retry started over.
    const saved = assistantInvokeCursor.parse(JSON.parse(attempt1.cursor as string));
    expect(saved.resolution).toEqual({
      kind: 'continue',
      conversationId: expect.any(String),
      rule: 'thread',
    });

    // The retry resumes from that cursor: no second invoke, the answer posts.
    const sentBefore = h.sent.length;
    const attempt2 = await h.run(input, attempt1.cursor);
    expect(attempt2.error).toBeUndefined();
    expect(h.inputs).toHaveLength(invokesAfterAttempt1);
    expect(h.sent.length).toBeGreaterThan(sentBefore);
    expect(h.sent.at(-1)?.message.content).toBe('answer');
  });

  it('posts a mention answer as a reply; a 4,500-character answer posts 3 parts, only the first with replyTo', async () => {
    const h = harness(() => ({ ok: true, content: 'x'.repeat(4_500) }));
    await h.run(mention({ invocationId: 'inv-parts', messageId: '810000000000000011' }));

    expect(h.sent).toHaveLength(3);
    expect(h.sent[0]?.message).toMatchObject({
      replyTo: '810000000000000011',
      allowedMentions: { parse: [] },
    });
    expect(h.sent[0]?.message.content).toHaveLength(2_000);
    expect(h.sent[1]?.message).not.toHaveProperty('replyTo');
    expect(h.sent[2]?.message).not.toHaveProperty('replyTo');
    for (const part of h.sent) {
      expect(part.message.allowedMentions).toEqual({ parse: [] });
    }
  });

  it('a crash after part 1 resumes with parts 2-3 only and never re-calls the provider', async () => {
    let providerCalls = 0;
    const h = harness(() => {
      providerCalls += 1;
      return { ok: true, content: 'x'.repeat(4_500) };
    });
    const successful: string[] = [];
    let sends = 0;
    h.send.mockImplementation(async (channelId: string, message: OutgoingMessage) => {
      sends += 1;
      const id = `8290000000000001${String(sends).padStart(2, '0')}`;
      if (sends === 2) throw new Error('discord 500');
      successful.push(String(message.content));
      return { channelId, messageId: id };
    });
    const payload = mention({ invocationId: 'inv-crash', messageId: '810000000000000012' });

    const attempt1 = await h.run(payload);
    expect(attempt1.error).toBeInstanceOf(Error);
    expect(providerCalls).toBe(1);

    const attempt2 = await h.run(payload, attempt1.cursor);
    expect(attempt2.error).toBeUndefined();
    expect(providerCalls).toBe(1);
    // Part 1 posted once, parts 2-3 posted on the retry: three contents, each once.
    expect(successful).toHaveLength(3);
    expect(successful.map((part) => part.length)).toEqual([2_000, 2_000, 500]);
    const trace = traceRepo.getTrace(scope(), 'trace_inv-crash');
    expect(trace?.discordMessageIds).toHaveLength(3);
    expect(new Set(trace?.discordMessageIds).size).toBe(3);
  });

  it('a follow-up carries the first question and answer as history', async () => {
    const h = harness((input) => ({
      ok: true,
      content: `answer to ${String((input.input as Record<string, string>).question)}`,
    }));
    await h.run(
      mention({
        invocationId: 'inv-f1',
        messageId: '810000000000000013',
        input: { question: 'first question' },
      }),
    );
    nowMs += 5 * 60_000;
    await h.run(
      mention({
        invocationId: 'inv-f2',
        messageId: '810000000000000014',
        input: { question: 'second question' },
      }),
    );

    expect(h.inputs).toHaveLength(2);
    const history = h.inputs[1]?.history ?? [];
    expect(history[0]?.text).toMatch(/^\[Ama, .+\] first question$/);
    expect(history[1]?.text).toBe('answer to first question');
  });

  it('passes the payload authorName to the service as askerName', async () => {
    const h = harness(() => ({ ok: true, content: 'hello' }));
    await h.run(
      mention({
        invocationId: 'inv-asker',
        messageId: '810000000000000030',
        input: { question: 'first question' },
      }),
    );
    expect(h.inputs[0]?.askerName).toBe('Ama');
  });

  it('never stores or prints a bare user id as a speaker name', async () => {
    // A 19-digit id that passes the Luhn check, so the outbound card-number
    // detector would flag it if it ever reached a provider request as a name.
    const luhnDigit = (prefix: string): string => {
      for (let digit = 0; digit <= 9; digit += 1) {
        const candidate = `${prefix}${String(digit)}`;
        let sum = 0;
        let double = false;
        for (let index = candidate.length - 1; index >= 0; index -= 1) {
          let value = candidate.charCodeAt(index) - 48;
          if (double) {
            value *= 2;
            if (value > 9) value -= 9;
          }
          sum += value;
          double = !double;
        }
        if (sum % 10 === 0) return String(digit);
      }
      throw new Error('no Luhn digit found');
    };
    const cardShapedId = `411111111111111111${luhnDigit('411111111111111111')}`;
    expect(cardShapedId).toMatch(/^\d{19}$/);
    const luhnValid = (digits: string): boolean => {
      let sum = 0;
      let double = false;
      for (let index = digits.length - 1; index >= 0; index -= 1) {
        let value = digits.charCodeAt(index) - 48;
        if (double) {
          value *= 2;
          if (value > 9) value -= 9;
        }
        sum += value;
        double = !double;
      }
      return sum % 10 === 0;
    };
    expect(luhnValid(cardShapedId)).toBe(true);

    const h = harness((input) => ({
      ok: true,
      content: `answer to ${String((input.input as Record<string, string>).question)}`,
    }));
    const withoutName = (over: Record<string, unknown>): Record<string, unknown> => {
      const { authorName: _dropped, ...rest } = mention(over);
      void _dropped;
      return { ...rest, userId: cardShapedId };
    };
    await h.run(
      withoutName({
        invocationId: 'inv-noid-1',
        messageId: '810000000000000041',
        input: { question: 'first question' },
      }),
    );
    nowMs += 5 * 60_000;
    await h.run(
      withoutName({
        invocationId: 'inv-noid-2',
        messageId: '810000000000000042',
        input: { question: 'second question' },
      }),
    );

    expect(h.inputs).toHaveLength(2);
    const history = h.inputs[1]?.history ?? [];
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((message) => !/\d{17,}/.test(message.text))).toBe(true);
    const request = {
      model: 'test-model',
      systemInstruction: '',
      messages: [...history, { role: 'user' as const, text: 'second question' }],
    };
    expect(scanOutboundRequest(request).safe).toBe(true);
  });

  it('a reply by another member to the bot answer continues the conversation with both speakers labelled', async () => {
    const h = harness((input) => ({
      ok: true,
      content: `answer to ${String((input.input as Record<string, string>).question)}`,
    }));
    await h.run(
      mention({
        invocationId: 'inv-r1',
        messageId: '810000000000000015',
        input: { question: 'first question' },
      }),
    );
    const postedId = (await h.send.mock.results[0]?.value) as DiscordMessageRef;
    await h.run(
      mention({
        invocationId: 'inv-r2',
        messageId: '810000000000000016',
        userId: BO,
        authorName: 'Bo',
        referencedMessageId: postedId.messageId,
        referencedAuthorId: BOT_ID,
        input: { question: 'and parking?' },
      }),
    );

    const first = conversationRepo.lookupMessage(scope(), '810000000000000015');
    const second = conversationRepo.lookupMessage(scope(), '810000000000000016');
    expect(second?.conversationId).toBe(first?.conversationId);
    const secondInput = h.inputs[1];
    const history = secondInput?.history ?? [];
    expect(history[0]?.text).toMatch(/^\[Ama, .+\] first question$/);
    // The just-written user turn is not history: the model gets the current
    // question exactly once, as the request's user text.
    expect(history.at(-1)?.text).toBe('answer to first question');
    expect(history.every((message) => !message.text.includes('and parking?'))).toBe(true);
    expect(secondInput?.input).toEqual({ question: 'and parking?' });
  });

  it('a quoted reply carries the untrusted envelope with the author name', async () => {
    const h = harness(() => ({ ok: true, content: 'yes, that is right' }));
    h.fetchMessageContent.mockResolvedValue({
      authorId: OTHER_ID,
      authorName: 'Alex',
      content: 'the hall opens at seven',
    });
    await h.run(
      mention({
        invocationId: 'inv-q',
        messageId: '810000000000000017',
        referencedMessageId: '840000000000000001',
        referencedAuthorId: OTHER_ID,
        input: { question: 'is that right?' },
      }),
    );

    expect(h.fetchMessageContent).toHaveBeenCalledWith(CHANNEL_ID, '840000000000000001');
    expect(h.inputs[0]?.quoteEnvelope).toBe(
      '[UNTRUSTED QUOTED MESSAGE author="Alex"]\nthe hall opens at seven\n[/UNTRUSTED QUOTED MESSAGE]',
    );
  });

  it('a quoted reply stores the quote as a turn once, even on retry', async () => {
    const h = harness(() => ({ ok: true, content: 'yes, that is right' }));
    h.fetchMessageContent.mockResolvedValue({
      authorId: OTHER_ID,
      authorName: 'Alex',
      content: 'the hall opens at seven',
    });
    const input = mention({
      invocationId: 'inv-qs',
      messageId: '810000000000000027',
      referencedMessageId: '840000000000000011',
      referencedAuthorId: OTHER_ID,
      input: { question: 'is that right?' },
    });
    await h.run(input);
    await h.run(input);

    const conversationId = conversationRepo.lookupMessage(
      scope(),
      '810000000000000027',
    )?.conversationId;
    expect(conversationId).toBeDefined();
    const turns = conversationRepo.listTurns(scope(), conversationId!);
    expect(turns.filter((turn) => turn.role === 'quote')).toHaveLength(1);
    expect(turns.find((turn) => turn.role === 'quote')).toMatchObject({
      authorId: OTHER_ID,
      authorName: 'Alex',
      text: 'the hall opens at seven',
    });
    expect(turns.filter((turn) => turn.role === 'user')).toHaveLength(1);
  });

  it('a follow-up in a quoted conversation carries the pinned quote as an untrusted envelope', async () => {
    const h = harness((input) => ({
      ok: true,
      content: `answer to ${String((input.input as Record<string, string>).question)}`,
    }));
    h.fetchMessageContent.mockResolvedValue({
      authorId: OTHER_ID,
      authorName: 'Alex',
      content: 'the hall opens at seven',
    });
    await h.run(
      mention({
        invocationId: 'inv-qq1',
        messageId: '810000000000000028',
        referencedMessageId: '840000000000000012',
        referencedAuthorId: OTHER_ID,
        input: { question: 'is that right?' },
      }),
    );
    nowMs += 5 * 60_000;
    await h.run(
      mention({
        invocationId: 'inv-qq2',
        messageId: '810000000000000029',
        input: { question: 'what about Friday?' },
      }),
    );

    const history = h.inputs[1]?.history ?? [];
    expect(history[0]).toEqual({
      role: 'user',
      text: '[UNTRUSTED QUOTED MESSAGE author="Alex"]\nthe hall opens at seven\n[/UNTRUSTED QUOTED MESSAGE]',
    });
    expect(
      history.every((message) => message.role === 'user' || message.role === 'assistant'),
    ).toBe(true);
    const conversationId = conversationRepo.lookupMessage(
      scope(),
      '810000000000000029',
    )?.conversationId;
    expect(
      conversationRepo
        .listTurns(scope(), conversationId!)
        .some((turn) => turn.role === 'quote' && turn.text === 'the hall opens at seven'),
    ).toBe(true);
  });

  it('a follow-up in a quoted conversation passes quoteInHistory to the service', async () => {
    const h = harness((input) => ({
      ok: true,
      content: `answer to ${String((input.input as Record<string, string>).question)}`,
    }));
    h.fetchMessageContent.mockResolvedValue({
      authorId: OTHER_ID,
      authorName: 'Alex',
      content: 'the hall opens at seven',
    });
    await h.run(
      mention({
        invocationId: 'inv-qh1',
        messageId: '810000000000000031',
        referencedMessageId: '840000000000000013',
        referencedAuthorId: OTHER_ID,
        input: { question: 'is that right?' },
      }),
    );
    nowMs += 5 * 60_000;
    await h.run(
      mention({
        invocationId: 'inv-qh2',
        messageId: '810000000000000032',
        input: { question: 'what about Friday?' },
      }),
    );

    expect(h.inputs).toHaveLength(2);
    expect(h.inputs[1]?.history?.[0]).toEqual({
      role: 'user',
      text: '[UNTRUSTED QUOTED MESSAGE author="Alex"]\nthe hall opens at seven\n[/UNTRUSTED QUOTED MESSAGE]',
    });
    expect(h.inputs[1]?.quoteInHistory).toBe(true);
  });

  it('a quote fetch failure still posts the answer and flags the trace quote-unavailable', async () => {
    const h = harness(() => ({ ok: true, content: 'answered without the quote' }));
    h.fetchMessageContent.mockRejectedValue(new Error('discord 403'));
    await h.run(
      mention({
        invocationId: 'inv-qf',
        messageId: '810000000000000018',
        referencedMessageId: '840000000000000002',
        referencedAuthorId: OTHER_ID,
      }),
    );

    expect(h.sent).toHaveLength(1);
    expect(traceRepo.getTrace(scope(), 'trace_inv-qf')?.flags).toContain('quote-unavailable');
  });

  /** ADR 0089: the channel-context window around a mention. */
  const channelMessage = (over: Partial<RecentMessage> = {}): RecentMessage => ({
    messageId: '820000000000000001',
    authorId: OTHER_ID,
    authorName: 'Alex',
    authorIsBot: false,
    content: 'the hall opens at seven',
    at: NOW - 60_000,
    hasAttachments: false,
    ...over,
  });

  it('a mention fetches the channel window and passes it to the service', async () => {
    const h = harness(() => ({ ok: true, content: 'answer' }));
    h.channelContextMessages.mockReturnValue(15);
    h.fetchChannelMessages.mockResolvedValue([
      channelMessage(),
      channelMessage({ messageId: '820000000000000002', content: 'and parking is free' }),
    ]);
    await h.run(mention({ invocationId: 'inv-cc1', messageId: '810000000000000051' }));

    expect(h.fetchChannelMessages).toHaveBeenCalledWith(CHANNEL_ID, {
      before: '810000000000000051',
      limit: 15,
    });
    const input = h.inputs[0];
    expect(input?.channelContext).toContain('[UNTRUSTED CHANNEL MESSAGES]');
    expect(input?.channelContext).toContain('the hall opens at seven');
    expect(input?.channelContext).toContain('and parking is free');
    expect(input?.channelMessages).toBe(2);
  });

  it('channel context excludes the invoking message and already-linked messages', async () => {
    const h = harness(() => ({ ok: true, content: 'answer' }));
    h.channelContextMessages.mockReturnValue(15);
    await h.run(mention({ invocationId: 'inv-cc2a', messageId: '810000000000000052' }));
    h.fetchChannelMessages.mockResolvedValue([
      // Already linked to this conversation by the first run: excluded.
      channelMessage({ messageId: '810000000000000052', content: 'first question' }),
      channelMessage({ messageId: '820000000000000003', content: 'something earlier' }),
      // The invoking message itself: excluded.
      channelMessage({ messageId: '810000000000000053', content: 'second question' }),
    ]);
    nowMs += 1_000;
    await h.run(
      mention({
        invocationId: 'inv-cc2b',
        messageId: '810000000000000053',
        input: { question: 'second question' },
      }),
    );

    const input = h.inputs[1];
    expect(input?.channelContext).toContain('something earlier');
    expect(input?.channelContext).not.toContain('first question');
    expect(input?.channelContext).not.toContain('second question');
    expect(input?.channelMessages).toBe(1);
  });

  it('a zero window turns channel context off without fetching', async () => {
    const h = harness(() => ({ ok: true, content: 'answer' }));
    h.channelContextMessages.mockReturnValue(0);
    await h.run(mention({ invocationId: 'inv-cc3', messageId: '810000000000000054' }));

    expect(h.fetchChannelMessages).not.toHaveBeenCalled();
    expect(h.inputs[0]?.channelContext).toBeUndefined();
    expect(h.inputs[0]?.channelMessages).toBeUndefined();
  });

  it('a mention passes the oldest window id as the channel-history default', async () => {
    const h = harness(() => ({ ok: true, content: 'answer' }));
    h.channelContextMessages.mockReturnValue(15);
    h.fetchChannelMessages.mockResolvedValue([
      channelMessage({ messageId: '820000000000000001' }),
      channelMessage({ messageId: '820000000000000002', content: 'and parking is free' }),
    ]);
    await h.run(mention({ invocationId: 'inv-cc6', messageId: '810000000000000058' }));

    expect(h.inputs[0]?.channelContextOldestId).toBe('820000000000000001');
  });

  it('no window means no channel-history default', async () => {
    const h = harness(() => ({ ok: true, content: 'answer' }));
    h.channelContextMessages.mockReturnValue(0);
    await h.run(mention({ invocationId: 'inv-cc7', messageId: '810000000000000059' }));

    expect(h.inputs[0]?.channelContextOldestId).toBeUndefined();
  });

  it('a slash command never fetches channel context', async () => {
    const h = harness(() => ({ ok: true, content: 'answer' }));
    h.channelContextMessages.mockReturnValue(15);
    await h.run(
      mention({
        invocationId: 'inv-cc4',
        messageId: '810000000000000055',
        source: 'slash-command',
      }),
    );

    expect(h.fetchChannelMessages).not.toHaveBeenCalled();
    expect(h.inputs[0]?.channelContext).toBeUndefined();
  });

  it('a channel fetch failure still posts the answer and flags the trace', async () => {
    for (const failure of [undefined, new Error('discord 403')] as const) {
      const h = harness(() => ({ ok: true, content: 'answered without context' }));
      h.channelContextMessages.mockReturnValue(15);
      if (failure === undefined) h.fetchChannelMessages.mockResolvedValue(undefined);
      else h.fetchChannelMessages.mockRejectedValue(failure);
      const invocationId = failure === undefined ? 'inv-cc5a' : 'inv-cc5b';
      const messageId = failure === undefined ? '810000000000000056' : '810000000000000057';
      await h.run(mention({ invocationId, messageId }));

      expect(h.sent).toHaveLength(1);
      expect(traceRepo.getTrace(scope(), `trace_${invocationId}`)?.flags).toContain(
        'channel-context-unavailable',
      );
      expect(h.inputs[0]?.channelContext).toBeUndefined();
    }
  });

  it('a retry past invoke-done does not fetch channel context again', async () => {
    const h = harness(() => ({ ok: true, content: 'answer' }));
    h.channelContextMessages.mockReturnValue(15);
    h.fetchChannelMessages.mockResolvedValue([channelMessage()]);
    const input = mention({ invocationId: 'inv-cc6', messageId: '810000000000000058' });
    const first = await h.run(input);
    await h.run(input, first.cursor);

    expect(h.fetchChannelMessages).toHaveBeenCalledTimes(1);
  });

  it('in a thread the starter comes first, labelled as the thread start', async () => {
    const h = harness(() => ({ ok: true, content: 'answer' }));
    h.channelContextMessages.mockReturnValue(15);
    h.fetchChannelMessages.mockResolvedValue([channelMessage()]);
    h.fetchMessageContent.mockResolvedValue({
      authorId: OTHER_ID,
      authorName: 'Alex',
      content: 'the opening post',
    });
    await h.run(
      mention({
        channelId: '888888888888888888',
        invocationId: 'inv-cc7',
        messageId: '810000000000000059',
        threadParentId: CHANNEL_ID,
      }),
    );

    expect(h.fetchMessageContent).toHaveBeenCalledWith(CHANNEL_ID, '888888888888888888');
    const block = h.inputs[0]?.channelContext ?? '';
    const starterAt = block.indexOf('the opening post');
    const otherAt = block.indexOf('the hall opens at seven');
    expect(starterAt).toBeGreaterThanOrEqual(0);
    expect(otherAt).toBeGreaterThan(starterAt);
    expect(block).toContain(', started this thread');
    expect(h.inputs[0]?.channelMessages).toBe(2);
  });

  it('in a thread a missing starter falls back to the thread channel itself', async () => {
    const h = harness(() => ({ ok: true, content: 'answer' }));
    h.channelContextMessages.mockReturnValue(15);
    h.fetchChannelMessages.mockResolvedValue([]);
    h.fetchMessageContent
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ authorId: OTHER_ID, authorName: 'Alex', content: 'forum opener' });
    await h.run(
      mention({
        channelId: '888888888888888888',
        invocationId: 'inv-cc8',
        messageId: '810000000000000060',
        threadParentId: CHANNEL_ID,
      }),
    );

    expect(h.fetchMessageContent).toHaveBeenNthCalledWith(1, CHANNEL_ID, '888888888888888888');
    expect(h.fetchMessageContent).toHaveBeenNthCalledWith(
      2,
      '888888888888888888',
      '888888888888888888',
    );
    expect(h.inputs[0]?.channelContext).toContain('forum opener');
  });

  it('in a thread an unavailable starter still posts the answer with the flag', async () => {
    const h = harness(() => ({ ok: true, content: 'answered without the starter' }));
    h.channelContextMessages.mockReturnValue(15);
    h.fetchChannelMessages.mockResolvedValue([channelMessage()]);
    h.fetchMessageContent.mockResolvedValue(undefined);
    await h.run(
      mention({
        channelId: '888888888888888888',
        invocationId: 'inv-cc9',
        messageId: '810000000000000061',
        threadParentId: CHANNEL_ID,
      }),
    );

    expect(h.sent).toHaveLength(1);
    expect(traceRepo.getTrace(scope(), 'trace_inv-cc9')?.flags).toContain(
      'channel-context-unavailable',
    );
    // The channel window itself still reaches the service.
    expect(h.inputs[0]?.channelContext).toContain('the hall opens at seven');
  });

  /** ADR 0126: Read gates live fetches, Write gates the reply. */
  const fakeAccess = (
    denied: Partial<Record<'read' | 'write', 'no-access' | 'not-granted'>>,
  ): Pick<ChannelAccess, 'check'> => ({
    check: async (purpose) => {
      const reason = purpose === 'read' || purpose === 'write' ? denied[purpose] : undefined;
      return reason === undefined
        ? { allowed: true, grantedBy: 'grant' }
        : { allowed: false, reason };
    },
  });

  it('a mention in a Write-denied channel never invokes nor sends', async () => {
    const h = harness(
      () => ({ ok: true, content: 'answer' }),
      fakeAccess({ write: 'not-granted' }),
    );
    await h.run(mention({ invocationId: 'inv-wd', messageId: '810000000000000062' }));

    expect(h.inputs).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a mention run before the guild is cached retries instead of being skipped (R1)', async () => {
    let ready = false;
    const unknown: Pick<ChannelAccess, 'check'> = {
      check: async () =>
        ready
          ? { allowed: true, grantedBy: 'grant' }
          : { allowed: false, reason: 'unknown-channel' },
    };
    const h = harness(
      () => ({ ok: true, content: 'answer' }),
      unknown,
      () => ready,
    );
    const first = await h.run(mention({ invocationId: 'inv-nr', messageId: '810000000000000064' }));

    expect(first.error).toBeInstanceOf(RetryAfterError);
    expect(h.inputs).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();

    ready = true;
    await h.run(mention({ invocationId: 'inv-nr', messageId: '810000000000000064' }), first.cursor);
    expect(h.inputs).toHaveLength(1);
    expect(h.send).toHaveBeenCalled();
  });

  it('a mention in a No-access channel never invokes nor sends', async () => {
    const h = harness(() => ({ ok: true, content: 'answer' }), fakeAccess({ write: 'no-access' }));
    await h.run(mention({ invocationId: 'inv-na', messageId: '810000000000000063' }));

    expect(h.inputs).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a retry after Write is turned off posts nothing', async () => {
    let writeDenied = false;
    const access: Pick<ChannelAccess, 'check'> = {
      check: async (purpose) =>
        purpose === 'write' && writeDenied
          ? { allowed: false as const, reason: 'not-granted' as const }
          : { allowed: true as const, grantedBy: 'grant' },
    };
    const h = harness(() => ({ ok: true, content: 'answer' }), access);
    // Attempt 1 invokes, then the delivery throw leaves the cursor at
    // `invoke-done` with nothing posted.
    h.send.mockRejectedValueOnce(new Error('delivery boom'));
    const first = await h.run(
      mention({ invocationId: 'inv-retry-wo', messageId: '810000000000000066' }),
    );
    expect(first.error).toBeInstanceOf(Error);
    expect(first.cursor).not.toBeNull();
    expect(h.sent).toHaveLength(0);
    // Write is turned off before the retry: the staged answer must stay
    // unposted rather than landing late in a channel it may not enter.
    writeDenied = true;
    const second = await h.run(
      mention({ invocationId: 'inv-retry-wo', messageId: '810000000000000066' }),
      first.cursor,
    );
    expect(second.error).toBeUndefined();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveLength(0);
  });

  it('(F2a) a delivery retry after Write is turned off closes the run refused with channel-not-writable', async () => {
    let writeDenied = false;
    const access: Pick<ChannelAccess, 'check'> = {
      check: async (purpose) =>
        purpose === 'write' && writeDenied
          ? { allowed: false as const, reason: 'not-granted' as const }
          : { allowed: true as const, grantedBy: 'grant' },
    };
    const h = harness(() => ({ ok: true, content: 'answer' }), access);
    const key = 'inv-retry-wo-ledger';
    const messageId = '810000000000000067';
    h.send.mockRejectedValueOnce(new Error('delivery boom'));
    const first = await h.run(mention({ invocationId: key, messageId }));
    expect(first.error).toBeInstanceOf(Error);
    expect(first.cursor).not.toBeNull();
    expect(h.sent).toHaveLength(0);
    writeDenied = true;
    const second = await h.run(mention({ invocationId: key, messageId }), first.cursor);
    expect(second.error).toBeUndefined();
    expect(h.sent).toHaveLength(0);
    expect(runRepo.getRun(scope(), key)).toMatchObject({ state: 'refused' });
    const finished = runRepo
      .listRunEvents(scope(), key, 0, 50)
      .find((r) => r.event.kind === 'finished')?.event;
    expect(finished).toMatchObject({ outcome: 'refused', code: 'channel-not-writable' });
  });

  it('a mention in a Read-denied channel skips the window and the thread starter, still answers, and flags the trace', async () => {
    const h = harness(
      () => ({ ok: true, content: 'answered without context' }),
      fakeAccess({ read: 'not-granted' }),
    );
    h.channelContextMessages.mockReturnValue(15);
    h.fetchChannelMessages.mockResolvedValue([channelMessage()]);
    h.fetchMessageContent.mockResolvedValue({
      authorId: OTHER_ID,
      authorName: 'Alex',
      content: 'the opening post',
    });
    await h.run(
      mention({
        channelId: '888888888888888888',
        invocationId: 'inv-rd',
        messageId: '810000000000000064',
        threadParentId: CHANNEL_ID,
      }),
    );

    expect(h.fetchChannelMessages).not.toHaveBeenCalled();
    expect(h.fetchMessageContent).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(1);
    expect(h.inputs[0]?.channelContext).toBeUndefined();
    expect(traceRepo.getTrace(scope(), 'trace_inv-rd')?.flags).toContain('channel-context-denied');
  });

  it('a mention in a Read-denied channel still fetches the quoted message', async () => {
    const h = harness(
      () => ({ ok: true, content: 'yes, that is right' }),
      fakeAccess({ read: 'no-access' }),
    );
    h.fetchMessageContent.mockResolvedValue({
      authorId: OTHER_ID,
      authorName: 'Alex',
      content: 'the hall opens at seven',
    });
    await h.run(
      mention({
        invocationId: 'inv-rq',
        messageId: '810000000000000065',
        referencedMessageId: '840000000000000021',
        referencedAuthorId: OTHER_ID,
        input: { question: 'is that right?' },
      }),
    );

    expect(h.fetchMessageContent).toHaveBeenCalledWith(CHANNEL_ID, '840000000000000021');
    expect(h.inputs[0]?.quoteEnvelope).toContain('the hall opens at seven');
    expect(h.sent).toHaveLength(1);
  });

  it('/ask links the respond message id so a later reply continues the conversation', async () => {
    const h = harness((input) => ({
      ok: true,
      content: `answer to ${String((input.input as Record<string, string>).question)}`,
    }));
    const openToken = vi.fn((sealed: string): string | undefined =>
      sealed === 'sealed-7' ? 'tok-7' : undefined,
    );
    const slashHandler = assistantInvokeHandler({
      guildId: GUILD_ID,
      service: {
        behavioursForGuild: async () => [behaviour],
        invoke: async (input) => {
          h.inputs.push(input);
          return {
            ok: true,
            content: `answer to ${String((input.input as Record<string, string>).question)}`,
          };
        },
      },
      openToken,
      respond: h.respond,
      send: h.send,
      logger: pino({ level: 'silent' }),
      logChannelId: () => undefined,
      now: () => nowMs,
      conversations: { scope: scope(), botUserId: BOT_ID, botDisplayName: 'bananasaurs' },
      sendTyping: h.sendTyping,
      fetchMessageContent: h.fetchMessageContent,
    });
    await slashHandler.run(
      slashHandler.payload.parse({
        channelId: CHANNEL_ID,
        userId: AMA,
        callerRoleIds: [],
        behaviourId: behaviour.id,
        command: 'ask',
        input: { question: 'slash question' },
        source: 'slash-command',
        interaction: { interactionId: 'int-7', sealedToken: 'sealed-7' },
        invocationId: 'int-7',
        authorName: 'Ama',
      }),
      { jobId: 1, attempts: 1, cursor: null, saveCursor: () => undefined },
    );

    expect(h.respond).toHaveBeenCalledTimes(1);
    const ref = (await h.respond.mock.results[0]?.value) as DiscordMessageRef;
    expect(conversationRepo.lookupMessage(scope(), ref.messageId)?.role).toBe('assistant');

    await h.run(
      mention({
        invocationId: 'inv-q7',
        messageId: '810000000000000019',
        userId: BO,
        authorName: 'Bo',
        referencedMessageId: ref.messageId,
        referencedAuthorId: BOT_ID,
        input: { question: 'tell me more' },
      }),
    );
    const history = h.inputs.at(-1)?.history ?? [];
    expect(history[0]?.text).toContain('slash question');
    expect(conversationRepo.lookupMessage(scope(), '810000000000000019')?.conversationId).toBe(
      conversationRepo.lookupMessage(scope(), ref.messageId)?.conversationId,
    );
  });

  it('writes a trace with outcome, attempts, sections and discord message ids', async () => {
    const h = harness(() => ({
      ok: true,
      content: 'short answer',
      detail: {
        sections: [
          { name: 'behaviour-prompt', chars: 3, estTokens: 1, text: 'sys' },
          { name: 'history', chars: 8, estTokens: 2, text: 'user: hi' },
        ],
        attempts: [{ provider: 'gemini', model: 'm', outcome: 'ok', ms: 5 }],
        toolCalls: [],
        usage: {},
        guard: { removed: [] },
        history: [],
      },
    }));
    await h.run(mention({ invocationId: 'inv-t', messageId: '810000000000000020' }));

    const trace = traceRepo.getTrace(scope(), 'trace_inv-t');
    expect(trace).toMatchObject({ outcome: 'answered' });
    expect(trace?.attempts).toHaveLength(1);
    expect(trace?.sections.map((section) => section.name)).toEqual(
      expect.arrayContaining(['behaviour-prompt', 'history']),
    );
    expect(trace?.discordMessageIds).toHaveLength(1);
    expect(trace?.conversationId).toBe(
      conversationRepo.lookupMessage(scope(), '810000000000000020')?.conversationId,
    );
  });

  it('a retry from an invoke-done cursor writes the trace with the saved detail and never re-invokes', async () => {
    const h = harness(() => ({
      ok: true,
      content: 'hello',
      detail: {
        sections: [
          { name: 'behaviour-prompt', chars: 3, estTokens: 1, text: 'sys' },
          { name: 'history', chars: 8, estTokens: 2, text: 'user: hi' },
        ],
        history: [],
        attempts: [{ provider: 'gemini', model: 'm', outcome: 'ok', ms: 5 }],
        toolCalls: [{ round: 1, name: 'search_sources', args: {}, ok: true, ms: 2, preview: 'p' }],
        usage: { promptTokens: 10, completionTokens: 5 },
        guard: { removed: ['phone'] },
      },
    }));
    const input = mention({ invocationId: 'inv-retry-detail', messageId: '810000000000000022' });

    // The first attempt invokes, saves invoke-done, then fails posting the answer.
    h.send.mockRejectedValueOnce(new Error('discord 500'));
    const attempt1 = await h.run(input);
    expect(attempt1.error).toBeInstanceOf(Error);
    expect(h.inputs).toHaveLength(1);
    expect(attempt1.cursor).not.toBeNull();

    // The retry resumes from that cursor: no second invoke, full trace.
    const attempt2 = await h.run(input, attempt1.cursor);
    expect(attempt2.error).toBeUndefined();
    expect(h.inputs).toHaveLength(1);

    const trace = traceRepo.getTrace(scope(), 'trace_inv-retry-detail');
    expect(trace?.outcome).toBe('answered');
    expect(trace?.sections.map((section) => section.name)).toEqual(['behaviour-prompt', 'history']);
    expect(trace?.attempts).toHaveLength(1);
    expect(trace?.attempts[0]).toMatchObject({ provider: 'gemini', model: 'm' });
    expect(trace?.toolCalls).toHaveLength(1);
    expect(trace?.toolCalls[0]).toMatchObject({ name: 'search_sources' });
    expect(trace?.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(trace?.guard).toEqual({ removed: ['phone'] });
  });

  it('writes included from the detail into the stored trace', async () => {
    const h = harness(() => ({
      ok: true,
      content: 'short answer',
      detail: {
        sections: [{ name: 'behaviour-prompt', chars: 3, estTokens: 1, text: 'sys' }],
        attempts: [{ provider: 'gemini', model: 'm', outcome: 'ok', ms: 5 }],
        toolCalls: [],
        usage: {},
        guard: { removed: [] },
        history: [],
        included: {
          toolsOffered: ['search_sources'],
          snippetChunkIds: ['c_1'],
          quote: true,
          historyTurns: 2,
        },
      },
    }));
    await h.run(mention({ invocationId: 'inv-included', messageId: '810000000000000024' }));

    expect(traceRepo.getTrace(scope(), 'trace_inv-included')?.included).toEqual({
      toolsOffered: ['search_sources'],
      snippetChunkIds: ['c_1'],
      quote: true,
      historyTurns: 2,
    });
  });

  it('a retry from an invoke-done cursor keeps the saved included', async () => {
    const h = harness(() => ({
      ok: true,
      content: 'hello',
      detail: {
        sections: [{ name: 'behaviour-prompt', chars: 3, estTokens: 1, text: 'sys' }],
        history: [],
        attempts: [{ provider: 'gemini', model: 'm', outcome: 'ok', ms: 5 }],
        toolCalls: [],
        usage: {},
        guard: { removed: [] },
        included: {
          toolsOffered: ['search_sources'],
          snippetChunkIds: ['c_1'],
          quote: false,
          historyTurns: 1,
        },
      },
    }));
    const input = mention({ invocationId: 'inv-retry-included', messageId: '810000000000000025' });

    // The first attempt invokes, saves invoke-done, then fails posting the answer.
    h.send.mockRejectedValueOnce(new Error('discord 500'));
    const attempt1 = await h.run(input);
    expect(attempt1.error).toBeInstanceOf(Error);
    expect(attempt1.cursor).not.toBeNull();

    // The retry resumes from that cursor: no second invoke, included kept.
    const attempt2 = await h.run(input, attempt1.cursor);
    expect(attempt2.error).toBeUndefined();
    expect(h.inputs).toHaveLength(1);

    expect(traceRepo.getTrace(scope(), 'trace_inv-retry-included')?.included).toEqual({
      toolsOffered: ['search_sources'],
      snippetChunkIds: ['c_1'],
      quote: false,
      historyTurns: 1,
    });
  });

  it('a result flag reaches the stored trace and survives a retry from the cursor', async () => {
    const h = harness(() => ({
      ok: true,
      content: 'answered without resources',
      flags: ['resources-unavailable'],
    }));
    const input = mention({ invocationId: 'inv-rf', messageId: '810000000000000023' });

    // The first attempt invokes, saves invoke-done, then fails posting the answer.
    h.send.mockRejectedValueOnce(new Error('discord 500'));
    const attempt1 = await h.run(input);
    expect(attempt1.error).toBeInstanceOf(Error);
    expect(h.inputs).toHaveLength(1);
    expect(attempt1.cursor).not.toBeNull();

    // The retry resumes from that cursor: no second invoke, flag kept.
    const attempt2 = await h.run(input, attempt1.cursor);
    expect(attempt2.error).toBeUndefined();
    expect(h.inputs).toHaveLength(1);
    expect(traceRepo.getTrace(scope(), 'trace_inv-rf')?.flags).toContain('resources-unavailable');
  });

  it('a typing failure never fails the job', async () => {
    const h = harness(() => ({ ok: true, content: 'hello' }));
    h.sendTyping.mockRejectedValue(new Error('typing failed'));
    await expect(
      h.run(mention({ invocationId: 'inv-ty', messageId: '810000000000000021' })),
    ).resolves.toBeDefined();
    expect(h.sent).toHaveLength(1);
  });

  it('keeps typing alive while invoke is pending and stops when it resolves', async () => {
    vi.useFakeTimers();
    try {
      let resolveInvoke!: (result: AssistantInvocationResult) => void;
      const h = harness(
        () =>
          new Promise<AssistantInvocationResult>((resolve) => {
            resolveInvoke = resolve;
          }),
      );
      const running = h.run(mention({ invocationId: 'inv-slow', messageId: '810000000000000030' }));
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sendTyping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(h.sendTyping).toHaveBeenCalledTimes(2);
      resolveInvoke({ ok: true, content: 'slow answer' });
      await running;
      await vi.advanceTimersByTimeAsync(16_000);
      expect(h.sendTyping).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops typing when invoke throws and a rejected typing send does not fail the job', async () => {
    vi.useFakeTimers();
    try {
      let rejectInvoke!: (error: Error) => void;
      const h = harness(
        () =>
          new Promise<AssistantInvocationResult>((_, reject) => {
            rejectInvoke = reject;
          }),
      );
      h.sendTyping.mockRejectedValue(new Error('typing failed'));
      const running = h.run(
        mention({ invocationId: 'inv-throw', messageId: '810000000000000031' }),
      );
      await vi.advanceTimersByTimeAsync(1);
      rejectInvoke(new Error('invoke failed'));
      await running;
      const calls = h.sendTyping.mock.calls.length;
      await vi.advanceTimersByTimeAsync(16_000);
      expect(h.sendTyping).toHaveBeenCalledTimes(calls);
      expect(h.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops typing when conversation preparation fails before invoke', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(() => ({ ok: true, content: 'unused' }));
      const lookupMessage = vi.spyOn(conversationRepo, 'lookupMessage').mockImplementation(() => {
        throw new Error('conversation lookup failed');
      });
      try {
        const running = h.run(
          mention({
            invocationId: 'inv-pre-invoke-failure',
            messageId: '810000000000000032',
            referencedMessageId: '840000000000000001',
            referencedAuthorId: OTHER_ID,
          }),
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(h.sendTyping).toHaveBeenCalledTimes(1);
        await running;
        const typingCalls = h.sendTyping.mock.calls.length;
        await vi.advanceTimersByTimeAsync(16_000);
        expect(h.sendTyping).toHaveBeenCalledTimes(typingCalls);
        expect(h.inputs).toHaveLength(0);
      } finally {
        lookupMessage.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Task 10 (c): ChainFailedError writes a trace per job attempt', () => {
  const BOT_ID = '901234567890123456';

  it('a ChainFailedError on attempt 1 inserts trace trace_<key>_a1 with retry:1 then throws RetryAfterError', async () => {
    const { ChainFailedError } = await import('../assistant/chain-failed-error.js');
    const t = openMigratedTestDatabase();
    try {
      guildRepo.upsertGuild(t.scopes.forGuild(GUILD_ID), { name: 'fixture', now: NOW });
      const scope = t.scopes.forGuild(GUILD_ID);
      const attempts = [
        {
          provider: 'openrouter',
          model: 'm',
          keyLabel: 'Key A',
          outcome: 'busy' as const,
          reason: 'outage',
          code: 'provider-connect-timeout',
          netCode: 'UND_ERR_CONNECT_TIMEOUT',
          host: 'openrouter.ai',
          ms: 5,
        },
      ];
      const svc: AssistantCommandService = {
        behavioursForGuild: async () => [behaviour],
        invoke: async () => {
          throw new ChainFailedError(
            'outage',
            'Every assistant model failed — openrouter/m: provider-connect-timeout',
            true,
            attempts,
          );
        },
      };
      const sent: { channelId: string; message: OutgoingMessage }[] = [];
      const handler = assistantInvokeHandler({
        guildId: GUILD_ID,
        service: svc,
        openToken: () => undefined,
        respond: async () => undefined,
        send: async (channelId: string, message: OutgoingMessage) => {
          sent.push({ channelId, message });
          return undefined;
        },
        logger: pino({ level: 'silent' }),
        logChannelId: () => undefined,
        now: () => NOW,
        conversations: { scope, botUserId: BOT_ID, botDisplayName: 'bananasaurs' },
      });
      await expect(
        handler.run(handler.payload.parse(payload), context({ attempts: 1 })),
      ).rejects.toBeInstanceOf(RetryAfterError);
      const stored = traceRepo.getTrace(scope, 'trace_inv-1_a1');
      expect(stored).toBeDefined();
      expect(stored?.flags).toEqual(['retry:1']);
      expect(stored?.outcome).toBe('failed');
      expect(stored?.attempts).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('on the last attempt it inserts trace_<key>_a<n> with gave-up and answers the busy reply', async () => {
    const { ChainFailedError } = await import('../assistant/chain-failed-error.js');
    const t = openMigratedTestDatabase();
    try {
      guildRepo.upsertGuild(t.scopes.forGuild(GUILD_ID), { name: 'fixture', now: NOW });
      const scope = t.scopes.forGuild(GUILD_ID);
      const attempts = [
        {
          provider: 'openrouter',
          model: 'm',
          keyLabel: 'Key A',
          outcome: 'busy' as const,
          reason: 'outage',
          code: 'provider-connect-timeout',
          netCode: 'UND_ERR_CONNECT_TIMEOUT',
          host: 'openrouter.ai',
          ms: 5,
        },
      ];
      const svc: AssistantCommandService = {
        behavioursForGuild: async () => [behaviour],
        invoke: async () => {
          throw new ChainFailedError(
            'outage',
            'Every assistant model failed — openrouter/m: provider-connect-timeout',
            true,
            attempts,
          );
        },
      };
      const sent: { channelId: string; message: OutgoingMessage }[] = [];
      const handler = assistantInvokeHandler({
        guildId: GUILD_ID,
        service: svc,
        openToken: () => undefined,
        respond: async () => undefined,
        send: async (channelId: string, message: OutgoingMessage) => {
          sent.push({ channelId, message });
          return undefined;
        },
        logger: pino({ level: 'silent' }),
        logChannelId: () => undefined,
        now: () => NOW,
        conversations: { scope, botUserId: BOT_ID, botDisplayName: 'bananasaurs' },
      });
      await handler.run(handler.payload.parse(payload), context({ attempts: 4 }));
      const stored = traceRepo.getTrace(scope, 'trace_inv-1_a4');
      expect(stored).toBeDefined();
      expect(stored?.flags).toEqual(['gave-up']);
      expect(sent[0]?.message.content).toBe(
        'The AI service is busy right now. Try again in a minute. No action was taken.',
      );
    } finally {
      t.close();
    }
  });
});

describe('assistantInvokeHandler (ADR 0091: summary enqueue)', () => {
  const BOT_ID = '901234567890123456';
  const AMA = '444444444444444444';

  let t: MigratedTestDatabase;
  let nowMs: number;

  beforeEach(() => {
    t = openMigratedTestDatabase();
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD_ID), { name: 'fixture', now: NOW });
    nowMs = NOW;
  });
  afterEach(() => t.close());

  const scope = () => t.scopes.forGuild(GUILD_ID);

  const answeredResult = (): AssistantInvocationResult => ({
    ok: true,
    content: 'answer',
    detail: {
      sections: [],
      history: [],
      attempts: [],
      toolCalls: [],
      usage: {},
      guard: { removed: [] },
      answeredBy: { providerId: 'test-provider', model: 'test-model', keyId: 'key_test' },
    },
  });

  const harness = (answer: (input: AssistantInvocation) => AssistantInvocationResult) => {
    const inputs: AssistantInvocation[] = [];
    const svc: AssistantCommandService = {
      behavioursForGuild: async () => [behaviour],
      invoke: async (input) => {
        inputs.push(input);
        return answer(input);
      },
    };
    let idSeq = 0;
    const handler = assistantInvokeHandler({
      guildId: GUILD_ID,
      service: svc,
      openToken: () => undefined,
      respond: async () => undefined,
      send: async (channelId: string) => {
        idSeq += 1;
        return { channelId, messageId: `8290000000000001${String(idSeq).padStart(2, '0')}` };
      },
      logger: pino({ level: 'silent' }),
      logChannelId: () => undefined,
      now: () => nowMs,
      conversations: { scope: scope(), botUserId: BOT_ID, botDisplayName: 'bananasaurs' },
    });
    const run = async (
      input: Record<string, unknown>,
      cursor: string | null = null,
    ): Promise<string | null> => {
      let saved: string | null = cursor;
      await handler.run(handler.payload.parse(input), {
        jobId: 1,
        attempts: cursor === null ? 1 : 2,
        cursor,
        saveCursor: (c) => {
          saved = c;
        },
      });
      return saved;
    };
    return { inputs, run };
  };

  const mention = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    channelId: CHANNEL_ID,
    userId: AMA,
    callerRoleIds: [],
    behaviourId: behaviour.id,
    command: 'ask',
    input: { question: 'another question' },
    source: 'mention',
    authorName: 'Ama',
    ...over,
  });

  const summaryJobs = () =>
    jobRepo.listJobs(scope(), {}).filter((job) => job.kind === JOB_KINDS.assistantSummarise);

  it('enqueues one summary job when turns were evicted', async () => {
    const h = harness(answeredResult);
    await h.run(mention({ invocationId: 'sum-first', messageId: '810000000000000201' }));
    // Twelve seeded turns plus the run's own two push the oldest out of the window.
    for (let i = 0; i < 12; i += 1) {
      conversationRepo.appendTurn(scope(), {
        conversationId: 'conv_sum-first',
        turnId: `turn_seed_${i}`,
        at: NOW - 60_000 + i,
        role: i % 2 === 0 ? 'user' : 'assistant',
        authorId: AMA,
        authorName: i % 2 === 0 ? 'Ama' : 'bananasaurs',
        text: `seeded turn ${i}`,
      });
    }
    nowMs += 1_000;
    await h.run(mention({ invocationId: 'sum-second', messageId: '810000000000000202' }));

    const jobs = summaryJobs();
    expect(jobs).toHaveLength(1);
    const parsed = assistantSummarisePayload.safeParse(JSON.parse(jobs[0]!.payload));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.conversationId).toBe('conv_sum-first');
      expect(parsed.data.providerId).toBe('test-provider');
      expect(parsed.data.model).toBe('test-model');
      expect(parsed.data.keyId).toBe('key_test');
      expect(jobs[0]!.dedupeKey).toBe(`summary_conv_sum-first_${parsed.data.throughAt}`);
    }
  });

  it('enqueues nothing when no turn was evicted', async () => {
    const h = harness(answeredResult);
    await h.run(mention({ invocationId: 'sum-fresh', messageId: '810000000000000203' }));
    expect(summaryJobs()).toHaveLength(0);
  });

  it('enqueues nothing without an answering entry', async () => {
    const h = harness(() => ({ ok: true, content: 'answer' }));
    await h.run(mention({ invocationId: 'sum-noentry', messageId: '810000000000000204' }));
    for (let i = 0; i < 13; i += 1) {
      conversationRepo.appendTurn(scope(), {
        conversationId: 'conv_sum-noentry',
        turnId: `turn_seed_${i}`,
        at: NOW - 60_000 + i,
        role: i % 2 === 0 ? 'user' : 'assistant',
        authorId: AMA,
        authorName: i % 2 === 0 ? 'Ama' : 'bananasaurs',
        text: `seeded turn ${i}`,
      });
    }
    nowMs += 1_000;
    await h.run(mention({ invocationId: 'sum-noentry-next', messageId: '810000000000000205' }));
    expect(summaryJobs()).toHaveLength(0);
  });

  it('a retry of the same job does not enqueue twice', async () => {
    const h = harness(answeredResult);
    await h.run(mention({ invocationId: 'sum-retry', messageId: '810000000000000206' }));
    for (let i = 0; i < 12; i += 1) {
      conversationRepo.appendTurn(scope(), {
        conversationId: 'conv_sum-retry',
        turnId: `turn_seed_${i}`,
        at: NOW - 60_000 + i,
        role: i % 2 === 0 ? 'user' : 'assistant',
        authorId: AMA,
        authorName: i % 2 === 0 ? 'Ama' : 'bananasaurs',
        text: `seeded turn ${i}`,
      });
    }
    nowMs += 1_000;
    const cursor = await h.run(
      mention({ invocationId: 'sum-retry-next', messageId: '810000000000000207' }),
    );
    expect(summaryJobs()).toHaveLength(1);
    await h.run(
      mention({ invocationId: 'sum-retry-next', messageId: '810000000000000207' }),
      cursor,
    );
    expect(summaryJobs()).toHaveLength(1);
  });

  it('a dangling recalled id does not fail the job and the summary still enqueues', async () => {
    const h = harness(() => ({
      ...answeredResult(),
      detail: {
        ...answeredResult().detail!,
        recalled: ['conv_gone'],
      },
    }));
    await h.run(mention({ invocationId: 'recall-gone', messageId: '810000000000000209' }));
    // Twelve seeded turns plus the run's own two push the oldest out of the window.
    for (let i = 0; i < 12; i += 1) {
      conversationRepo.appendTurn(scope(), {
        conversationId: 'conv_recall-gone',
        turnId: `turn_seed_${i}`,
        at: NOW - 60_000 + i,
        role: i % 2 === 0 ? 'user' : 'assistant',
        authorId: AMA,
        authorName: i % 2 === 0 ? 'Ama' : 'bananasaurs',
        text: `seeded turn ${i}`,
      });
    }
    nowMs += 1_000;
    // `conv_gone` was never created, so its link write fails: the job must
    // still resolve and enqueue the summary job after it.
    await h.run(mention({ invocationId: 'recall-gone-next', messageId: '810000000000000210' }));
    expect(conversationRepo.listLinks(scope(), 'conv_recall-gone')).toEqual([]);
    expect(summaryJobs()).toHaveLength(1);
  });

  it('passes the stored summary into the invoke and records its version on the trace', async () => {
    conversationRepo.createConversation(scope(), {
      conversationId: 'conv_sum-ver',
      channelId: CHANNEL_ID,
      behaviourId: behaviour.id,
      startedBy: AMA,
      title: 'seeded',
      source: 'discord',
      at: NOW - 1_000,
    });
    conversationRepo.appendTurn(scope(), {
      conversationId: 'conv_sum-ver',
      turnId: 'turn_seed_0',
      at: NOW - 1_000,
      role: 'user',
      authorId: AMA,
      authorName: 'Ama',
      text: 'earlier question',
    });
    conversationRepo.writeSummaryIfNewer(scope(), {
      conversationId: 'conv_sum-ver',
      summary: {
        topic: 'Old topic',
        facts: [],
        botClaims: [],
        openQuestions: [],
        commitments: [],
        participants: [],
      },
      throughAt: NOW - 1_000,
      now: NOW,
    });
    const h = harness((input) => ({
      ok: true,
      content: 'answer',
      detail: {
        sections: [],
        history: [],
        attempts: [],
        toolCalls: [],
        usage: {},
        guard: { removed: [] },
        answeredBy: { providerId: 'test-provider', model: 'test-model', keyId: 'key_test' },
        included: {
          toolsOffered: [],
          snippetChunkIds: [],
          quote: false,
          historyTurns: 0,
          ...(input.summaryVersion === undefined ? {} : { summaryVersion: input.summaryVersion }),
        },
      },
    }));
    await h.run(mention({ invocationId: 'sum-ver', messageId: '810000000000000208' }));

    expect(h.inputs[0]?.summaryVersion).toBe(1);
    expect(h.inputs[0]?.history?.[0]).toBeDefined();
    expect(h.inputs[0]?.history?.[0]!.text.startsWith('[EARLIER IN THIS CONVERSATION')).toBe(true);
    expect(h.inputs[0]?.history?.[0]!.text).toContain('Old topic');
    const stored = traceRepo.getTrace(scope(), 'trace_sum-ver');
    expect(stored?.included?.summaryVersion).toBe(1);
  });
});

describe('assistantInvokeHandler (ADR 0129: one trace per terminal path)', () => {
  const BOT_ID2 = '901234567890123456';
  let t3: MigratedTestDatabase;
  let nowMs3: number;
  let logLines3: { fields: Record<string, unknown>; msg: string }[];
  let logger3: Logger;
  beforeEach(() => {
    t3 = openMigratedTestDatabase();
    guildRepo.upsertGuild(t3.scopes.forGuild(GUILD_ID), { name: 'fixture', now: NOW });
    nowMs3 = NOW;
    logLines3 = [];
    const push = (fields: Record<string, unknown>, msg?: string): void => {
      logLines3.push({ fields, msg: msg ?? '' });
    };
    logger3 = {
      debug: push,
      info: push,
      warn: push,
      error: push,
    } as unknown as Logger;
  });
  afterEach(() => t3.close());
  const scope3 = () => t3.scopes.forGuild(GUILD_ID);
  const detailWithSection3 = (): AssistantTraceDetail => ({
    sections: [{ name: 'identity', chars: 4, estTokens: 1, text: 'rule' }],
    history: [],
    attempts: [],
    toolCalls: [],
    usage: {},
    guard: { removed: [] },
  });
  const chainAttempt3 = (
    over: Partial<AssistantTrace['attempts'][number]> = {},
  ): AssistantTrace['attempts'][number] => ({
    provider: 'openrouter',
    model: 'stealth/space-bunny-alpha',
    outcome: 'error',
    code: 'provider-bad-model',
    httpStatus: 404,
    providerMessage: 'No endpoints found',
    ms: 5,
    ...over,
  });
  const chainFailed3 = (
    over: {
      readonly retryable?: boolean;
      readonly kind?: 'invalid-request' | 'rate-limit';
      readonly attempts?: AssistantTrace['attempts'];
    } = {},
  ): ChainFailedError =>
    new ChainFailedError(
      over.kind ?? 'invalid-request',
      'chain failed',
      over.retryable ?? false,
      over.attempts ?? [chainAttempt3()],
      {
        detail: detailWithSection3(),
      },
    );
  const mention3 = (invocationId: string, messageId = '810000000000000301') => ({
    channelId: CHANNEL_ID,
    userId: USER_ID,
    callerRoleIds: [],
    behaviourId: behaviour.id,
    command: 'ask' as const,
    input: { question: 'hi' },
    source: 'mention' as const,
    invocationId,
    messageId,
  });
  const harness3 = (
    answer: (
      input: AssistantInvocation,
    ) => AssistantInvocationResult | Promise<AssistantInvocationResult>,
    opts: {
      readonly behaviours?: readonly AssistantBehaviour[];
      readonly channelAccess?: Pick<ChannelAccess, 'check'>;
      readonly logChannelId?: string;
    } = {},
  ) => {
    const inputs: AssistantInvocation[] = [];
    const svc: AssistantCommandService = {
      behavioursForGuild: async () => opts.behaviours ?? [behaviour],
      invoke: async (input) => {
        inputs.push(input);
        return await answer(input);
      },
    };
    const sent: { channelId: string; message: OutgoingMessage }[] = [];
    let idSeq = 0;
    const nextRef = (channelId: string): DiscordMessageRef => {
      idSeq += 1;
      return { channelId, messageId: `8290000000000000${String(idSeq).padStart(2, '0')}` };
    };
    const send = vi.fn(async (channelId: string, message: OutgoingMessage) => {
      sent.push({ channelId, message });
      return nextRef(channelId);
    });
    const respond = vi.fn(async () => nextRef(CHANNEL_ID));
    const logPosts: OutgoingMessage[] = [];
    const handler = assistantInvokeHandler({
      guildId: GUILD_ID,
      service: svc,
      openToken: () => undefined,
      respond,
      send: async (channelId, message) => {
        if (opts.logChannelId !== undefined && channelId === opts.logChannelId) {
          logPosts.push(message);
          return undefined;
        }
        return send(channelId, message);
      },
      logger: logger3,
      logChannelId: () => opts.logChannelId,
      now: () => nowMs3,
      conversations: { scope: scope3(), botUserId: BOT_ID2, botDisplayName: 'bananasaurs' },
      sendTyping: async () => undefined,
      fetchMessageContent: async () => undefined,
      fetchChannelMessages: async () => undefined,
      channelContextMessages: () => 0,
      ...(opts.channelAccess === undefined ? {} : { channelAccess: opts.channelAccess }),
    });
    return {
      run: async (input: Record<string, unknown>, attempts = 1) => {
        let saved: string | null = null;
        try {
          await handler.run(handler.payload.parse(input), {
            jobId: 1,
            attempts,
            cursor: null,
            saveCursor: (c) => {
              saved = c;
            },
          });
          return { cursor: saved, error: undefined as unknown };
        } catch (error) {
          return { cursor: saved, error };
        }
      },
      sent,
      inputs,
      logPosts,
      turnsOf: (conversationId: string) => conversationRepo.listTurns(scope3(), conversationId),
    };
  };
  it('(a) a non-retryable chain failure writes one failed trace plus the failure turn', async () => {
    const h = harness3(async () => {
      throw chainFailed3();
    });
    const key = 't3-a1';
    await h.run(mention3(key));
    const trace = traceRepo.getTrace(scope3(), `trace_${key}_a1`);
    expect(trace?.outcome).toBe('failed');
    expect(trace?.flags).toContain('gave-up');
    expect(trace?.attempts).toHaveLength(1);
    expect(trace?.sections).toHaveLength(1);
    expect(trace?.runId).toBe(key);
    expect(trace?.turnId).toBe(`turn_${key}_a`);
    expect(trace?.error?.kind).toBe('invalid-request');
    const convId = trace?.conversationId;
    expect(convId).toBeDefined();
    const turns = h.turnsOf(convId!);
    const failureTurn = turns.find((turn) => turn.turnId === `turn_${key}_a`);
    expect(failureTurn?.traceId).toBe(`trace_${key}_a1`);
    expect(failureTurn?.text).toBe('I could not complete that request. No action was taken.');
    expect(h.sent).toHaveLength(1);
    expect(conversationRepo.lookupMessage(scope3(), '829000000000000001')?.conversationId).toBe(
      convId,
    );
  });
  it('(b) retry then success leaves two retry traces plus the answered trace and one turn', async () => {
    let calls = 0;
    const h = harness3(async () => {
      calls += 1;
      if (calls <= 2) throw chainFailed3({ retryable: true, kind: 'rate-limit' });
      return {
        ok: true,
        content: 'answer',
        detail: {
          sections: [],
          history: [],
          attempts: [],
          toolCalls: [],
          usage: {},
          guard: { removed: [] },
        },
      };
    });
    const key = 't3-b1';
    const first = await h.run(mention3(key), 1);
    expect(first.error).toBeInstanceOf(RetryAfterError);
    const second = await h.run(mention3(key), 2);
    expect(second.error).toBeInstanceOf(RetryAfterError);
    await h.run(mention3(key), 3);
    expect(traceRepo.getTrace(scope3(), `trace_${key}_a1`)?.flags).toContain('retry:1');
    expect(traceRepo.getTrace(scope3(), `trace_${key}_a2`)?.flags).toContain('retry:2');
    const answered = traceRepo.getTrace(scope3(), `trace_${key}`);
    expect(answered?.outcome).toBe('answered');
    expect(answered?.runId).toBe(key);
    const turns = h.turnsOf(answered?.conversationId ?? '');
    expect(turns.filter((turn) => turn.role === 'assistant')).toHaveLength(1);
  });
  it('(c) the retry ceiling leaves gave-up and a crash replay adds nothing', async () => {
    const h = harness3(async () => {
      throw chainFailed3({ retryable: true, kind: 'rate-limit' });
    });
    const key = 't3-c1';
    for (const attempt of [1, 2, 3]) {
      const out = await h.run(mention3(key), attempt);
      expect(out.error).toBeInstanceOf(RetryAfterError);
    }
    await h.run(mention3(key), 4);
    const last = traceRepo.getTrace(scope3(), `trace_${key}_a4`);
    expect(last?.flags).toContain('gave-up');
    const convId = last?.conversationId ?? '';
    const failureTurn = h.turnsOf(convId).find((turn) => turn.turnId === `turn_${key}_a`);
    expect(failureTurn?.traceId).toBe(`trace_${key}_a4`);
    const turnsBefore = h.turnsOf(convId).length;
    await h.run(mention3(key), 4);
    expect(traceRepo.getTrace(scope3(), `trace_${key}_a4`)?.flags).toContain('gave-up');
    expect(h.turnsOf(convId)).toHaveLength(turnsBefore);
  });
  it('(d) daily quota writes a failed trace and the quota reply with no retry', async () => {
    const h = harness3(async () => {
      throw new ChainFailedError('quota', 'daily free allowance spent', false, [chainAttempt3()], {
        detail: detailWithSection3(),
        quotaScope: 'daily-free',
        resetAt: NOW + 3_600_000,
      });
    });
    const key = 't3-d1';
    const out = await h.run(mention3(key), 1);
    expect(out.error).toBeUndefined();
    const trace = traceRepo.getTrace(scope3(), `trace_${key}_a1`);
    expect(trace?.outcome).toBe('failed');
    const turns = h.turnsOf(trace?.conversationId ?? '');
    expect(turns.find((turn) => turn.turnId === `turn_${key}_a`)?.text).toBe(
      dailyQuotaReply(NOW + 3_600_000, NOW),
    );
  });
  it('(e) a local limit writes a failed trace and the local-limit reply', async () => {
    const at = NOW + 60_000;
    const h = harness3(async () => {
      throw new LocalLimitError(at, 'local-rpm-limit', {
        attempts: [],
        detail: detailWithSection3(),
      });
    });
    const key = 't3-e1';
    await h.run(mention3(key), 1);
    const trace = traceRepo.getTrace(scope3(), `trace_${key}_a1`);
    expect(trace?.error?.kind).toBe('local-rpm-limit');
    expect(trace?.outcome).toBe('failed');
    const turns = h.turnsOf(trace?.conversationId ?? '');
    expect(turns.find((turn) => turn.turnId === `turn_${key}_a`)?.text).toBe(
      localLimitReply(at, NOW, 'UTC'),
    );
  });
  it('(f) an internal error writes a failed trace without leaking the message', async () => {
    const h = harness3(async () => {
      throw new Error('boom secret detail');
    });
    const key = 't3-f1';
    await h.run(mention3(key), 1);
    const trace = traceRepo.getTrace(scope3(), `trace_${key}_a1`);
    expect(trace?.error?.kind).toBe('internal');
    expect(JSON.stringify(trace)).not.toContain('boom');
  });
  it('(F4) a failing failure-turn write still posts once, warns with the runId and never retries', async () => {
    const warn = vi.fn();
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn,
      error: () => undefined,
    } as unknown as Logger;
    const sent: { channelId: string; message: OutgoingMessage }[] = [];
    let idSeq = 0;
    const svc: AssistantCommandService = {
      behavioursForGuild: async () => [behaviour],
      invoke: async () => {
        throw new Error('boom secret detail');
      },
    };
    const handler = assistantInvokeHandler({
      guildId: GUILD_ID,
      service: svc,
      openToken: () => undefined,
      respond: async () => ({ channelId: CHANNEL_ID, messageId: '829000000000000001' }),
      send: async (channelId: string, message: OutgoingMessage) => {
        sent.push({ channelId, message });
        idSeq += 1;
        return { channelId, messageId: `8290000000000000${String(idSeq).padStart(2, '0')}` };
      },
      logger,
      logChannelId: () => undefined,
      now: () => nowMs3,
      conversations: { scope: scope3(), botUserId: BOT_ID2, botDisplayName: 'bananasaurs' },
      sendTyping: async () => undefined,
      fetchMessageContent: async () => undefined,
      fetchChannelMessages: async () => undefined,
      channelContextMessages: () => 0,
    });
    const originalAppend = conversationRepo.appendTurn;
    const appendSpy = vi
      .spyOn(conversationRepo, 'appendTurn')
      .mockImplementation((scope, turn) => {
        if (turn.role === 'assistant') throw new Error('turn write boom');
        return originalAppend(scope, turn);
      });
    try {
      const key = 't3-f4-turn-write';
      let error: unknown;
      try {
        await handler.run(handler.payload.parse(mention3(key)), {
          jobId: 1,
          attempts: 1,
          cursor: null,
          saveCursor: () => undefined,
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeUndefined();
      expect(sent).toHaveLength(1);
      expect(sent[0]?.message.content).toBe(
        'I could not complete that request. No action was taken.',
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ runId: key }),
        'assistant failure turn write failed',
      );
    } finally {
      appendSpy.mockRestore();
    }
  });
  it('(g) a deleted behaviour writes one refused trace', async () => {
    const h = harness3(
      async () => ({
        ok: true,
        content: 'answer',
      }),
      { behaviours: [] },
    );
    const key = 't3-g1';
    await h.run(mention3(key), 1);
    const trace = traceRepo.getTrace(scope3(), `trace_${key}`);
    expect(trace?.outcome).toBe('refused');
    expect(trace?.error?.kind).toBe('behaviour-unavailable');
    expect(trace?.runId).toBe(key);
  });
  it('(h) a fresh write-denied run writes one refused trace and sends nothing', async () => {
    const h = harness3(
      async () => ({
        ok: true,
        content: 'answer',
      }),
      {
        channelAccess: {
          check: async () => ({ allowed: false as const, reason: 'not-granted' as const }),
        },
      },
    );
    const key = 't3-h1';
    await h.run(mention3(key), 1);
    const trace = traceRepo.getTrace(scope3(), `trace_${key}`);
    expect(trace?.outcome).toBe('refused');
    expect(trace?.flags).toContain('channel-not-writable');
    expect(h.sent).toHaveLength(0);
  });
  it('(i) ok:false outcomes pass through to the trace', async () => {
    const failed = harness3(async () => ({ ok: false, outcome: 'failed', content: 'bad' }));
    await failed.run(mention3('t3-i1'), 1);
    expect(traceRepo.getTrace(scope3(), 'trace_t3-i1')?.outcome).toBe('failed');
    const refused = harness3(async () => ({ ok: false, content: 'no' }));
    await refused.run(mention3('t3-i2'), 1);
    expect(traceRepo.getTrace(scope3(), 'trace_t3-i2')?.outcome).toBe('refused');
  });
  it('(j) success and final failure log assistant run finished with runId', async () => {
    const ok = harness3(async () => ({
      ok: true,
      content: 'answer',
      detail: {
        sections: [],
        history: [],
        attempts: [],
        toolCalls: [],
        usage: {},
        guard: { removed: [] },
      },
    }));
    await ok.run(mention3('t3-j1'), 1);
    const okLine = logLines3.find((line) => line.msg === 'assistant run finished')?.fields;
    expect(okLine).toMatchObject({ runId: 't3-j1', outcome: 'answered' });
    logLines3.length = 0;
    const bad = harness3(async () => {
      throw chainFailed3();
    });
    await bad.run(mention3('t3-j2'), 1);
    const badLine = logLines3.find((line) => line.msg === 'assistant run finished')?.fields;
    expect(badLine).toMatchObject({
      runId: 't3-j2',
      outcome: 'failed',
      code: 'provider-bad-model',
    });
  });
  it('(k) the final-failure log post names the title and model, never provider text', async () => {
    const h = harness3(
      async () => {
        throw chainFailed3();
      },
      { logChannelId: '444444444444444444' },
    );
    await h.run(mention3('t3-k1'), 1);
    const reason = JSON.stringify(h.logPosts);
    expect(reason).toContain('This model is not available on this key — stealth/space-bunny-alpha');
    expect(reason).not.toContain('No endpoints found');
  });
});

describe('assistantInvokeHandler run ledger (ADR 0129 §6)', () => {
  const BOT = '901234567890123456';
  let t: MigratedTestDatabase;
  let nowMs: number;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD_ID), { name: 'fixture', now: NOW });
    nowMs = NOW;
  });
  afterEach(() => t.close());
  const scope = () => t.scopes.forGuild(GUILD_ID);

  const harness = (
    answer: (
      input: AssistantInvocation,
    ) => AssistantInvocationResult | Promise<AssistantInvocationResult>,
    opts: { readonly behaviours?: readonly AssistantBehaviour[] } = {},
  ) => {
    const inputs: AssistantInvocation[] = [];
    const svc: AssistantCommandService = {
      behavioursForGuild: async () => opts.behaviours ?? [behaviour],
      invoke: async (input) => {
        inputs.push(input);
        return await answer(input);
      },
    };
    const sent: { channelId: string; message: OutgoingMessage }[] = [];
    let idSeq = 0;
    const send = vi.fn(async (channelId: string, message: OutgoingMessage) => {
      sent.push({ channelId, message });
      idSeq += 1;
      return { channelId, messageId: `8290000000000000${String(idSeq).padStart(2, '0')}` };
    });
    const handler = assistantInvokeHandler({
      guildId: GUILD_ID,
      service: svc,
      openToken: () => undefined,
      respond: async () => undefined,
      send,
      logger: pino({ level: 'silent' }),
      logChannelId: () => undefined,
      now: () => nowMs,
      conversations: { scope: scope(), botUserId: BOT, botDisplayName: 'bananasaurs' },
      sendTyping: async () => undefined,
      fetchMessageContent: async () => undefined,
      fetchChannelMessages: async () => undefined,
      channelContextMessages: () => 0,
    });
    return {
      inputs,
      sent,
      run: async (input: Record<string, unknown>, attempts = 1) => {
        try {
          await handler.run(handler.payload.parse(input), {
            jobId: 1,
            attempts,
            cursor: null,
            saveCursor: () => undefined,
          });
          return { error: undefined as unknown };
        } catch (error) {
          return { error };
        }
      },
    };
  };

  const mention = (invocationId: string, over: Record<string, unknown> = {}) => ({
    channelId: CHANNEL_ID,
    userId: USER_ID,
    callerRoleIds: [],
    behaviourId: behaviour.id,
    command: 'ask' as const,
    input: { question: 'hi' },
    source: 'mention' as const,
    invocationId,
    messageId: '810000000000000001',
    ...over,
  });

  const kindsOf = (runId: string): string[] =>
    runRepo.listRunEvents(scope(), runId, 0, 50).map((r) => r.event.kind);

  it('the happy path records started, conversation, delivering, delivered, finished', async () => {
    const h = harness(async () => ({ ok: true, content: 'answer' }));
    await h.run(mention('rec-1'));
    expect(kindsOf('rec-1')).toEqual([
      'started',
      'conversation',
      'delivering',
      'delivered',
      'finished',
    ]);
    expect(runRepo.getRun(scope(), 'rec-1')).toMatchObject({
      state: 'answered',
      stage: 'done',
      traceId: 'trace_rec-1',
      conversationId: 'conv_rec-1',
    });
    const finished = runRepo
      .listRunEvents(scope(), 'rec-1', 0, 50)
      .find((r) => r.event.kind === 'finished')?.event;
    expect(finished).toMatchObject({ outcome: 'answered', traceId: 'trace_rec-1' });
  });

  it('a retryable failure records retry-scheduled and parks the run in retry-wait', async () => {
    const h = harness(async () => {
      throw new ProviderError('rate-limit', 'HTTP 429', true);
    });
    const out = await h.run(mention('rec-2'), 1);
    expect(out.error).toBeInstanceOf(RetryAfterError);
    const events = runRepo.listRunEvents(scope(), 'rec-2', 0, 50).map((r) => r.event);
    expect(events.map((e) => e.kind)).toEqual(['started', 'conversation', 'retry-scheduled']);
    expect(events.at(-1)).toMatchObject({
      code: 'internal',
      retryAt: NOW + 10_000,
      attempt: 1,
    });
    expect(runRepo.getRun(scope(), 'rec-2')).toMatchObject({
      state: 'retry-wait',
      stage: 'retry-wait',
    });
  });

  it('a final failure records finished failed with the last attempt code and trace id', async () => {
    const h = harness(async () => {
      throw new ChainFailedError('invalid-request', 'chain failed', false, [
        {
          provider: 'openrouter',
          model: 'stealth/space-bunny-alpha',
          outcome: 'error',
          code: 'provider-bad-model',
          httpStatus: 404,
          ms: 5,
        },
      ]);
    });
    await h.run(mention('rec-3'), 1);
    const finished = runRepo
      .listRunEvents(scope(), 'rec-3', 0, 50)
      .find((r) => r.event.kind === 'finished')?.event;
    expect(finished).toMatchObject({
      outcome: 'failed',
      code: 'provider-bad-model',
      traceId: 'trace_rec-3_a1',
    });
    expect(runRepo.getRun(scope(), 'rec-3')).toMatchObject({ state: 'failed', stage: 'done' });
  });

  it('a deleted behaviour records finished refused', async () => {
    const h = harness(async () => ({ ok: true, content: 'answer' }), { behaviours: [] });
    await h.run(mention('rec-4'), 1);
    const finished = runRepo
      .listRunEvents(scope(), 'rec-4', 0, 50)
      .find((r) => r.event.kind === 'finished')?.event;
    expect(finished).toMatchObject({ outcome: 'refused' });
    expect(runRepo.getRun(scope(), 'rec-4')).toMatchObject({ state: 'refused', stage: 'done' });
  });

  it('no run event stores message text', async () => {
    const h = harness(async () => ({ ok: true, content: 'answer' }));
    await h.run(mention('rec-5', { input: { question: 'tell me about zebracorn please' } }));
    const rows = t.raw
      .prepare(`SELECT data_json AS "dataJson" FROM assistant_run_events WHERE guild_id = ?`)
      .all(GUILD_ID) as { dataJson: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.dataJson).not.toContain('zebracorn');
  });
});
