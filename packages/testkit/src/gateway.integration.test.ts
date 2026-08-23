import { beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  authorize,
  dedupeKeyFor,
  EffectGateway,
  inverseOf,
  parseGuildId,
  parseSnowflakeId,
  RateLimiter,
  undoBatch,
  type Actor,
  type AuditInput,
  type Authorized,
  type AuthzStore,
  type EffectGatewayDeps,
  type EffectRecordInput,
  type RoleIntent,
  type SafetyState,
  type UndoableEffect,
} from '@bananasaurs/core';
import { FakeDiscord } from './fake-discord.js';

/**
 * The effect gateway, driven through the fake Discord harness.
 *
 * Every safety control lives in one function, which is what makes "is dry-run
 * respected?" one test rather than an audit of every call site. These tests
 * exercise each layer through the real `applyRoleEffect`, with the database
 * side stubbed in memory — the SQL is proved separately in
 * `apps/daemon/src/effects.integration.test.ts`.
 */

const GUILD = parseGuildId('111111111111111111');
const USER = parseSnowflakeId('222222222222222222');
const ROLE = parseSnowflakeId('333333333333333333');
const ACTOR_ROLE = parseSnowflakeId('444444444444444444');

const logger = pino({ level: 'silent' });

const actor: Actor = { type: 'member', id: USER, roleIds: [ACTOR_ROLE] };

const permissiveAuthz: AuthzStore = { hasGrant: () => true, anyProtected: () => false };

const witnessFor = (store: AuthzStore = permissiveAuthz): Authorized<'roles.mutate'> => {
  const result = authorize({ store, guildId: GUILD, actor }, 'roles.mutate');
  if (!result.ok) throw new Error('test setup: expected authorization to succeed');
  return result.value;
};

interface Harness {
  discord: FakeDiscord;
  gateway: EffectGateway;
  audits: AuditInput[];
  records: EffectRecordInput[];
  claimed: Set<string>;
  breakerTrips: string[];
  state: SafetyState;
  setState(patch: Partial<SafetyState>): void;
}

const build = (
  over: Partial<EffectGatewayDeps> = {},
  options: { botPosition?: number } = {},
): Harness => {
  const discord = new FakeDiscord({
    guildId: GUILD,
    botHighestRolePosition: options.botPosition ?? 100,
  });
  discord.defineRole({ id: ROLE, name: 'members', position: 10 });
  discord.defineMember(USER, []);

  const audits: AuditInput[] = [];
  const records: EffectRecordInput[] = [];
  const claimed = new Set<string>();
  const breakerTrips: string[] = [];
  const state: SafetyState = {
    killswitch: false,
    dryRun: false,
    breakerOpen: false,
    breakerThreshold: 5,
  };

  const deps: EffectGatewayDeps = {
    guildId: GUILD,
    authz: permissiveAuthz,
    discord,
    rateLimiter: new RateLimiter(100),
    logger,
    now: () => discord.now(),
    state: {
      read: () => state,
      isPanelEnabled: () => true,
      isRoleAllowlisted: () => true,
      isTargetProtected: () => false,
      tripBreaker: (reason) => breakerTrips.push(reason),
    },
    effects: {
      claim: ({ dedupeKey }) => {
        if (claimed.has(dedupeKey)) return { claimed: false, effectId: `effect-${dedupeKey}` };
        claimed.add(dedupeKey);
        return { claimed: true, effectId: `effect-${dedupeKey}` };
      },
      record: (input) => records.push(input),
    },
    audit: { record: (input) => audits.push(input) },
    ...over,
  };

  return {
    discord,
    gateway: new EffectGateway(deps),
    audits,
    records,
    claimed,
    breakerTrips,
    state,
    setState(patch) {
      Object.assign(state, patch);
    },
  };
};

const intent = (over: Partial<RoleIntent> = {}): RoleIntent => ({
  userId: USER,
  roleId: ROLE,
  action: 'grant',
  panelId: 'panel-1',
  triggerRef: '900000000000000001',
  source: 'interaction',
  batchId: 'batch-1',
  reason: 'panel click',
  ...over,
});

let h: Harness;
beforeEach(() => {
  h = build();
});

