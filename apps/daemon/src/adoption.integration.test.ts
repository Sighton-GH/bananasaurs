import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  adoptDedupeKey,
  EffectGateway,
  JobWorker,
  JOB_KINDS,
  panelDefinitionSchema,
  parseGuildId,
  parseSnowflakeId,
  RateLimiter,
  runAdoptionPass,
  unicodeEmojiKey,
  type AdoptionPorts,
  type EffectGatewayDeps,
  type PanelDefinition,
} from '@bananasaurs/core';
import {
  authzStoreFor,
  effectRepo,
  guildRepo,
  isTargetProtected,
  jobRepo,
  jobStoreFor,
  panelRepo,
  read,
  schema,
  write,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { BOT_USER_ID, FakeDiscord } from '@bananasaurs/testkit';
import { adoptPanelHandler } from './jobs/adopt.js';
import { panelAuthorization, panelEffectsFor, panelStoreFor } from './panels/wiring.js';

/**
 * The adoption pass — collision 2 in `docs/19` §6.4.
 *
 * A panel with existing reactions needs one grant per reactor, which any sane
 * standing rate cap refuses. The pass therefore computes its **entire** change
 * list first and does nothing at all unless an owner-sized allowance covers it.
 *
 * Refusing without an allowance is the finished behaviour for WP3. These tests
 * grant the allowance directly; the CLI that lets the owner size and grant one
 * is slice 13 in WP5.
 */

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = parseSnowflakeId('222222222222222222');
const MESSAGE = parseSnowflakeId('333333333333333333');
const AUTHOR = parseSnowflakeId('444444444444444444');
const ROLE_A = parseSnowflakeId('666666666666666666');
const ROLE_B = parseSnowflakeId('777777777777777777');

const BRAIN = unicodeEmojiKey('🧠');
const CHECK = unicodeEmojiKey('✔️');

/** Enough reactors that the standing 20/minute cap could not carry them. */
const REACTORS = Array.from({ length: 12 }, (_, i) =>
  parseSnowflakeId(String(500000000000000000n + BigInt(i))),
);

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;
let rateLimiter: RateLimiter;
let ports: AdoptionPorts;
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
      { optionId: 'brain', roleId: ROLE_A, emojiKey: BRAIN, position: 0 },
      { optionId: 'check', roleId: ROLE_B, emojiKey: CHECK, position: 1 },
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

const buildPorts = (): AdoptionPorts => {
  const gateway = new EffectGateway(gatewayDeps());
  return {
    guildId: GUILD,
    botUserId: BOT_USER_ID,
    store: panelStoreFor(scope),
    discord,
    effects: panelEffectsFor(scope, gateway, panelAuthorization(scope), () => discord.now()),
    logger,
    now: () => discord.now(),
    newPassId: () => `pass-${passCounter++}`,
    allowanceFor: (source) => rateLimiter.bucketFor(source, discord.now()).allowance,
    setAdoptionPassState: (panelId, state) =>
      panelRepo.setAdoptionPassState(scope, panelId, state, discord.now()),
  };
};

/** Runs the pass outside the worker, with a cursor the caller can inspect. */
const runPass = async (panelId = 'roles') => {
  let cursor: string | null = null;
  const outcome = await runAdoptionPass(ports, {
    panelId,
    cursor: null,
    saveCursor: (next) => {
      cursor = next;
    },
  });
  return { outcome, cursor: cursor as string | null };
};

beforeEach(() => {
  passCounter = 0;
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);

  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });
  write(scope, ({ db }) => {
    db.update(schema.guilds).set({ dryRun: 0 }).where(scope.only(schema.guilds)).run();
    db.insert(schema.managedRoles).values({ guildId: GUILD, roleId: ROLE_A }).run();
    db.insert(schema.managedRoles).values({ guildId: GUILD, roleId: ROLE_B }).run();
  });

  discord = new FakeDiscord({ guildId: GUILD, botHighestRolePosition: 100 });
  discord.defineRole({ id: ROLE_A, name: 'brains', position: 10 });
  discord.defineRole({ id: ROLE_B, name: 'checked', position: 11 });
  discord.defineMember(BOT_USER_ID, []);
  discord.defineMessage({ channelId: CHANNEL, messageId: MESSAGE, authorId: AUTHOR });

  // Twelve members who already reacted, before the bot ever saw the message.
  for (const userId of REACTORS) {
    discord.defineMember(userId, []);
    discord.offlineReactionAdd({
      channelId: CHANNEL,
      messageId: MESSAGE,
      userId,
      emoji: BRAIN,
    });
  }

  panelRepo.createPanel(scope, definition(), discord.now());
  // The standing cap is deliberately smaller than the work, which is the whole
  // of collision 2: without an allowance this pass cannot legally proceed.
  rateLimiter = new RateLimiter(20);
  ports = buildPorts();
});

