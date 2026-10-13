import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  cardCustomIds,
  cardTexts,
  createInteractionSubscriber,
  EffectGateway,
  panelDefinitionSchema,
  parseGuildId,
  parseSnowflakeId,
  Pipeline,
  postManagedPanel,
  RateLimiter,
  type EffectGatewayDeps,
  type InteractionSubscriberDeps,
  type OutgoingMessage,
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
import { cardOut } from './cards/art.js';
import { panelAuthorization, panelEffectsFor, panelStoreFor } from './panels/wiring.js';

/**
 * A managed panel, end to end: posted by the bot, clicked by a member,
 * confirmed ephemerally.
 *
 * The ordering constraint under test is Discord's, not ours. Three seconds to
 * acknowledge; a role change is slower than that; so the handler defers first
 * and follows up after. The fake enforces the deadline, so a handler that did
 * the work before acknowledging would fail here rather than in the club server.
 */

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = parseSnowflakeId('222222222222222222');
const MEMBER = parseSnowflakeId('444444444444444444');
const ROLE_A = parseSnowflakeId('666666666666666666');
const ROLE_B = parseSnowflakeId('777777777777777777');
const ROLE_C = parseSnowflakeId('888888888888888888');

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;
let pipeline: Pipeline;
let messageId: string;

const definition = (over: Record<string, unknown> = {}): PanelDefinition =>
  panelDefinitionSchema.parse({
    panelId: 'roles',
    kind: 'managed',
    channelId: CHANNEL,
    behaviour: 'toggle',
    component: 'button',
    options: [
      { optionId: 'alpha', roleId: ROLE_A, label: 'Alpha', position: 0 },
      { optionId: 'beta', roleId: ROLE_B, label: 'Beta', position: 1 },
      { optionId: 'gamma', roleId: ROLE_C, label: 'Gamma', position: 2 },
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

const buildSubscriberDeps = (): InteractionSubscriberDeps => {
  const gateway = new EffectGateway(gatewayDeps());
  return {
    guildId: GUILD,
    botUserId: BOT_USER_ID,
    store: panelStoreFor(scope),
    discord,
    effects: panelEffectsFor(scope, gateway, panelAuthorization(scope), () => discord.now()),
    logger,
    now: () => discord.now(),
    newPassId: () => `pass-${discord.now()}`,
    responder: {
      defer: (ref, options) => discord.deferInteraction(GUILD, ref, options),
      respond: async (ref, message) => {
        await discord.respondToInteraction(GUILD, ref, message);
      },
    },
  };
};

/** Posts the panel and rebuilds the pipeline around it. */
const setUpPanel = async (def: PanelDefinition) => {
  panelRepo.createPanel(scope, def, discord.now());
  const panel = panelRepo.findPanel(scope, def.panelId);
  if (!panel) throw new Error('panel was not created');

  const ref = await postManagedPanel(panel, {
    guildId: GUILD,
    discord,
    logger,
    setPanelMessage: (panelId, id) => panelRepo.setPanelMessage(scope, panelId, id, discord.now()),
    toMessage: cardOut,
  });
  messageId = ref.messageId;

  pipeline = new Pipeline({
    allowlist: new Set([GUILD]),
    dedupe: { firstSight: (input) => pipelineRepo.recordFirstSight(scope, input) },
    subscribers: [createInteractionSubscriber(buildSubscriberDeps())],
    leaveGuild: async () => undefined,
    logger,
  });
  discord.onEvent(async (event) => {
    await pipeline.dispatch(event);
  });
};

const click = (customId: string, values?: readonly string[]) =>
  discord.emitInteraction({
    channelId: CHANNEL,
    messageId,
    userId: MEMBER,
    customId,
    ...(values ? { values } : {}),
  });

const replyText = (interactionId: string): string =>
  cardTexts(discord.interactionReplies(interactionId)[0]?.components ?? []);

const replyFlags = (interactionId: string): number | undefined =>
  discord.interactionReplies(interactionId)[0]?.flags;

beforeEach(() => {
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
  discord.defineRole({ id: ROLE_A, name: 'alpha', position: 10 });
  discord.defineRole({ id: ROLE_B, name: 'beta', position: 11 });
  discord.defineRole({ id: ROLE_C, name: 'gamma', position: 12 });
  discord.defineMember(MEMBER, []);
  discord.defineMember(BOT_USER_ID, []);
});

afterEach(() => {
  t.close();
});

describe('a button becomes a role', () => {
  beforeEach(async () => setUpPanel(definition()));

  it('posts the panel as a card with the V2 flag and the panel banner', async () => {
    const sent = discord.restCalls('sendMessage');
    expect(sent).toHaveLength(1);
    const message = sent[0]?.args[2] as OutgoingMessage;
    expect(message.flags).toBe(32768);
    expect(message.files?.map((f) => f.name)).toEqual(['banner-panel.png']);
    const container = message.components?.[0] as { components: readonly unknown[] };
    expect(container.components[0]).toMatchObject({
      type: 12,
      items: [{ media: { url: 'attachment://banner-panel.png' } }],
    });
    // The custom ids are unchanged, so a click still converges.
    expect(cardCustomIds(message.components ?? [])).toEqual([
      'bs.panel:roles:alpha',
      'bs.panel:roles:beta',
      'bs.panel:roles:gamma',
    ]);
  });

  it('grants the role and says so, only to the member who clicked', async () => {
    const id = await click('bs.panel:roles:alpha');

    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_A]);
    expect(discord.wasEphemeral(id)).toBe(true);
    expect(replyFlags(id)).toBe(32768);
    expect(replyText(id)).toContain(`<@&${ROLE_A}>`);
    expect(replyText(id)).toContain('You now have');
  });

  it('toggles the role off on a second click', async () => {
    await click('bs.panel:roles:alpha');
    const id = await click('bs.panel:roles:alpha');

    expect(discord.memberRoles(MEMBER)).toEqual([]);
    expect(replyText(id)).toContain('Removed');
  });

  it('leaves the other options alone', async () => {
    await click('bs.panel:roles:alpha');
    await click('bs.panel:roles:beta');
    expect(discord.memberRoles(MEMBER).sort()).toEqual([ROLE_A, ROLE_B].sort());

    await click('bs.panel:roles:alpha');
    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_B]);
  });

  it('acknowledges before doing the work', async () => {
    // Discord gives three seconds. If the handler converged first and replied
    // second, the fake would refuse the late defer with 10062 and the member
    // would see "This interaction failed".
    const id = await click('bs.panel:roles:alpha');
    expect(discord.wasDeferred(id)).toBe(true);

    const calls = discord.restCalls().map((c) => c.method);
    expect(calls.indexOf('deferInteraction')).toBeLessThan(calls.indexOf('addRole'));
  });

  it('records the interaction id as the trigger, so a replay cannot act twice', async () => {
    const id = await click('bs.panel:roles:alpha');
    discord.resetCalls();

    // The same interaction delivered again — a reconnect replay.
    await discord.emitInteraction({
      channelId: CHANNEL,
      messageId,
      userId: MEMBER,
      customId: 'bs.panel:roles:alpha',
      interactionId: id,
    });

    expect(discord.restCalls('addRole')).toEqual([]);
    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_A]);
  });
});