describe('layer 1 — authorization is re-verified at runtime', () => {
  it('refuses when the grant has been revoked since the witness was issued', () => {
    // The witness says the check passed. It is erased at runtime and a cast
    // produces one for free, so the gateway asks again. This is the control;
    // the type is only the reminder.
    const stale = witnessFor();
    const revoked = build({ authz: { hasGrant: () => false, anyProtected: () => false } });

    return expect(revoked.gateway.applyRoleEffect(stale, intent())).resolves.toEqual({
      status: 'refused',
      reason: 'unauthorized',
    });
  });

  it('refuses a witness issued for a different guild', async () => {
    const otherGuild = parseGuildId('555555555555555555');
    const foreign = authorize(
      { store: permissiveAuthz, guildId: otherGuild, actor },
      'roles.mutate',
    );
    if (!foreign.ok) throw new Error('test setup');

    expect(await h.gateway.applyRoleEffect(foreign.value, intent())).toEqual({
      status: 'refused',
      reason: 'unauthorized',
    });
  });

  it('makes no Discord call when refused', async () => {
    const revoked = build({ authz: { hasGrant: () => false, anyProtected: () => false } });
    await revoked.gateway.applyRoleEffect(witnessFor(), intent());
    expect(revoked.discord.restCalls()).toHaveLength(0);
  });
});

describe('layers 2 and 3 — kill switch and breaker', () => {
  it('refuses while the kill switch is on', async () => {
    h.setState({ killswitch: true });
    expect(await h.gateway.applyRoleEffect(witnessFor(), intent())).toEqual({
      status: 'refused',
      reason: 'killswitch',
    });
    expect(h.discord.restCalls()).toHaveLength(0);
  });

  it('refuses while the breaker is open', async () => {
    h.setState({ breakerOpen: true });
    expect(await h.gateway.applyRoleEffect(witnessFor(), intent())).toMatchObject({
      reason: 'breaker-open',
    });
  });

  it('refuses when the guild is unknown', async () => {
    const unknown = build({ state: { ...buildState(), read: () => undefined } });
    expect(await unknown.gateway.applyRoleEffect(witnessFor(), intent())).toMatchObject({
      reason: 'guild-unknown',
    });
  });
});

function buildState(): EffectGatewayDeps['state'] {
  return {
    read: () => ({ killswitch: false, dryRun: false, breakerOpen: false, breakerThreshold: 5 }),
    isPanelEnabled: () => true,
    isRoleAllowlisted: () => true,
    isTargetProtected: () => false,
    tripBreaker: () => undefined,
  };
}

describe('layers 4, 5 and 6 — panel status, allowlist, protected target', () => {
  it('refuses when the doctor has disabled the panel', async () => {
    const disabled = build({ state: { ...buildState(), isPanelEnabled: () => false } });
    expect(await disabled.gateway.applyRoleEffect(witnessFor(), intent())).toMatchObject({
      reason: 'panel-disabled',
    });
  });

  it('does not consult panel status for an action with no panel', async () => {
    // A CLI or reconciliation action is not driven by a panel and must not be
    // blocked by one.
    const disabled = build({ state: { ...buildState(), isPanelEnabled: () => false } });
    const outcome = await disabled.gateway.applyRoleEffect(
      witnessFor(),
      intent({ panelId: undefined, source: 'cli' }),
    );
    expect(outcome.status).toBe('applied');
  });

  it('refuses a role outside the allowlist', async () => {
    const notListed = build({ state: { ...buildState(), isRoleAllowlisted: () => false } });
    expect(await notListed.gateway.applyRoleEffect(witnessFor(), intent())).toMatchObject({
      reason: 'role-not-allowlisted',
    });
  });

  it('refuses a protected target', async () => {
    const protectedTarget = build({ state: { ...buildState(), isTargetProtected: () => true } });
    expect(await protectedTarget.gateway.applyRoleEffect(witnessFor(), intent())).toMatchObject({
      reason: 'protected-target',
    });
  });

  it('refuses the guild owner, whom Discord never lets a bot touch', async () => {
    h.discord.defineMember(USER, [], true);
    expect(await h.gateway.applyRoleEffect(witnessFor(), intent())).toMatchObject({
      reason: 'protected-target',
    });
  });
});

