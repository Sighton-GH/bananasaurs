import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  createReactionSubscriber,
  EffectGateway,
  panelDefinitionSchema,
  parseGuildId,
  parseSnowflakeId,
  Pipeline,
  RateLimiter,
  unicodeEmojiKey,
  type EffectGatewayDeps,
  type PanelDefinition,
} from '@bananasaurs/core';
import {
  authzStoreFor,
  effectRepo,
  guildRepo,
  isTargetProtected,
  panelRepo,
  pipelineRepo,
  read,
  schema,
  write,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { BOT_USER_ID, FakeDiscord } from '@bananasaurs/testkit';
import { panelAuthorization, panelEffectsFor, panelStoreFor } from './panels/wiring.js';

/**
 * Every behaviour on an adopted panel, including its refusal path.
 *
 * Managed panels are covered by `managed-panels.integration.test.ts`; this is
 * the reaction side, where the interesting case lives — amendment 6's one
 * expensive path, an adopted panel with `max_roles`, which is the only reaction
 * flow that has to read the whole reaction set rather than the single emoji the
 * event carried.
 */

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = parseSnowflakeId('222222222222222222');
const MESSAGE = parseSnowflakeId('333333333333333333');
const AUTHOR = parseSnowflakeId('444444444444444444');
const MEMBER = parseSnowflakeId('555555555555555555');
const ROLE_A = parseSnowflakeId('666666666666666666');
const ROLE_B = parseSnowflakeId('777777777777777777');
const ROLE_C = parseSnowflakeId('888888888888888888');
const REQUIRED = parseSnowflakeId('999999999999999999');
const BLOCKED = parseSnowflakeId('101111111111111111');

const E_A = unicodeEmojiKey('🅰️');
const E_B = unicodeEmojiKey('🅱️');
const E_C = unicodeEmojiKey('🇨');

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;
let pipeline: Pipeline;

const definition = (over: Record<string, unknown> = {}): PanelDefinition =>
  panelDefinitionSchema.parse({
    panelId: 'roles',
    kind: 'adopted',
    channelId: CHANNEL,
    messageId: MESSAGE,
    behaviour: 'toggle',
    component: 'reaction',
    options: [
      { optionId: 'a', roleId: ROLE_A, emojiKey: E_A, position: 0 },
      { optionId: 'b', roleId: ROLE_B, emojiKey: E_B, position: 1 },
      { optionId: 'c', roleId: ROLE_C, emojiKey: E_C, position: 2 },
    ],
    ...over,
  });

const gatewayDeps = (): EffectGatewayDeps => ({
  guildId: GUILD,
  authz: authzStoreFor(scope),
  discord,
  rateLimiter: new RateLimiter(100),
  logger,
  now: () => discord.now(),
  state: {
    read: () => guildRepo.readSafetyState(scope),
    isPanelEnabled: (panelId) => panelRepo.isPanelEnabled(scope, panelId),
    isRoleAllowlisted: (roleId) =>
      read(scope, (db) =>
        db
          .select({ roleId: schema.managedRoles.roleId })
          .from(schema.managedRoles)
          .where(scope.only(schema.managedRoles))
          .all()
          .some((r) => r.roleId === roleId),
      ),
    isTargetProtected: (userId, roleId) => isTargetProtected(scope, { userId, roleId }),
    tripBreaker: (reason, atMs) => guildRepo.tripBreaker(scope, reason, atMs),
  },
  effects: {
    claim: ({ dedupeKey, intent, hadRoleBefore, atMs }) =>
      effectRepo.claimEffect(scope, {
        dedupeKey,
        batchId: intent.batchId,
        userId: intent.userId,
        roleId: intent.roleId,
        action: intent.action,
        hadRoleBefore,
        panelId: intent.panelId,
        now: atMs,
      }),
    record: ({ effectId, state, completedAtMs, errorCode }) =>
      effectRepo.recordOutcome(scope, { effectId, state, completedAt: completedAtMs, errorCode }),
  },
  audit: {
    record: (input) =>
      effectRepo.recordAudit(scope, {
        at: input.atMs,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: input.action,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        batchId: input.batchId,
        before: input.before,
        after: input.after,
        dryRun: input.dryRun,
      }),
  },
});

let passCounter = 0;

const setUpPanel = (def: PanelDefinition) => {
  panelRepo.createPanel(scope, def, discord.now());
  const gateway = new EffectGateway(gatewayDeps());
  pipeline = new Pipeline({
    allowlist: new Set([GUILD]),
    dedupe: { firstSight: (input) => pipelineRepo.recordFirstSight(scope, input) },
    subscribers: [
      createReactionSubscriber({
        guildId: GUILD,
        botUserId: BOT_USER_ID,
        store: panelStoreFor(scope),
        discord,
        effects: panelEffectsFor(scope, gateway, panelAuthorization(scope), () => discord.now()),
        logger,
        now: () => discord.now(),
        newPassId: () => `pass-${passCounter++}`,
      }),
    ],
    leaveGuild: async () => undefined,
    logger,
  });
  discord.onEvent(async (event) => {
    await pipeline.dispatch(event);
  });
};

const react = async (emoji: string, op: 'add' | 'remove' = 'add', userId = MEMBER) => {
  if (op === 'add') {
    await discord.emitReactionAdd({ channelId: CHANNEL, messageId: MESSAGE, userId, emoji });
  } else {
    await discord.emitReactionRemove({ channelId: CHANNEL, messageId: MESSAGE, userId, emoji });
  }
};

/** Reacts without the bot seeing it, so state exists before the panel acts. */
const preReact = (emoji: string, userId = MEMBER) =>
  discord.offlineReactionAdd({ channelId: CHANNEL, messageId: MESSAGE, userId, emoji });

beforeEach(() => {
  passCounter = 0;
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);

  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });
  write(scope, ({ db }) => {
    db.update(schema.guilds).set({ dryRun: 0 }).where(scope.only(schema.guilds)).run();
    for (const roleId of [ROLE_A, ROLE_B, ROLE_C]) {
      db.insert(schema.managedRoles).values({ guildId: GUILD, roleId }).run();
    }
  });

  discord = new FakeDiscord({ guildId: GUILD, botHighestRolePosition: 100 });
  discord.defineRole({ id: ROLE_A, name: 'a', position: 10 });
  discord.defineRole({ id: ROLE_B, name: 'b', position: 11 });
  discord.defineRole({ id: ROLE_C, name: 'c', position: 12 });
  discord.defineRole({ id: REQUIRED, name: 'verified', position: 5 });
  discord.defineRole({ id: BLOCKED, name: 'timed-out', position: 6 });
  discord.defineMember(MEMBER, []);
  discord.defineMember(BOT_USER_ID, []);
  discord.defineMessage({ channelId: CHANNEL, messageId: MESSAGE, authorId: AUTHOR });
});