afterEach(() => {
  t.close();
});

describe('without an allowance', () => {
  it('does nothing at all', async () => {
    const { outcome } = await runPass();

    expect(outcome.status).toBe('awaiting-allowance');
    expect(outcome.applied).toBe(0);
    expect(discord.restCalls('addRole')).toEqual([]);
    for (const userId of REACTORS) expect(discord.memberRoles(userId)).toEqual([]);
  });

  it('leaves the panel pending, so status and doctor can see it', async () => {
    await runPass();
    expect(panelRepo.findPanel(scope, 'roles')?.adoptionPassState).toBe('pending');
  });

  it('reports the count an owner is being asked to approve', async () => {
    const { outcome } = await runPass();
    expect(outcome.changeCount).toBe(REACTORS.length);
    expect(outcome.memberCount).toBe(REACTORS.length);
  });

  it('stores the change list durably rather than only logging it', async () => {
    const { cursor } = await runPass();
    expect(cursor).not.toBeNull();
    const parsed = JSON.parse(cursor ?? '{}') as { changes: unknown[] };
    expect(parsed.changes).toHaveLength(REACTORS.length);
  });

  it('writes no effect rows, so nothing is half-applied', async () => {
    await runPass();
    const effects = read(scope, (db) =>
      db.select().from(schema.roleEffects).where(scope.only(schema.roleEffects)).all(),
    );
    expect(effects).toEqual([]);
  });

  it('refuses an allowance one short of the change list', async () => {
    // "Anything beyond the allowance — one more role than the owner approved —
    // trips the breaker normally." The pass does not start at all.
    rateLimiter.grantAllowance('adoption', REACTORS.length - 1, discord.now());
    const { outcome } = await runPass();
    expect(outcome.status).toBe('awaiting-allowance');
    expect(discord.restCalls('addRole')).toEqual([]);
  });
});

