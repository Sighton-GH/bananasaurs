import { describe, expect, it, vi } from 'vitest';
import { ChannelType, type Client } from 'discord.js';
import type { DiscordPort } from '@bananasaurs/core';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { guildRepo, taskRepo, taskBindingRepo } from '@bananasaurs/storage';
import { taskMemberAccess } from './task-access.js';

const GUILD = parseGuildId('111111111111111111');
const USER = '444444444444444444';
const CATEGORY = '999999999999999999';
const CATEGORY_TWO = '999999999999999998';
const LEAD_ROLE = '666666666666666666';
const MEMBER_ROLE = '777777777777777777';
const PRESIDENT_ROLE = '888888888888888888';
const ACTOR = { actorType: 'dashboard', actorId: 'owner', via: 'http' } as const;

const setupScope = () => {
  const db = openMigratedTestDatabase();
  const scope = db.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(scope, { name: 'Test', now: 1 });
  return { db, scope };
};

const fakes = (options?: {
  readonly roleIds?: readonly string[];
  readonly liveRoles?: readonly string[];
  readonly userId?: string;
  readonly category?: unknown;
}) => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      options?.category === undefined
        ? { id: CATEGORY, type: ChannelType.GuildCategory }
        : options.category,
    );
  const client = {
    guilds: { cache: new Map([[GUILD, { channels: { fetch } }]]) },
  } as unknown as Client;
  const discord = {
    fetchMember: vi.fn().mockResolvedValue({
      userId: options?.userId ?? USER,
      roleIds: [...(options?.roleIds ?? [])],
      isGuildOwner: false,
    }),
    fetchRoles: vi.fn().mockResolvedValue((options?.liveRoles ?? []).map((id) => ({ id }))),
  } as unknown as DiscordPort;
  return { client, discord, fetch };
};

