import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelType, Client, PermissionsBitField, type Guild } from 'discord.js';
import { parseGuildId } from '@bananasaurs/core';
import { buildClientOptions } from '@bananasaurs/discord';
import {
  accountRepo,
  archiveRepo,
  guildRepo,
  oauthRepo,
  sessionRepo,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import type { GuildOperations } from '../runtime/guild.js';
import { accountOpsFor, opsPortsFor } from './wiring.js';

/**
 * `doctor`'s archive check: `listUnreadableArchiveChannels`
 * (`apps/daemon/src/ops/wiring.ts`).
 *
 * The permission logic — the `missing` / `no-view` / `no-history` branching
 * over the gateway cache — previously had no test anywhere: the doctor tests
 * stub `listUnreadableArchiveChannels` and assert only the renderer. These
 * reach the real function through `opsPortsFor` against a fake discord.js
 * guild shaped like the one `runtime/doctor.test.ts` builds (a real `Client`
 * that never logged in, guilds injected through `guilds._add`), with archive
 * rows in a real migrated database.
 */

const GUILD = parseGuildId('211111111111111111');
const BOT = '123456789012345678';
const OWNER = '345678901234567890';
const BOT_ROLE = '555555555555555555';

const MISSING = '611111111111111111';
const NO_VIEW = '622222222222222222';
const NO_HISTORY = '633333333333333333';
const CLEAN = '644444444444444444';

const NOW = 1_700_000_000_000;

interface Internals {
  guilds: { _add: (data: object) => Guild };
  users: { _add: (data: object) => never };
}
const internals = (c: Client): Internals => c as unknown as Internals;

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let client: Client;

const operations: GuildOperations = {
  publishPanel: async () => ({
    action: 'not-managed',
    messageId: undefined,
    reactionsSeeded: 0,
    reactionsFailed: [],
  }),
  grantAdoptionAllowance: () => {},
  adoptionAllowance: () => 0,
};

const channelPayload = (
  id: string,
  permissionOverwrites: readonly { id: string; deny: string }[],
) => ({
  id,
  guild_id: GUILD,
  type: ChannelType.GuildText,
  name: `channel-${id}`,
  position: 0,
  permission_overwrites: permissionOverwrites.map((overwrite) => ({
    id: overwrite.id,
    type: 0,
    allow: '0',
    deny: overwrite.deny,
  })),
});

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });

  client = new Client(buildClientOptions(() => BOT));
  const mutable = client as unknown as { user: unknown };
  mutable.user = internals(client).users._add({
    id: BOT,
    username: 'bananasaurs',
    discriminator: '0',
  });

  // The bot role can view and read everywhere by default; each channel below
  // denies at most one of the two, so the reason names the exact denial.
  // (Deliberately not Administrator: it bypasses channel overwrites, which
  // would make every denial invisible.)
  const rolePermissions = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.SendMessages,
  ]).bitfield.toString();
  internals(client).guilds._add({
    id: GUILD,
    name: 'test guild',
    owner_id: OWNER,
    member_count: 30,
    channels: [
      channelPayload(NO_VIEW, [
        { id: BOT_ROLE, deny: String(PermissionsBitField.Flags.ViewChannel) },
      ]),
      channelPayload(NO_HISTORY, [
        { id: BOT_ROLE, deny: String(PermissionsBitField.Flags.ReadMessageHistory) },
      ]),
      channelPayload(CLEAN, []),
    ],
    roles: [
      { id: GUILD, name: '@everyone', position: 0, permissions: '0', managed: false },
      {
        id: BOT_ROLE,
        name: 'bananasaurs',
        position: 7,
        permissions: rolePermissions,
        managed: true,
      },
    ],
    members: [
      { user: { id: BOT, username: 'bananasaurs', discriminator: '0' }, roles: [BOT_ROLE] },
    ],
    emojis: [],
    unavailable: false,
  });
});

const enable = (...channelIds: string[]): void => {
  for (const channelId of channelIds) {
    archiveRepo.enableChannel(scope, { channelId, attachmentPolicy: 'none', now: NOW });
  }
};

const unreadable = () =>
  opsPortsFor(
    scope,
    t.scopes.instance(),
    operations,
    () => NOW,
    client,
    true,
  ).listUnreadableArchiveChannels();

