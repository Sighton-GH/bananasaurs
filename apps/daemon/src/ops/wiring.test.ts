import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelType, Client, PermissionsBitField, type Guild } from 'discord.js';
import { parseGuildId, type Config } from '@bananasaurs/core';
import { buildClientOptions } from '@bananasaurs/discord';
import {
  accountRepo,
  archiveRepo,
  guildRepo,
  mcpSendRepo,
  oauthRepo,
  sessionRepo,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import type { GuildOperations } from '../runtime/guild.js';
import { accountOpsFor, opsInstanceFor, opsPortsFor } from './wiring.js';
// By relative path rather than the `@bananasaurs/http/test-support` subpath:
// vitest aliases `@bananasaurs/http` to the package index, so the subpath
// would resolve under it and break (see `mcp/wiring.test.ts`).
import { verifyPassword } from '@bananasaurs/http';
import { testPortsFor } from '../../../../packages/http/src/test-support.js';

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
/** A voice channel of the guild: accepted (ruling M6-D6), not refused. */
const VOICE = '655555555555555555';

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
      // A voice channel's text chat: discord.js reports it as text-based
      // (BaseGuildVoiceChannel carries a GuildMessageManager), so the
      // allow-time check accepts it (ruling M6-D6).
      {
        id: VOICE,
        guild_id: GUILD,
        type: ChannelType.GuildVoice,
        name: `channel-${VOICE}`,
        position: 3,
        permission_overwrites: [],
      },
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

describe('allowSendChannel (C2 allow-time)', () => {
  /** A snowflake in no guild's channel cache: the DM shape C2 is about. */
  const DM_SHAPED = '700000000000000001';
  const UNKNOWN = '799999999999999999';

  const sendPorts = () =>
    opsPortsFor(scope, t.scopes.instance(), operations, () => NOW, client, true);

  it('allows a text channel of the guild', () => {
    expect(sendPorts().allowSendChannel({ channelId: CLEAN, accountId: 'tester' })).toBe('allowed');
    expect(mcpSendRepo.isChannelAllowed(scope, CLEAN)).toBe(true);
  });

  it('accepts a voice channel of the guild: the check means text-capable, not text-only (M6-D6)', () => {
    // Pinned rather than incidental: discord.js reports voice and stage
    // channels as `isTextBased()` because they carry a `messages` manager, so
    // `isTextChannelOfGuild` accepts them. In-guild and owner-opted-in per
    // channel, so posting to the voice channel's text chat is legitimate.
    expect(sendPorts().allowSendChannel({ channelId: VOICE, accountId: 'tester' })).toBe('allowed');
    expect(mcpSendRepo.isChannelAllowed(scope, VOICE)).toBe(true);
  });

  it('reports already-allowed on a repeat without duplicating the row', () => {
    const ports = sendPorts();
    expect(ports.allowSendChannel({ channelId: CLEAN, accountId: 'tester' })).toBe('allowed');
    expect(ports.allowSendChannel({ channelId: CLEAN, accountId: 'tester' })).toBe(
      'already-allowed',
    );
  });

  it('refuses a DM-shaped id and writes no row', () => {
    expect(sendPorts().allowSendChannel({ channelId: DM_SHAPED, accountId: 'tester' })).toBe(
      'no-such-channel',
    );
    expect(mcpSendRepo.isChannelAllowed(scope, DM_SHAPED)).toBe(false);
  });

  it('refuses an unknown channel id and writes no row', () => {
    expect(sendPorts().allowSendChannel({ channelId: UNKNOWN, accountId: 'tester' })).toBe(
      'no-such-channel',
    );
    expect(mcpSendRepo.isChannelAllowed(scope, UNKNOWN)).toBe(false);
  });

  it('names the N2 gap: test-support writes the row the daemon refuses', () => {
    // N2. `testPortsFor` (`packages/http/src/test-support.ts`) implements the
    // same `OpsPorts` interface with no guild-membership check: it may not
    // import a Discord client (ADR 0014), and no dashboard route reaches
    // `allowSendChannel`, so an injected channel set would be machinery with
    // no caller — a default-allow set would be theater, a default-deny one
    // would break the real-repo behaviour the route tests rely on. The gap is
    // pinned here instead of closed there: the DM-shaped id the daemon's
    // implementation refuses is allowed by test-support, and the send-time
    // check (C2) is what contains any such row before it can reach Discord.
    //
    // Production uses the daemon's implementation: `runtime/daemon.ts`'s
    // `contextFor` builds `opsPortsFor` with the live client, while
    // `testPortsFor` is imported only by tests.
    const httpPorts = testPortsFor(scope, () => NOW);
    expect(httpPorts.allowSendChannel({ channelId: DM_SHAPED, accountId: 'tester' })).toBe(
      'allowed',
    );
    expect(mcpSendRepo.isChannelAllowed(scope, DM_SHAPED)).toBe(true);
    // The daemon's check runs before any read of the row, so the row written
    // above changes nothing about its answer.
    expect(sendPorts().allowSendChannel({ channelId: DM_SHAPED, accountId: 'tester' })).toBe(
      'no-such-channel',
    );
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

  const openSession = (scope: GuildScope, sessionIdHash: string, accountId: string): void => {
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

  it('returns no-such-account for an unknown username and revokes nothing', () => {
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
    expect(oauthRepo.findTokenById(instance(), 'holder-token')?.revokedAt).toBe(NOW);
  });

  it('deletes the account unexchanged codes, counts them, and leaves another account codes alone', () => {
    seedAccount('acct_codeholder0000000000000000000001', 'code-holder');
    seedAccount('acct_codeother00000000000000000000001', 'code-other');
    oauthRepo.createClient(instance(), {
      clientId: 'client-1',
      clientName: 'name of client-1',
      redirectUris: ['https://example.test/cb'],
      createdAt: NOW,
      createdByAccountId: null,
      registrationSource: 'dynamic',
    });
    const seedCode = (codeHash: string, accountId: string): void => {
      oauthRepo.createAuthorizationCode(instance(), {
        codeHash,
        clientId: 'client-1',
        accountId,
        scopes: ['bananasaurs:read'],
        codeChallenge: 'challenge',
        redirectUri: 'https://example.test/cb',
        createdAt: NOW,
        expiresAt: NOW + 300_000,
      });
    };
    seedCode('code-holder-1', 'acct_codeholder0000000000000000000001');
    seedCode('code-holder-2', 'acct_codeholder0000000000000000000001');
    seedCode('code-other-1', 'acct_codeother00000000000000000000001');

    const result = ops().accountRevokeCredentials('code-holder');

    expect(result).toMatchObject({ codesDeleted: 2, stillEnabled: true });
    expect(oauthRepo.findAuthorizationCode(instance(), 'code-holder-1')).toBeUndefined();
    expect(oauthRepo.findAuthorizationCode(instance(), 'code-holder-2')).toBeUndefined();
    expect(oauthRepo.findAuthorizationCode(instance(), 'code-other-1')).toBeDefined();
  });
});

describe('accountGrantGuild / accountRevokeGuild (S13-D1/D2)', () => {
  const GUILD_2 = parseGuildId('311111111111111111');
  const instance = () => t.scopes.instance();
  const guildB = () => t.scopes.forGuild(GUILD_2);

  const seedAccount = (accountId: string, username: string): void => {
    accountRepo.createAccount(instance(), {
      accountId,
      username,
      passwordHash: '$argon2id$fake',
      isOwner: false,
      now: NOW,
    });
  };

  const portsA = () =>
    opsPortsFor(scope, instance(), operations, () => NOW, client, true);
  const portsB = () =>
    opsPortsFor(guildB(), instance(), operations, () => NOW, client, true);

  it("grant returns no-such-account for an unknown username and writes nothing", () => {
    expect(portsA().accountGrantGuild('nobody')).toBe('no-such-account');
    expect(portsA().accountRevokeGuild('nobody')).toBe('no-such-account');
  });

  it('grant then re-grant answers granted, then already-had-it, with one row', () => {
    seedAccount('acct_grant00000000000000000000000001', 'grantee');

    expect(portsA().accountGrantGuild('grantee')).toBe('granted');
    expect(accountRepo.hasGuildAccess(scope, 'acct_grant00000000000000000000000001')).toBe(true);
    expect(portsA().accountGrantGuild('grantee')).toBe('already-had-it');
  });

  it('the grant names one guild: a grant in A leaves B unreached (S13-D1)', () => {
    seedAccount('acct_secondguild000000000000000000001', 'second-guild');
    guildRepo.upsertGuild(guildB(), { name: 'second guild', now: 0 });

    expect(portsA().accountGrantGuild('second-guild')).toBe('granted');
    expect(
      accountRepo.hasGuildAccess(scope, 'acct_secondguild000000000000000000001'),
    ).toBe(true);
    expect(
      accountRepo.hasGuildAccess(guildB(), 'acct_secondguild000000000000000000001'),
    ).toBe(false);
  });

  it('revoke then re-revoke answers revoked, then did-not-have-it', () => {
    seedAccount('acct_revoke0000000000000000000000001', 'revokee');
    accountRepo.grantGuildAccess(scope, 'acct_revoke0000000000000000000000001');

    expect(portsA().accountRevokeGuild('revokee')).toBe('revoked');
    expect(accountRepo.hasGuildAccess(scope, 'acct_revoke0000000000000000000000001')).toBe(false);
    expect(portsA().accountRevokeGuild('revokee')).toBe('did-not-have-it');
  });

  it('revoking a guild the account never had is did-not-have-it, not revoked', () => {
    seedAccount('acct_stranger0000000000000000000000001', 'stranger');

    expect(portsA().accountRevokeGuild('stranger')).toBe('did-not-have-it');
  });
});

describe('accountSetPassword (S13-D3/D4)', () => {
  const GUILD_2 = parseGuildId('411111111111111111');
  const instance = () => t.scopes.instance();
  const guildB = () => t.scopes.forGuild(GUILD_2);

  const seedAccount = (accountId: string, username: string): void => {
    accountRepo.createAccount(instance(), {
      accountId,
      username,
      passwordHash: '$argon2id$old-password',
      isOwner: false,
      now: NOW,
    });
  };

  const openSession = (guildScope: GuildScope, sessionIdHash: string, accountId: string): void => {
    sessionRepo.createSession(guildScope, {
      sessionIdHash,
      accountId,
      createdAt: NOW,
      expiresAt: NOW + 12 * 3_600_000,
      reauthAt: NOW,
      ip: '127.0.0.1',
    });
  };

  const seedToken = (tokenId: string, accountId: string): void => {
    oauthRepo.createClient(instance(), {
      clientId: 'client-1',
      clientName: 'name of client-1',
      redirectUris: ['https://example.test/cb'],
      createdAt: NOW,
      createdByAccountId: null,
      registrationSource: 'dynamic',
    });
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

  const ops = () => accountOpsFor(instance(), [scope, guildB()], () => NOW);

  it("returns no-such-account for an unknown username and writes nothing", async () => {
    seedAccount('acct_keeper0000000000000000000000004', 'keeper');

    expect(await ops().accountSetPassword('nobody')).toBe('no-such-account');
    expect(
      accountRepo.findAccountByUsername(instance(), 'keeper')?.passwordHash,
    ).toBe('$argon2id$old-password');
  });

  it('stores a hash the generated password verifies against, and nothing else retrievable', async () => {
    seedAccount('acct_reset00000000000000000000000001', 'resettable');

    const result = await ops().accountSetPassword('resettable');
    expect(result).not.toBe('no-such-account');
    if (result === 'no-such-account') return;
    expect(result).toMatchObject({
      username: 'resettable',
      accountId: 'acct_reset00000000000000000000000001',
      guildsTouched: 2,
    });
    // The stored row holds a hash the generated password verifies against —
    // the plaintext itself is in the result and nowhere else.
    const stored = accountRepo.findAccountByUsername(instance(), 'resettable');
    expect(stored?.passwordHash).not.toBe('$argon2id$old-password');
    expect(stored?.passwordHash).not.toContain(result.password);
    expect(await verifyPassword(stored?.passwordHash ?? '', result.password)).toBe(true);
  });

  it('revokes dashboard sessions in every guild and leaves OAuth tokens live', async () => {
    seedAccount('acct_sweep00000000000000000000000001', 'swept');
    openSession(scope, 'a'.repeat(64), 'acct_sweep00000000000000000000000001');
    openSession(guildB(), 'b'.repeat(64), 'acct_sweep00000000000000000000000001');
    seedToken('swept-token', 'acct_sweep00000000000000000000000001');

    const result = await ops().accountSetPassword('swept');
    expect(result).toMatchObject({ sessionsRevoked: 2, guildsTouched: 2 });
    expect(sessionRepo.findSessionByHash(instance(), 'a'.repeat(64))?.revokedAt).toBe(NOW);
    expect(sessionRepo.findSessionByHash(instance(), 'b'.repeat(64))?.revokedAt).toBe(NOW);
    // S13-D4: OAuth tokens are bound to the account, not the password.
    expect(oauthRepo.findTokenById(instance(), 'swept-token')?.revokedAt).toBeNull();
  });
});

describe('providerEligibilityWarnings (ADR 0044 §7)', () => {
  // Instance-level like `mcpClients`: the eligibility row is a fact about the
  // daemon, not a guild — so this goes through `opsInstanceFor` against the
  // real migrated database (whose migration seeds one `no` row), with the
  // review clock passed as `nowMs`, the same injected-clock shape as `now`.
  // Raw SQL updates the row because the repository is deliberately read-only
  // (ruling M4-D16: changing it later is a new migration, not an edit).
  const DAY_MS = 24 * 60 * 60 * 1000;
  const SEEDED = 'anthropic-consumer-mcp';

  const instanceOps = () =>
    opsInstanceFor({
      config: { BANANASAURS_READONLY: false, BANANASAURS_ENV: 'test' } as unknown as Config,
      client,
      startedAtMs: NOW,
      instanceScope: t.scopes.instance(),
      guildScopes: [],
      now: () => NOW,
      backupTimer: {
        runOnce: () => ({ ok: false as const, error: 'not used by this test' }),
        start: () => {},
        stop: () => {},
      },
    });

  const setReviewedAt = (provider: string, reviewedAt: number): void => {
    t.raw
      .prepare(`UPDATE provider_eligibility SET reviewed_at = ? WHERE provider = ?`)
      .run(reviewedAt, provider);
  };

  const setTrainsOnInput = (provider: string, value: string): void => {
    t.raw
      .prepare(`UPDATE provider_eligibility SET trains_on_input = ? WHERE provider = ?`)
      .run(value, provider);
  };

  const setProductionUseAllowed = (provider: string, value: number): void => {
    t.raw
      .prepare(`UPDATE provider_eligibility SET production_use_allowed = ? WHERE provider = ?`)
      .run(value, provider);
  };

  it("warns 'stale' for a row reviewed 91 days before now, and nothing for 89 days", () => {
    setReviewedAt(SEEDED, NOW - 91 * DAY_MS);
    expect(instanceOps().providerEligibilityWarnings(NOW)).toEqual([
      {
        provider: SEEDED,
        reason: 'stale',
        trainsOnInput: 'no',
        reviewedAt: NOW - 91 * DAY_MS,
      },
    ]);

    setReviewedAt(SEEDED, NOW - 89 * DAY_MS);
    expect(instanceOps().providerEligibilityWarnings(NOW)).toEqual([]);
  });

  it("warns 'not-no' for 'unknown' and for 'yes' — 'unknown' is visibly treated as 'yes'", () => {
    setTrainsOnInput(SEEDED, 'unknown');
    expect(instanceOps().providerEligibilityWarnings(NOW)).toEqual([
      {
        provider: SEEDED,
        reason: 'not-no',
        trainsOnInput: 'unknown',
        reviewedAt: 1789344000000,
      },
    ]);

    setTrainsOnInput(SEEDED, 'yes');
    expect(instanceOps().providerEligibilityWarnings(NOW)).toEqual([
      {
        provider: SEEDED,
        reason: 'not-no',
        trainsOnInput: 'yes',
        reviewedAt: 1789344000000,
      },
    ]);

    setTrainsOnInput(SEEDED, 'no');
    expect(instanceOps().providerEligibilityWarnings(NOW)).toEqual([]);
  });

  it("warns 'not-production' for a row with production_use_allowed = 0", () => {
    setProductionUseAllowed(SEEDED, 0);
    expect(instanceOps().providerEligibilityWarnings(NOW)).toEqual([
      {
        provider: SEEDED,
        reason: 'not-production',
        trainsOnInput: 'no',
        reviewedAt: 1789344000000,
      },
    ]);

    setProductionUseAllowed(SEEDED, 1);
    expect(instanceOps().providerEligibilityWarnings(NOW)).toEqual([]);
  });

  it("reports 'not-no' for a row that is both not-'no' and not-production", () => {
    setTrainsOnInput(SEEDED, 'yes');
    setProductionUseAllowed(SEEDED, 0);
    expect(instanceOps().providerEligibilityWarnings(NOW)).toEqual([
      {
        provider: SEEDED,
        reason: 'not-no',
        trainsOnInput: 'yes',
        reviewedAt: 1789344000000,
      },
    ]);
  });
});

describe('providerReview (ruling M4-D20)', () => {
  const SEEDED = 'anthropic-consumer-mcp';

  const instanceOps = () =>
    opsInstanceFor({
      config: { BANANASAURS_READONLY: false, BANANASAURS_ENV: 'test' } as unknown as Config,
      client,
      startedAtMs: NOW,
      instanceScope: t.scopes.instance(),
      guildScopes: [],
      now: () => NOW,
      backupTimer: {
        runOnce: () => ({ ok: false as const, error: 'not used by this test' }),
        start: () => {},
        stop: () => {},
      },
    });

  it('writes reviewed_at and returns the confirmed claims with the previous date', () => {
    const result = instanceOps().providerReview(SEEDED);
    expect(result).toEqual({
      provider: SEEDED,
      trainsOnInput: 'no',
      evidenceUrl: 'https://claude.ai/settings/data-privacy-controls',
      productionUseAllowed: true,
      reviewedAt: NOW,
      previouslyReviewedAt: 1789344000000,
    });
    expect(instanceOps().providerEligibilityWarnings(NOW)).toEqual([]);
  });

  it("answers 'no-such-provider' for an unknown provider", () => {
    expect(instanceOps().providerReview('no-such-provider')).toBe('no-such-provider');
  });
});

describe('probePublicSurface (ruling M6-D1)', () => {
  const instanceOps = (config: Partial<Config>) =>
    opsInstanceFor({
      config: {
        BANANASAURS_READONLY: false,
        BANANASAURS_ENV: 'test',
        ...config,
      } as unknown as Config,
      client,
      startedAtMs: NOW,
      instanceScope: t.scopes.instance(),
      guildScopes: [],
      now: () => NOW,
      backupTimer: {
        runOnce: () => ({ ok: false as const, error: 'not used by this test' }),
        start: () => {},
        stop: () => {},
      },
    });

  it('probes nothing and is ok when MCP_PUBLIC_URL is unset — no fetch, no failure', async () => {
    // The short-circuit happens before any `fetch`, so this reaches no
    // network even though the implementation holds the global fetch: a daemon
    // that has not opted into the tunnel has no surface to check.
    const report = await instanceOps({}).probePublicSurface();
    expect(report.probed).toBe(false);
    expect(report.ok).toBe(true);
    expect(report.text).toBe('public surface    not probed (MCP_PUBLIC_URL unset)');
  });
});
