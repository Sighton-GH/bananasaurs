import {
  assistantInvokeCursor,
  assistantInvokePayload,
  JOB_KINDS,
  ProviderError,
  resolveConversation,
  RetryAfterError,
  safeLogFields,
  splitForDiscord,
  stripNewTopic,
  type AssistantInvokePayload,
  type AssistantInvokeCursor,
  type ConversationResolution,
  type DiscordMessageRef,
  type GenerationMessage,
  type JobHandler,
  type Logger,
  type OutgoingMessage,
} from '@bananasaurs/core';
import { conversationRepo, traceRepo, type GuildScope } from '@bananasaurs/storage';
import type {
  AssistantCommandService,
  AssistantInvocationResult,
  AssistantTraceDetail,
  InvocationTrace,
} from '../assistant/commands.js';
import { BUSY_REPLY, dailyQuotaReply } from '../assistant/fallback-replies.js';
import { buildConversationContext } from '../assistant/conversation-context.js';
import { assistantLogMessage, type AssistantLogInput } from '../assistant/log-message.js';

/**
 * Runs one assistant invocation off the serial per-guild dispatch chain (B2).
 *
 * The subscriber (`apps/daemon/src/assistant/commands.ts`) does only the
 * cheap work inline - defer the interaction, route the mention - and
 * enqueues this job for everything expensive: the conversation lookup, the
 * quote fetch, resource fetches and the provider call. Without this split
 * one slow /ask stalls reaction roles, automod and /mod behind it in the
 * per-guild chain, and a provider hang exceeds Discord's interaction window
 * while the chain waits.
 *
 * Four invariants the independent audit pinned down, plus Task 14's:
 *
 * - The behaviour is re-resolved at run time rather than trusted from the
 *   payload: a prompt edit or disable between enqueue and run takes effect,
 *   and a behaviour deleted in between fails closed with a plain answer.
 * - Invoke and delivery are staged through the job cursor. If the provider
 *   call succeeded but the Discord answer threw, a retry must NOT invoke
 *   again - a second invoke would repeat the provider spend and could
 *   duplicate the ticket and skill-activity effects. The cursor carries the
 *   finished result (and whether the answer landed) across attempts.
 * - Every answer joins a conversation (ADR 0072): replies and same-author
 *   follow-ups keep context, a tagged reply to someone else's message brings
 *   that message in as untrusted quoted context, and the answer posts as a
 *   Discord reply split into safe parts. `partsPosted`/`postedMessageIds`
 *   make a retry resume mid-parts without re-posting (hard rule 6); the
 *   provider is never called again once `invoke-done` is saved.
 * - Typing is best-effort and exempt from hard rule 6: its failure never
 *   fails the job.
 */
const reply = (content: string): OutgoingMessage => ({
  content: content.slice(0, 2_000),
  allowedMentions: { parse: [] },
});

/** Every delivery stage the worker may retry through. */
type CursorStage = 'invoke-done' | 'answered' | 'escalation-sent' | 'logged';
interface StagedCursor {
  readonly stage: CursorStage;
  readonly result: AssistantInvocationResult;
  readonly conversationId?: string | undefined;
  readonly resolution?: ConversationResolution | undefined;
  readonly partsPosted: number;
  readonly postedMessageIds: readonly string[];
  readonly flags: readonly string[];
}
const STAGES: readonly CursorStage[] = ['invoke-done', 'answered', 'escalation-sent', 'logged'];
/** Total order over stages: a retry resumes AFTER the furthest stage reached. */
const stageRank = (stage: CursorStage): number => STAGES.indexOf(stage);

/** A cursor result's validated run detail, minus the absent-marker. */
type CursorDetail = Exclude<AssistantInvokeCursor['result']['detail'], undefined>;
/** A cursor result's validated log-channel trace, minus the absent-marker. */
type CursorTrace = Exclude<AssistantInvokeCursor['result']['trace'], undefined>;
/** The cursor's validated conversation resolution, minus the absent-marker. */
type CursorResolution = Exclude<AssistantInvokeCursor['resolution'], undefined>;

/**
 * Zod's optional fields come back as `undefined`; the result type wants them
 * absent, so each optional is spread only when defined — the compiler, not a
 * cast, proves the rebuilt shape.
 */
