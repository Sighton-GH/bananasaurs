import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { upsertGuild } from './guilds.js';
import { createTeam, createTask, recordTaskAnchor } from './tasks.js';
import * as nudge from './task-nudges.js';

let db: MigratedTestDatabase;
const A = parseGuildId('111111111111111111');
const B = parseGuildId('222222222222222222');
const ACTOR = { actorType: 'dashboard', actorId: 'owner', via: 'http' } as const;
beforeEach(() => {
  db = openMigratedTestDatabase();
  upsertGuild(db.scopes.forGuild(A), { name: 'A', now: 0 });
  upsertGuild(db.scopes.forGuild(B), { name: 'B', now: 0 });
});
afterEach(() => db.close());
it('persists and partitions slots and audits each delivery at most once', () => {
  const a = db.scopes.forGuild(A),
    b = db.scopes.forGuild(B);
  nudge.schedule(a, { slotId: 'weekly:one', kind: 'digest', dueAt: 50 }, 10);
  nudge.schedule(a, { slotId: 'weekly:one', kind: 'digest', dueAt: 50 }, 10);
  expect(nudge.listDue(b, 100)).toHaveLength(0);
  expect(nudge.listDue(a, 49)).toHaveLength(0);
  expect(nudge.claim(b, 'weekly:one', 50)).toBe(false);
  expect(nudge.claim(a, 'weekly:one', 50)).toBe(true);
  expect(nudge.claim(a, 'weekly:one', 50)).toBe(false);
  expect(
    nudge.settle(a, 'weekly:one', 'sent', 51, '333333333333333333', '444444444444444444'),
  ).toBe(true);
  expect(nudge.settle(a, 'weekly:one', 'sent', 52)).toBe(false);
  expect(nudge.listDeliveries(a)).toHaveLength(1);
  expect(nudge.listDeliveries(b)).toHaveLength(0);
});
it('pauses ambiguous in-flight sends on restart', () => {
  const a = db.scopes.forGuild(A),
    b = db.scopes.forGuild(B);
  const teamId = createTeam(
    a,
    { name: 'T', categoryId: '333333333333333333', kind: 'subteam' },
    ACTOR,
    1,
  );
  const taskId = createTask(
    a,
    {
      teamId,
      title: 'Task',
      dueAt: 1000,
      timezone: 'America/Vancouver',
      destinationId: '444444444444444444',
      assignmentKind: 'team',
      createdBy: 'owner',
    },
    ACTOR,
    2,
  );
  nudge.appendCustom(a, taskId, 500, 3);
  nudge.appendCustom(a, taskId, 500, 3);
  // createTask inserts one announce slot alongside the custom reminder slot.
  expect(nudge.listSlots(a)).toHaveLength(2);
  expect(nudge.claim(a, `custom:${taskId}:500`, 500)).toBe(true);
  expect(nudge.reconcileClaims(a, 501)).toBe(1);
  // The announce slot belongs to the task post worker; claim it so the restart assertions below see only the custom slot.
  expect(nudge.claim(a, `announce:${taskId}`, 502)).toBe(true);
  expect(nudge.listDue(a, 1000)).toHaveLength(0);
  expect(nudge.listDeliveries(a)[0]?.outcome).toBe('paused');
  expect(nudge.listDue(b, 1000)).toHaveLength(0);
});
it('cancels one pending custom reminder and refuses sent or foreign slots', () => {
  const a = db.scopes.forGuild(A);
  const teamId = createTeam(
    a,
    { name: 'T', categoryId: '333333333333333333', kind: 'subteam' },
    ACTOR,
    1,
  );
  const taskId = createTask(
    a,
    {
      teamId,
      title: 'Task',
      dueAt: 1000,
      timezone: 'America/Vancouver',
      destinationId: '444444444444444444',
      assignmentKind: 'team',
      createdBy: 'owner',
    },
    ACTOR,
    2,
  );
  const otherId = createTask(
    a,
    {
      teamId,
      title: 'Other',
      dueAt: 1000,
      timezone: 'America/Vancouver',
      destinationId: '444444444444444444',
      assignmentKind: 'team',
      createdBy: 'owner',
    },
    ACTOR,
    2,
  );
  nudge.appendCustom(a, taskId, 500, 3);
  nudge.appendCustom(a, taskId, 600, 3);
  const slotId = `custom:${taskId}:500`;
  expect(nudge.cancelCustom(a, taskId, slotId, 4)).toBe('cancelled');
  const slot = nudge.slotsForTask(a, taskId).find((s) => s.slotId === slotId);
  expect(slot?.state).toBe('superseded');
  expect(slot?.lastError).toBe('cancelled by owner');
  // Cancelling the same slot twice is not pending.
  expect(nudge.cancelCustom(a, taskId, slotId, 5)).toBe('not-pending');
  // A sent slot cannot be cancelled.
  const sentId = `custom:${taskId}:600`;
  expect(nudge.claim(a, sentId, 6)).toBe(true);
  expect(nudge.settle(a, sentId, 'sent', 7, '444444444444444444', '555555555555555555')).toBe(true);
  expect(nudge.cancelCustom(a, taskId, sentId, 8)).toBe('not-pending');
  // Another task's slot cannot be cancelled through this task.
  nudge.appendCustom(a, otherId, 500, 3);
  expect(nudge.cancelCustom(a, taskId, `custom:${otherId}:500`, 9)).toBe('not-pending');
  // slotsForTask is ordered by dueAt.
  expect(nudge.slotsForTask(a, taskId).map((s) => s.dueAt)).toEqual(
    [...nudge.slotsForTask(a, taskId).map((s) => s.dueAt)].sort((x, y) => x - y),
  );
});
it('stores destination and payload on schedule, and settles a check-in with its tasks once', () => {
  const a = db.scopes.forGuild(A);
  const teamId = createTeam(
    a,
    { name: 'T', categoryId: '333333333333333333', kind: 'subteam' },
    ACTOR,
    1,
  );
  const makeTask = (title: string) =>
    createTask(
      a,
      {
        teamId,
        title,
        dueAt: 1000,
        timezone: 'America/Vancouver',
        destinationId: '444444444444444444',
        assignmentKind: 'team',
        createdBy: 'owner',
      },
      ACTOR,
      2,
    );
  const t1 = makeTask('One');
  const t2 = makeTask('Two');
  const t3 = makeTask('Three');
  const checkin = 'checkin:444444444444444444:2026-09-28';
  nudge.schedule(
    a,
    {
      slotId: checkin,
      kind: 'checkin',
      dueAt: 10,
      destinationId: '444444444444444444',
    },
    10,
  );
  nudge.schedule(
    a,
    {
      slotId: `review:${t1}:2`,
      taskId: t1,
      kind: 'review',
      dueAt: 10,
      payload: JSON.stringify({ version: 2, requestedBy: '777777777777777777' }),
    },
    10,
  );
  nudge.schedule(
    a,
    {
      slotId: 'clarify:888888888888888888',
      kind: 'clarify',
      dueAt: 10,
      payload: JSON.stringify({
        replyMessageId: '888888888888888888',
        channelId: '444444444444444444',
        candidates: [t1, t2],
      }),
    },
    10,
  );
  expect(nudge.listSlots(a).find((s) => s.slotId === checkin)?.destinationId).toBe(
    '444444444444444444',
  );
  expect(nudge.listSlots(a).find((s) => s.slotId === `review:${t1}:2`)?.payload).toBe(
    JSON.stringify({ version: 2, requestedBy: '777777777777777777' }),
  );
  expect(nudge.listSlotTasks(a, checkin)).toEqual([]);
  expect(nudge.claim(a, checkin, 11)).toBe(true);
  expect(
    nudge.settleWithTasks(a, checkin, 12, '444444444444444444', '555555555555555555', [t1, t2, t3]),
  ).toBe(true);
  expect(nudge.listSlotTasks(a, checkin).sort()).toEqual([t1, t2, t3].sort());
  // A second settle finds no claimed slot and writes nothing new.
  expect(
    nudge.settleWithTasks(a, checkin, 13, '444444444444444444', '555555555555555555', [t1]),
  ).toBe(false);
  expect(nudge.listSlotTasks(a, checkin).sort()).toEqual([t1, t2, t3].sort());
  expect(nudge.listDeliveries(a).filter((d) => d.slotId === checkin)).toHaveLength(1);
});
it('finds a sent slot by its delivered message only in the same channel and state', () => {
  const a = db.scopes.forGuild(A),
    b = db.scopes.forGuild(B);
  const teamId = createTeam(
    a,
    { name: 'T', categoryId: '333333333333333333', kind: 'subteam' },
    ACTOR,
    1,
  );
  const taskId = createTask(
    a,
    {
      teamId,
      title: 'Task',
      dueAt: 1000,
      timezone: 'America/Vancouver',
      destinationId: '444444444444444444',
      assignmentKind: 'team',
      createdBy: 'owner',
    },
    ACTOR,
    2,
  );
  nudge.schedule(a, { slotId: 'reminder', taskId, kind: 'custom', dueAt: 1 }, 1);
  expect(nudge.getSlot(a, 'reminder')).toMatchObject({ slotId: 'reminder', state: 'pending' });
  expect(nudge.getSlot(a, 'missing')).toBeUndefined();
  // Pending is not sent: no attribution yet.
  expect(nudge.sentSlotForMessage(a, '444444444444444444', '555555555555555555')).toBeUndefined();
  expect(nudge.claim(a, 'reminder', 2)).toBe(true);
  expect(nudge.settle(a, 'reminder', 'sent', 3, '444444444444444444', '555555555555555555')).toBe(
    true,
  );
  expect(nudge.sentSlotForMessage(a, '444444444444444444', '555555555555555555')).toMatchObject({
    slotId: 'reminder',
    state: 'sent',
  });
  // A slot in another channel is another post: no attribution.
  expect(nudge.sentSlotForMessage(a, '999999999999999999', '555555555555555555')).toBeUndefined();
  // Guild scope holds: the same message id in another guild finds nothing.
  expect(nudge.sentSlotForMessage(b, '444444444444444444', '555555555555555555')).toBeUndefined();
});
it('holds a reply choice idempotently and prunes only week-old rows', () => {
  const a = db.scopes.forGuild(A),
    b = db.scopes.forGuild(B);
  const now = 10_000_000;
  const fresh = {
    messageId: '666666666666666666',
    authorId: '777777777777777777',
    channelId: '444444444444444444',
    body: 'wiring done',
    createdAt: now - 1000,
  };
  expect(nudge.insertReplyChoice(a, fresh)).toBe(true);
  expect(nudge.insertReplyChoice(a, fresh)).toBe(false);
  expect(nudge.getReplyChoice(a, fresh.messageId)).toMatchObject({
    authorId: fresh.authorId,
    channelId: fresh.channelId,
    body: fresh.body,
  });
  // Choices never cross guilds.
  expect(nudge.getReplyChoice(b, fresh.messageId)).toBeUndefined();
  const old = { ...fresh, messageId: '666666666666666667', createdAt: now - 7 * 86_400_000 - 1 };
  expect(nudge.insertReplyChoice(a, old)).toBe(true);
  expect(nudge.insertReplyChoice(b, old)).toBe(true);
  // A prune before anything is a week old removes nothing.
  expect(nudge.pruneReplyChoices(a, old.createdAt + 7 * 86_400_000 - 1)).toBe(0);
  expect(nudge.getReplyChoice(a, old.messageId)).toBeDefined();
  // At now the old row goes, the fresh row stays, and the other guild is untouched.
  expect(nudge.pruneReplyChoices(a, now)).toBe(1);
  expect(nudge.getReplyChoice(a, old.messageId)).toBeUndefined();
  expect(nudge.getReplyChoice(a, fresh.messageId)).toBeDefined();
  expect(nudge.getReplyChoice(b, old.messageId)).toBeDefined();
  expect(nudge.deleteReplyChoice(a, fresh.messageId)).toBe(true);
  expect(nudge.deleteReplyChoice(a, fresh.messageId)).toBe(false);
  expect(nudge.getReplyChoice(a, fresh.messageId)).toBeUndefined();
});
it('names a task post by its anchor or a sent slot, never by another guild', () => {
  const a = db.scopes.forGuild(A),
    b = db.scopes.forGuild(B);
  const teamId = createTeam(
    a,
    { name: 'T', categoryId: '333333333333333333', kind: 'subteam' },
    ACTOR,
    1,
  );
  const taskId = createTask(
    a,
    {
      teamId,
      title: 'Task',
      dueAt: 1000,
      timezone: 'America/Vancouver',
      destinationId: '444444444444444444',
      assignmentKind: 'team',
      createdBy: 'owner',
    },
    ACTOR,
    2,
  );
  expect(recordTaskAnchor(a, taskId, '444444444444444444', '555555555555555555', 3)).toBe(
    'recorded',
  );
  expect(nudge.isTaskPost(a, '555555555555555555')).toBe(true);
  nudge.schedule(a, { slotId: 'reminder', taskId, kind: 'custom', dueAt: 1 }, 1);
  expect(nudge.claim(a, 'reminder', 2)).toBe(true);
  expect(nudge.settle(a, 'reminder', 'sent', 3, '444444444444444444', '666666666666666666')).toBe(
    true,
  );
  expect(nudge.isTaskPost(a, '666666666666666666')).toBe(true);
  expect(nudge.isTaskPost(a, '777777777777777777')).toBe(false);
  expect(nudge.isTaskPost(b, '555555555555555555')).toBe(false);
  expect(nudge.isTaskPost(b, '666666666666666666')).toBe(false);
});
it('never names a task post by a sent followup slot, whose message is the member reply', () => {
  const a = db.scopes.forGuild(A);
  const teamId = createTeam(
    a,
    { name: 'T', categoryId: '333333333333333333', kind: 'subteam' },
    ACTOR,
    1,
  );
  const taskId = createTask(
    a,
    {
      teamId,
      title: 'Task',
      dueAt: 1000,
      timezone: 'America/Vancouver',
      destinationId: '444444444444444444',
      assignmentKind: 'team',
      createdBy: 'owner',
    },
    ACTOR,
    2,
  );
  nudge.schedule(a, { slotId: 'followup:one', taskId, kind: 'followup', dueAt: 1 }, 1);
  expect(nudge.claim(a, 'followup:one', 2)).toBe(true);
  expect(
    nudge.settle(a, 'followup:one', 'sent', 3, '444444444444444444', '555555555555555555'),
  ).toBe(true);
  expect(nudge.isTaskPost(a, '555555555555555555')).toBe(false);
});
it('excludes held kinds from the due page when asked, so event kinds are never starved', () => {
  const a = db.scopes.forGuild(A);
  for (let i = 0; i < 45; i += 1)
    nudge.schedule(a, { slotId: `held:${i}`, kind: 'digest', dueAt: 50 }, 10);
  nudge.schedule(a, { slotId: 'event:one', kind: 'review', dueAt: 50 }, 10);
  expect(nudge.listDue(a, 100)).toHaveLength(40);
  const page = nudge.listDue(a, 100, 40, ['pre_due', 'custom', 'checkin', 'digest']);
  expect(page.map((s) => s.slotId)).toEqual(['event:one']);
});