describe('layer 7 — hierarchy, checked live and immediately before acting', () => {
  it('refuses a role above the bot', async () => {
    const high = build({}, { botPosition: 5 });
    expect(await high.gateway.applyRoleEffect(witnessFor(), intent())).toMatchObject({
      reason: 'role-above-bot',
    });
  });

  it('refuses a role at exactly the bot position', async () => {
    // The off-by-one that breaks panels after somebody reorders roles.
    const level = build({}, { botPosition: 10 });
    expect(await level.gateway.applyRoleEffect(witnessFor(), intent())).toMatchObject({
      reason: 'role-above-bot',
    });
  });

  it('refuses an integration-managed role at any position', async () => {
    h.discord.defineRole({ id: ROLE, name: 'booster', position: 10, managed: true });
    expect(await h.gateway.applyRoleEffect(witnessFor(), intent())).toMatchObject({
      reason: 'role-managed',
    });
  });

  it('refuses a role that no longer exists', async () => {
    const missing = parseSnowflakeId('666666666666666666');
    expect(
      await h.gateway.applyRoleEffect(witnessFor(), intent({ roleId: missing })),
    ).toMatchObject({ reason: 'role-missing' });
  });

  it('re-reads the hierarchy on every call rather than caching it', async () => {
    await h.gateway.applyRoleEffect(witnessFor(), intent());
    h.discord.resetCalls();
    await h.gateway.applyRoleEffect(witnessFor(), intent({ triggerRef: 'another' }));
    expect(h.discord.restCalls('fetchRoles')).toHaveLength(1);
  });
});

describe('the no-op check', () => {
  it('skips granting a role the member already has', async () => {
    h.discord.defineMember(USER, [ROLE]);
    expect(await h.gateway.applyRoleEffect(witnessFor(), intent())).toEqual({
      status: 'skipped',
      reason: 'no-change-needed',
    });
    expect(h.discord.restCalls('addRole')).toHaveLength(0);
  });

  it('skips revoking a role the member does not have', async () => {
    expect(await h.gateway.applyRoleEffect(witnessFor(), intent({ action: 'revoke' }))).toEqual({
      status: 'skipped',
      reason: 'no-change-needed',
    });
  });

  it('does not spend rate budget on a no-op', async () => {
    // Convergence runs constantly and is mostly no-ops. Charging for them would
    // exhaust the cap without a single real change.
    const limiter = new RateLimiter(1);
    const cheap = build({ rateLimiter: limiter });
    cheap.discord.defineMember(USER, [ROLE]);

    await cheap.gateway.applyRoleEffect(witnessFor(), intent());
    await cheap.gateway.applyRoleEffect(witnessFor(), intent({ triggerRef: 'b' }));

    expect(limiter.bucketFor('interaction', 0).available(0)).toBe(1);
  });
});

describe('layer 8 — the rate cap trips the breaker', () => {
  it('refuses and trips once the budget is exhausted', async () => {
    const limiter = new RateLimiter(1);
    const capped = build({ rateLimiter: limiter });

    await capped.gateway.applyRoleEffect(witnessFor(), intent({ triggerRef: 'a' }));
    capped.discord.defineMember(USER, []); // undo the fake's state change
    const second = await capped.gateway.applyRoleEffect(witnessFor(), intent({ triggerRef: 'b' }));

    expect(second).toMatchObject({ reason: 'rate-cap' });
    expect(capped.breakerTrips).toHaveLength(1);
    expect(capped.breakerTrips[0]).toContain('interaction');
  });

  it('does not let one source exhaust another', async () => {
    const limiter = new RateLimiter(1);
    const capped = build({ rateLimiter: limiter });

    await capped.gateway.applyRoleEffect(witnessFor(), intent({ triggerRef: 'a' }));
    capped.discord.defineMember(USER, []);
    const other = await capped.gateway.applyRoleEffect(
      witnessFor(),
      intent({ triggerRef: 'c', source: 'reconcile', panelId: undefined }),
    );

    expect(other.status).toBe('applied');
  });
});

