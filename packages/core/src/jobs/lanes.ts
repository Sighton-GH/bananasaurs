import { JOB_KINDS, type JobKind } from './kinds.js';

export type JobLane = 'assistant' | 'background' | 'default';

/** ADR 0135. `satisfies` makes a new JobKind without a lane a compile error. */
export const JOB_LANES = {
  [JOB_KINDS.assistantInvoke]: 'assistant',
  [JOB_KINDS.assistantSummarise]: 'assistant',
  [JOB_KINDS.conversationPrune]: 'assistant',
  [JOB_KINDS.resourceRefresh]: 'background',
  [JOB_KINDS.archiveBackfill]: 'background',
  [JOB_KINDS.archiveExpiry]: 'background',
  [JOB_KINDS.pruneJobs]: 'background',
  [JOB_KINDS.sweepEventDedupe]: 'background',
  [JOB_KINDS.reconcileGuild]: 'default',
  [JOB_KINDS.adoptPanel]: 'default',
  [JOB_KINDS.logMessageDelete]: 'default',
  [JOB_KINDS.undoBatch]: 'default',
  [JOB_KINDS.modPurge]: 'default',
  [JOB_KINDS.deliverReminders]: 'default',
  [JOB_KINDS.mcpBulkRole]: 'default',
  [JOB_KINDS.assistantDailyDigest]: 'assistant',
} as const satisfies Record<JobKind, JobLane>;

/** An unmapped kind (a string not in JOB_KINDS) is 'default'. */
export function laneOf(kind: string): JobLane {
  return (JOB_LANES as Readonly<Record<string, JobLane>>)[kind] ?? 'default';
}

/** The kinds explicitly mapped to `lane`, in JOB_KINDS order. */
export function kindsInLane(lane: JobLane): readonly string[] {
  return (Object.values(JOB_KINDS) as readonly string[]).filter(
    (kind) => (JOB_LANES as Readonly<Record<string, JobLane>>)[kind] === lane,
  );
}

/**
 * The ordering key of an assistant job (ADR 0135 §2): the channel, with a thread
 * keyed by its parent so a thread and its parent channel never run at once.
 */
export function assistantOrderingKey(input: {
  readonly channelId?: string | undefined;
  readonly threadParentId?: string | undefined;
  readonly userId: string;
}): string {
  if (input.channelId === undefined) return `user:${input.userId}`;
  return `chan:${input.threadParentId ?? input.channelId}`;
}
