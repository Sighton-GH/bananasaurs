import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { tailAudit } from './effects.js';
import { upsertGuild } from './guilds.js';
import { listSlots } from './task-nudges.js';
import {
  DEFAULT_QUIET_HOURS,
  listTaskLinks,
  anchorFor,
  staleTaskCards,
  markCardRendered,
  lastPickup,
  approveTask,
  archiveTask,
  changeChild,
  completeTask,
  createTask,
  createTeam,
  deleteReport,
  deleteTask,
  deleteTeam,
  getQuietHours,
  getTask,
  isTaskAssignee,
  listChildren,
  listReports,
  listTaskAssignees,
  listTasks,
  normalizeAssignees,
  recordReport,
  recordTaskAnchor,
  rejectTask,
  requestCompletion,
  setQuietHours,
  setStatus,
  taskForAnchor,
  unarchiveTask,
  updateTask,
  updateTeam,
} from './tasks.js';

let db: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;
const A = parseGuildId('111111111111111111');
const B = parseGuildId('222222222222222222');
const ACTOR = { actorType: 'dashboard', actorId: 'owner', via: 'http' } as const;
const MEMBER_ACTOR = {
  actorType: 'member',
  actorId: '444444444444444444',
  via: 'gateway',
} as const;
beforeEach(() => {
  db = openMigratedTestDatabase();
  a = db.scopes.forGuild(A);
  b = db.scopes.forGuild(B);
  upsertGuild(a, { name: 'A', now: 0 });
  upsertGuild(b, { name: 'B', now: 0 });
});
afterEach(() => db.close());

const seedTeam = (scope: GuildScope = a, categoryId = '333333333333333333') =>
  createTeam(scope, { name: 'Tech', categoryId, kind: 'subteam' }, ACTOR, 1);
const seedTask = (
  teamId: string,
  over: Record<string, unknown> = {},
  scope: GuildScope = a,
  now = 2,
) =>
  createTask(
    scope,
    {
      teamId,
      title: 'Project',
      assignmentKind: 'team',
      dueAt: 3000,
      timezone: 'America/Vancouver',
      destinationId: '444444444444444444',
      createdBy: 'owner',
      ...over,
    },
    ACTOR,
    now,
  );

