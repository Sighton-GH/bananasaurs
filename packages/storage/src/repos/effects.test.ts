import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { panelDefinitionSchema, parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { managedRoles } from '../schema.js';
import { write } from '../write.js';
import { upsertGuild } from './guilds.js';
import { createPanel } from './panels.js';
import {
  closeBatch,
  claimEffect,
  listAssignedUsers,
  openBatch,
  recordAssignment,
  recordAudit,
  recordOutcome,
  removeAssignment,
  tailAudit,
  wasRecentlyApplied,
} from './effects.js';

/**
 * The two queries WP3 leans on that only SQL can prove.
 *
 * `wasRecentlyApplied` is amendment 5's self-mutation filter. `listAssignedUsers`
 * is the candidate list reconciliation walks when a member has withdrawn a
 * reaction and is therefore in no reaction set at all.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const ALICE = '551111111111111111';
const BOB = '552222222222222222';
const ROLE_A = '666666666666666666';
const ROLE_B = '777777777777777777';

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;

const setUp = (scope: GuildScope) => {
  upsertGuild(scope, { name: 'test guild', now: 0 });
  write(scope, ({ db }) => {
    for (const roleId of [ROLE_A, ROLE_B]) {
      db.insert(managedRoles)
        .values({ guildId: scope.guildId, roleId })
        .onConflictDoNothing()
        .run();
    }
  });
  // `managed_role_assignments.panel_id` is a real foreign key, so provenance
  // cannot name a panel that does not exist.
  for (const panelId of ['roles', 'other']) {
    createPanel(
      scope,
      panelDefinitionSchema.parse({
        panelId,
        kind: 'managed',
        channelId: '333333333333333333',
        behaviour: 'toggle',
        component: 'button',
        options: [
          { optionId: 'a', roleId: ROLE_A, label: 'A', position: 0 },
          { optionId: 'b', roleId: ROLE_B, label: 'B', position: 1 },
        ],
      }),
      0,
    );
  }
};

/** One applied effect, the way the gateway writes it: claim, then outcome. */
const applyEffect = (
  scope: GuildScope,
  input: { userId: string; roleId: string; action: 'grant' | 'revoke'; at: number },
): string => {
  const batchId = openBatch(scope, {
    source: 'reconcile',
    actorType: 'system',
    actorId: undefined,
    now: input.at,
  });
  const claim = claimEffect(scope, {
    dedupeKey: `${input.userId}:${input.roleId}:${input.action}:${input.at}`,
    batchId,
    userId: input.userId,
    roleId: input.roleId,
    action: input.action,
    hadRoleBefore: input.action === 'revoke',
    panelId: undefined,
    now: input.at,
  });
  if (!claim.claimed) throw new Error('the fixture failed to claim an effect');
  recordOutcome(scope, { effectId: claim.effectId, state: 'applied', completedAt: input.at });
  closeBatch(scope, batchId, input.at);
  return claim.effectId;
};

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  setUp(a);
  setUp(b);
});

afterEach(() => {
  t.close();
});

describe('wasRecentlyApplied', () => {
  it('sees an effect completed inside the window', () => {
    applyEffect(a, { userId: ALICE, roleId: ROLE_A, action: 'grant', at: 1_000 });

    expect(
      wasRecentlyApplied(a, { userId: ALICE, roleId: ROLE_A, sinceMs: 500, action: 'grant' }),
    ).toBe(true);
  });

  it('does not see one that completed before the window', () => {
    applyEffect(a, { userId: ALICE, roleId: ROLE_A, action: 'grant', at: 1_000 });

    expect(
      wasRecentlyApplied(a, { userId: ALICE, roleId: ROLE_A, sinceMs: 2_000, action: 'grant' }),
    ).toBe(false);
  });

  it('does not answer for the opposite direction', () => {
    // The bug this prevents: we grant a role, a moderator removes it five
    // seconds later, and the removal is dismissed as our own work.
    applyEffect(a, { userId: ALICE, roleId: ROLE_A, action: 'grant', at: 1_000 });

    expect(
      wasRecentlyApplied(a, { userId: ALICE, roleId: ROLE_A, sinceMs: 500, action: 'revoke' }),
    ).toBe(false);
  });

  it('ignores an effect that was planned but never applied', () => {
    const batchId = openBatch(a, {
      source: 'reconcile',
      actorType: 'system',
      actorId: undefined,
      now: 1_000,
    });
    claimEffect(a, {
      dedupeKey: 'planned-only',
      batchId,
      userId: ALICE,
      roleId: ROLE_A,
      action: 'grant',
      hadRoleBefore: false,
      panelId: undefined,
      now: 1_000,
    });

    expect(
      wasRecentlyApplied(a, { userId: ALICE, roleId: ROLE_A, sinceMs: 0, action: 'grant' }),
    ).toBe(false);
  });

  it('does not answer for a different member or a different role', () => {
    applyEffect(a, { userId: ALICE, roleId: ROLE_A, action: 'grant', at: 1_000 });

    expect(
      wasRecentlyApplied(a, { userId: BOB, roleId: ROLE_A, sinceMs: 0, action: 'grant' }),
    ).toBe(false);
    expect(
      wasRecentlyApplied(a, { userId: ALICE, roleId: ROLE_B, sinceMs: 0, action: 'grant' }),
    ).toBe(false);
  });

  it('does not answer for another guild', () => {
    applyEffect(a, { userId: ALICE, roleId: ROLE_A, action: 'grant', at: 1_000 });

    expect(
      wasRecentlyApplied(b, { userId: ALICE, roleId: ROLE_A, sinceMs: 0, action: 'grant' }),
    ).toBe(false);
  });
});