describe('with an owner-sized allowance', () => {
  beforeEach(() => {
    rateLimiter.grantAllowance('adoption', REACTORS.length, discord.now());
  });

  it('grants every existing reactor their role', async () => {
    const { outcome } = await runPass();

    expect(outcome.status).toBe('adopted');
    expect(outcome.applied).toBe(REACTORS.length);
    for (const userId of REACTORS) expect(discord.memberRoles(userId)).toEqual([ROLE_A]);
  });

  it('marks the panel done', async () => {
    await runPass();
    expect(panelRepo.findPanel(scope, 'roles')?.adoptionPassState).toBe('done');
  });

  it('spends the allowance rather than the standing cap', async () => {
    // `available()` is 20 either way — 20 tokens + 0 allowance, or 8 tokens +
    // 12 unspent allowance — so it proves nothing on its own. Draining the
    // bucket does: the standing 20 must all still be there.
    await runPass();
    const bucket = rateLimiter.bucketFor('adoption', discord.now());
    expect(bucket.allowance).toBe(0);

    let taken = 0;
    while (bucket.take(discord.now())) taken += 1;
    expect(taken).toBe(20);
  });

  it('does not trip the breaker', async () => {
    await runPass();
    expect(guildRepo.readSafetyState(scope)?.breakerOpen).toBe(false);
  });

  it('puts the whole adoption in one batch, so undo can reverse it', async () => {
    await runPass();
    const batches = read(scope, (db) =>
      db.select().from(schema.effectBatches).where(scope.only(schema.effectBatches)).all(),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]?.source).toBe('adoption');
    expect(effectRepo.effectsInBatch(scope, batches[0]?.batchId ?? '')).toHaveLength(
      REACTORS.length,
    );
  });

  it('writes a provenance row per granted role', async () => {
    await runPass();
    const rows = read(scope, (db) =>
      db
        .select()
        .from(schema.managedRoleAssignments)
        .where(scope.only(schema.managedRoleAssignments))
        .all(),
    );
    expect(rows).toHaveLength(REACTORS.length);
    expect(rows.every((r) => r.panelId === 'roles')).toBe(true);
  });

  it('is idempotent: a second pass finds nothing to do', async () => {
    await runPass();
    discord.resetCalls();

    const { outcome } = await runPass();
    expect(outcome.status).toBe('nothing-to-do');
    expect(discord.restCalls('addRole')).toEqual([]);
  });

  it("ignores the bot's own seeded reactions", async () => {
    // Seeding puts the bot on every emoji, and Discord's GET /reactions returns
    // it like any other user. Adopting must drop it, or the bot is granted
    // every role on the panel it just seeded.
    //
    // The allowance is deliberately generous. Sized to exactly the real change
    // list, an unfiltered bot would push the count one over and the pass would
    // refuse — which looks like the filter working while proving nothing. That
    // is how this test passed a mutation that removed the filter entirely.
    rateLimiter.grantAllowance('adoption', 100, discord.now());
    await discord.createReaction(GUILD, { channelId: CHANNEL, messageId: MESSAGE }, CHECK);

    const { outcome } = await runPass();

    expect(outcome.memberCount).toBe(REACTORS.length);
    expect(outcome.changeCount).toBe(REACTORS.length);
    expect(discord.memberRoles(BOT_USER_ID)).toEqual([]);
  });

  it('counts a member who already holds the role as no work', async () => {
    // Amendment 4 again: the count the owner approves reflects live Discord
    // state, so re-adopting a mostly-correct panel does not ask for a big
    // number and then do nothing.
    const already = REACTORS[0];
    if (already) await discord.addRole(GUILD, already, ROLE_A, 'set up by hand');

    const { outcome } = await runPass();
    expect(outcome.changeCount).toBe(REACTORS.length - 1);
  });
});

describe('a broken panel option — findings 1 and 2b', () => {
  const CARA = parseSnowflakeId('553333333333333333');

  beforeEach(() => {
    discord.defineMember(CARA, []);
    discord.offlineReactionAdd({
      channelId: CHANNEL,
      messageId: MESSAGE,
      userId: CARA,
      emoji: CHECK,
    });
  });

  it('skips one option Discord refuses to read (Unknown Emoji), instead of failing the whole pass', async () => {
    // Live evidence, docs/reports/WP5-slice-6-live-test.md finding 2b: a bad
    // default emoji (scripts/seed-test-panel.mjs's own beyond A/B) threw
    // uncaught out of runAdoptionPass entirely — five retries and the job
    // dead. BRAIN is position 0, so this hits its reactor fetch first.
    discord.failNext('fetchReactionUsers', FakeDiscord.unknownEmoji());
    rateLimiter.grantAllowance('adoption', 1, discord.now());

    const { outcome } = await runPass();

    expect(outcome.status).toBe('adopted');
    // BRAIN's option was skipped this pass — no different from finding no
    // reactors — so none of the twelve reactors are counted or granted.
    // CHECK, unaffected, still contributes CARA's grant.
    expect(outcome.changeCount).toBe(1);
    expect(outcome.applied).toBe(1);
    expect(discord.memberRoles(CARA)).toEqual([ROLE_B]);
    for (const userId of REACTORS) expect(discord.memberRoles(userId)).toEqual([]);
  });

  it('still fails the pass on an error that is not Unknown Emoji, rather than silently under-counting', async () => {
    // A rate limit or a network fault must not be swallowed the same way: a
    // pass that cannot tell "no reactors" from "could not check" must not
    // guess at an owner-facing change count. It has to fail loudly.
    discord.failNext('fetchReactionUsers', FakeDiscord.rateLimited());
    await expect(runPass()).rejects.toThrow();
  });
});

