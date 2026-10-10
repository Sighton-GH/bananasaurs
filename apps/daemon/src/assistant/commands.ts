import {
  assistantInvokeDedupeKey,
  assistantOrderingKey,
  JOB_KINDS,
  safeLogFields,
  type AssistantBehaviour,
  type AssistantInvokePayload,
  type AssistantTrace,
  type AssistantTraceIncluded,
  type ChannelAccess,
  type DomainEvent,
  type GenerationMessage,
  type KnownMessage,
  type Logger,
  type MessageEvent,
  type Subscriber,
} from '@bananasaurs/core';
import { routeAssistantMention } from '@bananasaurs/discord';
import type { RunRecorder } from './run-recorder.js';

export type AssistantCommand =
  | 'ask'
  | 'find'
  | 'remind'
  | 'remember'
  | 'decision'
  | 'review-plan'
  | 'onboard'
  | 'agenda'
  | 'summarise'
  | 'announce'
  | 'checklist'
  | 'handoff';

export interface AssistantInvocation {
  readonly guildId: string;
  readonly channelId: string | undefined;
  readonly userId: string;
  readonly callerRoleIds: readonly string[];
  readonly behaviour: AssistantBehaviour;
  readonly command: AssistantCommand;
  readonly input: Readonly<Record<string, string>>;
  readonly source: 'slash-command' | 'mention';
  /** Discord interaction or message id that produced this invocation; the dedupe anchor. */
  readonly invocationId?: string | undefined;
  /**
   * Task 14: the conversation so far, built by the invoke job from stored
   * turns (the current question is its last turn). The service forwards it
   * to the tool loop ahead of the current user text. Absent means a fresh,
   * history-free request.
   */
  readonly history?: readonly GenerationMessage[] | undefined;
  /**
   * Task 14: a quoted message as untrusted evidence, appended to the user
   * text by the service — never to the system instruction.
   */
  readonly quoteEnvelope?: string | undefined;
  /**
   * True when the replayed conversation history includes a quote turn, so the
   * self-only-with-a-quote rule holds for the whole conversation.
   */
  readonly quoteInHistory?: boolean | undefined;
  readonly referencedMessageId?: string | undefined;
  /**
   * ADR 0089: the channel-context evidence block the invoke job built from
   * the channel's recent messages (and the thread starter), placed first in
   * the user message by the service. Absent means no channel context — the
   * window is off, the fetch failed, or the source is not a mention.
   */
  readonly channelContext?: string | undefined;
  /**
   * ADR 0089: how many channel-context lines `channelContext` holds, for the
   * trace's `included.channelMessages`. Absent means none were sent.
   */
  readonly channelMessages?: number | undefined;
  /**
   * ADR 0092: the oldest message id of the channel-context window — the
   * default `before` for the `channel_history` tool. Absent means the tool
   * falls back to the invoking message id.
   */
  readonly channelContextOldestId?: string | undefined;
  /** The asker's display name, for the current-message label. */
  readonly askerName?: string | undefined;
  /**
   * ADR 0093: the conversation this invocation is answering in, so
   * `search_conversations` can exclude it from its own hits. Absent means
   * no exclusion — invocations with no channel never set it.
   */
  readonly conversationId?: string | undefined;
  /**
   * ADR 0091: the stored summary's version the history leads with, for the
   * trace's `included.summaryVersion`. Absent means no summary was injected.
   */
  readonly summaryVersion?: number | undefined;
  /** ADR 0129 §6: the run's step log; absent means nothing is recorded. */
  readonly recorder?: RunRecorder | undefined;
}

/** What the AI log channel reports about one request (ADR 0065). Never member-facing. */
export interface InvocationTrace {
  readonly latencyMs: number;
  readonly model?: string;
  readonly tools?: readonly { readonly name: string; readonly ok: boolean }[];
  readonly sources?: readonly { readonly title: string; readonly url: string }[];
  readonly web?: boolean;
  readonly usedFallback?: boolean;
}

