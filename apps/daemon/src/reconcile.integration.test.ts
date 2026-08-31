import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  createConnectionSubscriber,
  createMemberUpdateSubscriber,
  createReactionSubscriber,
  EffectGateway,
  JobWorker,
  JOB_KINDS,
  panelDefinitionSchema,
  parseGuildId,
  parseSnowflakeId,
  Pipeline,
  RateLimiter,
  reconcileDedupeKey,
  reconcileGuild,
  runAdoptionPass,
  unicodeEmojiKey,
  type AdoptionPorts,
  type EffectGatewayDeps,
  type MemberUpdatePorts,
  type PanelDefinition,
  type ReconcilePorts,
} from '@bananasaurs/core';
import {
  authzStoreFor,
  effectRepo,
  guildRepo,
  isTargetProtected,
  jobRepo,
  jobStoreFor,
  panelRepo,
  pipelineRepo,
  roleRepo,
  schema,
  write,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { BOT_USER_ID, FakeDiscord } from '@bananasaurs/testkit';
import { reconcileGuildHandler } from './jobs/reconcile.js';
import { panelAuthorization, panelEffectsFor, panelStoreFor } from './panels/wiring.js';

/**
 * Reconciliation: the demonstrable for `docs/19` §7 slice 11.
 *
 * "A 30-minute outage with offline reactions leaves the state correct on
 * return" is the whole slice in one sentence. A fresh IDENTIFY means the
 * dispatches in the window are gone and are never replayed, so the reaction a
 * member added while the bot was down produced no event at all — and there is
 * no way to discover it other than reading the message's reactions and diffing
 * against live roles.
 *
 * Against live roles, never against `managed_role_assignments` (amendment 4).
 * That table records which panel granted what, for provenance and for undo; it
 * is not a belief about the present, and diffing against it would make the bot
 * confidently wrong about every role a moderator touched by hand.
 */

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = parseSnowflakeId('222222222222222222');
const MESSAGE = parseSnowflakeId('333333333333333333');
const MANAGED_MESSAGE = parseSnowflakeId('343434343434343434');
const AUTHOR = parseSnowflakeId('444444444444444444');
const ROLE_A = parseSnowflakeId('666666666666666666');
const ROLE_B = parseSnowflakeId('777777777777777777');
const UNRELATED = parseSnowflakeId('888888888888888888');

const ALICE = parseSnowflakeId('551111111111111111');
const BOB = parseSnowflakeId('552222222222222222');
const CARA = parseSnowflakeId('553333333333333333');

const E_A = unicodeEmojiKey('🅰️');
const E_B = unicodeEmojiKey('🅱️');

const SELF_MUTATION_WINDOW_MS = 60_000;

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;
let rateLimiter: RateLimiter;
let gateway: EffectGateway;
let passCounter = 0;

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
    ],
    ...over,
  });

