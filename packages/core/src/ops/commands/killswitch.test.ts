import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsAuditWrite, OpsPorts, OpsSafetyState } from '../ports.js';
import { killswitchCommand } from './killswitch.js';

const safety = (over: Partial<OpsSafetyState> = {}): OpsSafetyState => ({
  killswitch: false,
  dryRun: false,
  breakerOpen: false,
  breakerReason: null,
  roleRatePerMin: 20,
  reconcileBudget: 25,
  breakerThreshold: 5,
  ...over,
});

type Dispatched = Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>;

interface Harness {
  run(state: string, confirm?: boolean): Promise<Dispatched>;
  readonly set: boolean[];
  readonly audit: OpsAuditWrite[];
}

/** An explicit marker, because `harness(undefined)` would take the default. */
const NO_GUILD_ROW = Symbol('no guild row');

const harness = (initial: OpsSafetyState | typeof NO_GUILD_ROW = safety()): Harness => {
  const set: boolean[] = [];
  const audit: OpsAuditWrite[] = [];
  let current: OpsSafetyState | undefined = initial === NO_GUILD_ROW ? undefined : initial;
  const ports: Partial<OpsPorts> = {
    safetyState: () => current,
    setKillswitch: (on) => {
      set.push(on);
      if (current !== undefined) current = { ...current, killswitch: on };
    },
    recordAudit: (input) => {
      audit.push(input);
    },
  };
  const dispatcher = createDispatcher({
    commands: [killswitchCommand],
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => ({
      guildId: FIXTURE_GUILD_ID,
      now: () => 1_700_000_000_000,
      ports: fakeOpsPorts(ports),
    }),
    instance: fakeOpsInstance(),
  });
  return {
    set,
    audit,
    run: (state, confirm = true) =>
      dispatcher.dispatch({ v: 1, command: 'killswitch', args: { state }, confirm }),
  };
};

describe('bananasaurs killswitch', () => {
  it('is a write, so the daemon refuses it without --confirm', async () => {
    const h = harness();
    const res = await h.run('on', false);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('needs-confirm');
    // And, crucially, nothing happened.
    expect(h.set).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('turns the kill switch on', async () => {
    const h = harness();
    const res = await h.run('on');
    expect(res.ok).toBe(true);
    expect(h.set).toEqual([true]);
  });

  it('turns the kill switch off', async () => {
    const h = harness(safety({ killswitch: true }));
    const res = await h.run('off');
    expect(res.ok).toBe(true);
    expect(h.set).toEqual([false]);
  });

  it('refuses anything that is not on or off, rather than guessing', async () => {
    const h = harness();
    const res = await h.run('maybe');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('bad-request');
    expect(h.set).toEqual([]);
  });

  it('records an audit row naming the transition', async () => {
    const h = harness();
    await h.run('on');
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'killswitch.enabled',
      subjectType: 'guild',
      subjectId: FIXTURE_GUILD_ID,
      before: { killswitch: false },
      after: { killswitch: true },
      actorType: 'operator_cli',
      via: 'ssh',
    });
  });

  it('records the off transition under its own action name', async () => {
    const h = harness(safety({ killswitch: true }));
    await h.run('off');
    expect(h.audit[0]).toMatchObject({
      action: 'killswitch.disabled',
      before: { killswitch: true },
      after: { killswitch: false },
    });
  });

  it('records the attempt even when the switch was already in that state', async () => {
    // An operator reaching for the kill switch at 03:00 is worth recording
    // whether or not it moved. `before` equalling `after` says so plainly.
    const h = harness(safety({ killswitch: true }));
    const res = await h.run('on');
    expect(res.ok).toBe(true);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ before: { killswitch: true }, after: { killswitch: true } });
  });

  it('says in its output that the switch was already on', async () => {
    const h = harness(safety({ killswitch: true }));
    const res = await h.run('on');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toMatch(/already/i);
  });

  it('refuses when the guild has no row, naming the actual problem', async () => {
    // `guilds` is where every safety control lives. A command that conjured the
    // row would be deciding a guild's dry-run and breaker defaults as a side
    // effect of an unrelated action.
    //
    // **The message is the assertion, not just the failure.** Dropping the
    // explicit check still fails — the next line dereferences `before` and
    // throws — so a test that only checked `code: 'failed'` passed against a
    // broken implementation (mutation 132). The difference an operator sees is
    // between "this guild has no row in `guilds`, the daemon has never started
    // for it" and "Cannot read properties of undefined", which is the whole
    // value of the check.
    const h = harness(NO_GUILD_ROW);
    const res = await h.run('on');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('failed');
    expect(res.message).toMatch(/no row in `guilds`/);
    expect(res.message).toMatch(/never\s+started/);
    expect(res.message).not.toMatch(/undefined/);
    expect(h.set).toEqual([]);
  });

  it('tells the operator what the kill switch actually does', async () => {
    const h = harness();
    const res = await h.run('on');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toMatch(/Discord/);
  });
});
