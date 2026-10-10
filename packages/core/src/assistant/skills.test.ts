import { describe, expect, it } from 'vitest';
import {
  CLUB_ASSISTANT_SKILLS,
  effectiveSkillScope,
  skillScopeAllows,
  STARTER_SKILL_IDS,
} from './skills.js';

const skill = CLUB_ASSISTANT_SKILLS[0]!;

describe('assistant skill scopes', () => {
  it('has one reminders skill and no legacy reminder ids', () => {
    expect(CLUB_ASSISTANT_SKILLS.map(({ id }) => id)).toContain('reminders');
    expect(CLUB_ASSISTANT_SKILLS.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining(['create-reminder', 'send-reminder']),
    );
  });

  it('defaults acting skills to owner and others to everyone', () => {
    for (const entry of CLUB_ASSISTANT_SKILLS)
      expect(entry.defaultScope).toBe(entry.acts ? 'owner' : 'everyone');
  });

  it('uses exactly the non-acting skills as starters', () => {
    const nonActing = CLUB_ASSISTANT_SKILLS.filter((entry) => !entry.acts).map((entry) => entry.id);
    expect(nonActing.length).toBeGreaterThan(0);
    expect([...STARTER_SKILL_IDS].sort()).toEqual([...nonActing].sort());
  });

  it('has a non-acting web-search skill open to everyone by default', () => {
    const s = CLUB_ASSISTANT_SKILLS.find((x) => x.id === 'web-search');
    expect(s).toMatchObject({ acts: false, defaultScope: 'everyone', effect: 'read', name: 'Search the web' });
  });

  it('defaults the reminders skill to owner scope', () => {
    const remindersSkill = CLUB_ASSISTANT_SKILLS.find((entry) => entry.id === 'reminders');
    if (remindersSkill === undefined) throw new Error('reminders skill missing');
    expect(effectiveSkillScope(remindersSkill, undefined)).toEqual({ mode: 'owner' });
  });

  it('uses the stored scope when present and the default otherwise', () => {
    expect(effectiveSkillScope(skill, undefined)).toEqual({ mode: 'everyone' });
    expect(effectiveSkillScope(skill, { roleIds: [] })).toEqual({ mode: 'everyone' });
    expect(effectiveSkillScope(skill, { mode: 'everyone', roleIds: ['r'] })).toEqual({
      mode: 'everyone',
    });
    expect(effectiveSkillScope(skill, { mode: 'roles', roleIds: ['r'] })).toEqual({
      mode: 'roles',
      roleIds: ['r'],
    });
    expect(effectiveSkillScope(skill, { mode: 'owner', roleIds: ['r'] })).toEqual({
      mode: 'owner',
    });
  });

  it('applies every scope gate', () => {
    const member = { owner: false, roleIds: ['r1'] };
    const owner = { owner: true, roleIds: [] };
    expect(skillScopeAllows({ mode: 'everyone' }, member)).toBe(true);
    expect(skillScopeAllows({ mode: 'everyone' }, owner)).toBe(true);
    expect(skillScopeAllows({ mode: 'owner' }, member)).toBe(false);
    expect(skillScopeAllows({ mode: 'owner' }, owner)).toBe(true);
    expect(skillScopeAllows({ mode: 'roles', roleIds: ['r1'] }, member)).toBe(true);
    expect(skillScopeAllows({ mode: 'roles', roleIds: ['r2'] }, member)).toBe(false);
    expect(skillScopeAllows({ mode: 'roles', roleIds: [] }, member)).toBe(false);
    expect(skillScopeAllows({ mode: 'roles', roleIds: [] }, owner)).toBe(true);
  });
});