describe('paging', () => {
  it('reads every reactor across more than one page', async () => {
    // Discord caps a page at 100 whatever you ask for, so a well-used panel is
    // several calls. Getting this wrong silently adopts only the first 100.
    const many = Array.from({ length: 150 }, (_, i) =>
      parseSnowflakeId(String(700000000000000000n + BigInt(i))),
    );
    for (const userId of many) {
      discord.defineMember(userId, []);
      discord.offlineReactionAdd({ channelId: CHANNEL, messageId: MESSAGE, userId, emoji: CHECK });
    }
    rateLimiter.grantAllowance('adoption', 1000, discord.now());

    const { outcome } = await runPass();
    expect(outcome.memberCount).toBe(REACTORS.length + many.length);
    for (const userId of many) expect(discord.memberRoles(userId)).toEqual([ROLE_B]);
  });
});

describe('as a job', () => {
  it('runs through the worker and stores its cursor', async () => {
    rateLimiter.grantAllowance('adoption', REACTORS.length, discord.now());

    const enqueued = jobRepo.enqueue(scope, {
      kind: JOB_KINDS.adoptPanel,
      payload: JSON.stringify({ panelId: 'roles' }),
      dedupeKey: adoptDedupeKey('roles'),
      now: discord.now(),
    });
    expect(enqueued.enqueued).toBe(true);

    const worker = new JobWorker({
      store: jobStoreFor(scope),
      handlers: [adoptPanelHandler(ports)],
      logger,
      now: () => discord.now(),
    });
    const outcome = await worker.runOnce();

    expect(outcome.status).toBe('completed');
    expect(panelRepo.findPanel(scope, 'roles')?.adoptionPassState).toBe('done');
    expect(jobRepo.findJob(scope, enqueued.jobId ?? -1)?.cursor).toContain('changes');
  });

  it('fails permanently for a panel that does not exist', async () => {
    jobRepo.enqueue(scope, {
      kind: JOB_KINDS.adoptPanel,
      payload: JSON.stringify({ panelId: 'no-such-panel' }),
      dedupeKey: adoptDedupeKey('no-such-panel'),
      now: discord.now(),
    });

    const worker = new JobWorker({
      store: jobStoreFor(scope),
      handlers: [adoptPanelHandler(ports)],
      logger,
      now: () => discord.now(),
    });
    const outcome = await worker.runOnce();
    expect(outcome.status).toBe('failed');
  });

  it('can be enqueued again after the first pass finished (ADR 0016)', async () => {
    // The refuse-then-grant-then-run cycle depends on this. With the WP2 index
    // the second enqueue was a silent no-op and adoption could never happen.
    const first = jobRepo.enqueue(scope, {
      kind: JOB_KINDS.adoptPanel,
      payload: JSON.stringify({ panelId: 'roles' }),
      dedupeKey: adoptDedupeKey('roles'),
      now: discord.now(),
    });
    const worker = new JobWorker({
      store: jobStoreFor(scope),
      handlers: [adoptPanelHandler(ports)],
      logger,
      now: () => discord.now(),
    });
    await worker.runOnce();
    expect(jobRepo.findJob(scope, first.jobId ?? -1)?.state).toBe('done');
    expect(panelRepo.findPanel(scope, 'roles')?.adoptionPassState).toBe('pending');

    rateLimiter.grantAllowance('adoption', REACTORS.length, discord.now());
    const second = jobRepo.enqueue(scope, {
      kind: JOB_KINDS.adoptPanel,
      payload: JSON.stringify({ panelId: 'roles' }),
      dedupeKey: adoptDedupeKey('roles'),
      now: discord.now(),
    });
    expect(second.enqueued).toBe(true);

    await worker.runOnce();
    expect(panelRepo.findPanel(scope, 'roles')?.adoptionPassState).toBe('done');
    for (const userId of REACTORS) expect(discord.memberRoles(userId)).toEqual([ROLE_A]);
  });
});
