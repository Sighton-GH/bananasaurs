import type { GuildScope } from '@bananasaurs/storage';
import { taskRepo } from '@bananasaurs/storage';

/** A read-only, already-authorized task snapshot for one Discord member. */
export interface TaskContextAccess {
  readonly actorId: string;
  readonly teams: readonly {
    readonly teamId: string;
    readonly name: string;
    readonly kind: string;
    readonly categoryId: string;
  }[];
  readonly president: boolean;
  readonly leadTeamIds: readonly string[];
}
export interface TaskContextPort {
  access(actorId: string): Promise<TaskContextAccess | undefined>;
  /** Optional until the core anchor persistence is merged. Never guess an anchor from text. */
  anchorTaskId?(channelId: string, referencedMessageId: string): string | undefined;
}

const TASK_SIGNAL =
  /\b(task|deadline|due|progress|update|finished|finish|completed|complete|done|blocked|assignment|subtask|check.?in)\b/i;
const clean = (text: string, max: number): string =>
  text
    .replaceAll(/[\r\n`@]/g, ' ')
    .replaceAll(String.fromCharCode(0), ' ')
    .slice(0, max);
/** No match means no task data is sent to the provider. Channel alone is not evidence of an update. */
export const boundedTaskContext = async (
  scope: GuildScope,
  port: TaskContextPort,
  input: {
    readonly actorId: string;
    readonly channelId?: string;
    readonly text: string;
    readonly referencedMessageId?: string;
  },
): Promise<string | undefined> => {
  if (!input.channelId) return undefined;
  const hasSignal = TASK_SIGNAL.test(input.text);
  if (!hasSignal && !input.referencedMessageId) return undefined;
  let access: TaskContextAccess | undefined;
  try {
    access = await port.access(input.actorId);
  } catch {
    return undefined;
  }
  if (!access || access.actorId !== input.actorId || access.teams.length === 0) return undefined;
  const teams = new Map(access.teams.map((team) => [team.teamId, team]));
  let anchored: string | undefined;
  if (input.referencedMessageId && port.anchorTaskId) {
    try {
      anchored = port.anchorTaskId(input.channelId, input.referencedMessageId);
    } catch {
      return undefined;
    }
  }
  // An unrelated reply is not task context merely because it is in a task channel.
  if (!hasSignal && !anchored) return undefined;
  const candidates = taskRepo
    .listTasks(scope)
    .filter(
      (task) =>
        task.status !== 'done' && teams.has(task.teamId) && task.destinationId === input.channelId,
    )
    .filter((task) => anchored === undefined || task.taskId === anchored)
    .slice(0, 8);
  if (candidates.length === 0) return undefined;
  const rows = candidates.map((task) => {
    const team = teams.get(task.teamId)!;
    const approve =
      team.kind === 'exec' ? access.president : access.leadTeamIds.includes(team.teamId);
    const actions = [
      task.assignmentKind === 'individual' &&
      !taskRepo.isTaskAssignee(scope, task.taskId, input.actorId)
        ? ''
        : 'request completion via /task complete',
      approve ? 'can approve from the review post' : '',
    ].filter(Boolean);
    return `- task ${task.taskId}; team ${clean(team.name, 60)}; title ${JSON.stringify(clean(task.title, 100))}; destination ${task.destinationId}; status ${task.status}; due ${new Date(task.dueAt).toISOString()}; allowed actions: ${actions.length ? actions.join(', ') : 'read only'}`;
  });
  const header = `TASK CONTEXT (read only; member access checked live)\nactor ${input.actorId}; channel ${input.channelId}`;
  const instruction =
    "To log progress, the member replies directly to the task's post or reminder in Discord. To finish a task they use /task complete; a lead or the president approves it from the review post. Do not claim anything was recorded or changed.";
  const closing =
    'The only direct Discord task commands are /task list and /task complete. Never disclose tasks beyond this section.';
  // Keep the control rule whole, even when the candidate set approaches the cap.
  const budget = 2400 - header.length - instruction.length - closing.length - 3;
  const boundedRows: string[] = [];
  let used = 0;
  for (const row of rows) {
    if (used + row.length + 1 > budget) break;
    boundedRows.push(row);
    used += row.length + 1;
  }
  return [header, ...boundedRows, instruction, closing].join('\n');
};