describe('layer 9 — idempotency', () => {
  it('skips an effect that was already claimed', async () => {
    await h.gateway.applyRoleEffect(witnessFor(), intent());
    h.discord.defineMember(USER, []); // pretend the role came off again

    expect(await h.gateway.applyRoleEffect(witnessFor(), intent())).toEqual({
      status: 'skipped',
      reason: 'already-applied',
    });
    expect(h.discord.restCalls('addRole')).toHaveLength(1);
  });

  it('treats a different trigger as different work', async () => {
    // A member toggling a role off and on again is legitimate and must not be
    // swallowed as a replay. The trigger ref is what separates them.
    await h.gateway.applyRoleEffect(witnessFor(), intent());
    h.discord.defineMember(USER, []);

    const outcome = await h.gateway.applyRoleEffect(
      witnessFor(),
      intent({ triggerRef: '900000000000000002' }),
    );
    expect(outcome.status).toBe('applied');
  });

  it('claims before calling Discord, so a crash cannot double-grant', async () => {
    // If the claim came after the call, a process death between them would
    // leave the effect unrecorded and a replay would grant a second time.
    const order: string[] = [];
    const ordered = build({
      effects: {
        claim: ({ dedupeKey }) => {
          order.push('claim');
          return { claimed: true, effectId: dedupeKey };
        },
        record: () => order.push('record'),
      },
    });
    ordered.discord.onEvent(() => undefined);
    await ordered.gateway.applyRoleEffect(witnessFor(), intent());

    expect(order[0]).toBe('claim');
  });

  it('computes the documented dedupe key', () => {
    const key = dedupeKeyFor(GUILD, intent());
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Changing any component changes the key.
    expect(dedupeKeyFor(GUILD, intent({ action: 'revoke' }))).not.toBe(key);
    expect(dedupeKeyFor(GUILD, intent({ triggerRef: 'other' }))).not.toBe(key);
  });
});

describe('layer 10 — dry run', () => {
  it('makes no Discord write call at all', async () => {
    h.setState({ dryRun: true });
    const outcome = await h.gateway.applyRoleEffect(witnessFor(), intent());

    expect(outcome.status).toBe('dry-run');
    expect(h.discord.restCalls('addRole')).toHaveLength(0);
    expect(h.discord.restCalls('removeRole')).toHaveLength(0);
  });

  it('still records the effect and an audit row', async () => {
    // A dry run that left no trace would be untestable and unreviewable.
    h.setState({ dryRun: true });
    await h.gateway.applyRoleEffect(witnessFor(), intent());

    expect(h.records[0]).toMatchObject({ state: 'dry_run' });
    expect(h.audits[0]).toMatchObject({ dryRun: true, action: 'role.grant' });
  });

  it('still performs the read calls, so the hierarchy check is exercised', async () => {
    h.setState({ dryRun: true });
    await h.gateway.applyRoleEffect(witnessFor(), intent());
    expect(h.discord.restCalls('fetchRoles')).toHaveLength(1);
  });
});

describe('layers 11 and 12 — execute and record', () => {
  it('applies the grant', async () => {
    const outcome = await h.gateway.applyRoleEffect(witnessFor(), intent());
    expect(outcome).toMatchObject({ status: 'applied', hadRoleBefore: false });
    expect(h.discord.restCalls('addRole')).toHaveLength(1);
  });

  it('passes the reason through to Discord audit log', async () => {
    await h.gateway.applyRoleEffect(witnessFor(), intent({ reason: 'clicked #roles' }));
    expect(h.discord.restCalls('addRole')[0]?.args).toContain('clicked #roles');
  });

  it('records before and after, which is what makes undo possible', async () => {
    await h.gateway.applyRoleEffect(witnessFor(), intent());
    expect(h.audits[0]).toMatchObject({
      before: { hasRole: false },
      after: { hasRole: true },
      batchId: 'batch-1',
    });
  });

  it('records a failure rather than losing it', async () => {
    h.discord.failNext('addRole', FakeDiscord.missingPermissions());
    const outcome = await h.gateway.applyRoleEffect(witnessFor(), intent());

    expect(outcome.status).toBe('failed');
    expect(h.records[0]).toMatchObject({ state: 'failed' });
  });

  it('writes no audit row for a failed call', async () => {
    // The audit trail records what happened. A failed grant did not happen.
    h.discord.failNext('addRole', FakeDiscord.missingPermissions());
    await h.gateway.applyRoleEffect(witnessFor(), intent());
    expect(h.audits).toHaveLength(0);
  });

  it('revokes as well as grants', async () => {
    h.discord.defineMember(USER, [ROLE]);
    const outcome = await h.gateway.applyRoleEffect(witnessFor(), intent({ action: 'revoke' }));

    expect(outcome).toMatchObject({ status: 'applied', hadRoleBefore: true });
    expect(h.discord.restCalls('removeRole')).toHaveLength(1);
  });
});