const gatewayDeps = (): EffectGatewayDeps => ({
  guildId: GUILD,
  authz: authzStoreFor(scope),
  discord,
  rateLimiter,
  logger,
  now: () => discord.now(),
  state: {
    read: () => guildRepo.readSafetyState(scope),
    isPanelEnabled: (panelId) => panelRepo.isPanelEnabled(scope, panelId),
    isRoleAllowlisted: (roleId) => roleRepo.isAllowlisted(scope, roleId),
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

const reconcilePorts = (): ReconcilePorts => ({
  guildId: GUILD,
  botUserId: BOT_USER_ID,
  store: panelStoreFor(scope),
  discord,
  effects: panelEffectsFor(scope, gateway, panelAuthorization(scope), () => discord.now()),
  logger,
  now: () => discord.now(),
  newPassId: () => `pass-${passCounter++}`,
  fetchRoles: () => discord.fetchRoles(GUILD),
  assignedMembers: (panelId) => effectRepo.listAssignedUsers(scope, panelId),
  // Read per pass rather than captured, so raising the budget takes effect on
  // the next run without a restart.
  reconcileBudget: () => guildRepo.findGuild(scope)?.reconcileBudget ?? 25,
  setPanelStatus: (panelId, status, reason) =>
    panelRepo.setPanelStatus(scope, panelId, status, reason, discord.now()),
  setRoleMissing: (roleId) =>
    roleRepo.setRoleAssignability(scope, {
      roleId,
      assignable: false,
      reason: 'deleted',
      now: discord.now(),
    }),
});

const adoptionPorts = (): AdoptionPorts => ({
  guildId: GUILD,
  botUserId: BOT_USER_ID,
  store: panelStoreFor(scope),
  discord,
  effects: panelEffectsFor(scope, gateway, panelAuthorization(scope), () => discord.now()),
  logger,
  now: () => discord.now(),
  newPassId: () => `pass-${passCounter++}`,
  allowanceFor: (source) => rateLimiter.bucketFor(source, discord.now()).allowance,
  setAdoptionPassState: (panelId, state, blockedCount) =>
    panelRepo.setAdoptionPassState(scope, panelId, state, blockedCount, discord.now()),
});

const memberUpdatePorts = (): MemberUpdatePorts => ({
  guildId: GUILD,
  botUserId: BOT_USER_ID,
  store: panelStoreFor(scope),
  discord,
  effects: panelEffectsFor(scope, gateway, panelAuthorization(scope), () => discord.now()),
  logger,
  now: () => discord.now(),
  newPassId: () => `pass-${passCounter++}`,
  wasRecentlyApplied: (input) => effectRepo.wasRecentlyApplied(scope, input),
  selfMutationWindowMs: SELF_MUTATION_WINDOW_MS,
});

/** The daemon's pipeline: connection, reactions, and drift repair. */
const buildPipeline = (): Pipeline =>
  new Pipeline({
    allowlist: new Set([GUILD]),
    dedupe: { firstSight: (input) => pipelineRepo.recordFirstSight(scope, input) },
    subscribers: [
      createConnectionSubscriber(
        {
          recordGap: (input) => pipelineRepo.recordGap(scope, input),
          enqueueReconcile: ({ dedupeKey, payload }) =>
            jobRepo.enqueue(scope, {
              kind: JOB_KINDS.reconcileGuild,
              payload,
              dedupeKey,
              now: discord.now(),
            }),
        },
        logger,
      ),
      createReactionSubscriber(reconcilePorts()),
      createMemberUpdateSubscriber(memberUpdatePorts()),
    ],
    leaveGuild: async () => undefined,
    logger,
  });

const worker = (): JobWorker =>
  new JobWorker({
    store: jobStoreFor(scope),
    handlers: [reconcileGuildHandler(scope, reconcilePorts(), () => discord.now())],
    logger,
    now: () => discord.now(),
  });

const preReact = (emoji: string, userId: string) =>
  discord.offlineReactionAdd({ channelId: CHANNEL, messageId: MESSAGE, userId, emoji });

const unReactOffline = (emoji: string, userId: string) =>
  discord.offlineReactionRemove({ channelId: CHANNEL, messageId: MESSAGE, userId, emoji });

/** A role granted outside the bot: by hand in the client, or by another tool. */
const grantByHand = async (userId: string, roleId: string) => {
  await discord.addRole(GUILD, userId, roleId, 'set up by hand');
};

beforeEach(() => {
  passCounter = 0;
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);

  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });
  write(scope, ({ db }) => {
    db.update(schema.guilds).set({ dryRun: 0 }).where(scope.only(schema.guilds)).run();
  });
  roleRepo.allowlistRole(scope, ROLE_A);
  roleRepo.allowlistRole(scope, ROLE_B);

  discord = new FakeDiscord({ guildId: GUILD, botHighestRolePosition: 100 });
  discord.defineRole({ id: ROLE_A, name: 'a', position: 10 });
  discord.defineRole({ id: ROLE_B, name: 'b', position: 11 });
  discord.defineRole({ id: UNRELATED, name: 'unrelated', position: 12 });
  discord.defineMember(BOT_USER_ID, []);
  for (const userId of [ALICE, BOB, CARA]) discord.defineMember(userId, []);
  discord.defineMessage({ channelId: CHANNEL, messageId: MESSAGE, authorId: AUTHOR });

  rateLimiter = new RateLimiter(100);
  gateway = new EffectGateway(gatewayDeps());
  panelRepo.createPanel(scope, definition(), discord.now());
});

afterEach(() => {
  t.close();
});

