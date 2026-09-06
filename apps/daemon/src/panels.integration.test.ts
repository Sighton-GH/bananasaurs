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
  seedPanelReactions,
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
 * An adopted panel, end to end, on the fake gateway.
 *
 * The pipeline dispatches a real `reactionAdd`, the subscriber converges, and
 * the effect gateway performs the role change against the fake — every layer
 * that will run in production except the discord.js adapter, which is slice 6
 * in WP5.
 *
 * What this proves that the unit tests cannot: that a reaction event actually
 * reaches a role change through the pipeline's gates, that the gateway's
 * idempotency and no-op checks make a replayed reaction free, and that the
 * provenance row is written from the effect rather than invented.
 */

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = parseSnowflakeId('222222222222222222');
const MESSAGE = parseSnowflakeId('333333333333333333');
const MEMBER = parseSnowflakeId('444444444444444444');
const OTHER = parseSnowflakeId('555555555555555555');
const ROLE_A = parseSnowflakeId('666666666666666666');
const ROLE_B = parseSnowflakeId('777777777777777777');

const BRAIN = unicodeEmojiKey('🧠');
const CHECK = unicodeEmojiKey('✔️');

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
      { optionId: 'brain', roleId: ROLE_A, emojiKey: BRAIN, position: 0 },
      { optionId: 'check', roleId: ROLE_B, emojiKey: CHECK, position: 1 },
    ],
    ...over,
  });

/** Wires the panel subscriber onto the pipeline, exactly as WP5's daemon will. */
const buildPipeline = () => {
  const gateway = new EffectGateway(gatewayDeps());
  const auth = panelAuthorization(scope);
  const subscriber = createReactionSubscriber({
    guildId: GUILD,
    botUserId: BOT_USER_ID,
    store: panelStoreFor(scope),
    discord,
    effects: panelEffectsFor(scope, gateway, auth, () => discord.now()),
    logger,
    now: () => discord.now(),
    newPassId: () => `pass-${discord.now()}-${passCounter++}`,
  });

  return new Pipeline({
    allowlist: new Set([GUILD]),
    dedupe: {
      firstSight: (input) => pipelineRepo.recordFirstSight(scope, input),
    },
    subscribers: [subscriber],
    leaveGuild: async () => undefined,
    logger,
  });
};

let passCounter = 0;

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

beforeEach(() => {
  passCounter = 0;
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);

  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });
  // docs/18 Layer 4: an unconfigured guild is dry-run. A test that exercises
  // real calls turns it off deliberately.
  write(scope, ({ db }) => {
    db.update(schema.guilds).set({ dryRun: 0 }).where(scope.only(schema.guilds)).run();
    db.insert(schema.managedRoles).values({ guildId: GUILD, roleId: ROLE_A }).run();
    db.insert(schema.managedRoles).values({ guildId: GUILD, roleId: ROLE_B }).run();
  });

  discord = new FakeDiscord({ guildId: GUILD, botHighestRolePosition: 100 });
  discord.defineRole({ id: ROLE_A, name: 'brains', position: 10 });
  discord.defineRole({ id: ROLE_B, name: 'checked', position: 11 });
  discord.defineMember(MEMBER, []);
  discord.defineMember(OTHER, []);
  discord.defineMember(BOT_USER_ID, []);
  discord.defineMessage({ channelId: CHANNEL, messageId: MESSAGE, authorId: OTHER });

  panelRepo.createPanel(scope, definition(), discord.now());
  pipeline = buildPipeline();
  // Exactly what the discord.js adapter will do in slice 6: every gateway
  // event goes through the pipeline, allowlist gate and dedupe gate included.
  discord.onEvent(async (event) => {
    await pipeline.dispatch(event);
  });
});

afterEach(() => {
  t.close();
});

