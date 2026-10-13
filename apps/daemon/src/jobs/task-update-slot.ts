import { taskNudgeRepo, type GuildScope } from '@bananasaurs/storage';

/** ADR 0140: post a recorded update to the task's channel on the next worker pass. Idempotent per report. */
export const scheduleUpdatePost = (
  scope: GuildScope,
  taskId: string,
  reportId: string,
  now: number,
): void => {
  taskNudgeRepo.schedule(
    scope,
    {
      slotId: `update:${reportId}`,
      kind: 'update',
      taskId,
      dueAt: now,
      payload: JSON.stringify({ reportId }),
    },
    now,
  );
};
