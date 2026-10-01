import { describe, expect, it, vi } from 'vitest';
import { ChannelType, type Client } from 'discord.js';
import { parseGuildId, type DiscordPort } from '@bananasaurs/core';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { guildRepo, taskRepo, taskBindingRepo, type GuildScope } from '@bananasaurs/storage';
import { decideTaskReview } from './task-approval.js';

const GUILD = parseGuildId('111111111111111111');
const CATEGORY = '999999999999999999';
const LEAD = '444444444444444444';
const MEMBER = '555555555555555555';
const PRESIDENT = '999999999999999991';
const LEAD_ROLE = '666666666666666666';
const PRESIDENT_ROLE = '888888888888888888';
const ACTOR = { actorType: 'dashboard', actorId: 'owner', via: 'http' } as const;
const memberActor = (actorId: string) =>
  ({ actorType: 'member', actorId, via: 'gateway' }) as const;

const setup = (options?: {
  readonly memberId?: string;
  readonly memberRoles?: readonly string[];
  readonly liveRoles?: readonly string[];
  readonly categoryLive?: boolean;
  readonly memberThrows?: boolean;
}) => {
  const db = openMigratedTestDatabase();
  const scope = db.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(scope, { name: 'Test', now: 1 });
  const fetch = vi.fn(async (_id: string, _options?: { force: boolean }) =>
    options?.categoryLive === false ? undefined : { type: ChannelType.GuildCategory },
  );
  const client = {
    guilds: {
      cache: new Map([[GUILD, { channels: { fetch } }]]),
    },
  } as unknown as Client;
  const discord = {
    fetchMember: vi.fn(async () => {
      if (options?.memberThrows === true) throw new Error('departed');
      return {
        userId: options?.memberId ?? LEAD,
        roleIds: [...(options?.memberRoles ?? [LEAD_ROLE])],
        isGuildOwner: false,
      };
    }),
    fetchRoles: vi.fn(async () => (options?.liveRoles ?? [LEAD_ROLE]).map((id) => ({ id }))),
  } as unknown as DiscordPort;
  return { db, scope, client, discord, fetch };
};

const pendingSubteam = (scope: GuildScope, requester: ReturnType<typeof memberActor>) => {
  const teamId = taskRepo.createTeam(
    scope,
    { name: 'Tech', categoryId: CATEGORY, kind: 'subteam', leadRoleId: LEAD_ROLE },
    ACTOR,
    1,
  );
  const id = taskRepo.createTask(
    scope,
    {
      teamId,
      title: 'Ready to review',
      assignmentKind: 'team',
      dueAt: 3000,
      timezone: 'America/Vancouver',
      destinationId: '333333333333333333',
      createdBy: 'owner',
    },
    ACTOR,
    2,
  );
  taskRepo.requestCompletion(scope, id, 1, requester, 3);
  return { teamId, id };
};

const pendingExec = (scope: GuildScope, requester: ReturnType<typeof memberActor>) => {
  const teamId = taskRepo.createTeam(
    scope,
    { name: 'Exec', categoryId: CATEGORY, kind: 'exec' },
    ACTOR,
    1,
  );
  const id = taskRepo.createTask(
    scope,
    {
      teamId,
      title: 'Ready to review',
      assignmentKind: 'team',
      dueAt: 3000,
      timezone: 'America/Vancouver',
      destinationId: '333333333333333333',
      createdBy: 'owner',
    },
    ACTOR,
    2,
  );
  taskRepo.requestCompletion(scope, id, 1, requester, 3);
  return { teamId, id };
};

