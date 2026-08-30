import { describe, expect, it } from 'vitest';
import { correlateDeletion, type CorrelationCandidate } from './attribution.js';

/**
 * ADR 0023 decision 3: the available key is (actor, author, channel,
 * count-delta), and it is approximate in every component. These tests are
 * the judgement call written down as behaviour.
 */

const candidate = (over: Partial<CorrelationCandidate> = {}): CorrelationCandidate => ({
  actorUserId: '111111111111111111',
  liveCount: 1,
  claimedCount: 0,
  ...over,
});

describe('correlateDeletion', () => {
  it('is unknown with no candidates — most likely a self-deletion, which writes no entry', () => {
    expect(correlateDeletion([])).toBeUndefined();
  });

  it('attributes to the single candidate with an unclaimed increment', () => {
    expect(
      correlateDeletion([candidate({ actorUserId: 'A', liveCount: 1, claimedCount: 0 })]),
    ).toBe('A');
  });

  it('is unknown when the sole candidate has no unclaimed increment', () => {
    // Every deletion this run has produced so far was already attributed.
    expect(correlateDeletion([candidate({ liveCount: 2, claimedCount: 2 })])).toBeUndefined();
  });

  it('is unknown when two different actors both show an unclaimed increment', () => {
    // The exact ambiguity the docs/20 gate names: a missing actor degrades to
    // "unknown", never a guess presented as fact — and guessing between two
    // candidates is exactly the guess the gate forbids.
    expect(
      correlateDeletion([
        candidate({ actorUserId: 'A', liveCount: 1, claimedCount: 0 }),
        candidate({ actorUserId: 'B', liveCount: 1, claimedCount: 0 }),
      ]),
    ).toBeUndefined();
  });

  it('picks the one actor with an unclaimed increment when another candidate is already fully claimed', () => {
    expect(
      correlateDeletion([
        candidate({ actorUserId: 'A', liveCount: 1, claimedCount: 1 }), // fully claimed already
        candidate({ actorUserId: 'B', liveCount: 1, claimedCount: 0 }), // still owes one
      ]),
    ).toBe('B');
  });

  it('lets a burst of N deletions by the same actor each independently see an unclaimed increment', () => {
    // Job 1 has not claimed yet; count is 3, claimed is 0 -> 3 unclaimed.
    expect(correlateDeletion([candidate({ liveCount: 3, claimedCount: 0 })])).toBe(
      '111111111111111111',
    );
    // Job 2 runs after job 1 claimed one unit.
    expect(correlateDeletion([candidate({ liveCount: 3, claimedCount: 1 })])).toBe(
      '111111111111111111',
    );
    // Job 3 runs after two units are claimed.
    expect(correlateDeletion([candidate({ liveCount: 3, claimedCount: 2 })])).toBe(
      '111111111111111111',
    );
    // A fourth job, if one arrived, finds nothing left to claim.
    expect(correlateDeletion([candidate({ liveCount: 3, claimedCount: 3 })])).toBeUndefined();
  });
});
