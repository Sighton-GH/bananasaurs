import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, PermissionsBitField } from 'discord.js';
import { buildClientOptions } from '@bananasaurs/discord';
import {
  authorize,
  parseGuildId,
  parseSnowflakeId,
  RateLimiter,
  rolePingAllowed,
  type Authorized,
  type RoleIntent,
} from '@bananasaurs/core';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import {
  accountRepo,
  authzRepo,
  authzStoreFor,
  effectRepo,
  guildRepo,
  schema,
  write,
  type GuildScope,
} from '@bananasaurs/storage';
import { FakeDiscord } from '@bananasaurs/testkit';
import { mcpRoleGatewayFor, roleGrantRefusal, type McpRoleGatewayDeps } from './roles-gateway.js';

/**
 * Task 2: the MCP's own `EffectGateway` instance over real storage, a
 * discord.js client cache built the way `wiring.test.ts` builds one
 * (`guilds._add`), and `FakeDiscord` as the REST port.
 *
 * What this proves: the grant policy (including the live floor) refuses
 * before any Discord call, MCP rate overflow refuses as `rate-cap` while
 * the guild breaker stays closed, the standard protected-target refusal
 * still applies, and the audit row lands as `mcp_operator`.
 */

const GUILD = parseGuildId('111111111111111111');
const BOT = '123456789012345678';
const BOT_ROLE = '511111111111111111';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';

const LOW_ROLE = parseSnowflakeId('522222222222222222');
const ABOVE_ROLE = parseSnowflakeId('533333333333333333');
const MANAGED_ROLE = parseSnowflakeId('555555555555555555');
const DANGEROUS_ROLE = parseSnowflakeId('566666666666666666');
const ALLOW_ROLE = parseSnowflakeId('577777777777777777');
const FLOOR_ROLE = parseSnowflakeId('588888888888888888');
/** In `FakeDiscord` only — missing from the client cache, so fail closed. */
const GHOST_ROLE = parseSnowflakeId('599999999999999999');

const OWNER = parseSnowflakeId('345678901234567890');

/** The bot role's raw position; `FakeDiscord` compares it literally. */
const BOT_TOP = 10;

let t: MigratedTestDatabase;
let scope: GuildScope;
let clock: number;
let client: Client;
let discord: FakeDiscord;
let triggerSeq: number;
const warns: unknown[][] = [];

const silentLogger = {
  info() {},
  warn(...args: unknown[]) {
    warns.push(args);
  },
  error() {},
  debug() {},
} as never;

const witness = (): Authorized<'roles.mutate'> => {
  const result = authorize(
    {
      store: authzStoreFor(scope),
      guildId: GUILD,
      actor: { type: 'dashboard', id: ACCOUNT, roleIds: [] },
    },
    'roles.mutate',
  );
  if (!result.ok) throw new Error('test setup: dashboard actor lacks roles.mutate');
  return result.value;
};

const intent = (userId: string, roleId: string): RoleIntent => {
  triggerSeq += 1;
  return {
    userId: parseSnowflakeId(userId),
    roleId: parseSnowflakeId(roleId),
    action: 'grant',
    panelId: undefined,
    triggerRef: `900000000000000${String(triggerSeq).padStart(3, '0')}`,
    source: 'mcp',
    batchId: 'batch-mcp',
    reason: 'mcp role grant',
  };
};

const gatewayDeps = (rateLimiter: RateLimiter): McpRoleGatewayDeps => ({
  authz: authzStoreFor(scope),
  rateLimiter,
  logger: silentLogger,
  now: () => clock,
});