export type AssistantInvocationResult =
  | {
      readonly ok: true;
      readonly content: string;
      readonly escalation?: {
        readonly channelId: string;
        readonly reviewerRoleIds: readonly string[];
        readonly ticketId: string;
      };
      /**
       * Task 20: trace flags the run gathered that the stored trace — not
       * the member-facing answer — must carry (currently only
       * `resources-unavailable`, set when the resource cache could not be
       * read). The invoke job merges these into its own flags before the
       * trace write; the cursor schema carries them so a retry keeps them.
       */
      readonly flags?: readonly string[];
      readonly trace?: InvocationTrace;
      readonly detail?: AssistantTraceDetail | undefined;
    }
  | {
      readonly ok: false;
      /**
       * ADR 0129 decision 2: whether the refusal was a failure or a policy
       * stop. `failed` means the AI could not produce an answer (chain errors,
       * empty answer, quota, local limit); `refused` means a deliberate
       * policy stop (role gate, skill scope, provider terms, IT routing).
       * Absent means `refused`.
       */
      readonly outcome?: 'refused' | 'failed';
      readonly content: string;
      readonly flags?: readonly string[];
      readonly trace?: InvocationTrace;
      readonly detail?: AssistantTraceDetail | undefined;
    };

/**
 * Task 14: the full run detail the invoke job persists as an `AssistantTrace`.
 * The small `InvocationTrace` above stays the AI log channel's shape; this
 * carries everything the History pages need — the compiled sections plus the
 * history section, the loop attempts and tool calls.
 */
export interface AssistantTraceDetail {
  readonly sections: AssistantTrace['sections'];
  readonly history: readonly GenerationMessage[];
  readonly attempts: AssistantTrace['attempts'];
  readonly toolCalls: AssistantTrace['toolCalls'];
  readonly usage: AssistantTrace['usage'];
  readonly guard: AssistantTrace['guard'];
  readonly model?: string | undefined;
  readonly finishReason?: string | undefined;
  readonly web?: boolean | undefined;
  /**
   * The chain entry whose response was accepted (ADR 0091). Carried in the
   * job cursor so the summary job can re-resolve it; never written to the
   * stored trace, since the key id is not for display.
   */
  readonly answeredBy?:
    { readonly providerId: string; readonly model: string; readonly keyId: string } | undefined;
  /** Which context blocks the reply saw (ADR 0088 decision 2); tools offered live inside it. */
  readonly included?: AssistantTraceIncluded | undefined;
  /**
   * ADR 0093: the conversations whose summaries this run looked back at
   * (`search_conversations` hits). Carried in the job cursor so the invoke
   * job can link them with kind `recalled`; never written to the stored
   * trace.
   */
  readonly recalled?: readonly string[] | undefined;
  /** B2b: the code-written action summaries appended to this answer. */
  readonly actions?: readonly string[];
}

/**
 * The live assistant service sits behind this port. Its implementation owns
 * permission lookup, local safety/privacy checks, context retrieval and the
 * free-only provider policy. The Discord layer never calls a provider itself.
 */
export interface AssistantCommandService {
  behavioursForGuild(guildId: string): Promise<readonly AssistantBehaviour[]>;
  invoke(input: AssistantInvocation): Promise<AssistantInvocationResult>;
}

