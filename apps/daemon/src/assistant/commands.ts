import {
  resolveAssistantBehaviour,
  safeLogFields,
  type AssistantBehaviour,
  type DomainEvent,
  type Logger,
  type MessageEvent,
  type OutgoingMessage,
  type SlashCommandEvent,
  type Subscriber,
} from '@bananasaurs/core';
import { routeAssistantMention } from '@bananasaurs/discord';

export type AssistantCommand =
  | 'ask'
  | 'find'
  | 'remind'
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
    }
  | { readonly ok: false; readonly content: string };

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
  readonly service: AssistantCommandService;
  readonly defer: (
    ref: { interactionId: string; token: string },
    options: { ephemeral: boolean },
  ) => Promise<void>;
  readonly respond: (
    ref: { interactionId: string; token: string },
    message: OutgoingMessage,
  ) => Promise<void>;
  readonly send: (channelId: string, message: OutgoingMessage) => Promise<unknown>;
  readonly logger: Logger;
}

const COMMANDS = new Set<AssistantCommand>([
  'ask',
  'find',
  'remind',
  'decision',
  'review-plan',
  'onboard',
  'agenda',
  'summarise',
  'announce',
  'checklist',
  'handoff',
]);
const value = (event: SlashCommandEvent, name: string): string | undefined => {
  const found = event.options.find((option) => option.name === name)?.value;
  return typeof found === 'string' ? found.trim() : undefined;
};

const commandInput = (event: SlashCommandEvent): Readonly<Record<string, string>> | undefined => {
  if (event.commandName === 'ask') {
    const question = value(event, 'question');
    return question ? { question } : undefined;
  }
  if (event.commandName === 'find') {
    const query = value(event, 'query');
    return query ? { query } : undefined;
  }
  if (event.commandName === 'remind') {
    const when = value(event, 'when');
    const text = value(event, 'text');
    return when && text ? { when, text } : undefined;
  }
  if (event.commandName === 'decision') {
    const topic = value(event, 'topic');
    const context = value(event, 'context');
    return topic ? { topic, ...(context ? { context } : {}) } : undefined;
  }
  if (event.commandName === 'review-plan') {
    const plan = value(event, 'plan');
    return plan ? { plan } : undefined;
  }
  if (
    ['onboard', 'agenda', 'summarise', 'announce', 'checklist', 'handoff'].includes(
      event.commandName,
    )
  ) {
    const request = value(event, 'request');
    return request ? { request } : undefined;
  }
  return undefined;
};

const directBehaviour = (
  behaviours: readonly AssistantBehaviour[],
  guildId: string,
): AssistantBehaviour =>
  resolveAssistantBehaviour(behaviours, {
    guildId,
    mentionedRoleIds: new Set(),
    directCommand: true,
  });

const reply = (content: string): OutgoingMessage => ({
  content: content.slice(0, 2_000),
  allowedMentions: { parse: [] },
});

const slashRef = (event: SlashCommandEvent) => ({
  interactionId: event.interactionId,
  token: event.token,
});

export const createAssistantCommandSubscriber = (deps: AssistantCommandDeps): Subscriber => ({
  name: 'assistant-commands',
  async handle(event: DomainEvent): Promise<void> {
    if (event.guildId !== deps.guildId) return;
    if (event.kind === 'slashCommand') await handleSlash(deps, event);
    if (event.kind === 'messageCreate') await handleMention(deps, event);
  },
});

async function handleSlash(deps: AssistantCommandDeps, event: SlashCommandEvent): Promise<void> {
  if (!COMMANDS.has(event.commandName as AssistantCommand)) return;
  const ref = slashRef(event);
  await deps.defer(ref, { ephemeral: event.commandName === 'remind' });

  const input = commandInput(event);
  if (input === undefined) {
    await deps.respond(ref, reply('That command is missing a required value.'));
    return;
  }

  try {
    const behaviours = await deps.service.behavioursForGuild(event.guildId);
    const behaviour = directBehaviour(behaviours, event.guildId);
    const result = await deps.service.invoke({
      guildId: event.guildId,
      channelId: event.channelId,
      userId: event.userId,
      callerRoleIds: event.userRoleIds ?? [],
      behaviour,
      command: event.commandName as AssistantCommand,
      input,
      source: 'slash-command',
      invocationId: event.interactionId,
    });
    await deps.respond(ref, reply(result.content));
  } catch (err) {
    deps.logger.error(
      safeLogFields({ component: 'assistant-command', guildId: event.guildId, err }),
      'assistant command failed before a response was produced',
    );
    await deps.respond(ref, reply('I could not complete that request. No action was taken.'));
  }
}

async function handleMention(deps: AssistantCommandDeps, event: MessageEvent): Promise<void> {
  const behaviours = await deps.service.behavioursForGuild(event.guildId);
  const route = routeAssistantMention(event, behaviours);
  if (route.kind === 'not-addressed') return;
  if (route.kind === 'ambiguous') {
    await deps.send(event.channelId, reply(route.message));
    return;
  }

  let result: Awaited<ReturnType<typeof deps.service.invoke>>;
  try {
    result = await deps.service.invoke({
      guildId: event.guildId,
      channelId: event.channelId,
      userId: event.authorId!,
      callerRoleIds: event.authorRoleIds ?? [],
      behaviour: route.behaviour,
      command: 'ask',
      input: { question: route.prompt },
      source: 'mention',
      invocationId: event.messageId,
    });
  } catch (err) {
    // Mirror handleSlash: a provider or storage failure answers the member
    // instead of vanishing into the pipeline's dispatch catch.
    deps.logger.error(
      safeLogFields({ component: 'assistant-mention', guildId: event.guildId, err }),
      'assistant mention failed before a response was produced',
    );
    await deps.send(
      event.channelId,
      reply('I could not complete that request. No action was taken.'),
    );
    return;
  }
  await deps.send(event.channelId, reply(result.content));
  if (result.ok && result.escalation !== undefined) {
    const reviewers = result.escalation.reviewerRoleIds.map((id) => `<@&${id}>`).join(' ');
    await deps.send(result.escalation.channelId, {
      content:
        `${reviewers}${reviewers === '' ? '' : '\n'}IT request ${result.escalation.ticketId} from <@${event.authorId!}> in <#${event.channelId}>:\n${result.content}`.slice(
          0,
          2_000,
        ),
      allowedMentions: { parse: [], roles: result.escalation.reviewerRoleIds },
    });
  }
}
