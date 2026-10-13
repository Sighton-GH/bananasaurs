import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { guildRepo, taskRepo, taskNudgeRepo, type GuildScope } from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { scheduleUpdatePost } from './task-update-slot.js';
let db: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
beforeEach(() => {
  db = openMigratedTestDatabase();
  scope = db.scopes.forGuild(parseGuildId('111111111111111111'));
  guildRepo.upsertGuild(scope, { name: 'Test', now: 1 });
});
afterEach(() => db.close());
it('schedules one immediate update per report and isolates guilds', () => {
  const actor = { actorType: 'dashboard', actorId: 'owner', via: 'http' } as const;
  const teamId = taskRepo.createTeam(
    scope,
    { name: 'Tech', categoryId: '222222222222222222', kind: 'subteam' },
    actor,
    1,
  );
  const taskId = taskRepo.createTask(
    scope,
    {
      teamId,
      title: 'Build',
      assignmentKind: 'team',
      dueAt: 5000,
      timezone: 'America/Vancouver',
      destinationId: '333333333333333333',
      createdBy: 'owner',
    },
    actor,
    2,
  );
  scheduleUpdatePost(scope, taskId, 'modal:900000000000000001', 3);
  scheduleUpdatePost(scope, taskId, 'modal:900000000000000001', 4);
  expect(taskNudgeRepo.listSlots(scope).filter((s) => s.kind === 'update')).toMatchObject([
    {
      slotId: 'update:modal:900000000000000001',
      kind: 'update',
      taskId,
      dueAt: 3,
      state: 'pending',
      payload: JSON.stringify({ reportId: 'modal:900000000000000001' }),
    },
  ]);
  const other = db.scopes.forGuild(parseGuildId('111111111111111112'));
  expect(taskNudgeRepo.listSlots(other)).toEqual([]);
});