describe('audited task writes', () => {
  it('each write records exactly one audit row with the passed actor; failures record none', () => {
    const teamId = createTeam(
      a,
      { name: 'Tech', categoryId: '333333333333333333', kind: 'subteam' },
      ACTOR,
      1,
    );
    expect(tailAudit(a)).toHaveLength(1);
    expect(tailAudit(a)[0]).toMatchObject({
      actorType: 'dashboard',
      actorId: 'owner',
      action: 'task.team_created',
    });
    expect(updateTeam(a, teamId, { name: 'Tech two' }, ACTOR, 2)).toBe(true);
    expect(tailAudit(a)).toHaveLength(2);
    expect(tailAudit(a)[0]).toMatchObject({ action: 'task.team_configured' });
    expect(updateTeam(a, '00000000-0000-0000-0000-000000000000', { name: 'Nope' }, ACTOR, 2)).toBe(
      false,
    );
    expect(tailAudit(a)).toHaveLength(2);
    const taskId = seedTask(teamId);
    expect(tailAudit(a)).toHaveLength(3);
    expect(tailAudit(a)[0]).toMatchObject({ action: 'task.created' });
    expect(
      updateTask(
        a,
        taskId,
        1,
        {
          title: 'Edited',
          assignmentKind: 'team',
          dueAt: 4000,
          timezone: 'America/Vancouver',
          destinationId: '444444444444444444',
        },
        ACTOR,
        3,
      ),
    ).toBe('ok');
    expect(tailAudit(a)).toHaveLength(4);
    expect(tailAudit(a)[0]).toMatchObject({ action: 'task.edited' });
    expect(
      updateTask(
        a,
        taskId,
        1,
        {
          title: 'Stale',
          assignmentKind: 'team',
          dueAt: 4000,
          timezone: 'America/Vancouver',
          destinationId: '444444444444444444',
        },
        ACTOR,
        3,
      ),
    ).toBe('stale');
    expect(tailAudit(a)).toHaveLength(4);
    expect(
      changeChild(a, taskId, 2, { kind: 'add', title: 'Step', dueAt: 2000 }, ACTOR, 4),
    ).toMatchObject({ version: 3 });
    expect(tailAudit(a)).toHaveLength(5);
    expect(
      changeChild(a, taskId, 2, { kind: 'add', title: 'Stale', dueAt: 2000 }, ACTOR, 4),
    ).toBeUndefined();
    expect(tailAudit(a)).toHaveLength(5);
    expect(
      recordReport(a, taskId, '666666666666666666', '444444444444444444', 'progress', ACTOR, 5),
    ).toBe('recorded');
    expect(tailAudit(a)).toHaveLength(6);
    expect(tailAudit(a)[0]).toMatchObject({ action: 'task.report_recorded' });
    expect(requestCompletion(a, taskId, 4, MEMBER_ACTOR, 6)).toBe(true);
    expect(tailAudit(a)).toHaveLength(7);
    expect(tailAudit(a)[0]).toMatchObject({
      actorType: 'member',
      action: 'task.completion_requested',
    });
    expect(requestCompletion(a, taskId, 4, MEMBER_ACTOR, 7)).toBe(false);
    expect(tailAudit(a)).toHaveLength(7);
    expect(rejectTask(a, taskId, 5, ACTOR, 8)).toBe(true);
    expect(tailAudit(a)).toHaveLength(8);
    expect(tailAudit(a)[0]).toMatchObject({ action: 'task.sent_back' });
    expect(requestCompletion(a, taskId, 6, MEMBER_ACTOR, 9)).toBe(true);
    expect(approveTask(a, taskId, 7, ACTOR, 10)).toBe(true);
    expect(tailAudit(a)).toHaveLength(10);
    expect(tailAudit(a)[0]).toMatchObject({ action: 'task.approved' });
    expect(approveTask(a, taskId, 7, ACTOR, 11)).toBe(false);
    expect(tailAudit(a)).toHaveLength(10);
    expect(unarchiveTask(a, taskId, 8, ACTOR, 12)).toBe(true);
    expect(tailAudit(a)).toHaveLength(11);
    expect(tailAudit(a)[0]).toMatchObject({ action: 'task.unarchived' });
    expect(setStatus(a, taskId, 9, 'in_progress', ACTOR, 13)).toBe(true);
    expect(tailAudit(a)).toHaveLength(12);
    expect(tailAudit(a)[0]).toMatchObject({ action: 'task.status_set' });
    expect(archiveTask(a, taskId, 10, ACTOR, 14)).toBe(true);
    expect(tailAudit(a)).toHaveLength(13);
    expect(tailAudit(a)[0]).toMatchObject({ action: 'task.archived' });
    expect(archiveTask(a, taskId, 11, ACTOR, 15)).toBe(false);
    expect(tailAudit(a)).toHaveLength(13);
    expect(unarchiveTask(a, taskId, 11, ACTOR, 16)).toBe(true);
    expect(tailAudit(a)).toHaveLength(14);
    expect(tailAudit(a)[0]).toMatchObject({ action: 'task.unarchived' });
    expect(unarchiveTask(a, taskId, 12, ACTOR, 17)).toBe(false);
    expect(tailAudit(a)).toHaveLength(14);
    expect(deleteTeam(a, teamId, ACTOR, 18)).toBe('has-tasks');
    expect(tailAudit(a)).toHaveLength(14);
    const emptyTeam = createTeam(
      a,
      { name: 'Empty', categoryId: '555555555555555555', kind: 'exec' },
      ACTOR,
      18,
    );
    expect(deleteTeam(a, emptyTeam, ACTOR, 19)).toBe('deleted');
    expect(tailAudit(a)[0]).toMatchObject({ action: 'task.team_deleted' });
    expect(deleteTeam(a, emptyTeam, ACTOR, 20)).toBe('not-found');
    setQuietHours(
      a,
      { startMinute: 0, endMinute: 480, timezone: 'America/Los_Angeles' },
      ACTOR,
      21,
    );
    expect(tailAudit(a)[0]).toMatchObject({ action: 'task.quiet_hours_configured' });
    expect(tailAudit(b)).toHaveLength(0);
  });
  it('createTask inserts exactly one announce slot and one custom slot per extraReminderAt', () => {
    const teamId = seedTeam();
    const at = 2500;
    const taskId = createTask(
      a,
      {
        teamId,
        title: 'Slotted',
        assignmentKind: 'team',
        dueAt: 3000,
        timezone: 'America/Vancouver',
        destinationId: '444444444444444444',
        createdBy: 'owner',
        extraReminderAt: [at],
      },
      ACTOR,
      2,
    );
    const slots = listSlots(a).filter((s) => s.taskId === taskId);
    expect(slots.filter((s) => s.slotId === `announce:${taskId}`)).toHaveLength(1);
    expect(slots.find((s) => s.slotId === `announce:${taskId}`)).toMatchObject({
      kind: 'announce',
    });
    expect(slots.filter((s) => s.slotId === `custom:${taskId}:${at}`)).toHaveLength(1);
    expect(slots.find((s) => s.slotId === `custom:${taskId}:${at}`)).toMatchObject({
      kind: 'custom',
      dueAt: at,
    });
    expect(slots).toHaveLength(2);
  });
  it('createTask rejects an extraReminderAt at or after dueAt without inserting a task', () => {
    const teamId = seedTeam();
    expect(() =>
      createTask(
        a,
        {
          teamId,
          title: 'Bad slot',
          assignmentKind: 'team',
          dueAt: 3000,
          timezone: 'America/Vancouver',
          destinationId: '444444444444444444',
          createdBy: 'owner',
          extraReminderAt: [3000],
        },
        ACTOR,
        2,
      ),
    ).toThrow('invalid-extra-reminder');
    expect(() =>
      createTask(
        a,
        {
          teamId,
          title: 'Bad slot',
          assignmentKind: 'team',
          dueAt: 3000,
          timezone: 'America/Vancouver',
          destinationId: '444444444444444444',
          createdBy: 'owner',
          extraReminderAt: [1],
        },
        ACTOR,
        2,
      ),
    ).toThrow('invalid-extra-reminder');
    expect(listTasks(a)).toHaveLength(0);
    expect(tailAudit(a)).toHaveLength(1);
  });
  it('requestCompletion inserts one review slot; a stale retry adds none', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    expect(requestCompletion(a, taskId, 1, MEMBER_ACTOR, 3)).toBe(true);
    const slots = listSlots(a);
    const review = slots.filter((s) => s.slotId === `review:${taskId}:2`);
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ kind: 'review' });
    expect(JSON.parse(review[0]!.payload!)).toEqual({
      version: 2,
      requestedBy: '444444444444444444',
    });
    expect(requestCompletion(a, taskId, 1, MEMBER_ACTOR, 4)).toBe(false);
    expect(listSlots(a).filter((s) => s.slotId === `review:${taskId}:2`)).toHaveLength(1);
    expect(requestCompletion(a, taskId, 9, MEMBER_ACTOR, 4)).toBe(false);
    expect(listSlots(a).filter((s) => s.slotId === `review:${taskId}:10`)).toHaveLength(0);
  });
  it('approveTask archives in the same write; unarchive brings the done task back', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    expect(requestCompletion(a, taskId, 1, MEMBER_ACTOR, 3)).toBe(true);
    expect(
      recordReport(a, taskId, '666666666666666666', '444444444444444444', 'halfway', ACTOR, 4),
    ).toBe('recorded');
    expect(approveTask(a, taskId, 2, ACTOR, 5)).toBe(true);
    const done = getTask(a, taskId)!;
    expect(done).toMatchObject({ status: 'done', version: 3 });
    expect(done.archivedAt).toBe(5);
    expect(listTasks(a)).toHaveLength(0);
    expect(listTasks(a, { includeDone: true, includeArchived: true })).toHaveLength(1);
    expect(listReports(a, taskId)).toHaveLength(1);
    expect(unarchiveTask(a, taskId, 3, ACTOR, 6)).toBe(true);
    expect(getTask(a, taskId)).toMatchObject({ status: 'done', version: 4, archivedAt: null });
    expect(listTasks(a, { includeDone: true })).toHaveLength(1);
  });
  it('edits to an awaiting task re-issue a review slot for the new version', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    expect(requestCompletion(a, taskId, 1, MEMBER_ACTOR, 3)).toBe(true);
    const edit = {
      title: 'Edited',
      assignmentKind: 'team' as const,
      dueAt: 4000,
      timezone: 'America/Vancouver',
      destinationId: '444444444444444444',
    };
    expect(updateTask(a, taskId, 2, edit, ACTOR, 4)).toBe('ok');
    expect(getTask(a, taskId)).toMatchObject({ status: 'awaiting_approval', version: 3 });
    const review = listSlots(a).filter((s) => s.slotId === `review:${taskId}:3`);
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ kind: 'review', dueAt: 4 });
    expect(JSON.parse(review[0]!.payload!)).toMatchObject({ version: 3 });
    expect(approveTask(a, taskId, 3, ACTOR, 5)).toBe(true);
    const second = seedTask(teamId, { title: 'Second' }, a, 6);
    expect(requestCompletion(a, second, 1, MEMBER_ACTOR, 7)).toBe(true);
    expect(
      changeChild(a, second, 2, { kind: 'add', title: 'Step', dueAt: 2000 }, ACTOR, 8),
    ).toMatchObject({ version: 3 });
    expect(listSlots(a).filter((s) => s.slotId === `review:${second}:3`)).toHaveLength(1);
    expect(approveTask(a, second, 3, ACTOR, 9)).toBe(true);
    expect(getTask(a, second)).toMatchObject({ status: 'done' });
  });
  it('re-issued review slots credit the original requester, not the editor', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    expect(requestCompletion(a, taskId, 1, MEMBER_ACTOR, 3)).toBe(true);
    const edit = {
      title: 'Edited',
      assignmentKind: 'team' as const,
      dueAt: 4000,
      timezone: 'America/Vancouver',
      destinationId: '444444444444444444',
    };
    expect(updateTask(a, taskId, 2, edit, ACTOR, 4)).toBe('ok');
    const reissued = listSlots(a).filter((s) => s.slotId === `review:${taskId}:3`);
    expect(reissued).toHaveLength(1);
    expect(JSON.parse(reissued[0]!.payload!)).toEqual({
      version: 3,
      requestedBy: '444444444444444444',
    });
    expect(
      changeChild(a, taskId, 3, { kind: 'add', title: 'Step', dueAt: 2000 }, ACTOR, 5),
    ).toMatchObject({ version: 4 });
    const reissuedChild = listSlots(a).filter((s) => s.slotId === `review:${taskId}:4`);
    expect(reissuedChild).toHaveLength(1);
    expect(JSON.parse(reissuedChild[0]!.payload!)).toEqual({
      version: 4,
      requestedBy: '444444444444444444',
    });
  });
  it('deleteTask removes the task and everything under it, with CAS and a title-only audit', () => {
    const teamId = seedTeam();
    const one = '444444444444444444';
    const taskId = createTask(
      a,
      {
        teamId,
        title: 'Gone',
        description: 'secret description text',
        assignmentKind: 'individual',
        assigneeIds: [one],
        dueAt: 3000,
        timezone: 'America/Vancouver',
        destinationId: '444444444444444444',
        createdBy: 'owner',
      },
      ACTOR,
      2,
    );
    expect(
      changeChild(a, taskId, 1, { kind: 'add', title: 'Step', dueAt: 2000 }, ACTOR, 3),
    ).toMatchObject({ version: 2 });
    expect(
      recordReport(a, taskId, '666666666666666666', one, 'secret progress body', ACTOR, 4),
    ).toBe('recorded');
    expect(recordTaskAnchor(a, taskId, '444444444444444444', '888888888888888888', 5)).toBe(
      'recorded',
    );
    expect(requestCompletion(a, taskId, 3, MEMBER_ACTOR, 6)).toBe(true);
    db.raw
      .prepare('INSERT INTO task_nudge_slot_tasks (guild_id, slot_id, task_id) VALUES (?,?,?)')
      .run(A, `review:${taskId}:4`, taskId);
    const otherTeam = seedTeam(b, '555555555555555555');
    const otherTask = seedTask(otherTeam, { title: 'Stays' }, b, 7);
    expect(deleteTask(b, taskId, 4, ACTOR, 10)).toBe('missing');
    expect(deleteTask(a, taskId, 3, ACTOR, 10)).toBe('stale');
    expect(deleteTask(a, '00000000-0000-0000-0000-000000000000', 1, ACTOR, 10)).toBe('missing');
    expect(deleteTask(a, taskId, 4, ACTOR, 10)).toBe('ok');
    expect(getTask(a, taskId)).toBeUndefined();
    expect(listChildren(a, taskId)).toHaveLength(0);
    expect(listReports(a, taskId)).toHaveLength(0);
    expect(listTaskAssignees(a, taskId)).toHaveLength(0);
    expect(taskForAnchor(a, '444444444444444444', '888888888888888888')).toBeUndefined();
    expect(listSlots(a).filter((s) => s.taskId === taskId)).toHaveLength(0);
    expect(
      db.raw
        .prepare('SELECT task_id FROM task_nudge_slot_tasks WHERE guild_id = ? AND task_id = ?')
        .get(A, taskId),
    ).toBeUndefined();
    const audit = tailAudit(a).filter((row) => row.action === 'task.deleted');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ subjectId: taskId });
    expect(JSON.stringify(audit)).not.toMatch(/secret description|secret progress/);
    expect(JSON.parse(audit[0]!.before!)).toMatchObject({ title: 'Gone' });
    expect(deleteTask(a, taskId, 4, ACTOR, 11)).toBe('missing');
    expect(getTask(b, otherTask)).toMatchObject({ title: 'Stays' });
    expect(listTasks(b)).toHaveLength(1);
    expect(tailAudit(b).filter((row) => row.action === 'task.deleted')).toHaveLength(0);
  });
  it('deleteReport removes exactly one report and audits bodyChars only', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    expect(deleteReport(b, taskId, '111111111111111111', ACTOR, 3)).toBe('missing');
    expect(
      recordReport(
        a,
        taskId,
        '111111111111111111',
        '444444444444444444',
        'first secret body',
        ACTOR,
        3,
      ),
    ).toBe('recorded');
    expect(
      recordReport(a, taskId, '222222222222222222', '444444444444444444', 'second', ACTOR, 4),
    ).toBe('recorded');
    expect(deleteReport(a, taskId, '999999999999999999', ACTOR, 5)).toBe('missing');
    expect(deleteReport(a, taskId, '111111111111111111', ACTOR, 5)).toBe('ok');
    expect(listReports(a, taskId).map((r) => r.reportId)).toEqual(['222222222222222222']);
    const audit = tailAudit(a).filter((row) => row.action === 'task.report_deleted');
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('first secret body');
    expect(JSON.parse(audit[0]!.after!)).toMatchObject({
      reportId: '111111111111111111',
      bodyChars: 'first secret body'.length,
    });
    expect(getTask(a, taskId)).toBeDefined();
  });
  it('recordReport dedupes, advances not_started, and never audits the body', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    const msg = '888888888888888888';
    expect(recordReport(b, taskId, msg, '555555555555555555', 'Private update', ACTOR, 3)).toBe(
      'not-open',
    );
    expect(recordReport(a, taskId, msg, '555555555555555555', 'Private update', ACTOR, 3)).toBe(
      'recorded',
    );
    expect(recordReport(a, taskId, msg, '555555555555555555', 'Duplicate', ACTOR, 4)).toBe(
      'duplicate',
    );
    expect(listReports(a, taskId)).toMatchObject([{ reportId: msg, body: 'Private update' }]);
    expect(getTask(a, taskId)).toMatchObject({ status: 'in_progress', version: 2 });
    const audit = tailAudit(a).filter((row) => row.action === 'task.report_recorded');
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('Private update');
    expect(JSON.stringify(audit)).not.toContain('Duplicate');
    expect(JSON.parse(audit[0]!.after!)).toMatchObject({
      reportId: msg,
      authorId: '555555555555555555',
      bodyChars: 'Private update'.length,
      statusChanged: true,
    });
    const second = seedTask(teamId, { title: 'Second' }, a, 5);
    expect(requestCompletion(a, second, 1, MEMBER_ACTOR, 6)).toBe(true);
    expect(rejectTask(a, second, 2, ACTOR, 7)).toBe(true);
    expect(
      recordReport(a, second, '999999999999999999', '555555555555555555', 'More', ACTOR, 8),
    ).toBe('recorded');
    expect(getTask(a, second)).toMatchObject({ status: 'in_progress', version: 3 });
    const secondAudit = tailAudit(a).filter((row) => row.action === 'task.report_recorded')[0]!;
    expect(JSON.parse(secondAudit.after!)).toMatchObject({ statusChanged: false });
    expect(requestCompletion(a, second, 3, MEMBER_ACTOR, 9)).toBe(true);
    expect(approveTask(a, second, 4, ACTOR, 10)).toBe(true);
    expect(
      recordReport(a, second, '777777777777777777', '555555555555555555', 'Late', ACTOR, 11),
    ).toBe('not-open');
  });
  it('rejectTask works only from awaiting_approval and returns to in_progress', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    expect(rejectTask(a, taskId, 1, ACTOR, 3)).toBe(false);
    expect(getTask(a, taskId)).toMatchObject({ status: 'not_started', version: 1 });
    expect(requestCompletion(a, taskId, 1, MEMBER_ACTOR, 3)).toBe(true);
    expect(rejectTask(b, taskId, 2, ACTOR, 4)).toBe(false);
    expect(rejectTask(a, taskId, 2, ACTOR, 4)).toBe(true);
    expect(getTask(a, taskId)).toMatchObject({ status: 'in_progress', version: 3 });
    expect(rejectTask(a, taskId, 3, ACTOR, 5)).toBe(false);
  });
  it('setStatus reopens a done task but fails on an archived task', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    expect(requestCompletion(a, taskId, 1, MEMBER_ACTOR, 3)).toBe(true);
    expect(approveTask(a, taskId, 2, ACTOR, 4)).toBe(true);
    expect(listTasks(a)).toHaveLength(0);
    expect(unarchiveTask(a, taskId, 3, ACTOR, 5)).toBe(true);
    expect(setStatus(a, taskId, 4, 'in_progress', ACTOR, 6)).toBe(true);
    const reopened = getTask(a, taskId)!;
    expect(reopened).toMatchObject({ status: 'in_progress', version: 5 });
    const audit = tailAudit(a).filter((row) => row.action === 'task.status_set')[0]!;
    expect(JSON.parse(audit.before!)).toMatchObject({ status: 'done' });
    expect(JSON.parse(audit.after!)).toMatchObject({ status: 'in_progress' });
    expect(archiveTask(a, taskId, 5, ACTOR, 7)).toBe(true);
    expect(setStatus(a, taskId, 6, 'in_progress', ACTOR, 8)).toBe(false);
    expect(setStatus(a, taskId, 6, 'not_started', ACTOR, 8)).toBe(false);
  });
  it('archiveTask hides a task until unarchiveTask restores it', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    expect(archiveTask(b, taskId, 1, ACTOR, 3)).toBe(false);
    expect(archiveTask(a, taskId, 1, ACTOR, 3)).toBe(true);
    expect(listTasks(a)).toHaveLength(0);
    expect(listTasks(a, { includeArchived: true })).toHaveLength(1);
    expect(unarchiveTask(b, taskId, 2, ACTOR, 4)).toBe(false);
    expect(unarchiveTask(a, taskId, 2, ACTOR, 4)).toBe(true);
    expect(listTasks(a)).toHaveLength(1);
  });
  it('listTasks excludes done by default, includes it on request, ordered by dueAt', () => {
    const teamId = seedTeam();
    const late = seedTask(teamId, { title: 'Late', dueAt: 5000 }, a, 2);
    const early = seedTask(teamId, { title: 'Early', dueAt: 1000 }, a, 2);
    expect(listTasks(a).map((t) => t.taskId)).toEqual([early, late]);
    expect(requestCompletion(a, early, 1, MEMBER_ACTOR, 3)).toBe(true);
    expect(approveTask(a, early, 2, ACTOR, 4)).toBe(true);
    expect(listTasks(a).map((t) => t.taskId)).toEqual([late]);
    expect(listTasks(a, { includeDone: true }).map((t) => t.taskId)).toEqual([late]);
    expect(listTasks(a, { includeDone: true, includeArchived: true }).map((t) => t.taskId)).toEqual(
      [early, late],
    );
    expect(listTasks(a, { teamId }).map((t) => t.taskId)).toEqual([late]);
  });
  it('updateTask returns anchored-destination on a stranded move and stale on a version miss', () => {
    const teamId = seedTeam();
    const destinationId = '444444444444444444';
    const taskId = seedTask(teamId);
    expect(recordTaskAnchor(a, taskId, destinationId, '888888888888888888', 3)).toBe('recorded');
    const edit = {
      title: 'Edited',
      assignmentKind: 'team' as const,
      dueAt: 4000,
      timezone: 'America/Vancouver',
      destinationId,
    };
    expect(
      updateTask(a, taskId, 1, { ...edit, destinationId: '555555555555555555' }, ACTOR, 4),
    ).toBe('anchored-destination');
    expect(getTask(a, taskId)).toMatchObject({ version: 1, destinationId });
    expect(updateTask(b, taskId, 1, edit, ACTOR, 4)).toBe('stale');
    expect(updateTask(a, taskId, 1, edit, ACTOR, 4)).toBe('ok');
    expect(updateTask(a, taskId, 1, { ...edit, title: 'Stale' }, ACTOR, 5)).toBe('stale');
    expect(getTask(a, taskId)).toMatchObject({ title: 'Edited', version: 2 });
  });
  it('updateTask audits the full assignee list, not just the first', () => {
    const teamId = seedTeam();
    const one = '444444444444444444';
    const two = '555555555555555555';
    const id = seedTask(teamId, { assignmentKind: 'individual', assigneeIds: [one, two] }, a, 2);
    expect(
      updateTask(
        a,
        id,
        1,
        {
          title: 'Updated',
          assignmentKind: 'individual',
          assigneeIds: [two],
          dueAt: 4000,
          timezone: 'America/Vancouver',
          destinationId: '444444444444444444',
        },
        ACTOR,
        3,
      ),
    ).toBe('ok');
    const audit = tailAudit(a).filter((row) => row.action === 'task.edited')[0]!;
    const before = JSON.parse(audit.before!) as { assigneeIds: string[] };
    const after = JSON.parse(audit.after!) as { assigneeIds: string[] };
    expect(before.assigneeIds.sort()).toEqual([one, two]);
    expect(after.assigneeIds).toEqual([two]);
  });
  it('createTeam rejects a reused category in-guild but allows it cross-guild', () => {
    seedTeam(a, '333333333333333333');
    expect(() =>
      createTeam(a, { name: 'Dupe', categoryId: '333333333333333333', kind: 'exec' }, ACTOR, 2),
    ).toThrow('category-in-use');
    expect(listTasks(a)).toHaveLength(0);
    const other = createTeam(
      b,
      { name: 'Same category', categoryId: '333333333333333333', kind: 'subteam' },
      ACTOR,
      2,
    );
    expect(typeof other).toBe('string');
  });
  it('deleteTeam reports has-tasks, deleted and not-found', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    expect(deleteTeam(a, teamId, ACTOR, 3)).toBe('has-tasks');
    expect(archiveTask(a, taskId, 1, ACTOR, 4)).toBe(true);
    expect(deleteTeam(a, teamId, ACTOR, 5)).toBe('has-tasks');
    const empty = createTeam(
      a,
      { name: 'Empty', categoryId: '555555555555555555', kind: 'exec' },
      ACTOR,
      6,
    );
    expect(deleteTeam(a, empty, ACTOR, 7)).toBe('deleted');
    expect(deleteTeam(a, empty, ACTOR, 8)).toBe('not-found');
    expect(deleteTeam(a, '00000000-0000-0000-0000-000000000000', ACTOR, 8)).toBe('not-found');
  });
  it('changeChild audits with the passed actor', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    const mcpActor = { actorType: 'mcp_operator', actorId: 'owner', via: 'http' } as const;
    expect(
      changeChild(a, taskId, 1, { kind: 'add', title: 'Step', dueAt: 2000 }, mcpActor, 3),
    ).toMatchObject({ version: 2 });
    expect(tailAudit(a)[0]).toMatchObject({
      actorType: 'mcp_operator',
      action: 'task.child_add',
    });
  });
  it('cross-guild approve, reject, archive, report and edit change nothing', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    expect(requestCompletion(a, taskId, 1, MEMBER_ACTOR, 3)).toBe(true);
    expect(approveTask(b, taskId, 2, ACTOR, 4)).toBe(false);
    expect(rejectTask(b, taskId, 2, ACTOR, 4)).toBe(false);
    expect(archiveTask(b, taskId, 2, ACTOR, 4)).toBe(false);
    expect(recordReport(b, taskId, '666666666666666666', '444444444444444444', 'x', ACTOR, 4)).toBe(
      'not-open',
    );
    expect(
      updateTask(
        b,
        taskId,
        2,
        {
          title: 'Cross',
          assignmentKind: 'team',
          dueAt: 4000,
          timezone: 'America/Vancouver',
          destinationId: '444444444444444444',
        },
        ACTOR,
        4,
      ),
    ).toBe('stale');
    expect(getTask(a, taskId)).toMatchObject({ status: 'awaiting_approval', version: 2 });
    expect(tailAudit(b)).toHaveLength(0);
  });
  it('normalizeAssignees enforces the assignment rules', () => {
    expect(normalizeAssignees({ assignmentKind: 'team' })).toEqual([]);
    expect(
      normalizeAssignees({
        assignmentKind: 'individual',
        assigneeId: '444444444444444444',
        assigneeIds: ['444444444444444444'],
      }),
    ).toEqual(['444444444444444444']);
    expect(() =>
      normalizeAssignees({ assignmentKind: 'team', assigneeIds: ['444444444444444444'] }),
    ).toThrow('invalid-task-assignees');
    expect(() => normalizeAssignees({ assignmentKind: 'individual' })).toThrow(
      'invalid-task-assignees',
    );
  });
  it('audits task writes without title or report bodies', () => {
    const teamId = createTeam(
      a,
      { name: 'Engine', categoryId: '333333333333333333', kind: 'subteam' },
      ACTOR,
      1,
    );
    const taskId = createTask(
      a,
      {
        teamId,
        title: 'Sensitive @everyone title',
        description: 'sensitive description text',
        assignmentKind: 'team',
        dueAt: 20000,
        timezone: 'America/Vancouver',
        destinationId: '444444444444444444',
        createdBy: 'owner',
      },
      ACTOR,
      2,
    );
    recordReport(a, taskId, '666666666666666666', 'owner', 'private progress body', ACTOR, 3);
    expect(listReports(a, taskId)).toHaveLength(1);
    expect(getTask(b, taskId)).toBeUndefined();
    expect(JSON.stringify(tailAudit(a))).not.toMatch(
      /Sensitive|private child|private progress|sensitive description/,
    );
    expect(tailAudit(b)).toHaveLength(0);
  });
  it('keeps quiet-hour config inside its guild partition', () => {
    expect(DEFAULT_QUIET_HOURS).toMatchObject({ startMinute: 0, endMinute: 480 });
    setQuietHours(a, { startMinute: 0, endMinute: 480, timezone: 'America/Los_Angeles' }, ACTOR, 1);
    expect(getQuietHours(a)).toMatchObject({ startMinute: 0, endMinute: 480 });
    expect(getQuietHours(b)).toBeUndefined();
    expect(tailAudit(a)[0]).toMatchObject({ action: 'task.quiet_hours_configured' });
    expect(tailAudit(b)).toHaveLength(0);
  });
});

