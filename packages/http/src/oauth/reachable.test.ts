import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, guildRepo } from '@bananasaurs/storage';
import { parseGuildId } from '@bananasaurs/core';
import { hashPassword } from '../secrets.js';
import type { OAuthDeps } from './provider.js';
import { reachableGuilds } from './reachable.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const PASSWORD = 'correct horse battery staple';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';

let t: MigratedTestDatabase;
let clock: number;
let deps: OAuthDeps;

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  deps = { scopes: t.scopes, now: () => clock, guildIds: [GUILD_A, GUILD_B] };
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_A), { name: 'guild a', now: clock });
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_B), { name: 'guild b', now: clock });

  accountRepo.createAccount(t.scopes.instance(), {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
});

afterEach(() => {
  t.close();
});

const grantAccess = (guild: typeof GUILD_A): void => {
  accountRepo.grantGuildAccess(t.scopes.forGuild(guild), ACCOUNT);
};

const grantAuthorize = (guild: typeof GUILD_A): void => {
  authzRepo.grantAccountCapability(t.scopes.forGuild(guild), {
    accountId: ACCOUNT,
    capability: 'mcp.authorize',
    grantedBy: 'test',
    now: clock,
  });
};

describe('reachableGuilds (ADR 0045 PR-92)', () => {
  it('returns the granted guild only, even with access to both', () => {
    grantAccess(GUILD_A);
    grantAccess(GUILD_B);
    grantAuthorize(GUILD_A);
    expect(reachableGuilds(deps, ACCOUNT)).toEqual([GUILD_A]);
  });

  it('goes empty on the very next call after the grant is revoked, with nothing else changed', () => {
    grantAccess(GUILD_A);
    grantAccess(GUILD_B);
    grantAuthorize(GUILD_A);
    expect(reachableGuilds(deps, ACCOUNT)).toEqual([GUILD_A]);
    authzRepo.revokeAccountCapability(t.scopes.forGuild(GUILD_A), {
      accountId: ACCOUNT,
      capability: 'mcp.authorize',
    });
    expect(reachableGuilds(deps, ACCOUNT)).toEqual([]);
  });

  it('returns empty with no grants at all', () => {
    grantAccess(GUILD_A);
    expect(reachableGuilds(deps, ACCOUNT)).toEqual([]);
  });

  it('never returns a guild the daemon does not serve', () => {
    grantAccess(GUILD_A);
    grantAccess(GUILD_B);
    grantAuthorize(GUILD_A);
    grantAuthorize(GUILD_B);
    const narrowed: OAuthDeps = { ...deps, guildIds: [GUILD_A] };
    expect(reachableGuilds(narrowed, ACCOUNT)).toEqual([GUILD_A]);
  });
});
