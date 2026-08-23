import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { createScopeFactory, type GuildScope } from '../scope.js';
import { ReadonlyError } from '../write.js';
import { upsertGuild } from './guilds.js';
import {
  countEventDedupe,
  markGapReconciled,
  recordFirstSight,
  recordGap,
  sweepEventDedupe,
  unreconciledGaps,
} from './pipeline.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  upsertGuild(a, { name: 'guild a', now: 1000 });
  upsertGuild(b, { name: 'guild b', now: 1000 });
});
afterEach(() => {
  t.close();
});

const sight = (scope: GuildScope, fingerprint: string, atMs = 1000) =>
  recordFirstSight(scope, { eventKind: 'interaction', fingerprint, atMs });

describe('recordFirstSight', () => {
  it('is true the first time', () => {
    expect(sight(a, 'fp-1')).toBe(true);
  });

  it('is false on a replay', () => {
    sight(a, 'fp-1');
    expect(sight(a, 'fp-1')).toBe(false);
  });

  it('does not confuse two event kinds sharing a fingerprint', () => {
    expect(recordFirstSight(a, { eventKind: 'messageUpdate', fingerprint: 'x', atMs: 1 })).toBe(
      true,
    );
    expect(recordFirstSight(a, { eventKind: 'messageDelete', fingerprint: 'x', atMs: 1 })).toBe(
      true,
    );
  });

  it('is scoped: the same fingerprint in another guild is still a first sight', () => {
    // The failure this guards is a cross-guild drop — one guild's event
    // silently suppressing another's because the fingerprints collided.
    sight(a, 'fp-1');
    expect(sight(b, 'fp-1')).toBe(true);
  });

  it('keeps the first timestamp rather than overwriting it on a replay', () => {
    sight(a, 'fp-1', 1000);
    sight(a, 'fp-1', 9000);
    // If the replay overwrote first_seen_at, the sweep would never expire a
    // fingerprint that keeps being replayed.
    expect(sweepEventDedupe(a, 5000)).toBe(1);
  });

  it('refuses in readonly mode rather than pretending to record', () => {
    const ro = createScopeFactory(t.db, { readonly: true }).forGuild(GUILD_A);
    expect(() => sight(ro, 'fp-1')).toThrow(ReadonlyError);
  });
});

describe('the event_dedupe sweep', () => {
  it('bounds a table that would otherwise grow forever', () => {
    sight(a, 'old-1', 1000);
    sight(a, 'old-2', 2000);
    sight(a, 'recent', 9000);

    expect(sweepEventDedupe(a, 5000)).toBe(2);
    expect(countEventDedupe(a)).toBe(1);
  });

  it('keeps rows on the boundary, so a fingerprint is never expired early', () => {
    sight(a, 'exactly-at', 5000);
    expect(sweepEventDedupe(a, 5000)).toBe(0);
  });

  it('does not sweep another guild', () => {
    sight(a, 'old', 1000);
    sight(b, 'old', 1000);

    sweepEventDedupe(a, 5000);

    expect(countEventDedupe(a)).toBe(0);
    expect(countEventDedupe(b)).toBe(1);
  });
});

describe('gateway gaps', () => {
  it('records a fresh IDENTIFY as a real gap', () => {
    const gapId = recordGap(a, {
      disconnectedAtMs: 1000,
      reconnectedAtMs: 4000,
      resumed: false,
    });
    const gaps = unreconciledGaps(a);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.gapId).toBe(gapId);
    expect(gaps[0]?.resumed).toBe(0);
  });

  it('records a RESUMED reconnect too, so the distinction survives', () => {
    // A resume replays the window, so there is nothing to reconcile — but the
    // record still matters for diagnosis, and for not claiming a gap that
    // never happened.
    recordGap(a, { disconnectedAtMs: 1000, reconnectedAtMs: 1200, resumed: true });
    expect(unreconciledGaps(a)[0]?.resumed).toBe(1);
  });

  it('stops listing a gap once reconciled', () => {
    const gapId = recordGap(a, {
      disconnectedAtMs: 1000,
      reconnectedAtMs: 4000,
      resumed: false,
    });
    markGapReconciled(a, gapId, 5000);
    expect(unreconciledGaps(a)).toHaveLength(0);
  });

  it('is scoped: reconciling one guild does not clear another', () => {
    const gapA = recordGap(a, { disconnectedAtMs: 1, reconnectedAtMs: 2, resumed: false });
    recordGap(b, { disconnectedAtMs: 1, reconnectedAtMs: 2, resumed: false });

    markGapReconciled(a, gapA, 3);

    expect(unreconciledGaps(a)).toHaveLength(0);
    expect(unreconciledGaps(b)).toHaveLength(1);
  });

  it('cannot mark another guild gap reconciled by passing its id', () => {
    // gap_id is a global AUTOINCREMENT, so it is guessable across guilds. The
    // guild predicate is what stops one guild clearing another's work.
    const gapB = recordGap(b, { disconnectedAtMs: 1, reconnectedAtMs: 2, resumed: false });

    markGapReconciled(a, gapB, 3);

    expect(unreconciledGaps(b)).toHaveLength(1);
  });
});
