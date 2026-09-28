export type AssistantSurface = 'bananasaurs' | 'it-services' | 'help' | 'direct-command';

import type { PromptWizardAnswers } from './prompt-wizard.js';

export interface AssistantBehaviour {
  readonly id: string;
  readonly guildId: string;
  readonly surface: AssistantSurface;
  readonly mentionRoleId?: string | undefined;
  /**
   * Answers when someone tags the bot user itself; at most one per guild,
   * enforced by the database (ADR 0063). Absent means false.
   */
  readonly answersBotTag?: boolean | undefined;
  /** Discord roles allowed to invoke this behaviour. Empty means nobody. */
  readonly callerRoleIds: readonly string[];
  /** IT escalation destination; required for ticket creation, otherwise fail closed. */
  readonly ticketChannelId?: string | undefined;
  readonly reviewerRoleIds: readonly string[];
  readonly name: string;
  readonly systemPrompt: string;
  /** Monotonic revision used for conflict-safe dashboard editing. */
  readonly promptVersion: number;
  readonly preferredSkillIds: readonly string[];
  readonly resourceIds: readonly string[];
  readonly enabled: boolean;
  /**
   * The dashboard wizard's structured answers that produced `systemPrompt`
   * (Task 18). Absent when the prompt was written by hand or the answers were
   * cleared; the wizard falls back to the surface defaults then.
   */
  readonly promptWizard?: PromptWizardAnswers | undefined;
}

export type AssistantSkillEffect = 'read' | 'draft' | 'schedule' | 'send';
export type SkillScopeMode = 'everyone' | 'roles' | 'owner';

export interface AssistantSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly effect: AssistantSkillEffect;
  readonly requiredPermission: string;
  readonly acts: boolean;
  readonly defaultScope: 'everyone' | 'owner';
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
