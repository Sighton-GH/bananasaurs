import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reminderRecurrence, type Reminder } from '@bananasaurs/core';
import { openMigratedTestDatabase } from '../test-support.js';
import { upsertGuild } from './guilds.js';
import {
  getReminder,
  insertReminder,
  listBehaviours,
  listRemindersForCreator,
  listSkillGrants,
  putBehaviour,
  putSkillGrant,
  rescheduleReminder,
  claimDueReminders,
  setSkillScope,
  updateReminder,
} from './assistant.js';

const A = '111111111111111111';
const B = '222222222222222222';
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
    expect(getReminder(a, 'r1')?.context).toBe('why');
    expect(getReminder(b, 'r1')?.guildId).toBe(B);
    expect(listRemindersForCreator(a, U, { includeFinished: false })).toHaveLength(1);
    expect(updateReminder(a, 'r1', { text: 'changed' }, 4)).toBe('updated');
    claimDueReminders(a, 1000, 1, 300);
    rescheduleReminder(a, 'r1', 2000);
    expect(getReminder(a, 'r1')?.dueAt).toBe(2000);
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
