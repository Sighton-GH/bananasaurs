import { describe, expect, it } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import {
  ADMINISTRATOR,
  BAN_MEMBERS,
  DANGEROUS_PERMISSION_BITS,
  KICK_MEMBERS,
  MANAGE_CHANNELS,
  MANAGE_EVENTS,
  MANAGE_GUILD,
  MANAGE_GUILD_EXPRESSIONS,
  MANAGE_MESSAGES,
  MANAGE_ROLES,
  MANAGE_THREADS,
  MANAGE_WEBHOOKS,
  MENTION_EVERYONE,
  MODERATE_MEMBERS,
} from '@bananasaurs/core';

/**
 * The dangerous-permission floor lives in core as bigint literals, because
 * core must not depend on discord-api-types or discord.js. These tests pin
 * every literal to the real `PermissionFlagsBits` member, so a drift on
 * either side — a renumbered flag, a mistyped shift — fails loudly instead
 * of silently letting a dangerous role be pinged or granted (ADR 0117 §3).
 */
describe('dangerous-permission floor (ADR 0117 §3)', () => {
  it('holds exactly the 13 ADR 0117 names, no more and no fewer', () => {
    expect(Object.keys(DANGEROUS_PERMISSION_BITS).sort()).toEqual([
      'Administrator',
      'BanMembers',
      'KickMembers',
      'ManageChannels',
      'ManageEvents',
      'ManageGuild',
      'ManageGuildExpressions',
      'ManageMessages',
      'ManageRoles',
      'ManageThreads',
      'ManageWebhooks',
      'MentionEveryone',
      'ModerateMembers',
    ]);
  });

  it('matches PermissionFlagsBits member for member', () => {
    const names = Object.keys(
      DANGEROUS_PERMISSION_BITS,
    ) as (keyof typeof DANGEROUS_PERMISSION_BITS)[];
    for (const name of names) {
      expect(DANGEROUS_PERMISSION_BITS[name]).toBe(PermissionFlagsBits[name]);
    }
  });

  it('matches for each individually exported constant', () => {
    const named = {
      Administrator: ADMINISTRATOR,
      BanMembers: BAN_MEMBERS,
      KickMembers: KICK_MEMBERS,
      ManageChannels: MANAGE_CHANNELS,
      ManageEvents: MANAGE_EVENTS,
      ManageGuild: MANAGE_GUILD,
      ManageGuildExpressions: MANAGE_GUILD_EXPRESSIONS,
      ManageMessages: MANAGE_MESSAGES,
      ManageRoles: MANAGE_ROLES,
      ManageThreads: MANAGE_THREADS,
      ManageWebhooks: MANAGE_WEBHOOKS,
      MentionEveryone: MENTION_EVERYONE,
      ModerateMembers: MODERATE_MEMBERS,
    } as const;
    for (const [name, bit] of Object.entries(named)) {
      expect(bit).toBe(DANGEROUS_PERMISSION_BITS[name as keyof typeof named]);
    }
  });
});
