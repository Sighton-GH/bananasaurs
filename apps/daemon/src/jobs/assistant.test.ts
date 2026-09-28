import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import {
  parseGuildId,
  ProviderError,
  RetryAfterError,
  scanOutboundRequest,
  type AssistantBehaviour,
  type DiscordMessageRef,
  type JobContext,
  type Logger,
  type OutgoingMessage,
} from '@bananasaurs/core';
import { conversationRepo, guildRepo, traceRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import type {
  AssistantCommandService,
  AssistantInvocation,
  AssistantInvocationResult,
} from '../assistant/commands.js';
import { assistantInvokeHandler } from './assistant.js';
import { LocalLimitError, localLimitReply } from '../assistant/local-limit.js';

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
    return { inputs, sent, send, respond, sendTyping, fetchMessageContent, run };
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
