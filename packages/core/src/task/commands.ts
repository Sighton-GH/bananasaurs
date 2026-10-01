import type { SlashResponder } from '../ops/commands/slash-responder.js';
import type { Subscriber } from '../pipeline/pipeline.js';
import type { InteractionRef, OutgoingMessage } from '../discord/port.js';
import { buildCompleteSelect, parseTaskCustomId } from './components.js';

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
  ) => Promise<{ outcome: 'done' | 'sent-back' | 'not-authorised' | 'conflict'; title?: string }>;
  readonly pickReplyTask: (
    userId: string,
    choiceMessageId: string,
    taskId: string,
  ) => Promise<{ outcome: 'recorded' | 'not-yours' | 'gone'; title?: string }>;
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

const clean = (text: string, max: number): string =>
  text.replaceAll(/[\r\n`@]/g, ' ').slice(0, max);

const statusLabel = (status: string): string => {
  if (status === 'not_started') return 'Not started';
  if (status === 'in_progress') return 'In progress';
  if (status === 'awaiting_approval') return 'Awaiting approval';
  return status;
};

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
            await deps.responder.respond(ref, {
              content: 'Unknown task command.',
              allowedMentions: { parse: [] },
            });
            return;
          }
          if (event.subcommandPath[0] === 'complete') {
            const items = [...(await deps.completableForMember(event.userId))].sort(
              (a, b) => a.dueAt - b.dueAt,
            );
            if (items.length === 0) {
              await deps.responder.respond(ref, {
                content: 'Nothing to complete right now.',
                allowedMentions: { parse: [] },
              });
              return;
            }
            const first = items.slice(0, 25).map((t) => ({
              taskId: t.taskId,
              title: t.title,
              dueLabel: `due ${formatDueLabel(t.dueAt, t.timezone)}`,
            }));
            await deps.responder.respond(ref, {
              content: 'Which task is ready for review?',
              components: buildCompleteSelect(first),
              allowedMentions: { parse: [] },
            });
            return;
          }
          const rows = [...(await deps.listForMember(event.userId))].sort(
            (a, b) => a.dueAt - b.dueAt,
          );
          if (rows.length === 0) {
            await deps.responder.respond(ref, {
              content: 'You have no open tasks.',
              allowedMentions: { parse: [] },
            });
            return;
          }
          const nowMs = deps.now();
          const lines = rows.slice(0, 15).map((row) => {
            const title = clean(row.title, 100);
            const team = clean(row.teamName, 50);
            const label = statusLabel(row.status);
            const due = formatDueLabel(row.dueAt, row.timezone);
            const overdue = row.dueAt < nowMs ? ' (overdue)' : '';
            return `**${team}**: ${title} — ${label}, due ${due}${overdue}`;
          });
          const content =
            rows.length > 15
              ? `${lines.join('\n')}\nShowing 15 of ${rows.length}.`
              : lines.join('\n');
          await deps.responder.respond(ref, { content, allowedMentions: { parse: [] } });
        } catch {
          try {
            await deps.responder.respond(ref, {
              content: 'Could not update tasks right now. Try again later.',
              allowedMentions: { parse: [] },
            });
          } catch {
            // The interaction token may have expired or the first defer may have failed.
          }
        }
      } catch {
        try {
          await deps.responder.respond(ref, {
            content: 'Could not update tasks right now. Try again later.',
            allowedMentions: { parse: [] },
          });
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
        try {
          if (parsed.action === 'complete') {
            const selected = event.values?.[0];
            if (typeof selected !== 'string' || !UUID_RE.test(selected)) {
              await deps.responder.respond(ref, {
                content: 'Choose a task from the list.',
                allowedMentions: { parse: [] },
              });
              return;
            }
            const outcome = await deps.completeForMember(event.userId, selected);
            const content =
              outcome === 'awaiting_approval'
                ? 'Marked ready for review. A lead (or the president for exec tasks) can approve it.'
                : outcome === 'already-awaiting'
                  ? 'That task is already waiting for review.'
                  : outcome === 'not-found'
                    ? 'That task is not available to you.'
                    : 'That task changed. Run /task complete again.';
            await deps.responder.respond(ref, { content, allowedMentions: { parse: [] } });
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
            if (result.outcome === 'done') {
              await deps.responder.respond(ref, {
                content: 'Approved.',
                allowedMentions: { parse: [] },
              });
              await refreshPost({
                content: `✅ Approved by <@${event.userId}>: **${result.title ?? ''}**`,
                components: [],
                allowedMentions: { parse: [] },
              });
              return;
            }
            if (result.outcome === 'sent-back') {
              await deps.responder.respond(ref, {
                content: 'Sent back.',
                allowedMentions: { parse: [] },
              });
              await refreshPost({
                content: `↩️ Sent back by <@${event.userId}>: **${result.title ?? ''}**`,
                components: [],
                allowedMentions: { parse: [] },
              });
              return;
            }
            if (result.outcome === 'not-authorised') {
              await deps.responder.respond(ref, {
                content: "Only this team's lead or the president can review this task.",
                allowedMentions: { parse: [] },
              });
              return;
            }
            await deps.responder.respond(ref, {
              content: 'This task changed since this post. Check /task list.',
              allowedMentions: { parse: [] },
            });
            return;
          }
          if (parsed.action !== 'pick') return;
          const result = await deps.pickReplyTask(
            event.userId,
            parsed.choiceMessageId,
            parsed.taskId,
          );
          if (result.outcome === 'recorded') {
            await deps.responder.respond(ref, {
              content: 'Update recorded.',
              allowedMentions: { parse: [] },
            });
            await refreshPost({
              content: `Update recorded on **${result.title ?? ''}**.`,
              components: [],
              allowedMentions: { parse: [] },
            });
            return;
          }
          if (result.outcome === 'not-yours') {
            await deps.responder.respond(ref, {
              content: 'Only the person who posted the update can choose.',
              allowedMentions: { parse: [] },
            });
            return;
          }
          await deps.responder.respond(ref, {
            content: 'This choice is no longer available.',
            allowedMentions: { parse: [] },
          });
        } catch {
          try {
            await deps.responder.respond(ref, {
              content: 'Could not update tasks right now. Try again later.',
              allowedMentions: { parse: [] },
            });
          } catch {
            // The interaction token may have expired or the first defer may have failed.
          }
        }
      } catch {
        try {
          await deps.responder.respond(ref, {
            content: 'Could not update tasks right now. Try again later.',
            allowedMentions: { parse: [] },
          });
        } catch {
          // The interaction token may have expired or the first defer may have failed.
        }
      }
    }
  },
});
