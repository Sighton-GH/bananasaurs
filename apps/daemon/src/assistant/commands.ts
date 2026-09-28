import {
  assistantInvokeDedupeKey,
  JOB_KINDS,
  safeLogFields,
  type AssistantBehaviour,
  type AssistantInvokePayload,
  type AssistantTrace,
  type DomainEvent,
  type GenerationMessage,
  type KnownMessage,
  type Logger,
  type MessageEvent,
  type Subscriber,
} from '@bananasaurs/core';
import { routeAssistantMention } from '@bananasaurs/discord';

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
  /** The asker's display name, for the current-message label. */
  readonly askerName?: string | undefined;
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
   * stall reaction roles, automod and /mod behind one /ask. Reports whether
   * the queue took the job, so a duplicate mention skips its typing indicator.
   */
  readonly enqueue: (input: {
    kind: typeof JOB_KINDS.assistantInvoke;
    payload: AssistantInvokePayload;
    dedupeKey: string;
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
  const route = routeAssistantMention(event, behaviours, deps.botUserId, deps.lookupMessage);
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
  try {
    const queued = deps.enqueue({
      kind: JOB_KINDS.assistantInvoke,
      payload: {
        channelId: event.channelId,
        userId: event.authorId!,
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
        ...(event.authorDisplayName === undefined
          ? {}
          : { authorName: event.authorDisplayName.slice(0, 200) }),
      },
      dedupeKey: assistantInvokeDedupeKey(event.messageId),
      now: deps.now(),
    });
    // Best-effort and never awaited: the dispatch chain must not stall on it.
    // A duplicate already in the queue restarts nothing, so it gets no typing.
    if (!queued.enqueued) return;
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
