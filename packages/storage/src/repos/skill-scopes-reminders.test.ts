import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGuildId, reminderRecurrence, type Reminder } from '@bananasaurs/core';
import { openMigratedTestDatabase } from '../test-support.js';
import { upsertGuild } from './guilds.js';
import {
  cancelReminder,
  completeReminder,
  getReminder,
  insertDecisionDraftOnce,
  insertReminder,
  listBehaviours,
  listDecisions,
  listRemindersForCreator,
  listSkillActivity,
  listSkillGrants,
  putBehaviour,
  putSkillGrant,
  recordSkillActivity,
  rescheduleReminder,
  claimDueReminders,
  setSkillScope,
  updateReminder,
} from './assistant.js';

const A = parseGuildId('111111111111111111');
const B = parseGuildId('222222222222222222');
const U = '333333333333333333';
const C = '444444444444444444';
const reminder = (
  guildId: string,
  id: string,
  status: Reminder['status'] = 'scheduled',
): Reminder => ({
  id,
  guildId,
  creatorId: U,
  destinationId: C,
  text: id,
  dueAt: 1000,
  createdAt: 1,
  status,
  dedupeKey: `${guildId}:${id}`,
  mentions: { userIds: [], roleIds: [], everyone: false, here: false },
  deliveredCount: 0,
});