describe('a 30-minute outage', () => {
  it('leaves the state correct on return — the slice 11 demonstrable', async () => {
    const pipeline = buildPipeline();
    discord.onEvent(async (event) => {
      await pipeline.dispatch(event);
    });

    // Before the outage: Bob reacted while the bot was watching, and got the
    // role the ordinary way.
    await discord.emitReactionAdd({
      channelId: CHANNEL,
      messageId: MESSAGE,
      userId: BOB,
      emoji: E_A,
    });
    expect(discord.memberRoles(BOB)).toEqual([ROLE_A]);

    discord.disconnect();
    discord.advance(30 * 60_000);
    // Nothing that happens here produces a dispatch. That is the whole problem.
    preReact(E_A, ALICE);
    unReactOffline(E_A, BOB);

    // A fresh IDENTIFY: the window is gone and will not be replayed.
    await discord.reconnect({ resumed: false });
    const outcome = await worker().runOnce();

    expect(outcome.status).toBe('completed');
    expect(discord.memberRoles(ALICE)).toEqual([ROLE_A]);
    expect(discord.memberRoles(BOB)).toEqual([]);
  });

  it('records the gap and clears it only once the pass has run', async () => {
    preReact(E_A, ALICE);
    const pipeline = buildPipeline();
    discord.onEvent(async (event) => {
      await pipeline.dispatch(event);
    });

    discord.disconnect();
    discord.advance(30 * 60_000);
    await discord.reconnect({ resumed: false });

    expect(pipelineRepo.unreconciledGaps(scope)).toHaveLength(1);
    await worker().runOnce();
    expect(pipelineRepo.unreconciledGaps(scope)).toHaveLength(0);
  });

  it('a resumed session queues nothing, because the dispatches were replayed', async () => {
    preReact(E_A, ALICE);
    const pipeline = buildPipeline();
    discord.onEvent(async (event) => {
      await pipeline.dispatch(event);
    });

    discord.disconnect();
    discord.advance(30 * 60_000);
    await discord.reconnect({ resumed: true });

    expect(await worker().runOnce()).toEqual({ status: 'idle' });
    expect(discord.memberRoles(ALICE)).toEqual([]);
  });

  it('collapses a flapping connection into one pending pass', async () => {
    const pipeline = buildPipeline();
    discord.onEvent(async (event) => {
      await pipeline.dispatch(event);
    });

    for (let i = 0; i < 4; i += 1) {
      discord.disconnect();
      discord.advance(5_000);
      await discord.reconnect({ resumed: false });
    }

    expect(jobRepo.countByState(scope).queued).toBe(1);
  });

  it('reconciles again after the first pass finished — ADR 0016', async () => {
    const pipeline = buildPipeline();
    discord.onEvent(async (event) => {
      await pipeline.dispatch(event);
    });

    discord.disconnect();
    discord.advance(60_000);
    await discord.reconnect({ resumed: false });
    await worker().runOnce();

    // The second gateway gap ever. Under the old whole-table unique index this
    // enqueued nothing and the guild was never reconciled again.
    preReact(E_A, ALICE);
    discord.disconnect();
    discord.advance(60_000);
    await discord.reconnect({ resumed: false });
    await worker().runOnce();

    expect(discord.memberRoles(ALICE)).toEqual([ROLE_A]);
  });
});

