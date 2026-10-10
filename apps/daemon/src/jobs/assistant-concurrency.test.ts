import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import {
  assistantInvokeDedupeKey,
  assistantOrderingKey,
  JOB_KINDS,
  JobWorker,
  LaneScheduler,
  parseGuildId,
  type AssistantBehaviour,
  type AssistantInvocation,
  type AssistantInvocationResult,
  type DiscordMessageRef,
  type OutgoingMessage,
} from '@bananasaurs/core';
import {
  conversationRepo,
  guildRepo,
  jobRepo,
  jobStoreFor,
  type GuildScope,
} from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import type { AssistantCommandService } from '../assistant/commands.js';
import { assistantInvokeHandler } from './assistant.js';

/**
 * ADR 0135 Task 4: through the real assistant job handler, real storage, the
 * real job worker and the real `LaneScheduler`, answers in different channels
 * run at the same time while answers in one channel (or a thread and its
 * parent) never overlap — and produce exactly the same conversations as
 * serial execution.
 *
 * The faked `invoke` blocks on a per-call deferred the test resolves by hand.
 * No real sleeps: between ticks the test flushes microtasks so started jobs
 * reach `invoke`.
 */
const GUILD_ID = parseGuildId('111111111111111111');
const NOW = 1_700_000_000_000;
const BOT_ID = '901234567890123456';
const CHANNEL_A = '333333333333333333';
const CHANNEL_B = '777777777777777777';
const THREAD_T = '888888888888888888';
const U1 = '444444444444444444';
const U2 = '555555555555555555';

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

const answerFor = (invocationId: string): AssistantInvocationResult => ({
  ok: true,
  content: `answer for ${invocationId}`,
});

/** Yields to the event loop so started jobs reach `invoke`. No timers. */
const flush = async (rounds = 20): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

interface Gate {
  readonly promise: Promise<AssistantInvocationResult>;
  settled: boolean;
  resolve: (result: AssistantInvocationResult) => void;
}

interface MentionDef {
  readonly channelId: string;
  readonly userId: string;
  readonly invocationId: string;
  readonly messageId: string;
  readonly question: string;
  readonly authorName: string;
  readonly threadParentId?: string;
}

/**
 * A mention payload shaped like the ones in `assistant.test.ts`: `channelId`,
 * `userId`, `callerRoleIds`, `behaviourId`, `command: 'ask'`, `input`,
 * `source: 'mention'`, `invocationId`, `messageId`, `authorName`, and
 * optionally `threadParentId`. All ids satisfy the storage snowflake CHECK.
 */
const mentionPayload = (def: MentionDef): Record<string, unknown> => ({
  channelId: def.channelId,
  userId: def.userId,
  callerRoleIds: [],
  behaviourId: behaviour.id,
  command: 'ask',
  input: { question: def.question },
  source: 'mention',
  invocationId: def.invocationId,
  messageId: def.messageId,
  authorName: def.authorName,
  ...(def.threadParentId === undefined ? {} : { threadParentId: def.threadParentId }),
});

interface Harness {
  readonly t: MigratedTestDatabase;
  readonly scope: GuildScope;
  /** Every `invoke` entry, in order, with its channel. */
  readonly entered: { invocationId: string; channelId: string | undefined }[];
  readonly gates: Map<string, Gate>;
  /** Overlap tracking: incremented on invoke entry, decremented on settle. */
  readonly active: { current: number; max: number };
  readonly sent: { channelId: string; message: OutgoingMessage }[];
  readonly worker: JobWorker;
  readonly scheduler: LaneScheduler;
  enqueueMention: (def: MentionDef) => void;
  resolveGate: (invocationId: string) => void;
  resolveAllGates: () => void;
  close: () => void;
}

/**
 * When `immediate` is true the faked `invoke` answers at once (for the serial
 * `worker.drain()` runs); otherwise it blocks on a per-call deferred the test
 * resolves by hand (for the scheduler runs).
 */
