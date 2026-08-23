import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  authorize,
  EffectGateway,
  parseGuildId,
  parseSnowflakeId,
  RateLimiter,
  undoBatch,
  type Actor,
  type Authorized,
  type EffectGatewayDeps,
  type RoleIntent,
  type UndoableEffect,
} from '@bananasaurs/core';
import {
  authzRepo,
  authzStoreFor,
  effectRepo,
  guildRepo,
  isTargetProtected,
  schema,
  write,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { FakeDiscord } from '@bananasaurs/testkit';

/**
 * The effect gateway wired to the real database.
 *
 * `packages/testkit/src/gateway.integration.test.ts` proves the *ordering* of
 * the safety layers with in-memory ports. This proves the parts only SQL can:
 * that `role_effects_dedupe` really does make a replay a no-op, that the
 * foreign key into `managed_roles` really is the role allowlist, that an audit
 * row is really written, and that undo really restores prior state.
 *
 * The distinction matters because a fake claiming "already claimed" agrees with
 * itself for free. A UNIQUE index either exists or it does not.
 */

const GUILD = parseGuildId('111111111111111111');
const USER = parseSnowflakeId('222222222222222222');
const ROLE = parseSnowflakeId('333333333333333333');
const ACTOR_ROLE = parseSnowflakeId('444444444444444444');
/** Someone other than the actor, so target-side protection can be tested. */
const TARGET = parseSnowflakeId('555555555555555555');

const logger = pino({ level: 'silent' });
const actor: Actor = { type: 'member', id: USER, roleIds: [ACTOR_ROLE] };

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;
let gateway: EffectGateway;

const witness = (): Authorized<'roles.mutate'> => {
  const result = authorize({ store: authzStoreFor(scope), guildId: GUILD, actor }, 'roles.mutate');
  if (!result.ok) throw new Error(`test setup: ${result.error.reason}`);
  return result.value;
};

const intent = (over: Partial<RoleIntent> = {}): RoleIntent => ({
  userId: USER,
  roleId: ROLE,
  action: 'grant',
  panelId: undefined,
  triggerRef: '900000000000000001',
  source: 'interaction',
  batchId: 'batch-1',
  reason: 'panel click',
  ...over,
});

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);

  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });
  // dry_run defaults ON for an unconfigured guild (docs/18 Layer 4), so a test
  // exercising real calls has to turn it off explicitly. That default is the
  // point: an unconfigured guild performs no writes.
  write(scope, ({ db }) => {
    db.update(schema.guilds).set({ dryRun: 0 }).where(scope.only(schema.guilds)).run();
  });

  write(scope, ({ db }) => {
    db.insert(schema.managedRoles).values({ guildId: GUILD, roleId: ROLE }).run();
  });

  authzRepo.upsertPrincipal(scope, { principalType: 'user', principalId: USER });
  authzRepo.grantCapability(scope, {
    principalType: 'user',
    principalId: USER,
    capability: 'roles.mutate',
    grantedBy: 'test',
    now: 0,
  });
  authzRepo.grantCapability(scope, {
    principalType: 'user',
    principalId: USER,
    capability: 'undo.execute',
    grantedBy: 'test',
    now: 0,
  });

  effectRepo.openBatch(scope, {
    batchId: 'batch-1',
    source: 'interaction',
    actorType: 'member',
    actorId: USER,
    now: 0,
  });

  discord = new FakeDiscord({ guildId: GUILD, botHighestRolePosition: 100 });
  discord.defineRole({ id: ROLE, name: 'members', position: 10 });
  discord.defineMember(USER, []);
  discord.defineMember(TARGET, []);

  const deps: EffectGatewayDeps = {
    guildId: GUILD,
    authz: authzStoreFor(scope),
    discord,
    rateLimiter: new RateLimiter(100),
    logger,
    now: () => discord.now(),
    state: {
      read: () => guildRepo.readSafetyState(scope),
      isPanelEnabled: () => true,
      isRoleAllowlisted: (roleId) => isAllowlisted(roleId),
      isTargetProtected: (userId, roleId) => isTargetProtected(scope, { userId, roleId }),
      tripBreaker: (reason, atMs) => guildRepo.tripBreaker(scope, reason, atMs),
    },
    effects: {
      claim: ({ dedupeKey, intent: i, hadRoleBefore, atMs }) =>
        effectRepo.claimEffect(scope, {
          dedupeKey,
          batchId: i.batchId,
          userId: i.userId,
          roleId: i.roleId,
          action: i.action,
          hadRoleBefore,
          panelId: i.panelId,
          now: atMs,
        }),
      record: (input) =>
        effectRepo.recordOutcome(scope, {
          effectId: input.effectId,
          state: input.state,
          completedAt: input.completedAtMs,
          errorCode: input.errorCode,
        }),
    },
    audit: {
      record: (input) =>
        effectRepo.recordAudit(scope, {
          at: input.atMs,
          actorType: input.actor.type,
          actorId: input.actor.id,
          via: 'gateway',
          action: input.action,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          batchId: input.batchId,
          before: input.before,
          after: input.after,
          dryRun: input.dryRun,
        }),
    },
  };

  gateway = new EffectGateway(deps);
});

