import { beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Pipeline, type DedupeStore, type Subscriber } from './pipeline.js';
import type { DomainEvent } from '../discord/events.js';

const ALLOWED = '111111111111111111';
const NOT_ALLOWED = '999999999999999999';

/** Silent, so a passing run is not thousands of lines of JSON. */
const logger = pino({ level: 'silent' });

/** The real store's contract: INSERT OR IGNORE, true on the first sight. */
const memoryDedupe = (): DedupeStore & { seen: Set<string> } => {
  const seen = new Set<string>();
  return {
    seen,
    firstSight({ guildId, eventKind, fingerprint }) {
      const key = `${guildId}/${eventKind}/${fingerprint}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
};

const recorder = (name: string, throws = false) => {
  const got: DomainEvent[] = [];
  const subscriber: Subscriber = {
    name,
    handle(event) {
      got.push(event);
      if (throws) throw new Error(`${name} exploded`);
    },
  };
  return { subscriber, got };
};

const interactionOn = (guildId: string, interactionId: string): DomainEvent => ({
  kind: 'interaction',
  guildId,
  receivedAtMs: 1_700_000_000_000,
  interactionId,
  token: `tok-${interactionId}`,
  channelId: '222222222222222222',
  messageId: '333333333333333333',
  userId: '444444444444444444',
  customId: 'panel:opt',
});

const reactionOn = (guildId: string): DomainEvent => ({
  kind: 'reactionAdd',
  guildId,
  receivedAtMs: 1_700_000_000_000,
  channelId: '222222222222222222',
  messageId: '333333333333333333',
  userId: '444444444444444444',
  emoji: 'u:1f9e0',
  wasPartial: false,
});

let dedupe: ReturnType<typeof memoryDedupe>;
let left: string[];

const build = (subscribers: readonly Subscriber[]) => {
  dedupe = memoryDedupe();
  left = [];
  return new Pipeline({
    allowlist: new Set([ALLOWED]),
    dedupe,
    subscribers,
    leaveGuild: (guildId) => {
      left.push(guildId);
      return Promise.resolve();
    },
    logger,
  });
};

beforeEach(() => {
  dedupe = memoryDedupe();
  left = [];
});

describe('the guild allowlist gate', () => {
  it('refuses an event from a guild we are not supposed to be in', async () => {
    const a = recorder('panels');
    const pipeline = build([a.subscriber]);

    const outcome = await pipeline.dispatch(interactionOn(NOT_ALLOWED, '900000000000000001'));

    expect(outcome).toEqual({ status: 'refused', reason: 'guild-not-allowlisted' });
    expect(a.got).toHaveLength(0);
  });

  it('leaves the guild', async () => {
    const pipeline = build([]);
    await pipeline.dispatch(interactionOn(NOT_ALLOWED, '900000000000000001'));
    expect(left).toEqual([NOT_ALLOWED]);
  });

  it('leaves once, not once per event in a burst', async () => {
    // Without the guard, a busy unlisted guild produces one REST call per
    // dispatch — which is both rate-limit suicide and very loud.
    const pipeline = build([]);
    for (let i = 1; i <= 20; i += 1) {
      await pipeline.dispatch(interactionOn(NOT_ALLOWED, `90000000000000000${i % 10}`));
    }
    expect(left).toEqual([NOT_ALLOWED]);
  });

  it('runs before the dedupe gate, so no row is written for an unlisted guild', async () => {
    // Ordering matters: deduplication writes. Writing rows for a guild we are
    // in the process of leaving is exactly what the allowlist is there to
    // prevent.
    const pipeline = build([]);
    await pipeline.dispatch(interactionOn(NOT_ALLOWED, '900000000000000001'));
    expect(dedupe.seen.size).toBe(0);
  });

  it('retries the leave on a later event if it failed', async () => {
    dedupe = memoryDedupe();
    const failures: string[] = [];
    const pipeline = new Pipeline({
      allowlist: new Set([ALLOWED]),
      dedupe,
      subscribers: [],
      leaveGuild: (guildId) => {
        failures.push(guildId);
        return failures.length === 1
          ? Promise.reject(new Error('503 from Discord'))
          : Promise.resolve();
      },
      logger,
    });

    await pipeline.dispatch(interactionOn(NOT_ALLOWED, '900000000000000001'));
    await pipeline.dispatch(interactionOn(NOT_ALLOWED, '900000000000000002'));

    expect(failures).toHaveLength(2);
  });
});

describe('the dedupe gate', () => {
  it('delivers the first sight of an event', async () => {
    const a = recorder('panels');
    const pipeline = build([a.subscriber]);

    const outcome = await pipeline.dispatch(interactionOn(ALLOWED, '900000000000000001'));

    expect(outcome).toEqual({ status: 'delivered', ran: 1, failed: [] });
    expect(a.got).toHaveLength(1);
  });

  it('drops a replayed dispatch', async () => {
    // Gateway events replay on reconnect. This is the mechanism that makes
    // that harmless for the kinds that carry a stable fingerprint.
    const a = recorder('panels');
    const pipeline = build([a.subscriber]);

    await pipeline.dispatch(interactionOn(ALLOWED, '900000000000000001'));
    const second = await pipeline.dispatch(interactionOn(ALLOWED, '900000000000000001'));

    expect(second).toEqual({ status: 'dropped', reason: 'duplicate' });
    expect(a.got).toHaveLength(1);
  });

  it('does not deduplicate a level-triggered event', async () => {
    // A member may add, remove and re-add a reaction. Dropping the second add
    // would silently lose a real action, so reactions pass through every time
    // and convergence sorts it out.
    const a = recorder('panels');
    const pipeline = build([a.subscriber]);

    await pipeline.dispatch(reactionOn(ALLOWED));
    await pipeline.dispatch(reactionOn(ALLOWED));

    expect(a.got).toHaveLength(2);
    expect(dedupe.seen.size).toBe(0);
  });

  it('scopes the fingerprint to the guild', async () => {
    const seen = memoryDedupe();
    seen.firstSight({
      guildId: '222222222222222222',
      eventKind: 'interaction',
      fingerprint: '900000000000000001',
      atMs: 0,
    });
    const a = recorder('panels');
    const pipeline = new Pipeline({
      allowlist: new Set([ALLOWED]),
      dedupe: seen,
      subscribers: [a.subscriber],
      leaveGuild: () => Promise.resolve(),
      logger,
    });

    // Same fingerprint, different guild: still a first sight.
    const outcome = await pipeline.dispatch(interactionOn(ALLOWED, '900000000000000001'));
    expect(outcome.status).toBe('delivered');
  });
});

describe('subscriber isolation', () => {
  it('runs every subscriber even when one throws', async () => {
    // The logging module going wrong must not take role panels down with it.
    const bad = recorder('logging', true);
    const good = recorder('panels');
    const pipeline = build([bad.subscriber, good.subscriber]);

    const outcome = await pipeline.dispatch(interactionOn(ALLOWED, '900000000000000001'));

    expect(good.got).toHaveLength(1);
    expect(outcome).toEqual({ status: 'delivered', ran: 2, failed: ['logging'] });
  });

  it('reports which subscribers failed rather than swallowing it', async () => {
    const bad = recorder('logging', true);
    const alsoBad = recorder('panels', true);
    const pipeline = build([bad.subscriber, alsoBad.subscriber]);

    const outcome = await pipeline.dispatch(interactionOn(ALLOWED, '900000000000000001'));

    expect(outcome).toEqual({ status: 'delivered', ran: 2, failed: ['logging', 'panels'] });
  });

  it('does not let a throwing subscriber undo the dedupe record', async () => {
    // A subscriber that throws has already been given the event. Rolling the
    // dedupe row back would redeliver on the next replay, to a subscriber that
    // may well throw again — a loop rather than a repair. Retry belongs to the
    // job table, not to the pipeline.
    const bad = recorder('logging', true);
    const pipeline = build([bad.subscriber]);

    await pipeline.dispatch(interactionOn(ALLOWED, '900000000000000001'));
    const second = await pipeline.dispatch(interactionOn(ALLOWED, '900000000000000001'));

    expect(second).toEqual({ status: 'dropped', reason: 'duplicate' });
    expect(bad.got).toHaveLength(1);
  });
});