const createHarness = (immediate: boolean): Harness => {
  const t = openMigratedTestDatabase();
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_ID), { name: 'fixture', now: NOW });
  const scope = t.scopes.forGuild(GUILD_ID);

  const entered: Harness['entered'] = [];
  const gates = new Map<string, Gate>();
  const active = { current: 0, max: 0 };
  const svc: AssistantCommandService = {
    behavioursForGuild: async () => [behaviour],
    invoke: async (input: AssistantInvocation) => {
      entered.push({ invocationId: input.invocationId, channelId: input.channelId });
      active.current += 1;
      active.max = Math.max(active.max, active.current);
      try {
        if (immediate) return answerFor(input.invocationId);
        let resolve!: (result: AssistantInvocationResult) => void;
        const promise = new Promise<AssistantInvocationResult>((res) => {
          resolve = res;
        });
        const gate: Gate = {
          promise,
          settled: false,
          resolve: (result) => {
            if (!gate.settled) {
              gate.settled = true;
              resolve(result);
            }
          },
        };
        gates.set(input.invocationId, gate);
        return await promise;
      } finally {
        active.current -= 1;
      }
    },
  };

  const sent: Harness['sent'] = [];
  let idSeq = 0;
  const nextRef = (channelId: string): DiscordMessageRef => {
    idSeq += 1;
    return { channelId, messageId: `8290000000000000${String(idSeq).padStart(2, '0')}` };
  };
  const logger = pino({ level: 'silent' });
  const handler = assistantInvokeHandler({
    guildId: GUILD_ID,
    service: svc,
    openToken: () => undefined,
    respond: async () => nextRef(CHANNEL_A),
    send: async (channelId: string, message: OutgoingMessage) => {
      sent.push({ channelId, message });
      return nextRef(channelId);
    },
    logger,
    logChannelId: () => undefined,
    now: () => NOW,
    conversations: { scope, botUserId: BOT_ID, botDisplayName: 'bananasaurs' },
    sendTyping: vi.fn(async () => undefined),
    fetchMessageContent: vi.fn(async () => undefined),
    fetchChannelMessages: vi.fn(async () => undefined),
    channelContextMessages: () => 0,
  });
  const worker = new JobWorker({ store: jobStoreFor(scope), handlers: [handler], logger, now: () => NOW });
  const scheduler = new LaneScheduler({
    worker,
    lanes: [{ lane: 'assistant', concurrency: () => 4 }],
    logger,
  });

  return {
    t,
    scope,
    entered,
    gates,
    active,
    sent,
    worker,
    scheduler,
    enqueueMention: (def) => {
      const payload = mentionPayload(def);
      const result = jobRepo.enqueue(scope, {
        kind: JOB_KINDS.assistantInvoke,
        payload: JSON.stringify(payload),
        dedupeKey: assistantInvokeDedupeKey(def.invocationId),
        orderingKey: assistantOrderingKey({
          channelId: def.channelId,
          ...(def.threadParentId === undefined ? {} : { threadParentId: def.threadParentId }),
          userId: def.userId,
        }),
        now: NOW,
      });
      if (!result.enqueued) throw new Error(`mention ${def.invocationId} did not enqueue`);
    },
    resolveGate: (invocationId) => {
      const gate = gates.get(invocationId);
      if (gate === undefined) throw new Error(`no invoke gate for ${invocationId}`);
      gate.resolve(answerFor(invocationId));
    },
    resolveAllGates: () => {
      for (const [invocationId, gate] of gates) {
        if (!gate.settled) gate.resolve(answerFor(invocationId));
      }
    },
    close: () => t.close(),
  };
};

const jobStates = (h: Harness): string[] =>
  jobRepo.listJobs(h.scope, {}).map((job) => job.state);

/**
 * Ticks the scheduler and hand-resolves every pending `invoke` until no job
 * is left queued or running, then waits for in-flight work. No sleeps.
 */
