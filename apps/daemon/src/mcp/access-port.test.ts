import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HttpDeps } from '@bananasaurs/http';
import { parseGuildId } from '@bananasaurs/core';
import { accountRepo, authzRepo, guildRepo, type InstanceScope } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accessPortFor } from './access-port.js';

/**
 * ADR 0133, Task 4: the access port behind the `bananasaurs_guide` live block.
 * It answers one account's username, owner flag and permissions in the one
 * guild asked for, and nothing for a missing or disabled account.
 */

const OWNER = 'acct_0123456789abcdef0123456789abcdef';
const MEMBER = 'acct_fedcba9876543210fedcba9876543210';
const DISABLED = 'acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MISSING = 'acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');

let t: MigratedTestDatabase;
let instance: InstanceScope;

const account = (accountId: string, username: string, isOwner: boolean): void =>
  accountRepo.createAccount(instance, {
    accountId,
    username,
    passwordHash: '$argon2id$fake',
    isOwner,
    now: 1000,
  });

beforeEach(() => {
  t = openMigratedTestDatabase();
  instance = t.scopes.instance();
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_A), { name: 'guild a', now: 1000 });
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_B), { name: 'guild b', now: 1000 });
  account(OWNER, 'owner', true);
  account(MEMBER, 'member', false);
  account(DISABLED, 'former-member', false);
});

afterEach(() => {
  t.close();
});

/** `accessPortFor` reads only `scopes`, so the fixture carries nothing else. */
const port = (): ReturnType<typeof accessPortFor> =>
  accessPortFor({ scopes: t.scopes } as unknown as HttpDeps);

/** An account reaches a guild before it can hold a capability there. */
const grant = (
  guildId: typeof GUILD_A,
  accountId: string,
  capability: 'config.read' | 'tasks.manage',
): void => {
  const scope = t.scopes.forGuild(guildId);
  accountRepo.grantGuildAccess(scope, accountId);
  authzRepo.grantAccountCapability(scope, { accountId, capability, grantedBy: 'test', now: 1000 });
};

describe('accessPortFor (ADR 0133, Task 4)', () => {
  it('answers the owner with the rows of the guild asked for, and no rows from another guild', () => {
    grant(GUILD_A, OWNER, 'config.read');
    expect(port().forGuild(OWNER, GUILD_A)).toEqual({
      username: 'owner',
      isOwner: true,
      permissions: ['config.read'],
    });
    expect(port().forGuild(OWNER, GUILD_B)).toEqual({
      username: 'owner',
      isOwner: true,
      permissions: [],
    });
  });

  it('answers a member with Manage club tasks in guild A with nothing in guild B', () => {
    grant(GUILD_A, MEMBER, 'tasks.manage');
    const inA = port().forGuild(MEMBER, GUILD_A);
    expect(inA).toEqual({ username: 'member', isOwner: false, permissions: ['tasks.manage'] });
    expect(port().forGuild(MEMBER, GUILD_B)).toEqual({
      username: 'member',
      isOwner: false,
      permissions: [],
    });
  });

  it('answers only the username, the owner flag and the permissions, and no other account detail', () => {
    const answer = port().forGuild(OWNER, GUILD_A);
    expect(answer).toBeDefined();
    expect(Object.keys(answer ?? {}).sort()).toEqual(['isOwner', 'permissions', 'username']);
  });

  it('has no answer for a disabled account, even one holding a grant, or for an unknown account', () => {
    grant(GUILD_A, DISABLED, 'tasks.manage');
    accountRepo.setAccountDisabled(instance, { accountId: DISABLED, disabled: true });
    expect(port().forGuild(DISABLED, GUILD_A)).toBeUndefined();
    expect(port().forGuild(MISSING, GUILD_A)).toBeUndefined();
  });
});
