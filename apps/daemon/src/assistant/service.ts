import { randomUUID } from 'node:crypto';
import {
  compileAssistantContext,
  CLUB_ASSISTANT_SKILLS,
  GeminiProvider,
  createNvidiaNimProvider,
  createOpenRouterProvider,
  SafeProvider,
  type Config,
  type TextProvider,
} from '@bananasaurs/core';
import { assistantRepo, type GuildScope } from '@bananasaurs/storage';
import type { AssistantCommandService, AssistantInvocation } from './commands.js';
import { ReviewedResourceFetcher } from './resource-fetcher.js';

const providerFor = (config: Config): TextProvider | undefined => {
  if (config.AI_PROVIDER === 'off' || config.AI_MODEL === undefined) return undefined;
  if (config.AI_PROVIDER === 'gemini' && config.GEMINI_API_KEY !== undefined)
    return new SafeProvider(
      new GeminiProvider({ apiKey: config.GEMINI_API_KEY }),
      config.AI_PROFILE_COST_CLASS,
      {
        monthlyCapUsdMicros: 0,
      },
    );
  if (config.AI_PROVIDER === 'openrouter' && config.OPENROUTER_API_KEY !== undefined)
    return new SafeProvider(
      createOpenRouterProvider({ apiKey: config.OPENROUTER_API_KEY }),
      config.AI_PROFILE_COST_CLASS,
      { monthlyCapUsdMicros: 0 },
    );
  if (config.AI_PROVIDER === 'nvidia-nim' && config.NVIDIA_NIM_API_KEY !== undefined)
    return new SafeProvider(
      createNvidiaNimProvider({ apiKey: config.NVIDIA_NIM_API_KEY }),
      config.AI_PROFILE_COST_CLASS,
      { monthlyCapUsdMicros: 0 },
    );
  return undefined;
};
const textOf = (input: Readonly<Record<string, string>>): string => Object.values(input).join('\n');
export const createAssistantService = (
  scope: GuildScope,
  config: Config,
  now: () => number,
): AssistantCommandService => {
  const provider = providerFor(config);
  const resourceFetcher = new ReviewedResourceFetcher({ now });
  return {
    behavioursForGuild: () => Promise.resolve(assistantRepo.listBehaviours(scope)),
    async invoke(input: AssistantInvocation) {
      const commandSkill: Record<AssistantInvocation['command'], string> = {
        ask: 'search-club',
        find: 'search-club',
        remind: 'create-reminder',
        decision: 'record-decision',
        'review-plan': 'review-plan',
        onboard: 'onboarding-guide',
        agenda: 'draft-agenda',
        summarise: 'summarise-meeting',
        announce: 'draft-announcement',
        checklist: 'event-checklist',
        handoff: 'draft-handoff',
      };
      const skill = commandSkill[input.command];
      if (!input.behaviour.allowedSkillIds.includes(skill))
        return {
          ok: false,
          content: `This behaviour is not allowed to use ${skill}. No action was taken.`,
        };
      const owner = input.userId === config.BANANASAURS_OWNER_USER_ID;
      const grants = assistantRepo.listSkillGrants(scope);
      const permittedSkills = CLUB_ASSISTANT_SKILLS.filter((candidate) => {
        if (!input.behaviour.allowedSkillIds.includes(candidate.id)) return false;
        if (owner) return true;
        if (candidate.ownerOnly === true) return false;
        const grant = grants.find((item) => item.skillId === candidate.id);
        return (
          grant !== undefined &&
          (grant.userIds.includes(input.userId) ||
            grant.roleIds.some((roleId) => input.callerRoleIds.includes(roleId)))
        );
      });
      if (!permittedSkills.some((candidate) => candidate.id === skill)) {
        assistantRepo.recordSkillActivity(scope, {
          id: randomUUID(),
          at: now(),
          behaviourId: input.behaviour.id,
          skillId: skill,
          actorId: input.userId,
          outcome: 'denied',
          detail: 'No matching owner, user or role grant.',
        });
        return {
          ok: false,
          content:
            'You do not have a matching grant for this assistant skill. No action was taken.',
        };
      }
      if (input.command === 'remind') {
        const dueAt = Date.parse(input.input.when ?? '');
        if (!Number.isFinite(dueAt) || dueAt <= now())
          return {
            ok: false,
            content: 'Use an unambiguous future date and time. No reminder was scheduled.',
          };
        const id = randomUUID();
        assistantRepo.insertReminder(scope, {
          id,
          guildId: scope.guildId,
          creatorId: input.userId,
          destinationId: input.channelId ?? input.userId,
          text: input.input.text ?? '',
          dueAt,
          createdAt: now(),
          status: 'scheduled',
          dedupeKey: `reminder:${scope.guildId}:${id}`,
        });
        return {
          ok: true,
          content: `Reminder scheduled for ${new Date(dueAt).toLocaleString('en-CA')}.`,
        };
      }
      if (input.command === 'find')
        return {
          ok: false,
          content:
            'Search is holding because Discord channel visibility has not been verified for this request. No hidden source was searched.',
        };
      if (provider === undefined || config.AI_MODEL === undefined)
        return {
          ok: false,
          content:
            'The free AI provider is not configured, so no content was sent outside the server.',
        };
      const resources = assistantRepo
        .listResources(scope)
        .filter((r) => input.behaviour.resourceIds.includes(r.id) && r.enabled);
      const fetched = await Promise.all(
        resources
          .filter((resource) => ['website', 'document', 'repository'].includes(resource.kind))
          .map(async (resource) => ({
            resource,
            result: await resourceFetcher.fetch(resource.url),
          })),
      );
      for (const { resource, result } of fetched) {
        assistantRepo.recordResourceFetch(scope, resource.id, {
          status: result.ok
            ? 'ok'
            : result.code === 'private-address' || result.code === 'invalid-url'
              ? 'blocked'
              : 'failed',
          at: now(),
          detail: result.ok
            ? `${result.evidence.mediaType}; ${result.evidence.text.length.toLocaleString('en-CA')} characters; cache=${result.cache}`
            : `${result.code}: ${result.message}`,
        });
      }
      const evidence = fetched.flatMap(({ resource, result }) =>
        result.ok
          ? [
              {
                sourceId: resource.id,
                title: resource.title,
                text: result.evidence.text,
                accessible: true,
              },
            ]
          : [],
      );
      const context = compileAssistantContext({
        behaviour: input.behaviour,
        serverCard: 'Bananasaurs club assistant',
        resources,
        evidence,
        skills: permittedSkills,
      });
      const isIt = input.behaviour.surface === 'it-services';
      const response = await provider.generateText({
        model: config.AI_MODEL,
        systemInstruction:
          context.systemInstruction +
          (isIt
            ? '\nIf this request needs a human action, permission, or review, start the response with exactly ESCALATE: followed by a safe summary. Never include credentials.'
            : '') +
          (input.command === 'decision' || input.command === 'review-plan'
            ? '\nReturn analysis as a DRAFT. State that it is not club policy and has not been saved. Do not claim persistence.'
            : ''),
        messages: [{ role: 'user', text: textOf(input.input) }],
        maxOutputTokens: 800,
        temperature: 0.2,
      });
      assistantRepo.recordSkillActivity(scope, {
        id: randomUUID(),
        at: now(),
        behaviourId: input.behaviour.id,
        skillId: skill,
        actorId: input.userId,
        outcome: 'completed',
      });
      if (input.command === 'decision' || input.command === 'review-plan') {
        const id = `${input.command}-${randomUUID()}`;
        assistantRepo.insertDecisionDraft(scope, {
          id,
          kind: input.command,
          summary: response.text.slice(0, 4_000),
          requesterId: input.userId,
          provenance: `Discord ${input.source}; behaviour=${input.behaviour.id}; resources=${context.disclosurePlan.join(',') || 'none'}`,
          at: now(),
        });
        return {
          ok: true,
          content: `${response.text}

Draft ID: ${id}. This is analysis, not club policy. An owner must review and save it from the dashboard.`,
        };
      }
      if (isIt && response.text.startsWith('ESCALATE:')) {
        if (
          input.behaviour.ticketChannelId === undefined ||
          input.behaviour.reviewerRoleIds.length === 0
        )
          return {
            ok: false,
            content:
              'This needs human action, but IT ticket routing is not fully configured. No ticket was created.',
          };
        const summary = response.text.slice('ESCALATE:'.length).trim().slice(0, 1_500);
        const ticketId = `it-${randomUUID()}`;
        const created = assistantRepo.insertTicket(scope, {
          id: ticketId,
          behaviourId: input.behaviour.id,
          channelId: input.behaviour.ticketChannelId,
          requesterId: input.userId,
          summary,
          dedupeKey: `it:${input.userId}:${input.channelId ?? 'none'}:${summary}`,
          at: now(),
        });
        if (!created)
          return {
            ok: true,
            content: 'That IT request is already open. I did not create a duplicate.',
          };
        return {
          ok: true,
          content: summary,
          escalation: {
            channelId: input.behaviour.ticketChannelId,
            reviewerRoleIds: input.behaviour.reviewerRoleIds,
            ticketId,
          },
        };
      }
      return { ok: true, content: response.text };
    },
  };
};
