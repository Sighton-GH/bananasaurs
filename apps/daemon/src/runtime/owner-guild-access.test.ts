import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { CAPABILITIES, OPS_AUDIT_ACTIONS, parseGuildId } from '@bananasaurs/core';
import {
  accountRepo,
  authzRepo,
  effectRepo,
  guildRepo,
  type GuildScope,
  type InstanceScope,
} from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { ensureOwnerGuildAccess } from './owner-guild-access.js';

const OWNER = 'acct_0123456789abcdef0123456789abcdef';
const MEMBER = 'acct_fedcba9876543210fedcba9876543210';
const DISABLED_OWNER = 'acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const silent = pino({ level: 'silent' });

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;
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
  a = t.scopes.forGuild(parseGuildId('111111111111111111'));
  b = t.scopes.forGuild(parseGuildId('222222222222222222'));
  instance = t.scopes.instance();
  guildRepo.upsertGuild(a, { name: 'guild a', now: 1000 });
  guildRepo.upsertGuild(b, { name: 'guild b', now: 1000 });
  account(OWNER, 'owner', true);
});
afterEach(() => {
  t.close();
});

const run = (scope: GuildScope, readonly = false): readonly string[] =>
  ensureOwnerGuildAccess({ scope, instance, readonly, logger: silent, now: 5000 });

describe('ensureOwnerGuildAccess (ADR 0124)', () => {
  it('gives an owner with no access row access and every capability in this guild only', () => {
    expect(run(a)).toEqual([OWNER]);

    expect(accountRepo.hasGuildAccess(a, OWNER)).toBe(true);
    expect(authzRepo.listAccountCapabilities(a, OWNER).sort()).toEqual([...CAPABILITIES].sort());
    expect(accountRepo.hasGuildAccess(b, OWNER)).toBe(false);
    expect(authzRepo.listAccountCapabilities(b, OWNER)).toEqual([]);
  });

  it('audits the grant in the guild granted, as the system', () => {
    run(a);
    const rows = effectRepo
      .tailAudit(a)
      .filter((row) => row.action === OPS_AUDIT_ACTIONS.accountGuildGranted);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'system',
      subjectType: 'account',
      subjectId: OWNER,
    });
    expect(effectRepo.tailAudit(b)).toEqual([]);
  });

  it('changes nothing when the owner already reaches the guild, keeping a revoked capability revoked', () => {
    accountRepo.grantGuildAccess(a, OWNER);
    authzRepo.grantAccountCapability(a, {
      accountId: OWNER,
      capability: 'config.read',
      grantedBy: 'test',
      now: 1000,
    });

    expect(run(a)).toEqual([]);
    expect(authzRepo.listAccountCapabilities(a, OWNER)).toEqual(['config.read']);
    expect(effectRepo.tailAudit(a)).toEqual([]);
  });

  it('is idempotent across restarts', () => {
    run(a);
    expect(run(a)).toEqual([]);
    expect(
      effectRepo.tailAudit(a).filter((row) => row.action === OPS_AUDIT_ACTIONS.accountGuildGranted),
    ).toHaveLength(1);
  });

  it('leaves member accounts and disabled owners without access', () => {
    account(MEMBER, 'member', false);
    account(DISABLED_OWNER, 'old-owner', true);
    accountRepo.setAccountDisabled(instance, { accountId: DISABLED_OWNER, disabled: true });

    expect(run(a)).toEqual([OWNER]);
    expect(accountRepo.hasGuildAccess(a, MEMBER)).toBe(false);
    expect(accountRepo.hasGuildAccess(a, DISABLED_OWNER)).toBe(false);
  });

  it('writes nothing in read-only mode', () => {
    expect(run(a, true)).toEqual([]);
    expect(accountRepo.hasGuildAccess(a, OWNER)).toBe(false);
  });
});
