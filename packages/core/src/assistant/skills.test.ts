import { describe, expect, it } from 'vitest';
import {
  CLUB_ASSISTANT_SKILLS,
  effectiveSkillScope,
  skillScopeAllows,
  STARTER_SKILL_IDS,
} from './skills.js';

const skill = CLUB_ASSISTANT_SKILLS[0];

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

  it('does not include acting skills in starters', () => {
    expect(STARTER_SKILL_IDS).not.toEqual(
      expect.arrayContaining(
        CLUB_ASSISTANT_SKILLS.filter((entry) => entry.acts).map((entry) => entry.id),
      ),
    );
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