describe('listAssignedUsers', () => {
  const record = (scope: GuildScope, userId: string, roleId: string, panelId: string) =>
    recordAssignment(scope, {
      userId,
      roleId,
      panelId,
      effectId: applyEffect(scope, { userId, roleId, action: 'grant', at: 1_000 }),
      now: 1_000,
    });

  it('lists the members a panel granted a role to', () => {
    record(a, ALICE, ROLE_A, 'roles');
    record(a, BOB, ROLE_A, 'roles');

    expect(listAssignedUsers(a, 'roles').sort()).toEqual([ALICE, BOB].sort());
  });

  it('names a member once however many of the panel’s roles they hold', () => {
    record(a, ALICE, ROLE_A, 'roles');
    record(a, ALICE, ROLE_B, 'roles');

    expect(listAssignedUsers(a, 'roles')).toEqual([ALICE]);
  });

  it('does not list a member of a different panel', () => {
    record(a, ALICE, ROLE_A, 'roles');
    record(a, BOB, ROLE_B, 'other');

    expect(listAssignedUsers(a, 'roles')).toEqual([ALICE]);
  });

  it('forgets a member once the role is revoked', () => {
    record(a, ALICE, ROLE_A, 'roles');
    removeAssignment(a, { userId: ALICE, roleId: ROLE_A });

    // This is what keeps the candidate list the size of the panel's current
    // membership rather than of its whole history.
    expect(listAssignedUsers(a, 'roles')).toEqual([]);
  });

  it('does not cross guilds', () => {
    record(a, ALICE, ROLE_A, 'roles');

    expect(listAssignedUsers(b, 'roles')).toEqual([]);
  });
});

describe('tailAudit', () => {
  const put = (scope: GuildScope, at: number, action: string) =>
    recordAudit(scope, {
      at,
      actorType: 'operator_cli',
      actorId: undefined,
      actorUnixUserClaimed: 'bryan',
      via: 'ssh',
      action,
      subjectType: 'guild',
      subjectId: undefined,
      dryRun: false,
    });

  it('returns the newest first', () => {
    put(a, 100, 'first');
    put(a, 300, 'third');
    put(a, 200, 'second');
    expect(tailAudit(a).map((r) => r.action)).toEqual(['third', 'second', 'first']);
  });

  it('carries `via`, so the trail says which channel an action came in on', () => {
    put(a, 100, 'x');
    expect(tailAudit(a)[0]?.via).toBe('ssh');
  });

  it('carries the claimed unix user, and leaves actor_id null', () => {
    put(a, 100, 'x');
    expect(tailAudit(a)[0]).toMatchObject({ actorUnixUserClaimed: 'bryan', actorId: null });
  });

  it('honours a limit', () => {
    put(a, 100, 'a');
    put(a, 200, 'b');
    expect(tailAudit(a, { limit: 1 }).map((r) => r.action)).toEqual(['b']);
  });

  it('honours a since bound, which is what --since 2h becomes', () => {
    put(a, 100, 'old');
    put(a, 500, 'recent');
    expect(tailAudit(a, { sinceMs: 400 }).map((r) => r.action)).toEqual(['recent']);
  });

  it('includes a row exactly on the since boundary', () => {
    put(a, 400, 'boundary');
    expect(tailAudit(a, { sinceMs: 400 })).toHaveLength(1);
  });

  it("does not see another guild's audit trail", () => {
    put(b, 100, 'theirs');
    expect(tailAudit(a)).toEqual([]);
    expect(tailAudit(b)).toHaveLength(1);
  });
});

describe('tailAudit excludeActions (ADR 0050)', () => {
  const put = (scope: GuildScope, at: number, action: string) =>
    recordAudit(scope, {
      at,
      actorType: 'mcp_operator',
      actorId: 'tok_test',
      via: 'http',
      action,
      subjectType: 'guild',
      subjectId: undefined,
      dryRun: false,
    });

  it('omits the named actions, in SQL, so a full page of excluded rows cannot empty the result', () => {
    for (let i = 0; i < 5; i += 1) put(a, 100 + i, 'mcp.read.list_audit_events');
    put(a, 1, 'real.one');
    put(a, 2, 'real.two');
    // Without the filter the five read-rows fill the limit-5 page and the two
    // real rows vanish; with it they are exactly what remains.
    expect(tailAudit(a, { limit: 5, excludeActions: ['mcp.read.list_audit_events'] })).toHaveLength(
      2,
    );
    expect(
      tailAudit(a, { limit: 5, excludeActions: ['mcp.read.list_audit_events'] }).map(
        (r) => r.action,
      ),
    ).toEqual(['real.two', 'real.one']);
  });

  it('filters nothing when the option is absent, and treats an empty list as absent', () => {
    put(a, 100, 'mcp.read.list_audit_events');
    expect(tailAudit(a)).toHaveLength(1);
    expect(tailAudit(a, { excludeActions: [] })).toHaveLength(1);
  });

  it('stays guild-scoped while filtering', () => {
    put(a, 100, 'mcp.read.list_audit_events');
    put(b, 100, 'real.theirs');
    expect(tailAudit(a, { excludeActions: ['mcp.read.list_audit_events'] })).toEqual([]);
    expect(tailAudit(b, { excludeActions: ['mcp.read.list_audit_events'] })).toHaveLength(1);
  });
});
