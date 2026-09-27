import type {
  AssistantPrincipal,
  AssistantSkill,
  SkillDecision,
  SkillScopeMode,
} from './types.js';

export const CLUB_ASSISTANT_SKILLS: readonly AssistantSkill[] = [
  {
    id: 'search-club',
    name: 'Search club knowledge',
    description:
      'Search enabled Discord archive and reviewed resources with permission-filtered citations.',
    effect: 'read',
    requiredPermission: 'assistant.search',
    acts: false,
    defaultScope: 'everyone',
    requiresConfirmation: false,
  },
  {
    id: 'open-resource',
    name: 'Link a club resource',
    description: 'Return a reviewed website, document or channel link.',
    effect: 'read',
    requiredPermission: 'assistant.resources',
    acts: false,
    defaultScope: 'everyone',
    requiresConfirmation: false,
  },
  {
    id: 'reminders',
    name: 'Reminders',
    description:
      'Set, list, change and cancel reminders, one-off or repeating; delivers them automatically.',
    effect: 'schedule',
    requiredPermission: 'assistant.reminders',
    acts: true,
    defaultScope: 'owner',
    requiresConfirmation: false,
  },
  {
    id: 'propose-memory',
    name: 'Propose a memory',
    description:
      'Draft a sectioned memory entry for operator review; never writes memory directly.',
    effect: 'draft',
    requiredPermission: 'assistant.memory',
    acts: true,
    defaultScope: 'owner',
    requiresConfirmation: false,
  },
  {
    id: 'record-decision',
    name: 'Record a decision',
    description: 'Draft a sourced club decision record for human review.',
    effect: 'draft',
    requiredPermission: 'assistant.decisions',
    acts: true,
    defaultScope: 'owner',
    requiresConfirmation: false,
  },
  {
    id: 'review-plan',
    name: 'Review a plan',
    description: 'Review a plan against club resources without changing server state.',
    effect: 'read',
    requiredPermission: 'assistant.review',
    acts: false,
    defaultScope: 'everyone',
    requiresConfirmation: false,
  },
  {
    id: 'onboarding-guide',
    name: 'Guide onboarding',
    description: 'Answer new-member questions and produce a sourced next-step checklist.',
    effect: 'read',
    requiredPermission: 'assistant.onboarding',
    acts: false,
    defaultScope: 'everyone',
    requiresConfirmation: false,
  },
  {
    id: 'draft-agenda',
    name: 'Draft a meeting agenda',
    description: 'Draft an agenda from reviewed club context without publishing it.',
    effect: 'draft',
    requiredPermission: 'assistant.organise',
    acts: false,
    defaultScope: 'everyone',
    requiresConfirmation: false,
  },
  {
    id: 'summarise-meeting',
    name: 'Summarise a meeting',
    description: 'Turn supplied notes into a sourced summary and action-item draft.',
    effect: 'draft',
    requiredPermission: 'assistant.organise',
    acts: false,
    defaultScope: 'everyone',
    requiresConfirmation: false,
  },
  {
    id: 'draft-announcement',
    name: 'Draft an announcement',
    description: 'Prepare a Canadian-English club announcement without sending it.',
    effect: 'draft',
    requiredPermission: 'assistant.communications',
    acts: false,
    defaultScope: 'everyone',
    requiresConfirmation: false,
  },
  {
    id: 'event-checklist',
    name: 'Build an event checklist',
    description: 'Draft owners, dependencies and deadlines for a club event or work session.',
    effect: 'draft',
    requiredPermission: 'assistant.organise',
    acts: false,
    defaultScope: 'everyone',
    requiresConfirmation: false,
  },
  {
    id: 'draft-handoff',
    name: 'Draft a team handoff',
    description: 'Prepare a concise handoff with state, blockers, decisions and next actions.',
    effect: 'draft',
    requiredPermission: 'assistant.organise',
    acts: false,
    defaultScope: 'everyone',
    requiresConfirmation: false,
  },
] as const;

/** Everyday skills a first-run owner may grant in one step. */
export const STARTER_SKILL_IDS: readonly string[] = CLUB_ASSISTANT_SKILLS.filter(
  (skill) => skill.defaultScope === 'everyone',
).map((skill) => skill.id);

export type SkillScope =
  | { readonly mode: 'everyone' }
  | { readonly mode: 'roles'; readonly roleIds: readonly string[] }
  | { readonly mode: 'owner' };

export const effectiveSkillScope = (
  skill: AssistantSkill,
  stored: { readonly mode?: SkillScopeMode | undefined; readonly roleIds: readonly string[] } | undefined,
): SkillScope => {
  if (stored?.mode === 'roles') return { mode: 'roles', roleIds: stored.roleIds };
  if (stored?.mode === 'owner') return { mode: 'owner' };
  if (stored?.mode === 'everyone') return { mode: 'everyone' };
  return { mode: skill.defaultScope };
};

export const skillScopeAllows = (
  scope: SkillScope,
  caller: { readonly owner: boolean; readonly roleIds: readonly string[] },
): boolean => {
  if (caller.owner || scope.mode === 'everyone') return true;
  if (scope.mode === 'owner') return false;
  return scope.roleIds.some((roleId) => caller.roleIds.includes(roleId));
};

export const decideSkillUse = (
  skill: AssistantSkill,
  principal: AssistantPrincipal,
): SkillDecision => {
  if (!principal.permissionKeys.has(skill.requiredPermission)) {
    return {
      allowed: false,
      reason: `missing ${skill.requiredPermission}`,
      requiresConfirmation: false,
    };
  }
  return { allowed: true, requiresConfirmation: skill.requiresConfirmation };
};

export const allowedSkills = (
  configuredIds: readonly string[],
  principal: AssistantPrincipal,
  catalogue: readonly AssistantSkill[] = CLUB_ASSISTANT_SKILLS,
): readonly AssistantSkill[] =>
  catalogue.filter(
    (skill) => configuredIds.includes(skill.id) && decideSkillUse(skill, principal).allowed,
  );