describe('Discord task member access', () => {
  it('requires a live member, category and explicit membership', async () => {
    const { db, scope } = setupScope();
    try {
      const teamId = taskRepo.createTeam(
        scope,
        { name: 'Tech', categoryId: CATEGORY, kind: 'subteam' },
        ACTOR,
        1,
      );
      taskBindingRepo.addMembership(scope, teamId, USER, 'member', ACTOR, 1);
      const { client, discord, fetch } = fakes();
      expect((await taskMemberAccess(scope, client, discord, USER)).teams).toHaveLength(1);
      expect(fetch).toHaveBeenCalledWith(CATEGORY, { force: true });
      fetch.mockResolvedValue(undefined); // Deleted category.
      expect((await taskMemberAccess(scope, client, discord, USER)).teams).toHaveLength(0);
      fetch.mockResolvedValue({ id: CATEGORY, type: ChannelType.GuildCategory });
      taskBindingRepo.removeMembership(scope, teamId, USER, ACTOR, 1);
      expect((await taskMemberAccess(scope, client, discord, USER)).teams).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('treats a stored membership as being on the team', async () => {
    const { db, scope } = setupScope();
    try {
      const teamId = taskRepo.createTeam(
        scope,
        { name: 'Tech', categoryId: CATEGORY, kind: 'subteam' },
        ACTOR,
        1,
      );
      taskBindingRepo.addMembership(scope, teamId, USER, 'member', ACTOR, 1);
      const { client, discord } = fakes();
      const access = await taskMemberAccess(scope, client, discord, USER);
      expect(access.onTeam(teamId)).toBe(true);
      expect(access.teams.map((team) => team.teamId)).toContain(teamId);
    } finally {
      db.close();
    }
  });

  it('treats holding the team role as being on the team', async () => {
    const { db, scope } = setupScope();
    try {
      const teamId = taskRepo.createTeam(
        scope,
        { name: 'Tech', categoryId: CATEGORY, kind: 'subteam', memberRoleId: MEMBER_ROLE },
        ACTOR,
        1,
      );
      // No stored membership: the live team role alone counts.
      const { client, discord } = fakes({ roleIds: [MEMBER_ROLE], liveRoles: [MEMBER_ROLE] });
      const access = await taskMemberAccess(scope, client, discord, USER);
      expect(access.onTeam(teamId)).toBe(true);
      expect(access.teams.map((team) => team.teamId)).toContain(teamId);
    } finally {
      db.close();
    }
  });

  it('ignores a team role that no longer exists', async () => {
    const { db, scope } = setupScope();
    try {
      const teamId = taskRepo.createTeam(
        scope,
        { name: 'Tech', categoryId: CATEGORY, kind: 'subteam', memberRoleId: MEMBER_ROLE },
        ACTOR,
        1,
      );
      // The member still holds the role id, but the role itself is deleted.
      const { client, discord } = fakes({ roleIds: [MEMBER_ROLE], liveRoles: [] });
      const access = await taskMemberAccess(scope, client, discord, USER);
      expect(access.onTeam(teamId)).toBe(false);
      expect(access.teams).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('treats the president as on every live team', async () => {
    const { db, scope } = setupScope();
    try {
      const first = taskRepo.createTeam(
        scope,
        { name: 'Tech', categoryId: CATEGORY, kind: 'subteam' },
        ACTOR,
        1,
      );
      const second = taskRepo.createTeam(
        scope,
        { name: 'Exec', categoryId: CATEGORY_TWO, kind: 'exec' },
        ACTOR,
        1,
      );
      taskBindingRepo.setPresidentRole(scope, PRESIDENT_ROLE, ACTOR, 1);
      const fetch = vi.fn().mockResolvedValue({ type: ChannelType.GuildCategory });
      const client = {
        guilds: { cache: new Map([[GUILD, { channels: { fetch } }]]) },
      } as unknown as Client;
      const discord = {
        fetchMember: vi.fn().mockResolvedValue({
          userId: USER,
          roleIds: [PRESIDENT_ROLE],
          isGuildOwner: false,
        }),
        fetchRoles: vi.fn().mockResolvedValue([{ id: PRESIDENT_ROLE }]),
      } as unknown as DiscordPort;
      const access = await taskMemberAccess(scope, client, discord, USER);
      expect(access.president).toBe(true);
      expect(access.onTeam(first)).toBe(true);
      expect(access.onTeam(second)).toBe(true);
      expect(access.teams).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('treats a stored lead holding the lead role as leadOf', async () => {
    const { db, scope } = setupScope();
    try {
      const teamId = taskRepo.createTeam(
        scope,
        { name: 'Tech', categoryId: CATEGORY, kind: 'subteam', leadRoleId: LEAD_ROLE },
        ACTOR,
        1,
      );
      taskBindingRepo.addMembership(scope, teamId, USER, 'lead', ACTOR, 1);
      const { client, discord } = fakes({ roleIds: [LEAD_ROLE], liveRoles: [LEAD_ROLE] });
      const access = await taskMemberAccess(scope, client, discord, USER);
      expect(access.leadOf(teamId)).toBe(true);
      expect(access.onTeam(teamId)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('keeps the team visible when its lead role is deleted, with lead powers lost', async () => {
    const { db, scope } = setupScope();
    try {
      const teamId = taskRepo.createTeam(
        scope,
        { name: 'Tech', categoryId: CATEGORY, kind: 'subteam', leadRoleId: LEAD_ROLE },
        ACTOR,
        1,
      );
      taskBindingRepo.addMembership(scope, teamId, USER, 'lead', ACTOR, 1);
      const { client, discord } = fakes({ roleIds: [LEAD_ROLE], liveRoles: [] });
      const access = await taskMemberAccess(scope, client, discord, USER);
      expect(access.leadOf(teamId)).toBe(false);
      expect(access.onTeam(teamId)).toBe(true);
      expect(access.teams.map((team) => team.teamId)).toContain(teamId);
    } finally {
      db.close();
    }
  });

  it('excludes a team whose category fetch is not a category', async () => {
    const { db, scope } = setupScope();
    try {
      const teamId = taskRepo.createTeam(
        scope,
        { name: 'Tech', categoryId: CATEGORY, kind: 'subteam' },
        ACTOR,
        1,
      );
      taskBindingRepo.addMembership(scope, teamId, USER, 'member', ACTOR, 1);
      const { client, discord } = fakes({
        category: { id: CATEGORY, type: ChannelType.GuildText },
      });
      const access = await taskMemberAccess(scope, client, discord, USER);
      expect(access.onTeam(teamId)).toBe(true);
      expect(access.teams).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('fetches every category with force', async () => {
    const { db, scope } = setupScope();
    try {
      const teamId = taskRepo.createTeam(
        scope,
        { name: 'Tech', categoryId: CATEGORY, kind: 'subteam' },
        ACTOR,
        1,
      );
      taskBindingRepo.addMembership(scope, teamId, USER, 'member', ACTOR, 1);
      const { client, discord, fetch } = fakes();
      await taskMemberAccess(scope, client, discord, USER);
      expect(fetch.mock.calls.length).toBeGreaterThan(0);
      for (const call of fetch.mock.calls) expect(call[1]).toEqual({ force: true });
    } finally {
      db.close();
    }
  });
});
