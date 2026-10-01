import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import {
  accountRepo,
  guildRepo,
  sessionRepo,
  taskRepo,
  taskBindingRepo,
  taskNudgeRepo,
} from '@bananasaurs/storage';
import { parseGuildId } from '@bananasaurs/core';
import { createServer, type HttpDeps } from '../server.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { hashPassword, hashToken } from '../secrets.js';
import { registerTaskRoutes } from './tasks.js';

const GUILD = parseGuildId('111111111111111111');
const NOW = 1_700_000_000_000;
const ACTOR = { actorType: 'dashboard', actorId: 'owner', via: 'http' } as const;
let db: MigratedTestDatabase;
let app: FastifyInstance;
let token: string;
let liveMember = false;
let categoryPresent = true;
let memberRoles: string[] = [];
let rolePresent = true;

beforeEach(async () => {
  db = openMigratedTestDatabase();
  liveMember = false;
  categoryPresent = true;
  memberRoles = [];
  rolePresent = true;
  const guild = db.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(guild, { name: 'test', now: NOW });
  const accountId = 'acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  accountRepo.createAccount(db.scopes.instance(), {
    accountId,
    username: 'viewer',
    passwordHash: await hashPassword('long-password-for-tests'),
    isOwner: false,
    now: NOW,
  });
  accountRepo.grantGuildAccess(guild, accountId);
  accountRepo.createAccount(db.scopes.instance(), {
    accountId: 'acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    username: 'owner',
    passwordHash: await hashPassword('long-password-for-tests'),
    isOwner: true,
    now: NOW,
  });
  accountRepo.grantGuildAccess(guild, 'acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  token = 'task-test-cookie-token';
  sessionRepo.createSession(guild, {
    sessionIdHash: hashToken(token),
    accountId,
    ip: null,
    createdAt: NOW,
    expiresAt: NOW + 100000,
    reauthAt: NOW,
  });
  const ownerToken = 'task-test-owner-cookie-token';
  sessionRepo.createSession(guild, {
    sessionIdHash: hashToken(ownerToken),
    accountId: 'acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ip: null,
    createdAt: NOW,
    expiresAt: NOW + 100000,
    reauthAt: NOW,
  });
  const deps: HttpDeps = {
    scopes: db.scopes,
    now: () => NOW,
    guildIds: [GUILD],
    logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never,
    readonly: false,
    portsFor: (scope) => ({
      ...testPortsFor(scope, () => NOW),
      listGuildChannels: () =>
        categoryPresent ? testPortsFor(scope, () => NOW).listGuildChannels() : [],
      listGuildRoles: () => (rolePresent ? testPortsFor(scope, () => NOW).listGuildRoles() : []),
      fetchGuildMembers: async (ids) =>
        liveMember && ids.includes('444444444444444444')
          ? [
              {
                memberId: '444444444444444444',
                username: 'member',
                displayName: 'Member',
                roleIds: memberRoles,
                joinedAt: NOW,
              },
            ]
          : [],
    }),
    instance: testInstanceFor(db.scopes.instance(), () => NOW),
  };
  app = createServer({ deps, registerRoutes: registerTaskRoutes });
});
afterEach(async () => {
  await app.close();
  db.close();
});