afterEach(() => {
  t.close();
});

describe('toggle', () => {
  beforeEach(() => setUpPanel(definition()));

  it('reacting grants, un-reacting revokes', async () => {
    await react(E_A);
    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_A]);
    await react(E_A, 'remove');
    expect(discord.memberRoles(MEMBER)).toEqual([]);
  });
});

describe('add_only', () => {
  beforeEach(() => setUpPanel(definition({ behaviour: 'add_only' })));

  it('reacting grants', async () => {
    await react(E_A);
    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_A]);
  });

  it('un-reacting does NOT revoke — that is the whole point of the behaviour', async () => {
    await react(E_A);
    await react(E_A, 'remove');
    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_A]);
  });

  it('makes no REST call for the un-react, rather than calling and being refused', async () => {
    await react(E_A);
    discord.resetCalls();
    await react(E_A, 'remove');
    expect(discord.restCalls('removeRole')).toEqual([]);
  });
});

describe('remove_only', () => {
  beforeEach(() => setUpPanel(definition({ behaviour: 'remove_only' })));

  it('un-reacting revokes a role the member holds', async () => {
    // The member already has the role — granted by hand, or by another panel.
    await discord.addRole(GUILD, MEMBER, ROLE_A, 'set up by hand');
    preReact(E_A);

    await react(E_A, 'remove');
    expect(discord.memberRoles(MEMBER)).toEqual([]);
  });

  it('reacting does NOT grant', async () => {
    await react(E_A);
    expect(discord.memberRoles(MEMBER)).toEqual([]);
    expect(discord.restCalls('addRole')).toEqual([]);
  });
});

