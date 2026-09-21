import {
  assistantInvokePayload,
  JOB_KINDS,
  safeLogFields,
  type AssistantInvokePayload,
  type JobHandler,
  type Logger,
  type OutgoingMessage,
} from '@bananasaurs/core';
import type { AssistantCommandService, AssistantInvocationResult } from '../assistant/commands.js';

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

/** Cursor stage: invoke finished, answer not yet attempted. */
interface InvokeDoneCursor {
  readonly stage: 'invoke-done';
  readonly result: AssistantInvocationResult;
}
/** Cursor stage: the answer landed, only the escalation post remains. */
interface AnsweredCursor {
  readonly stage: 'answered';
  readonly result: AssistantInvocationResult;
}

const parseCursor = (cursor: string | null): InvokeDoneCursor | AnsweredCursor | undefined => {
  if (cursor === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'stage' in parsed &&
      'result' in parsed &&
      ((parsed as { stage: unknown }).stage === 'invoke-done' ||
        (parsed as { stage: unknown }).stage === 'answered')
    ) {
      return parsed as InvokeDoneCursor | AnsweredCursor;
    }
    return undefined;
  } catch {
    return undefined;
  }
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
}): JobHandler<AssistantInvokePayload> => ({
  kind: JOB_KINDS.assistantInvoke,
  payload: assistantInvokePayload,
  async run(payload, context) {
    const answer = async (content: string): Promise<void> => {
      if (payload.interaction !== undefined) {
        const token = deps.openToken(payload.interaction.sealedToken);
        if (token === undefined) {
          // A restart forgot the sealing key; the old interaction cannot be
          // answered and its token has expired by now anyway. Fail closed.
          deps.logger.warn(
            safeLogFields({ component: 'assistant-job', guildId: deps.guildId }),
            'assistant answer dropped: interaction token is not from this process',
          );
          return;
        }
        await deps.respond(
          { interactionId: payload.interaction.interactionId, token },
          reply(content),
        );
      } else if (payload.channelId !== undefined) {
        await deps.send(payload.channelId, reply(content));
      }
    };

    // Stage 1: the invoke. Skipped on a retry that already finished it.
    const prior = parseCursor(context.cursor);
    let result: AssistantInvocationResult;
    if (prior !== undefined) {
      result = prior.result;
    } else {
      try {
        const behaviours = await deps.service.behavioursForGuild(deps.guildId);
        const behaviour = behaviours.find((b) => b.id === payload.behaviourId);
        if (behaviour === undefined || !behaviour.enabled) {
          await answer('That assistant behaviour is no longer available. No action was taken.');
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
        // Mirror the subscriber's failure contract: a provider or storage
        // failure answers the member instead of vanishing into a job retry.
        deps.logger.error(
          safeLogFields({ component: 'assistant-job', guildId: deps.guildId, err }),
          'assistant invocation failed before a response was produced',
        );
        await answer('I could not complete that request. No action was taken.');
        return;
      }
      // Persist BEFORE the first delivery attempt: a delivery throw from here
      // on retries with this cursor and never re-invokes.
      context.saveCursor(
        JSON.stringify({ stage: 'invoke-done', result } satisfies InvokeDoneCursor),
      );
    }

    // Stage 2: the answer. Skipped on a retry where it already landed.
    if (prior?.stage !== 'answered') {
      await answer(result.content);
      if (result.ok && result.escalation !== undefined) {
        context.saveCursor(JSON.stringify({ stage: 'answered', result } satisfies AnsweredCursor));
      }
    }

    // Stage 3: the escalation post.
    if (result.ok && result.escalation !== undefined && payload.channelId !== undefined) {
      const reviewers = result.escalation.reviewerRoleIds.map((id) => `<@&${id}>`).join(' ');
      await deps.send(result.escalation.channelId, {
        content:
          `${reviewers}${reviewers === '' ? '' : '\n'}IT request ${result.escalation.ticketId} from <@${payload.userId}> in <#${payload.channelId}>:\n${result.content}`.slice(
            0,
            2_000,
          ),
        allowedMentions: { parse: [], roles: result.escalation.reviewerRoleIds },
      });
    }
  },
});
