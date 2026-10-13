export type TaskStatus = 'not_started' | 'in_progress' | 'awaiting_approval' | 'done';

/** The words people read for a status (docs/28 section 3). */
export const STATUS_WORDS: Record<TaskStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  awaiting_approval: 'Waiting for review',
  done: 'Done',
};

export const STATUS_TONE: Record<TaskStatus, 'neutral' | 'progress' | 'hold' | 'ok'> = {
  not_started: 'neutral',
  in_progress: 'progress',
  awaiting_approval: 'hold',
  done: 'ok',
};

const plural = (n: number, unit: string): string => `${String(n)} ${unit}${n === 1 ? '' : 's'}`;

/** "in 3 days" for the future, "3 days ago" for the past; coarse on purpose. */
export const relativeWhen = (atMs: number, nowMs: number): string => {
  const diff = atMs - nowMs;
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return 'just now';
  const [n, unit] =
    minutes < 60
      ? [minutes, 'minute']
      : minutes < 60 * 24
        ? [Math.round(minutes / 60), 'hour']
        : [Math.round(minutes / (60 * 24)), 'day'];
  const text = plural(n, unit);
  return diff > 0 ? `in ${text}` : `${text} ago`;
};