describe("max_roles on an adopted panel — amendment 6's expensive path", () => {
  beforeEach(() => setUpPanel(definition({ maxRoles: 2 })));

  it('grants up to the ceiling', async () => {
    await react(E_A);
    await react(E_B);
    expect(discord.memberRoles(MEMBER).sort()).toEqual([ROLE_A, ROLE_B].sort());
  });

  it('refuses the one past the ceiling, keeping what the member already had', async () => {
    await react(E_A);
    await react(E_B);
    await react(E_C);

    expect(discord.memberRoles(MEMBER).sort()).toEqual([ROLE_A, ROLE_B].sort());
    expect(discord.memberRoles(MEMBER)).not.toContain(ROLE_C);
  });

  it('reads the whole reaction set, which the other behaviours do not', async () => {
    // This is the case amendment 6 pays N REST calls for: `max_roles` is a
    // statement about the set, so the set has to be known.
    discord.resetCalls();
    await react(E_A);
    expect(discord.restCalls('fetchReactionUsers').length).toBeGreaterThan(0);
  });

  it('frees a slot when a reaction is withdrawn', async () => {
    await react(E_A);
    await react(E_B);
    await react(E_C);
    expect(discord.memberRoles(MEMBER)).not.toContain(ROLE_C);

    await react(E_A, 'remove');
    // C's reaction is still on the message, so the next pass takes the slot.
    expect(discord.memberRoles(MEMBER).sort()).toEqual([ROLE_B, ROLE_C].sort());
  });

  it('memoises within one pass rather than refetching per emoji per event', async () => {
    preReact(E_A);
    preReact(E_B);
    discord.resetCalls();

    await react(E_C);

    // Three mapped emoji, one pass: at most one paged read each.
    const byEmoji = new Set(discord.restCalls('fetchReactionUsers').map((c) => String(c.args[2])));
    expect(discord.restCalls('fetchReactionUsers')).toHaveLength(byEmoji.size);
  });
});

describe('required_role_id', () => {
  beforeEach(() => setUpPanel(definition({ requiredRoleId: REQUIRED })));

  it('refuses a member who does not hold it', async () => {
    await react(E_A);
    expect(discord.memberRoles(MEMBER)).toEqual([]);
    expect(discord.restCalls('addRole')).toEqual([]);
  });

  it('permits a member who does', async () => {
    await discord.addRole(GUILD, MEMBER, REQUIRED, 'verified');
    await react(E_A);
    expect(discord.memberRoles(MEMBER).sort()).toEqual([ROLE_A, REQUIRED].sort());
  });

  it('stops responding if the required role is taken away, without stripping roles', async () => {
    await discord.addRole(GUILD, MEMBER, REQUIRED, 'verified');
    await react(E_A);
    await discord.removeRole(GUILD, MEMBER, REQUIRED, 'unverified');

    await react(E_B);
    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_A]);
  });
});

describe('blocked roles', () => {
  beforeEach(() => setUpPanel(definition({ blockedRoleIds: [BLOCKED] })));

  it('refuses a member holding one', async () => {
    await discord.addRole(GUILD, MEMBER, BLOCKED, 'timed out');
    await react(E_A);
    expect(discord.memberRoles(MEMBER)).toEqual([BLOCKED]);
  });

  it('does not strip roles the panel granted before the block', async () => {
    // Acquiring a blocked role must not become a silent mass revocation.
    await react(E_A);
    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_A]);

    await discord.addRole(GUILD, MEMBER, BLOCKED, 'timed out');
    await react(E_B);

    expect(discord.memberRoles(MEMBER).sort()).toEqual([ROLE_A, BLOCKED].sort());
  });

  it('lets a member back in once the blocked role is gone', async () => {
    await discord.addRole(GUILD, MEMBER, BLOCKED, 'timed out');
    await react(E_A);
    expect(discord.memberRoles(MEMBER)).toEqual([BLOCKED]);

    await discord.removeRole(GUILD, MEMBER, BLOCKED, 'served their time');
    await react(E_B);
    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_B]);
  });
});

describe('the audit trail records refusals as well as changes', () => {
  beforeEach(() => setUpPanel(definition({ requiredRoleId: REQUIRED })));

  it('writes no effect row for a panel-level refusal, because nothing was attempted', async () => {
    // The refusal happens in convergence, before any intent exists. There is
    // nothing for the gateway to record, and inventing a row would make
    // `role_effects` a log of things that never happened.
    await react(E_A);
    const effects = read(scope, (db) =>
      db.select().from(schema.roleEffects).where(scope.only(schema.roleEffects)).all(),
    );
    expect(effects).toEqual([]);
  });
});