const seedClient = (): void => {
  const fresh = new Client(buildClientOptions(() => BOT));
  const mutable = fresh as unknown as { user: unknown };
  const internals = fresh as unknown as {
    guilds: { _add: (data: object) => unknown };
    users: { _add: (data: object) => unknown };
  };
  mutable.user = internals.users._add({ id: BOT, username: 'bananasaurs', discriminator: '0' });
  internals.guilds._add({
    id: GUILD,
    name: 'guild a',
    owner_id: OWNER,
    channels: [],
    // discord.js computes `Role.position` from `rawPosition` ordering (id
    // breaks ties), so every raw position here is distinct — the comments
    // name the computed order position each role lands on.
    roles: [
      { id: GUILD, name: '@everyone', position: 0, permissions: '0', managed: false },
      { id: MANAGED_ROLE, name: 'integration', position: 1, permissions: '0', managed: true },
      {
        id: DANGEROUS_ROLE,
        name: 'janitors',
        position: 2,
        permissions: String(PermissionsBitField.Flags.ManageRoles),
      },
      { id: ALLOW_ROLE, name: 'allowlisted', position: 3, permissions: '0' },
      { id: LOW_ROLE, name: 'helpers', position: 4, permissions: '0' },
      { id: FLOOR_ROLE, name: 'floor-watch', position: 5, permissions: '0' },
      {
        id: BOT_ROLE,
        name: 'bananasaurs',
        position: BOT_TOP,
        permissions: (
          PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.SendMessages
        ).toString(),
        managed: true,
      },
      { id: ABOVE_ROLE, name: 'admins', position: BOT_TOP + 2, permissions: '0' },
    ],
    members: [
      { user: { id: BOT, username: 'bananasaurs', discriminator: '0' }, roles: [BOT_ROLE] },
      { user: { id: OWNER, username: 'owner', discriminator: '0' }, roles: [] },
    ],
    emojis: [],
    unavailable: false,
  });
  client = fresh;
};

const seedAllowlistRow = (roleId: string, purpose: 'grant' | 'ping'): void => {
  t.db
    .insert(schema.mcpRoleAllowlist)
    .values({
      guildId: scope.guildId,
      roleId,
      purpose,
      addedByAccountId: ACCOUNT,
      addedAt: clock,
    })
    .run();
};

const seedGrantMode = (grantMode: 'below-bot' | 'allowlist'): void => {
  t.db
    .insert(schema.mcpRolePolicy)
    .values({ guildId: scope.guildId, grantMode, pingMode: 'below-bot', updatedAt: clock })
    .run();
};

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  clock = 1_700_000_000_000;
  triggerSeq = 0;
  warns.length = 0;

  guildRepo.upsertGuild(scope, { name: 'guild a', now: clock });
  guildRepo.setDryRun(scope, false, clock);

  accountRepo.createAccount(t.scopes.instance(), {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: 'test-hash',
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(scope, ACCOUNT);
  authzRepo.grantAccountCapability(scope, {
    accountId: ACCOUNT,
    capability: 'roles.mutate',
    grantedBy: 'test',
    now: clock,
  });

  effectRepo.openBatch(scope, {
    batchId: 'batch-mcp',
    source: 'dashboard',
    actorType: 'mcp_operator',
    actorId: ACCOUNT,
    now: clock,
  });

  seedClient();

  discord = new FakeDiscord({ guildId: GUILD, botHighestRolePosition: BOT_TOP });
  for (const roleId of [
    LOW_ROLE,
    ABOVE_ROLE,
    MANAGED_ROLE,
    DANGEROUS_ROLE,
    ALLOW_ROLE,
    FLOOR_ROLE,
    GHOST_ROLE,
  ]) {
    discord.defineRole({
      id: roleId,
      name: `role-${roleId}`,
      position: roleId === ABOVE_ROLE ? BOT_TOP + 2 : roleId === LOW_ROLE ? 4 : 2,
      managed: roleId === MANAGED_ROLE,
    });
  }

  // ADR 0118 amendment: an MCP grant needs the role in `managed_roles`
  // (the bot's role allowlist) as well as the MCP grant policy. LOW_ROLE and
  // FLOOR_ROLE are allowlisted, so the policy decides for them; ALLOW_ROLE is
  // deliberately not, so it shows the managed_roles conjunct on its own.
  write(scope, ({ db }) => {
    db.insert(schema.managedRoles).values({ guildId: GUILD, roleId: LOW_ROLE }).run();
    db.insert(schema.managedRoles).values({ guildId: GUILD, roleId: FLOOR_ROLE }).run();
  });
});

