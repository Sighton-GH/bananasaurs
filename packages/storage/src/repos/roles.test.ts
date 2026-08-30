import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { upsertGuild } from './guilds.js';
import {
  allowlistRole,
  findManagedRole,
  isAllowlisted,
  listUnassignableRoles,
  setRoleAssignability,
} from './roles.js';

/**
 * `managed_roles` and its assignability diagnosis.
 *
 * `listUnassignableRoles` is what `bananasaurs doctor` reports, and the
 * distinction it draws is the whole point: `above_bot`, `managed` and `deleted`
 * each need a different fix, and from Discord's side all three look identical —
 * a panel that silently does nothing for one member (`docs/19` §9 finding 6).
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const ROLE_A = '333333333333333333';
const ROLE_B = '444444444444444444';

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  upsertGuild(a, { name: 'guild a', now: 0 });
  upsertGuild(b, { name: 'guild b', now: 0 });
});
afterEach(() => {
  t.close();
});

describe('allowlistRole', () => {
  it('records a role as managed', () => {
    allowlistRole(a, ROLE_A);
    expect(isAllowlisted(a, ROLE_A)).toBe(true);
  });

  it('is guild-scoped: another guild has not allowlisted it', () => {
    allowlistRole(a, ROLE_A);
    expect(isAllowlisted(b, ROLE_A)).toBe(false);
  });
});

describe('listUnassignableRoles', () => {
  it('is empty while every managed role is assignable', () => {
    allowlistRole(a, ROLE_A);
    allowlistRole(a, ROLE_B);
    expect(listUnassignableRoles(a)).toEqual([]);
  });

  it('returns only the roles a check actually found unassignable', () => {
    // The load-bearing assertion. Returning *every* managed role would make
    // `doctor` report a healthy guild as broken, and it is exactly what a
    // dropped `assignable = 0` predicate does.
    allowlistRole(a, ROLE_A);
    allowlistRole(a, ROLE_B);
    setRoleAssignability(a, { roleId: ROLE_A, assignable: false, reason: 'above_bot', now: 100 });

    const rows = listUnassignableRoles(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.roleId).toBe(ROLE_A);
  });

  it('carries the diagnosis, because each reason needs a different fix', () => {
    allowlistRole(a, ROLE_A);
    setRoleAssignability(a, { roleId: ROLE_A, assignable: false, reason: 'deleted', now: 100 });
    expect(listUnassignableRoles(a)[0]?.unassignableReason).toBe('deleted');
  });

  it('drops a role from the list once a later check finds it assignable again', () => {
    allowlistRole(a, ROLE_A);
    setRoleAssignability(a, { roleId: ROLE_A, assignable: false, reason: 'above_bot', now: 100 });
    setRoleAssignability(a, { roleId: ROLE_A, assignable: true, now: 200 });
    expect(listUnassignableRoles(a)).toEqual([]);
    expect(findManagedRole(a, ROLE_A)?.unassignableReason).toBeNull();
  });

  it("does not see another guild's unassignable roles", () => {
    allowlistRole(b, ROLE_A);
    setRoleAssignability(b, { roleId: ROLE_A, assignable: false, reason: 'managed', now: 100 });
    expect(listUnassignableRoles(a)).toEqual([]);
    expect(listUnassignableRoles(b)).toHaveLength(1);
  });
});
