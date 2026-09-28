import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CLUB_ASSISTANT_SKILLS,
  compileAssistantContext,
  effectiveSkillScope,
  isGithubWebHost,
  parseGitHubUrl,
  promptWizardAnswers,
  ProviderError,
  reminderRecurrence,
  SAFETY_SUFFIX,
  SAFETY_SUFFIX_VERSION,
  skillInstructionLine,
  STARTER_SKILL_IDS,
  TOOL_CATALOGUE,
  validateReminderDraft,
  validateResourceUrl,
  type AssistantSkill,
  type ClubResource,
  type JsonValue,
  type ReminderRecurrence,
  type SkillScopeMode,
} from '@bananasaurs/core';
import { assistantRepo, eligibilityRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import { isInstanceOwner } from '../owner.js';
import { dashboardAuditBase } from './audit-base.js';
import { requireCapability } from './capability.js';
import { computeAssistantSetup } from './assistant-setup.js';

/**
 * Instance owner, read from the account row rather than any capability: the
 * provider's cost statement and terms record are facts about the whole
 * daemon (ADR 0061), and no per-guild grant can confer them.
 */
/** Re-exported so existing `from './assistant.js'` imports keep working. */
export { isInstanceOwner };

const snowflake = z.string().regex(/^\d{17,20}$/);

/**
 * Task E1: the dashboard view of one skill's scope (ADR 0086 decision 1).
 * `isDefault` is true when no stored mode exists; non-roles modes carry no
 * role ids.
 */
const skillScopeView = (
  skill: AssistantSkill,
  stored:
    { readonly mode?: SkillScopeMode | undefined; readonly roleIds: readonly string[] } | undefined,
): {
  readonly mode: SkillScopeMode;
  readonly roleIds: readonly string[];
  readonly isDefault: boolean;
} => {
  const effective = effectiveSkillScope(skill, stored);
  return {
    mode: effective.mode,
    roleIds: effective.mode === 'roles' ? [...effective.roleIds] : [],
    isDefault: stored?.mode === undefined,
  };
};
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
    const reminders = assistantRepo.listReminders(session.scope);
    const decisions = assistantRepo.listDecisions(session.scope);
    const grantsBySkillId = new Map(skillGrants.map((grant) => [grant.skillId, grant] as const));
    const skillScopes: Record<
      string,
      {
        readonly mode: SkillScopeMode;
        readonly roleIds: readonly string[];
        readonly isDefault: boolean;
      }
    > = Object.fromEntries(
      CLUB_ASSISTANT_SKILLS.map((skill) => {
        const grant = grantsBySkillId.get(skill.id);
        return [
          skill.id,
          skillScopeView(
            skill,
            grant === undefined ? undefined : { mode: grant.mode, roleIds: grant.roleIds },
          ),
        ];
      }),
    );
    const liveReminders = reminders.filter(
      (reminder) => reminder.status === 'scheduled' || reminder.status === 'delivering',
    ).length;
    const draftMemories = decisions.filter(
      (decision) => decision.kind === 'memory' && decision.status === 'draft',
    ).length;
    const draftDecisions = decisions.filter(
      (decision) => decision.kind !== 'memory' && decision.status === 'draft',
    ).length;
    const skillItemCounts: Record<string, number> = Object.fromEntries(
      CLUB_ASSISTANT_SKILLS.map((skill) => [
        skill.id,
        skill.id === 'reminders'
          ? liveReminders
          : skill.id === 'propose-memory'
            ? draftMemories
            : skill.id === 'record-decision'
              ? draftDecisions
              : 0,
      ]),
    );
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
      reminders,
      skills: CLUB_ASSISTANT_SKILLS,
      skillScopes,
      skillItemCounts,
      activity: assistantRepo.listSkillActivity(session.scope, 100),
      skillGrants,
      tickets: assistantRepo.listTickets(session.scope),
      decisions,
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
  // Task E1: one scope per skill, server-wide (ADR 0086 decision 1). The
  // stored row keeps its role/user ids; only the mode and role ids move.
  app.put('/api/assistant/skills/:skillId/scope', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const skillId = (request.params as { skillId: string }).skillId;
    const skill = CLUB_ASSISTANT_SKILLS.find((item) => item.id === skillId);
    if (skill === undefined) return reply.status(404).send({ error: 'not-found' });
    const parsed = z
      .object({
        mode: z.enum(['everyone', 'roles', 'owner']),
        roleIds: z.array(snowflake).max(100),
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (parsed.data.mode === 'roles' && parsed.data.roleIds.length === 0) return badRequest(reply);
    const roleIds = parsed.data.mode === 'roles' ? parsed.data.roleIds : [];
    const stored = assistantRepo
      .listSkillGrants(session.scope)
      .find((item) => item.skillId === skillId);
    const before = skillScopeView(
      skill,
      stored === undefined ? undefined : { mode: stored.mode, roleIds: stored.roleIds },
    );
    assistantRepo.setSkillScope(
      session.scope,
      { skillId, mode: parsed.data.mode, roleIds },
      deps.now(),
    );
    const after = { mode: parsed.data.mode, roleIds, isDefault: false };
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_skill_scope.saved',
      subjectType: 'assistant_skill',
      subjectId: skillId,
      before,
      after,
    });
    return reply.status(200).send({ ok: true, scope: after });
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
  // Task E1: edit a reminder's text, context, due time or repeat from the
  // skill page. The repeat keeps the time zone it was created with in chat;
  // a one-off reminder cannot gain one here (ADR 0086 decision 5).
  // Projects a stored repeat into plain audit JSON field by field, so the
  // audit trail never carries a live object reference.
  const recurrenceAuditValue = (r: ReminderRecurrence | undefined): JsonValue => {
    if (r === undefined) return null;
    return {
      pattern:
        r.pattern.kind === 'weekly'
          ? { kind: r.pattern.kind, days: [...r.pattern.days], everyWeeks: r.pattern.everyWeeks }
          : r.pattern.kind === 'monthly'
            ? { kind: r.pattern.kind, dayOfMonth: r.pattern.dayOfMonth }
            : { kind: r.pattern.kind },
      ...(r.endAt === undefined ? {} : { endAt: r.endAt }),
      ...(r.maxCount === undefined ? {} : { maxCount: r.maxCount }),
    };
  };
  app.patch('/api/assistant/reminders/:id', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const id = (request.params as { id: string }).id;
    const parsed = z
      .object({
        text: z.string().optional(),
        context: z.string().max(300).nullable().optional(),
        dueAt: z.number().int().optional(),
        recurrence: z
          .union([
            z.null(),
            z
              .object({
                pattern: reminderRecurrence.shape.pattern,
                endAt: z.number().int().positive().optional(),
                maxCount: z.number().int().min(1).max(1000).optional(),
              })
              .strict(),
          ])
          .optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const existing = assistantRepo.getReminder(session.scope, id);
    if (existing === undefined) return reply.status(404).send({ error: 'not-found' });
    const effectiveDueAt = parsed.data.dueAt ?? existing.dueAt;
    const dueAtChanged = parsed.data.dueAt !== undefined && parsed.data.dueAt !== existing.dueAt;
    // Validate `dueAt` in the future only when it changed: a retrying
    // past-due row must still accept a text fix. Text is always validated
    // through the shared draft so the stored value is the trimmed form.
    let draftText: string | undefined;
    if (parsed.data.text !== undefined || dueAtChanged) {
      const draft = validateReminderDraft(
        {
          dueAt: dueAtChanged ? effectiveDueAt : deps.now() + 1000,
          text: parsed.data.text ?? existing.text,
        },
        deps.now(),
      );
      if (!draft.ok)
        return reply.status(400).send({ error: 'invalid-reminder', message: draft.error });
      if (parsed.data.text !== undefined) draftText = draft.text;
    }
    const normalizedContext =
      parsed.data.context === undefined
        ? undefined
        : parsed.data.context === null
          ? null
          : (() => {
              const collapsed = parsed.data.context.trim().replace(/\s+/g, ' ');
              return collapsed === '' ? null : collapsed;
            })();
    // The dashboard never learns the club's time zone: a non-null repeat is
    // only an edit of an existing repeat, keeping its stored time zone.
    const recurrence =
      parsed.data.recurrence === undefined
        ? undefined
        : parsed.data.recurrence === null
          ? null
          : existing.recurrence === undefined
            ? undefined
            : {
                pattern: parsed.data.recurrence.pattern,
                timeZone: existing.recurrence.timeZone,
                ...(parsed.data.recurrence.endAt === undefined
                  ? {}
                  : { endAt: parsed.data.recurrence.endAt }),
                ...(parsed.data.recurrence.maxCount === undefined
                  ? {}
                  : { maxCount: parsed.data.recurrence.maxCount }),
              };
    if (
      parsed.data.recurrence !== undefined &&
      parsed.data.recurrence !== null &&
      recurrence === undefined
    )
      return reply.status(400).send({
        error: 'recurrence-needs-time-zone',
        message: `Repeating reminders are created from chat, where the club's time zone is known.`,
      });
    const effectiveRecurrence = recurrence === undefined ? existing.recurrence : recurrence;
    const effectiveEndAt =
      effectiveRecurrence === null || effectiveRecurrence === undefined
        ? undefined
        : effectiveRecurrence.endAt;
    if (effectiveEndAt !== undefined && effectiveEndAt < effectiveDueAt)
      return reply.status(400).send({
        error: 'invalid-reminder',
        message: `The repeat can't end before the reminder starts.`,
      });
    const before: Record<string, JsonValue> = {};
    const after: Record<string, JsonValue> = {};
    if (draftText !== undefined && draftText !== existing.text) {
      before['text'] = existing.text;
      after['text'] = draftText;
    }
    if (
      normalizedContext !== undefined &&
      (normalizedContext ?? null) !== (existing.context ?? null)
    ) {
      before['context'] = existing.context ?? null;
      after['context'] = normalizedContext;
    }
    if (parsed.data.dueAt !== undefined && parsed.data.dueAt !== existing.dueAt) {
      before['dueAt'] = existing.dueAt;
      after['dueAt'] = parsed.data.dueAt;
    }
    if (
      parsed.data.recurrence !== undefined &&
      JSON.stringify(recurrence ?? null) !== JSON.stringify(existing.recurrence ?? null)
    ) {
      before['recurrence'] = recurrenceAuditValue(existing.recurrence);
      after['recurrence'] = recurrenceAuditValue(recurrence ?? undefined);
    }
    const result = assistantRepo.updateReminder(
      session.scope,
      id,
      {
        ...(draftText === undefined ? {} : { text: draftText }),
        ...(normalizedContext === undefined
          ? {}
          : normalizedContext === null
            ? { context: null }
            : { context: normalizedContext }),
        ...(parsed.data.dueAt === undefined ? {} : { dueAt: parsed.data.dueAt }),
        ...(recurrence === undefined ? {} : { recurrence }),
      },
      deps.now(),
    );
    if (result === 'not-found') return reply.status(404).send({ error: 'not-found' });
    if (result === 'not-editable') return reply.status(409).send({ error: 'invalid-transition' });
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_reminder.edited',
      subjectType: 'assistant_reminder',
      subjectId: id,
      before,
      after,
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
      if (existing.meta === undefined) {
        // A GitHub resource stored without meta has no `owner` to spread;
        // rebuild the base meta from its URL so the strict schema reads it
        // back. An unparseable URL keeps no meta rather than owner-less meta.
        const target = parseGitHubUrl(existing.url);
        if (target === undefined) {
          assistantRepo.setResourceEnabled(session.scope, id, { enabled, meta: undefined });
        } else {
          assistantRepo.setResourceEnabled(session.scope, id, {
            enabled,
            meta: {
              owner: target.owner,
              ...(target.kind === 'repo' ? { repo: target.repo } : {}),
              disabledByOwner: true as const,
            },
          });
        }
      } else {
        // Spread keeps every other meta key.
        const meta = { ...existing.meta, disabledByOwner: true as const } as ClubResource['meta'];
        assistantRepo.setResourceEnabled(session.scope, id, { enabled, meta });
      }
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
  // its scope, who can use it, its tools, its live items and its recent runs.
  // Task E1: the slash command is gone (ADR 0086 decision 8) and who-can-use
  // reads the skill scope, not the behaviours' caller roles.
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
    const grant = assistantRepo
      .listSkillGrants(session.scope)
      .find((item) => item.skillId === skill.id);
    const scope = skillScopeView(
      skill,
      grant === undefined ? undefined : { mode: grant.mode, roleIds: grant.roleIds },
    );
    const whoCanUse =
      scope.mode === 'owner'
        ? 'Only the server owner.'
        : scope.mode === 'everyone'
          ? 'Everyone who can ask a behaviour that allows this skill, and the server owner.'
          : `${scope.roleIds.map((id) => `@${roleName(id) ?? 'a role that left the server'}`).join(', ')} (among those who can ask), and the server owner.`;
    const recentRuns = assistantRepo
      .listSkillActivity(session.scope, 500)
      .filter((row) => row.skillId === skill.id)
      .slice(0, 50);
    // Task E1: each skill's live items. Active reminders keep their
    // due-date order; the finished ones are the 50 most recently due first.
    const items =
      skill.id === 'reminders'
        ? {
            kind: 'reminders' as const,
            reminders: ((): readonly {
              readonly id: string;
              readonly creatorId: string;
              readonly creatorName?: string;
              readonly destinationId: string;
              readonly destinationName?: string;
              readonly text: string;
              readonly context?: string;
              readonly dueAt: number;
              readonly status: string;
              readonly recurrence?: unknown;
              readonly mentions: unknown;
              readonly deliveredCount: number;
              readonly failureReason?: string;
            }[] => {
              const all = assistantRepo.listReminders(session.scope);
              const live = all.filter(
                (reminder) => reminder.status === 'scheduled' || reminder.status === 'delivering',
              );
              const finished = all
                .filter(
                  (reminder) => reminder.status !== 'scheduled' && reminder.status !== 'delivering',
                )
                .sort((a, b) => b.dueAt - a.dueAt)
                .slice(0, 50);
              const memberName = (id: string) =>
                directories?.members.find((m) => m.id === id)?.name;
              const channelName = (id: string) =>
                directories?.channels.find((c) => c.id === id)?.name;
              return [...live, ...finished].map((reminder) => ({
                id: reminder.id,
                creatorId: reminder.creatorId,
                ...(memberName(reminder.creatorId) === undefined
                  ? {}
                  : { creatorName: memberName(reminder.creatorId) as string }),
                destinationId: reminder.destinationId,
                ...(channelName(reminder.destinationId) === undefined
                  ? {}
                  : { destinationName: channelName(reminder.destinationId) as string }),
                text: reminder.text,
                ...(reminder.context === undefined ? {} : { context: reminder.context }),
                dueAt: reminder.dueAt,
                status: reminder.status,
                ...(reminder.recurrence === undefined ? {} : { recurrence: reminder.recurrence }),
                mentions: reminder.mentions,
                deliveredCount: reminder.deliveredCount,
                ...(reminder.failureReason === undefined
                  ? {}
                  : { failureReason: reminder.failureReason }),
              }));
            })(),
          }
        : skill.id === 'propose-memory'
          ? {
              kind: 'memory-proposals' as const,
              proposals: assistantRepo
                .listDecisions(session.scope)
                .filter(
                  (decision) =>
                    decision.kind === 'memory' &&
                    (decision.status === 'draft' || decision.status === 'reviewed'),
                ),
            }
          : skill.id === 'record-decision'
            ? {
                kind: 'decisions' as const,
                decisions: assistantRepo
                  .listDecisions(session.scope)
                  .filter(
                    (decision) =>
                      decision.kind !== 'memory' &&
                      (decision.status === 'draft' || decision.status === 'reviewed'),
                  ),
              }
            : { kind: 'none' as const };
    return reply.status(200).send({
      skill,
      instructionLine: skillInstructionLine(skill),
      behaviours: behaviours.map((b) => ({
        id: b.id,
        name: b.name,
        allowed: b.allowedSkillIds.includes(skill.id),
      })),
      scope,
      whoCanUse,
      tools: TOOL_CATALOGUE.filter((tool) => tool.skills.includes(skill.id)),
      items,
      recentRuns,
    });
  });
};
