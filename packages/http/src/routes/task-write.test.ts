import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import {
  accountRepo,
  effectRepo,
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
import { registerTaskWriteRoutes } from './task-write.js';
const GUILD = parseGuildId('111111111111111111');
const NOW = 1700000000000;
let db: MigratedTestDatabase;
let app: FastifyInstance;
let destinationCategory = '999999999999999999';
const OWNER = 'acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MEMBER = '444444444444444444';
const TOKEN = 'owner-task-revocation-session';
const ACTOR = { actorType: 'dashboard', actorId: 'owner', via: 'http' } as const;
beforeEach(async () => {
  db = openMigratedTestDatabase();
  destinationCategory = '999999999999999999';
  const guild = db.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(guild, { name: 'test', now: NOW });
  accountRepo.createAccount(db.scopes.instance(), {
    accountId: 'acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    username: 'viewer',
    passwordHash: await hashPassword('long-password-for-tests'),
    isOwner: false,
    now: NOW,
  });
  accountRepo.grantGuildAccess(guild, 'acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  accountRepo.createAccount(db.scopes.instance(), {
    accountId: OWNER,
    username: 'owner',
    passwordHash: await hashPassword('long-password-for-tests'),
    isOwner: true,
    now: NOW,
  });
  accountRepo.grantGuildAccess(guild, OWNER);
  sessionRepo.createSession(guild, {
    sessionIdHash: hashToken(TOKEN),
    accountId: OWNER,
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
      inspectTaskChannel: async (id) =>
        id === '333333333333333333' || id === '777777777777777779'
          ? {
              channelId: id,
              kind: 'channel' as const,
              parentId: destinationCategory,
              categoryId: destinationCategory,
            }
          : undefined,
    }),
    instance: testInstanceFor(db.scopes.instance(), () => NOW),
  };
  app = createServer({
    deps,
    registerRoutes: (instance, guard, routeDeps) => {
      registerTaskWriteRoutes(instance, guard, routeDeps);
      registerTaskRoutes(instance, guard, routeDeps);
    },
  });
});
afterEach(async () => {
  await app.close();
  db.close();
});
describe('task setup write gate', () => {
  it('does not create a team without authentication', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/teams',
      payload: { name: 'Tech', categoryId: '333333333333333333', kind: 'subteam' },
    });
    expect(response.statusCode).toBe(401);
  });
  it('does not create a child without authentication', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/random/children',
      payload: { title: 'Measurements', dueAt: NOW + 10000 },
    });
    expect(response.statusCode).toBe(401);
  });
  it('requires owner CSRF and parent version to edit or remove a dated child', async () => {
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(
      scope,
      { name: 'Tech', categoryId: '999999999999999999', kind: 'subteam' },
      ACTOR,
      NOW,
    );
    const taskId = taskRepo.createTask(
      scope,
      {
        teamId,
        title: 'Project',
        assignmentKind: 'team',
        dueAt: NOW + 86400000,
        timezone: 'America/Vancouver',
        destinationId: '333333333333333333',
        createdBy: OWNER,
      },
      ACTOR,
      NOW,
    );
    const url = `/api/tasks/${taskId}/children`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { version: 1, title: 'Step', dueAt: NOW + 10000 },
        })
      ).statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: {
        username: 'owner',
        password: 'long-password-for-tests',
      },
    });
    const headers = {
      cookie: String(login.headers['set-cookie']).split(';')[0],
      'x-bananasaurs-csrf': login.json<{ csrfToken: string }>().csrfToken,
    };
    const add = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: {
        version: 1,
        title: 'Step',
        dueAt: NOW + 10000,
      },
    });
    expect(add.statusCode).toBe(201);
    const { childId } = add.json<{ childId: string }>();
    const editUrl = `${url}/${childId}`;
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: editUrl,
          headers,
          payload: { version: 1, title: 'Stale', dueAt: NOW + 20000 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: editUrl,
          headers,
          payload: { version: 2, title: 'Changed', dueAt: NOW + 20000 },
        })
      ).statusCode,
    ).toBe(200);
    expect(taskRepo.listChildren(scope, taskId)[0]?.title).toBe('Changed');
    expect(
      (await app.inject({ method: 'DELETE', url: editUrl, headers, payload: { version: 2 } }))
        .statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: 'DELETE', url: editUrl, headers, payload: { version: 3 } }))
        .statusCode,
    ).toBe(200);
    expect(taskRepo.listChildren(scope, taskId)).toHaveLength(0);
  });
  it('validates every named assignee against stored and live team membership', async () => {
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(
      scope,
      { name: 'Tech', categoryId: '999999999999999999', kind: 'subteam' },
      ACTOR,
      NOW,
    );
    taskBindingRepo.addMembership(scope, teamId, MEMBER, 'member', ACTOR, NOW);
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: {
        username: 'owner',
        password: 'long-password-for-tests',
      },
    });
    const headers = {
      cookie: String(login.headers['set-cookie']).split(';')[0],
      'x-bananasaurs-csrf': login.json<{ csrfToken: string }>().csrfToken,
    };
    const payload = {
      teamId,
      title: 'Shared',
      assignmentKind: 'individual',
      assigneeIds: [MEMBER, '555555555555555555'],
      dueAt: NOW + 86400000,
      timezone: 'America/Vancouver',
      destinationId: '333333333333333333',
    };
    const response = await app.inject({ method: 'POST', url: '/api/tasks', headers, payload });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'assignee-not-in-team' });
    expect(taskRepo.listTasks(scope)).toHaveLength(0);
    const repeated = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers,
      payload: { ...payload, assigneeIds: [MEMBER, MEMBER] },
    });
    expect(repeated.statusCode).toBe(400);
    const single = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers,
      payload: { ...payload, assigneeIds: [MEMBER] },
    });
    expect(single.statusCode).toBe(409);
    expect(single.json()).toMatchObject({ error: 'assignee-not-in-guild' });
    expect(taskRepo.listTasks(scope)).toHaveLength(0);
  });
  it('edits an individual assignment only with a current version and live member', async () => {
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(
      scope,
      { name: 'Tech', categoryId: '999999999999999999', kind: 'subteam' },
      ACTOR,
      NOW,
    );
    const taskId = taskRepo.createTask(
      scope,
      {
        teamId,
        title: 'Measure chassis',
        assignmentKind: 'team',
        dueAt: NOW + 86400000,
        timezone: 'America/Vancouver',
        destinationId: '333333333333333333',
        createdBy: OWNER,
      },
      ACTOR,
      NOW,
    );
    taskBindingRepo.addMembership(scope, teamId, MEMBER, 'member', ACTOR, NOW);
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: 'long-password-for-tests' },
    });
    const headers = {
      cookie: String(login.headers['set-cookie']).split(';')[0],
      'x-bananasaurs-csrf': login.json<{ csrfToken: string }>().csrfToken,
    };
    const url = `/api/tasks/${taskId}`;
    const payload = {
      version: 1,
      title: 'Measure chassis',
      assignmentKind: 'individual',
      assigneeId: MEMBER,
      dueAt: NOW + 86400000,
      timezone: 'America/Vancouver',
      destinationId: '333333333333333333',
      priority: 'urgent',
    };
    const before = await app.inject({ method: 'PUT', url, headers, payload });
    expect(before.statusCode).toBe(409); // Fixture directory does not verify this member.
    expect(before.json()).toMatchObject({ error: 'assignee-not-in-guild' });
    expect(taskRepo.getTask(scope, taskId)?.version).toBe(1);
    const teamEdit = { ...payload, assignmentKind: 'team', assigneeId: undefined };
    const saved = await app.inject({ method: 'PUT', url, headers, payload: teamEdit });
    expect(saved.statusCode).toBe(200);
    expect(taskRepo.getTask(scope, taskId)).toMatchObject({ version: 2, priority: 'urgent' });
    expect((await app.inject({ method: 'PUT', url, headers, payload: teamEdit })).statusCode).toBe(
      409,
    );
    expect(taskRepo.getTask(scope, taskId)?.version).toBe(2);
    destinationCategory = '555555555555555555'; // Simulates a moved channel after creation.
    const moved = await app.inject({
      method: 'PUT',
      url,
      headers,
      payload: { ...teamEdit, version: 2 },
    });
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toMatchObject({ error: 'destination-not-verified' });
    expect(taskRepo.getTask(scope, taskId)?.version).toBe(2);
  });
  it('guards per-task extra reminders and stores creation and later append once', async () => {
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(
      scope,
      {
        name: 'Tech',
        categoryId: '999999999999999999',
        kind: 'subteam',
      },
      ACTOR,
      NOW,
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: {
        username: 'owner',
        password: 'long-password-for-tests',
      },
    });
    const headers = {
      cookie: String(login.headers['set-cookie']).split(';')[0],
      'x-bananasaurs-csrf': login.json<{ csrfToken: string }>().csrfToken,
    };
    const payload = {
      teamId,
      title: 'Check chassis',
      assignmentKind: 'team',
      dueAt: NOW + 86_400_000,
      timezone: 'America/Vancouver',
      destinationId: '333333333333333333',
      extraReminderAt: [NOW + 3_600_000],
    };
    expect((await app.inject({ method: 'POST', url: '/api/tasks', payload })).statusCode).toBe(401);
    const created = await app.inject({ method: 'POST', url: '/api/tasks', payload, headers });
    expect(created.statusCode).toBe(201);
    const taskId = created.json<{ taskId: string }>().taskId;
    expect(taskNudgeRepo.listSlots(scope).map((s) => s.slotId)).toContain(
      `custom:${taskId}:${NOW + 3_600_000}`,
    );
    const url = `/api/tasks/${taskId}/reminders`;
    expect(
      (await app.inject({ method: 'POST', url, payload: { at: NOW + 7_200_000 } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url, headers, payload: { at: NOW + 86_400_000 } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url, headers, payload: { at: NOW + 7_200_000 } }))
        .statusCode,
    ).toBe(201);
    expect(
      (await app.inject({ method: 'POST', url, headers, payload: { at: NOW + 7_200_000 } }))
        .statusCode,
    ).toBe(201);
    // createTask now inserts its own announce slot, so creation plus one append is three slots.
    expect(taskNudgeRepo.listSlots(scope)).toHaveLength(3);
  });
  it('requires owner, CSRF, and a live role to configure president access', async () => {
    const url = '/api/tasks/president-role';
    expect(
      (await app.inject({ method: 'PUT', url, payload: { roleId: '111111111111111119' } }))
        .statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: 'long-password-for-tests' },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect(
      (
        await app.inject({
          method: 'PUT',
          url,
          headers: { cookie },
          payload: { roleId: '111111111111111119' },
        })
      ).statusCode,
    ).toBe(403);
    const headers = { cookie, 'x-bananasaurs-csrf': login.json<{ csrfToken: string }>().csrfToken };
    expect(
      (await app.inject({ method: 'PUT', url, headers, payload: { roleId: '222222222222222222' } }))
        .statusCode,
    ).toBe(409);
    expect(taskBindingRepo.presidentRoleId(db.scopes.forGuild(GUILD))).toBeUndefined();
    expect(
      (await app.inject({ method: 'PUT', url, headers, payload: { roleId: '111111111111111119' } }))
        .statusCode,
    ).toBe(200);
    expect(taskBindingRepo.presidentRoleId(db.scopes.forGuild(GUILD))).toBe('111111111111111119');
    expect((await app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(204);
    expect(taskBindingRepo.presidentRoleId(db.scopes.forGuild(GUILD))).toBeUndefined();
  });
});

