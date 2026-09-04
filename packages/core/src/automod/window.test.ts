import { describe, expect, it } from 'vitest';
import { createWindowStore } from './window.js';

const key = (memberId: string, guildId = '100000000000000001', ruleId = 'r1') => ({
  guildId,
  memberId,
  ruleId,
});

describe('the window store', () => {
  it('counts only events inside the window', () => {
    const store = createWindowStore({ maxEventsPerMember: 10, maxMembers: 10 });
    const w = store.for(key('m1'));
    w.record(1_000);
    w.record(2_000);
    w.record(9_000);
    // A 5-second window at t=9000 covers [4000, 9000]: only the last event.
    expect(w.countWithin(9_000, 5_000)).toBe(1);
    expect(w.countWithin(9_000, 10_000)).toBe(3);
  });

  it('keeps two members apart', () => {
    // NOT decorative: BOTH members record events, so an implementation that
    // ignored memberId would report 2 for each and this goes red. One member
    // with events and one without would pass under that bug.
    const store = createWindowStore({ maxEventsPerMember: 10, maxMembers: 10 });
    store.for(key('m1')).record(1_000);
    store.for(key('m2')).record(1_000);
    expect(store.for(key('m1')).countWithin(1_000, 5_000)).toBe(1);
    expect(store.for(key('m2')).countWithin(1_000, 5_000)).toBe(1);
  });

  it('keeps two guilds apart even for the same member and rule', () => {
    // CLAUDE.md rule 2 names cache keys explicitly. Both sides record, so an
    // implementation keyed on (memberId, ruleId) alone reports 2 and goes red.
    const store = createWindowStore({ maxEventsPerMember: 10, maxMembers: 10 });
    store.for(key('m1', '100000000000000001')).record(1_000);
    store.for(key('m1', '200000000000000002')).record(1_000);
    expect(store.for(key('m1', '100000000000000001')).countWithin(1_000, 5_000)).toBe(1);
  });

  it('keeps two rules apart for the same member', () => {
    const store = createWindowStore({ maxEventsPerMember: 10, maxMembers: 10 });
    store.for(key('m1', '100000000000000001', 'rule-a')).record(1_000);
    store.for(key('m1', '100000000000000001', 'rule-b')).record(1_000);
    expect(store.for(key('m1', '100000000000000001', 'rule-a')).countWithin(1_000, 5_000)).toBe(1);
  });

  it('does not grow past the per-member cap', () => {
    const store = createWindowStore({ maxEventsPerMember: 3, maxMembers: 10 });
    const w = store.for(key('m1'));
    for (let i = 0; i < 50; i++) w.record(1_000 + i);
    // A 100-second window covers every event ever recorded, so this can only
    // be 3 if the buffer is genuinely bounded — the assertion would read 50
    // under an unbounded implementation.
    expect(w.countWithin(1_050, 100_000)).toBe(3);
  });

  it('evicts the least recently active member past the member cap', () => {
    const store = createWindowStore({ maxEventsPerMember: 5, maxMembers: 2 });
    store.for(key('m1')).record(1_000);
    store.for(key('m2')).record(2_000);
    store.for(key('m3')).record(3_000); // evicts m1, the least recently active
    expect(store.size()).toBe(2);
    // m1's window is forgotten — one extra message may get through, which
    // PR-22 accepts deliberately over refusing to track under load.
    expect(store.for(key('m1')).countWithin(3_000, 100_000)).toBe(0);
    expect(store.for(key('m2')).countWithin(3_000, 100_000)).toBe(1);
  });

  it('counts repeats of one value without counting the others', () => {
    // duplicate_message's need. Three events, two of them identical, so an
    // implementation ignoring `value` reports 3 and goes red.
    const store = createWindowStore({ maxEventsPerMember: 10, maxMembers: 10 });
    const w = store.for(key('m1'));
    w.record(1_000, 'buy crypto now');
    w.record(2_000, 'something else');
    w.record(3_000, 'buy crypto now');
    expect(w.countMatching(3_000, 10_000, 'buy crypto now')).toBe(2);
  });

  it('takes its clock from the caller, never from Date.now()', () => {
    // The dry run replays fixtures at their recorded createdAt (ADR 0041 §6).
    // A store reading the wall clock would make a replay's result depend on
    // when the replay ran. Events far in the past must count when the caller
    // says the window is far in the past too.
    const store = createWindowStore({ maxEventsPerMember: 10, maxMembers: 10 });
    const w = store.for(key('m1'));
    w.record(1_000);
    w.record(2_000);
    expect(w.countWithin(2_000, 5_000)).toBe(2);
  });
});