export interface AssistantCommandDeps {
  readonly guildId: string;
  /** The bot's own user id: a tag of it routes to the behaviour flagged `answersBotTag` (ADR 0063). */
  readonly botUserId: string;
  readonly service: AssistantCommandService;
  /**
   * Hands the invocation to the job queue (B2). The provider call is far too
   * slow for the serial per-guild dispatch chain: awaiting it here would
   * stall reaction roles, automod and /mod behind one question asked in chat. Reports whether
   * the queue took the job, so a duplicate mention skips its typing indicator.
   */
  readonly enqueue: (input: {
    kind: typeof JOB_KINDS.assistantInvoke;
    payload: AssistantInvokePayload;
    dedupeKey: string;
    orderingKey: string;
    now: number;
  }) => { readonly enqueued: boolean };
  readonly now: () => number;
  readonly logger: Logger;
  /**
   * Storage's `conversationRepo.lookupMessage`, scoped to this guild —
   * whether a message id is a known conversation turn (ADR 0072). Lets an
   * untagged Discord Reply to a known bot answer route to that
   * conversation's behaviour. Optional so every existing caller (and every
   * test-only `AssistantCommandDeps` fixture) keeps compiling unchanged;
   * omitting it just means untagged replies are never routed.
   */
  readonly lookupMessage?: (messageId: string) => KnownMessage | undefined;
  /**
   * ADR 0112 decision 4: whether a message id is a bot task post. A pinged
   * reply to one never reaches the general assistant unless its text tags
   * the bot. Optional like `lookupMessage`; omitting it routes as before.
   */
  readonly isTaskPost?: (messageId: string) => boolean;
  /**
   * ADR 0125: the id of the role Discord created for the bot on install, read
   * live so a reinstall is picked up. A tag of it routes like a tag of the bot
   * user. Optional; omitting it (or the guild not being cached) ignores it.
   */
  readonly botRoleId?: () => string | undefined;
  /**
   * Task 20: member 👍/👎 reactions on bot answers. Guild-scoped closures
   * over `conversationRepo.setFeedback` and `traceRepo.addTraceFlag` (wired
   * in `runtime/guild.ts`), so this subscriber stays storage-free like the
   * rest of the file. Absent in tests that do not exercise reactions.
   */
  readonly feedback?:
    | {
        readonly setFeedback: (
          messageId: string,
          feedback: 'up' | 'down' | null,
        ) => { updated: boolean; traceId: string | undefined };
        readonly addTraceFlag: (traceId: string, flag: string) => boolean;
      }
    | undefined;
  /**
   * Best-effort typing indicator for mentions: fired without awaiting on the
   * serial per-guild dispatch chain, so a slow Discord call never stalls it.
   */
  readonly sendTyping?: ((channelId: string) => Promise<void>) | undefined;
  /**
   * ADR 0126: Write gates the reply. When set, a mention in a channel the
   * bot may not post in is dropped after routing and before anything is
   * enqueued — no queue, no reply, no typing. Optional so existing test
   * fixtures compile; absent means no gate.
   */
  readonly channelAccess?: Pick<ChannelAccess, 'check'> | undefined;
  /**
   * ADR 0129 §6: called once when a mention's job is newly queued. Absent
   * means the queued step goes unrecorded.
   */
  readonly recordQueued?:
    | ((run: {
        readonly runId: string;
        readonly userId: string;
        readonly channelId: string;
        readonly behaviourId: string;
        readonly via: 'mention' | 'reply';
      }) => void)
    | undefined;
}

export const createAssistantCommandSubscriber = (deps: AssistantCommandDeps): Subscriber => ({
  name: 'assistant-commands',
  async handle(event: DomainEvent): Promise<void> {
    if (event.guildId !== deps.guildId) return;
    if (event.kind === 'messageCreate') await handleMention(deps, event);
    if (event.kind === 'reactionAdd' || event.kind === 'reactionRemove')
      handleFeedback(deps, event);
  },
});

/**
 * Task 20: 👍/👎 feedback on bot answers. Only reactions on messages linked
 * as an `assistant` turn count; the bot's own reactions are ignored (its
 * seeded/own reactions must never read as member feedback). Removing the
 * reaction clears the feedback; trace flags are append-only, so clearing
 * writes no flag.
 */
function handleFeedback(
  deps: AssistantCommandDeps,
  event: Extract<DomainEvent, { kind: 'reactionAdd' | 'reactionRemove' }>,
): void {
  const feedback = deps.feedback;
  if (feedback === undefined) return;
  if (event.userId === deps.botUserId) return;
  const vote =
    event.emoji === 'u:1f44d'
      ? ('up' as const)
      : event.emoji === 'u:1f44e'
        ? ('down' as const)
        : undefined;
  if (vote === undefined) return;
  const known = deps.lookupMessage?.(event.messageId);
  if (known === undefined || known.role !== 'assistant') return;
  if (event.kind === 'reactionRemove') {
    feedback.setFeedback(event.messageId, null);
    return;
  }
  const stored = feedback.setFeedback(event.messageId, vote);
  if (stored.updated && stored.traceId !== undefined)
    feedback.addTraceFlag(stored.traceId, `feedback:${vote}`);
}

