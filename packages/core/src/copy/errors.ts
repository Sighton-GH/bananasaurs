/**
 * The error catalogue (docs/28 §3, ADR 0141). One entry per failure a person
 * can meet; Discord replies and HTTP answers read the same words. P1 adds the
 * task entries; P2 adds moderation, panels and the rest, plus a completeness test.
 */
export type CopyAudience = 'member' | 'moderator' | 'owner';

export interface ErrorCopy {
  /** What happened, in a few words. Sentence case, no full stop. */
  readonly title: string;
  /** Why, framed as the system's rule. */
  readonly detail: string;
  /** What the reader can do, or who can. */
  readonly next?: string;
  /** True only when trying again can succeed. */
  readonly retryable: boolean;
  readonly tone: 'hold' | 'danger';
  readonly audience: CopyAudience;
}

export const ERROR_COPY = {
  'task.not-yours': {
    title: "This task isn't yours to pick up",
    detail: 'Only people assigned to it, or on its team for a whole-team task, can do this.',
    next: 'Ask a team lead to add you if you want to help.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'task.not-open': {
    title: 'This task is closed',
    detail: "It's done, archived or waiting for review, so it can't change from here.",
    next: 'Use /task list to see your open tasks.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'task.stale': {
    title: 'This card was out of date',
    detail: 'The task changed after this card was posted. The card has been refreshed.',
    next: 'Try again on the refreshed card.',
    retryable: true,
    tone: 'hold',
    audience: 'member',
  },
  'task.unavailable': {
    title: "Couldn't update the task",
    detail: "Bananasaurs couldn't save the change. Nothing was changed.",
    next: 'Try again in a minute.',
    retryable: true,
    tone: 'danger',
    audience: 'member',
  },
  'task.update-not-saved': {
    title: "Your update wasn't saved",
    detail: 'Only people on this task can post updates to it, and only while it is open.',
    next: 'Here is what you wrote, so you can copy it:',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'task.review-not-yours': {
    title: "You can't review this task",
    detail:
      "Only the team's lead, or the president for exec tasks, can approve it or send it back.",
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'task.choice-not-yours': {
    title: "This choice isn't yours",
    detail: 'Only the person who posted the update can choose its task.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'task.choice-gone': {
    title: 'This choice has expired',
    detail: 'The update was already recorded, or it is too old to place.',
    next: 'Reply to the task card again if it still needs recording.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'task.pick-from-list': {
    title: 'Choose a task from the list',
    detail: "That choice didn't match one of your open tasks.",
    next: 'Run /task complete again.',
    retryable: true,
    tone: 'hold',
    audience: 'member',
  },
  'task.review-stale': {
    title: 'This review is out of date',
    detail: 'The task changed after this review was requested, so a newer review post replaces it.',
    next: 'Use the newest review post for this task.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'task.changed': {
    title: 'This task just changed',
    detail: 'Someone edited it while you were choosing.',
    next: 'Run /task complete again.',
    retryable: true,
    tone: 'hold',
    audience: 'member',
  },
  'command.unknown': {
    title: "That command isn't available",
    detail: "Bananasaurs doesn't recognise it.",
    next: 'Use /task list or /task complete.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
} as const satisfies Record<string, ErrorCopy>;

export type ErrorCode = keyof typeof ERROR_COPY;