const driveSchedulerUntilDone = async (h: Harness): Promise<void> => {
  for (let round = 0; round < 100; round += 1) {
    h.scheduler.tick();
    await flush();
    h.resolveAllGates();
    await flush();
    if (
      jobRepo.listJobs(h.scope, {}).every((job) => job.state === 'done' || job.state === 'failed')
    ) {
      break;
    }
  }
  await h.scheduler.idle();
};

interface ConversationSnapshot {
  readonly conversationId: string;
  readonly channelId: string;
  readonly turns: readonly { role: string; authorId: string | undefined; text: string }[];
  readonly links: readonly {
    otherConversationId: string;
    otherTitle: string;
    kind: string;
    direction: string;
    at: number;
  }[];
}

/** The number of conversations, each conversation's ordered turns, and the link rows. */
const snapshotConversations = (scope: GuildScope): ConversationSnapshot[] =>
  conversationRepo
    .listConversations(scope, { sort: 'started', order: 'asc', limit: 100 })
    .map((conversation) => ({
      conversationId: conversation.conversationId,
      channelId: conversation.channelId,
      turns: conversationRepo.listTurns(scope, conversation.conversationId).map((turn) => ({
        role: turn.role,
        authorId: turn.authorId,
        text: turn.text,
      })),
      links: conversationRepo.listLinks(scope, conversation.conversationId),
    }));

