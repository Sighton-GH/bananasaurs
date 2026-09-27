import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CLUB_ASSISTANT_SKILLS,
  compileAssistantContext,
  isGithubWebHost,
  promptWizardAnswers,
  ProviderError,
  SAFETY_SUFFIX,
  SAFETY_SUFFIX_VERSION,
  skillInstructionLine,
  STARTER_SKILL_IDS,
  TOOL_CATALOGUE,
  validateResourceUrl,
  type ClubResource,
} from '@bananasaurs/core';
import { assistantRepo, eligibilityRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import { isInstanceOwner } from '../owner.js';
import { dashboardAuditBase } from './audit-base.js';
import { requireCapability } from './capability.js';
import { computeAssistantSetup } from './assistant-setup.js';

/**
 * A slash command shown on a skill's detail page, hand-kept in sync with
 * `RELEASE_3_COMMANDS` (`packages/discord/src/rest/commands.ts`) rather than
 * imported from `@bananasaurs/discord`: that package depends on `discord.js`,
 * and this HTTP package deliberately does not (`packages/http/package.json`
 * lists only `core`, `storage`, `fastify`, `zod` and `@node-rs/argon2`).
 * `assistant.test.ts` cross-checks every entry here against the live command
 * definitions so a renamed or removed command cannot go stale silently.
 */
const SKILL_COMMANDS: Readonly<
  Record<
    string,
    {
      readonly name: string;
      readonly options: readonly {
        readonly name: string;
        readonly required: boolean;
        readonly description: string;
      }[];
    }
  >
> = {
  'search-club': {
    name: 'find',
    options: [{ name: 'query', required: true, description: 'What to find' }],
  },
  'create-reminder': {
    name: 'remind',
    options: [
      {
        name: 'when',
        required: true,
        description: 'When to send it, including date or time zone',
      },
      { name: 'text', required: true, description: 'Reminder text' },
    ],
  },
  'propose-memory': {
    name: 'remember',
    options: [
      {
        name: 'request',
        required: true,
        description: 'What the assistant should consider remembering',
      },
    ],
  },
  'record-decision': {
    name: 'decision',
    options: [
      { name: 'topic', required: true, description: 'Decision topic' },
      { name: 'context', required: false, description: 'Optional context or constraints' },
    ],
  },
  'review-plan': {
    name: 'review-plan',
    options: [{ name: 'plan', required: true, description: 'Plan to review' }],
  },
  'onboarding-guide': {
    name: 'onboard',
    options: [{ name: 'request', required: true, description: 'What you need' }],
  },
  'draft-agenda': {
    name: 'agenda',
    options: [{ name: 'request', required: true, description: 'What you need' }],
  },
  'summarise-meeting': {
    name: 'summarise',
    options: [{ name: 'request', required: true, description: 'What you need' }],
  },
  'draft-announcement': {
    name: 'announce',
    options: [{ name: 'request', required: true, description: 'What you need' }],
  },
  'event-checklist': {
    name: 'checklist',
    options: [{ name: 'request', required: true, description: 'What you need' }],
  },
  'draft-handoff': {
    name: 'handoff',
    options: [{ name: 'request', required: true, description: 'What you need' }],
  },
};

/**
 * Instance owner, read from the account row rather than any capability: the
 * provider's cost statement and terms record are facts about the whole
 * daemon (ADR 0061), and no per-guild grant can confer them.
 */
/** Re-exported so existing `from './assistant.js'` imports keep working. */
export { isInstanceOwner };

const snowflake = z.string().regex(/^\d{17,20}$/);
const behaviour = z.object({
  id: z.string().min(1).max(64),
  surface: z.enum(['bananasaurs', 'it-services', 'help', 'direct-command']),
  mentionRoleId: snowflake.optional(),
  name: z.string().min(1).max(100),
  systemPrompt: z.string().min(1).max(4000),
  promptVersion: z.number().int().min(0),
  allowedSkillIds: z
    .array(z.enum(CLUB_ASSISTANT_SKILLS.map((skill) => skill.id) as [string, ...string[]]))
    .max(CLUB_ASSISTANT_SKILLS.length),
  callerRoleIds: z.array(snowflake).max(100),
  ticket: z
    .object({
      channelId: snowflake.optional(),
      reviewerRoleIds: z.array(snowflake).max(100).optional(),
    })
    .optional(),
  resourceIds: z.array(z.string()).max(100),
  enabled: z.boolean(),
  // Task 18: the wizard's structured answers. Omitted keeps the stored
  // answers; explicit null clears them; an object must validate.
  promptWizard: promptWizardAnswers.nullable().optional(),
});
const botTag = z.object({ behaviourId: z.string().min(1).max(64).nullable() }).strict();
const providerConfig = z.object({
  provider: z.enum(['off', 'gemini', 'openrouter', 'nvidia-nim']),
  model: z.string().min(1).max(200).optional(),
  apiKey: z.string().min(1).max(1000).optional(),
  enabled: z.boolean(),
  costClass: z.enum(['free', 'paid', 'unknown']).optional(),
  fallbackModels: z.array(z.string().trim().min(1).max(200)).max(2).optional(),
  searchApiKey: z.string().min(1).max(1000).optional(),
  searchEnabled: z.boolean().optional(),
});
const memory = z.object({
  id: z.string().min(1).max(64),
  section: z.string().min(1).max(100),
  content: z.string().min(1).max(1000),
  subjectId: snowflake.optional(),
});
const serverCard = z.object({ content: z.string().min(1).max(4000) });
const resource = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  url: z.string().url(),
  kind: z.enum(['website', 'document', 'discord-channel', 'repository', 'note']),
  enabled: z.boolean(),
  reviewedAt: z.string().datetime(),
});
export const registerAssistantRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.get('/api/assistant', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;
    const directories =
      deps.assistantDirectories === undefined
        ? undefined
        : await deps.assistantDirectories(session.guildId).catch(() => undefined);
    const behaviours = assistantRepo.listBehaviours(session.scope);
    const skillGrants = assistantRepo.listSkillGrants(session.scope);
    const aiStatus = deps.assistantProviderConfig?.status() ??
      deps.assistantAiStatus ?? {
        provider: 'unknown',
        enabled: false,
        modelConfigured: false,
        keyConfigured: false,
        keyReadable: false,
        costClass: 'unknown',
        secretSource: 'missing',
      };
    const providerTerms =
      eligibilityRepo.findEligibility(deps.scopes.instance(), aiStatus.provider) ?? null;
    const roleNames =
      directories?.roles === undefined
        ? undefined
        : new Map(directories.roles.map((role) => [role.id, role.name] as const));
    return reply.status(200).send({
      behaviours: behaviours.map((item) => ({
        ...item,
        ticket: {
          ...(item.ticketChannelId === undefined ? {} : { channelId: item.ticketChannelId }),
          reviewerRoleIds: item.reviewerRoleIds,
        },
      })),
      resources: assistantRepo.listResources(session.scope),
      reminders: assistantRepo.listReminders(session.scope),
      skills: CLUB_ASSISTANT_SKILLS,
      activity: assistantRepo.listSkillActivity(session.scope, 100),
      skillGrants,
      tickets: assistantRepo.listTickets(session.scope),
      decisions: assistantRepo.listDecisions(session.scope),
      serverCard: assistantRepo.getServerCard(session.scope),
      memories: assistantRepo.listMemories(session.scope),
      settings: assistantRepo.getAssistantSettings(session.scope),
      aiStatus,
      setup: computeAssistantSetup({
        status: aiStatus,
        terms: providerTerms ?? undefined,
        behaviours,
        skills: CLUB_ASSISTANT_SKILLS,
        now: deps.now(),
        reviewMaxAgeMs: eligibilityRepo.ELIGIBILITY_REVIEW_MAX_AGE_MS,
        ...(roleNames === undefined ? {} : { roleNames }),
      }),
      providerTerms,
      viewerIsOwner: isInstanceOwner(deps, session),
      ...(directories ?? {}),
    });
  });
  app.put('/api/assistant/provider', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    if (deps.assistantProviderConfig === undefined)
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    const parsed = providerConfig.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const before = deps.assistantProviderConfig.status();
    if (
      parsed.data.costClass !== undefined &&
      parsed.data.costClass !== before.costClass &&
      !isInstanceOwner(deps, session)
    )
      return reply.status(403).send({ error: 'owner-only', field: 'costClass' });
    // ADR 0066: web search sends queries to a new outside service, so turning
    // it on and replacing its key are the owner's call, like the cost class.
    if (!isInstanceOwner(deps, session)) {
      if (
        parsed.data.searchEnabled !== undefined &&
        parsed.data.searchEnabled !== (before.webSearch?.enabled ?? false)
      )
        return reply.status(403).send({ error: 'owner-only', field: 'searchEnabled' });
      if (parsed.data.searchApiKey !== undefined)
        return reply.status(403).send({ error: 'owner-only', field: 'searchApiKey' });
    }
    deps.assistantProviderConfig.save(parsed.data, deps.now());
    const after = deps.assistantProviderConfig.status();
    // The key itself never reaches the audit row: only whether it was replaced.
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_provider.saved',
      subjectType: 'assistant_provider',
      subjectId: 'active',
      before: {
        provider: before.provider,
        model: before.model ?? null,
        enabled: before.enabled,
        costClass: before.costClass,
        fallbackModels: before.fallbackModels ?? [],
        searchEnabled: before.webSearch?.enabled ?? false,
      },
      after: {
        provider: after.provider,
        model: after.model ?? null,
        enabled: after.enabled,
        costClass: after.costClass,
        keyReplaced: parsed.data.apiKey !== undefined,
        fallbackModels: after.fallbackModels ?? [],
        searchEnabled: after.webSearch?.enabled ?? false,
        searchKeyReplaced: parsed.data.searchApiKey !== undefined,
      },
    });
    return reply.status(200).send(after);
  });
  // ADR 0068: the models a key can use, for the ordered model pickers. The
  // pasted key is used once and dropped; it is never saved, logged or echoed.
  app.post('/api/assistant/provider/models', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const store = deps.assistantProviderConfig;
    if (store?.listModels === undefined)
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    const parsed = z
      .object({
        provider: z.enum(['gemini', 'openrouter', 'nvidia-nim']),
        apiKey: z.string().min(1).max(1000).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    try {
      const models = await store.listModels(parsed.data.provider, parsed.data.apiKey);
      return reply.status(200).send({ models });
    } catch (err) {
      if (err instanceof ProviderError)
        return reply.status(409).send({ error: 'provider-refused', kind: err.kind });
      const message = err instanceof Error ? err.message : '';
      if (message === 'no-key' || message === 'unsupported')
        return reply.status(409).send({ error: message });
      throw err;
    }
  });
  app.put('/api/assistant/server-card', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const parsed = serverCard.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    assistantRepo.putServerCard(session.scope, parsed.data.content, deps.now());
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_server_card.saved',
      subjectType: 'assistant_server_card',
      subjectId: session.guildId,
      before: undefined,
      after: { length: parsed.data.content.length },
    });
    return reply.status(200).send({ ok: true });
  });
  app.put('/api/assistant/memory-preferences/:userId', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const userId = (request.params as { userId: string }).userId;
    const parsed = z.object({ optedOut: z.boolean() }).safeParse(request.body);
    if (!snowflake.safeParse(userId).success || !parsed.success)
      return reply.status(400).send({ error: 'bad-request' });
    assistantRepo.setMemoryOptOut(session.scope, userId, parsed.data.optedOut, deps.now());
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_memory_preference.saved',
      subjectType: 'member',
      subjectId: userId,
      before: undefined,
      after: { optedOut: parsed.data.optedOut },
    });
    return reply.status(200).send({ ok: true });
  });
  app.delete('/api/assistant/member-memory/:userId', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const userId = (request.params as { userId: string }).userId;
    if (!snowflake.safeParse(userId).success)
      return reply.status(400).send({ error: 'bad-request' });
    const removed = assistantRepo.forgetMember(session.scope, userId, deps.now());
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_member_memory.forgotten',
      subjectType: 'member',
      subjectId: userId,
      before: undefined,
      after: { removed, optedOut: true },
    });
    return reply.status(200).send({ removed, optedOut: true });
  });
  app.put('/api/assistant/memories/:id', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const parsed = memory.safeParse(request.body);
    if (!parsed.success || parsed.data.id !== (request.params as { id: string }).id)
      return reply.status(400).send({ error: 'bad-request' });
    assistantRepo.putMemory(session.scope, parsed.data, deps.now());
    return reply.status(200).send({ ok: true });
  });
  app.delete('/api/assistant/memories/:id', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    assistantRepo.deleteMemory(session.scope, (request.params as { id: string }).id);
    return reply.status(200).send({ ok: true });
  });
  app.put('/api/assistant/behaviours/:id', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const parsed = behaviour.safeParse(request.body);
    if (!parsed.success || parsed.data.id !== (request.params as { id: string }).id)
      return reply.status(400).send({ error: 'bad-request' });
    const behaviours = assistantRepo.listBehaviours(session.scope);
    const existing = behaviours.find((item) => item.id === parsed.data.id);
    if (parsed.data.surface !== 'direct-command' && parsed.data.mentionRoleId === undefined)
      return reply.status(400).send({ error: 'mention-role-required' });
    if (parsed.data.enabled) {
      const conflict = behaviours.find(
        (item) =>
          item.id !== parsed.data.id &&
          item.enabled &&
          (parsed.data.surface === 'direct-command'
            ? item.surface === 'direct-command'
            : item.surface !== 'direct-command' &&
              item.mentionRoleId === parsed.data.mentionRoleId),
      );
      if (conflict !== undefined)
        return reply.status(409).send({ error: 'behaviour-conflict', behaviourId: conflict.id });
    }
    if (existing !== undefined && existing.promptVersion !== parsed.data.promptVersion)
      return reply
        .status(409)
        .send({ error: 'prompt-version-conflict', currentVersion: existing.promptVersion });
    // Omitted keeps the stored answers; explicit null clears them. The audit
    // row records only whether answers exist, never the answers text.
    const promptWizard =
      parsed.data.promptWizard === undefined
        ? existing?.promptWizard
        : (parsed.data.promptWizard ?? undefined);
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: existing === undefined ? 'assistant_behaviour.created' : 'assistant_behaviour.saved',
      subjectType: 'assistant_behaviour',
      subjectId: parsed.data.id,
      before:
        existing === undefined
          ? undefined
          : { promptVersion: existing.promptVersion, enabled: existing.enabled },
      after: {
        name: parsed.data.name,
        surface: parsed.data.surface,
        enabled: parsed.data.enabled,
        allowedSkillIds: parsed.data.allowedSkillIds,
        callerRoleIds: parsed.data.callerRoleIds,
        resourceIds: parsed.data.resourceIds,
        mentionRoleId: parsed.data.mentionRoleId ?? null,
        ticketChannelId: parsed.data.ticket?.channelId ?? null,
        reviewerRoleIds: parsed.data.ticket?.reviewerRoleIds ?? [],
        systemPrompt: parsed.data.systemPrompt,
        promptWizard: promptWizard !== undefined,
      },
    });
    assistantRepo.putBehaviour(
      session.scope,
      {
        id: parsed.data.id,
        guildId: session.guildId,
        surface: parsed.data.surface,
        // A behaviour PUT is a full replace: an absent optional id means the
        // operator cleared it, so it must reach the repo as absent rather
        // than be dropped here (dropping it kept the stale value stored).
        mentionRoleId: parsed.data.mentionRoleId,
        name: parsed.data.name,
        systemPrompt: parsed.data.systemPrompt,
        promptVersion: (existing?.promptVersion ?? 0) + 1,
        allowedSkillIds: parsed.data.allowedSkillIds,
        callerRoleIds: parsed.data.callerRoleIds,
        ticketChannelId: parsed.data.ticket?.channelId,
        reviewerRoleIds: parsed.data.ticket?.reviewerRoleIds ?? [],
        resourceIds: parsed.data.resourceIds,
        enabled: parsed.data.enabled,
        ...(promptWizard === undefined ? {} : { promptWizard }),
      },
      deps.now(),
    );
    return reply.status(200).send({ ok: true });
  });
  // Task 18: the locked safety suffix on its own, so the wizard can show it
  // read-only next to the editable prompt.
  app.get('/api/assistant/safety-suffix', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;
    return reply.status(200).send({ version: SAFETY_SUFFIX_VERSION, text: SAFETY_SUFFIX });
  });
  // Task 18: the full compiled prompt for one behaviour — every section the
  // model receives, with its size. Member memories are never included.
  app.get('/api/assistant/behaviours/:id/preview', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;
    const id = (request.params as { id: string }).id;
    const behaviour = assistantRepo.listBehaviours(session.scope).find((item) => item.id === id);
    if (behaviour === undefined) return reply.status(404).send({ error: 'not-found' });
    const compiled = compileAssistantContext({
      behaviour,
      serverCard: assistantRepo.getServerCard(session.scope),
      resources: assistantRepo.listResources(session.scope).filter((r) => r.enabled),
      evidence: [],
      skills: CLUB_ASSISTANT_SKILLS.filter((skill) => behaviour.allowedSkillIds.includes(skill.id)),
      toolsAvailable: true,
    });
    const sections = compiled.sections.map((section) => ({
      name: section.name,
      chars: section.text.length,
      estTokens: Math.ceil(section.text.length / 4),
      text: section.text,
    }));
    const totalChars = sections.reduce((sum, section) => sum + section.chars, 0);
    return reply
      .status(200)
      .send({ sections, totalChars, totalEstTokens: Math.ceil(totalChars / 4) });
  });
  // ADR 0065: the AI log channel for this guild; null turns logging off.
  app.put('/api/assistant/log-channel', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const parsed = z.object({ channelId: snowflake.nullable() }).strict().safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const previous = assistantRepo.getAssistantSettings(session.scope).logChannelId ?? null;
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_log_channel.set',
      subjectType: 'assistant_settings',
      subjectId: session.guildId,
      before: { channelId: previous },
      after: { channelId: parsed.data.channelId },
    });
    assistantRepo.setLogChannel(session.scope, parsed.data.channelId, deps.now());
    return reply.status(200).send({ ok: true, channelId: parsed.data.channelId });
  });
  // ADR 0063: the one behaviour that answers a tag of the bot user itself.
  app.put('/api/assistant/bot-tag', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const parsed = botTag.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { behaviourId } = parsed.data;
    const behaviours = assistantRepo.listBehaviours(session.scope);
    if (behaviourId !== null) {
      const target = behaviours.find((item) => item.id === behaviourId);
      if (target === undefined) return reply.status(404).send({ error: 'not-found' });
      if (!target.enabled) return reply.status(409).send({ error: 'behaviour-disabled' });
    }
    const previous = behaviours.find((item) => item.answersBotTag === true)?.id ?? null;
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_bot_tag.set',
      subjectType: 'assistant_behaviour',
      subjectId: behaviourId ?? previous ?? 'none',
      before: { behaviourId: previous },
      after: { behaviourId },
    });
    assistantRepo.setBotTagBehaviour(session.scope, behaviourId, deps.now());
    return reply.status(200).send({ ok: true, behaviourId });
  });
  app.post('/api/assistant/skill-grants/starter', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const parsed = z
      .object({ roleIds: z.array(snowflake).min(1).max(100) })
      .safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const before: Record<string, readonly string[]> = {};
    for (const grant of assistantRepo.listSkillGrants(session.scope)) {
      if (STARTER_SKILL_IDS.includes(grant.skillId)) {
        before[grant.skillId] = grant.roleIds;
      }
    }
    assistantRepo.addRolesToSkillGrants(
      session.scope,
      { skillIds: STARTER_SKILL_IDS, roleIds: parsed.data.roleIds },
      deps.now(),
    );
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_skill_grant.starter_applied',
      subjectType: 'assistant_skill_grant',
      subjectId: 'starter',
      before,
      after: { roleIds: parsed.data.roleIds, skillIds: STARTER_SKILL_IDS },
    });
    return reply.status(200).send({ skillIds: STARTER_SKILL_IDS });
  });
  app.put('/api/assistant/skill-grants/:id', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const id = (request.params as { id: string }).id;
    const parsed = z
      .object({ roleIds: z.array(snowflake).max(100), userIds: z.array(snowflake).max(100) })
      .safeParse(request.body);
    const skill = CLUB_ASSISTANT_SKILLS.find((item) => item.id === id);
    if (!parsed.success || skill === undefined || skill.ownerOnly === true)
      return reply.status(400).send({ error: 'bad-request' });
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_skill_grant.saved',
      subjectType: 'assistant_skill_grant',
      subjectId: id,
      before: (() => {
        const grant = assistantRepo
          .listSkillGrants(session.scope)
          .find((item) => item.skillId === id);
        return grant === undefined ? undefined : { roleIds: grant.roleIds, userIds: grant.userIds };
      })(),
      after: { roleIds: parsed.data.roleIds, userIds: parsed.data.userIds },
    });
    assistantRepo.putSkillGrant(session.scope, { skillId: id, ...parsed.data }, deps.now());
    return reply.status(200).send({ ok: true });
  });
  app.post('/api/assistant/reminders/:id/cancel', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const id = (request.params as { id: string }).id;
    const reminder = assistantRepo.listReminders(session.scope).find((item) => item.id === id);
    if (!assistantRepo.cancelReminder(session.scope, id))
      return reply.status(409).send({ error: 'invalid-transition' });
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_reminder.cancelled',
      subjectType: 'assistant_reminder',
      subjectId: id,
      before:
        reminder === undefined
          ? undefined
          : { text: reminder.text, dueAt: reminder.dueAt, status: reminder.status },
      after: { status: 'cancelled' },
    });
    return reply.status(200).send({ ok: true });
  });
  app.post('/api/assistant/decisions/:id/review', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const id = (request.params as { id: string }).id;
    if (!assistantRepo.transitionDecision(session.scope, id, 'draft', 'reviewed'))
      return reply.status(409).send({ error: 'invalid-transition' });
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_decision.reviewed',
      subjectType: 'assistant_decision',
      subjectId: id,
      before: { status: 'draft' },
      after: { status: 'reviewed' },
    });
    return reply.status(200).send({ ok: true });
  });
  app.post('/api/assistant/decisions/:id/save', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const id = (request.params as { id: string }).id;
    const proposal = assistantRepo.listDecisions(session.scope).find((item) => item.id === id);
    if (proposal?.kind === 'memory') {
      const parsed = z
        .object({
          section: z.string().min(1).max(100),
          content: z.string().min(1).max(1000),
          subjectId: snowflake.optional(),
        })
        .safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error, 'memory-details-required');
      if (!assistantRepo.saveMemoryProposal(session.scope, id, parsed.data, deps.now()))
        return reply.status(409).send({ error: 'invalid-transition' });
    } else if (!assistantRepo.transitionDecision(session.scope, id, 'reviewed', 'saved')) {
      return reply.status(409).send({ error: 'invalid-transition' });
    }
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_decision.saved',
      subjectType: 'assistant_decision',
      subjectId: id,
      before: { status: 'reviewed' },
      after: { status: 'saved' },
    });
    return reply.status(200).send({ ok: true });
  });
  app.put('/api/assistant/resources/:id', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const parsed = resource.safeParse(request.body);
    if (!parsed.success || parsed.data.id !== (request.params as { id: string }).id)
      return reply.status(400).send({ error: 'bad-request' });
    try {
      validateResourceUrl(parsed.data.url);
    } catch {
      return reply.status(400).send({ error: 'unsafe-resource-url' });
    }
    if (
      (parsed.data.kind === 'website' ||
        parsed.data.kind === 'document' ||
        parsed.data.kind === 'repository') &&
      isGithubWebHost(new URL(parsed.data.url).hostname)
    ) {
      return reply.status(400).send({ error: 'github-url-needs-import' });
    }
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_resource.saved',
      subjectType: 'assistant_resource',
      subjectId: parsed.data.id,
      before: (() => {
        const existing = assistantRepo
          .listResources(session.scope)
          .find((item) => item.id === parsed.data.id);
        return existing === undefined
          ? undefined
          : {
              title: existing.title,
              url: existing.url,
              kind: existing.kind,
              enabled: existing.enabled,
            };
      })(),
      after: {
        title: parsed.data.title,
        url: parsed.data.url,
        kind: parsed.data.kind,
        enabled: parsed.data.enabled,
      },
    });
    assistantRepo.putResource(session.scope, { ...parsed.data, guildId: session.guildId });
    // ADR 0073: the request path no longer fetches live, so a newly added
    // or edited resource is refreshed through the injected enqueue — absent
    // in isolated route tests, in which case nothing is enqueued.
    deps.enqueueResourceRefresh?.(session.scope, parsed.data.id, 'added');
    return reply.status(200).send({ ok: true });
  });
  // ADR 0084: enable/disable for every kind. The whole-object save above
  // cannot carry `github-repo` / `github-org` (its schema predates them),
  // so this route changes only the enabled flag. Disabling a GitHub
  // resource records `meta.disabledByOwner`; enabling clears it.
  app.put('/api/assistant/resources/:id/enabled', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const id = (request.params as { id: string }).id;
    const existing = assistantRepo.listResources(session.scope).find((item) => item.id === id);
    if (existing === undefined) return reply.status(404).send({ error: 'not-found' });
    const { enabled } = parsed.data;
    const isGithub = existing.kind === 'github-repo' || existing.kind === 'github-org';
    if (!isGithub) {
      assistantRepo.setResourceEnabled(session.scope, id, { enabled, meta: existing.meta });
    } else if (enabled === false) {
      // Spread keeps every other meta key; the cast only covers a GitHub
      // resource stored without meta yet (no `owner` to spread).
      const meta = { ...existing.meta, disabledByOwner: true as const } as ClubResource['meta'];
      assistantRepo.setResourceEnabled(session.scope, id, { enabled, meta });
    } else if (existing.meta === undefined) {
      assistantRepo.setResourceEnabled(session.scope, id, { enabled, meta: existing.meta });
    } else {
      const rest = { ...existing.meta };
      delete rest.disabledByOwner;
      assistantRepo.setResourceEnabled(session.scope, id, { enabled, meta: rest });
    }
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_resource.enabled_changed',
      subjectType: 'assistant_resource',
      subjectId: id,
      before: { enabled: existing.enabled },
      after: { enabled },
    });
    return reply.status(200).send({ ok: true });
  });
  // Task 9: one skill in full - the exact instruction the model receives,
  // its tools, who can use it, its slash command and its recent runs.
  app.get('/api/assistant/skills/:skillId', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;
    const skillId = (request.params as { skillId: string }).skillId;
    const skill = CLUB_ASSISTANT_SKILLS.find((item) => item.id === skillId);
    if (skill === undefined) return reply.status(404).send({ error: 'not-found' });
    const behaviours = assistantRepo.listBehaviours(session.scope);
    const directories =
      deps.assistantDirectories === undefined
        ? undefined
        : await deps.assistantDirectories(session.guildId).catch(() => undefined);
    const roleName = (id: string) => directories?.roles.find((r) => r.id === id)?.name;
    const allowedOn = behaviours.filter((b) => b.allowedSkillIds.includes(skill.id));
    const roleIds = [...new Set(allowedOn.flatMap((b) => b.callerRoleIds ?? []))];
    const roleLabels = roleIds.map((id) => `@${roleName(id) ?? 'a role that left the server'}`);
    const whoCanUse =
      skill.ownerOnly === true
        ? 'Only the server owner.'
        : roleLabels.length === 0
          ? 'Only the server owner, until a behaviour that allows it has Who can ask roles.'
          : `${roleLabels.join(', ')}, and the server owner`;
    const recentRuns = assistantRepo
      .listSkillActivity(session.scope, 500)
      .filter((row) => row.skillId === skill.id)
      .slice(0, 50);
    const command = SKILL_COMMANDS[skill.id];
    return reply.status(200).send({
      skill,
      instructionLine: skillInstructionLine(skill),
      behaviours: behaviours.map((b) => ({
        id: b.id,
        name: b.name,
        allowed: b.allowedSkillIds.includes(skill.id),
      })),
      whoCanUse,
      tools: TOOL_CATALOGUE.filter((tool) => tool.skills.includes(skill.id)),
      ...(command === undefined ? {} : { command }),
      recentRuns,
    });
  });
};