const rebuildTrace = (trace: CursorTrace): InvocationTrace => ({
  latencyMs: trace.latencyMs,
  ...(trace.model === undefined ? {} : { model: trace.model }),
  ...(trace.tools === undefined
    ? {}
    : { tools: trace.tools.map((tool) => ({ name: tool.name, ok: tool.ok })) }),
  ...(trace.sources === undefined
    ? {}
    : { sources: trace.sources.map((source) => ({ title: source.title, url: source.url })) }),
  ...(trace.web === undefined ? {} : { web: trace.web }),
  ...(trace.usedFallback === undefined ? {} : { usedFallback: trace.usedFallback }),
});

/** Rebuilds the run detail the trace write reads, omitting every absent optional. */
const rebuildDetail = (detail: CursorDetail): AssistantTraceDetail => ({
  sections: detail.sections.map((section) => ({
    name: section.name,
    chars: section.chars,
    estTokens: section.estTokens,
    text: section.text,
  })),
  history: detail.history.map((message) => ({
    role: message.role,
    text: message.text,
    ...(message.toolCalls === undefined
      ? {}
      : {
          toolCalls: message.toolCalls.map((call) => ({
            ...(call.id === undefined ? {} : { id: call.id }),
            name: call.name,
            args: call.args,
          })),
        }),
    ...(message.toolName === undefined ? {} : { toolName: message.toolName }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.providerParts === undefined ? {} : { providerParts: message.providerParts }),
  })),
  attempts: detail.attempts.map((attempt) => ({
    provider: attempt.provider,
    model: attempt.model,
    ...(attempt.keyLabel === undefined ? {} : { keyLabel: attempt.keyLabel }),
    outcome: attempt.outcome,
    ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
    ms: attempt.ms,
  })),
  toolCalls: detail.toolCalls.map((call) => ({
    round: call.round,
    name: call.name,
    args: call.args,
    ok: call.ok,
    ...(call.refused === undefined ? {} : { refused: call.refused }),
    ms: call.ms,
    preview: call.preview,
  })),
  usage: {
    ...(detail.usage.promptTokens === undefined ? {} : { promptTokens: detail.usage.promptTokens }),
    ...(detail.usage.completionTokens === undefined
      ? {}
      : { completionTokens: detail.usage.completionTokens }),
    ...(detail.usage.thinkingTokens === undefined
      ? {}
      : { thinkingTokens: detail.usage.thinkingTokens }),
  },
  guard: {
    removed: [...detail.guard.removed],
    ...(detail.guard.blocked === undefined ? {} : { blocked: detail.guard.blocked }),
  },
  ...(detail.model === undefined ? {} : { model: detail.model }),
  ...(detail.finishReason === undefined ? {} : { finishReason: detail.finishReason }),
  ...(detail.web === undefined ? {} : { web: detail.web }),
});

/**
 * Rebuilds the resolution so its shape matches exactly: the `new` variant's
 * `quotedMessageId` is omitted when undefined rather than assigned as such.
 */
const rebuildResolution = (resolution: CursorResolution): ConversationResolution => {
  if (resolution.kind === 'continue') {
    return {
      kind: 'continue',
      conversationId: resolution.conversationId,
      rule: resolution.rule,
    };
  }
  return {
    kind: 'new',
    rule: resolution.rule,
    ...(resolution.quotedMessageId === undefined
      ? {}
      : { quotedMessageId: resolution.quotedMessageId }),
  };
};

const parseCursor = (cursor: string | null): StagedCursor | undefined => {
  if (cursor === null) return undefined;
  try {
    // Own prior write, still validated (hard rule 3): a malformed row is
    // "no progress", never a TypeError on every retry.
    const parsed = assistantInvokeCursor.safeParse(JSON.parse(cursor));
    if (!parsed.success) return undefined;
    const { stage, result, conversationId, resolution, partsPosted, postedMessageIds, flags } =
      parsed.data;
    const trace = result.trace === undefined ? {} : { trace: rebuildTrace(result.trace) };
    const detail = result.detail === undefined ? {} : { detail: rebuildDetail(result.detail) };
    const rest = {
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(resolution === undefined ? {} : { resolution: rebuildResolution(resolution) }),
      partsPosted,
      postedMessageIds,
      flags,
    };
    // Task 20: the service-attached result flags (e.g.
    // `resources-unavailable`) travel in the cursor alongside the job's own
    // `quote-unavailable` flags so a retry keeps both.
    const resultFlags = result.flags === undefined ? {} : { flags: [...result.flags] };
    if (!result.ok)
      return {
        stage,
        result: { ok: false, content: result.content, ...resultFlags, ...trace, ...detail },
        ...rest,
      };
    return {
      stage,
      result:
        result.escalation === undefined
          ? { ok: true, content: result.content, ...resultFlags, ...trace, ...detail }
          : {
              ok: true,
              content: result.content,
              escalation: result.escalation,
              ...resultFlags,
              ...trace,
              ...detail,
            },
      ...rest,
    };
  } catch {
    return undefined;
  }
};

