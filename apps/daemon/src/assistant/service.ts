import { randomUUID } from 'node:crypto';
import {
  assertProviderEligible,
  CLUB_ASSISTANT_SKILLS,
  compileAssistantContext,
  createNvidiaNimProvider,
  createOpenRouterProvider,
  GeminiProvider,
  providerMayTrain,
  redactEvidenceText,
  SafeProvider,
  safeLogFields,
  type Config,
  type Logger,
  type TextProvider,
  validateReminderDraft,
} from '@bananasaurs/core';
import {
  archiveRepo,
  archiveSearchRepo,
  assistantRepo,
  eligibilityRepo,
  type GuildScope,
  type InstanceScope,
} from '@bananasaurs/storage';
import type {
  AssistantCommandService,
  AssistantInvocation,
  AssistantInvocationResult,
} from './commands.js';
import { braveWebSearch } from './brave-search.js';
import { generateAnswer, type GenerationTrace } from './generate.js';
import {
  runAssistantTool,
  toolDeclarations,
  type ArchiveHit,
  type AssistantToolPorts,
  type WebResult,
} from './tools.js';
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
  /** Replaces Brave's HTTP call in tests. */
  readonly webSearch?: ((query: string) => Promise<readonly WebResult[]>) | undefined;
}

/** What the tools need from live Discord (ADR 0067). */
export interface AssistantDiscordPorts {
  /**
   * Text channels the member can view and read history in, from their live
   * permissions. The archive tool searches only these; empty fails closed.
   */
  readonly memberChannels: (
    userId: string,
  ) => Promise<readonly { readonly id: string; readonly name: string }[]>;
}
export const createAssistantService = (
  scope: GuildScope,
  instance: InstanceScope,
  config: Config,
  now: () => number,
  testPorts: AssistantServiceTestPorts = {},
  liveConfig: () => Config = () => config,
  logger: Pick<Logger, 'warn'> = { warn: () => undefined },
  discord: AssistantDiscordPorts = { memberChannels: () => Promise.resolve([]) },
): AssistantCommandService => {
  // The safety/spend boundary wraps whatever provider is in play, including a
  // test-injected one: no caller may bypass the pre-API scan (finding 2).
  const currentProvider = (): TextProvider | undefined => {
    const current = liveConfig();
    const rawProvider = testPorts.provider ?? providerFor(current);
    return rawProvider === undefined || rawProvider instanceof SafeProvider
      ? rawProvider
      : new SafeProvider(rawProvider, current.AI_PROFILE_COST_CLASS, { monthlyCapUsdMicros: 0 });
  };
  const resourceFetcher = new ReviewedResourceFetcher({ now });
  const fetchResource = testPorts.fetchResource ?? ((url: string) => resourceFetcher.fetch(url));
  /** ADR 0067: archive hits from channels the member can view. Threads are left out. */
  const searchArchive = async (userId: string, query: string): Promise<readonly ArchiveHit[]> => {
    if (query.trim() === '') return [];
    const visible = new Set((await discord.memberChannels(userId)).map((channel) => channel.id));
    const channelIds = archiveRepo
      .listChannels(scope)
      .map((channel) => channel.channelId)
      .filter((id) => visible.has(id));
    if (channelIds.length === 0) return [];
    // A private thread inside a visible channel is not visible to every member
    // who can see the channel, and the archive does not record which threads
    // are private, so member-facing search leaves every thread out.
    return archiveSearchRepo
      .searchMessages(scope, { query, visibility: { channelIds }, limit: 16 })
      .hits.filter((hit) => hit.threadId === undefined)
      .slice(0, 8)
      .map((hit) => ({
        channelId: hit.channelId,
        messageId: hit.messageId,
        createdAt: hit.createdAt,
        excerpt: hit.excerpt,
      }));
  };
  const invokeOnce = async (
    input: AssistantInvocation,
    sink: { trace?: GenerationTrace },
  ): Promise<AssistantInvocationResult> => {
    {
      const currentConfig = liveConfig();
      const provider = currentProvider();
      const commandSkill: Record<AssistantInvocation['command'], string> = {
        ask: 'search-club',
        find: 'search-club',
        remind: 'create-reminder',
        remember: 'propose-memory',
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
      const owner = input.userId === config.BANANASAURS_OWNER_USER_ID;
      // Owners can complete first-run setup before any caller role is selected.
      // Everyone else still fails closed against the behaviour allowlist.
      if (
        !owner &&
        !input.behaviour.callerRoleIds.some((roleId) => input.callerRoleIds.includes(roleId))
      )
        return {
          ok: false,
          content: 'This behaviour is not available to your server roles. No action was taken.',
        };
      if (!input.behaviour.allowedSkillIds.includes(skill))
        return {
          ok: false,
          content: `This behaviour is not allowed to use ${skill}. No action was taken.`,
        };
      // ADR 0064: passing the behaviour's "Who can ask" allows every skill in
      // its allowlist. Owner-only skills stay owner-only; per-skill grants are
      // no longer a gate.
      const permittedSkills = CLUB_ASSISTANT_SKILLS.filter(
        (candidate) =>
          input.behaviour.allowedSkillIds.includes(candidate.id) &&
          (owner || candidate.ownerOnly !== true),
      );
      if (!permittedSkills.some((candidate) => candidate.id === skill)) {
        assistantRepo.recordSkillActivity(scope, {
          id: randomUUID(),
          at: now(),
          behaviourId: input.behaviour.id,
          skillId: skill,
          actorId: input.userId,
          outcome: 'denied',
          detail: 'The skill is owner-only.',
        });
        return {
          ok: false,
          content: 'Only the server owner can use this assistant skill. No action was taken.',
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
        // The dedupe-key conflict comes back as a typed repo result: only
        // that exact replay is the benign "already scheduled" answer, and a
        // real write failure still throws instead of reading as success
        // (should-fix; typed per the independent audit, round 2).
        const insert = assistantRepo.insertReminder(scope, {
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
        if (insert === 'duplicate') {
          return {
            ok: true,
            content: 'That reminder is already scheduled. I did not create a duplicate.',
          };
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
      if (input.command === 'find') {
        // ADR 0067: the archive, limited to channels this member can view.
        const hits = await searchArchive(input.userId, input.input.query ?? '');
        return {
          ok: true,
          content:
            hits.length === 0
              ? 'No matching messages in the channels you can see.'
              : hits
                  .map(
                    (hit) =>
                      `https://discord.com/channels/${scope.guildId}/${hit.channelId}/${hit.messageId}\n> ${hit.excerpt}`,
                  )
                  .join('\n')
                  .slice(0, 1_900),
        };
      }
      if (provider === undefined || currentConfig.AI_MODEL === undefined)
        return {
          ok: false,
          content:
            'The free AI provider is not configured, so no content was sent outside the server.',
        };
      // Hard rule 5 (ADR 0062): the provider_eligibility table is consulted
      // on the request path. A missing terms record, or one that does not
      // allow production use, fails closed before any member content crosses
      // the provider boundary (finding 1). A provider that may train on input
      // is allowed by owner decision and raises a warning instead.
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
          detail: 'Provider terms are not recorded or do not allow this use.',
        });
        return {
          ok: false,
          content:
            "The AI provider's terms are not recorded or don't allow this use, so no content was sent outside the server.",
        };
      }
      if (providerMayTrain(eligibilityRow))
        logger.warn(
          safeLogFields({
            component: 'assistant',
            guildId: input.guildId,
            reason: 'provider-may-train',
          }),
          'assistant provider may train on server content',
        );
      // ADR 0067: every enabled resource is available to every behaviour. The
      // behaviour's own list is fetched up front as preferred evidence; with
      // tools the model opens the others itself, without them all are fetched.
      const resources = assistantRepo.listResources(scope).filter((r) => r.enabled);
      const emphasised = resources.filter((r) => input.behaviour.resourceIds.includes(r.id));
      const toolsAvailable = provider.capabilities.has('tools');
      const prefetch = toolsAvailable
        ? emphasised
        : [...emphasised, ...resources.filter((r) => !emphasised.includes(r))];
      const fetched = await Promise.all(
        prefetch
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
          status:
            result.code === 'private-address' || result.code === 'invalid-url'
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
        serverCard:
          assistantRepo.getServerCard(scope) +
          (assistantRepo.memoryPreference(scope, input.userId).optedOut
            ? ''
            : '\nCurated memory:\n' +
              assistantRepo
                .listMemories(scope)
                .filter(
                  (memory) => memory.subjectId === undefined || memory.subjectId === input.userId,
                )
                .map((memory) => '- ' + memory.content)
                .join('\n')),
        resources,
        evidence,
        skills: permittedSkills,
        toolsAvailable,
      });
      const isIt = input.behaviour.surface === 'it-services';
      const toolPorts: AssistantToolPorts = {
        userId: input.userId,
        now,
        timeZone: currentConfig.BANANASAURS_TIME_ZONE,
        searchArchive: (query) => searchArchive(input.userId, query),
        resources: () => resources,
        fetchResource,
        webSearch:
          testPorts.webSearch ??
          (currentConfig.BRAVE_SEARCH_API_KEY === undefined
            ? undefined
            : (query: string) =>
                braveWebSearch({ apiKey: currentConfig.BRAVE_SEARCH_API_KEY! }, query)),
        serverCard: () => assistantRepo.getServerCard(scope),
        visibleChannels: () => discord.memberChannels(input.userId),
        reminders: () => assistantRepo.listReminders(scope),
      };
      const response = await generateAnswer({
        provider,
        model: currentConfig.AI_MODEL,
        fallbackModel: currentConfig.AI_FALLBACK_MODEL,
        tools: {
          declarations: toolDeclarations(toolPorts),
          run: (call) => runAssistantTool(call, toolPorts),
        },
        systemInstruction:
          context.systemInstruction +
          (isIt
            ? '\nIf this request needs a human action, permission, or review, start the response with exactly ESCALATE: followed by a safe summary. Never include credentials.'
            : '') +
          (input.command === 'decision' || input.command === 'review-plan'
            ? '\nReturn analysis as a DRAFT. State that it is not club policy and has not been saved. Do not claim persistence.'
            : ''),
        userText: [sanitizeMentionsForProvider(textOf(input.input)), context.evidenceEnvelope]
          .filter(Boolean)
          .join('\n\n'),
        maxOutputTokens: 800,
        temperature: 0.2,
      });
      sink.trace = {
        ...response.trace,
        sources: [
          ...redactedEvidence.map(({ resource }) => ({ title: resource.title, url: resource.url })),
          ...response.trace.sources,
        ],
      };
      assistantRepo.recordSkillActivity(scope, {
        id: randomUUID(),
        at: now(),
        behaviourId: input.behaviour.id,
        skillId: skill,
        actorId: input.userId,
        outcome: 'completed',
      });
      if (input.command === 'remember') {
        const id = `memory-${randomUUID()}`;
        assistantRepo.insertDecisionDraft(scope, {
          id,
          kind: 'memory',
          summary: response.text.slice(0, 4_000),
          requesterId: input.userId,
          provenance: `Assistant memory proposal; behaviour=${input.behaviour.id}; resources=${context.disclosurePlan.join(',') || 'none'}`,
          at: now(),
        });
        return {
          ok: true,
          content: `${response.text}

Memory proposal ID: ${id}. Nothing was added to memory. An owner must review and save it in the dashboard.`,
        };
      }
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
    }
  };
  return {
    behavioursForGuild: () => Promise.resolve(assistantRepo.listBehaviours(scope)),
    async invoke(input: AssistantInvocation) {
      const started = now();
      const sink: { trace?: GenerationTrace } = {};
      const result = await invokeOnce(input, sink);
      return { ...result, trace: { ...sink.trace, latencyMs: now() - started } };
    },
  };
};
