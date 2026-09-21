import { randomUUID } from 'node:crypto';
import {
  assertProviderEligible,
  CLUB_ASSISTANT_SKILLS,
  compileAssistantContext,
  createNvidiaNimProvider,
  createOpenRouterProvider,
  GeminiProvider,
  redactEvidenceText,
  SafeProvider,
  type Config,
  type TextProvider,
  validateReminderDraft,
} from '@bananasaurs/core';
import {
  assistantRepo,
  eligibilityRepo,
  type GuildScope,
  type InstanceScope,
} from '@bananasaurs/storage';
import type { AssistantCommandService, AssistantInvocation } from './commands.js';
import { ReviewedResourceFetcher } from './resource-fetcher.js';

export const providerFor = (config: Config): TextProvider | undefined => {
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
/**
 * Raw Discord mention snowflakes carry no meaning to a provider and trip the
 * conservative outbound scan's long-digit detectors, so they are flattened to
 * readable tokens before anything leaves the process. Only the mention shape
 * is rewritten; bare numbers stay untouched.
 */
export const sanitizeMentionsForProvider = (text: string): string =>
  text
    .replace(/<@&\d{17,20}>/g, '@role')
    .replace(/<@!?\d{17,20}>/g, '@user')
    .replace(/<#\d{17,20}>/g, '#channel');
export interface AssistantServiceTestPorts {
  readonly provider?: TextProvider | undefined;
  readonly fetchResource?:
    ((url: string) => ReturnType<ReviewedResourceFetcher['fetch']>) | undefined;
}
export const createAssistantService = (
  scope: GuildScope,
  instance: InstanceScope,
  config: Config,
  now: () => number,
  testPorts: AssistantServiceTestPorts = {},
): AssistantCommandService => {
  // The safety/spend boundary wraps whatever provider is in play, including a
  // test-injected one: no caller may bypass the pre-API scan (finding 2).
  const rawProvider = testPorts.provider ?? providerFor(config);
  const provider =
    rawProvider === undefined || rawProvider instanceof SafeProvider
      ? rawProvider
      : new SafeProvider(rawProvider, config.AI_PROFILE_COST_CLASS, {
          monthlyCapUsdMicros: 0,
        });
  const resourceFetcher = new ReviewedResourceFetcher({ now });
  const fetchResource = testPorts.fetchResource ?? ((url: string) => resourceFetcher.fetch(url));
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
      // The behaviour's caller role gate applies on every path. The mention
      // router already enforced it; the slash path did not (finding 9).
      if (!input.behaviour.callerRoleIds.some((roleId) => input.callerRoleIds.includes(roleId)))
        return {
          ok: false,
          content: 'This behaviour is not available to your server roles. No action was taken.',
        };
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
        // A reminder needs a real destination channel. Falling back to the
        // user id produced a row that could never be delivered while the
        // reply said "Reminder scheduled" (finding 7).
        if (input.channelId === undefined)
          return {
            ok: false,
            content: 'Reminders must run in a server channel. No reminder was scheduled.',
          };
        // The same validation every reminder write goes through (finding 8)
        // - the slash path shares `createReminder`'s checks instead of
        // carrying its own copy.
        const draft = validateReminderDraft(
          { dueAt: Date.parse(input.input.when ?? ''), text: input.input.text ?? '' },
          now(),
        );
        if (!draft.ok)
          return {
            ok: false,
            content: `${draft.error.charAt(0).toUpperCase()}${draft.error.slice(1)}. No reminder was scheduled.`,
          };
        const text = draft.text;
        const dueAt = Date.parse(input.input.when ?? '');
        const id = randomUUID();
        // Hard rule 6: the dedupe key is the Discord interaction or message
        // that asked for the reminder, not a fresh UUID, so a retried
        // interaction cannot book the same reminder twice (finding 7).
        const dedupeKey = `reminder:${scope.guildId}:${input.invocationId ?? id}`;
        try {
          assistantRepo.insertReminder(scope, {
            id,
            guildId: scope.guildId,
            creatorId: input.userId,
            destinationId: input.channelId,
            text,
            dueAt,
            createdAt: now(),
            status: 'scheduled',
            dedupeKey,
          });
        } catch (err) {
          // Only the dedupe-key unique conflict is the benign idempotency
          // case. Reporting any other failure (disk, schema, FK) as "already
          // scheduled" would turn a real create failure into a success the
          // member believes (should-fix).
          if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
            return {
              ok: true,
              content: 'That reminder is already scheduled. I did not create a duplicate.',
            };
          }
          throw err;
        }
        assistantRepo.recordSkillActivity(scope, {
          id: randomUUID(),
          at: now(),
          behaviourId: input.behaviour.id,
          skillId: skill,
          actorId: input.userId,
          outcome: 'completed',
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
      // Hard rule 5: the provider_eligibility table is consulted on the
      // request path, and a missing or ineligible row fails closed before
      // any member content crosses the provider boundary (finding 1).
      const eligibilityRow = eligibilityRepo.findEligibility(instance, provider.id);
      try {
        if (eligibilityRow === undefined)
          throw new Error(`no provider_eligibility row for ${provider.id}`);
        assertProviderEligible(
          {
            trainsOnInput: eligibilityRow.trainsOnInput,
            productionUseAllowed: eligibilityRow.productionUseAllowed,
            evidenceUrl: eligibilityRow.evidenceUrl,
            reviewedAt: new Date(eligibilityRow.reviewedAt).toISOString(),
          },
          'club',
        );
      } catch {
        assistantRepo.recordSkillActivity(scope, {
          id: randomUUID(),
          at: now(),
          behaviourId: input.behaviour.id,
          skillId: skill,
          actorId: input.userId,
          outcome: 'denied',
          detail: 'Provider training-data eligibility is not verified.',
        });
        return {
          ok: false,
          content:
            "The AI provider's training-data eligibility is not verified, so no content was sent outside the server.",
        };
      }
      const resources = assistantRepo
        .listResources(scope)
        .filter((r) => input.behaviour.resourceIds.includes(r.id) && r.enabled);
      const fetched = await Promise.all(
        resources
          .filter((resource) => ['website', 'document', 'repository'].includes(resource.kind))
          .map(async (resource) => ({
            resource,
            result: await fetchResource(resource.url),
          })),
      );
      // Evidence-appropriate safety policy (should-fix, round 2): fetched
      // public evidence is redact-and-continue, never hard-refuse. A club
      // page that prints a contact email used to fail the whole request at
      // the provider preflight and leave no activity row.
      const redactedEvidence = fetched.flatMap(({ resource, result }) => {
        if (!result.ok) return [];
        const redacted = redactEvidenceText(result.evidence.text);
        return [
          {
            resource,
            result,
            text: redacted.text,
            detectors: redacted.detectors,
          },
        ];
      });
      for (const { resource, result, detectors } of redactedEvidence) {
        assistantRepo.recordResourceFetch(scope, resource.id, {
          status: 'ok',
          at: now(),
          detail:
            `${result.evidence.mediaType}; ${result.evidence.text.length.toLocaleString('en-CA')} characters; cache=${result.cache}` +
            (detectors.length > 0 ? `; redacted: ${detectors.join(', ')}` : ''),
        });
      }
      for (const { resource, result } of fetched) {
        if (result.ok) continue;
        assistantRepo.recordResourceFetch(scope, resource.id, {
          status: result.code === 'private-address' || result.code === 'invalid-url'
            ? 'blocked'
            : 'failed',
          at: now(),
          detail: `${result.code}: ${result.message}`,
        });
      }
      const evidence = redactedEvidence.map(({ resource, text }) => ({
        sourceId: resource.id,
        title: resource.title,
        text,
        accessible: true,
      }));
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
        messages: [
          {
            role: 'user',
            text: [sanitizeMentionsForProvider(textOf(input.input)), context.evidenceEnvelope]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
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
          // Hard rule 6, same posture as reminders: the dedupe anchor is
          // the Discord interaction or message that produced the
          // escalation, so a retried invocation cannot open the ticket
          // twice and two genuinely different requests never collide on
          // byte-identical model text (review cosmetic).
          dedupeKey: `it:${scope.guildId}:${input.invocationId ?? ticketId}`,
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
