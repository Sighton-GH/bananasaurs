export type AssistantSurface = 'bananasaurs' | 'it-services' | 'help' | 'direct-command';

export interface AssistantBehaviour {
  readonly id: string;
  readonly guildId: string;
  readonly surface: AssistantSurface;
  readonly mentionRoleId?: string;
  /** Discord roles allowed to invoke this behaviour. Empty means nobody. */
  readonly callerRoleIds: readonly string[];
  /** IT escalation destination; required for ticket creation, otherwise fail closed. */
  readonly ticketChannelId?: string;
  readonly reviewerRoleIds: readonly string[];
  readonly name: string;
  readonly systemPrompt: string;
  /** Monotonic revision used for conflict-safe dashboard editing. */
  readonly promptVersion: number;
  readonly allowedSkillIds: readonly string[];
  readonly resourceIds: readonly string[];
  readonly enabled: boolean;
}

export type AssistantSkillEffect = 'read' | 'draft' | 'schedule' | 'send';

export interface AssistantSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly effect: AssistantSkillEffect;
  readonly requiredPermission: string;
  readonly ownerOnly?: boolean;
  readonly requiresConfirmation: boolean;
}

export interface AssistantPrincipal {
  readonly guildId: string;
  readonly userId: string;
  readonly permissionKeys: ReadonlySet<string>;
  readonly owner: boolean;
}

export interface SkillDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly requiresConfirmation: boolean;
}