describe('undo', () => {
  const undoable = (over: Partial<UndoableEffect> = {}): UndoableEffect => ({
    effectId: 'e1',
    userId: USER,
    roleId: ROLE,
    action: 'grant',
    state: 'applied',
    hadRoleBefore: false,
    panelId: 'panel-1',
    ...over,
  });

  describe('inverseOf — the truth table had_role_before exists for', () => {
    it('reverses a grant that actually added the role', () => {
      expect(inverseOf(undoable())).toBe('revoke');
    });

    it('does not reverse a grant of a role they already had', () => {
      // The failure this prevents: stripping a role the member has had for a
      // year because an unrelated batch happened to touch it.
      expect(inverseOf(undoable({ hadRoleBefore: true }))).toBeUndefined();
    });

    it('reverses a revoke that actually removed the role', () => {
      expect(inverseOf(undoable({ action: 'revoke', hadRoleBefore: true }))).toBe('grant');
    });

    it('does not reverse a revoke of a role they never had', () => {
      expect(inverseOf(undoable({ action: 'revoke', hadRoleBefore: false }))).toBeUndefined();
    });

    it.each(['dry_run', 'failed', 'skipped', 'planned'])(
      'does not reverse an effect in state %s',
      (state) => {
        expect(inverseOf(undoable({ state }))).toBeUndefined();
      },
    );
  });

  const undoAuth = () => {
    const undo = authorize({ store: permissiveAuthz, guildId: GUILD, actor }, 'undo.execute');
    if (!undo.ok) throw new Error('test setup');
    return { undo: undo.value, mutate: witnessFor() };
  };

  it('replays the inverse through the same gateway', async () => {
    h.discord.defineMember(USER, [ROLE]);
    const batches: string[] = [];

    const result = await undoBatch(
      h.gateway,
      undoAuth(),
      {
        guildId: GUILD,
        effectsInBatch: () => [undoable()],
        openBatch: () => {
          batches.push('undo-batch');
          return 'undo-batch';
        },
        closeBatch: () => undefined,
        markBatchUndone: () => undefined,
        logger,
      },
      { batchId: 'batch-1', source: 'cli', reason: 'operator undo' },
    );

    expect(result.reversed).toBe(1);
    expect(h.discord.restCalls('removeRole')).toHaveLength(1);
  });

  it('respects the kill switch, because it is not a separate path', async () => {
    // An undo that could bypass the kill switch would be a second, unaudited
    // way to change roles.
    h.discord.defineMember(USER, [ROLE]);
    h.setState({ killswitch: true });

    const result = await undoBatch(
      h.gateway,
      undoAuth(),
      {
        guildId: GUILD,
        effectsInBatch: () => [undoable()],
        openBatch: () => 'undo-batch',
        closeBatch: () => undefined,
        markBatchUndone: () => undefined,
        logger,
      },
      { batchId: 'batch-1', source: 'cli', reason: 'operator undo' },
    );

    expect(result.reversed).toBe(0);
    expect(result.outcomes[0]).toMatchObject({ status: 'refused', reason: 'killswitch' });
  });

  it('counts effects that changed nothing separately from those it reversed', async () => {
    h.discord.defineMember(USER, [ROLE]);
    const result = await undoBatch(
      h.gateway,
      undoAuth(),
      {
        guildId: GUILD,
        effectsInBatch: () => [
          undoable({ effectId: 'e1' }),
          undoable({ effectId: 'e2', hadRoleBefore: true }),
          undoable({ effectId: 'e3', state: 'dry_run' }),
        ],
        openBatch: () => 'undo-batch',
        closeBatch: () => undefined,
        markBatchUndone: () => undefined,
        logger,
      },
      { batchId: 'batch-1', source: 'cli', reason: 'operator undo' },
    );

    expect(result).toMatchObject({ reversed: 1, nothingToReverse: 2 });
  });

  it('marks the original batch undone and opens its own', async () => {
    h.discord.defineMember(USER, [ROLE]);
    const marked: string[] = [];

    await undoBatch(
      h.gateway,
      undoAuth(),
      {
        guildId: GUILD,
        effectsInBatch: () => [undoable()],
        openBatch: () => 'undo-batch',
        closeBatch: () => undefined,
        markBatchUndone: (batchId) => marked.push(batchId),
        logger,
      },
      { batchId: 'batch-1', source: 'cli', reason: 'operator undo' },
    );

    expect(marked).toEqual(['batch-1']);
  });
});