describe('listUnreadableArchiveChannels', () => {
  it('reports a channel absent from the cache as missing', () => {
    enable(MISSING);

    expect(unreadable()).toEqual([{ channelId: MISSING, reason: 'missing' }]);
  });

  it('reports a channel the bot cannot view as no-view', () => {
    enable(NO_VIEW);

    expect(unreadable()).toEqual([{ channelId: NO_VIEW, reason: 'no-view' }]);
  });

  it('reports a viewable channel the bot cannot read history in as no-history', () => {
    enable(NO_HISTORY);

    expect(unreadable()).toEqual([{ channelId: NO_HISTORY, reason: 'no-history' }]);
  });

  it('reports nothing for a channel the bot can read', () => {
    enable(CLEAN);

    expect(unreadable()).toEqual([]);
  });

  it('reports each enabled channel under its own reason and stays silent on the clean one', () => {
    enable(MISSING, NO_VIEW, NO_HISTORY, CLEAN);

    expect(unreadable()).toEqual([
      { channelId: MISSING, reason: 'missing' },
      { channelId: NO_VIEW, reason: 'no-view' },
      { channelId: NO_HISTORY, reason: 'no-history' },
    ]);
  });
});

describe('accountOpsFor', () => {
  const instance = () => t.scopes.instance();
  const ops = () => accountOpsFor(instance(), [], () => NOW);

  const seedAccount = (
    accountId: string,
    username: string,
    over: { isOwner?: boolean; now?: number; passwordHash?: string } = {},
  ): void => {
    accountRepo.createAccount(instance(), {
      accountId,
      username,
      passwordHash: over.passwordHash ?? '$argon2id$fake',
      isOwner: over.isOwner ?? false,
      now: over.now ?? NOW,
    });
  };

  const seedClient = (clientId = 'client-1'): void => {
    oauthRepo.createClient(instance(), {
      clientId,
      clientName: `name of ${clientId}`,
      redirectUris: ['https://example.test/cb'],
      createdAt: NOW,
      createdByAccountId: null,
      registrationSource: 'dynamic',
    });
  };

  const seedToken = (tokenId: string, accountId: string): void => {
    oauthRepo.createToken(instance(), {
      tokenId,
      tokenHash: `hash-${tokenId}`,
      kind: 'access',
      clientId: 'client-1',
      accountId,
      scopes: ['bananasaurs:read'],
      createdAt: NOW,
      expiresAt: NOW + 100_000,
      parentTokenId: null,
      issuedFromCodeHash: `code-for-${tokenId}`,
    });
  };

  it('accountList never exposes a password hash', () => {
    seedAccount('acct_sentinel00000000000000000000001', 'sentinel', {
      passwordHash: '$argon2id$v=19$SENTINEL',
    });

    const rows = ops().accountList();
    expect(JSON.stringify(rows)).not.toContain('SENTINEL');
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('passwordHash');
    }
  });

  it('accountList returns every account with its disabled, isOwner, lockedUntil and createdAt intact', () => {
    seedAccount('acct_owner00000000000000000000000001', 'owner-one', {
      isOwner: true,
      now: NOW - 2000,
    });
    seedAccount('acct_member0000000000000000000000001', 'member-one', {
      isOwner: false,
      now: NOW - 1000,
    });
    accountRepo.setAccountDisabled(instance(), {
      accountId: 'acct_member0000000000000000000000001',
      disabled: true,
    });
    accountRepo.recordFailedAttempt(instance(), {
      accountId: 'acct_owner00000000000000000000000001',
      now: NOW,
      maxAttempts: 1,
      lockoutMs: 900_000,
    });

    const rows = ops().accountList();
    expect(rows.map((r) => r.username)).toEqual(['owner-one', 'member-one']);
    const owner = rows.find((r) => r.username === 'owner-one');
    const member = rows.find((r) => r.username === 'member-one');
    expect(owner).toMatchObject({
      accountId: 'acct_owner00000000000000000000000001',
      isOwner: true,
      disabled: false,
      lockedUntil: NOW + 900_000,
      createdAt: NOW - 2000,
    });
    expect(member).toMatchObject({
      accountId: 'acct_member0000000000000000000000001',
      isOwner: false,
      disabled: true,
      lockedUntil: null,
      createdAt: NOW - 1000,
    });
  });

  it("accountSetDisabled('nobody') returns no-such-account and writes nothing", () => {
    seedAccount('acct_keeper0000000000000000000000001', 'keeper');

    expect(ops().accountSetDisabled('nobody', true)).toBe('no-such-account');
    expect(accountRepo.findAccountByUsername(instance(), 'keeper')?.disabled).toBe(false);
  });

  it('accountSetDisabled reports changed on the first write and not on a repeat', () => {
    seedAccount('acct_toggle0000000000000000000000001', 'toggle');

    const first = ops().accountSetDisabled('toggle', true);
    expect(first).toMatchObject({ changed: true, disabled: true, username: 'toggle' });
    const second = ops().accountSetDisabled('toggle', true);
    expect(second).toMatchObject({ changed: false, disabled: true });
  });

  it('accountSetDisabled reports enabledOwnersRemaining after the write', () => {
    seedAccount('acct_soloowner00000000000000000000001', 'solo', { isOwner: true });

    const only = ops().accountSetDisabled('solo', true);
    expect(only).toMatchObject({ disabled: true, enabledOwnersRemaining: 0 });

    accountRepo.setAccountDisabled(instance(), {
      accountId: 'acct_soloowner00000000000000000000001',
      disabled: false,
    });
    seedAccount('acct_secondowner000000000000000000001', 'second', { isOwner: true });
    const oneLeft = ops().accountSetDisabled('solo', true);
    expect(oneLeft).toMatchObject({ disabled: true, enabledOwnersRemaining: 1 });
  });

  it('accountSetDisabled on an account deleted from under it returns no-such-account', () => {
    seedAccount('acct_gone00000000000000000000000001', 'gone');
    accountRepo.deleteAccount(instance(), {
      accountId: 'acct_gone00000000000000000000000001',
      now: NOW,
    });

    expect(ops().accountSetDisabled('gone', true)).toBe('no-such-account');
  });

  it('accountDelete returns accountsRemaining counted after the delete', () => {
    seedAccount('acct_remain1000000000000000000000001', 'remain-one');
    seedAccount('acct_remain2000000000000000000000001', 'remain-two');

    const result = ops().accountDelete('remain-one');
    expect(result).toMatchObject({ username: 'remain-one', accountsRemaining: 1 });
  });

  it("accountDelete('nobody') returns no-such-account", () => {
    seedAccount('acct_keeper0000000000000000000000002', 'keeper');

    expect(ops().accountDelete('nobody')).toBe('no-such-account');
    expect(accountRepo.findAccountByUsername(instance(), 'keeper')).not.toBeUndefined();
  });

  it('accountDelete reports the token count the repository revoked', () => {
    seedAccount('acct_tokenowner0000000000000000000001', 'token-owner', { isOwner: true });
    seedClient();
    seedToken('token-one', 'acct_tokenowner0000000000000000000001');
    seedToken('token-two', 'acct_tokenowner0000000000000000000001');

    const result = ops().accountDelete('token-owner');
    expect(result).toMatchObject({
      username: 'token-owner',
      accountId: 'acct_tokenowner0000000000000000000001',
      wasOwner: true,
      tokensRevoked: 2,
    });
    expect(accountRepo.findAccountByUsername(instance(), 'token-owner')).toBeUndefined();
  });

  it('accountDelete reports enabledOwnersRemaining after the delete', () => {
    seedAccount('acct_delowner100000000000000000000001', 'del-one', { isOwner: true });
    seedAccount('acct_delowner200000000000000000000001', 'del-two', { isOwner: true });

    const result = ops().accountDelete('del-one');
    expect(result).toMatchObject({ username: 'del-one', enabledOwnersRemaining: 1 });
  });
});

