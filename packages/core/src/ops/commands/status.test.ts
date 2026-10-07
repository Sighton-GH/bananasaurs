import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../dispatch.js';
import {
  fakeOpsGuildContext,
  fakeOpsInstance,
  fakeOpsPorts,
  FIXTURE_GUILD_ID,
} from '../test-fixtures.js';
import type { OpsInstance, OpsPorts } from '../ports.js';
import { statusCommand } from './status.js';

const HEALTHY: Partial<OpsPorts> = {
  guildName: () => 'Engineering Club',
  safetyState: () => ({
    killswitch: false,
    dryRun: false,
    breakerOpen: false,
    breakerReason: null,
    roleRatePerMin: 20,
    reconcileBudget: 25,
    breakerThreshold: 5,
    automodState: 'off' as const,
    taskPostsEnabled: false,
  }),
  jobCounts: () => ({ queued: 2, done: 17 }),
  oldestDueJobAtMs: () => undefined,
};

const run = async (ports: Partial<OpsPorts> = HEALTHY, instance: Partial<OpsInstance> = {}) => {
  const dispatcher = createDispatcher({
    commands: [statusCommand],
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => fakeOpsGuildContext({ ports: fakeOpsPorts(ports) }),
    instance: fakeOpsInstance(instance),
  });
  return await dispatcher.dispatch({ v: 1, command: 'status' });
};

describe('bananasaurs status', () => {
  it('is a read command, so it needs no --confirm', async () => {
    const res = await run();
    expect(res.ok).toBe(true);
  });

  it('reports the guild, the gateway, the queue and every safety control', async () => {
    const res = await run();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      guildId: FIXTURE_GUILD_ID,
      guildName: 'Engineering Club',
      gateway: { connected: true, pingMs: 42, guildCount: 1 },
      jobs: { queued: 2, done: 17 },
      schedulerLagMs: 0,
      safety: { killswitch: false, dryRun: false, breakerOpen: false },
    });
  });

  it('reports uptime from the process start, not from the guild row', async () => {
    // fixture now = start + 60s
    const res = await run();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ uptimeMs: 60_000 });
    expect(res.text).toContain('1m');
  });

  it('turns an overdue queued job into a scheduler lag in milliseconds', async () => {
    const res = await run({ ...HEALTHY, oldestDueJobAtMs: () => 1_700_000_055_000 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ schedulerLagMs: 5_000 });
  });

  it('says so loudly when the kill switch is on', async () => {
    const res = await run({
      ...HEALTHY,
      safetyState: () => ({
        killswitch: true,
        dryRun: false,
        breakerOpen: false,
        breakerReason: null,
        roleRatePerMin: 20,
        reconcileBudget: 25,
        breakerThreshold: 5,
        automodState: 'off' as const,
        taskPostsEnabled: false,
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ safety: { killswitch: true } });
    expect(res.text).toMatch(/KILL SWITCH ON/);
  });

  it('reports a tripped breaker with the reason it was tripped for', async () => {
    const res = await run({
      ...HEALTHY,
      safetyState: () => ({
        killswitch: false,
        dryRun: false,
        breakerOpen: true,
        breakerReason: 'five consecutive 403s',
        roleRatePerMin: 20,
        reconcileBudget: 25,
        breakerThreshold: 5,
        automodState: 'off' as const,
        taskPostsEnabled: false,
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('five consecutive 403s');
  });

  it('reports a guild with no row rather than inventing a healthy one', async () => {
    const res = await run({ ...HEALTHY, safetyState: () => undefined });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ safety: null });
    expect(res.text).toMatch(/no row in `guilds`/);
  });

  it('reports a disconnected gateway rather than a ping of zero', async () => {
    const res = await run(HEALTHY, {
      gateway: () => ({ connected: false, pingMs: undefined, guildCount: 0 }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ gateway: { connected: false, pingMs: null } });
    expect(res.text).toMatch(/disconnected/i);
  });

  it('says the daemon is read-only, so a later refusal is not a surprise', async () => {
    const res = await run(HEALTHY, { readonly: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ readonly: true });
    expect(res.text).toMatch(/read-only/i);
  });

  it('prints no secret, whatever else it prints', async () => {
    const res = await run();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const serialised = JSON.stringify(res);
    for (const forbidden of ['token', 'TOKEN', 'secret', 'SECRET', 'password']) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});