afterEach(() => {
  t.close();
});

describe('roleGrantRefusal, over the live client cache', () => {
  it('passes a below-bot role', () => {
    expect(roleGrantRefusal(client, scope, LOW_ROLE)).toBe(true);
  });

  it('refuses above-bot, managed, @everyone and dangerous roles', () => {
    expect(roleGrantRefusal(client, scope, ABOVE_ROLE)).toBe('above-bot');
    expect(roleGrantRefusal(client, scope, MANAGED_ROLE)).toBe('managed-or-everyone');
    expect(roleGrantRefusal(client, scope, GUILD)).toBe('managed-or-everyone');
    expect(roleGrantRefusal(client, scope, DANGEROUS_ROLE)).toBe('dangerous');
  });

  it('at the bot position counts as above (the assignability off-by-one)', () => {
    // discord.js computes `Role.position` from `rawPosition` ordering, so no
    // `_add`-built cache can hold two roles at exactly the same position —
    // the boundary itself is pinned against the pure rule instead.
    expect(
      rolePingAllowed(
        {
          id: LOW_ROLE,
          position: BOT_TOP,
          permissions: 0n,
          managed: false,
          isEveryone: false,
        },
        BOT_TOP,
        'below-bot',
        false,
      ),
    ).toBe('above-bot');
  });

  it('fails closed for a role missing from the cache', () => {
    expect(roleGrantRefusal(client, scope, GHOST_ROLE)).toBe('not-allowlisted');
  });

  it('in allowlist mode a ping row does not satisfy grant, a grant row does', () => {
    seedGrantMode('allowlist');
    seedAllowlistRow(ALLOW_ROLE, 'ping');
    expect(roleGrantRefusal(client, scope, ALLOW_ROLE)).toBe('not-allowlisted');
    seedAllowlistRow(ALLOW_ROLE, 'grant');
    expect(roleGrantRefusal(client, scope, ALLOW_ROLE)).toBe(true);
  });
});

