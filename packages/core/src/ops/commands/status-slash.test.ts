import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { DomainEvent, SlashCommandEvent } from '../../discord/events.js';
import type { InteractionRef, OutgoingMessage } from '../../discord/port.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsInstance, OpsPorts } from '../ports.js';
import { createStatusCommandSubscriber, renderMemberStatus } from './status-slash.js';

/**
 * `/status` (ADR 0033).
 *
 * Two halves, tested apart: what a member is told (a pure function of what the
 * ports reported) and how the interaction is handled (acknowledge, read, answer,
 * and never acknowledge a command that is not ours).
 */

const USER = '111111111111111111';
const CHANNEL = '333333333333333333';
const INTERACTION = '888888888888888888';
const NOW = 1_700_000_100_000;

const logger = pino({ level: 'silent' });

const HEALTHY: Partial<OpsPorts> = {
  safetyState: () => ({
    killswitch: false,
    dryRun: false,
    breakerOpen: false,
    breakerReason: null,
    roleRatePerMin: 20,
    reconcileBudget: 25,
    breakerThreshold: 5,
  }),
  jobCounts: () => ({ queued: 2, running: 1, done: 17 }),
  oldestDueJobAtMs: () => undefined,
};

const event = (over: Partial<SlashCommandEvent> = {}): DomainEvent => ({
  kind: 'slashCommand',
  guildId: FIXTURE_GUILD_ID,
  receivedAtMs: NOW,
  interactionId: INTERACTION,
  token: 'interaction-token',
  commandName: 'status',
  subcommandPath: [],
  options: [],
  channelId: CHANNEL,
  userId: USER,
  ...over,
});

interface Recorder {
  defers: { ref: InteractionRef; ephemeral: boolean }[];
  replies: { ref: InteractionRef; message: OutgoingMessage }[];
}

const harness = (options: {
  ports?: Partial<OpsPorts>;
  instance?: Partial<OpsInstance>;
  portsThrows?: boolean;
}) => {
  const recorder: Recorder = { defers: [], replies: [] };
  const subscriber = createStatusCommandSubscriber({
    guildId: FIXTURE_GUILD_ID,
    ports: () => {
      if (options.portsThrows === true) throw new Error('no guild runtime');
      return fakeOpsPorts(options.ports ?? HEALTHY);
    },
    instance: fakeOpsInstance(options.instance ?? {}),
    responder: {
      defer: async (ref, o) => void recorder.defers.push({ ref, ephemeral: o.ephemeral }),
      respond: async (ref, message) => void recorder.replies.push({ ref, message }),
    },
    now: () => NOW,
    logger,
  });
  return { subscriber, recorder };
};

const reply = (recorder: Recorder): string => {
  const content = recorder.replies.at(-1)?.message.content;
  if (content === undefined) throw new Error('no reply was sent');
  return content;
};

