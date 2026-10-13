import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { guildRepo, taskRepo, type GuildScope } from '@bananasaurs/storage';
import { audienceFor, taskCardView } from './task-view.js';

let db: MigratedTestDatabase, scope: GuildScope;
const G = parseGuildId('111111111111111111');
const ROLE = '200000000000000002';
const U1 = '100000000000000001',
  U2 = '100000000000000002';
const ACTOR = { actorType: 'dashboard', actorId: 'owner', via: 'http' } as const;
const MEMBER_ACTOR = { actorType: 'member', actorId: U1, via: 'gateway' } as const;
const T0 = Date.parse('2026-09-28T15:00:00Z');

beforeEach(() => {
  db = openMigratedTestDatabase();
  scope = db.scopes.forGuild(G);
  guildRepo.upsertGuild(scope, { name: 'A', now: 0 });
});
afterEach(() => db.close());

let catSeq = 0;
const team = (name: string, memberRoleId?: string) =>
  taskRepo.createTeam(
    scope,
    {
      name,
      categoryId: String(333333333333333330n + BigInt(++catSeq)),
      announcementChannelId: '444444444444444444',
      kind: 'subteam',
      ...(memberRoleId ? { memberRoleId } : {}),
    },
    ACTOR,
    1,
  );
const task = (teamId: string, extra?: Record<string, unknown>) =>
  taskRepo.createTask(
    scope,
    {
      teamId,
      title: 'Build',
      assignmentKind: 'team',
      dueAt: T0 + 48 * 3_600_000,
      timezone: 'America/Vancouver',
      destinationId: '555555555555555555',
      createdBy: 'owner',
      ...extra,
    },
    ACTOR,
    2,
  );

it('uses the member role for a team task, or the team when it has no role', () => {
  const withRole = team('Robotics', ROLE);
  const noRole = team('Media');
  const a = task(withRole);
  const b = task(noRole);
  const ta = taskRepo.getTask(scope, a)!;
  const tb = taskRepo.getTask(scope, b)!;
  expect(audienceFor(scope, ta, { memberRoleId: ROLE })).toEqual({ kind: 'role', roleId: ROLE });
  expect(audienceFor(scope, tb, { memberRoleId: null })).toEqual({ kind: 'team' });
  expect(taskCardView(scope, a, T0, 'announce')?.audience).toEqual({ kind: 'role', roleId: ROLE });
  expect(taskCardView(scope, b, T0, 'announce')?.audience).toEqual({ kind: 'team' });
});

it('builds an individual task view with links, newest report and pickup', () => {
  const t = task(team('Robotics'), {
    assignmentKind: 'individual',
    assigneeIds: [U1, U2],
    links: [
      { label: 'Spec', url: 'https://example.com/spec' },
      { label: 'Board', url: 'https://example.com/board' },
    ],
  });
  expect(taskRepo.setStatus(scope, t, 1, 'in_progress', MEMBER_ACTOR, T0 + 10)).toBe(true);
  taskRepo.recordReport(scope, t, 'r1', U1, 'first', MEMBER_ACTOR, T0 + 20);
  taskRepo.recordReport(scope, t, 'r2', U2, 'second', MEMBER_ACTOR, T0 + 30);
  const view = taskCardView(scope, t, T0 + 40, 'refresh')!;
  expect(view.audience).toEqual({ kind: 'users', userIds: [U1, U2] });
  expect(view.links.map((l) => l.label)).toEqual(['Spec', 'Board']);
  expect(view.lastUpdate).toMatchObject({ authorId: U2, body: 'second' });
  expect(view.pickedUp?.userId).toBe(U1);
  expect(view.status).toBe('in_progress');
  expect(view.variant).toBe('refresh');
  expect(view.now).toBe(T0 + 40);
});

it('returns undefined for an archived task', () => {
  const t = task(team('Robotics'));
  const v = taskRepo.getTask(scope, t)!.version;
  expect(taskRepo.archiveTask(scope, t, v, ACTOR, T0)).toBe(true);
  expect(taskCardView(scope, t, T0, 'announce')).toBeUndefined();
});
