import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  ProviderError,
  RetryAfterError,
  type AssistantBehaviour,
  type JobContext,
} from '@bananasaurs/core';
import type {
  AssistantCommandService,
  AssistantInvocation,
  AssistantInvocationResult,
} from '../assistant/commands.js';
import { assistantInvokeHandler } from './assistant.js';

const GUILD_ID = '111111111111111111';
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
  allowedSkillIds: [],
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
const capturedLogger = (): { logger: pino.Logger; lines: () => Record<string, unknown>[] } => {
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

const baseDeps = (service_: AssistantCommandService, logger: pino.Logger) => {
  const sent: { channelId: string; message: { content: string } }[] = [];
  return {
    deps: {
      guildId: GUILD_ID,
      service: service_,
      openToken: () => undefined,
      respond: async () => undefined,
      send: async (channelId: string, message: { content: string }) => {
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
});