describe('mcpRoleGatewayFor', () => {
  it('never trips: mcp bucket overflow refuses as rate-cap with the breaker still closed', async () => {
    const gateway = mcpRoleGatewayFor(gatewayDeps(new RateLimiter(2)), client, discord, scope);
    const members = ['611111111111111111', '622222222222222222', '633333333333333333'];
    for (const member of members) discord.defineMember(member, []);

    const first = await gateway.applyRoleEffect(witness(), intent(members[0]!, LOW_ROLE));
    const second = await gateway.applyRoleEffect(witness(), intent(members[1]!, LOW_ROLE));
    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');

    const refused = await gateway.applyRoleEffect(witness(), intent(members[2]!, LOW_ROLE));
    expect(refused).toEqual({ status: 'refused', reason: 'rate-cap' });

    // The breaker is still closed — the no-op trip never called
    // `guildRepo.tripBreaker` — and the refused grant made no Discord call.
    expect(guildRepo.readSafetyState(scope)?.breakerOpen).toBe(false);
    expect(discord.restCalls('addRole')).toHaveLength(2);

    // One warn line from the no-op trip, carrying guild id and reason only.
    const trips = warns.filter((args) => JSON.stringify(args).includes('breaker left closed'));
    expect(trips).toHaveLength(1);
    expect(JSON.stringify(trips[0])).toContain(GUILD);
    expect(JSON.stringify(trips[0])).toContain('rate cap exceeded');
  });

  it('applies a below-bot grant and refuses the rest without a Discord call', async () => {
    const gateway = mcpRoleGatewayFor(gatewayDeps(new RateLimiter(100)), client, discord, scope);
    const members = [
      '611111111111111111',
      '622222222222222222',
      '633333333333333333',
      '644444444444444444',
      '655555555555555555',
      '666666666666666666',
    ];
    for (const member of members) discord.defineMember(member, []);

    const applied = await gateway.applyRoleEffect(witness(), intent(members[0]!, LOW_ROLE));
    expect(applied.status).toBe('applied');

    const cases = [ABOVE_ROLE, MANAGED_ROLE, GUILD, DANGEROUS_ROLE, GHOST_ROLE];
    for (const [index, roleId] of cases.entries()) {
      const outcome = await gateway.applyRoleEffect(witness(), intent(members[index + 1]!, roleId));
      expect(outcome).toEqual({ status: 'refused', reason: 'role-not-allowlisted' });
    }

    // Only the passing grant reached Discord.
    expect(discord.restCalls('addRole')).toHaveLength(1);
  });

  it('a role passing the grant policy but not in managed_roles is refused, then applies once allowlisted', async () => {
    // ALLOW_ROLE is below the bot and passes the default below-bot policy.
    expect(roleGrantRefusal(client, scope, ALLOW_ROLE)).toBe(true);
    const gateway = mcpRoleGatewayFor(gatewayDeps(new RateLimiter(100)), client, discord, scope);
    discord.defineMember('611111111111111111', []);
    discord.defineMember('622222222222222222', []);

    const refused = await gateway.applyRoleEffect(
      witness(),
      intent('611111111111111111', ALLOW_ROLE),
    );
    expect(refused).toEqual({ status: 'refused', reason: 'role-not-allowlisted' });
    expect(discord.restCalls('addRole')).toHaveLength(0);

    write(scope, ({ db }) => {
      db.insert(schema.managedRoles).values({ guildId: GUILD, roleId: ALLOW_ROLE }).run();
    });
    const applied = await gateway.applyRoleEffect(
      witness(),
      intent('622222222222222222', ALLOW_ROLE),
    );
    expect(applied.status).toBe('applied');
    expect(discord.restCalls('addRole')).toHaveLength(1);
  });

  it('the floor is live: a role that gains ManageRoles is refused on the next call', async () => {
    expect(roleGrantRefusal(client, scope, FLOOR_ROLE)).toBe(true);

    const guild = client.guilds.cache.get(GUILD);
    const role = guild?.roles.cache.get(FLOOR_ROLE) as unknown as {
      permissions: PermissionsBitField;
    };
    if (role === undefined) throw new Error('test setup: floor role missing from cache');
    role.permissions = new PermissionsBitField(PermissionsBitField.Flags.ManageRoles);

    expect(roleGrantRefusal(client, scope, FLOOR_ROLE)).toBe('dangerous');

    const gateway = mcpRoleGatewayFor(gatewayDeps(new RateLimiter(100)), client, discord, scope);
    discord.defineMember('611111111111111111', []);
    const outcome = await gateway.applyRoleEffect(
      witness(),
      intent('611111111111111111', FLOOR_ROLE),
    );
    expect(outcome).toEqual({ status: 'refused', reason: 'role-not-allowlisted' });
    expect(discord.restCalls('addRole')).toHaveLength(0);
  });

  it('the standard protected-target refusal still applies to the guild owner', async () => {
    const gateway = mcpRoleGatewayFor(gatewayDeps(new RateLimiter(100)), client, discord, scope);
    discord.defineMember(OWNER, [], true);

    const outcome = await gateway.applyRoleEffect(witness(), intent(OWNER, LOW_ROLE));
    expect(outcome).toEqual({ status: 'refused', reason: 'protected-target' });
    expect(discord.restCalls('addRole')).toHaveLength(0);
  });

  it('the audit row records actor_type mcp_operator', async () => {
    const gateway = mcpRoleGatewayFor(gatewayDeps(new RateLimiter(100)), client, discord, scope);
    discord.defineMember('611111111111111111', []);

    const outcome = await gateway.applyRoleEffect(
      witness(),
      intent('611111111111111111', LOW_ROLE),
    );
    expect(outcome.status).toBe('applied');

    const row = effectRepo.tailAudit(scope).find((entry) => entry.action === 'role.grant');
    expect(row).toMatchObject({ actorType: 'mcp_operator', actorId: ACCOUNT });
  });
});