describe('the pass itself', () => {
  it('grants what the reactions say and revokes what they do not', async () => {
    preReact(E_A, ALICE);
    preReact(E_B, ALICE);
    await grantByHand(BOB, ROLE_B); // holds a panel role, never reacted

    const outcome = await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(outcome.status).toBe('reconciled');
    expect(discord.memberRoles(ALICE).sort()).toEqual([ROLE_A, ROLE_B].sort());
    // Bob is not in any reaction set, so the pass never looks at him. Revoking
    // a role from someone who never touched the panel would be the bot
    // asserting authority over a change it has no record of.
    expect(discord.memberRoles(BOB)).toEqual([ROLE_B]);
  });

  it('revokes a role from someone still in a reaction set who withdrew another', async () => {
    preReact(E_A, ALICE);
    await grantByHand(ALICE, ROLE_A);
    await grantByHand(ALICE, ROLE_B); // no 🅱️ reaction

    await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(discord.memberRoles(ALICE)).toEqual([ROLE_A]);
  });

  it('repairs a reaction withdrawn while the bot was down', async () => {
    // The hard half of drift. The member is in *no* reaction set now, so a pass
    // driven only by reactors would never look at them. The panel's provenance
    // supplies the name; both sides of the diff are still read live.
    preReact(E_A, ALICE);
    await reconcileGuild(reconcilePorts(), { reason: 'timer' });
    expect(discord.memberRoles(ALICE)).toEqual([ROLE_A]);

    unReactOffline(E_A, ALICE);
    const outcome = await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(outcome.status).toBe('reconciled');
    expect(discord.memberRoles(ALICE)).toEqual([]);
  });

  it('does not believe its own provenance over Discord — amendment 4', async () => {
    preReact(E_A, ALICE);
    await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    // `managed_role_assignments` now says Alice holds ROLE_A by this panel. She
    // does not: it was taken away by hand. Diffing against the table would
    // compute an empty change set and the drift would never be repaired.
    await discord.removeRole(GUILD, ALICE, ROLE_A, 'by a moderator');
    await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(discord.memberRoles(ALICE)).toEqual([ROLE_A]);
  });

  it('is level-triggered: a second pass changes nothing and spends no budget', async () => {
    preReact(E_A, ALICE);
    await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    discord.resetCalls();
    const before = rateLimiter.bucketFor('reconcile', discord.now()).available(discord.now());
    const second = await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(second.status).toBe('nothing-to-do');
    expect(discord.restCalls('addRole')).toEqual([]);
    expect(rateLimiter.bucketFor('reconcile', discord.now()).available(discord.now())).toBe(before);
  });

  it('skips a reactor who has since left the guild, and finishes the rest', async () => {
    preReact(E_A, ALICE);
    preReact(E_A, parseSnowflakeId('559999999999999999')); // never defined: gone

    const outcome = await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(outcome.status).toBe('reconciled');
    expect(discord.memberRoles(ALICE)).toEqual([ROLE_A]);
  });

  it('ignores a disabled panel', async () => {
    preReact(E_A, ALICE);
    panelRepo.setPanelStatus(scope, 'roles', 'disabled_by_owner', 'by an owner', discord.now());

    const outcome = await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(outcome.panelsVisited).toBe(0);
    expect(discord.memberRoles(ALICE)).toEqual([]);
  });

  it('does not treat the bot’s own seeded reaction as a member asking for a role', async () => {
    preReact(E_A, BOT_USER_ID);
    preReact(E_A, ALICE);

    const outcome = await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(outcome.changeCount).toBe(1);
    expect(discord.memberRoles(BOT_USER_ID)).toEqual([]);
  });
});

describe('defect 3 — reconciliation must not bypass the adoption allowance gate (ADR 0021)', () => {
  it('reproduces the live sequence: adoption refuses, then reconcile must not grant the same change behind it', async () => {
    // One pre-existing reaction — exactly the live repro's shape (count: 1,
    // limit: 0 with no standing allowance). The bug is not about scale.
    preReact(E_A, ALICE);

    const adoptionOutcome = await runAdoptionPass(adoptionPorts(), {
      panelId: 'roles',
      cursor: null,
      saveCursor: () => undefined,
    });
    expect(adoptionOutcome.status).toBe('awaiting-allowance');
    expect(discord.memberRoles(ALICE)).toEqual([]);

    // The daemon's own restart, two seconds later in the live report: the
    // same gateway-gap reconnect enqueues reconcile_guild right behind
    // adopt_panel.
    discord.resetCalls();
    const reconcileOutcome = await reconcileGuild(reconcilePorts(), { reason: 'gateway-gap' });

    expect(reconcileOutcome.status).toBe('nothing-to-do');
    // The mass grant this exercise exists to prevent must not happen via a
    // different, more permissive gate two seconds after the correct refusal.
    expect(discord.memberRoles(ALICE)).toEqual([]);
    expect(discord.restCalls('addRole')).toEqual([]);
  });

  it('leaves a panel that was never examined by adoption fully reconcilable — not every "pending" panel is blocked', async () => {
    // The naive fix (exclude every adoptionPassState === 'pending' panel) was
    // rejected in the ADR: every adopted panel defaults to 'pending' at
    // creation, and docs/21 exercises 1-4 never run runAdoptionPass at all.
    // Ordinary drift-repair — this suite's own flagship outage-repair test —
    // must keep working on a panel nobody has explicitly adopted.
    expect(panelStoreFor(scope).findPanel('roles')?.adoptionPassState).toBe('pending');
    preReact(E_A, ALICE);

    const outcome = await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(outcome.status).toBe('reconciled');
    expect(discord.memberRoles(ALICE)).toEqual([ROLE_A]);
  });

  it('reconciles normally again once the allowance is granted and adoption completes', async () => {
    preReact(E_A, ALICE);
    await runAdoptionPass(adoptionPorts(), {
      panelId: 'roles',
      cursor: null,
      saveCursor: () => undefined,
    });
    expect(discord.memberRoles(ALICE)).toEqual([]);

    rateLimiter.grantAllowance('adoption', 1, discord.now());
    const adopted = await runAdoptionPass(adoptionPorts(), {
      panelId: 'roles',
      cursor: null,
      saveCursor: () => undefined,
    });
    expect(adopted.status).toBe('adopted');
    expect(discord.memberRoles(ALICE)).toEqual([ROLE_A]);

    // Now that the backlog is resolved, ordinary drift-repair covers the
    // panel exactly as it did before adoption was ever involved.
    unReactOffline(E_A, ALICE);
    const outcome = await reconcileGuild(reconcilePorts(), { reason: 'timer' });
    expect(outcome.status).toBe('reconciled');
    expect(discord.memberRoles(ALICE)).toEqual([]);
  });

  it('leaves a panel alone while an adoption pass is actively running against it', async () => {
    // Defensive: today's single-writer, per-guild job ordering (ADR 0020)
    // makes a literal overlap with reconcileGuild unlikely, but 'running'
    // means an adoption pass currently owns this panel's convergence, and
    // that must not depend on the scheduler staying exactly as it is today.
    preReact(E_A, ALICE);
    panelRepo.setAdoptionPassState(scope, 'roles', 'running', 0, discord.now());

    const outcome = await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(outcome.status).toBe('nothing-to-do');
    expect(discord.memberRoles(ALICE)).toEqual([]);
  });
});

