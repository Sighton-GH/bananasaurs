import type { SlashResponder } from '../ops/commands/slash-responder.js';
import type { Subscriber } from '../pipeline/pipeline.js';
import type { InteractionRef, OutgoingMessage } from '../discord/port.js';
import {
  errorCard,
  resultCard,
  toOutgoingMessage,
  truncate,
  type CardMessage,
} from '../ui/discord/index.js';
import {
  buildUpdateModal,
  renderReviewDecisionCard,
  renderCompletePickerCard,
  renderTaskListCard,
  TASK_UPDATE_BLOCKER_MAX,
  TASK_UPDATE_BODY_MAX,
  type TaskStatus,
} from './cards.js';
import { parseTaskCustomId } from './components.js';

export interface TaskCommandRow {
  readonly taskId: string;
  readonly teamName: string;
  readonly title: string;
  readonly status: string;
  readonly dueAt: number;
  readonly timezone: string;
}

export interface TaskCommandDeps {
  readonly guildId: string;
  readonly responder: SlashResponder;
  readonly now: () => number;
  readonly listForMember: (userId: string) => Promise<readonly TaskCommandRow[]>;
  readonly completableForMember: (
    userId: string,
  ) => Promise<readonly { taskId: string; title: string; dueAt: number; timezone: string }[]>;
  readonly completeForMember: (
    userId: string,
    taskId: string,
  ) => Promise<'awaiting_approval' | 'already-awaiting' | 'not-found' | 'conflict'>;
  readonly decideReview: (
    userId: string,
    taskId: string,
    version: number,
    decision: 'approve' | 'reject',
  ) => Promise<{
    outcome: 'done' | 'sent-back' | 'not-authorised' | 'conflict';
    title?: string;
    teamName?: string;
  }>;
  readonly pickReplyTask: (
    userId: string,
    choiceMessageId: string,
    taskId: string,
  ) => Promise<{ outcome: 'recorded' | 'not-yours' | 'gone'; title?: string }>;
  /** Move a not-started task to In progress for this member, compare-and-swap on version. */
  readonly startTask: (
    userId: string,
    taskId: string,
    version: number,
  ) => Promise<'started' | 'not-yours' | 'stale' | 'not-open'>;
  /** Re-render the task's anchored card now. */
  readonly refreshTaskCard: (taskId: string) => Promise<void>;
  /** Synchronous so opening the modal never waits for live access checks. */
  readonly taskTitle: (taskId: string) => string | undefined;
  /** Authority is checked on submit, not on modal open (ADR 0140). */
  readonly postUpdate: (
    userId: string,
    taskId: string,
    interactionId: string,
    body: string,
    blocker: string | undefined,
  ) => Promise<{
    outcome: 'recorded' | 'duplicate' | 'not-yours' | 'not-open' | 'invalid';
    postsOn: boolean;
  }>;
  readonly editBotMessage: (
    channelId: string,
    messageId: string,
    message: OutgoingMessage,
  ) => Promise<void>;
}