describe('an interaction that is not ours', () => {
  beforeEach(async () => setUpPanel(definition()));

  it("ignores another bot's component without acknowledging it", async () => {
    // Acknowledging would swallow the other bot's interaction.
    const id = await click('someoneelse:button');
    expect(discord.wasDeferred(id)).toBe(false);
    expect(discord.interactionReplies(id)).toEqual([]);
  });

  it('ignores a custom id naming a different panel than the message it was on', async () => {
    const id = await click('bs.panel:otherpanel:alpha');
    expect(discord.wasDeferred(id)).toBe(false);
    expect(discord.memberRoles(MEMBER)).toEqual([]);
  });

  it('ignores an option the panel does not offer', async () => {
    const id = await click('bs.panel:roles:removed-last-week');
    expect(discord.wasDeferred(id)).toBe(false);
    expect(discord.memberRoles(MEMBER)).toEqual([]);
  });
});

describe('select menus', () => {
  beforeEach(async () => setUpPanel(definition({ component: 'select' })));

  it('applies the whole selection at once', async () => {
    await click('bs.panel:roles:_select', ['alpha', 'gamma']);
    expect(discord.memberRoles(MEMBER).sort()).toEqual([ROLE_A, ROLE_C].sort());
  });

  it('revokes what was deselected, because the menu speaks for the panel', async () => {
    await click('bs.panel:roles:_select', ['alpha', 'beta']);
    const id = await click('bs.panel:roles:_select', ['beta']);

    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_B]);
    expect(replyText(id)).toContain('Removed');
  });

  it('clears every role on an empty selection', async () => {
    await click('bs.panel:roles:_select', ['alpha', 'beta']);
    await click('bs.panel:roles:_select', []);
    expect(discord.memberRoles(MEMBER)).toEqual([]);
  });

  it('ignores values the panel does not offer', async () => {
    // The values come back from the client and can say anything.
    await click('bs.panel:roles:_select', ['alpha', 'not-an-option']);
    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_A]);
  });
});

