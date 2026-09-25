import {
  assistantInvokeCursor,
  assistantInvokePayload,
  JOB_KINDS,
  ProviderError,
  RetryAfterError,
  safeLogFields,
  type AssistantInvokePayload,
  type JobHandler,
  type Logger,
  type OutgoingMessage,
} from '@bananasaurs/core';
import type {
  AssistantCommandService,
  AssistantInvocationResult,
  InvocationTrace,
} from '../assistant/commands.js';
import { assistantLogMessage, type AssistantLogInput } from '../assistant/log-message.js';

/**
 * Runs one assistant invocation off the serial per-guild dispatch chain (B2).
 *
 * The subscriber (`apps/daemon/src/assistant/commands.ts`) does only the
 * cheap work inline - defer the interaction, route the mention - and
 * enqueues this job for everything expensive: resource fetches and the
 * provider call. Without this split one slow /ask stalls reaction roles,
 * automod and /mod behind it in the per-guild chain, and a provider hang
 * exceeds Discord's interaction window while the chain waits.
 *
 * Two invariants the independent audit pinned down:
 *
 * - The behaviour is re-resolved at run time rather than trusted from the
 *   payload: a prompt edit or disable between enqueue and run takes effect,
 *   and a behaviour deleted in between fails closed with a plain answer.
 * - Invoke and delivery are staged through the job cursor. If the provider
 *   call succeeded but the Discord answer threw, a retry must NOT invoke
 *   again - a second invoke would repeat the provider spend and could
 *   duplicate the ticket and skill-activity effects. The cursor carries the
 *   finished result (and whether the answer landed) across attempts.
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
}
const STAGES: readonly CursorStage[] = ['invoke-done', 'answered', 'escalation-sent', 'logged'];
/** Total order over stages: a retry resumes AFTER the furthest stage reached. */
const stageRank = (stage: CursorStage): number => STAGES.indexOf(stage);

/** Zod's optional fields come back as `undefined`; the result type wants them absent. */
const stripUndefined = (value: object): InvocationTrace =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as unknown as InvocationTrace;

const parseCursor = (cursor: string | null): StagedCursor | undefined => {
  if (cursor === null) return undefined;
  try {
    // Own prior write, still validated (hard rule 3): a malformed row is
    // "no progress", never a TypeError on every retry.
    const parsed = assistantInvokeCursor.safeParse(JSON.parse(cursor));
    if (!parsed.success) return undefined;
    const { stage, result } = parsed.data;
    const trace = result.trace === undefined ? {} : { trace: stripUndefined(result.trace) };
    if (!result.ok) return { stage, result: { ok: false, content: result.content, ...trace } };
    return {
      stage,
      result:
        result.escalation === undefined
          ? { ok: true, content: result.content, ...trace }
          : { ok: true, content: result.content, escalation: result.escalation, ...trace },
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
const BUSY_REPLY = 'The AI service is busy right now. Try again in a minute. No action was taken.';

/**
 * ADR 0077: when a `:free` model's daily request allowance is exhausted, a
 * retry cannot help - it does not reset for up to 24 hours, and the whole
 * point is to stop spending the (already zero) remaining allowance. The
 * member is told exactly when it resets instead of being told to try again
 * in a minute.
 */
const nextUtcMidnight = (nowMs: number): number => {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
};
const dailyQuotaReply = (resetAt: number | undefined, nowMs: number): string => {
  const unix = Math.floor((resetAt ?? nextUtcMidnight(nowMs)) / 1000);
  return `The bot's free AI allowance for today is used up. It resets <t:${unix}:t>. No action was taken.`;
};

export const assistantInvokeHandler = (deps: {
  guildId: string;
  service: AssistantCommandService;
  /** `undefined` when the sealed token is not this process's - fail closed. */
  openToken: (sealed: string) => string | undefined;
  respond: (
    ref: { interactionId: string; token: string },
    message: OutgoingMessage,
  ) => Promise<void>;
  send: (channelId: string, message: OutgoingMessage) => Promise<unknown>;
  logger: Logger;
  /** ADR 0065: the AI log channel, read at run time; undefined means no log. */
  logChannelId: () => string | undefined;
  now: () => number;
}): JobHandler<AssistantInvokePayload> => ({
  kind: JOB_KINDS.assistantInvoke,
  payload: assistantInvokePayload,
  async run(payload, context) {
    const answer = async (content: string): Promise<void> => {
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

    // Stage 1: the invoke. Skipped on a retry that already finished it.
    let result: AssistantInvocationResult;
    if (prior !== undefined) {
      result = prior.result;
    } else {
      try {
        const behaviours = await deps.service.behavioursForGuild(deps.guildId);
        const behaviour = behaviours.find((b) => b.id === payload.behaviourId);
        if (behaviour === undefined || !behaviour.enabled) {
          const text = 'That assistant behaviour is no longer available. No action was taken.';
          await answer(text);
          await logFailure(text, 'The behaviour was deleted or turned off before the request ran.');
          return;
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
        });
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
          await answer(text);
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
        await answer(text);
        await logFailure(text, err instanceof Error ? err.message : 'unknown error');
        return;
      }
      // Persist BEFORE the first delivery attempt: a delivery throw from here
      // on retries with this cursor and never re-invokes.
      context.saveCursor(JSON.stringify({ stage: 'invoke-done', result } satisfies StagedCursor));
    }

    // Stage 2: the answer. Persisted for EVERY result, not only escalation
    // ones: a crash or completion retry after the send must not repeat the
    // member-facing answer (independent audit, round 2).
    if (reached < stageRank('answered')) {
      await answer(result.content);
      context.saveCursor(JSON.stringify({ stage: 'answered', result } satisfies StagedCursor));
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
      context.saveCursor(
        JSON.stringify({ stage: 'escalation-sent', result } satisfies StagedCursor),
      );
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
      context.saveCursor(JSON.stringify({ stage: 'logged', result } satisfies StagedCursor));
    }
  },
});
