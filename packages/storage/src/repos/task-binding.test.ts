import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { upsertGuild } from './guilds.js';
import { tailAudit } from './effects.js';
import { createTeam } from './tasks.js';
import {
  addMembership,
  isMember,
  removeMembership,
  presidentRoleId,
  setPresidentRole,
  clearPresidentRole,
} from './task-binding.js';
let t: MigratedTestDatabase;
const A = parseGuildId('111111111111111111');
const B = parseGuildId('222222222222222222');
const ACTOR = { actorType: 'dashboard', actorId: 'owner', via: 'http' } as const;
beforeEach(() => {
  t = openMigratedTestDatabase();
  upsertGuild(t.scopes.forGuild(A), { name: 'a', now: 0 });
  upsertGuild(t.scopes.forGuild(B), { name: 'b', now: 0 });
});
afterEach(() => t.close());
describe('verified task identity', () => {
  it('scopes membership to the guild', () => {
    const a = t.scopes.forGuild(A);
    const b = t.scopes.forGuild(B);
    const teamId = createTeam(
      a,
      { name: 'Tech', categoryId: '333333333333333333', kind: 'subteam' },
      ACTOR,
      0,
    );
    addMembership(a, teamId, '444444444444444444', 'member', ACTOR, 1);
    expect(isMember(a, teamId, '444444444444444444')).toBe(true);
    expect(isMember(b, teamId, '444444444444444444')).toBe(false);
  });
  it('revokes membership without crossing guilds or teams', () => {
    const a = t.scopes.forGuild(A);
    const b = t.scopes.forGuild(B);
    const id = '444444444444444444';
    const teamA = createTeam(
      a,
      { name: 'Tech', categoryId: '333333333333333333', kind: 'subteam' },
      ACTOR,
      0,
    );
    const teamB = createTeam(
      b,
      { name: 'Tech', categoryId: '333333333333333333', kind: 'subteam' },
      ACTOR,
      0,
    );
    const secondTeam = createTeam(
      a,
      { name: 'Exec', categoryId: '555555555555555555', kind: 'exec' },
      ACTOR,
      0,
    );
    addMembership(a, teamA, id, 'member', ACTOR, 1);
    addMembership(a, secondTeam, id, 'member', ACTOR, 1);
    addMembership(b, teamB, id, 'member', ACTOR, 1);
    expect(removeMembership(a, teamA, id, ACTOR, 2)).toBe(true);
    expect(removeMembership(a, teamA, id, ACTOR, 2)).toBe(false);
    expect(isMember(a, teamA, id)).toBe(false);
    expect(isMember(a, secondTeam, id)).toBe(true);
    expect(isMember(b, teamB, id)).toBe(true);
  });
  it('keeps president role configuration isolated by guild', () => {
    const a = t.scopes.forGuild(A);
    const b = t.scopes.forGuild(B);
    setPresidentRole(a, '666666666666666666', ACTOR, 1);
    expect(presidentRoleId(a)).toBe('666666666666666666');
    expect(presidentRoleId(b)).toBeUndefined();
    setPresidentRole(b, '777777777777777777', ACTOR, 2);
    clearPresidentRole(a, ACTOR, 3);
    expect(presidentRoleId(a)).toBeUndefined();
    expect(presidentRoleId(b)).toBe('777777777777777777');
  });
  it('membership add and remove write audit rows with the passed actor', () => {
    const a = t.scopes.forGuild(A);
    const teamId = createTeam(
      a,
      { name: 'Tech', categoryId: '333333333333333333', kind: 'subteam' },
      ACTOR,
      0,
    );
    const before = tailAudit(a).length;
    addMembership(a, teamId, '444444444444444444', 'member', ACTOR, 1);
    expect(tailAudit(a)).toHaveLength(before + 1);
    expect(tailAudit(a)[0]).toMatchObject({
      actorType: 'dashboard',
      action: 'task.member_added',
    });
    expect(removeMembership(a, teamId, '444444444444444444', ACTOR, 2)).toBe(true);
    expect(tailAudit(a)[0]).toMatchObject({ action: 'task.member_removed' });
  });
  it('removing a non-existent membership writes no audit row', () => {
    const a = t.scopes.forGuild(A);
    const teamId = createTeam(
      a,
      { name: 'Tech', categoryId: '333333333333333333', kind: 'subteam' },
      ACTOR,
      0,
    );
    const before = tailAudit(a).length;
    expect(removeMembership(a, teamId, '444444444444444444', ACTOR, 1)).toBe(false);
    expect(tailAudit(a)).toHaveLength(before);
  });
  it('president set and clear write audit rows; clearing an absent role writes none', () => {
    const a = t.scopes.forGuild(A);
    const before = tailAudit(a).length;
    setPresidentRole(a, '666666666666666666', ACTOR, 1);
    expect(tailAudit(a)).toHaveLength(before + 1);
    expect(tailAudit(a)[0]).toMatchObject({
      actorType: 'dashboard',
      action: 'task.president_role_set',
    });
    expect(clearPresidentRole(a, ACTOR, 2)).toBe(true);
    expect(tailAudit(a)[0]).toMatchObject({ action: 'task.president_role_cleared' });
    const afterClear = tailAudit(a).length;
    expect(clearPresidentRole(a, ACTOR, 3)).toBe(false);
    expect(tailAudit(a)).toHaveLength(afterClear);
  });
});
