import { beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import * as schema from '../schema.js';
import { upsertGuild } from './guilds.js';
import {
  allowRole,
  disallowRole,
  isMcpPrivateThread,
  isRoleAllowlisted,
  listRoleAllowlist,
  readRolePolicy,
  recordPrivateThread,
  upsertRolePolicy,
} from './mcp-role-policy.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const ROLE_A = '333333333333333333';
const THREAD_ID = '444444444444444444';
const PARENT_ID = '555555555555555555';

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  upsertGuild(a, { name: 'guild-a', now: 0 });
  upsertGuild(b, { name: 'guild-b', now: 0 });
});

const seedPolicy = (
  scope: GuildScope,
  policy: { grantMode?: 'below-bot' | 'allowlist'; pingMode?: 'below-bot' | 'allowlist' },
): void => {
  t.db
    .insert(schema.mcpRolePolicy)
    .values({
      guildId: scope.guildId,
      grantMode: policy.grantMode ?? 'below-bot',
      pingMode: policy.pingMode ?? 'below-bot',
      updatedAt: 1000,
    })
    .run();
};

const seedAllowlist = (
  scope: GuildScope,
  row: { roleId: string; purpose: 'grant' | 'ping' },
): void => {
  t.db
    .insert(schema.mcpRoleAllowlist)
    .values({
      guildId: scope.guildId,
      roleId: row.roleId,
      purpose: row.purpose,
      addedByAccountId: 'acct-1',
      addedAt: 1000,
    })
    .run();
};

describe('readRolePolicy', () => {
  it('defaults to below-bot for both modes with no row', () => {
    expect(readRolePolicy(a)).toEqual({ grantMode: 'below-bot', pingMode: 'below-bot' });
  });

  it('reads the stored modes, per guild', () => {
    seedPolicy(a, { grantMode: 'allowlist', pingMode: 'allowlist' });
    expect(readRolePolicy(a)).toEqual({ grantMode: 'allowlist', pingMode: 'allowlist' });
    // Guild B still has no row: the default, not A's modes.
    expect(readRolePolicy(b)).toEqual({ grantMode: 'below-bot', pingMode: 'below-bot' });
  });
});

describe('isRoleAllowlisted', () => {
  it('is false with no rows', () => {
    expect(isRoleAllowlisted(a, ROLE_A, 'ping')).toBe(false);
    expect(isRoleAllowlisted(a, ROLE_A, 'grant')).toBe(false);
  });

  it('is scoped by purpose: a ping row does not satisfy grant and vice versa', () => {
    seedAllowlist(a, { roleId: ROLE_A, purpose: 'ping' });
    expect(isRoleAllowlisted(a, ROLE_A, 'ping')).toBe(true);
    expect(isRoleAllowlisted(a, ROLE_A, 'grant')).toBe(false);
    seedAllowlist(a, { roleId: ROLE_A, purpose: 'grant' });
    expect(isRoleAllowlisted(a, ROLE_A, 'grant')).toBe(true);
  });

  it('is scoped by guild and by role', () => {
    seedAllowlist(a, { roleId: ROLE_A, purpose: 'ping' });
    expect(isRoleAllowlisted(b, ROLE_A, 'ping')).toBe(false);
    expect(isRoleAllowlisted(a, '777777777777777777', 'ping')).toBe(false);
  });
});

describe('upsertRolePolicy', () => {
  it('creates the row from the default and reports before and after', () => {
    const result = upsertRolePolicy(a, { grantMode: 'allowlist', now: 1000 });
    expect(result).toEqual({
      before: { grantMode: 'below-bot', pingMode: 'below-bot' },
      after: { grantMode: 'allowlist', pingMode: 'below-bot' },
    });
    expect(readRolePolicy(a)).toEqual({ grantMode: 'allowlist', pingMode: 'below-bot' });
  });

  it('keeps the mode no input named, and guild B is isolated', () => {
    upsertRolePolicy(a, { grantMode: 'allowlist', pingMode: 'allowlist', now: 1000 });
    const result = upsertRolePolicy(a, { pingMode: 'below-bot', now: 2000 });
    expect(result).toEqual({
      before: { grantMode: 'allowlist', pingMode: 'allowlist' },
      after: { grantMode: 'allowlist', pingMode: 'below-bot' },
    });
    expect(readRolePolicy(a)).toEqual({ grantMode: 'allowlist', pingMode: 'below-bot' });
    // Guild B never wrote: the default, not A's modes.
    expect(readRolePolicy(b)).toEqual({ grantMode: 'below-bot', pingMode: 'below-bot' });
  });
});