describe('assistant lanes concurrency (ADR 0135 Task 4)', () => {
  it('answers in different channels run at the same time', async () => {
    const h = createHarness(false);
    try {
      h.enqueueMention({
        channelId: CHANNEL_A,
        userId: U1,
        invocationId: 'inv-a1',
        messageId: '810000000000000101',
        question: 'question in A',
        authorName: 'Ama',
      });
      h.enqueueMention({
        channelId: CHANNEL_B,
        userId: U2,
        invocationId: 'inv-b1',
        messageId: '810000000000000102',
        question: 'question in B',
        authorName: 'Bo',
      });

      expect(h.scheduler.tick()).toBe(2);
      await flush();
      expect(h.entered).toHaveLength(2);
      expect(new Set(h.entered.map((call) => call.invocationId))).toEqual(
        new Set(['inv-a1', 'inv-b1']),
      );
      expect(h.active.max).toBe(2);
      expect(h.scheduler.runningCount('assistant')).toBe(2);
      // Neither answer has resolved: nothing was sent.
      expect(h.sent).toHaveLength(0);

      h.resolveAllGates();
      await h.scheduler.idle();

      expect(h.sent).toHaveLength(2);
      const byChannel = new Map(h.sent.map((post) => [post.channelId, post.message.content]));
      expect(byChannel.get(CHANNEL_A)).toBe('answer for inv-a1');
      expect(byChannel.get(CHANNEL_B)).toBe('answer for inv-b1');
      expect(jobStates(h)).toEqual(['done', 'done']);
    } finally {
      h.close();
    }
  });

  it('two answers in one channel never overlap and run in order', async () => {
    const h = createHarness(false);
    try {
      h.enqueueMention({
        channelId: CHANNEL_A,
        userId: U1,
        invocationId: 'inv-m1',
        messageId: '810000000000000111',
        question: 'first question',
        authorName: 'Ama',
      });
      h.enqueueMention({
        channelId: CHANNEL_A,
        userId: U2,
        invocationId: 'inv-m2',
        messageId: '810000000000000112',
        question: 'second question',
        authorName: 'Bo',
      });

      expect(h.scheduler.tick()).toBe(1);
      await flush();
      expect(h.entered.map((call) => call.invocationId)).toEqual(['inv-m1']);
      // Further ticks before resolving start nothing.
      expect(h.scheduler.tick()).toBe(0);
      expect(h.scheduler.tick()).toBe(0);
      await flush();
      expect(h.entered.map((call) => call.invocationId)).toEqual(['inv-m1']);

      h.resolveGate('inv-m1');
      await flush();
      await h.scheduler.idle();
      expect(h.scheduler.tick()).toBe(1);
      await flush();
      expect(h.entered.map((call) => call.invocationId)).toEqual(['inv-m1', 'inv-m2']);

      h.resolveGate('inv-m2');
      await h.scheduler.idle();

      expect(h.active.max).toBe(1);
      expect(h.sent.map((post) => post.message.content)).toEqual([
        'answer for inv-m1',
        'answer for inv-m2',
      ]);
      expect(jobStates(h)).toEqual(['done', 'done']);
    } finally {
      h.close();
    }
  });

  it('a thread answer waits for its parent channel', async () => {
    const h = createHarness(false);
    try {
      h.enqueueMention({
        channelId: CHANNEL_A,
        userId: U1,
        invocationId: 'inv-parent',
        messageId: '810000000000000121',
        question: 'question in the channel',
        authorName: 'Ama',
      });
      h.enqueueMention({
        channelId: THREAD_T,
        threadParentId: CHANNEL_A,
        userId: U2,
        invocationId: 'inv-thread',
        messageId: '810000000000000122',
        question: 'question in the thread',
        authorName: 'Bo',
      });

      // The thread shares its parent channel's ordering key, so only the
      // parent-channel answer starts.
      expect(h.scheduler.tick()).toBe(1);
      await flush();
      expect(h.entered.map((call) => call.invocationId)).toEqual(['inv-parent']);
      expect(h.scheduler.tick()).toBe(0);
      await flush();
      expect(h.entered.map((call) => call.invocationId)).toEqual(['inv-parent']);

      h.resolveGate('inv-parent');
      await flush();
      await h.scheduler.idle();
      expect(h.scheduler.tick()).toBe(1);
      await flush();
      expect(h.entered.map((call) => call.invocationId)).toEqual(['inv-parent', 'inv-thread']);

      h.resolveGate('inv-thread');
      await h.scheduler.idle();

      expect(h.active.max).toBe(1);
      expect(h.sent.map((post) => post.message.content)).toEqual([
        'answer for inv-parent',
        'answer for inv-thread',
      ]);
      expect(jobStates(h)).toEqual(['done', 'done']);
    } finally {
      h.close();
    }
  });

  it('one channel under the scheduler produces the same conversations as serial execution', async () => {
    const defs: MentionDef[] = [
      {
        channelId: CHANNEL_A,
        userId: U1,
        invocationId: 'inv-s1',
        messageId: '810000000000000131',
        question: 'first question from Ama',
        authorName: 'Ama',
      },
      {
        channelId: CHANNEL_A,
        userId: U1,
        invocationId: 'inv-s2',
        messageId: '810000000000000132',
        question: 'second question from Ama',
        authorName: 'Ama',
      },
      {
        channelId: CHANNEL_A,
        userId: U2,
        invocationId: 'inv-s3',
        messageId: '810000000000000133',
        question: 'question from Bo',
        authorName: 'Bo',
      },
    ];

    // (i) Serial: enqueue all three, then drain.
    const serial = createHarness(true);
    let serialSnap: ConversationSnapshot[];
    try {
      for (const def of defs) serial.enqueueMention(def);
      await serial.worker.drain();
      expect(jobStates(serial)).toEqual(['done', 'done', 'done']);
      serialSnap = snapshotConversations(serial.scope);
    } finally {
      serial.close();
    }

    // (ii) Scheduler: enqueue all three, then tick with hand resolution.
    const parallel = createHarness(false);
    let parallelSnap: ConversationSnapshot[];
    try {
      for (const def of defs) parallel.enqueueMention(def);
      await driveSchedulerUntilDone(parallel);
      expect(jobStates(parallel)).toEqual(['done', 'done', 'done']);
      parallelSnap = snapshotConversations(parallel.scope);
    } finally {
      parallel.close();
    }

    expect(serialSnap.length).toBeGreaterThan(0);
    expect(serialSnap.flatMap((conversation) => conversation.turns)).toHaveLength(6);
    expect(parallelSnap).toEqual(serialSnap);
  });
});
