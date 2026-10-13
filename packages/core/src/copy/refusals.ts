import type { ModerationRefusalReason } from '../effects/moderation-gateway.js';
import type { PanelRefusal } from '../panels/convergence.js';
import type { ErrorCode } from './errors.js';

/** ADR 0141 decision 11: every refusal union maps to one catalogue entry; `tsc` enforces completeness. */
const MODERATION: Readonly<Record<ModerationRefusalReason, ErrorCode>> = {
  unauthorized: 'mod.not-allowed',
  'guild-unknown': 'mod.guild-unknown',
  killswitch: 'mod.killswitch',
  'breaker-open': 'mod.breaker-open',
  'rate-cap': 'mod.rate-cap',
  'discord-owner': 'mod.discord-owner',
  'role-above-bot': 'mod.role-above-bot',
};

const PANEL: Readonly<Record<PanelRefusal, ErrorCode>> = {
  'panel-disabled': 'panel.panel-disabled',
  'missing-required-role': 'panel.missing-required-role',
  'blocked-role': 'panel.blocked-role',
  'max-roles': 'panel.max-roles',
  'add-only': 'panel.add-only',
  'remove-only': 'panel.remove-only',
};

export const moderationRefusalCode = (reason: ModerationRefusalReason): ErrorCode =>
  MODERATION[reason];

export const panelRefusalCode = (refusal: PanelRefusal): ErrorCode => PANEL[refusal];

/** The short reference a moderator or owner can quote; log lines carry the full interaction id. */
export const refFor = (interactionId: string): string => interactionId.slice(-8);
