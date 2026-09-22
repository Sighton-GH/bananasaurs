import type { AssistantPrincipal, AssistantSkill, SkillDecision } from './types.js';

export const CLUB_ASSISTANT_SKILLS: readonly AssistantSkill[] = [
  {
    id: 'search-club',
    name: 'Search club knowledge',
    description:
      'Search enabled Discord archive and reviewed resources with permission-filtered citations.',
    effect: 'read',
    requiredPermission: 'assistant.search',
    requiresConfirmation: false,
  },
  {
    id: 'open-resource',
    name: 'Link a club resource',
    description: 'Return a reviewed website, document or channel link.',
    effect: 'read',
    requiredPermission: 'assistant.resources',
    requiresConfirmation: false,
  },
  {
    id: 'create-reminder',
    name: 'Set a reminder',
    description: 'Schedule a reminder for the requester or an allowed channel.',
    effect: 'schedule',
    requiredPermission: 'assistant.reminders.create',
    requiresConfirmation: true,
  },
  {
    id: 'send-reminder',
    name: 'Deliver a reminder',
    description: 'Send a due reminder through the configured Discord destination.',
    effect: 'send',
    requiredPermission: 'assistant.reminders.deliver',
    ownerOnly: true,
    requiresConfirmation: false,
  },
  {
    id: 'record-decision',
    name: 'Record a decision',
    description: 'Draft a sourced club decision record for human review.',
    effect: 'draft',
    requiredPermission: 'assistant.decisions',
    requiresConfirmation: true,
  },
  {
    id: 'review-plan',
    name: 'Review a plan',
    description: 'Review a plan against club resources without changing server state.',
    effect: 'read',
    requiredPermission: 'assistant.review',
    requiresConfirmation: false,
  },
  {
    id: 'onboarding-guide',
    name: 'Guide onboarding',
    description: 'Answer new-member questions and produce a sourced next-step checklist.',
    effect: 'read',
    requiredPermission: 'assistant.onboarding',
    requiresConfirmation: false,
  },
  {
    id: 'draft-agenda',
    name: 'Draft a meeting agenda',
    description: 'Draft an agenda from reviewed club context without publishing it.',
    effect: 'draft',
    requiredPermission: 'assistant.organise',
    requiresConfirmation: false,
  },
  {
    id: 'summarise-meeting',
    name: 'Summarise a meeting',
    description: 'Turn supplied notes into a sourced summary and action-item draft.',
    effect: 'draft',
    requiredPermission: 'assistant.organise',
    requiresConfirmation: false,
  },
  {
    id: 'draft-announcement',
    name: 'Draft an announcement',
    description: 'Prepare a Canadian-English club announcement without sending it.',
    effect: 'draft',
    requiredPermission: 'assistant.communications',
    requiresConfirmation: false,
  },
  {
    id: 'event-checklist',
    name: 'Build an event checklist',
    description: 'Draft owners, dependencies and deadlines for a club event or work session.',
    effect: 'draft',
    requiredPermission: 'assistant.organise',
    requiresConfirmation: false,
  },
  {
    id: 'draft-handoff',
    name: 'Draft a team handoff',
    description: 'Prepare a concise handoff with state, blockers, decisions and next actions.',
    effect: 'draft',
    requiredPermission: 'assistant.organise',
    requiresConfirmation: false,
  },
] as const;

export const decideSkillUse = (
  skill: AssistantSkill,
  principal: AssistantPrincipal,
): SkillDecision => {
  if (skill.ownerOnly === true && !principal.owner)
    return { allowed: false, reason: 'owner-only skill', requiresConfirmation: false };
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