/**
 * A retryable provider failure (429, 5xx, timeout) is what the job table is
 * for: rethrow so the job runs again. An overloaded model (Gemini's HTTP 503)
 * answers the same way two seconds later, so the retries are spaced out
 * rather than using the store's 1 s, 2 s, 4 s backoff: 10 s, 30 s, 90 s. That
 * is bounded below the store's default `maxAttempts` (5), so the member always
 * gets an answer, and ends well inside Discord's 15-minute interaction-token
 * window. Non-retryable failures answer at once.
 */
const PROVIDER_RETRY_DELAYS_MS = [10_000, 30_000, 90_000] as const;
const PROVIDER_RETRY_CEILING = PROVIDER_RETRY_DELAYS_MS.length + 1;

export const assistantInvokeHandler = (deps: {
  guildId: string;
  service: AssistantCommandService;
  /** `undefined` when the sealed token is not this process's - fail closed. */
  openToken: (sealed: string) => string | undefined;
  respond: (
    ref: { interactionId: string; token: string },
    message: OutgoingMessage,
  ) => Promise<DiscordMessageRef | undefined>;
  send: (channelId: string, message: OutgoingMessage) => Promise<DiscordMessageRef | undefined>;
  logger: Logger;
  /** ADR 0065: the AI log channel, read at run time; undefined means no log. */
  logChannelId: () => string | undefined;
  now: () => number;
  /**
   * Task 14: conversation wiring. Optional so pre-Task-14 callers (and the
   * golden-evaluation pair, which drives the real subscriber and handler
   * with no database) keep compiling: without it the job answers with no
   * history, no quote, no links and no trace. Production always wires it.
   */
  conversations?:
    | {
        readonly scope: GuildScope;
        /** This bot's user id, telling our own messages apart from quotes. */
        readonly botUserId: string;
        /** This bot's display name, used for the assistant turn and labels. */
        readonly botDisplayName: string;
      }
    | undefined;
  /** Task 14: the typing indicator. Best-effort; absent means no typing. */
  sendTyping?: ((channelId: string) => Promise<void>) | undefined;
  /** Task 14: quoted-message fetch for unknown references. Absent means no quote. */
  fetchMessageContent?:
    | ((
        channelId: string,
        messageId: string,
      ) => Promise<{ authorId: string; authorName: string; content: string } | undefined>)
    | undefined;
}): JobHandler<AssistantInvokePayload> => ({
  kind: JOB_KINDS.assistantInvoke,
  payload: assistantInvokePayload,
  async run(payload, context) {
    const startedAt = deps.now();
    // One-shot delivery for the pre-invoke failure paths (deleted behaviour,
    // daily cap, exhausted busy retries): short fixed strings that predate
    // Task 14's staged posting and stay exactly as they were.
    const answerSingle = async (content: string): Promise<void> => {
      if (payload.interaction !== undefined) {
        const token = deps.openToken(payload.interaction.sealedToken);
        if (token === undefined) return; // fresh runs fail closed above; a stranded cursor skips the answer only
        await deps.respond(
          { interactionId: payload.interaction.interactionId, token },
          reply(content),
        );
      } else if (payload.channelId !== undefined) {
        await deps.send(payload.channelId, reply(content));
      }
    };

    // Fail closed BEFORE any side effect when the answer can never be
    // delivered: a restart forgets the sealing key, and invoking anyway
    // would spend provider quota and write durable ticket/activity effects
    // nobody hears about (independent audit, round 2).
    //
    // Only BEFORE the invoke, though: once a cursor records `invoke-done`,
    // the durable effects (ticket row, activity) already exist, and stage 3
    // needs no token - a restart must still page the reviewers rather than
    // leave an open ticket nobody was told about.
    const prior = parseCursor(context.cursor);
    const reached = prior === undefined ? -1 : stageRank(prior.stage);
    if (
      prior === undefined &&
      payload.interaction !== undefined &&
      deps.openToken(payload.interaction.sealedToken) === undefined
    ) {
      deps.logger.warn(
        safeLogFields({ component: 'assistant-job', guildId: deps.guildId }),
        'assistant invocation dropped: interaction token is not from this process',
      );
      return;
    }

    const behaviourName = async (): Promise<string> =>
      (await deps.service.behavioursForGuild(deps.guildId)).find(
        (b) => b.id === payload.behaviourId,
      )?.name ?? payload.behaviourId;
    const logEntry = async (
      entry: Pick<AssistantLogInput, 'outcome' | 'answer' | 'reason' | 'trace'>,
    ): Promise<OutgoingMessage> =>
      assistantLogMessage({
        userId: payload.userId,
        channelId: payload.channelId,
        behaviourName: await behaviourName(),
        command: payload.command,
        source: payload.source,
        question: Object.values(payload.input).join('\n'),
        at: deps.now(),
        ...entry,
      });
    /**
     * A failure is logged best-effort: the member has already been answered
     * and the job completes, so a broken log channel must not retry the job
     * and answer them twice.
     */
    const logFailure = async (answerText: string, reason: string): Promise<void> => {
      const logChannelId = deps.logChannelId();
      if (logChannelId === undefined) return;
      try {
        await deps.send(
          logChannelId,
          await logEntry({ outcome: 'failed', answer: answerText, reason }),
        );
      } catch (err) {
        deps.logger.warn(
          safeLogFields({ component: 'assistant-job', guildId: deps.guildId, err }),
          'assistant log channel post failed',
        );
      }
    };

    // `recentTurns` orders by (at, turnId), and our turn ids sort the
    // assistant turn (`turn_<k>_a`) before the user turn (`turn_<k>_u`) —
    // so equal timestamps would misorder the history. Stamp each turn
    // strictly after every existing one; under a live clock this is just
    // `now()`.
    const nextAt = (existing: readonly { readonly at: number }[]): number =>
      Math.max(deps.now(), ...existing.map((turn) => turn.at + 1));

    const saveStaged = (stage: CursorStage, result: AssistantInvocationResult): void => {
      context.saveCursor(
        JSON.stringify({
          stage,
          result,
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(resolution === undefined ? {} : { resolution }),
          partsPosted,
          postedMessageIds,
          flags,
        } satisfies StagedCursor),
      );
    };

    // Stage 1: the invoke. Skipped on a retry that already finished it.
    let result: AssistantInvocationResult;
    let conversationId: string | undefined = prior?.conversationId;
    let resolution: ConversationResolution | undefined = prior?.resolution;
    let partsPosted = prior?.partsPosted ?? 0;
    let postedMessageIds: string[] = [...(prior?.postedMessageIds ?? [])];
    const flags: string[] = [...(prior?.flags ?? [])];
    let invokeDoneAt = startedAt;
    if (prior !== undefined) {
      result = prior.result;
    } else {
      try {
        const behaviours = await deps.service.behavioursForGuild(deps.guildId);
        const behaviour = behaviours.find((b) => b.id === payload.behaviourId);
        if (behaviour === undefined || !behaviour.enabled) {
          const text = 'That assistant behaviour is no longer available. No action was taken.';
          await answerSingle(text);
          await logFailure(text, 'The behaviour was deleted or turned off before the request ran.');
          return;
        }
        // Typing first, best-effort: a failure here must never fail the job.
        if (payload.channelId !== undefined && deps.sendTyping !== undefined) {
          try {
            await deps.sendTyping(payload.channelId);
          } catch (err) {
            deps.logger.warn(
              safeLogFields({ component: 'assistant-job', guildId: deps.guildId, err }),
              'assistant typing indicator failed; continuing',
            );
          }
        }
        // The conversation join: resolve, fetch an unknown quote, create the
        // row and the user turn, then build the history. The ids derive from
        // the invocation anchor, so a retry reuses the same conversation and
        // turn instead of duplicating them. Needs a channel; a slash
        // invocation without one answers history-free.
        const rawQuestion = Object.values(payload.input).join('\n');
        const strippedQuestion = stripNewTopic(rawQuestion);
        let history: readonly GenerationMessage[] = [];
        let quoteEnvelope: string | undefined;
        if (payload.channelId !== undefined && deps.conversations !== undefined) {
          const conv = deps.conversations;
          const channelId = payload.channelId;
          const resolved = resolveConversation({
            now: deps.now(),
            channelId,
            authorId: payload.userId,
            botUserId: conv.botUserId,
            text: rawQuestion,
            ...(payload.referencedMessageId === undefined
              ? {}
              : { referencedMessageId: payload.referencedMessageId }),
            ...(payload.referencedAuthorId === undefined
              ? {}
              : { referencedAuthorId: payload.referencedAuthorId }),
            lookupMessage: (messageId) => conversationRepo.lookupMessage(conv.scope, messageId),
            latestForAuthor: (authorId, scopeChannelId) =>
              conversationRepo.latestForAuthor(conv.scope, authorId, scopeChannelId),
          });
          resolution = resolved;
          // Quoted rules name a message we do not know: fetch it in the same
          // channel as untrusted evidence. A fetch failure flags the trace
          // `quote-unavailable` and continues without the quote (ruling).
          let quoted: { authorName: string; content: string } | undefined;
          if (resolved.kind === 'new' && resolved.quotedMessageId !== undefined) {
            if (deps.fetchMessageContent === undefined) {
              flags.push('quote-unavailable');
            } else {
              try {
                const fetched = await deps.fetchMessageContent(channelId, resolved.quotedMessageId);
                if (fetched === undefined) flags.push('quote-unavailable');
                else quoted = { authorName: fetched.authorName, content: fetched.content };
              } catch (err) {
                deps.logger.warn(
                  safeLogFields({ component: 'assistant-job', guildId: deps.guildId, err }),
                  'assistant quoted message fetch failed; continuing without the quote',
                );
                flags.push('quote-unavailable');
              }
            }
          }
          const key = payload.invocationId;
          conversationId = resolved.kind === 'continue' ? resolved.conversationId : `conv_${key}`;
          const userTurnId = `turn_${key}_u`;
          if (conversationRepo.getConversation(conv.scope, conversationId) === undefined) {
            const title = strippedQuestion.slice(0, 120);
            conversationRepo.createConversation(conv.scope, {
              conversationId,
              channelId,
              behaviourId: payload.behaviourId,
              startedBy: payload.userId,
              title: title === '' ? 'Assistant conversation' : title,
              source: 'discord',
              at: deps.now(),
            });
          }
          const beforeUser = conversationRepo.listTurns(conv.scope, conversationId);
          if (!beforeUser.some((turn) => turn.turnId === userTurnId)) {
            conversationRepo.appendTurn(conv.scope, {
              conversationId,
              turnId: userTurnId,
              at: nextAt(beforeUser),
              role: 'user',
              authorId: payload.userId,
              authorName: payload.authorName ?? payload.userId,
              text: strippedQuestion,
            });
          }
          const built = buildConversationContext({
            scope: conv.scope,
            resolution: resolved,
            ...(quoted === undefined ? {} : { quoted }),
            botDisplayName: conv.botDisplayName,
          });
          history = built.history;
          quoteEnvelope = built.quoteEnvelope;
        }
        result = await deps.service.invoke({
          guildId: deps.guildId,
          channelId: payload.channelId,
          userId: payload.userId,
          callerRoleIds: payload.callerRoleIds,
          behaviour,
          command: payload.command,
          input: payload.input,
          source: payload.source,
          invocationId: payload.invocationId,
          history,
          ...(quoteEnvelope === undefined ? {} : { quoteEnvelope }),
        });
        invokeDoneAt = deps.now();
        // Task 20: flags the service attached to the result (currently only
        // `resources-unavailable`) join the job's own flags before the trace
        // write — the same way `quote-unavailable` above does — and persist
        // in the cursor via `saveStaged`, so a retry keeps them.
        for (const flag of result.flags ?? []) {
          if (!flags.includes(flag)) flags.push(flag);
        }
      } catch (err) {
        // ADR 0077: a daily free-model cap answers at once - no job retry,
        // no RetryAfterError - because a retry only burns another of
        // tomorrow's requests for the same guaranteed failure.
        if (err instanceof ProviderError && err.quotaScope === 'daily-free') {
          const text = dailyQuotaReply(err.resetAt, deps.now());
          deps.logger.warn(
            safeLogFields({ component: 'assistant-job', guildId: deps.guildId, err }),
            'assistant invocation hit a daily free-model quota cap; answering at once',
          );
          await answerSingle(text);
          await logFailure(text, err.message);
          return;
        }
        if (
          err instanceof ProviderError &&
          err.retryable &&
          context.attempts < PROVIDER_RETRY_CEILING
        ) {
          deps.logger.warn(
            safeLogFields({
              component: 'assistant-job',
              guildId: deps.guildId,
              attempt: context.attempts,
              err,
            }),
            'assistant invocation hit a retryable provider error; job will retry',
          );
          throw new RetryAfterError(
            err.message,
            PROVIDER_RETRY_DELAYS_MS[context.attempts - 1] ?? PROVIDER_RETRY_DELAYS_MS.at(-1)!,
          );
        }
        // Anything else - or the last permitted attempt - answers the member
        // instead of vanishing into a job retry.
        deps.logger.error(
          safeLogFields({ component: 'assistant-job', guildId: deps.guildId, err }),
          'assistant invocation failed before a response was produced',
        );
        const text =
          err instanceof ProviderError && err.retryable
            ? BUSY_REPLY
            : 'I could not complete that request. No action was taken.';
        await answerSingle(text);
        await logFailure(text, err instanceof Error ? err.message : 'unknown error');
        return;
      }
      // Persist BEFORE the first delivery attempt: a delivery throw from here
      // on retries with this cursor and never re-invokes.
      partsPosted = 0;
      postedMessageIds = [];
      saveStaged('invoke-done', result);
    }

    // One part, posted where it belongs: a mention's first part replies to
    // the member's message, later parts are plain sends; a slash answer's
    // first part follows up the interaction (capturing its message id) and
    // later parts go to the channel. Returns the posted message id, or
    // `undefined` when Discord reported none (or there was nowhere to post).
    const postPart = async (
      index: number,
      text: string,
      slashToken: string | undefined,
    ): Promise<string | undefined> => {
      const message = (replyTo?: string): OutgoingMessage =>
        replyTo === undefined
          ? { content: text, allowedMentions: { parse: [] } }
          : { content: text, allowedMentions: { parse: [] }, replyTo };
      if (payload.interaction !== undefined) {
        if (index === 0) {
          // A stranded slash cursor whose token is gone skips the answer
          // only (as before Task 14): the escalation and log stages below
          // still run.
          if (slashToken === undefined) return undefined;
          const ref = await deps.respond(
            { interactionId: payload.interaction.interactionId, token: slashToken },
            message(),
          );
          return ref?.messageId;
        }
        if (payload.channelId === undefined) {
          deps.logger.warn(
            safeLogFields({ component: 'assistant-job', guildId: deps.guildId }),
            'assistant follow-up part has no channel; dropping the remainder',
          );
          return undefined;
        }
        const ref = await deps.send(payload.channelId, message());
        return ref?.messageId;
      }
      if (payload.channelId === undefined) {
        deps.logger.warn(
          safeLogFields({ component: 'assistant-job', guildId: deps.guildId }),
          'assistant mention answer has no channel; dropping the remainder',
        );
        return undefined;
      }
      if (index === 0 && payload.messageId !== undefined) {
        const ref = await deps.send(payload.channelId, message(payload.messageId));
        return ref?.messageId;
      }
      const ref = await deps.send(payload.channelId, message());
      return ref?.messageId;
    };

    // Stage 2: the staged answer. Parts `[0, partsPosted)` already landed, so
    // a retry posts only the rest; every part is saved before the next, so a
    // crash mid-parts never re-posts one (hard rule 6). Afterwards the
    // assistant turn, the message links and the trace land exactly once.
    if (reached < stageRank('answered')) {
      const parts = splitForDiscord(result.content);
      const slashToken =
        payload.interaction === undefined
          ? undefined
          : deps.openToken(payload.interaction.sealedToken);
      // Fresh slash runs passed the fail-closed check above, so the token is
      // good; a stranded retry with a dead token skips the whole answer.
      const answerable = payload.interaction === undefined || slashToken !== undefined;
      if (answerable) {
        for (let index = partsPosted; index < parts.length; index += 1) {
          const posted = await postPart(index, parts[index]!, slashToken);
          if (posted !== undefined) postedMessageIds.push(posted);
          partsPosted = index + 1;
          saveStaged('invoke-done', result);
        }
      }
      if (conversationId !== undefined && deps.conversations !== undefined) {
        const conv = deps.conversations;
        const key = payload.invocationId;
        const assistantTurnId = `turn_${key}_a`;
        const beforeAssistant = conversationRepo.listTurns(conv.scope, conversationId);
        if (!beforeAssistant.some((turn) => turn.turnId === assistantTurnId)) {
          conversationRepo.appendTurn(conv.scope, {
            conversationId,
            turnId: assistantTurnId,
            at: nextAt(beforeAssistant),
            role: 'assistant',
            authorName: conv.botDisplayName,
            text: result.content,
            // Task 20: the turn carries its trace id so a later 👍/👎
            // reaction on a linked message can flag the matching trace.
            traceId: `trace_${key}`,
          });
        }
        if (payload.messageId !== undefined) {
          conversationRepo.linkMessages(conv.scope, conversationId, `turn_${key}_u`, 'user', [
            payload.messageId,
          ]);
        }
        if (postedMessageIds.length > 0) {
          conversationRepo.linkMessages(
            conv.scope,
            conversationId,
            assistantTurnId,
            'assistant',
            postedMessageIds,
          );
        }
        const traceId = `trace_${key}`;
        if (traceRepo.getTrace(conv.scope, traceId) === undefined) {
          const detail = result.detail;
          traceRepo.insertTrace(conv.scope, {
            traceId,
            at: deps.now(),
            userId: payload.userId,
            ...(payload.channelId === undefined ? {} : { channelId: payload.channelId }),
            behaviourId: payload.behaviourId,
            command: payload.command,
            source: payload.source,
            conversationId,
            turnId: assistantTurnId,
            question: Object.values(payload.input).join('\n'),
            answer: result.content,
            outcome: result.ok ? 'answered' : 'refused',
            durationMs: result.trace?.latencyMs ?? 0,
            attempts: detail?.attempts ?? [],
            ...(detail?.finishReason === undefined ? {} : { finishReason: detail.finishReason }),
            usage: detail?.usage ?? {},
            sections: detail?.sections ?? [],
            toolCalls: detail?.toolCalls ?? [],
            guard: detail?.guard ?? { removed: [] },
            timeline: [
              { label: 'received', atMs: 0 },
              { label: 'invoke-done', atMs: Math.max(0, invokeDoneAt - startedAt) },
              { label: 'answered', atMs: Math.max(0, deps.now() - startedAt) },
            ],
            discordMessageIds: [...postedMessageIds],
            sources: [...(result.trace?.sources ?? [])],
            flags: [...flags],
          });
        }
      }
      saveStaged('answered', result);
    }

    // Stage 3: the escalation post, with its own sent marker for the same
    // reason.
    if (
      reached < stageRank('escalation-sent') &&
      result.ok &&
      result.escalation !== undefined &&
      payload.channelId !== undefined
    ) {
      const reviewers = result.escalation.reviewerRoleIds.map((id) => `<@&${id}>`).join(' ');
      await deps.send(result.escalation.channelId, {
        content:
          `${reviewers}${reviewers === '' ? '' : '\n'}IT request ${result.escalation.ticketId} from <@${payload.userId}> in <#${payload.channelId}>:\n${result.content}`.slice(
            0,
            2_000,
          ),
        allowedMentions: { parse: [], roles: result.escalation.reviewerRoleIds },
      });
      saveStaged('escalation-sent', result);
    }

    // Stage 4: the AI log channel (ADR 0065), after the member has their
    // answer. Its own marker, so a retry resumes here and never re-answers.
    const logChannelId = deps.logChannelId();
    if (reached < stageRank('logged') && logChannelId !== undefined) {
      await deps.send(
        logChannelId,
        await logEntry({
          outcome: result.ok ? 'answered' : 'refused',
          answer: result.content,
          trace: result.trace,
        }),
      );
      saveStaged('logged', result);
    }
  },
});
