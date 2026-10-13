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
  'mod.not-allowed': {
    title: "You can't take moderation actions",
    detail: 'This needs the moderation permission in Bananasaurs.',
    next: 'Ask the owner if you think you should have it.',
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'mod.killswitch': {
    title: 'Moderation is paused',
    detail: 'The kill switch is on, so the bot takes no moderation actions.',
    next: 'The owner can turn it off in the dashboard under Safety.',
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'mod.breaker-open': {
    title: 'Moderation is paused for safety',
    detail: 'Too many actions went wrong in a row, so the bot stopped acting until someone checks.',
    next: 'The owner can reset it in the dashboard under Safety.',
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'mod.guild-unknown': {
    title: "This server isn't set up yet",
    detail: 'Bananasaurs has no settings for this server, so it will not act here.',
    next: 'The owner can finish setup from the dashboard.',
    retryable: false,
    tone: 'hold',
    audience: 'owner',
  },
  'mod.rate-cap': {
    title: 'Too many actions just now',
    detail: 'The bot limits how many moderation actions it takes in a short time.',
    next: 'Wait a minute, then try again.',
    retryable: true,
    tone: 'hold',
    audience: 'moderator',
  },
  'mod.discord-owner': {
    title: "The server owner can't be moderated",
    detail: "Discord doesn't let any bot act on the server owner.",
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'mod.role-above-bot': {
    title: 'That member is above the bot',
    detail: "Their highest role is at or above the bot's, so Discord won't let it act on them.",
    next: "Move the bot's role higher in Server Settings → Roles, or ask someone with a higher role.",
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'mod.discord-error': {
    title: "Discord didn't accept that",
    detail: 'The bot sent the action, but Discord answered with an error.',
    next: "Try again in a minute. If it keeps happening, check the bot's permissions here.",
    retryable: true,
    tone: 'danger',
    audience: 'moderator',
  },
  'mod.unavailable': {
    title: "Couldn't finish that",
    detail: "Something went wrong on the bot's side, and the action may not have run.",
    next: "Check the member's case history before trying again. Give the owner the Ref below.",
    retryable: true,
    tone: 'danger',
    audience: 'moderator',
  },
  'mod.over-budget': {
    title: 'Too many messages to purge at once',
    detail: 'A purge can remove a limited number of messages in one go.',
    next: 'Purge a quieter channel, or ask the owner to clear it from Discord.',
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'mod.reason-required': {
    title: 'Add a reason',
    detail:
      'Every warning and timeout needs a reason. It goes in case history and Discord’s audit log.',
    next: 'Open the form again and write one.',
    retryable: true,
    tone: 'hold',
    audience: 'moderator',
  },
  'confirm.expired': {
    title: 'This confirmation expired',
    detail: 'A confirmation lasts 15 minutes.',
    next: 'Start again from the command or the log card.',
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'confirm.done': {
    title: 'This was already handled',
    detail: 'It was confirmed or cancelled already.',
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'confirm.not-yours': {
    title: 'Only the moderator who started this can confirm it',
    detail: 'A confirmation belongs to the person who asked for it.',
    next: 'Start your own from the command or the log card.',
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'panel.panel-disabled': {
    title: 'This panel is switched off',
    detail: 'An organiser has turned it off for now.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'panel.missing-required-role': {
    title: 'You need another role first',
    detail: 'This panel is only for members who already have a certain role.',
    next: 'Ask an organiser which role you need.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'panel.blocked-role': {
    title: "This panel isn't available to you",
    detail: "One of your roles means you can't use it.",
    next: "Ask an organiser if you think that's wrong.",
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'panel.max-roles': {
    title: "You've reached this panel's limit",
    detail: 'It allows only so many of its roles at once.',
    next: 'Remove one, then pick again.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'panel.add-only': {
    title: 'This panel only adds roles',
    detail: "It can't take a role away.",
    next: 'Ask an organiser to remove it for you.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'panel.remove-only': {
    title: 'This panel only removes roles',
    detail: "It can't hand roles out.",
    next: 'Ask an organiser how to get the role.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'panel.not-applied': {
    title: "Couldn't change your roles",
    detail:
      "The bot couldn't apply the change just now. An organiser can see why in the dashboard.",
    next: 'Try again in a minute.',
    retryable: true,
    tone: 'danger',
    audience: 'member',
  },
  'panel.unavailable': {
    title: "Couldn't handle that",
    detail: "Something went wrong on the bot's side, so your roles didn't change.",
    next: 'Try again in a minute.',
    retryable: true,
    tone: 'danger',
    audience: 'member',
  },
} as const satisfies Record<string, ErrorCopy>;

export type ErrorCode = keyof typeof ERROR_COPY;