describe('what a member is told', () => {
  it('reports a healthy bot as connected and enabled', () => {
    const text = renderMemberStatus({
      gateway: { connected: true, pingMs: 42, guildCount: 1 },
      safety: { killswitch: false, dryRun: false, breakerOpen: false, breakerReason: null },
      jobCounts: { queued: 2, running: 1, failed: 0 },
      schedulerLagMs: 0,
    });

    expect(text).toContain('**Connected**');
    expect(text).toContain('42ms');
    expect(text).toContain('Role changes are **enabled**');
    expect(text).toContain('2 queued, 1 running, 0 failed');
    // Nothing to say about lag when there is none, rather than "0ms behind".
    expect(text).not.toContain('behind');
  });

  /**
   * The whole reason this command exists. `docs/21` exercises 2 and 3 are about
   * a bot that looks broken because a safety control was left engaged, and a
   * status that mentions dry run only while it is *off* makes "dry run has been
   * on for a week" invisible.
   */
  it('says why role changes are paused, naming every engaged control', () => {
    const text = renderMemberStatus({
      gateway: { connected: true, pingMs: undefined, guildCount: 1 },
      safety: {
        killswitch: true,
        dryRun: true,
        breakerOpen: true,
        breakerReason: 'too many failures',
      },
      jobCounts: {},
      schedulerLagMs: 0,
    });

    expect(text).toContain('**paused**');
    expect(text).toContain('kill switch');
    expect(text).toContain('dry run');
    expect(text).toContain('safety breaker');
    expect(text).toContain('too many failures');
  });

  it('says nothing about a heartbeat that has not happened yet', () => {
    const text = renderMemberStatus({
      gateway: { connected: true, pingMs: undefined, guildCount: 1 },
      safety: { killswitch: false, dryRun: false, breakerOpen: false, breakerReason: null },
      jobCounts: {},
      schedulerLagMs: 0,
    });
    // `undefined` is not a fast heartbeat, and must not render as one.
    expect(text).not.toContain('0ms');
    expect(text).toContain('**Connected**');
  });

  it('reports a disconnected gateway plainly', () => {
    const text = renderMemberStatus({
      gateway: { connected: false, pingMs: undefined, guildCount: 0 },
      safety: { killswitch: false, dryRun: false, breakerOpen: false, breakerReason: null },
      jobCounts: {},
      schedulerLagMs: 0,
    });
    expect(text).toContain('**Not connected**');
  });

  /**
   * A guild with no row in `guilds` is a real finding, not a cosmetic gap: the
   * effect gateway reads that row to decide whether it may act at all.
   */
  it('flags a missing settings row rather than reporting it as healthy', () => {
    const text = renderMemberStatus({
      gateway: { connected: true, pingMs: 5, guildCount: 1 },
      safety: undefined,
      jobCounts: {},
      schedulerLagMs: 0,
    });
    expect(text).toContain('No settings row');
    expect(text).not.toContain('enabled');
  });

  it('reports scheduler lag when the queue is behind', () => {
    const text = renderMemberStatus({
      gateway: { connected: true, pingMs: 5, guildCount: 1 },
      safety: { killswitch: false, dryRun: false, breakerOpen: false, breakerReason: null },
      jobCounts: { queued: 9 },
      schedulerLagMs: 125_000,
    });
    expect(text).toContain('2m 5s behind');
  });

  /**
   * The subscriber clamps lag at zero, and this is the renderer's own half of
   * that: a clock that moved backwards must never produce "-1m behind".
   *
   * Two guards for one property is deliberate, and it is why mutation 245
   * (removing the clamp) is an **equivalent mutant** rather than a survivor —
   * the renderer's `> 0` already suppresses the line. Pinned here so the
   * behaviour survives whichever guard is later refactored away.
   */
  it('says nothing about lag when the lag is negative', () => {
    const text = renderMemberStatus({
      gateway: { connected: true, pingMs: 5, guildCount: 1 },
      safety: { killswitch: false, dryRun: false, breakerOpen: false, breakerReason: null },
      jobCounts: {},
      schedulerLagMs: -60_000,
    });
    expect(text).not.toContain('behind');
    expect(text).not.toContain('-');
  });

  /** A job state the ports do not report is zero, not absent from the line. */
  it('reports zero for a job state with no rows', () => {
    const text = renderMemberStatus({
      gateway: { connected: true, pingMs: 5, guildCount: 1 },
      safety: { killswitch: false, dryRun: false, breakerOpen: false, breakerReason: null },
      jobCounts: { done: 17 },
      schedulerLagMs: 0,
    });
    expect(text).toContain('0 queued, 0 running, 0 failed');
  });
});