describe('accountRevokeCredentials (M3c)', () => {
  const GUILD_2 = parseGuildId('311111111111111111');
  const instance = () => t.scopes.instance();
  const guildB = () => t.scopes.forGuild(GUILD_2);

  const seedAccount = (
    accountId: string,
    username: string,
    over: { isOwner?: boolean; now?: number; passwordHash?: string } = {},
  ): void => {
    accountRepo.createAccount(instance(), {
      accountId,
      username,
      passwordHash: over.passwordHash ?? '$argon2id$fake',
      isOwner: over.isOwner ?? false,
      now: over.now ?? NOW,
    });
  };

  const openSession = (
    scope: GuildScope,
    sessionIdHash: string,
    accountId: string,
  ): void => {
    sessionRepo.createSession(scope, {
      sessionIdHash,
      accountId,
      createdAt: NOW,
      expiresAt: NOW + 12 * 3_600_000,
      reauthAt: NOW,
      ip: '127.0.0.1',
    });
  };

  beforeEach(() => {
    guildRepo.upsertGuild(guildB(), { name: 'second guild', now: 0 });
  });

  const ops = () => accountOpsFor(instance(), [scope, guildB()], () => NOW);

  it('revokes sessions in every guild and reports guildsTouched', () => {
    seedAccount('acct_alice00000000000000000000000001', 'alice');
    openSession(scope, 'a'.repeat(64), 'acct_alice00000000000000000000000001');
    openSession(guildB(), 'b'.repeat(64), 'acct_alice00000000000000000000000001');

    const result = ops().accountRevokeCredentials('alice');

    expect(result).toMatchObject({
      username: 'alice',
      accountId: 'acct_alice00000000000000000000000001',
      sessionsRevoked: 2,
      guildsTouched: 2,
      stillEnabled: true,
    });
    expect(sessionRepo.findSessionByHash(instance(), 'a'.repeat(64))?.revokedAt).toBe(NOW);
    expect(sessionRepo.findSessionByHash(instance(), 'b'.repeat(64))?.revokedAt).toBe(NOW);
  });

  it('does not revoke another account sessions in either guild', () => {
    seedAccount('acct_alice00000000000000000000000002', 'alice');
    seedAccount('acct_bob0000000000000000000000000002', 'bob');
    openSession(scope, 'c'.repeat(64), 'acct_alice00000000000000000000000002');
    openSession(scope, 'd'.repeat(64), 'acct_bob0000000000000000000000000002');
    openSession(guildB(), 'e'.repeat(64), 'acct_bob0000000000000000000000000002');

    const result = ops().accountRevokeCredentials('alice');

    expect(result).toMatchObject({ sessionsRevoked: 1, guildsTouched: 2 });
    expect(sessionRepo.findSessionByHash(instance(), 'd'.repeat(64))?.revokedAt).toBeNull();
    expect(sessionRepo.findSessionByHash(instance(), 'e'.repeat(64))?.revokedAt).toBeNull();
  });

  it('leaves disabled untouched: enabled stays enabled, disabled stays disabled', () => {
    seedAccount('acct_enabled0000000000000000000000001', 'enabled-one');
    seedAccount('acct_disabled000000000000000000000001', 'disabled-one');
    accountRepo.setAccountDisabled(instance(), {
      accountId: 'acct_disabled000000000000000000000001',
      disabled: true,
    });

    expect(ops().accountRevokeCredentials('enabled-one')).toMatchObject({ stillEnabled: true });
    expect(accountRepo.findAccountByUsername(instance(), 'enabled-one')?.disabled).toBe(false);

    expect(ops().accountRevokeCredentials('disabled-one')).toMatchObject({ stillEnabled: false });
    expect(accountRepo.findAccountByUsername(instance(), 'disabled-one')?.disabled).toBe(true);
  });

  it("returns no-such-account for an unknown username and revokes nothing", () => {
    seedAccount('acct_keeper0000000000000000000000003', 'keeper');
    openSession(scope, 'f'.repeat(64), 'acct_keeper0000000000000000000000003');

    expect(ops().accountRevokeCredentials('nobody')).toBe('no-such-account');
    expect(sessionRepo.findSessionByHash(instance(), 'f'.repeat(64))?.revokedAt).toBeNull();
  });

  it('revokes the account tokens and counts them', () => {
    seedAccount('acct_tokenholder000000000000000000001', 'holder');
    oauthRepo.createClient(instance(), {
      clientId: 'client-1',
      clientName: 'name of client-1',
      redirectUris: ['https://example.test/cb'],
      createdAt: NOW,
      createdByAccountId: null,
      registrationSource: 'dynamic',
    });
    oauthRepo.createToken(instance(), {
      tokenId: 'holder-token',
      tokenHash: 'hash-holder-token',
      kind: 'access',
      clientId: 'client-1',
      accountId: 'acct_tokenholder000000000000000000001',
      scopes: ['bananasaurs:read'],
      createdAt: NOW,
      expiresAt: NOW + 100_000,
      parentTokenId: null,
      issuedFromCodeHash: 'code-holder',
    });

    const result = ops().accountRevokeCredentials('holder');

    expect(result).toMatchObject({ tokensRevoked: 1, stillEnabled: true });
    expect(
      oauthRepo.findTokenById(instance(), 'holder-token')?.revokedAt,
    ).toBe(NOW);
  });
});