describe('task partitions', () => {
  it('keeps tasks and optional children inside their guild', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    expect(listTasks(a)).toHaveLength(1);
    expect(listTasks(b)).toHaveLength(0);
    expect(listChildren(a, taskId)).toHaveLength(0);
    const childId = changeChild(
      a,
      taskId,
      1,
      { kind: 'add', title: 'Take measurements', dueAt: 2000 },
      ACTOR,
      3,
    )?.childId;
    expect(listChildren(a, taskId)).toHaveLength(1);
    expect(listChildren(b, taskId)).toHaveLength(0);
    expect(
      changeChild(b, taskId, 2, { kind: 'complete', childId: childId! }, ACTOR, 4),
    ).toBeUndefined();
    expect(
      changeChild(a, taskId, 2, { kind: 'complete', childId: childId! }, ACTOR, 4),
    ).toMatchObject({ version: 3 });
    expect(listChildren(a, taskId)[0]?.status).toBe('done');
  });
  it('serialises concurrent child writes against the same parent version', async () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    const contenders = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() =>
          changeChild(a, taskId, 1, { kind: 'add', title: `Step ${i}`, dueAt: 2000 }, ACTOR, 3),
        ),
      ),
    );
    expect(contenders.filter(Boolean)).toHaveLength(1);
    expect(listChildren(a, taskId)).toHaveLength(1);
    expect(getTask(a, taskId)?.version).toBe(2);
    expect(tailAudit(a).filter((row) => row.action.startsWith('task.child_'))).toHaveLength(1);
  });
  it('versions and audits child add/edit/delete, blocking stale and cross-guild writes', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    const created = changeChild(
      a,
      taskId,
      1,
      { kind: 'add', title: 'Step', dueAt: 2000 },
      ACTOR,
      3,
    );
    expect(created).toMatchObject({ version: 2 });
    const id = created!.childId;
    expect(
      changeChild(
        a,
        taskId,
        1,
        { kind: 'edit', childId: id, title: 'Wrong', dueAt: 2500 },
        ACTOR,
        4,
      ),
    ).toBeUndefined();
    expect(changeChild(b, taskId, 2, { kind: 'delete', childId: id }, ACTOR, 4)).toBeUndefined();
    expect(
      changeChild(a, taskId, 2, { kind: 'edit', childId: id, title: 'New', dueAt: 2500 }, ACTOR, 4),
    ).toMatchObject({ version: 3 });
    expect(listChildren(a, taskId)[0]).toMatchObject({ title: 'New', dueAt: 2500 });
    expect(changeChild(a, taskId, 3, { kind: 'delete', childId: id }, ACTOR, 5)).toMatchObject({
      version: 4,
    });
    expect(listChildren(a, taskId)).toHaveLength(0);
    expect(changeChild(a, taskId, 4, { kind: 'delete', childId: id }, ACTOR, 6)).toBeUndefined();
    expect(tailAudit(a).filter((row) => row.action.startsWith('task.child_'))).toHaveLength(3);
    expect(tailAudit(b).filter((row) => row.action.startsWith('task.child_'))).toHaveLength(0);
  });
  it('pins an anchor per task, channel and guild without repointing it on retry', () => {
    const teamId = seedTeam();
    const channelId = '444444444444444444';
    const taskId = seedTask(teamId);
    const msg = '888888888888888888';
    expect(recordTaskAnchor(b, taskId, channelId, msg, 3)).toBe('conflict');
    expect(recordTaskAnchor(a, taskId, '555555555555555555', msg, 3)).toBe('conflict');
    expect(recordTaskAnchor(a, taskId, channelId, msg, 3)).toBe('recorded');
    expect(recordTaskAnchor(a, taskId, channelId, msg, 4)).toBe('already-recorded');
    expect(recordTaskAnchor(a, taskId, channelId, '999999999999999999', 4)).toBe('conflict');
    expect(taskForAnchor(a, channelId, msg)).toBe(taskId);
    expect(taskForAnchor(b, channelId, msg)).toBeUndefined();
    expect(taskForAnchor(a, '555555555555555555', msg)).toBeUndefined();
  });
  it('keeps multi-assignees guild-scoped, replacing them only after a winning CAS', () => {
    const teamId = seedTeam();
    const one = '444444444444444444';
    const two = '555555555555555555';
    const id = seedTask(teamId, { assignmentKind: 'individual', assigneeIds: [one, two] }, a, 2);
    expect(getTask(a, id)?.assigneeId).toBe(one);
    expect(listTaskAssignees(a, id).sort()).toEqual([one, two]);
    expect(isTaskAssignee(b, id, one)).toBe(false);
    const edit = {
      title: 'Updated',
      assignmentKind: 'individual' as const,
      assigneeIds: [two],
      dueAt: 4000,
      timezone: 'America/Vancouver',
      destinationId: '666666666666666666',
    };
    expect(updateTask(a, id, 2, edit, ACTOR, 3)).toBe('stale');
    expect(listTaskAssignees(a, id).sort()).toEqual([one, two]);
    expect(updateTask(a, id, 1, edit, ACTOR, 3)).toBe('ok');
    expect(listTaskAssignees(a, id)).toEqual([two]);
    expect(isTaskAssignee(a, id, one)).toBe(false);
    expect(isTaskAssignee(a, id, two)).toBe(true);
    expect(getTask(a, id)).toMatchObject({ assigneeId: two, version: 2 });
  });
  it('requests approval once and rejects cross-guild and stale transitions', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    expect(requestCompletion(b, taskId, 1, MEMBER_ACTOR, 3)).toBe(false);
    expect(requestCompletion(a, taskId, 1, MEMBER_ACTOR, 3)).toBe(true);
    expect(getTask(a, taskId)).toMatchObject({ status: 'awaiting_approval', version: 2 });
    const audit = tailAudit(a);
    expect(audit.filter((row) => row.action === 'task.completion_requested')).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: 'member',
      actorId: '444444444444444444',
      subjectId: taskId,
    });
    expect(audit[0]?.before).toBe(JSON.stringify({ status: 'not_started', version: 1 }));
    expect(requestCompletion(a, taskId, 1, MEMBER_ACTOR, 4)).toBe(false);
    expect(requestCompletion(a, taskId, 2, MEMBER_ACTOR, 5)).toBe(false);
    expect(tailAudit(a).filter((row) => row.action === 'task.completion_requested')).toHaveLength(
      1,
    );
    expect(tailAudit(b).filter((row) => row.action === 'task.completion_requested')).toHaveLength(
      0,
    );
  });
});