afterEach(() => {
  t.close();
});

const isAllowlisted = (roleId: string): boolean =>
  write(scope, ({ db }) => {
    const row = db
      .select({ roleId: schema.managedRoles.roleId })
      .from(schema.managedRoles)
      .where(scope.only(schema.managedRoles))
      .all()
      .find((r) => r.roleId === roleId);
    return row !== undefined;
  });

describe('the idempotency constraint is real SQL, not a fake agreeing with itself', () => {
  it('makes a replayed effect a no-op', async () => {
    await gateway.applyRoleEffect(witness(), intent());
    // Pretend the role came back off, so a second grant would otherwise apply.
    discord.defineMember(USER, []);

    const replay = await gateway.applyRoleEffect(witness(), intent());

    expect(replay).toEqual({ status: 'skipped', reason: 'already-applied' });
    expect(discord.restCalls('addRole')).toHaveLength(1);
    expect(effectRepo.effectsInBatch(scope, 'batch-1')).toHaveLength(1);
  });

  it('lets a genuinely different trigger through', async () => {
    // A member toggling a role off and on again is legitimate. Swallowing the
    // second action would be a bug that looks exactly like working dedupe.
    await gateway.applyRoleEffect(witness(), intent());
    discord.defineMember(USER, []);

    await gateway.applyRoleEffect(witness(), intent({ triggerRef: '900000000000000002' }));

    expect(discord.restCalls('addRole')).toHaveLength(2);
    expect(effectRepo.effectsInBatch(scope, 'batch-1')).toHaveLength(2);
  });
});

describe('the audit trail', () => {
  it('records one row per applied effect, with before and after', async () => {
    await gateway.applyRoleEffect(witness(), intent());

    const rows = effectRepo.tailAudit(scope);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'role.grant',
      actorType: 'member',
      actorId: USER,
      batchId: 'batch-1',
      dryRun: 0,
    });
    expect(JSON.parse(rows[0]?.before ?? 'null')).toEqual({ hasRole: false });
    expect(JSON.parse(rows[0]?.after ?? 'null')).toEqual({ hasRole: true });
  });

  it('records a dry run with dry_run = 1 and makes no Discord call', async () => {
    write(scope, ({ db }) => {
      db.update(schema.guilds).set({ dryRun: 1 }).where(scope.only(schema.guilds)).run();
    });

    const outcome = await gateway.applyRoleEffect(witness(), intent());

    expect(outcome.status).toBe('dry-run');
    expect(discord.restCalls('addRole')).toHaveLength(0);
    expect(effectRepo.tailAudit(scope)[0]).toMatchObject({ dryRun: 1 });
  });
});

