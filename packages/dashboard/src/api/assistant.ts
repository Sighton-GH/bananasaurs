import type {
  AssistantBehaviour,
  AssistantSkill,
  ClubResource,
  ReminderStatus,
} from '@bananasaurs/core';

/**
 * The dashboard's side of the assistant API contract. GET /api/assistant
 * aggregates everything the Release 3 pages need; the optional fields are
 * the Release 3 configuration surface and stay absent on server builds that
 * do not expose them yet, in which case the matching controls fail closed
 * (they say so and offer no editing) rather than pretending to work.
 */

export interface ReminderRow {
  readonly id: string;
  readonly text: string;
  readonly dueAt: number;
  readonly destinationId: string;
  readonly status: ReminderStatus;
}

export interface ActivityRow {
  readonly id: string;
  readonly at: number;
  readonly behaviourId: string;
  readonly skillId: string;
  readonly outcome: string;
  readonly detail?: string;
}

/** A role from the live guild directory. Pickers offer these; ids are never typed by hand. */
export interface GuildRoleInfo {
  readonly id: string;
  readonly name: string;
  readonly position: number;
}

/** A channel from the live guild directory, for ticket routing. */
export interface GuildChannelInfo {
  readonly id: string;
  readonly name: string;
}

/** A member from the live guild directory, for grants that name one person. */
export interface GuildMemberInfo {
  readonly id: string;
  /** Display name as operators know the member; the id stays the identity. */
  readonly name: string;
}

/** Who may use one skill, guild-wide. An absent or empty grant fails closed: nobody may use it. */
export interface SkillGrant {
  readonly skillId: string;
  readonly roleIds: readonly string[];
  readonly userIds: readonly string[];
}

export interface AssistantBehaviourView extends Omit<AssistantBehaviour, 'callerRoleIds'> {
  /**
   * Roles whose members may invoke this behaviour by tag or direct command.
   * `undefined` means the server build does not expose the allowlist yet;
   * an empty array fails closed (the tag answers nobody).
   */
  readonly callerRoleIds?: readonly string[];
  /**
   * Ticket escalation for behaviours that hand requests to humans (today:
   * @it-services). `undefined` means the server build does not expose ticket
   * routing yet; a present value with no channelId fails closed (no ticket
   * is created until a channel is chosen).
   */
  readonly ticket?: {
    readonly channelId?: string;
    readonly reviewerRoleIds?: readonly string[];
  };
}

/** A /decision or /review-plan record. Drafts are analysis, not club policy, until confirmed and saved. */
export interface DecisionRow {
  readonly id: string;
  readonly kind: 'decision' | 'review-plan';
  readonly summary: string;
  readonly status: 'draft' | 'reviewed' | 'saved';
  /** Who asked, and where the content came from, so a draft never reads as policy. */
  readonly requesterId: string;
  readonly provenance: string;
  readonly at: number;
}

/** One escalation ticket created in Discord for IT members to review. */
export interface TicketRow {
  readonly id: string;
  readonly behaviourId: string;
  readonly channelId: string;
  readonly requesterId: string;
  readonly summary: string;
  readonly status: 'open' | 'claimed' | 'resolved';
  readonly at: number;
}

export interface AssistantData {
  readonly behaviours: readonly AssistantBehaviourView[];
  readonly resources: readonly ClubResource[];
  readonly reminders: readonly ReminderRow[];
  readonly skills: readonly AssistantSkill[];
  readonly activity: readonly ActivityRow[];
  readonly roles?: readonly GuildRoleInfo[];
  readonly members?: readonly GuildMemberInfo[];
  readonly channels?: readonly GuildChannelInfo[];
  readonly skillGrants?: readonly SkillGrant[];
  readonly tickets?: readonly TicketRow[];
  readonly decisions?: readonly DecisionRow[];
}

export const ASSISTANT_URL = '/api/assistant';
export const behaviourUrl = (id: string) => `/api/assistant/behaviours/${encodeURIComponent(id)}`;
export const reminderCancelUrl = (id: string) =>
  `/api/assistant/reminders/${encodeURIComponent(id)}/cancel`;
export const decisionReviewUrl = (id: string) =>
  `/api/assistant/decisions/${encodeURIComponent(id)}/review`;
export const decisionSaveUrl = (id: string) =>
  `/api/assistant/decisions/${encodeURIComponent(id)}/save`;
export const resourceUrl = (id: string) => `/api/assistant/resources/${encodeURIComponent(id)}`;
export const skillGrantUrl = (skillId: string) =>
  `/api/assistant/skill-grants/${encodeURIComponent(skillId)}`;