export const formatDueLabel: (dueAt: number, timeZone: string) => string = (dueAt, timeZone) => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'short',
      day: 'numeric',
    }).format(new Date(dueAt));
  } catch (err) {
    if (err instanceof RangeError) return new Date(dueAt).toISOString().slice(0, 10);
    throw err;
  }
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Completion requests review; it never approves a task or posts to Discord. */
export const createTaskCommandSubscriber = (deps: TaskCommandDeps): Subscriber => ({
  name: 'task-commands',
  async handle(event) {
    if (event.guildId !== deps.guildId) return;
    if (event.kind === 'slashCommand') {
      if (event.commandName !== 'task') return;
      const ref: InteractionRef = { interactionId: event.interactionId, token: event.token };
      try {
        await deps.responder.defer(ref, { ephemeral: true });
        try {
          if (
            event.subcommandPath.length !== 1 ||
            !['list', 'complete'].includes(event.subcommandPath[0] ?? '')
          ) {
            await deps.responder.respond(ref, toOutgoingMessage(errorCard('command.unknown')));
            return;
          }
          if (event.subcommandPath[0] === 'complete') {
            const items = [...(await deps.completableForMember(event.userId))].sort(
              (a, b) => a.dueAt - b.dueAt,
            );
            if (items.length === 0) {
              await deps.responder.respond(
                ref,
                toOutgoingMessage(
                  resultCard({
                    icon: 'task',
                    title: 'Nothing is ready to complete',
                    detail: 'You have no open tasks that can go to review.',
                    tone: 'neutral',
                  }),
                ),
              );
              return;
            }
            const first = items.slice(0, 25).map((t) => ({
              taskId: t.taskId,
              title: t.title,
              dueLabel: `due ${formatDueLabel(t.dueAt, t.timezone)}`,
            }));
            await deps.responder.respond(
              ref,
              toOutgoingMessage(renderCompletePickerCard({ tasks: first })),
            );
            return;
          }
          const rows = [...(await deps.listForMember(event.userId))].sort(
            (a, b) => a.dueAt - b.dueAt,
          );
          if (rows.length === 0) {
            await deps.responder.respond(
              ref,
              toOutgoingMessage(
                resultCard({ icon: 'task', title: 'You have no open tasks', tone: 'neutral' }),
              ),
            );
            return;
          }
          await deps.responder.respond(
            ref,
            toOutgoingMessage(
              renderTaskListCard({
                rows: rows.map((r) => ({
                  teamName: r.teamName,
                  title: r.title,
                  status: r.status as TaskStatus,
                  dueAt: r.dueAt,
                })),
                now: deps.now(),
              }),
            ),
          );
        } catch {
          try {
            await deps.responder.respond(ref, toOutgoingMessage(errorCard('task.unavailable')));
          } catch {
            // The interaction token may have expired or the first defer may have failed.
          }
        }
      } catch {
        try {
          await deps.responder.respond(ref, toOutgoingMessage(errorCard('task.unavailable')));
        } catch {
          // The interaction token may have expired or the first defer may have failed.
        }
      }
      return;
    }
    if (event.kind === 'interaction') {
      const parsed = parseTaskCustomId(event.customId);
      if (parsed === undefined) return;
      const ref: InteractionRef = { interactionId: event.interactionId, token: event.token };
      if (parsed.action === 'start') {
        const reply = async (message: CardMessage): Promise<void> => {
          try {
            await deps.responder.respond(ref, toOutgoingMessage(message));
          } catch {
            // The token may have expired; nothing more can be said to the member.
          }
        };
        const refreshCard = async (taskId: string): Promise<void> => {
          try {
            await deps.refreshTaskCard(taskId);
          } catch {
            // The 60-second refresh pass will catch up.
          }
        };
        try {
          await deps.responder.deferUpdate(ref);
        } catch {
          return;
        }
        try {
          const outcome = await deps.startTask(event.userId, parsed.taskId, parsed.version);
          if (outcome === 'started') {
            await refreshCard(parsed.taskId);
            return;
          }
          if (outcome === 'stale') {
            await refreshCard(parsed.taskId);
            await reply(errorCard('task.stale'));
            return;
          }
          await reply(errorCard(outcome === 'not-yours' ? 'task.not-yours' : 'task.not-open'));
        } catch {
          await reply(errorCard('task.unavailable'));
        }
        return;
      }
      if (parsed.action === 'update') {
        try {
          await deps.responder.showModal(
            ref,
            buildUpdateModal(parsed.taskId, deps.taskTitle(parsed.taskId)),
          );
        } catch {
          // Expired or already answered; the member can press the button again.
        }
        return;
      }
      try {
        await deps.responder.defer(ref, { ephemeral: true });
        // Refresh the bot post after a successful review or pick. An edit
        // failure must never overwrite the success reply: the write already
        // happened, so there is nothing member-facing to say about it.
        const refreshPost = async (message: OutgoingMessage): Promise<void> => {
          try {
            await deps.editBotMessage(event.channelId, event.messageId, message);
          } catch {
            // The success reply already stands.
          }
        };
        const reply = async (message: CardMessage): Promise<void> => {
          try {
            await deps.responder.respond(ref, toOutgoingMessage(message));
          } catch {
            // The token may have expired; do not retry a reply after the write.
          }
        };
        try {
          if (parsed.action === 'complete') {
            const selected = event.values?.[0];
            if (typeof selected !== 'string' || !UUID_RE.test(selected)) {
              await deps.responder.respond(
                ref,
                toOutgoingMessage(errorCard('task.pick-from-list')),
              );
              return;
            }
            const outcome = await deps.completeForMember(event.userId, selected);
            const reply =
              outcome === 'awaiting_approval'
                ? resultCard({
                    icon: 'review',
                    title: 'Sent for review',
                    detail: 'A lead (or the president for exec tasks) can approve it.',
                    tone: 'hold',
                  })
                : outcome === 'already-awaiting'
                  ? resultCard({
                      icon: 'review',
                      title: 'Already waiting for review',
                      tone: 'hold',
                    })
                  : outcome === 'not-found'
                    ? errorCard('task.not-open')
                    : errorCard('task.changed');
            await deps.responder.respond(ref, toOutgoingMessage(reply));
            return;
          }
          if (parsed.action === 'approve' || parsed.action === 'reject') {
            const decision = parsed.action === 'approve' ? 'approve' : 'reject';
            const result = await deps.decideReview(
              event.userId,
              parsed.taskId,
              parsed.version,
              decision,
            );
            if (result.outcome === 'done' || result.outcome === 'sent-back') {
              const approved = result.outcome === 'done';
              await reply(
                approved
                  ? resultCard({ icon: 'done', title: 'Approved', tone: 'ok' })
                  : resultCard({
                      icon: 'sentBack',
                      title: 'Sent back',
                      detail: 'The task is back in progress.',
                      tone: 'progress',
                    }),
              );
              await refreshPost(
                toOutgoingMessage(
                  renderReviewDecisionCard({
                    taskTitle: result.title ?? 'Task',
                    teamName: result.teamName ?? 'Team',
                    decision: approved ? 'approved' : 'sent-back',
                    deciderId: event.userId,
                    at: deps.now(),
                  }),
                ),
              );
              return;
            }
            await reply(
              errorCard(
                result.outcome === 'not-authorised' ? 'task.review-not-yours' : 'task.review-stale',
              ),
            );
            return;
          }
          if (parsed.action !== 'pick') return;
          const result = await deps.pickReplyTask(
            event.userId,
            parsed.choiceMessageId,
            parsed.taskId,
          );
          if (result.outcome === 'recorded') {
            // resultCard escapes the detail; pass raw text so it is escaped once.
            const done = resultCard({
              icon: 'update',
              title: 'Update recorded',
              detail: `On ${truncate(result.title ?? 'the task', 120)}.`,
              tone: 'ok',
            });
            await reply(done);
            await refreshPost(toOutgoingMessage(done));
            return;
          }
          await reply(
            errorCard(
              result.outcome === 'not-yours' ? 'task.choice-not-yours' : 'task.choice-gone',
            ),
          );
        } catch {
          try {
            await deps.responder.respond(ref, toOutgoingMessage(errorCard('task.unavailable')));
          } catch {
            // The interaction token may have expired or the first defer may have failed.
          }
        }
      } catch {
        try {
          await deps.responder.respond(ref, toOutgoingMessage(errorCard('task.unavailable')));
        } catch {
          // The interaction token may have expired or the first defer may have failed.
        }
      }
    }
    if (event.kind === 'modalSubmit') {
      const parsed = parseTaskCustomId(event.customId);
      if (parsed === undefined || parsed.action !== 'update') return;
      const ref: InteractionRef = { interactionId: event.interactionId, token: event.token };
      const body = (event.fields['body'] ?? '').trim();
      const blockerRaw = (event.fields['blocker'] ?? '').trim();
      const blocker = blockerRaw === '' ? undefined : blockerRaw;
      const typed = blocker === undefined ? body : `${body}\n\nBlocked: ${blocker}`;
      const reply = async (message: CardMessage): Promise<void> => {
        try {
          await deps.responder.respond(ref, toOutgoingMessage(message));
        } catch {
          // The token may have expired.
        }
      };
      try {
        await deps.responder.defer(ref, { ephemeral: true });
      } catch {
        return;
      }
      // Discord enforces min_length/max_length on the client; a hand-rolled
      // interaction does not. Reject an empty or oversized update here rather
      // than recording it (P1 phase review P3-1).
      if (
        body === '' ||
        body.length > TASK_UPDATE_BODY_MAX ||
        (blocker !== undefined && blocker.length > TASK_UPDATE_BLOCKER_MAX)
      ) {
        await reply(errorCard('task.update-not-saved', { quote: typed }));
        return;
      }
      try {
        const result = await deps.postUpdate(
          event.userId,
          parsed.taskId,
          event.interactionId,
          body,
          blocker,
        );
        if (result.outcome === 'recorded' || result.outcome === 'duplicate') {
          await reply(
            resultCard({
              icon: 'update',
              title: 'Update saved',
              detail: result.postsOn
                ? 'It shows on the task card and is posted in the channel.'
                : 'It is saved on the task. Task posts are turned off, so nothing was posted.',
              tone: 'ok',
            }),
          );
          return;
        }
        await reply(errorCard('task.update-not-saved', { quote: typed }));
      } catch {
        await reply(errorCard('task.unavailable', { quote: typed }));
      }
      return;
    }
  },
});
