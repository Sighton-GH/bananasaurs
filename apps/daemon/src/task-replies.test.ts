import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, type Client } from 'discord.js';
import { parseGuildId, type DiscordPort, type MessageEvent } from '@bananasaurs/core';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import {
  effectRepo,
  guildRepo,
  taskRepo,
  taskBindingRepo,
  taskNudgeRepo,
  type GuildScope,
} from '@bananasaurs/storage';
import { createTaskReplySubscriber, resolveReplyChoice } from './task-replies.js';

const GUILD = parseGuildId('111111111111111111');
const CATEGORY = '999999999999999999';
const CHANNEL = '333333333333333333';
const ANNOUNCE = '888888888888888888';
const ACTOR = '444444444444444444';
const OTHER = '121212121212121212';
const ANCHOR = '555555555555555555';
const MESSAGE = '666666666666666666';
const MEMBER_ROLE = '101010101010101010';
const ACTOR_OBJ = { actorType: 'dashboard', actorId: 'owner', via: 'http' } as const;
let db: MigratedTestDatabase;
let scope: GuildScope;
let taskId: string;
let teamId: string;
let roleIdsFor: Record<string, string[]>;
let liveRoles: { id: string }[];
let client: Client;
let discord: DiscordPort;

beforeEach(() => {
  db = openMigratedTestDatabase();
  scope = db.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(scope, { name: 'Test', now: 1 });
  teamId = taskRepo.createTeam(
    scope,
    { name: 'Tech', categoryId: CATEGORY, kind: 'subteam', memberRoleId: MEMBER_ROLE },
    ACTOR_OBJ,
    1,
  );
  taskId = taskRepo.createTask(
    scope,
    {
      teamId,
      title: 'Project',
      assignmentKind: 'team',
      dueAt: 3000,
      timezone: 'America/Vancouver',
      destinationId: CHANNEL,
      createdBy: 'owner',
    },
    ACTOR_OBJ,
    2,
  );
  taskRepo.recordTaskAnchor(scope, taskId, CHANNEL, ANCHOR, 3);
  roleIdsFor = {};
  liveRoles = [];
  client = {
    guilds: {
      cache: new Map([
        [
          GUILD,
          {
            channels: {
              fetch: vi.fn(async (id: string) => {
                if (id === CATEGORY) return { type: ChannelType.GuildCategory };
                if (id === ANNOUNCE)
                  return {
                    type: ChannelType.GuildText,
                    parentId: CATEGORY,
                    isTextBased: (): boolean => true,
                    isThread: (): boolean => false,
                  };
                if (id === CHANNEL)
                  return {
                    isTextBased: (): boolean => true,
                    isThread: (): boolean => true,
                    parentId: '777777777777777777',
                  };
                if (id === '777777777777777777') return { parentId: CATEGORY };
                return undefined;
              }),
            },
          },
        ],
      ]),
    },
  } as unknown as Client;
  discord = {
    fetchMember: vi.fn(async (_guild: string, userId: string) => ({
      userId,
      roleIds: roleIdsFor[userId] ?? [],
      isGuildOwner: false,
    })),
    fetchRoles: vi.fn(async () => liveRoles),
  } as unknown as DiscordPort;
});
afterEach(() => db.close());
const reply = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  kind: 'messageCreate',
  guildId: GUILD,
  receivedAtMs: 5,
  channelId: CHANNEL,
  parentChannelId: '777777777777777777',
  categoryId: CATEGORY,
  isPrivateThread: false,
  messageId: MESSAGE,
  authorId: ACTOR,
  authorDisplayName: 'Member',
  authorIsBot: false,
  content: 'Measurements done',
  editedTimestampMs: undefined,
  referencedMessageId: ANCHOR,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  ...over,
});
const individualTask = (title: string, assignees: string[]): string =>
  taskRepo.createTask(
    scope,
    {
      teamId,
      title,
      assignmentKind: 'individual',
      assigneeIds: assignees,
      dueAt: 3000,
      timezone: 'America/Vancouver',
      destinationId: CHANNEL,
      createdBy: 'owner',
    },
    ACTOR_OBJ,
    2,
  );
const sentSlot = (
  slotId: string,
  extra: { taskId?: string; teamId?: string; kind: 'pre_due' | 'custom' | 'digest' | 'evaluate' },
  messageId: string,
  channelId = CHANNEL,
): void => {
  taskNudgeRepo.schedule(scope, { slotId, dueAt: 10, ...extra }, 10);
  taskNudgeRepo.claim(scope, slotId, 11);
  taskNudgeRepo.settle(scope, slotId, 'sent', 12, channelId, messageId);
};
const sentCheckin = (slotId: string, messageId: string, listed: string[]): void => {
  taskNudgeRepo.schedule(scope, { slotId, kind: 'checkin', dueAt: 10, destinationId: CHANNEL }, 10);
  taskNudgeRepo.claim(scope, slotId, 11);
  taskNudgeRepo.settleWithTasks(scope, slotId, 12, CHANNEL, messageId, listed);
};
/** Slots this subscriber may schedule; createTask's own announce slots do not count. */
const scheduledSlots = () =>
  taskNudgeRepo
    .listSlots(scope)
    .filter((s) => s.kind === 'followup' || s.kind === 'clarify' || s.kind === 'evaluate');