describe('task review decisions', () => {
  it('a lead approves a subteam task', async () => {
    const h = setup();
    try {
      const { teamId, id } = pendingSubteam(h.scope, memberActor(MEMBER));
      taskBindingRepo.addMembership(h.scope, teamId, LEAD, 'lead', ACTOR, 4);
      expect(await decideTaskReview(h.scope, h.client, h.discord, LEAD, id, 2, 'approve', 5)).toBe(
        'done',
      );
      expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'done' });
      expect(h.fetch.mock.calls.length).toBeGreaterThan(0);
      for (const call of h.fetch.mock.calls) expect(call[1]).toEqual({ force: true });
    } finally {
      h.db.close();
    }
  });

  it('a lead approves their own completion', async () => {
    const h = setup();
    try {
      const { teamId, id } = pendingSubteam(h.scope, memberActor(LEAD));
      taskBindingRepo.addMembership(h.scope, teamId, LEAD, 'lead', ACTOR, 4);
      expect(await decideTaskReview(h.scope, h.client, h.discord, LEAD, id, 2, 'approve', 5)).toBe(
        'done',
      );
      expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'done' });
    } finally {
      h.db.close();
    }
  });

  it('the president approves a subteam task without a lead membership', async () => {
    const h = setup({
      memberId: PRESIDENT,
      memberRoles: [PRESIDENT_ROLE],
      liveRoles: [LEAD_ROLE, PRESIDENT_ROLE],
    });
    try {
      const { id } = pendingSubteam(h.scope, memberActor(MEMBER));
      taskBindingRepo.setPresidentRole(h.scope, PRESIDENT_ROLE, ACTOR, 4);
      expect(
        await decideTaskReview(h.scope, h.client, h.discord, PRESIDENT, id, 2, 'approve', 5),
      ).toBe('done');
      expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'done' });
    } finally {
      h.db.close();
    }
  });

  it('a plain member cannot approve', async () => {
    const h = setup({ memberId: MEMBER, memberRoles: [], liveRoles: [LEAD_ROLE] });
    try {
      const { teamId, id } = pendingSubteam(h.scope, memberActor(MEMBER));
      taskBindingRepo.addMembership(h.scope, teamId, MEMBER, 'member', ACTOR, 4);
      expect(
        await decideTaskReview(h.scope, h.client, h.discord, MEMBER, id, 2, 'approve', 5),
      ).toBe('not-authorised');
      expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'awaiting_approval' });
    } finally {
      h.db.close();
    }
  });

  it('the president approves an exec task', async () => {
    const h = setup({
      memberId: PRESIDENT,
      memberRoles: [PRESIDENT_ROLE],
      liveRoles: [PRESIDENT_ROLE],
    });
    try {
      const { id } = pendingExec(h.scope, memberActor(MEMBER));
      taskBindingRepo.setPresidentRole(h.scope, PRESIDENT_ROLE, ACTOR, 4);
      expect(
        await decideTaskReview(h.scope, h.client, h.discord, PRESIDENT, id, 2, 'approve', 5),
      ).toBe('done');
      expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'done' });
    } finally {
      h.db.close();
    }
  });

  it('a non-president lead cannot approve an exec task', async () => {
    const h = setup();
    try {
      const { teamId, id } = pendingExec(h.scope, memberActor(MEMBER));
      taskBindingRepo.addMembership(h.scope, teamId, LEAD, 'lead', ACTOR, 4);
      expect(await decideTaskReview(h.scope, h.client, h.discord, LEAD, id, 2, 'approve', 5)).toBe(
        'not-authorised',
      );
      expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'awaiting_approval' });
    } finally {
      h.db.close();
    }
  });

  it('a lead sends a task back to progress', async () => {
    const h = setup();
    try {
      const { teamId, id } = pendingSubteam(h.scope, memberActor(MEMBER));
      taskBindingRepo.addMembership(h.scope, teamId, LEAD, 'lead', ACTOR, 4);
      expect(await decideTaskReview(h.scope, h.client, h.discord, LEAD, id, 2, 'reject', 5)).toBe(
        'sent-back',
      );
      expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'in_progress' });
    } finally {
      h.db.close();
    }
  });

  it('a stale version conflicts', async () => {
    const h = setup();
    try {
      const { teamId, id } = pendingSubteam(h.scope, memberActor(MEMBER));
      taskBindingRepo.addMembership(h.scope, teamId, LEAD, 'lead', ACTOR, 4);
      expect(await decideTaskReview(h.scope, h.client, h.discord, LEAD, id, 1, 'approve', 5)).toBe(
        'conflict',
      );
      expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'awaiting_approval' });
    } finally {
      h.db.close();
    }
  });

  it('a task that is not awaiting approval conflicts', async () => {
    const h = setup();
    try {
      const teamId = taskRepo.createTeam(
        h.scope,
        { name: 'Tech', categoryId: CATEGORY, kind: 'subteam', leadRoleId: LEAD_ROLE },
        ACTOR,
        1,
      );
      const id = taskRepo.createTask(
        h.scope,
        {
          teamId,
          title: 'Not ready',
          assignmentKind: 'team',
          dueAt: 3000,
          timezone: 'America/Vancouver',
          destinationId: '333333333333333333',
          createdBy: 'owner',
        },
        ACTOR,
        2,
      );
      taskBindingRepo.addMembership(h.scope, teamId, LEAD, 'lead', ACTOR, 4);
      expect(await decideTaskReview(h.scope, h.client, h.discord, LEAD, id, 1, 'approve', 5)).toBe(
        'conflict',
      );
    } finally {
      h.db.close();
    }
  });

  it('a Discord failure denies review', async () => {
    const h = setup({ memberThrows: true });
    try {
      const { teamId, id } = pendingSubteam(h.scope, memberActor(MEMBER));
      taskBindingRepo.addMembership(h.scope, teamId, LEAD, 'lead', ACTOR, 4);
      expect(await decideTaskReview(h.scope, h.client, h.discord, LEAD, id, 2, 'approve', 5)).toBe(
        'not-authorised',
      );
      expect(taskRepo.getTask(h.scope, id)).toMatchObject({ status: 'awaiting_approval' });
    } finally {
      h.db.close();
    }
  });

  it('an archived task cannot be reviewed', async () => {
    const h = setup();
    try {
      const { teamId, id } = pendingSubteam(h.scope, memberActor(MEMBER));
      taskBindingRepo.addMembership(h.scope, teamId, LEAD, 'lead', ACTOR, 4);
      expect(taskRepo.archiveTask(h.scope, id, 2, ACTOR, 4)).toBe(true);
      expect(await decideTaskReview(h.scope, h.client, h.discord, LEAD, id, 3, 'approve', 5)).toBe(
        'not-authorised',
      );
    } finally {
      h.db.close();
    }
  });
});