describe('the /status subscriber', () => {
  /**
   * No `authorize()` call, no capability grant (ADR 0033). Asserted rather than
   * left implicit, so that closing it later is a deliberate, visible change
   * rather than something that drifts in with a refactor.
   */
  it('answers an ordinary guild member with no capability check', async () => {
    const h = harness({});
    await h.subscriber.handle(event());

    expect(h.recorder.replies).toHaveLength(1);
    expect(reply(h.recorder)).toContain('**Connected**');
  });

  /**
   * Three seconds, and a missed acknowledgement discards the token — the member
   * then sees "This interaction failed" whatever happens afterwards.
   */
  it('acknowledges before it reads, and asks for an ephemeral reply', async () => {
    const h = harness({});
    await h.subscriber.handle(event());

    expect(h.recorder.defers).toEqual([
      { ref: { interactionId: INTERACTION, token: 'interaction-token' }, ephemeral: true },
    ]);
  });

  it('replies against the interaction that invoked it', async () => {
    const h = harness({});
    await h.subscriber.handle(event({ interactionId: '999000999000999000' }));
    expect(h.recorder.replies[0]?.ref.interactionId).toBe('999000999000999000');
  });

  /**
   * Identified synchronously, *before* the defer. Acknowledging a command that
   * is not ours would swallow another application's interaction — the same rule
   * the panel subscriber follows for a custom id it does not recognise.
   */
  it('ignores a command that is not /status, without acknowledging it', async () => {
    const h = harness({});
    await h.subscriber.handle(event({ commandName: 'ping' }));

    expect(h.recorder.defers).toEqual([]);
    expect(h.recorder.replies).toEqual([]);
  });

  /** `/status` takes no subcommand; a payload carrying one names no real command. */
  it('ignores a /status invocation carrying a subcommand', async () => {
    const h = harness({});
    await h.subscriber.handle(event({ subcommandPath: ['tail'] }));

    expect(h.recorder.defers).toEqual([]);
    expect(h.recorder.replies).toEqual([]);
  });

  it('ignores every other kind of domain event', async () => {
    const h = harness({});
    await h.subscriber.handle({
      kind: 'interaction',
      guildId: FIXTURE_GUILD_ID,
      receivedAtMs: NOW,
      interactionId: INTERACTION,
      token: 'interaction-token',
      channelId: CHANNEL,
      messageId: '444444444444444444',
      userId: USER,
      customId: 'p:panel:option',
    });

    expect(h.recorder.defers).toEqual([]);
    expect(h.recorder.replies).toEqual([]);
  });

  /**
   * Already deferred, so a failure has to become an answer. A member left with a
   * spinner that never resolves learns less than one told something went wrong.
   */
  it('answers rather than leaving a spinner when a read throws', async () => {
    const h = harness({ portsThrows: true });
    await expect(h.subscriber.handle(event())).resolves.toBeUndefined();

    expect(h.recorder.defers).toHaveLength(1);
    expect(reply(h.recorder)).toContain('Something went wrong');
  });

  /** Lag is computed from the injected clock, not `Date.now()`. */
  it('computes scheduler lag against the oldest due job', async () => {
    const h = harness({ ports: { ...HEALTHY, oldestDueJobAtMs: () => NOW - 90_000 } });
    await h.subscriber.handle(event());
    expect(reply(h.recorder)).toContain('1m 30s behind');
  });

  /**
   * A clock that moved backwards must report "not behind" rather than a negative
   * duration nobody can interpret.
   */
  it('clamps lag at zero when the oldest due job is in the future', async () => {
    const h = harness({ ports: { ...HEALTHY, oldestDueJobAtMs: () => NOW + 60_000 } });
    await h.subscriber.handle(event());
    expect(reply(h.recorder)).not.toContain('behind');
  });

  /**
   * The ports are resolved **per invocation**, through the composition root's
   * `portsFor` seam, rather than captured once at construction. That is what
   * keeps `/status` and `GET /api/health` on one code path instead of two
   * snapshots that could drift, and it is why a guild whose row appears after
   * startup is reported correctly without a restart.
   */
  it('resolves the ports on each invocation rather than capturing them once', async () => {
    let calls = 0;
    const recorder: Recorder = { defers: [], replies: [] };
    const subscriber = createStatusCommandSubscriber({
      guildId: FIXTURE_GUILD_ID,
      ports: () => {
        calls += 1;
        return fakeOpsPorts(HEALTHY);
      },
      instance: fakeOpsInstance({}),
      responder: {
        defer: async (ref, o) => void recorder.defers.push({ ref, ephemeral: o.ephemeral }),
        respond: async (ref, message) => void recorder.replies.push({ ref, message }),
      },
      now: () => NOW,
      logger,
    });

    // Nothing read at construction: a subscriber built before the first guild
    // row exists must not have cached its absence.
    expect(calls).toBe(0);

    await subscriber.handle(event());
    await subscriber.handle(event({ interactionId: '999000999000999000' }));
    expect(calls).toBe(2);
  });
});