describe('skill scopes and richer reminder storage', () => {
  it('round-trips scopes, reminders, and guild boundaries', () => {
    const t = openMigratedTestDatabase();
    const a = t.scopes.forGuild(A);
    const b = t.scopes.forGuild(B);
    upsertGuild(a, { name: 'a', now: 1 });
    upsertGuild(b, { name: 'b', now: 1 });
    setSkillScope(a, { skillId: 'reminders', mode: 'roles', roleIds: ['555555555555555555'] }, 2);
    expect(listSkillGrants(a)).toEqual([
      { skillId: 'reminders', mode: 'roles', roleIds: ['555555555555555555'], userIds: [] },
    ]);
    putSkillGrant(a, { skillId: 'reminders', roleIds: [], userIds: ['666666666666666666'] }, 3);
    expect(listSkillGrants(a)[0]?.mode).toBe('roles');
    const repeating = { pattern: { kind: 'daily' as const }, timeZone: 'UTC' };
    insertReminder(a, {
      ...reminder(A, 'r1'),
      mentions: { userIds: [U], roleIds: [], everyone: false, here: false },
      recurrence: reminderRecurrence.parse(repeating),
      context: 'why',
    });
    insertReminder(b, reminder(B, 'r1'));
    const reread = getReminder(a, 'r1');
    expect(reread?.context).toBe('why');
    expect(reread?.mentions).toEqual({ userIds: [U], roleIds: [], everyone: false, here: false });
    expect(reread?.recurrence).toEqual(reminderRecurrence.parse(repeating));
    expect(getReminder(b, 'r1')?.guildId).toBe(B);
    expect(listRemindersForCreator(a, U, { includeFinished: false })).toHaveLength(1);
    expect(updateReminder(a, 'r1', { text: 'changed' }, 4)).toBe('updated');
    claimDueReminders(a, 1000, 1, 300);
    rescheduleReminder(a, 'r1', 2000);
    expect(getReminder(a, 'r1')?.dueAt).toBe(2000);
    t.close();
  });

  it('executes the 0049 data SQL against seeded rows', () => {
    const t = openMigratedTestDatabase();
    const a = t.scopes.forGuild(A);
    upsertGuild(a, { name: 'a', now: 1 });
    const behaviour = (id: string, skillIds: readonly string[]) =>
      putBehaviour(
        a,
        {
          id,
          guildId: A,
          surface: 'bananasaurs',
          name: id,
          systemPrompt: 'prompt',
          promptVersion: 1,
          allowedSkillIds: [...skillIds],
          callerRoleIds: [],
          reviewerRoleIds: [],
          resourceIds: [],
          enabled: true,
        },
        1,
      );
    behaviour('b1', ['search-club', 'create-reminder']);
    behaviour('b2', ['create-reminder', 'send-reminder', 'draft-agenda']);
    behaviour('b3', ['search-club']);
    putSkillGrant(
      a,
      { skillId: 'create-reminder', roleIds: ['555555555555555555'], userIds: [] },
      2,
    );
    putSkillGrant(a, { skillId: 'send-reminder', roleIds: [], userIds: [] }, 2);
    recordSkillActivity(a, {
      id: 'act-old-create',
      at: 2,
      behaviourId: 'b1',
      skillId: 'create-reminder',
      actorId: U,
      outcome: 'completed',
    });
    recordSkillActivity(a, {
      id: 'act-old-send',
      at: 3,
      behaviourId: 'b2',
      skillId: 'send-reminder',
      actorId: U,
      outcome: 'completed',
    });
    const sql = readFileSync(
      fileURLToPath(
        new URL('../../../../drizzle/0049_skill_scopes_and_reminder_fields.sql', import.meta.url),
      ),
      'utf8',
    );
    for (const chunk of sql.split('--> statement-breakpoint')) {
      const statement = chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim();
      if (statement.startsWith('UPDATE') || statement.startsWith('DELETE')) t.raw.exec(statement);
    }
    const byId = new Map(listBehaviours(a).map((entry) => [entry.id, entry.allowedSkillIds]));
    expect([...(byId.get('b1') ?? [])].sort()).toEqual(['reminders', 'search-club']);
    expect([...(byId.get('b2') ?? [])].sort()).toEqual(['draft-agenda', 'reminders']);
    expect((byId.get('b2') ?? []).filter((id) => id === 'reminders')).toHaveLength(1);
    expect(byId.get('b3')).toEqual(['search-club']);
    expect(listSkillGrants(a)).toEqual([
      { skillId: 'reminders', roleIds: ['555555555555555555'], userIds: [] },
    ]);
    expect(listSkillActivity(a, 10).map((entry) => entry.skillId).sort()).toEqual([
      'reminders',
      'reminders',
    ]);
    t.close();
  });

  it('reads bad mentions and recurrence JSON as absent defaults', () => {
    const t = openMigratedTestDatabase();
    const a = t.scopes.forGuild(A);
    upsertGuild(a, { name: 'a', now: 1 });
    insertReminder(a, reminder(A, 'bad'));
    t.raw.exec(
      `UPDATE assistant_reminders SET mentions_json = 'not-json', recurrence_json = 'not-json' WHERE guild_id = '${A}' AND reminder_id = 'bad'`,
    );
    expect(getReminder(a, 'bad')?.mentions).toEqual({
      userIds: [],
      roleIds: [],
      everyone: false,
      here: false,
    });
    expect(getReminder(a, 'bad')?.recurrence).toBeUndefined();
    t.close();
  });

  it('counts deliveries on complete and moves due time on reschedule', () => {
    const t = openMigratedTestDatabase();
    const a = t.scopes.forGuild(A);
    upsertGuild(a, { name: 'a', now: 1 });
    insertReminder(a, reminder(A, 'done'));
    claimDueReminders(a, 1000, 25, 300);
    completeReminder(a, 'done');
    expect(getReminder(a, 'done')?.deliveredCount).toBe(1);
    insertReminder(a, reminder(A, 'moved'));
    claimDueReminders(a, 1000, 25, 300);
    rescheduleReminder(a, 'moved', 2000);
    expect(getReminder(a, 'moved')?.dueAt).toBe(2000);
    expect(getReminder(a, 'moved')?.deliveredCount).toBe(1);
    expect(getReminder(a, 'moved')?.failureReason).toBeUndefined();
    insertReminder(a, reminder(A, 'failed-move'));
    claimDueReminders(a, 1000, 25, 300);
    rescheduleReminder(a, 'failed-move', 3000, 'Missing Access');
    expect(getReminder(a, 'failed-move')?.dueAt).toBe(3000);
    expect(getReminder(a, 'failed-move')?.failureReason).toBe('Missing Access');
    t.close();
  });

  it('updates scheduled reminders and refuses the rest', () => {
    const t = openMigratedTestDatabase();
    const a = t.scopes.forGuild(A);
    upsertGuild(a, { name: 'a', now: 1 });
    insertReminder(a, reminder(A, 'editable'));
    expect(updateReminder(a, 'editable', { text: 'changed' }, 4)).toBe('updated');
    expect(getReminder(a, 'editable')?.text).toBe('changed');
    insertReminder(a, reminder(A, 'gone', 'cancelled'));
    expect(updateReminder(a, 'gone', { text: 'changed' }, 5)).toBe('not-editable');
    expect(updateReminder(a, 'missing', { text: 'changed' }, 6)).toBe('not-found');
    t.close();
  });

  it('filters creator reminders by finished status', () => {
    const t = openMigratedTestDatabase();
    const a = t.scopes.forGuild(A);
    upsertGuild(a, { name: 'a', now: 1 });
    const other = '555555555555555555';
    insertReminder(a, { ...reminder(A, 'mine'), creatorId: U, dueAt: 1000 });
    insertReminder(a, { ...reminder(A, 'theirs'), creatorId: other, dueAt: 1000 });
    insertReminder(a, {
      ...reminder(A, 'finished'),
      creatorId: U,
      status: 'delivered',
      dueAt: 500,
    });
    expect(listRemindersForCreator(a, U, { includeFinished: false }).map((r) => r.id)).toEqual([
      'mine',
    ]);
    expect(listRemindersForCreator(a, U, { includeFinished: true }).map((r) => r.id)).toEqual([
      'finished',
      'mine',
    ]);
    expect(listRemindersForCreator(a, other, { includeFinished: false }).map((r) => r.id)).toEqual([
      'theirs',
    ]);
    t.close();
  });

  it('keeps every reminder function inside its guild', () => {
    const t = openMigratedTestDatabase();
    const a = t.scopes.forGuild(A);
    const b = t.scopes.forGuild(B);
    upsertGuild(a, { name: 'a', now: 1 });
    upsertGuild(b, { name: 'b', now: 1 });
    insertReminder(b, reminder(B, 'secret'));
    expect(getReminder(a, 'secret')).toBeUndefined();
    expect(updateReminder(a, 'secret', { text: 'x' }, 2)).toBe('not-found');
    expect(cancelReminder(a, 'secret')).toBe(false);
    expect(listRemindersForCreator(a, U, { includeFinished: true })).toEqual([]);
    expect(claimDueReminders(a, 1000, 25, 300)).toEqual([]);
    expect(() => completeReminder(a, 'secret')).toThrow();
    expect(() => rescheduleReminder(a, 'secret', 2000)).toThrow();
    expect(getReminder(b, 'secret')?.guildId).toBe(B);
    t.close();
  });

  it('inserts a decision draft once: the second insert is a duplicate and keeps the row', () => {
    const t = openMigratedTestDatabase();
    const a = t.scopes.forGuild(A);
    upsertGuild(a, { name: 'a', now: 1 });
    const input = {
      id: 'draft-1',
      kind: 'decision' as const,
      summary: 'first',
      requesterId: U,
      provenance: 'chat',
      at: 10,
    };
    expect(insertDecisionDraftOnce(a, input)).toBe('created');
    expect(insertDecisionDraftOnce(a, { ...input, summary: 'second', at: 20 })).toBe('duplicate');
    expect(listDecisions(a)).toHaveLength(1);
    expect(listDecisions(a)[0]).toMatchObject({ id: 'draft-1', summary: 'first' });
    t.close();
  });

  it('has the requested migration tag and data rewrite', () => {
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../../drizzle/meta/_journal.json', import.meta.url)),
        'utf8',
      ),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.at(-1)?.tag).toBe('0049_skill_scopes_and_reminder_fields');
    const sql = readFileSync(
      fileURLToPath(
        new URL('../../../../drizzle/0049_skill_scopes_and_reminder_fields.sql', import.meta.url),
      ),
      'utf8',
    );
    expect(sql).toContain("UPDATE `assistant_skill_grants` SET `skill_id` = 'reminders'");
    expect(sql).toContain('json_group_array(DISTINCT');
  });
});