describe('the role allowlist is a foreign key, not a guard clause', () => {
  it('cannot record an effect for a role outside managed_roles', () => {
    // The gateway refuses first, so this asserts the constraint underneath —
    // the thing that still holds if someone writes a new caller tomorrow.
    const unlisted = parseSnowflakeId('777777777777777777');
    expect(() =>
      effectRepo.claimEffect(scope, {
        dedupeKey: 'k',
        batchId: 'batch-1',
        userId: USER,
        roleId: unlisted,
        action: 'grant',
        hadRoleBefore: false,
        panelId: undefined,
        now: 0,
      }),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('cannot record an effect against a batch in another guild', () => {
    const other = t.scopes.forGuild(parseGuildId('888888888888888888'));
    guildRepo.upsertGuild(other, { name: 'other', now: 0 });

    expect(() =>
      effectRepo.claimEffect(other, {
        dedupeKey: 'k',
        batchId: 'batch-1', // exists, but belongs to GUILD
        userId: USER,
        roleId: ROLE,
        action: 'grant',
        hadRoleBefore: false,
        panelId: undefined,
        now: 0,
      }),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe('the protected principal check reads the real table', () => {
  /**
   * `protected` means exactly one thing (ADR 0015): the bot will not mutate
   * this member or this role, whoever asks.
   *
   * The plan was ambiguous and I first implemented a second meaning as well —
   * that a protected principal holds no capability. Owner review settled it:
   * target-only. The last test here pins the rejected reading down, because
   * "protecting the role you act through locks you out of your own bot" is
   * exactly the kind of thing someone re-adds in good faith later.
   */
  it('refuses to mutate a protected member', async () => {
    authzRepo.upsertPrincipal(scope, {
      principalType: 'user',
      principalId: TARGET,
      protected: true,
    });

    expect(await gateway.applyRoleEffect(witness(), intent({ userId: TARGET }))).toMatchObject({
      reason: 'protected-target',
    });
  });

  it('refuses to touch a protected role', async () => {
    authzRepo.upsertPrincipal(scope, {
      principalType: 'role',
      principalId: ROLE,
      protected: true,
    });

    expect(await gateway.applyRoleEffect(witness(), intent({ userId: TARGET }))).toMatchObject({
      reason: 'protected-target',
    });
  });

  it('does NOT deny capability to a protected actor', async () => {
    // Protecting yourself must not lock you out. The actor here is protected
    // and still acts; only the target side refuses.
    authzRepo.upsertPrincipal(scope, {
      principalType: 'user',
      principalId: USER,
      protected: true,
    });

    const result = authorize(
      { store: authzStoreFor(scope), guildId: GUILD, actor },
      'roles.mutate',
    );
    expect(result.ok).toBe(true);

    // ...and can still change someone else's roles.
    expect(await gateway.applyRoleEffect(witness(), intent({ userId: TARGET }))).toMatchObject({
      status: 'applied',
    });
  });
});

describe('capability comes only from capability_grants', () => {
  it('refuses once the grant is revoked, with no other change', async () => {
    authzRepo.revokeCapability(scope, {
      principalType: 'user',
      principalId: USER,
      capability: 'roles.mutate',
    });

    const result = authorize(
      { store: authzStoreFor(scope), guildId: GUILD, actor },
      'roles.mutate',
    );
    expect(result).toMatchObject({ ok: false, error: { reason: 'no-grant' } });
  });

  it('reaches a member through a grant made to a role they hold', async () => {
    authzRepo.revokeCapability(scope, {
      principalType: 'user',
      principalId: USER,
      capability: 'roles.mutate',
    });
    authzRepo.upsertPrincipal(scope, { principalType: 'role', principalId: ACTOR_ROLE });
    authzRepo.grantCapability(scope, {
      principalType: 'role',
      principalId: ACTOR_ROLE,
      capability: 'roles.mutate',
      grantedBy: 'test',
      now: 0,
    });

    expect(await gateway.applyRoleEffect(witness(), intent())).toMatchObject({ status: 'applied' });
  });

  it('does not match a grant made to a role of the same id but the other type', async () => {
    // Built as an OR of exact (type, id) pairs rather than two IN lists, which
    // would match the cross product.
    authzRepo.revokeCapability(scope, {
      principalType: 'user',
      principalId: USER,
      capability: 'roles.mutate',
    });
    authzRepo.upsertPrincipal(scope, { principalType: 'role', principalId: USER });
    authzRepo.grantCapability(scope, {
      principalType: 'role',
      principalId: USER, // same id, different type
      capability: 'roles.mutate',
      grantedBy: 'test',
      now: 0,
    });

    const result = authorize(
      { store: authzStoreFor(scope), guildId: GUILD, actor },
      'roles.mutate',
    );
    expect(result).toMatchObject({ ok: false, error: { reason: 'no-grant' } });
  });
});

describe('undo, through the real tables', () => {
  const undoAuth = () => {
    const undo = authorize({ store: authzStoreFor(scope), guildId: GUILD, actor }, 'undo.execute');
    if (!undo.ok) throw new Error('test setup');
    return { undo: undo.value, mutate: witness() };
  };

  const undoPorts = () => ({
    guildId: GUILD,
    effectsInBatch: (batchId: string): UndoableEffect[] =>
      effectRepo.effectsInBatch(scope, batchId).map((row) => ({
        effectId: row.effectId,
        userId: parseSnowflakeId(row.userId),
        roleId: parseSnowflakeId(row.roleId),
        action: row.action === 'revoke' ? ('revoke' as const) : ('grant' as const),
        state: row.state,
        hadRoleBefore: row.hadRoleBefore === 1,
        panelId: row.panelId ?? undefined,
      })),
    openBatch: (input: {
      source: 'cli' | 'dashboard';
      actorType: string;
      actorId: string | undefined;
    }) => effectRepo.openBatch(scope, { ...input, now: discord.now() }),
    closeBatch: (batchId: string) => effectRepo.closeBatch(scope, batchId, discord.now()),
    markBatchUndone: (batchId: string) => effectRepo.markBatchUndone(scope, batchId, discord.now()),
    logger,
  });

  it('restores the prior state', async () => {
    await gateway.applyRoleEffect(witness(), intent());
    expect(discord.restCalls('addRole')).toHaveLength(1);

    const result = await undoBatch(gateway, undoAuth(), undoPorts(), {
      batchId: 'batch-1',
      source: 'cli',
      reason: 'operator undo',
    });

    expect(result.reversed).toBe(1);
    expect(discord.restCalls('removeRole')).toHaveLength(1);
  });

  it('marks the original batch undone', async () => {
    await gateway.applyRoleEffect(witness(), intent());
    await undoBatch(gateway, undoAuth(), undoPorts(), {
      batchId: 'batch-1',
      source: 'cli',
      reason: 'operator undo',
    });

    expect(effectRepo.findBatch(scope, 'batch-1')?.undoneAt).not.toBeNull();
  });

  it('writes its own batch and its own audit rows', async () => {
    // An undo that left no trace would be an unaudited way to change roles.
    await gateway.applyRoleEffect(witness(), intent());
    const result = await undoBatch(gateway, undoAuth(), undoPorts(), {
      batchId: 'batch-1',
      source: 'cli',
      reason: 'operator undo',
    });

    expect(effectRepo.findBatch(scope, result.undoBatchId)).toBeDefined();
    const audits = effectRepo.tailAudit(scope);
    expect(audits.map((a) => a.action)).toEqual(['role.revoke', 'role.grant']);
  });

  it('does not strip a role the member already had before the batch', async () => {
    // The failure had_role_before exists to prevent. The member holds the role
    // independently; a batch that granted it changed nothing, so undoing that
    // batch must not take it away.
    discord.defineMember(USER, [ROLE]);
    const outcome = await gateway.applyRoleEffect(witness(), intent());
    expect(outcome).toEqual({ status: 'skipped', reason: 'no-change-needed' });

    // Force the "granted a role they already had" shape into the table.
    effectRepo.claimEffect(scope, {
      dedupeKey: 'already-had-it',
      batchId: 'batch-1',
      userId: USER,
      roleId: ROLE,
      action: 'grant',
      hadRoleBefore: true,
      panelId: undefined,
      now: 0,
    });
    const rows = effectRepo.effectsInBatch(scope, 'batch-1');
    effectRepo.recordOutcome(scope, {
      effectId: rows[0]?.effectId ?? '',
      state: 'applied',
      completedAt: 0,
    });

    const result = await undoBatch(gateway, undoAuth(), undoPorts(), {
      batchId: 'batch-1',
      source: 'cli',
      reason: 'operator undo',
    });

    expect(result.reversed).toBe(0);
    expect(discord.restCalls('removeRole')).toHaveLength(0);
  });
});
