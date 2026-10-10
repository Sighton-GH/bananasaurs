import { describe, expect, it } from 'vitest';
import { JOB_KINDS } from './kinds.js';
import { assistantOrderingKey, JOB_LANES, kindsInLane, laneOf } from './lanes.js';

describe('job lanes', () => {
  it('maps every JOB_KINDS value to a lane', () => {
    for (const kind of Object.values(JOB_KINDS)) {
      expect(JOB_LANES[kind]).toBeDefined();
    }
  });

  it("maps an unmapped kind to 'default'", () => {
    expect(laneOf('unknown_kind')).toBe('default');
  });

  it('kindsInLane returns the exact lists', () => {
    // In JOB_KINDS declaration order.
    expect(kindsInLane('assistant')).toEqual([
      JOB_KINDS.conversationPrune,
      JOB_KINDS.assistantSummarise,
      JOB_KINDS.assistantInvoke,
    ]);
    expect(kindsInLane('background')).toEqual([
      JOB_KINDS.sweepEventDedupe,
      JOB_KINDS.pruneJobs,
      JOB_KINDS.archiveBackfill,
      JOB_KINDS.archiveExpiry,
      JOB_KINDS.resourceRefresh,
    ]);
    expect(kindsInLane('default')).toEqual([
      JOB_KINDS.reconcileGuild,
      JOB_KINDS.adoptPanel,
      JOB_KINDS.logMessageDelete,
      JOB_KINDS.undoBatch,
      JOB_KINDS.modPurge,
      JOB_KINDS.deliverReminders,
      JOB_KINDS.mcpBulkRole,
    ]);
  });

  it('assistantOrderingKey covers all three cases', () => {
    expect(assistantOrderingKey({ userId: 'U1' })).toBe('user:U1');
    expect(assistantOrderingKey({ channelId: 'C1', userId: 'U1' })).toBe('chan:C1');
    expect(assistantOrderingKey({ channelId: 'T1', threadParentId: 'P1', userId: 'U1' })).toBe(
      'chan:P1',
    );
  });
});