describe('a reaction becomes a role', () => {
  it('grants the mapped role when a member reacts', async () => {
    await discord.emitReactionAdd({
      channelId: CHANNEL,
      messageId: MESSAGE,
      userId: MEMBER,
      emoji: BRAIN,
    });

    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_A]);
  });

  it('revokes it when the reaction is removed', async () => {
    await react(MEMBER, BRAIN, 'add');
    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_A]);

    await react(MEMBER, BRAIN, 'remove');
    expect(discord.memberRoles(MEMBER)).toEqual([]);
  });

  it('writes the provenance row from the effect that granted it', async () => {
    await react(MEMBER, BRAIN, 'add');

    const rows = read(scope, (db) =>
      db
        .select()
        .from(schema.managedRoleAssignments)
        .where(scope.only(schema.managedRoleAssignments))
        .all(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.panelId).toBe('roles');
    expect(rows[0]?.userId).toBe(MEMBER);
    // Not invented: the id belongs to a real applied effect.
    expect(effectRepo.findEffect(scope, rows[0]?.grantedByEffect ?? '')?.state).toBe('applied');
  });

  it('removes the provenance row when the role is revoked', async () => {
    await react(MEMBER, BRAIN, 'add');
    await react(MEMBER, BRAIN, 'remove');

    const rows = read(scope, (db) =>
      db
        .select()
        .from(schema.managedRoleAssignments)
        .where(scope.only(schema.managedRoleAssignments))
        .all(),
    );
    expect(rows).toEqual([]);
  });

  it('writes an audit row naming the member as the subject', async () => {
    await react(MEMBER, BRAIN, 'add');

    const audit = effectRepo.tailAudit(scope).filter((row) => row.action === 'role.grant');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.subjectId).toBe(MEMBER);
    // The panel is the authorization, so the actor is the instance itself.
    expect(audit[0]?.actorType).toBe('system');
  });
});

describe('a reaction that is not a request', () => {
  it('ignores our own seeded reaction', async () => {
    // Without this the bot grants itself a role the moment it seeds a panel.
    await seedPanelReactions(panelRepo.findPanel(scope, 'roles')!, {
      guildId: GUILD,
      discord,
      logger,
    });
    await discord.emitReactionAdd({
      channelId: CHANNEL,
      messageId: MESSAGE,
      userId: BOT_USER_ID,
      emoji: BRAIN,
    });

    expect(discord.memberRoles(BOT_USER_ID)).toEqual([]);
  });

  it('ignores an emoji the panel does not offer', async () => {
    await react(MEMBER, unicodeEmojiKey('🔥'), 'add');
    expect(discord.memberRoles(MEMBER)).toEqual([]);
  });

  it('ignores a reaction on a message that hosts no panel', async () => {
    const other = parseSnowflakeId('888888888888888888');
    discord.defineMessage({ channelId: CHANNEL, messageId: other, authorId: OTHER });
    await discord.emitReactionAdd({
      channelId: CHANNEL,
      messageId: other,
      userId: MEMBER,
      emoji: BRAIN,
    });

    expect(discord.memberRoles(MEMBER)).toEqual([]);
  });
});

describe('a replayed reaction is free', () => {
  /**
   * Reactions carry no fingerprint and are not deduplicated at the pipeline
   * (`fingerprint.ts`), so the replay reaches the subscriber. It is harmless
   * because convergence is level-triggered and the gateway's no-op check runs
   * before the rate cap and before the idempotency claim.
   */
  it('performs no second REST call and writes no second effect row', async () => {
    await react(MEMBER, BRAIN, 'add');
    const callsAfterFirst = discord.restCalls('addRole').length;
    const effectsAfterFirst = countEffects();

    await discord.emitDuplicateReactionAdd({
      channelId: CHANNEL,
      messageId: MESSAGE,
      userId: MEMBER,
      emoji: BRAIN,
    });

    expect(discord.restCalls('addRole')).toHaveLength(callsAfterFirst);
    expect(countEffects()).toBe(effectsAfterFirst);
    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_A]);
  });

  it('costs no rate budget, so a replay storm cannot trip the breaker', async () => {
    await react(MEMBER, BRAIN, 'add');
    for (let i = 0; i < 30; i += 1) {
      await discord.emitDuplicateReactionAdd({
        channelId: CHANNEL,
        messageId: MESSAGE,
        userId: MEMBER,
        emoji: BRAIN,
      });
    }
    expect(guildRepo.readSafetyState(scope)?.breakerOpen).toBe(false);
    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_A]);
  });
});