describe('allowRole / disallowRole / listRoleAllowlist', () => {
  it('allows once: a repeat is a no-op reported as false', () => {
    expect(
      allowRole(a, { roleId: ROLE_A, purpose: 'ping', addedByAccountId: 'acct-1', now: 1000 }),
    ).toBe(true);
    expect(
      allowRole(a, { roleId: ROLE_A, purpose: 'ping', addedByAccountId: 'acct-1', now: 2000 }),
    ).toBe(false);
    expect(listRoleAllowlist(a)).toHaveLength(1);
    expect(isRoleAllowlisted(a, ROLE_A, 'ping')).toBe(true);
  });

  it('is scoped by purpose: the same role allowed for both has two rows', () => {
    allowRole(a, { roleId: ROLE_A, purpose: 'ping', addedByAccountId: 'acct-1', now: 1000 });
    allowRole(a, { roleId: ROLE_A, purpose: 'grant', addedByAccountId: 'acct-1', now: 1000 });
    expect(listRoleAllowlist(a)).toEqual([
      { roleId: ROLE_A, purpose: 'grant', addedByAccountId: 'acct-1', addedAt: 1000 },
      { roleId: ROLE_A, purpose: 'ping', addedByAccountId: 'acct-1', addedAt: 1000 },
    ]);
  });

  it('disallows a row; a row that was never allowed reports false', () => {
    expect(disallowRole(a, ROLE_A, 'ping')).toBe(false);
    allowRole(a, { roleId: ROLE_A, purpose: 'ping', addedByAccountId: 'acct-1', now: 1000 });
    expect(disallowRole(a, ROLE_A, 'ping')).toBe(true);
    expect(disallowRole(a, ROLE_A, 'ping')).toBe(false);
    expect(isRoleAllowlisted(a, ROLE_A, 'ping')).toBe(false);
    // The grant row for the same role is untouched.
    allowRole(a, { roleId: ROLE_A, purpose: 'grant', addedByAccountId: 'acct-1', now: 1000 });
    allowRole(a, { roleId: ROLE_A, purpose: 'ping', addedByAccountId: 'acct-1', now: 1000 });
    expect(disallowRole(a, ROLE_A, 'ping')).toBe(true);
    expect(isRoleAllowlisted(a, ROLE_A, 'grant')).toBe(true);
  });

  it('is scoped by guild: guild B sees none of guild A rows', () => {
    allowRole(a, { roleId: ROLE_A, purpose: 'ping', addedByAccountId: 'acct-1', now: 1000 });
    expect(listRoleAllowlist(b)).toEqual([]);
    expect(disallowRole(b, ROLE_A, 'ping')).toBe(false);
    expect(isRoleAllowlisted(a, ROLE_A, 'ping')).toBe(true);
  });
});

describe('recordPrivateThread / isMcpPrivateThread', () => {
  it('records once: a second record of the same thread is a no-op', () => {
    expect(isMcpPrivateThread(a, THREAD_ID)).toBe(false);
    recordPrivateThread(a, {
      threadId: THREAD_ID,
      parentChannelId: PARENT_ID,
      createdActionId: 'act-1',
      now: 1000,
    });
    expect(isMcpPrivateThread(a, THREAD_ID)).toBe(true);
    recordPrivateThread(a, {
      threadId: THREAD_ID,
      parentChannelId: PARENT_ID,
      createdActionId: 'act-1',
      now: 2000,
    });
    expect(isMcpPrivateThread(a, THREAD_ID)).toBe(true);
    const rows = t.db
      .select()
      .from(schema.mcpPrivateThreads)
      .all()
      .filter((r) => r.guildId === a.guildId);
    expect(rows).toHaveLength(1);
  });

  it('is scoped by guild: a thread recorded in A is unknown in B', () => {
    recordPrivateThread(a, {
      threadId: THREAD_ID,
      parentChannelId: PARENT_ID,
      createdActionId: 'act-1',
      now: 1000,
    });
    expect(isMcpPrivateThread(a, THREAD_ID)).toBe(true);
    expect(isMcpPrivateThread(b, THREAD_ID)).toBe(false);
    expect(isMcpPrivateThread(a, '888888888888888888')).toBe(false);
  });
});
