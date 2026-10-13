import { ChannelType, type Client, type Guild } from 'discord.js';
import { isNoAccess, isProgressUpdate, type DiscordPort, type Subscriber } from '@bananasaurs/core';
import { loggingRepo, taskNudgeRepo, taskRepo, type GuildScope } from '@bananasaurs/storage';
import { noAccessFromCache } from './channels/access.js';
import { taskMemberAccess, type TaskMemberAccess } from './task-access.js';

/** The one pipeline subscriber for task progress replies: anchors, reminders, and check-ins. */
export const createTaskReplySubscriber = (
  scope: GuildScope,
  client: Client,
  discord: DiscordPort,
): Subscriber => ({
  name: 'task-reports',
  async handle(event) {
    if (event.kind !== 'messageCreate') return;
    // 1. Only first-party replies to a bot task post count.
    if (
      event.guildId !== scope.guildId ||
      event.authorIsBot ||
      !event.authorId ||
      !event.content ||
      !event.referencedMessageId ||
      event.isPrivateThread
    )
      return;
    const authorId = event.authorId;
    const content = event.content;
    // ADR 0126 I2: a reply in a No-access channel is never recorded — an
    // exclusion on the channel, its parent or its category vetoes, read off
    // the event facts like the logging subscriber. Nothing is recorded and
    // nothing is scheduled.
    if (
      isNoAccess({
        channelId: event.channelId,
        parentChannelId: event.parentChannelId,
        categoryId: event.categoryId,
        isExcluded: (id) => loggingRepo.isChannelExcluded(scope, id),
      })
    )
      return;
    // 2. Candidates come from the replied-to message id only.
    const anchored = taskRepo.taskForAnchor(scope, event.channelId, event.referencedMessageId);
    let candidateIds: string[];
    // A reply to the clarifying question is recorded but never evaluated
    // again (ADR 0112 decision 2): it answers its own slot's task.
    let repliedToEvaluate = false;
    if (anchored !== undefined) {
      candidateIds = [anchored];
    } else {
      const slot = taskNudgeRepo.sentSlotForMessage(
        scope,
        event.channelId,
        event.referencedMessageId,
      );
      if (!slot) return;
      if (
        (slot.kind === 'pre_due' || slot.kind === 'custom' || slot.kind === 'update') &&
        slot.taskId
      )
        candidateIds = [slot.taskId];
      else if (slot.kind === 'evaluate' && slot.taskId) {
        candidateIds = [slot.taskId];
        repliedToEvaluate = true;
      } else if (slot.kind === 'checkin')
        candidateIds = taskNudgeRepo.listSlotTasks(scope, slot.slotId);
      else return;
    }
    if (candidateIds.length === 0) return;
    // 3. A bare acknowledgement is not a progress update.
    if (!isProgressUpdate(content)) return;
    // 4. Live membership and destination checks, against current Discord state.
    const guild = client.guilds.cache.get(scope.guildId);
    if (!guild) return;
    let access: TaskMemberAccess;
    try {
      access = await taskMemberAccess(scope, client, discord, authorId);
    } catch {
      return;
    }
    const matching = await eligibleTasks(
      guild,
      scope,
      access,
      event.channelId,
      authorId,
      candidateIds,
    );
    // 5. Exactly one task owns this reply: record it, ask the worker for a ✅,
    // and — unless this answers a clarifying question — for one evaluation.
    if (matching.length === 1) {
      const taskId = matching[0]!;
      const outcome = taskRepo.recordReport(
        scope,
        taskId,
        event.messageId,
        authorId,
        content.trim(),
        { actorType: 'member', actorId: authorId, via: 'gateway' },
        event.receivedAtMs,
      );
      if (outcome === 'recorded') {
        taskNudgeRepo.schedule(
          scope,
          {
            slotId: `followup:${event.messageId}`,
            kind: 'followup',
            dueAt: event.receivedAtMs,
            payload: JSON.stringify({ channelId: event.channelId, messageId: event.messageId }),
          },
          event.receivedAtMs,
        );
        if (!repliedToEvaluate)
          scheduleEvaluate(scope, taskId, event.channelId, event.messageId, event.receivedAtMs);
      }
      return;
    }
    // 6. Several tasks could own it: hold the body until the author picks one.
    if (matching.length > 1) {
      taskNudgeRepo.insertReplyChoice(scope, {
        messageId: event.messageId,
        authorId,
        channelId: event.channelId,
        body: content.trim(),
        createdAt: event.receivedAtMs,
      });
      taskNudgeRepo.schedule(
        scope,
        {
          slotId: `clarify:${event.messageId}`,
          kind: 'clarify',
          dueAt: event.receivedAtMs,
          payload: JSON.stringify({
            replyMessageId: event.messageId,
            channelId: event.channelId,
            candidates: matching.slice(0, 5),
          }),
        },
        event.receivedAtMs,
      );
    }
    // 7. None match: ignore.
  },
});

