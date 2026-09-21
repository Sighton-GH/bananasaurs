import {
  assistantInvokePayload,
  JOB_KINDS,
  safeLogFields,
  type AssistantInvokePayload,
  type JobHandler,
  type Logger,
  type OutgoingMessage,
} from '@bananasaurs/core';
import type { AssistantCommandService } from '../assistant/commands.js';

/**
 * Runs one assistant invocation off the serial per-guild dispatch chain (B2).
 *
 * The subscriber (`apps/daemon/src/assistant/commands.ts`) does only the
 * cheap work inline — defer the interaction, route the mention — and enqueues
 * this job for everything expensive: resource fetches and the provider call.
 * Without this split one slow /ask stalls reaction roles, automod and /mod
 * behind it in the per-guild chain, and a provider hang exceeds Discord's
 * interaction window while the chain waits.
 *
 * The behaviour is re-resolved at run time rather than trusted from the
 * payload: a prompt edit or disable between enqueue and run takes effect,
 * and a behaviour deleted in between fails closed with a plain answer.
 */
const reply = (content: string): OutgoingMessage => ({
  content: content.slice(0, 2_000),
  allowedMentions: { parse: [] },
});

export const assistantInvokeHandler = (deps: {
  guildId: string;
  service: AssistantCommandService;
  respond: (
    ref: { interactionId: string; token: string },
    message: OutgoingMessage,
  ) => Promise<void>;
  send: (channelId: string, message: OutgoingMessage) => Promise<unknown>;
  logger: Logger;
}): JobHandler<AssistantInvokePayload> => ({
  kind: JOB_KINDS.assistantInvoke,
  payload: assistantInvokePayload,
  async run(payload) {
    const answer = async (content: string): Promise<void> => {
      if (payload.interaction !== undefined) {
        await deps.respond(payload.interaction, reply(content));
      } else if (payload.channelId !== undefined) {
        await deps.send(payload.channelId, reply(content));
      }
    };

    let result: Awaited<ReturnType<AssistantCommandService['invoke']>>;
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

    await answer(result.content);
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