describe('the budget', () => {
  beforeEach(() => {
    write(scope, ({ db }) => {
      db.update(schema.guilds).set({ reconcileBudget: 2 }).where(scope.only(schema.guilds)).run();
    });
  });

  it('refuses the whole pass rather than applying part of it', async () => {
    preReact(E_A, ALICE);
    preReact(E_A, BOB);
    preReact(E_A, CARA);

    const outcome = await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(outcome.status).toBe('over-budget');
    expect(outcome.changeCount).toBe(3);
    expect(outcome.applied).toBe(0);
    // Not one of the three. Applying the first two and stopping would leave the
    // guild in a state nobody chose.
    for (const userId of [ALICE, BOB, CARA]) {
      expect(discord.memberRoles(userId)).toEqual([]);
    }
    expect(discord.restCalls('addRole')).toEqual([]);
  });

  it('leaves the gap outstanding, so the guild is not silently written off', async () => {
    preReact(E_A, ALICE);
    preReact(E_A, BOB);
    preReact(E_A, CARA);

    const pipeline = buildPipeline();
    discord.onEvent(async (event) => {
      await pipeline.dispatch(event);
    });
    discord.disconnect();
    discord.advance(60_000);
    await discord.reconnect({ resumed: false });

    const outcome = await worker().runOnce();

    // The job succeeded — retrying would repeat the refusal — but the gap it
    // was created for is still unrepaired and still says so.
    expect(outcome.status).toBe('completed');
    expect(pipelineRepo.unreconciledGaps(scope)).toHaveLength(1);
  });

  it('applies once an operator raises the budget, without a restart', async () => {
    preReact(E_A, ALICE);
    preReact(E_A, BOB);
    preReact(E_A, CARA);

    const ports = reconcilePorts();
    expect((await reconcileGuild(ports, { reason: 'timer' })).status).toBe('over-budget');

    write(scope, ({ db }) => {
      db.update(schema.guilds).set({ reconcileBudget: 25 }).where(scope.only(schema.guilds)).run();
    });

    expect((await reconcileGuild(ports, { reason: 'timer' })).status).toBe('reconciled');
    expect(discord.memberRoles(CARA)).toEqual([ROLE_A]);
  });
});