describe('task reply subscriber', () => {
  it('records an assignee reply to the announcement anchor and schedules a follow-up', async () => {
    taskBindingRepo.addMembership(scope, teamId, ACTOR, 'member', ACTOR_OBJ, 3);
    const frame = individualTask('Frame', [ACTOR]);
    taskRepo.recordTaskAnchor(scope, frame, CHANNEL, '555555555555555556', 3);
    await createTaskReplySubscriber(scope, client, discord).handle(
      reply({ referencedMessageId: '555555555555555556', content: 'finished the frame' }),
    );
    expect(taskRepo.listReports(scope, frame)).toMatchObject([
      { body: 'finished the frame', reportId: MESSAGE },
    ]);
    expect(taskRepo.getTask(scope, frame)).toMatchObject({ status: 'in_progress' });
    const followup = taskNudgeRepo.getSlot(scope, `followup:${MESSAGE}`);
    expect(followup).toMatchObject({ kind: 'followup', state: 'pending' });
    expect(JSON.parse(followup?.payload ?? '')).toEqual({
      channelId: CHANNEL,
      messageId: MESSAGE,
    });
  });
  it('replays the same Discord message into exactly one report and one audit row', async () => {
    taskBindingRepo.addMembership(scope, teamId, ACTOR, 'member', ACTOR_OBJ, 3);
    const frame = individualTask('Frame', [ACTOR]);
    taskRepo.recordTaskAnchor(scope, frame, CHANNEL, '555555555555555556', 3);
    const subscriber = createTaskReplySubscriber(scope, client, discord);
    const event = reply({
      referencedMessageId: '555555555555555556',
      content: 'finished the frame',
    });
    await subscriber.handle(event);
    await subscriber.handle(event);
    expect(taskRepo.listReports(scope, frame)).toHaveLength(1);
    expect(
      effectRepo.tailAudit(scope).filter((row) => row.action === 'task.report_recorded'),
    ).toHaveLength(1);
  });
  it('ignores a bare acknowledgement without writing anything', async () => {
    await createTaskReplySubscriber(scope, client, discord).handle(reply({ content: 'ok' }));
    expect(taskRepo.listReports(scope, taskId)).toHaveLength(0);
    expect(scheduledSlots()).toHaveLength(0);
    expect(taskNudgeRepo.getReplyChoice(scope, MESSAGE)).toBeUndefined();
  });
  it('ignores a reply by a non-member', async () => {
    await createTaskReplySubscriber(scope, client, discord).handle(
      reply({ authorId: OTHER, content: 'finished the frame' }),
    );
    expect(taskRepo.listReports(scope, taskId)).toHaveLength(0);
    expect(scheduledSlots()).toHaveLength(0);
    expect(taskNudgeRepo.getReplyChoice(scope, MESSAGE)).toBeUndefined();
  });
  it('records a reply to a pre-due reminder slot on that task', async () => {
    taskBindingRepo.addMembership(scope, teamId, ACTOR, 'member', ACTOR_OBJ, 3);
    const wire = individualTask('Wire', [ACTOR]);
    sentSlot(`pre:${wire}:1000`, { taskId: wire, kind: 'pre_due' }, '777777777777777771');
    await createTaskReplySubscriber(scope, client, discord).handle(
      reply({
        referencedMessageId: '777777777777777771',
        content: 'halfway through the wiring',
      }),
    );
    expect(taskRepo.listReports(scope, wire)).toMatchObject([
      { body: 'halfway through the wiring', reportId: MESSAGE },
    ]);
    expect(taskNudgeRepo.getSlot(scope, `followup:${MESSAGE}`)).toMatchObject({
      kind: 'followup',
    });
  });
  it('records a check-in reply on the one listed task the author owns', async () => {
    taskBindingRepo.addMembership(scope, teamId, ACTOR, 'member', ACTOR_OBJ, 3);
    const one = individualTask('One', [ACTOR]);
    const two = individualTask('Two', [OTHER]);
    sentCheckin('checkin:one', '777777777777777772', [one, two]);
    await createTaskReplySubscriber(scope, client, discord).handle(
      reply({
        referencedMessageId: '777777777777777772',
        content: 'finished the first build',
      }),
    );
    expect(taskRepo.listReports(scope, one)).toHaveLength(1);
    expect(taskRepo.listReports(scope, two)).toHaveLength(0);
    expect(taskNudgeRepo.getReplyChoice(scope, MESSAGE)).toBeUndefined();
    expect(taskNudgeRepo.getSlot(scope, `followup:${MESSAGE}`)).toMatchObject({
      kind: 'followup',
    });
  });
  it('holds a check-in reply matching several tasks for clarification', async () => {
    taskBindingRepo.addMembership(scope, teamId, ACTOR, 'member', ACTOR_OBJ, 3);
    const one = individualTask('One', [ACTOR]);
    const two = individualTask('Two', [ACTOR]);
    sentCheckin('checkin:two', '777777777777777773', [one, two]);
    await createTaskReplySubscriber(scope, client, discord).handle(
      reply({
        referencedMessageId: '777777777777777773',
        content: 'made good progress today',
      }),
    );
    expect(taskRepo.listReports(scope, one)).toHaveLength(0);
    expect(taskRepo.listReports(scope, two)).toHaveLength(0);
    expect(taskNudgeRepo.getReplyChoice(scope, MESSAGE)).toMatchObject({
      authorId: ACTOR,
      channelId: CHANNEL,
      body: 'made good progress today',
    });
    const clarify = taskNudgeRepo.getSlot(scope, `clarify:${MESSAGE}`);
    expect(clarify).toMatchObject({ kind: 'clarify', state: 'pending' });
    const payload = JSON.parse(clarify?.payload ?? '') as {
      replyMessageId: string;
      channelId: string;
      candidates: string[];
    };
    expect(payload.replyMessageId).toBe(MESSAGE);
    expect(payload.channelId).toBe(CHANNEL);
    expect([...payload.candidates].sort()).toEqual([one, two].sort());
  });
  it('refuses a clarification pick pressed by another user', async () => {
    taskBindingRepo.addMembership(scope, teamId, ACTOR, 'member', ACTOR_OBJ, 3);
    const one = individualTask('One', [ACTOR]);
    const two = individualTask('Two', [ACTOR]);
    sentCheckin('checkin:three', '777777777777777774', [one, two]);
    await createTaskReplySubscriber(scope, client, discord).handle(
      reply({
        referencedMessageId: '777777777777777774',
        content: 'made good progress today',
      }),
    );
    await expect(resolveReplyChoice(scope, client, discord, OTHER, MESSAGE, one, 99)).resolves.toBe(
      'not-yours',
    );
    expect(taskRepo.listReports(scope, one)).toHaveLength(0);
    expect(taskNudgeRepo.getReplyChoice(scope, MESSAGE)).toBeDefined();
  });
  it('records the stored body when the author picks a task', async () => {
    taskBindingRepo.addMembership(scope, teamId, ACTOR, 'member', ACTOR_OBJ, 3);
    const one = individualTask('One', [ACTOR]);
    const two = individualTask('Two', [ACTOR]);
    sentCheckin('checkin:four', '777777777777777775', [one, two]);
    await createTaskReplySubscriber(scope, client, discord).handle(
      reply({
        referencedMessageId: '777777777777777775',
        content: 'made good progress today',
      }),
    );
    await expect(resolveReplyChoice(scope, client, discord, ACTOR, MESSAGE, one, 99)).resolves.toBe(
      'recorded',
    );
    expect(taskRepo.listReports(scope, one)).toMatchObject([
      { body: 'made good progress today', reportId: MESSAGE },
    ]);
    expect(taskRepo.listReports(scope, two)).toHaveLength(0);
    expect(taskNudgeRepo.getReplyChoice(scope, MESSAGE)).toBeUndefined();
    const followup = taskNudgeRepo.getSlot(scope, `followup:${MESSAGE}`);
    expect(followup).toMatchObject({ kind: 'followup' });
    expect(JSON.parse(followup?.payload ?? '')).toEqual({
      channelId: CHANNEL,
      messageId: MESSAGE,
    });
  });
  it('ignores a reply to a digest slot', async () => {
    sentSlot('digest:one', { teamId, kind: 'digest' }, '777777777777777776', ANNOUNCE);
    await createTaskReplySubscriber(scope, client, discord).handle(
      reply({
        channelId: ANNOUNCE,
        referencedMessageId: '777777777777777776',
        content: 'finished everything',
      }),
    );
    expect(taskRepo.listReports(scope, taskId)).toHaveLength(0);
    expect(scheduledSlots()).toHaveLength(0);
    expect(taskNudgeRepo.getReplyChoice(scope, MESSAGE)).toBeUndefined();
  });
  it('ignores a reply that references no bot post', async () => {
    await createTaskReplySubscriber(scope, client, discord).handle(
      reply({ referencedMessageId: '888888888888888881', content: 'finished the frame' }),
    );
    expect(taskRepo.listReports(scope, taskId)).toHaveLength(0);
    expect(scheduledSlots()).toHaveLength(0);
    expect(taskNudgeRepo.getReplyChoice(scope, MESSAGE)).toBeUndefined();
  });
  it('records a team-task reply from a member holding only the team role', async () => {
    roleIdsFor[OTHER] = [MEMBER_ROLE];
    liveRoles = [{ id: MEMBER_ROLE }];
    await createTaskReplySubscriber(scope, client, discord).handle(
      reply({ authorId: OTHER, content: 'finished the frame' }),
    );
    expect(taskRepo.listReports(scope, taskId)).toMatchObject([
      { body: 'finished the frame', reportId: MESSAGE },
    ]);
    expect(taskNudgeRepo.getSlot(scope, `followup:${MESSAGE}`)).toMatchObject({
      kind: 'followup',
    });
  });
  it('schedules one evaluate slot alongside the follow-up for a recorded reply', async () => {
    taskBindingRepo.addMembership(scope, teamId, ACTOR, 'member', ACTOR_OBJ, 3);
    const frame = individualTask('Frame', [ACTOR]);
    taskRepo.recordTaskAnchor(scope, frame, CHANNEL, '555555555555555556', 3);
    await createTaskReplySubscriber(scope, client, discord).handle(
      reply({ referencedMessageId: '555555555555555556', content: 'finished the frame' }),
    );
    expect(taskNudgeRepo.getSlot(scope, `followup:${MESSAGE}`)).toMatchObject({
      kind: 'followup',
      state: 'pending',
    });
    const evaluate = taskNudgeRepo.getSlot(scope, `evaluate:${MESSAGE}`);
    expect(evaluate).toMatchObject({ kind: 'evaluate', state: 'pending', taskId: frame });
    expect(JSON.parse(evaluate?.payload ?? '')).toEqual({
      taskId: frame,
      channelId: CHANNEL,
      messageId: MESSAGE,
    });
  });
  it('records a reply to a clarifying question with a follow-up but no new evaluation', async () => {
    taskBindingRepo.addMembership(scope, teamId, ACTOR, 'member', ACTOR_OBJ, 3);
    const frame = individualTask('Frame', [ACTOR]);
    sentSlot(`evaluate:${MESSAGE}`, { taskId: frame, kind: 'evaluate' }, '777777777777777779');
    await createTaskReplySubscriber(scope, client, discord).handle(
      reply({
        referencedMessageId: '777777777777777779',
        messageId: '666666666666666670',
        content: 'i finished the left panel',
      }),
    );
    expect(taskRepo.listReports(scope, frame)).toMatchObject([
      { body: 'i finished the left panel', reportId: '666666666666666670' },
    ]);
    expect(taskNudgeRepo.getSlot(scope, 'followup:666666666666666670')).toMatchObject({
      kind: 'followup',
    });
    expect(taskNudgeRepo.getSlot(scope, 'evaluate:666666666666666670')).toBeUndefined();
  });
  it('replays the same Discord message into exactly one evaluate slot', async () => {
    taskBindingRepo.addMembership(scope, teamId, ACTOR, 'member', ACTOR_OBJ, 3);
    const frame = individualTask('Frame', [ACTOR]);
    taskRepo.recordTaskAnchor(scope, frame, CHANNEL, '555555555555555556', 3);
    const subscriber = createTaskReplySubscriber(scope, client, discord);
    const event = reply({
      referencedMessageId: '555555555555555556',
      content: 'finished the frame',
    });
    await subscriber.handle(event);
    await subscriber.handle(event);
    expect(taskNudgeRepo.listSlots(scope).filter((s) => s.kind === 'evaluate')).toHaveLength(1);
  });
  it('schedules an evaluate slot when the author picks a task', async () => {
    taskBindingRepo.addMembership(scope, teamId, ACTOR, 'member', ACTOR_OBJ, 3);
    const one = individualTask('One', [ACTOR]);
    const two = individualTask('Two', [ACTOR]);
    sentCheckin('checkin:four', '777777777777777775', [one, two]);
    await createTaskReplySubscriber(scope, client, discord).handle(
      reply({
        referencedMessageId: '777777777777777775',
        content: 'made good progress today',
      }),
    );
    await expect(resolveReplyChoice(scope, client, discord, ACTOR, MESSAGE, one, 99)).resolves.toBe(
      'recorded',
    );
    const evaluate = taskNudgeRepo.getSlot(scope, `evaluate:${MESSAGE}`);
    expect(evaluate).toMatchObject({ kind: 'evaluate', taskId: one });
    expect(JSON.parse(evaluate?.payload ?? '')).toEqual({
      taskId: one,
      channelId: CHANNEL,
      messageId: MESSAGE,
    });
  });
});