describe('one reaction does not disturb the others (amendment 6)', () => {
  it('leaves a role from another option alone', async () => {
    await react(MEMBER, BRAIN, 'add');
    await react(MEMBER, CHECK, 'add');
    expect(discord.memberRoles(MEMBER).sort()).toEqual([ROLE_A, ROLE_B].sort());

    await react(MEMBER, BRAIN, 'remove');
    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_B]);
  });

  it('costs no reaction-state fetch at all for a toggle panel', async () => {
    // Amendment 6: toggle is decidable from the single emoji the event carried.
    discord.resetCalls();
    await react(MEMBER, BRAIN, 'add');
    expect(discord.restCalls('fetchReactionUsers')).toEqual([]);
  });
});

describe('seeding', () => {
  it('puts every mapped emoji on the message, in display order', async () => {
    discord.resetCalls();
    const result = await seedPanelReactions(panelRepo.findPanel(scope, 'roles')!, {
      guildId: GUILD,
      discord,
      logger,
    });

    expect(result.seeded).toBe(2);
    expect(discord.restCalls('createReaction').map((c) => c.args[2])).toEqual([BRAIN, CHECK]);
  });

  it('reports an emoji Discord refused without abandoning the rest', async () => {
    discord.failNext('createReaction', FakeDiscord.missingPermissions());
    const result = await seedPanelReactions(panelRepo.findPanel(scope, 'roles')!, {
      guildId: GUILD,
      discord,
      logger,
    });

    expect(result.seeded).toBe(1);
    expect(result.failed).toHaveLength(1);
  });
});

describe('the gateway still governs every panel change', () => {
  it('refuses when the panel is disabled', async () => {
    panelRepo.setPanelStatus(scope, 'roles', 'disabled_by_doctor', 'message deleted', 0);
    await react(MEMBER, BRAIN, 'add');
    expect(discord.memberRoles(MEMBER)).toEqual([]);
  });

  it('refuses when the kill switch is on', async () => {
    guildRepo.setKillswitch(scope, true, 0);
    await react(MEMBER, BRAIN, 'add');
    expect(discord.memberRoles(MEMBER)).toEqual([]);
  });

  it('refuses when the role sits above the bot', async () => {
    discord.setRolePosition(ROLE_A, 200);
    await react(MEMBER, BRAIN, 'add');
    expect(discord.memberRoles(MEMBER)).toEqual([]);
  });

  it('makes no REST call in dry run, but still records the decision', async () => {
    write(scope, ({ db }) => {
      db.update(schema.guilds).set({ dryRun: 1 }).where(scope.only(schema.guilds)).run();
    });
    await react(MEMBER, BRAIN, 'add');

    expect(discord.restCalls('addRole')).toEqual([]);
    expect(discord.memberRoles(MEMBER)).toEqual([]);
    expect(countEffects()).toBe(1);
  });

  /**
   * ADR 0042 §5 (spec F3/F4): `automod_testing_mode` is a third lever,
   * distinct from `dry_run`, precisely so an operator watching a newly
   * flipped automod rule does not have to disable every role panel in the
   * guild to do it. The guard this test exists for (plan Task 5, ruling
   * PR-33): the role-panel path runs through `EffectGateway`, whose own
   * `state.read()` reads the *same* `guildRepo.readSafetyState(scope)` row
   * the automod subscriber does — so if `automod_testing_mode` were ever
   * read as a synonym for `dryRun` (the shortcut this ADR explicitly
   * rejects), this assignment would silently stop applying the moment an
   * operator turned testing mode on. It must not.
   */
  it('still grants the role when automod_testing_mode is on — not dry_run by another name', async () => {
    write(scope, ({ db }) => {
      db.update(schema.guilds)
        .set({ automodTestingMode: 1 })
        .where(scope.only(schema.guilds))
        .run();
    });
    await react(MEMBER, BRAIN, 'add');

    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_A]);
  });
});

// --- helpers ----------------------------------------------------------------

/** Emits a reaction, which the pipeline picks up through `onEvent`. */
async function react(userId: string, emoji: string, op: 'add' | 'remove'): Promise<void> {
  if (op === 'add') {
    await discord.emitReactionAdd({ channelId: CHANNEL, messageId: MESSAGE, userId, emoji });
  } else {
    await discord.emitReactionRemove({ channelId: CHANNEL, messageId: MESSAGE, userId, emoji });
  }
}

function countEffects(): number {
  return read(scope, (db) =>
    db.select().from(schema.roleEffects).where(scope.only(schema.roleEffects)).all(),
  ).length;
}