describe('a broken panel option — findings 1 and 2b', () => {
  const SECOND_MESSAGE = parseSnowflakeId('393939393939393939');
  const SECOND_ROLE = parseSnowflakeId('959595959595959595');
  const SECOND_EMOJI = unicodeEmojiKey('🧠');

  beforeEach(() => {
    // A second, unrelated panel — so the test can show the whole pass keeps
    // going, not only the rest of the panel whose option broke.
    discord.defineRole({ id: SECOND_ROLE, name: 'second', position: 13 });
    discord.defineMessage({ channelId: CHANNEL, messageId: SECOND_MESSAGE, authorId: AUTHOR });
    roleRepo.allowlistRole(scope, SECOND_ROLE);
    panelRepo.createPanel(
      scope,
      panelDefinitionSchema.parse({
        panelId: 'second',
        kind: 'adopted',
        channelId: CHANNEL,
        messageId: SECOND_MESSAGE,
        behaviour: 'toggle',
        component: 'reaction',
        options: [{ optionId: 'x', roleId: SECOND_ROLE, emojiKey: SECOND_EMOJI, position: 0 }],
      }),
      discord.now(),
    );
  });

  it('visits only the named panel when one is named (ADR 0026)', async () => {
    // `bananasaurs panel sync <id>` queues a pass carrying this panel id. A
    // pass that ignored it would name one panel and reconcile the whole guild —
    // over-reach the operator would discover only from the audit trail, and the
    // reason the payload carries a panel at all.
    preReact(E_A, ALICE);
    discord.offlineReactionAdd({
      channelId: CHANNEL,
      messageId: SECOND_MESSAGE,
      userId: BOB,
      emoji: SECOND_EMOJI,
    });

    const outcome = await reconcileGuild(reconcilePorts(), {
      reason: 'operator',
      panelId: 'second',
    });

    expect(outcome.panelsVisited).toBe(1);
    // Bob's role came from the panel that was named.
    expect(discord.memberRoles(BOB)).toContain(SECOND_ROLE);
    // Alice reacted on the other panel and was not touched by this pass.
    expect(discord.memberRoles(ALICE)).not.toContain(ROLE_A);
  });

  it('visits every panel when none is named, which is what the timer does', async () => {
    preReact(E_A, ALICE);
    discord.offlineReactionAdd({
      channelId: CHANNEL,
      messageId: SECOND_MESSAGE,
      userId: BOB,
      emoji: SECOND_EMOJI,
    });

    const outcome = await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(outcome.panelsVisited).toBe(2);
    expect(discord.memberRoles(ALICE)).toContain(ROLE_A);
    expect(discord.memberRoles(BOB)).toContain(SECOND_ROLE);
  });

  it('skips one option Discord refuses to read (Unknown Emoji), instead of failing the whole pass', async () => {
    preReact(E_A, ALICE); // 🅰️: the injected failure hits this fetch first
    preReact(E_B, ALICE); // 🅱️ on the same panel: still read normally
    discord.offlineReactionAdd({
      channelId: CHANNEL,
      messageId: SECOND_MESSAGE,
      userId: BOB,
      emoji: SECOND_EMOJI,
    });

    // Before the fix this propagated uncaught out of reconcileGuild entirely:
    // five job retries and the pass dead for every panel in the guild
    // (docs/reports/WP5-slice-6-live-test.md finding 2b).
    discord.failNext('fetchReactionUsers', FakeDiscord.unknownEmoji());

    const outcome = await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(outcome.status).toBe('reconciled');
    expect(outcome.panelsVisited).toBe(2);
    // 🅰️'s option was skipped this pass — no different from finding no
    // reactors — so Alice gets only what 🅱️ asked for.
    expect(discord.memberRoles(ALICE)).toEqual([ROLE_B]);
    // The second panel, unaffected by the first panel's broken option, still
    // reconciles normally.
    expect(discord.memberRoles(BOB)).toEqual([SECOND_ROLE]);
  });

  it('still fails the pass on an error that is not Unknown Emoji, rather than silently under-counting', async () => {
    preReact(E_A, ALICE);
    // A rate limit or a network fault must not be swallowed the same way: a
    // pass that cannot tell "no reactors" from "could not check" must not
    // guess. It has to fail loudly so the job retries.
    discord.failNext('fetchReactionUsers', FakeDiscord.rateLimited());

    await expect(reconcileGuild(reconcilePorts(), { reason: 'timer' })).rejects.toThrow();
  });
});

describe('a panel that can no longer work', () => {
  it('is disabled when its message has been deleted, and its configuration kept', async () => {
    preReact(E_A, ALICE);
    discord.simulateDeletedMessage({ channelId: CHANNEL, messageId: MESSAGE });

    const outcome = await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(outcome.disabled).toEqual([{ panelId: 'roles', reason: 'message-deleted' }]);
    const panel = panelRepo.findPanel(scope, 'roles');
    expect(panel?.status).toBe('disabled_by_doctor');
    expect(panelRepo.isPanelEnabled(scope, 'roles')).toBe(false);
    // The options survive, so an owner can point the panel at a new message.
    expect(panel?.options).toHaveLength(2);
  });

  it('changes no roles when its message is gone', async () => {
    preReact(E_A, ALICE);
    discord.simulateDeletedMessage({ channelId: CHANNEL, messageId: MESSAGE });

    await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(discord.memberRoles(ALICE)).toEqual([]);
    expect(discord.restCalls('addRole')).toEqual([]);
  });

  it('records a diagnosis when an offered role has been deleted', async () => {
    preReact(E_B, ALICE);
    discord.deleteRole(ROLE_B);

    await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    const row = roleRepo.findManagedRole(scope, ROLE_B);
    expect(row?.assignable).toBe(0);
    expect(row?.unassignableReason).toBe('deleted');
    // The diagnosis is not the control: the other option still works.
    expect(roleRepo.findManagedRole(scope, ROLE_A)?.assignable).toBe(1);
  });

  it('keeps reconciling the options whose roles still exist', async () => {
    preReact(E_A, ALICE);
    preReact(E_B, ALICE);
    discord.deleteRole(ROLE_B);

    await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    expect(discord.memberRoles(ALICE)).toEqual([ROLE_A]);
  });
});