describe('approval transition', () => {
  it('only approves awaiting tasks at the expected version, once and within the guild', () => {
    const teamId = seedTeam();
    const id = seedTask(teamId, { title: 'Measure body' }, a, 2);
    expect(approveTask(a, id, 1, ACTOR, 3)).toBe(false);
    expect(requestCompletion(a, id, 1, MEMBER_ACTOR, 3)).toBe(true);
    expect(approveTask(b, id, 2, ACTOR, 4)).toBe(false);
    expect(approveTask(a, id, 1, ACTOR, 4)).toBe(false);
    expect(approveTask(a, id, 2, ACTOR, 4)).toBe(true);
    expect(getTask(a, id)).toMatchObject({ status: 'done', version: 3 });
    expect(getTask(a, id)!.archivedAt).toBe(4);
    expect(approveTask(a, id, 2, ACTOR, 5)).toBe(false);
    expect(tailAudit(a).filter((row) => row.action === 'task.approved')).toHaveLength(1);
    expect(tailAudit(b).filter((row) => row.action === 'task.approved')).toHaveLength(0);
  });
});

describe('direct completion (ADR 0138)', () => {
  it('completes a working task at the expected version, once and within the guild', () => {
    const teamId = seedTeam();
    const id = seedTask(teamId, { title: 'Measure body' }, a, 2);
    expect(completeTask(b, id, 1, ACTOR, 3)).toBe(false);
    expect(completeTask(a, id, 2, ACTOR, 3)).toBe(false);
    expect(completeTask(a, id, 1, ACTOR, 3)).toBe(true);
    expect(getTask(a, id)).toMatchObject({ status: 'done', version: 2, archivedAt: 3 });
    expect(completeTask(a, id, 1, ACTOR, 4)).toBe(false);
    expect(completeTask(a, id, 2, ACTOR, 4)).toBe(false);
    const rows = tailAudit(a).filter((row) => row.action === 'task.completed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'dashboard', actorId: 'owner' });
    expect(tailAudit(b).filter((row) => row.action === 'task.completed')).toHaveLength(0);
  });

  it('completes from in progress, but leaves an awaiting task to approval', () => {
    const teamId = seedTeam();
    const working = seedTask(teamId, {}, a, 2);
    expect(setStatus(a, working, 1, 'in_progress', ACTOR, 3)).toBe(true);
    expect(completeTask(a, working, 2, ACTOR, 4)).toBe(true);
    expect(getTask(a, working)).toMatchObject({ status: 'done' });

    const awaiting = seedTask(teamId, {}, a, 5);
    expect(requestCompletion(a, awaiting, 1, MEMBER_ACTOR, 6)).toBe(true);
    expect(completeTask(a, awaiting, 2, ACTOR, 7)).toBe(false);
    expect(getTask(a, awaiting)).toMatchObject({ status: 'awaiting_approval', archivedAt: null });
  });
});

describe('task tracking migration', () => {
  it('drops task_account_bindings', () => {
    expect(
      db.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='task_account_bindings'",
        )
        .get(),
    ).toBeUndefined();
  });
  it('widens nudge slot kinds and stores a payload', () => {
    db.raw
      .prepare(
        'INSERT INTO task_nudge_slots (guild_id, slot_id, kind, due_at, state, payload, updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(A, 'slot-review', 'review', 1000, 'pending', '{"version":2}', 1000);
    expect(
      db.raw
        .prepare('SELECT payload FROM task_nudge_slots WHERE guild_id = ? AND slot_id = ?')
        .get(A, 'slot-review'),
    ).toMatchObject({ payload: '{"version":2}' });
    db.raw
      .prepare(
        'INSERT INTO task_nudge_slots (guild_id, slot_id, kind, due_at, state, payload, updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(A, 'slot-evaluate', 'evaluate', 1000, 'pending', '{"taskId":"t"}', 1000);
    expect(
      db.raw
        .prepare('SELECT kind FROM task_nudge_slots WHERE guild_id = ? AND slot_id = ?')
        .get(A, 'slot-evaluate'),
    ).toMatchObject({ kind: 'evaluate' });
    expect(() =>
      db.raw
        .prepare(
          'INSERT INTO task_nudge_slots (guild_id, slot_id, kind, due_at, state, updated_at) VALUES (?,?,?,?,?,?)',
        )
        .run(A, 'slot-bogus', 'bogus', 1000, 'pending', 1000),
    ).toThrow(/CHECK constraint failed/);
  });
  it('records an optional team member role', () => {
    db.raw
      .prepare(
        'INSERT INTO task_teams (guild_id, team_id, name, category_id, member_role_id, kind, created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(A, 'team-one', 'Tech', '333333333333333333', '222222222222222222', 'subteam', 1);
    expect(
      db.raw
        .prepare('SELECT member_role_id FROM task_teams WHERE guild_id = ? AND team_id = ?')
        .get(A, 'team-one'),
    ).toMatchObject({ member_role_id: '222222222222222222' });
    expect(() =>
      db.raw
        .prepare(
          'INSERT INTO task_teams (guild_id, team_id, name, category_id, member_role_id, kind, created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(A, 'team-two', 'Exec', '444444444444444444', 'abc', 'exec', 1),
    ).toThrow(/CHECK constraint failed/);
  });
  it('refuses a reply choice with a non-snowflake author', () => {
    expect(() =>
      db.raw
        .prepare(
          'INSERT INTO task_reply_choices (guild_id, message_id, author_id, channel_id, body, created_at) VALUES (?,?,?,?,?,?)',
        )
        .run(A, '555555555555555555', 'abc', '666666666666666666', 'done', 1),
    ).toThrow(/CHECK constraint failed/);
  });
  it('cascades slot task rows when their slot is deleted', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId, { title: 'Cascade' }, a, 2);
    db.raw
      .prepare(
        'INSERT INTO task_nudge_slots (guild_id, slot_id, kind, due_at, state, updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run(A, 'slot-cascade', 'checkin', 3000, 'pending', 2);
    db.raw
      .prepare('INSERT INTO task_nudge_slot_tasks (guild_id, slot_id, task_id) VALUES (?,?,?)')
      .run(A, 'slot-cascade', taskId);
    expect(
      db.raw
        .prepare('SELECT task_id FROM task_nudge_slot_tasks WHERE guild_id = ? AND slot_id = ?')
        .get(A, 'slot-cascade'),
    ).toMatchObject({ task_id: taskId });
    db.raw
      .prepare('DELETE FROM task_nudge_slots WHERE guild_id = ? AND slot_id = ?')
      .run(A, 'slot-cascade');
    expect(
      db.raw
        .prepare('SELECT task_id FROM task_nudge_slot_tasks WHERE guild_id = ? AND slot_id = ?')
        .get(A, 'slot-cascade'),
    ).toBeUndefined();
  });
});

describe('task links (ADR 0140)', () => {
  it('stores links in order on create and returns them', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId, {
      links: [
        { label: 'Wiring diagram', url: 'https://drive.example/a.pdf' },
        { label: 'BOM sheet', url: 'https://docs.example/bom' },
      ],
    });
    expect(listTaskLinks(a, taskId)).toEqual([
      { label: 'Wiring diagram', url: 'https://drive.example/a.pdf' },
      { label: 'BOM sheet', url: 'https://docs.example/bom' },
    ]);
  });

  it('replaces links on edit when given, keeps them when omitted, clears them with []', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId, { links: [{ label: 'One', url: 'https://one.example' }] });
    const base = {
      title: 'Project',
      assignmentKind: 'team' as const,
      dueAt: 3000,
      timezone: 'America/Vancouver',
      destinationId: '444444444444444444',
    };
    expect(updateTask(a, taskId, 1, base, ACTOR, 5)).toBe('ok');
    expect(listTaskLinks(a, taskId)).toEqual([{ label: 'One', url: 'https://one.example' }]);
    expect(
      updateTask(
        a,
        taskId,
        2,
        { ...base, links: [{ label: 'Two', url: 'https://two.example' }] },
        ACTOR,
        6,
      ),
    ).toBe('ok');
    expect(listTaskLinks(a, taskId)).toEqual([{ label: 'Two', url: 'https://two.example' }]);
    expect(updateTask(a, taskId, 3, { ...base, links: [] }, ACTOR, 7)).toBe('ok');
    expect(listTaskLinks(a, taskId)).toEqual([]);
  });

  it('never returns another guild’s links', () => {
    const teamA = seedTeam(a);
    const taskA = seedTask(teamA, { links: [{ label: 'A', url: 'https://a.example' }] }, a);
    expect(listTaskLinks(b, taskA)).toEqual([]);
  });

  it('the database refuses an http link and a sixth link', () => {
    const teamId = seedTeam();
    expect(() =>
      seedTask(teamId, { links: [{ label: 'x', url: 'http://plain.example' }] }),
    ).toThrow();
    const six = Array.from({ length: 6 }, (_, i) => ({
      label: `L${i}`,
      url: `https://x.example/${i}`,
    }));
    expect(() => seedTask(teamId, { links: six })).toThrow();
  });

  it('deleting the task deletes its links', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId, { links: [{ label: 'x', url: 'https://x.example' }] });
    deleteTask(a, taskId, 1, ACTOR, 9);
    expect(listTaskLinks(a, taskId)).toEqual([]);
  });
});