describe('single choice', () => {
  beforeEach(async () => setUpPanel(definition({ behaviour: 'single_choice' })));

  it('swaps one role for another in a single click', async () => {
    await click('bs.panel:roles:alpha');
    const id = await click('bs.panel:roles:beta');

    expect(discord.memberRoles(MEMBER)).toEqual([ROLE_B]);
    expect(replyText(id)).toContain('You now have');
    expect(replyText(id)).toContain('Removed');
  });

  it('revokes before granting, so a ceiling is never briefly exceeded', async () => {
    await click('bs.panel:roles:alpha');
    discord.resetCalls();
    await click('bs.panel:roles:beta');

    const calls = discord.restCalls().map((c) => c.method);
    expect(calls.indexOf('removeRole')).toBeLessThan(calls.indexOf('addRole'));
  });
});

describe('the member is never told something untrue', () => {
  beforeEach(async () => setUpPanel(definition()));

  it('does not claim a role was granted under dry run', async () => {
    write(scope, ({ db }) => {
      db.update(schema.guilds).set({ dryRun: 1 }).where(scope.only(schema.guilds)).run();
    });

    const id = await click('bs.panel:roles:alpha');

    expect(discord.memberRoles(MEMBER)).toEqual([]);
    expect(replyText(id)).not.toContain('You now have');
  });

  it('does not claim a role was granted when the gateway refused', async () => {
    // Above the bot in the hierarchy: the plan wants it, the gateway refuses.
    discord.setRolePosition(ROLE_A, 200);

    const id = await click('bs.panel:roles:alpha');

    expect(discord.memberRoles(MEMBER)).toEqual([]);
    expect(replyText(id)).not.toContain('You now have');
    expect(replyText(id)).toContain("Couldn't change your roles");
  });

  it('says the panel is off when it is disabled', async () => {
    panelRepo.setPanelStatus(scope, 'roles', 'disabled_by_owner', 'testing', 0);
    const id = await click('bs.panel:roles:alpha');

    expect(replyText(id)).toContain('This panel is switched off');
    expect(discord.memberRoles(MEMBER)).toEqual([]);
  });

  it('still answers when the work throws, rather than leaving a spinner', async () => {
    discord.failAlways('fetchMember', FakeDiscord.unknownMember());
    const id = await click('bs.panel:roles:alpha');

    expect(discord.wasDeferred(id)).toBe(true);
    expect(replyFlags(id)).toBe(32768);
    expect(replyText(id)).toContain("Couldn't handle that");
  });
});