describe('task read isolation', () => {
  describe('task loop closure reads', () => {
    const ownerHeaders = { cookie: 'bs_session=task-test-owner-cookie-token' };
    const seedTeam = (name = 'Tech') =>
      taskRepo.createTeam(
        db.scopes.forGuild(GUILD),
        { name, categoryId: '999999999999999999', kind: 'subteam' },
        ACTOR,
        NOW,
      );
    const seedTask = (teamId: string, extra?: Record<string, unknown>) =>
      taskRepo.createTask(
        db.scopes.forGuild(GUILD),
        {
          teamId,
          title: 'Check chassis',
          assignmentKind: 'team',
          dueAt: NOW + 86_400_000,
          timezone: 'America/Vancouver',
          destinationId: '333333333333333333',
          createdBy: 'owner',
          ...extra,
        },
        ACTOR,
        NOW,
      );

    it('lists destinations inside the team category', async () => {
      const teamId = seedTeam();
      const response = await app.inject({
        method: 'GET',
        url: `/api/tasks/teams/${teamId}/destinations`,
        headers: ownerHeaders,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        destinations: [{ channelId: '333333333333333333', name: 'general', kind: 'channel' }],
      });
    });

    it('lists members with live display names and null when not live', async () => {
      const scope = db.scopes.forGuild(GUILD);
      const teamId = seedTeam();
      taskBindingRepo.addMembership(scope, teamId, '444444444444444444', 'member', ACTOR, NOW);
      taskBindingRepo.addMembership(scope, teamId, '555555555555555555', 'lead', ACTOR, NOW);
      liveMember = true;
      const response = await app.inject({
        method: 'GET',
        url: `/api/tasks/teams/${teamId}/members`,
        headers: ownerHeaders,
      });
      expect(response.statusCode).toBe(200);
      expect(
        response.json<{
          members: { discordUserId: string; kind: string; displayName: string | null }[];
        }>().members,
      ).toEqual(
        expect.arrayContaining([
          { discordUserId: '444444444444444444', kind: 'member', displayName: 'Member' },
          { discordUserId: '555555555555555555', kind: 'lead', displayName: null },
        ]),
      );
    });

    it('lists reminders for a task', async () => {
      const scope = db.scopes.forGuild(GUILD);
      const teamId = seedTeam();
      const taskId = seedTask(teamId, { extraReminderAt: [NOW + 3_600_000] });
      const response = await app.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}/reminders`,
        headers: ownerHeaders,
      });
      expect(response.statusCode).toBe(200);
      const reminders = response.json<{
        reminders: { slotId: string; kind: string; dueAt: number; state: string }[];
      }>().reminders;
      expect(reminders.map((r) => r.slotId)).toContain(`custom:${taskId}:${NOW + 3_600_000}`);
      for (const reminder of reminders)
        expect(Object.keys(reminder).sort()).toEqual(['dueAt', 'kind', 'slotId', 'state']);
      expect(taskNudgeRepo.reminderSlotsForTask(scope, taskId).length).toBe(reminders.length);
    });

    it('lists only pre_due and custom reminders, excluding evaluate and review slots', async () => {
      const scope = db.scopes.forGuild(GUILD);
      const teamId = seedTeam();
      const taskId = seedTask(teamId, { extraReminderAt: [NOW + 3_600_000] });
      taskNudgeRepo.schedule(
        scope,
        { slotId: `evaluate:${taskId}:1`, taskId, kind: 'evaluate', dueAt: NOW + 1_800_000 },
        NOW,
      );
      taskNudgeRepo.schedule(
        scope,
        {
          slotId: `review:${taskId}:2`,
          taskId,
          kind: 'review',
          dueAt: NOW,
          payload: JSON.stringify({ version: 2, requestedBy: 'owner' }),
        },
        NOW,
      );
      const response = await app.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}/reminders`,
        headers: ownerHeaders,
      });
      expect(response.statusCode).toBe(200);
      const reminders = response.json<{
        reminders: { slotId: string; kind: string; dueAt: number; state: string }[];
      }>().reminders;
      expect(reminders.map((r) => r.slotId)).toContain(`custom:${taskId}:${NOW + 3_600_000}`);
      expect(reminders.map((r) => r.slotId)).not.toContain(`evaluate:${taskId}:1`);
      expect(reminders.map((r) => r.slotId)).not.toContain(`review:${taskId}:2`);
      for (const reminder of reminders) expect(['pre_due', 'custom']).toContain(reminder.kind);
    });

    it('filters the task list by include and reports assignees and the president role', async () => {
      const scope = db.scopes.forGuild(GUILD);
      const teamId = seedTeam();
      const openId = seedTask(teamId);
      const doneId = seedTask(teamId, { title: 'Finished' });
      expect(taskRepo.requestCompletion(scope, doneId, 1, ACTOR, NOW)).toBe(true);
      expect(taskRepo.approveTask(scope, doneId, 2, ACTOR, NOW)).toBe(true);
      const archivedId = seedTask(teamId, { title: 'Old' });
      expect(taskRepo.archiveTask(scope, archivedId, 1, ACTOR, NOW)).toBe(true);
      taskBindingRepo.setPresidentRole(scope, '111111111111111119', ACTOR, NOW);
      const ids = async (url: string) =>
        (await app.inject({ method: 'GET', url, headers: ownerHeaders })).json<{
          tasks: { taskId: string; assigneeIds: string[] }[];
          presidentRoleId: string | null;
        }>();
      const open = await ids('/api/tasks');
      expect(open.tasks.map((t) => t.taskId)).toEqual([openId]);
      expect(open.presidentRoleId).toBe('111111111111111119');
      expect(open.tasks[0]).toHaveProperty('assigneeIds');
      const withDone = await ids('/api/tasks?include=done');
      // Approving archives in the same write, so the approved task leaves the
      // done-but-unarchived listing and only returns with include=archived.
      expect(withDone.tasks.map((t) => t.taskId)).toEqual([openId]);
      expect(withDone.tasks.map((t) => t.taskId)).not.toContain(archivedId);
      expect(withDone.tasks.map((t) => t.taskId)).not.toContain(doneId);
      const withArchived = await ids('/api/tasks?include=archived');
      expect(withArchived.tasks.map((t) => t.taskId)).toEqual(
        expect.arrayContaining([openId, archivedId]),
      );
      const withBoth = await ids('/api/tasks?include=done,archived');
      expect(withBoth.tasks.map((t) => t.taskId)).toEqual(
        expect.arrayContaining([openId, doneId, archivedId]),
      );
    });

    it('shows one task with reminders and its team', async () => {
      const teamId = seedTeam();
      const taskId = seedTask(teamId, { extraReminderAt: [NOW + 3_600_000] });
      const response = await app.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}`,
        headers: ownerHeaders,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        task: { taskId: string; assigneeIds: string[] };
        reminders: { slotId: string }[];
        team: { teamId: string };
      }>();
      expect(body.task.taskId).toBe(taskId);
      expect(body.task.assigneeIds).toEqual([]);
      expect(body.reminders.map((r) => r.slotId)).toContain(`custom:${taskId}:${NOW + 3_600_000}`);
      expect(body.team.teamId).toBe(teamId);
    });

    it('warns on setup when a team has no member role', async () => {
      seedTeam();
      const response = await app.inject({
        method: 'GET',
        url: '/api/tasks/setup',
        headers: ownerHeaders,
      });
      expect(response.statusCode).toBe(200);
      const teams = response.json<{ teams: { issues: string[] }[] }>().teams;
      expect(teams).toHaveLength(1);
      expect(teams[0]?.issues).toContain('No team role set; whole-team tasks will not ping anyone');
    });

    it('warns on setup when an exec team has no president role set', async () => {
      taskRepo.createTeam(
        db.scopes.forGuild(GUILD),
        { name: 'Exec', categoryId: '999999999999999999', kind: 'exec' },
        ACTOR,
        NOW,
      );
      const setup = async () =>
        (await app.inject({ method: 'GET', url: '/api/tasks/setup', headers: ownerHeaders })).json<{
          teams: { name: string; issues: string[] }[];
        }>();
      expect((await setup()).teams[0]?.issues).toContain(
        'Nobody can approve Exec tasks in Discord: set the president role.',
      );
      taskBindingRepo.setPresidentRole(db.scopes.forGuild(GUILD), '111111111111111119', ACTOR, NOW);
      expect((await setup()).teams[0]?.issues).not.toContain(
        'Nobody can approve Exec tasks in Discord: set the president role.',
      );
    });

    it('warns on setup when a subteam has no lead role and no president role is set', async () => {
      seedTeam('Tech');
      const setup = async () =>
        (await app.inject({ method: 'GET', url: '/api/tasks/setup', headers: ownerHeaders })).json<{
          teams: { name: string; issues: string[] }[];
        }>();
      expect((await setup()).teams[0]?.issues).toContain(
        'Nobody can approve Tech tasks in Discord: set a lead role or the president role.',
      );
      taskBindingRepo.setPresidentRole(db.scopes.forGuild(GUILD), '111111111111111119', ACTOR, NOW);
      expect((await setup()).teams[0]?.issues).not.toContain(
        'Nobody can approve Tech tasks in Discord: set a lead role or the president role.',
      );
    });
  });
  it('refuses non-owner sessions before reading task data', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: { cookie: `bs_session=${token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'owner-only' });
  });
  it('does not expose task data to a non-owner with a stored membership', async () => {
    const guild = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(
      guild,
      { name: 'Tech', categoryId: '999999999999999999', kind: 'subteam' },
      ACTOR,
      NOW,
    );
    const taskId = taskRepo.createTask(
      guild,
      {
        teamId,
        title: 'Private task',
        assignmentKind: 'team',
        dueAt: NOW + 10000,
        timezone: 'America/Vancouver',
        destinationId: '333333333333333333',
        createdBy: 'owner',
      },
      ACTOR,
      NOW,
    );
    taskBindingRepo.addMembership(guild, teamId, '444444444444444444', 'member', ACTOR, NOW);
    taskBindingRepo.setPresidentRole(guild, '111111111111111119', ACTOR, NOW);
    liveMember = true;
    memberRoles = ['111111111111111119'];
    const headers = { cookie: `bs_session=${token}` };
    for (const url of [
      '/api/tasks',
      `/api/tasks/${taskId}`,
      '/api/tasks/setup',
      `/api/tasks/teams/${teamId}/assignees`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers });
      expect([403, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain('Private task');
    }
  });
  it('does not expose setup status to a non-owner', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks/setup',
      headers: { cookie: `bs_session=${token}` },
    });
    expect(response.statusCode).toBe(403);
  });
  it('does not expose a task without a session', async () => {
    const teamId = taskRepo.createTeam(
      db.scopes.forGuild(GUILD),
      { name: 'Tech', categoryId: '999999999999999999', kind: 'subteam' },
      ACTOR,
      NOW,
    );
    const taskId = taskRepo.createTask(
      db.scopes.forGuild(GUILD),
      {
        teamId,
        title: 'Private task',
        assignmentKind: 'team',
        dueAt: NOW + 10000,
        timezone: 'America/Vancouver',
        destinationId: '444444444444444444',
        createdBy: 'owner',
      },
      ACTOR,
      NOW,
    );
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('Private task');
  });
});
