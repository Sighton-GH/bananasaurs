import { describe, expect, it } from 'vitest';
import { ERROR_COPY } from './errors.js';
import { moderationRefusalCode, panelRefusalCode, refFor } from './refusals.js';

const MOD_REASONS = [
  'unauthorized',
  'guild-unknown',
  'killswitch',
  'breaker-open',
  'rate-cap',
  'discord-owner',
  'role-above-bot',
] as const;
const PANEL_REFUSALS = [
  'panel-disabled',
  'missing-required-role',
  'blocked-role',
  'max-roles',
  'add-only',
  'remove-only',
] as const;

describe('refusal mappers (ADR 0141 decision 11)', () => {
  it.each(MOD_REASONS)('moderation refusal %s has a moderator-facing entry', (reason) => {
    const entry = ERROR_COPY[moderationRefusalCode(reason)];
    expect(entry.audience).not.toBe('member');
  });
  it.each(PANEL_REFUSALS)('panel refusal %s has a member-facing entry', (refusal) => {
    expect(ERROR_COPY[panelRefusalCode(refusal)].audience).toBe('member');
  });
  it('a ref is the last 8 characters of the interaction id', () => {
    expect(refFor('1234567890123456789')).toBe('23456789');
  });
});