/** Resolve a clarification pick press (Task 8 wires this to the pick button). */
export const resolveReplyChoice = async (
  scope: GuildScope,
  client: Client,
  discord: DiscordPort,
  pressedBy: string,
  choiceMessageId: string,
  taskId: string,
  now: number,
): Promise<'recorded' | 'not-yours' | 'gone'> => {
  const choice = taskNudgeRepo.getReplyChoice(scope, choiceMessageId);
  if (!choice) return 'gone';
  if (pressedBy !== choice.authorId) return 'not-yours';
  // ADR 0126 I2: the choice's channel may have been marked No access while
  // the pick was pending — record nothing and schedule nothing.
  if (noAccessFromCache(client, scope, choice.channelId)) return 'gone';
  const slot = taskNudgeRepo.getSlot(scope, `clarify:${choiceMessageId}`);
  if (!parseCandidates(slot?.payload ?? null).includes(taskId)) return 'gone';
  const guild = client.guilds.cache.get(scope.guildId);
  if (!guild) return 'gone';
  let access: TaskMemberAccess;
  try {
    access = await taskMemberAccess(scope, client, discord, choice.authorId);
  } catch {
    return 'gone';
  }
  const matching = await eligibleTasks(guild, scope, access, choice.channelId, choice.authorId, [
    taskId,
  ]);
  if (matching.length !== 1) return 'gone';
  const outcome = taskRepo.recordReport(
    scope,
    taskId,
    choiceMessageId,
    choice.authorId,
    choice.body,
    { actorType: 'member', actorId: choice.authorId, via: 'gateway' },
    now,
  );
  taskNudgeRepo.deleteReplyChoice(scope, choiceMessageId);
  if (outcome === 'recorded') {
    taskNudgeRepo.schedule(
      scope,
      {
        slotId: `followup:${choiceMessageId}`,
        kind: 'followup',
        dueAt: now,
        payload: JSON.stringify({ channelId: choice.channelId, messageId: choiceMessageId }),
      },
      now,
    );
    scheduleEvaluate(scope, taskId, choice.channelId, choiceMessageId, now);
  }
  if (outcome === 'not-open') return 'gone';
  return 'recorded';
};

/**
 * One evaluation slot per recorded update (ADR 0112 decision 3): idempotent
 * on the reply message, so a gateway replay never evaluates twice. The
 * payload carries ids only, never the member's update text.
 */
const scheduleEvaluate = (
  scope: GuildScope,
  taskId: string,
  channelId: string,
  messageId: string,
  now: number,
): void => {
  taskNudgeRepo.schedule(
    scope,
    {
      slotId: `evaluate:${messageId}`,
      kind: 'evaluate',
      taskId,
      dueAt: now,
      payload: JSON.stringify({ taskId, channelId, messageId }),
    },
    now,
  );
};

const parseCandidates = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { candidates?: unknown };
    return Array.isArray(parsed.candidates) &&
      parsed.candidates.every((c): c is string => typeof c === 'string')
      ? [...parsed.candidates]
      : [];
  } catch {
    return [];
  }
};

/** Keep the candidate tasks the author may report on right now. */
const eligibleTasks = async (
  guild: Guild,
  scope: GuildScope,
  access: TaskMemberAccess,
  channelId: string,
  authorId: string,
  candidateIds: readonly string[],
): Promise<string[]> => {
  const teamsById = new Map(taskRepo.listTeams(scope).map((team) => [team.teamId, team]));
  const matching: string[] = [];
  for (const taskId of new Set(candidateIds)) {
    const task = taskRepo.getTask(scope, taskId);
    if (
      !task ||
      task.archivedAt !== null ||
      (task.status !== 'not_started' && task.status !== 'in_progress')
    )
      continue;
    if (task.destinationId !== channelId) continue;
    const team = teamsById.get(task.teamId);
    if (!team) continue;
    if (!(await destinationMatchesTeam(guild, task.destinationId, team.categoryId))) continue;
    if (task.assignmentKind === 'individual') {
      if (!taskRepo.isTaskAssignee(scope, task.taskId, authorId)) continue;
      if (!access.onTeam(task.teamId)) continue;
    } else if (!access.onTeam(task.teamId)) continue;
    matching.push(task.taskId);
  }
  return matching;
};

/**
 * The team's category is live and the destination sits under it. A thread
 * counts as its parent's parent; anything else counts as its own parent.
 */
const destinationMatchesTeam = async (
  guild: Guild,
  destinationId: string,
  categoryId: string,
): Promise<boolean> => {
  try {
    const category = await guild.channels.fetch(categoryId, { force: true });
    if (category?.type !== ChannelType.GuildCategory) return false;
    const destination = await guild.channels.fetch(destinationId, { force: true });
    if (!destination || !destination.isTextBased()) return false;
    if (destination.isThread()) {
      if (!destination.parentId) return false;
      const parent = await guild.channels.fetch(destination.parentId, { force: true });
      return !!parent && 'parentId' in parent && parent.parentId === categoryId;
    }
    return 'parentId' in destination && destination.parentId === categoryId;
  } catch {
    // Missing current Discord state is not permission to attribute a reply.
    return false;
  }
};