async function handleMention(deps: AssistantCommandDeps, event: MessageEvent): Promise<void> {
  const behaviours = await deps.service.behavioursForGuild(event.guildId);
  const route = routeAssistantMention(
    event,
    behaviours,
    deps.botUserId,
    deps.lookupMessage,
    deps.isTaskPost,
    deps.botRoleId?.(),
  );
  if (route.kind === 'not-addressed') return;
  if (route.kind === 'ambiguous') {
    // Hard rule 6: this subscriber holds no idempotency key of its own, and
    // a gateway replay of the message would post the refusal twice. Fail
    // closed and silent; the message is logged, not sent.
    deps.logger.info(
      safeLogFields({
        component: 'assistant-mention',
        guildId: event.guildId,
        messageId: event.messageId,
        reason: route.message,
      }),
      'assistant mention refused: ambiguous tags',
    );
    return;
  }

  // Routing is cheap and inline; the invoke is a job (B2). Escalation
  // delivery lives in the job handler with the invoke that produces it. Task
  // 14: the payload also carries the message
  // identity the job needs — the message id for the reply and the link, and
  // the reply reference for the conversation resolver.
  //
  // ADR 0126: Write gates the reply. A mention in a channel the bot may not
  // post in stops here — after routing (so the shape stays "routed then
  // refused") but before the enqueue, the reply and the typing indicator.
  // The invoke job re-checks at run time; this early drop just saves the
  // queue round trip.
  if (deps.channelAccess !== undefined) {
    const decision = await deps.channelAccess.check('write', event.channelId);
    if (!decision.allowed) {
      deps.logger.info(
        safeLogFields({
          component: 'assistant-mention',
          guildId: event.guildId,
          channelId: event.channelId,
          purpose: 'write',
          reason: decision.reason,
        }),
        'assistant mention skipped: channel not writable',
      );
      return;
    }
  }
  try {
    const userId = event.authorId!;
    const queued = deps.enqueue({
      kind: JOB_KINDS.assistantInvoke,
      payload: {
        channelId: event.channelId,
        userId,
        callerRoleIds: [...(event.authorRoleIds ?? [])],
        behaviourId: route.behaviour.id,
        command: 'ask',
        input: { question: route.prompt },
        source: 'mention',
        invocationId: event.messageId,
        messageId: event.messageId,
        ...(event.referencedMessageId === undefined
          ? {}
          : { referencedMessageId: event.referencedMessageId }),
        ...(event.referencedAuthorId === undefined
          ? {}
          : { referencedAuthorId: event.referencedAuthorId }),
        ...(event.parentChannelId === undefined ? {} : { threadParentId: event.parentChannelId }),
        ...(event.authorDisplayName === undefined
          ? {}
          : { authorName: event.authorDisplayName.slice(0, 200) }),
      },
      dedupeKey: assistantInvokeDedupeKey(event.messageId),
      orderingKey: assistantOrderingKey({
        channelId: event.channelId,
        threadParentId: event.parentChannelId,
        userId,
      }),
      now: deps.now(),
    });
    // Best-effort and never awaited: the dispatch chain must not stall on it.
    // A duplicate already in the queue restarts nothing, so it gets no typing.
    if (!queued.enqueued) return;
    // ADR 0129 §6: a newly queued mention opens the run's ledger row. A
    // recording failure never stops the run — it is logged, and the mention
    // still gets its typing indicator and answer.
    try {
      deps.recordQueued?.({
        runId: event.messageId,
        userId: event.authorId!,
        channelId: event.channelId,
        behaviourId: route.behaviour.id,
        via: event.referencedMessageId === undefined ? 'mention' : 'reply',
      });
    } catch (err) {
      deps.logger.warn(
        safeLogFields({
          component: 'assistant-mention',
          guildId: event.guildId,
          runId: event.messageId,
          err,
        }),
        'assistant run ledger write failed',
      );
    }
    const sendTyping = deps.sendTyping;
    if (sendTyping !== undefined) {
      try {
        sendTyping(event.channelId).catch((err: unknown) => {
          deps.logger.warn(
            safeLogFields({ component: 'assistant-mention', guildId: event.guildId, err }),
            'assistant typing indicator failed; continuing',
          );
        });
      } catch (err) {
        deps.logger.warn(
          safeLogFields({ component: 'assistant-mention', guildId: event.guildId, err }),
          'assistant typing indicator failed; continuing',
        );
      }
    }
  } catch (err) {
    // Same rule: no unkeyed public reply from the subscriber. The enqueue
    // failure is local (storage), so the log line is the durable record.
    deps.logger.error(
      safeLogFields({ component: 'assistant-mention', guildId: event.guildId, err }),
      'assistant mention could not be queued',
    );
  }
}