describe('managed panels are not reconciled', () => {
  beforeEach(() => {
    discord.defineMessage({
      channelId: CHANNEL,
      messageId: MANAGED_MESSAGE,
      authorId: BOT_USER_ID,
    });
    panelRepo.createPanel(
      scope,
      panelDefinitionSchema.parse({
        panelId: 'buttons',
        kind: 'managed',
        channelId: CHANNEL,
        messageId: MANAGED_MESSAGE,
        behaviour: 'toggle',
        component: 'button',
        options: [{ optionId: 'a', roleId: ROLE_A, label: 'A', position: 0 }],
      }),
      discord.now(),
    );
  });

  it('leaves a manually removed role removed', async () => {
    // The bot granted it, and a moderator took it away by hand.
    await grantByHand(ALICE, ROLE_A);
    effectRepo.recordAssignment(scope, {
      userId: ALICE,
      roleId: ROLE_A,
      panelId: 'buttons',
      effectId: 'eff-1',
      now: discord.now(),
    });
    await discord.removeRole(GUILD, ALICE, ROLE_A, 'by a moderator');

    const outcome = await reconcileGuild(reconcilePorts(), { reason: 'timer' });

    // `managed_role_assignments` still says the panel granted this role. It is
    // provenance, not a belief about the present — amendment 4. Re-adding the
    // role on the strength of it would be the bot overruling a human.
    expect(discord.memberRoles(ALICE)).toEqual([]);
    expect(outcome.panelsVisited).toBe(1); // the adopted panel only
  });
});