describe('task card render state (ADR 0140)', () => {
  const CHANNEL = '444444444444444444';
  const MESSAGE = '555555555555555555';
  const anchorTask = () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    expect(recordTaskAnchor(a, taskId, CHANNEL, MESSAGE, 3)).toBe('recorded');
    return taskId;
  };

  it('a new anchor is stale until marked rendered at the current version', () => {
    const taskId = anchorTask();
    expect(staleTaskCards(a, 10)).toMatchObject([
      { taskId, channelId: CHANNEL, messageId: MESSAGE, version: 1 },
    ]);
    markCardRendered(a, taskId, 1, 4);
    expect(staleTaskCards(a, 10)).toEqual([]);
    expect(anchorFor(a, taskId)).toEqual({ channelId: CHANNEL, messageId: MESSAGE });
  });

  it('deleting a report makes the anchored card stale so the deleted update is refreshed away', () => {
    const taskId = anchorTask();
    expect(recordReport(a, taskId, 'r1', CHANNEL, 'did it', MEMBER_ACTOR, 5)).toBe('recorded');
    const shown = getTask(a, taskId)!.version;
    markCardRendered(a, taskId, shown, 6);
    expect(staleTaskCards(a, 10)).toEqual([]);
    expect(deleteReport(a, taskId, 'r1', ACTOR, 7)).toBe('ok');
    expect(listReports(a, taskId)).toEqual([]);
    expect(getTask(a, taskId)!.version).toBe(shown + 1);
    expect(staleTaskCards(a, 10)).toMatchObject([
      { taskId, channelId: CHANNEL, messageId: MESSAGE, version: shown + 1 },
    ]);
    markCardRendered(a, taskId, shown + 1, 8);
    expect(staleTaskCards(a, 10)).toEqual([]);
  });

  it('deleting a report while awaiting approval keeps the posted review approvable', () => {
    const taskId = anchorTask();
    expect(setStatus(a, taskId, 1, 'in_progress', MEMBER_ACTOR, 4)).toBe(true);
    expect(recordReport(a, taskId, 'r1', CHANNEL, 'did it', MEMBER_ACTOR, 5)).toBe('recorded');
    const shown = getTask(a, taskId)!.version;
    expect(requestCompletion(a, taskId, shown, MEMBER_ACTOR, 6)).toBe(true);
    const reviewVersion = getTask(a, taskId)!.version;
    expect(getTask(a, taskId)!.status).toBe('awaiting_approval');
    markCardRendered(a, taskId, reviewVersion, 7);
    expect(staleTaskCards(a, 10)).toEqual([]);
    expect(deleteReport(a, taskId, 'r1', ACTOR, 8)).toBe('ok');
    expect(listReports(a, taskId)).toEqual([]);
    // No version bump: the already-posted review card's buttons still match.
    expect(getTask(a, taskId)!.version).toBe(reviewVersion);
    expect(getTask(a, taskId)!.status).toBe('awaiting_approval');
    // The anchored card is still refreshed, so the deleted update disappears.
    expect(staleTaskCards(a, 10)).toMatchObject([
      { taskId, channelId: CHANNEL, messageId: MESSAGE, version: reviewVersion },
    ]);
    expect(approveTask(a, taskId, reviewVersion, ACTOR, 9)).toBe(true);
    expect(getTask(a, taskId)!.status).toBe('done');
  });

  it('a render finished after an overlapping report delete cannot clear the dirty marker', () => {
    const taskId = anchorTask();
    expect(setStatus(a, taskId, 1, 'in_progress', MEMBER_ACTOR, 4)).toBe(true);
    expect(recordReport(a, taskId, 'r1', CHANNEL, 'did it', MEMBER_ACTOR, 5)).toBe('recorded');
    const shown = getTask(a, taskId)!.version;
    expect(requestCompletion(a, taskId, shown, MEMBER_ACTOR, 6)).toBe(true);
    const reviewVersion = getTask(a, taskId)!.version;
    // The card is stale from the completion request; the refresh pass picks it
    // up and awaits the Discord edit. While it awaits, the report is deleted.
    const picked = staleTaskCards(a, 10)[0]!;
    expect(picked).toMatchObject({ taskId, version: reviewVersion });
    expect(deleteReport(a, taskId, 'r1', ACTOR, 9)).toBe('ok');
    // The pre-delete render completes with the fence it was picked with: the
    // dirty marker must survive (a 4-arg mark without the fence is the bug the
    // phase re-review probed - it erases the marker and strands the card).
    markCardRendered(a, taskId, picked.version, 8, picked.updatedAt);
    expect(staleTaskCards(a, 10).map((s) => s.taskId)).toEqual([taskId]);
    // A render read after the delete carries the current fence and clears it.
    const fresh = staleTaskCards(a, 10)[0]!;
    markCardRendered(a, taskId, fresh.version, 10, fresh.updatedAt);
    expect(staleTaskCards(a, 10)).toEqual([]);
  });

  it('deleting an unknown or wrong-guild report leaves the card fresh', () => {
    const taskId = anchorTask();
    expect(recordReport(a, taskId, 'r1', CHANNEL, 'did it', MEMBER_ACTOR, 5)).toBe('recorded');
    const shown = getTask(a, taskId)!.version;
    markCardRendered(a, taskId, shown, 6);
    expect(deleteReport(a, taskId, 'nope', ACTOR, 7)).toBe('missing');
    expect(deleteReport(b, taskId, 'r1', ACTOR, 7)).toBe('missing');
    expect(listReports(a, taskId)).toHaveLength(1);
    expect(getTask(a, taskId)!.version).toBe(shown);
    expect(staleTaskCards(a, 10)).toEqual([]);
  });

  it('a failed report delete rolls back, leaving the report and the card fresh', () => {
    const taskId = anchorTask();
    expect(recordReport(a, taskId, 'r1', CHANNEL, 'did it', MEMBER_ACTOR, 5)).toBe('recorded');
    const shown = getTask(a, taskId)!.version;
    markCardRendered(a, taskId, shown, 6);
    db.raw.exec(
      `CREATE TRIGGER fail_report_delete_audit BEFORE INSERT ON audit_events
       WHEN NEW.action = 'task.report_deleted' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    expect(() => deleteReport(a, taskId, 'r1', ACTOR, 7)).toThrow();
    expect(listReports(a, taskId)).toHaveLength(1);
    expect(getTask(a, taskId)!.version).toBe(shown);
    expect(staleTaskCards(a, 10)).toEqual([]);
  });

  it('a version bump or a newer report makes the card stale again', () => {
    const taskId = anchorTask();
    markCardRendered(a, taskId, 1, 4);
    expect(setStatus(a, taskId, 1, 'in_progress', MEMBER_ACTOR, 5)).toBe(true);
    expect(staleTaskCards(a, 10).map((s) => s.version)).toEqual([2]);
    markCardRendered(a, taskId, 2, 6);
    expect(staleTaskCards(a, 10)).toEqual([]);
    expect(recordReport(a, taskId, 'r1', '444444444444444444', 'did it', MEMBER_ACTOR, 7)).toBe(
      'recorded',
    );
    expect(staleTaskCards(a, 10)).toHaveLength(1);
  });

  it('never moves rendered_version backwards', () => {
    const taskId = anchorTask();
    expect(setStatus(a, taskId, 1, 'in_progress', MEMBER_ACTOR, 5)).toBe(true);
    markCardRendered(a, taskId, 2, 6);
    markCardRendered(a, taskId, 1, 7);
    expect(staleTaskCards(a, 10)).toEqual([]);
  });

  it('skips archived tasks', () => {
    const taskId = anchorTask();
    archiveTask(a, taskId, 1, ACTOR, 5);
    expect(staleTaskCards(a, 10)).toEqual([]);
  });

  it('is scoped to the guild', () => {
    anchorTask();
    expect(staleTaskCards(b, 10)).toEqual([]);
  });

  it('reports who last picked the task up, from the audit trail', () => {
    const taskId = anchorTask();
    expect(lastPickup(a, taskId)).toBeUndefined();
    expect(setStatus(a, taskId, 1, 'in_progress', MEMBER_ACTOR, 5)).toBe(true);
    expect(lastPickup(a, taskId)).toEqual({ actorId: MEMBER_ACTOR.actorId, at: 5 });
  });

  it('a lower-version render completion is rejected wholly, including its timestamp', () => {
    const taskId = anchorTask();
    expect(setStatus(a, taskId, 1, 'in_progress', MEMBER_ACTOR, 5)).toBe(true);
    markCardRendered(a, taskId, 2, 6);
    expect(recordReport(a, taskId, 'r1', '444444444444444444', 'did it', MEMBER_ACTOR, 7)).toBe(
      'recorded',
    );
    markCardRendered(a, taskId, 1, 8);
    expect(staleTaskCards(a, 10)).toHaveLength(1);
  });

  it('rejects an obsolete render timestamp when version alone cannot make the card stale', () => {
    const taskId = anchorTask();
    expect(setStatus(a, taskId, 1, 'in_progress', MEMBER_ACTOR, 5)).toBe(true);
    markCardRendered(a, taskId, 2, 6);
    expect(recordReport(a, taskId, 'r1', CHANNEL, 'did it', MEMBER_ACTOR, 7)).toBe('recorded');
    // Adversarial fixture: even an accepted v1 would satisfy the task version.
    // Only the unseen report can make this card stale, isolating the timestamp guard.
    db.raw
      .prepare('UPDATE club_tasks SET version = 1 WHERE guild_id = ? AND task_id = ?')
      .run(A, taskId);
    expect(staleTaskCards(a, 10)).toMatchObject([
      { taskId, channelId: CHANNEL, messageId: MESSAGE, version: 1 },
    ]);
    markCardRendered(a, taskId, 1, 8);
    expect(staleTaskCards(a, 10)).toMatchObject([
      { taskId, channelId: CHANNEL, messageId: MESSAGE, version: 1 },
    ]);
  });

  it('an equal-version re-ack clears a newer report after its snapshot is rendered', () => {
    const taskId = anchorTask();
    expect(setStatus(a, taskId, 1, 'in_progress', MEMBER_ACTOR, 5)).toBe(true);
    markCardRendered(a, taskId, 2, 6);
    expect(recordReport(a, taskId, 'r1', CHANNEL, 'did it', MEMBER_ACTOR, 7)).toBe('recorded');
    expect(staleTaskCards(a, 10)).toHaveLength(1);
    markCardRendered(a, taskId, 2, 9);
    expect(staleTaskCards(a, 10)).toEqual([]);
  });

  it('an equal-version older snapshot preserves the MAX render timestamp', () => {
    const taskId = anchorTask();
    expect(setStatus(a, taskId, 1, 'in_progress', MEMBER_ACTOR, 5)).toBe(true);
    expect(recordReport(a, taskId, 'r1', CHANNEL, 'did it', MEMBER_ACTOR, 7)).toBe('recorded');
    markCardRendered(a, taskId, 2, 9);
    expect(staleTaskCards(a, 10)).toEqual([]);
    markCardRendered(a, taskId, 2, 4);
    expect(
      db.raw
        .prepare(
          'SELECT rendered_at AS renderedAt FROM task_message_anchors WHERE guild_id = ? AND task_id = ?',
        )
        .get(A, taskId),
    ).toEqual({ renderedAt: 9 });
    expect(staleTaskCards(a, 10)).toEqual([]);
  });

  it('picks the latest pickup across actors, breaking a timestamp tie by audit order', () => {
    const taskId = anchorTask();
    const other = { actorType: 'member', actorId: '555555555555555555', via: 'gateway' } as const;
    expect(setStatus(a, taskId, 1, 'in_progress', MEMBER_ACTOR, 5)).toBe(true);
    expect(setStatus(a, taskId, 2, 'not_started', ACTOR, 5)).toBe(true);
    expect(setStatus(a, taskId, 3, 'in_progress', other, 5)).toBe(true);
    expect(lastPickup(a, taskId)).toEqual({ actorId: other.actorId, at: 5 });
    expect(lastPickup(b, taskId)).toBeUndefined();
  });

  it('reports no pickup when the latest pickup has no actor', () => {
    const taskId = anchorTask();
    expect(setStatus(a, taskId, 1, 'in_progress', MEMBER_ACTOR, 5)).toBe(true);
    db.raw
      .prepare(
        `INSERT INTO audit_events (guild_id, at, actor_type, actor_id, action, subject_type, subject_id, after)
         VALUES (?, 9, 'system', NULL, 'task.status_set', 'club_task', ?, '{"status":"in_progress"}')`,
      )
      .run(A, taskId);
    expect(lastPickup(a, taskId)).toBeUndefined();
  });
});