describe('task loop closure writes', () => {
  const loginHeaders = async (username: string): Promise<Record<string, string>> => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username, password: 'long-password-for-tests' },
    });
    expect(login.statusCode).toBe(200);
    return {
      cookie: String(login.headers['set-cookie']).split(';')[0] ?? '',
      'x-bananasaurs-csrf': login.json<{ csrfToken: string }>().csrfToken,
    };
  };
  const teamPayload = (name = 'Tech') => ({
    name,
    categoryId: '999999999999999999',
    kind: 'subteam' as const,
  });
  const taskPayload = (teamId: string, extra?: Record<string, unknown>) => ({
    teamId,
    title: 'Check chassis',
    assignmentKind: 'team' as const,
    dueAt: NOW + 86_400_000,
    timezone: 'America/Vancouver',
    destinationId: '333333333333333333',
    ...extra,
  });
  const editPayload = (version: number, extra?: Record<string, unknown>) => ({
    version,
    title: 'Check chassis',
    assignmentKind: 'team',
    dueAt: NOW + 86_400_000,
    timezone: 'America/Vancouver',
    destinationId: '333333333333333333',
    ...extra,
  });

  it('refuses an invalid timezone on create and on edit', async () => {
    const headers = await loginHeaders('owner');
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(scope, teamPayload(), ACTOR, NOW);
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers,
      payload: taskPayload(teamId, { timezone: 'Pacific Time' }),
    });
    expect(created.statusCode).toBe(400);
    expect(taskRepo.listTasks(scope)).toHaveLength(0);
    const taskId = taskRepo.createTask(
      scope,
      { ...taskPayload(teamId), teamId, createdBy: OWNER },
      ACTOR,
      NOW,
    );
    const edited = await app.inject({
      method: 'PUT',
      url: `/api/tasks/${taskId}`,
      headers,
      payload: editPayload(1, { timezone: 'Pacific Time' }),
    });
    expect(edited.statusCode).toBe(400);
    expect(taskRepo.getTask(scope, taskId)?.version).toBe(1);
  });

  it('refuses a second team in the same category', async () => {
    const headers = await loginHeaders('owner');
    const first = await app.inject({
      method: 'POST',
      url: '/api/tasks/teams',
      headers,
      payload: teamPayload(),
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/tasks/teams',
      headers,
      payload: teamPayload('Other'),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'category-in-use' });
  });

  it('writes exactly one dashboard audit row per write route', async () => {
    const headers = await loginHeaders('owner');
    const scope = db.scopes.forGuild(GUILD);
    const auditSize = () => effectRepo.tailAudit(scope, { limit: 10_000 }).length;
    const wroteOne = async (fn: () => Promise<{ statusCode: number }>, status: number) => {
      const before = auditSize();
      const response = await fn();
      expect(response.statusCode).toBe(status);
      const after = effectRepo.tailAudit(scope, { limit: 10_000 });
      expect(after.length).toBe(before + 1);
      expect(after[0]).toMatchObject({ actorType: 'dashboard' });
    };
    await wroteOne(
      () =>
        app.inject({ method: 'POST', url: '/api/tasks/teams', headers, payload: teamPayload() }),
      201,
    );
    const teamId = taskRepo.listTeams(scope)[0]?.teamId ?? '';
    await wroteOne(
      () =>
        app.inject({
          method: 'PUT',
          url: `/api/tasks/teams/${teamId}`,
          headers,
          payload: { name: 'Tech renamed' },
        }),
      200,
    );
    await wroteOne(
      () =>
        app.inject({
          method: 'POST',
          url: '/api/tasks/memberships',
          headers,
          payload: { teamId, discordUserId: '100000000000000001', kind: 'member' },
        }),
      200,
    );
    await wroteOne(
      () =>
        app.inject({
          method: 'PUT',
          url: '/api/tasks/president-role',
          headers,
          payload: { roleId: '111111111111111119' },
        }),
      200,
    );
    await wroteOne(
      () =>
        app.inject({ method: 'POST', url: '/api/tasks', headers, payload: taskPayload(teamId) }),
      201,
    );
    const taskId = taskRepo.listTasks(scope)[0]?.taskId ?? '';
    await wroteOne(
      () =>
        app.inject({
          method: 'PUT',
          url: `/api/tasks/${taskId}`,
          headers,
          payload: editPayload(1),
        }),
      200,
    );
    expect(taskRepo.requestCompletion(scope, taskId, 2, ACTOR, NOW)).toBe(true);
    await wroteOne(
      () =>
        app.inject({
          method: 'POST',
          url: `/api/tasks/${taskId}/approve`,
          headers,
          payload: { version: 3 },
        }),
      200,
    );
    // Approving archives the task in the same write, so reopen the listing first.
    await wroteOne(
      () =>
        app.inject({
          method: 'POST',
          url: `/api/tasks/${taskId}/unarchive`,
          headers,
          payload: { version: 4 },
        }),
      200,
    );
    await wroteOne(
      () =>
        app.inject({
          method: 'POST',
          url: `/api/tasks/${taskId}/status`,
          headers,
          payload: { version: 5, status: 'in_progress' },
        }),
      200,
    );
    expect(taskRepo.requestCompletion(scope, taskId, 6, ACTOR, NOW)).toBe(true);
    await wroteOne(
      () =>
        app.inject({
          method: 'POST',
          url: `/api/tasks/${taskId}/reject`,
          headers,
          payload: { version: 7 },
        }),
      200,
    );
    await wroteOne(
      () =>
        app.inject({
          method: 'POST',
          url: `/api/tasks/${taskId}/archive`,
          headers,
          payload: { version: 8 },
        }),
      200,
    );
    await wroteOne(
      () =>
        app.inject({
          method: 'POST',
          url: `/api/tasks/${taskId}/unarchive`,
          headers,
          payload: { version: 9 },
        }),
      200,
    );
    let childId = '';
    {
      const before = auditSize();
      const added = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/children`,
        headers,
        payload: { version: 10, title: 'Step', dueAt: NOW + 10_000 },
      });
      expect(added.statusCode).toBe(201);
      childId = added.json<{ childId: string }>().childId;
      const after = effectRepo.tailAudit(scope, { limit: 10_000 });
      expect(after.length).toBe(before + 1);
      expect(after[0]).toMatchObject({ actorType: 'dashboard' });
    }
    await wroteOne(
      () =>
        app.inject({
          method: 'POST',
          url: `/api/tasks/${taskId}/children/${childId}/complete`,
          headers,
          payload: { version: 11 },
        }),
      200,
    );
    let secondChild = '';
    {
      const before = auditSize();
      const added = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/children`,
        headers,
        payload: { version: 12, title: 'Second', dueAt: NOW + 20_000 },
      });
      expect(added.statusCode).toBe(201);
      secondChild = added.json<{ childId: string }>().childId;
      expect(effectRepo.tailAudit(scope, { limit: 10_000 }).length).toBe(before + 1);
    }
    await wroteOne(
      () =>
        app.inject({
          method: 'PUT',
          url: `/api/tasks/${taskId}/children/${secondChild}`,
          headers,
          payload: { version: 13, title: 'Second renamed', dueAt: NOW + 20_000 },
        }),
      200,
    );
    await wroteOne(
      () =>
        app.inject({
          method: 'DELETE',
          url: `/api/tasks/${taskId}/children/${secondChild}`,
          headers,
          payload: { version: 14 },
        }),
      200,
    );
    const at = NOW + 3_600_000;
    await wroteOne(
      () =>
        app.inject({
          method: 'POST',
          url: `/api/tasks/${taskId}/reminders`,
          headers,
          payload: { at },
        }),
      201,
    );
    await wroteOne(
      () =>
        app.inject({
          method: 'DELETE',
          url: `/api/tasks/${taskId}/reminders/custom:${taskId}:${at}`,
          headers,
        }),
      204,
    );
    await wroteOne(
      () =>
        app.inject({
          method: 'DELETE',
          url: `/api/tasks/memberships/${teamId}/100000000000000001`,
          headers,
        }),
      204,
    );
    await wroteOne(
      () => app.inject({ method: 'DELETE', url: '/api/tasks/president-role', headers }),
      204,
    );
    const emptyTeam = await app.inject({
      method: 'POST',
      url: '/api/tasks/teams',
      headers,
      payload: { ...teamPayload('Empty'), categoryId: '555555555555555555' },
    });
    // The second category is not in the fixture directory, so seed it directly.
    expect(emptyTeam.statusCode).toBe(409);
    const directTeamId = taskRepo.createTeam(
      scope,
      { name: 'Empty', categoryId: '555555555555555555', kind: 'subteam' },
      ACTOR,
      NOW,
    );
    await wroteOne(
      () => app.inject({ method: 'DELETE', url: `/api/tasks/teams/${directTeamId}`, headers }),
      204,
    );
  });

  it('approves an awaiting task to done', async () => {
    const headers = await loginHeaders('owner');
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(scope, teamPayload(), ACTOR, NOW);
    const taskId = taskRepo.createTask(
      scope,
      { ...taskPayload(teamId), teamId, createdBy: OWNER },
      ACTOR,
      NOW,
    );
    expect(taskRepo.requestCompletion(scope, taskId, 1, ACTOR, NOW)).toBe(true);
    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/approve`,
      headers,
      payload: { version: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ task: { status: 'done' } });
    expect(taskRepo.getTask(scope, taskId)?.status).toBe('done');
  });

  it('rejects an awaiting task back to progress', async () => {
    const headers = await loginHeaders('owner');
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(scope, teamPayload(), ACTOR, NOW);
    const taskId = taskRepo.createTask(
      scope,
      { ...taskPayload(teamId), teamId, createdBy: OWNER },
      ACTOR,
      NOW,
    );
    expect(taskRepo.requestCompletion(scope, taskId, 1, ACTOR, NOW)).toBe(true);
    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/reject`,
      headers,
      payload: { version: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ task: { status: 'in_progress' } });
  });

  it('reopens an approved (and archived) task to progress via unarchive then status', async () => {
    const headers = await loginHeaders('owner');
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(scope, teamPayload(), ACTOR, NOW);
    const taskId = taskRepo.createTask(
      scope,
      { ...taskPayload(teamId), teamId, createdBy: OWNER },
      ACTOR,
      NOW,
    );
    expect(taskRepo.requestCompletion(scope, taskId, 1, ACTOR, NOW)).toBe(true);
    expect(taskRepo.approveTask(scope, taskId, 2, ACTOR, NOW)).toBe(true);
    expect(taskRepo.getTask(scope, taskId)).toMatchObject({ status: 'done' });
    const unarchived = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/unarchive`,
      headers,
      payload: { version: 3 },
    });
    expect(unarchived.statusCode).toBe(200);
    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/status`,
      headers,
      payload: { version: 4, status: 'in_progress' },
    });
    expect(response.statusCode).toBe(200);
    expect(taskRepo.getTask(scope, taskId)?.status).toBe('in_progress');
  });

  it('hides archived tasks from the default list but shows them with include=archived', async () => {
    const headers = await loginHeaders('owner');
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(scope, teamPayload(), ACTOR, NOW);
    const taskId = taskRepo.createTask(
      scope,
      { ...taskPayload(teamId), teamId, createdBy: OWNER },
      ACTOR,
      NOW,
    );
    const archived = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/archive`,
      headers,
      payload: { version: 1 },
    });
    expect(archived.statusCode).toBe(200);
    const hidden = await app.inject({ method: 'GET', url: '/api/tasks', headers });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json()).toMatchObject({
      tasks: expect.not.arrayContaining([expect.objectContaining({ taskId })]),
    });
    const shown = await app.inject({ method: 'GET', url: '/api/tasks?include=archived', headers });
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toMatchObject({
      tasks: expect.arrayContaining([expect.objectContaining({ taskId })]),
    });
  });

  it('completes a dated child', async () => {
    const headers = await loginHeaders('owner');
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(scope, teamPayload(), ACTOR, NOW);
    const taskId = taskRepo.createTask(
      scope,
      { ...taskPayload(teamId), teamId, createdBy: OWNER },
      ACTOR,
      NOW,
    );
    const added = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/children`,
      headers,
      payload: { version: 1, title: 'Step', dueAt: NOW + 10_000 },
    });
    expect(added.statusCode).toBe(201);
    const childId = added.json<{ childId: string }>().childId;
    const completed = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/children/${childId}/complete`,
      headers,
      payload: { version: 2 },
    });
    expect(completed.statusCode).toBe(200);
    expect(taskRepo.listChildren(scope, taskId)[0]).toMatchObject({ status: 'done' });
  });

  it('returns task-not-found when completing a child of a missing task', async () => {
    const headers = await loginHeaders('owner');
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/00000000-0000-0000-0000-000000000000/children/00000000-0000-0000-0000-000000000001/complete',
      headers,
      payload: { version: 1 },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'task-not-found' });
  });

  it('refuses stale versions on approve, reject, archive, status and child complete', async () => {
    const headers = await loginHeaders('owner');
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(scope, teamPayload(), ACTOR, NOW);
    const taskId = taskRepo.createTask(
      scope,
      { ...taskPayload(teamId), teamId, createdBy: OWNER },
      ACTOR,
      NOW,
    );
    const added = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/children`,
      headers,
      payload: { version: 1, title: 'Step', dueAt: NOW + 10_000 },
    });
    const childId = added.json<{ childId: string }>().childId;
    for (const call of [
      { method: 'POST', url: `/api/tasks/${taskId}/approve`, payload: { version: 1 } },
      { method: 'POST', url: `/api/tasks/${taskId}/reject`, payload: { version: 1 } },
      { method: 'POST', url: `/api/tasks/${taskId}/archive`, payload: { version: 1 } },
      {
        method: 'POST',
        url: `/api/tasks/${taskId}/status`,
        payload: { version: 1, status: 'in_progress' },
      },
      {
        method: 'POST',
        url: `/api/tasks/${taskId}/children/${childId}/complete`,
        payload: { version: 1 },
      },
    ] as const) {
      const response = await app.inject({ ...call, headers });
      expect(response.statusCode).toBe(409);
    }
  });

  it('refuses every new write route to non-owners', async () => {
    const ownerHeaders = await loginHeaders('owner');
    const viewerHeaders = await loginHeaders('viewer');
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(scope, teamPayload(), ACTOR, NOW);
    const taskId = taskRepo.createTask(
      scope,
      { ...taskPayload(teamId), teamId, createdBy: OWNER },
      ACTOR,
      NOW,
    );
    const added = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/children`,
      headers: ownerHeaders,
      payload: { version: 1, title: 'Step', dueAt: NOW + 10_000 },
    });
    const childId = added.json<{ childId: string }>().childId;
    const calls = [
      { method: 'POST', url: '/api/tasks/teams', payload: teamPayload('Nope') },
      { method: 'PUT', url: `/api/tasks/teams/${teamId}`, payload: { name: 'Nope' } },
      { method: 'DELETE', url: `/api/tasks/teams/${teamId}` },
      {
        method: 'POST',
        url: '/api/tasks/memberships',
        payload: { teamId, discordUserId: '444444444444444444', kind: 'member' },
      },
      { method: 'DELETE', url: `/api/tasks/memberships/${teamId}/444444444444444444` },
      {
        method: 'PUT',
        url: '/api/tasks/president-role',
        payload: { roleId: '111111111111111119' },
      },
      { method: 'DELETE', url: '/api/tasks/president-role' },
      { method: 'POST', url: '/api/tasks', payload: taskPayload(teamId) },
      { method: 'PUT', url: `/api/tasks/${taskId}`, payload: editPayload(2) },
      { method: 'POST', url: `/api/tasks/${taskId}/approve`, payload: { version: 2 } },
      { method: 'POST', url: `/api/tasks/${taskId}/reject`, payload: { version: 2 } },
      {
        method: 'POST',
        url: `/api/tasks/${taskId}/status`,
        payload: { version: 2, status: 'in_progress' },
      },
      { method: 'POST', url: `/api/tasks/${taskId}/archive`, payload: { version: 2 } },
      { method: 'POST', url: `/api/tasks/${taskId}/unarchive`, payload: { version: 2 } },
      {
        method: 'POST',
        url: `/api/tasks/${taskId}/children`,
        payload: { version: 2, title: 'Step', dueAt: NOW + 10_000 },
      },
      {
        method: 'PUT',
        url: `/api/tasks/${taskId}/children/${childId}`,
        payload: { version: 2, title: 'Step', dueAt: NOW + 10_000 },
      },
      {
        method: 'DELETE',
        url: `/api/tasks/${taskId}/children/${childId}`,
        payload: { version: 2 },
      },
      {
        method: 'POST',
        url: `/api/tasks/${taskId}/children/${childId}/complete`,
        payload: { version: 2 },
      },
      {
        method: 'POST',
        url: `/api/tasks/${taskId}/reminders`,
        payload: { at: NOW + 3_600_000 },
      },
      {
        method: 'DELETE',
        url: `/api/tasks/${taskId}/reminders/custom:${taskId}:${NOW + 3_600_000}`,
      },
    ] as const;
    for (const call of calls) {
      const response = await app.inject({ ...call, headers: viewerHeaders });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'owner-only' });
    }
  });

  it('refuses to delete a team that still has a task', async () => {
    const headers = await loginHeaders('owner');
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(scope, teamPayload(), ACTOR, NOW);
    taskRepo.createTask(scope, { ...taskPayload(teamId), teamId, createdBy: OWNER }, ACTOR, NOW);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/teams/${teamId}`,
      headers,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'team-has-tasks' });
  });

  it('refuses to cancel a reminder that already sent', async () => {
    const headers = await loginHeaders('owner');
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(scope, teamPayload(), ACTOR, NOW);
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers,
      payload: taskPayload(teamId, { extraReminderAt: [NOW + 3_600_000] }),
    });
    const taskId = created.json<{ taskId: string }>().taskId;
    const slotId = `custom:${taskId}:${NOW + 3_600_000}`;
    expect(taskNudgeRepo.claim(scope, slotId, NOW + 3_600_000)).toBe(true);
    expect(
      taskNudgeRepo.settle(
        scope,
        slotId,
        'sent',
        NOW + 3_600_001,
        '333333333333333333',
        '444444444444444444',
      ),
    ).toBe(true);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}/reminders/${slotId}`,
      headers,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'reminder-not-pending' });
  });

  it('refuses to move an anchored task to another destination', async () => {
    const headers = await loginHeaders('owner');
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(scope, teamPayload(), ACTOR, NOW);
    const taskId = taskRepo.createTask(
      scope,
      { ...taskPayload(teamId), teamId, createdBy: OWNER },
      ACTOR,
      NOW,
    );
    expect(
      taskRepo.recordTaskAnchor(scope, taskId, '333333333333333333', '444444444444444444', NOW),
    ).toBe('recorded');
    const response = await app.inject({
      method: 'PUT',
      url: `/api/tasks/${taskId}`,
      headers,
      payload: editPayload(1, { destinationId: '777777777777777779' }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'task-anchored-destination' });
  });

  it('deletes a task with its version, then reports task-not-found', async () => {
    const headers = await loginHeaders('owner');
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(scope, teamPayload(), ACTOR, NOW);
    const taskId = taskRepo.createTask(
      scope,
      { ...taskPayload(teamId), teamId, createdBy: OWNER },
      ACTOR,
      NOW,
    );
    const stale = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}`,
      headers,
      payload: { version: 2 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'stale-task-version' });
    expect(taskRepo.getTask(scope, taskId)).toBeDefined();
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}`,
      headers,
      payload: { version: 1 },
    });
    expect(deleted.statusCode).toBe(204);
    expect(taskRepo.getTask(scope, taskId)).toBeUndefined();
    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}`,
      headers,
      payload: { version: 1 },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'task-not-found' });
  });

  it('deletes one progress report and reports task-report-not-found when missing', async () => {
    const headers = await loginHeaders('owner');
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(scope, teamPayload(), ACTOR, NOW);
    const taskId = taskRepo.createTask(
      scope,
      { ...taskPayload(teamId), teamId, createdBy: OWNER },
      ACTOR,
      NOW,
    );
    expect(
      taskRepo.recordReport(scope, taskId, 'rep-one', MEMBER, 'first update', ACTOR, NOW),
    ).toBe('recorded');
    expect(
      taskRepo.recordReport(scope, taskId, 'rep-two', MEMBER, 'second update', ACTOR, NOW),
    ).toBe('recorded');
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}/reports/rep-one`,
      headers,
    });
    expect(deleted.statusCode).toBe(204);
    expect(taskRepo.listReports(scope, taskId).map((r) => r.reportId)).toEqual(['rep-two']);
    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}/reports/rep-one`,
      headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'task-report-not-found' });
  });

  it('refuses task and report deletes to non-owners', async () => {
    const ownerHeaders = await loginHeaders('owner');
    const viewerHeaders = await loginHeaders('viewer');
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(scope, teamPayload(), ACTOR, NOW);
    const taskId = taskRepo.createTask(
      scope,
      { ...taskPayload(teamId), teamId, createdBy: OWNER },
      ACTOR,
      NOW,
    );
    expect(taskRepo.recordReport(scope, taskId, 'rep-one', MEMBER, 'an update', ACTOR, NOW)).toBe(
      'recorded',
    );
    for (const call of [
      { method: 'DELETE', url: `/api/tasks/${taskId}`, payload: { version: 1 } },
      { method: 'DELETE', url: `/api/tasks/${taskId}/reports/rep-one` },
    ] as const) {
      const response = await app.inject({ ...call, headers: viewerHeaders });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'owner-only' });
    }
    expect(taskRepo.getTask(scope, taskId)).toBeDefined();
    expect(taskRepo.listReports(scope, taskId)).toHaveLength(1);
    void ownerHeaders;
  });

  it('writes no second audit row when the same reminder is appended twice', async () => {
    const headers = await loginHeaders('owner');
    const scope = db.scopes.forGuild(GUILD);
    const teamId = taskRepo.createTeam(scope, teamPayload(), ACTOR, NOW);
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers,
      payload: taskPayload(teamId),
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json<{ taskId: string }>().taskId;
    const auditSize = () => effectRepo.tailAudit(scope, { limit: 10_000 }).length;
    const before = auditSize();
    const first = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/reminders`,
      headers,
      payload: { at: NOW + 3_600_000 },
    });
    expect(first.statusCode).toBe(201);
    expect(auditSize()).toBe(before + 1);
    const second = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/reminders`,
      headers,
      payload: { at: NOW + 3_600_000 },
    });
    expect(second.statusCode).toBe(201);
    expect(auditSize()).toBe(before + 1);
  });
});