describe('amendment 5: GUILD_MEMBER_UPDATE', () => {
  let pipeline: Pipeline;

  beforeEach(() => {
    pipeline = buildPipeline();
    discord.onEvent(async (event) => {
      await pipeline.dispatch(event);
    });
  });

  it('does not react to its own grant — the feedback loop', async () => {
    preReact(E_A, ALICE);
    await reconcileGuild(reconcilePorts(), { reason: 'timer' });
    expect(discord.memberRoles(ALICE)).toEqual([ROLE_A]);

    // Discord dispatches GUILD_MEMBER_UPDATE for the grant we just made.
    expect(discord.pendingMemberUpdates()).toBe(1);
    discord.resetCalls();
    const delivered = await discord.flushMemberUpdates();

    // One event in, no mutation out, and nothing further queued. Without the
    // self-mutation filter the handler would repair, the repair would echo, and
    // the echo would repair — until the breaker tripped.
    expect(delivered).toBe(1);
    expect(discord.restCalls('addRole')).toEqual([]);
    expect(discord.restCalls('removeRole')).toEqual([]);
    expect(discord.pendingMemberUpdates()).toBe(0);
  });

  it('repairs a role a moderator removed by hand, because the reaction stands', async () => {
    preReact(E_A, ALICE);
    await reconcileGuild(reconcilePorts(), { reason: 'timer' });
    await discord.flushMemberUpdates();

    // Nothing wrote a role_effects row for this: it did not come from us.
    await discord.removeRole(GUILD, ALICE, ROLE_A, 'by a moderator');
    await discord.flushMemberUpdates();

    expect(discord.memberRoles(ALICE)).toEqual([ROLE_A]);
    // And the repair's own echo settles rather than bouncing.
    await discord.flushMemberUpdates();
    expect(discord.memberRoles(ALICE)).toEqual([ROLE_A]);
  });

  it('revokes a role a moderator added by hand that no reaction asks for', async () => {
    preReact(E_A, ALICE);
    await grantByHand(ALICE, ROLE_B);

    await discord.flushMemberUpdates();

    // 🅱️ goes, because nothing asked for it. 🅰️ is *not* granted here even
    // though the reaction is there: only the option whose role changed is in
    // scope, and re-deriving the whole panel off an unrelated event would make
    // every manual role change a full reconciliation. The timer pass owns that.
    expect(discord.memberRoles(ALICE)).toEqual([]);
  });

  it('treats a change older than the window as external', async () => {
    preReact(E_A, ALICE);
    await reconcileGuild(reconcilePorts(), { reason: 'timer' });
    await discord.flushMemberUpdates();

    await discord.removeRole(GUILD, ALICE, ROLE_A, 'by a moderator');
    // Long enough that our own effect no longer counts as recent. The role is
    // gone and the reaction stands, so this is drift however it happened.
    discord.advance(SELF_MUTATION_WINDOW_MS * 2);
    await discord.flushMemberUpdates();

    expect(discord.memberRoles(ALICE)).toEqual([ROLE_A]);
  });

  it('ignores a role change that no panel offers', async () => {
    discord.resetCalls();
    await grantByHand(ALICE, UNRELATED);
    await discord.flushMemberUpdates();

    expect(discord.restCalls('fetchReactionUsers')).toEqual([]);
    expect(discord.memberRoles(ALICE)).toEqual([UNRELATED]);
  });

  it('repairs only the option that changed, leaving the rest alone', async () => {
    preReact(E_A, ALICE);
    preReact(E_B, ALICE);
    await reconcileGuild(reconcilePorts(), { reason: 'timer' });
    await discord.flushMemberUpdates();

    // The member withdraws 🅱️ while the bot is not watching, then a moderator
    // removes 🅰️'s role. Only 🅰️ is in the delta, so only 🅰️ is re-derived —
    // the stale 🅱️ role is left for the timer pass rather than being revoked on
    // the back of an unrelated event.
    unReactOffline(E_B, ALICE);
    await discord.removeRole(GUILD, ALICE, ROLE_A, 'by a moderator');
    await discord.flushMemberUpdates();

    expect(discord.memberRoles(ALICE).sort()).toEqual([ROLE_A, ROLE_B].sort());
  });

  /**
   * `previousRoleIds` is unknown whenever discord.js had no cached copy of the
   * member to diff against — routine on a live gateway, and something this fake
   * could not express until WP5 slice 6.
   *
   * Unknown is not empty. Read as empty, every role the member already holds
   * looks newly granted, and each one no reaction backs is revoked: a cache
   * miss turned into a mass revoke. The timer pass does not undo that either —
   * it visits members who reacted or whom the bot granted a role, and a member
   * whose roles were taken away on a phantom delta is in neither list.
   */
  it('does nothing when the previous roles are unknown, unlike a known delta', async () => {
    await grantByHand(ALICE, ROLE_A);
    discord.resetCalls();

    await discord.emitMemberUpdate({
      userId: ALICE,
      roleIds: [ROLE_A],
      previousRoleIds: undefined,
    });

    expect(discord.restCalls('fetchReactionUsers')).toEqual([]);
    expect(discord.memberRoles(ALICE)).toEqual([ROLE_A]);

    // The same roles with a known "before" *are* a delta, and this one is drift
    // the subscriber takes away. What the guard protects is not whether the
    // role is wrong; it is whether there is any evidence that it changed.
    await discord.emitMemberUpdate({ userId: ALICE, roleIds: [ROLE_A], previousRoleIds: [] });

    expect(discord.memberRoles(ALICE)).toEqual([]);
  });

  it('does nothing for a member update that changed no roles', async () => {
    discord.resetCalls();
    await discord.emitMemberUpdate({ userId: ALICE, roleIds: [], previousRoleIds: [] });

    expect(discord.restCalls('fetchReactionUsers')).toEqual([]);
  });
});

describe('the reconcile job', () => {
  it('runs the pass and reports through the worker', async () => {
    preReact(E_A, ALICE);
    jobRepo.enqueue(scope, {
      kind: JOB_KINDS.reconcileGuild,
      payload: JSON.stringify({ reason: 'timer' }),
      dedupeKey: reconcileDedupeKey('timer'),
      now: discord.now(),
    });

    const outcome = await worker().runOnce();

    expect(outcome).toMatchObject({ status: 'completed', kind: JOB_KINDS.reconcileGuild });
    expect(discord.memberRoles(ALICE)).toEqual([ROLE_A]);
  });

  it('rejects a payload it cannot validate rather than guessing', async () => {
    jobRepo.enqueue(scope, {
      kind: JOB_KINDS.reconcileGuild,
      payload: JSON.stringify({ reason: 'because-i-said-so' }),
      dedupeKey: reconcileDedupeKey('operator'),
      now: discord.now(),
    });

    const outcome = await worker().runOnce();

    expect(outcome.status).toBe('failed');
  });
});
