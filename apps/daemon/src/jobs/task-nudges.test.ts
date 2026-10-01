import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChannelType, type Client } from 'discord.js';
import {
  parseGuildId,
  parseTaskCustomId,
  TASK_REPLY_NOTICE,
  type DiscordPort,
} from '@bananasaurs/core';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import {
  guildRepo,
  taskRepo,
  taskNudgeRepo,
  taskBindingRepo,
  type GuildScope,
} from '@bananasaurs/storage';
import { deliverTaskNudges, isQuiet, isGuildQuiet, planTaskNudges } from './task-nudges.js';
import type { TaskUpdateEvaluator } from './task-evaluate.js';

let db: MigratedTestDatabase, scope: GuildScope;
const G = parseGuildId('111111111111111111');
const CATEGORY = '333333333333333333',
  CATEGORY2 = '333333333333333334',
  ANNOUNCEMENTS = '444444444444444444',
  CHANNEL = '555555555555555555';
const THREAD = '555555555555555556';
const LOCKED_THREAD = '555555555555555557';
const U1 = '100000000000000001',
  U2 = '100000000000000002';
const LEAD = '200000000000000001',
  MEMBER = '200000000000000002',
  PRESIDENT = '200000000000000003';
const REPLY_MSG = '777777777777777777';
const FOLLOWUP_MSG = '555555555555555555';
let channelMoved = false;
const client = {
  guilds: {
    cache: new Map([
      [
        G,
        {
          channels: {
            fetch: async (id: string) => {
              if (id === CATEGORY || id === CATEGORY2) return { type: ChannelType.GuildCategory };
              if (id === ANNOUNCEMENTS || id === CHANNEL)
                return {
                  type: ChannelType.GuildText,
                  parentId: channelMoved ? '999999999999999999' : CATEGORY,
                  send: (): undefined => undefined,
                };
              if (id === THREAD)
                return {
                  type: ChannelType.PublicThread,
                  archived: true,
                  locked: false,
                  parentId: CHANNEL,
                  send: (): undefined => undefined,
                };
              if (id === LOCKED_THREAD)
                return {
                  type: ChannelType.PublicThread,
                  archived: true,
                  locked: true,
                  parentId: CHANNEL,
                  send: (): undefined => undefined,
                };
              return null;
            },
          },
        },
      ],
    ]),
  },
} as unknown as Client;
let msgSeq = 0;
const send = vi.fn(async (_guild: string, target: string, _message: unknown) => {
  msgSeq += 1;
  return {
    channelId: target,
    messageId: `6666666666666666${String(60 + msgSeq).padStart(2, '0')}`,
  };
});
const react = vi.fn(async () => undefined);
const discord = {
  sendMessage: send,
  fetchMember: async (_guild: string, userId: string) => ({ userId, roleIds: [] }),
  createReaction: react,
} as unknown as DiscordPort;
const monday = Date.parse('2026-09-28T15:00:00Z'); // Monday 08:00 PDT
const tuesday = monday + 24 * 3_600_000;
const ACTOR = { actorType: 'dashboard', actorId: 'owner', via: 'http' } as const;
const MEMBER_ACTOR = { actorType: 'member', actorId: U1, via: 'gateway' } as const;
beforeEach(() => {
  db = openMigratedTestDatabase();
  scope = db.scopes.forGuild(G);
  guildRepo.upsertGuild(scope, { name: 'A', now: 0 });
  channelMoved = false;
  msgSeq = 0;
  send.mockClear();
  react.mockClear();
});
afterEach(() => db.close());

interface SentMessage {
  content?: string;
  allowedMentions?: { parse: readonly string[]; users?: string[]; roles?: string[] };
  components?: {
    type: number;
    components: { type: number; style: number; custom_id: string; label: string }[];
  }[];
  replyTo?: string;
}
const sentMessages = (): { channelId: string; message: SentMessage }[] =>
  send.mock.calls.map((c) => ({ channelId: c[1], message: c[2] as SentMessage }));
const findSend = (prefix: string) =>
  sentMessages().find((s) => s.message.content?.startsWith(prefix));
const slotState = (slotId: string) =>
  taskNudgeRepo.listSlots(scope).find((s) => s.slotId === slotId)?.state;

function seedTeam(input?: {
  name?: string;
  categoryId?: string;
  kind?: 'subteam' | 'exec';
  announcementChannelId?: string;
  leadRoleId?: string;
  memberRoleId?: string;
}) {
  return taskRepo.createTeam(
    scope,
    {
      name: input?.name ?? 'Robotics',
      categoryId: input?.categoryId ?? CATEGORY,
      announcementChannelId: input?.announcementChannelId ?? ANNOUNCEMENTS,
      kind: input?.kind ?? 'subteam',
      ...(input?.leadRoleId ? { leadRoleId: input.leadRoleId } : {}),
      ...(input?.memberRoleId ? { memberRoleId: input.memberRoleId } : {}),
    },
    ACTOR,
    1,
  );
}
function seedTask(
  teamId: string,
  input?: {
    title?: string;
    assignmentKind?: 'team' | 'individual';
    assigneeIds?: string[];
    dueAt?: number;
    timezone?: string;
    destinationId?: string;
  },
) {
  return taskRepo.createTask(
    scope,
    {
      teamId,
      title: input?.title ?? 'Build',
      assignmentKind: input?.assignmentKind ?? 'team',
      ...(input?.assigneeIds ? { assigneeIds: input.assigneeIds } : {}),
      dueAt: input?.dueAt ?? monday + 48 * 3_600_000,
      timezone: input?.timezone ?? 'America/Vancouver',
      destinationId: input?.destinationId ?? CHANNEL,
      createdBy: 'owner',
    },
    ACTOR,
    2,
  );
}
const setMorningQuiet = () =>
  taskRepo.setQuietHours(
    scope,
    { startMinute: 8 * 60, endMinute: 9 * 60, timezone: 'America/Los_Angeles' },
    { actorType: 'mcp_operator', actorId: 'owner', via: 'http' },
    monday,
  );

it('obeys midnight-08:00 Pacific even across daylight saving', () => {
  expect(isQuiet(Date.parse('2026-09-28T14:59:00Z'))).toBe(true);
  expect(isQuiet(monday)).toBe(false);
  expect(isQuiet(Date.parse('2026-12-14T15:59:00Z'))).toBe(true);
  expect(isQuiet(Date.parse('2026-12-14T16:00:00Z'))).toBe(false);
  expect(isQuiet(monday, 9, 17)).toBe(false);
});
it('uses a guild quiet-hours override, leaving the Pacific env default as fallback', () => {
  expect(isGuildQuiet(scope, monday)).toBe(false);
  setMorningQuiet();
  expect(isGuildQuiet(scope, monday)).toBe(true);
  expect(isGuildQuiet(scope, monday + 60 * 60_000)).toBe(false);
});
it('pings individual assignees on a pre-due reminder', async () => {
  const teamId = seedTeam();
  seedTask(teamId, { assignmentKind: 'individual', assigneeIds: [U1, U2] });
  planTaskNudges(scope, monday);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = findSend('Upcoming deadline');
  expect(found?.message.content).toContain(`<@${U1}> <@${U2}>`);
  expect(found?.message.content).toContain(TASK_REPLY_NOTICE);
  expect(found?.message.allowedMentions).toEqual({ parse: [], users: [U1, U2], roles: [] });
});
it('pings the team member role on a team task with a member role', async () => {
  const teamId = seedTeam({ memberRoleId: MEMBER });
  seedTask(teamId, { title: 'Wire' });
  planTaskNudges(scope, monday);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = findSend('Upcoming deadline');
  expect(found?.message.content).toContain(`<@&${MEMBER}>`);
  expect(found?.message.allowedMentions).toEqual({ parse: [], users: [], roles: [MEMBER] });
});
it('sends no mentions for a team task without a member role', async () => {
  const teamId = seedTeam();
  seedTask(teamId, { title: 'Wire' });
  planTaskNudges(scope, monday);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = findSend('Upcoming deadline');
  expect(found?.message.content).not.toContain('<@');
  expect(found?.message.allowedMentions).toEqual({ parse: [], users: [], roles: [] });
});
it('announces a new task, records its anchor, and never re-sends it', async () => {
  const teamId = seedTeam();
  const taskId = seedTask(teamId, { title: 'Build' });
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = findSend('New task:');
  expect(found?.channelId).toBe(CHANNEL);
  expect(found?.message.content).toContain('**Build**');
  expect(found?.message.content).toContain(TASK_REPLY_NOTICE);
  const announceSlot = taskNudgeRepo.listSlots(scope).find((s) => s.kind === 'announce')!;
  expect(announceSlot.messageId).toBeTruthy();
  expect(taskRepo.taskForAnchor(scope, CHANNEL, announceSlot.messageId!)).toBe(taskId);
  const calls = send.mock.calls.length;
  await deliverTaskNudges(scope, client, discord, monday + 1, { enabled: true });
  expect(send.mock.calls.length).toBe(calls);
  expect(slotState(announceSlot.slotId)).toBe('sent');
});
it('settles an announce as planned with no anchor when the send flag is off', async () => {
  const teamId = seedTeam();
  seedTask(teamId, { title: 'Build' });
  await deliverTaskNudges(scope, client, discord, monday);
  expect(send).not.toHaveBeenCalled();
  const announceSlot = taskNudgeRepo.listSlots(scope).find((s) => s.kind === 'announce')!;
  expect(announceSlot.state).toBe('planned');
  expect(announceSlot.messageId).toBeNull();
});
it('posts a review request pinging the subteam lead with approve and send-back buttons', async () => {
  const teamId = seedTeam({ leadRoleId: LEAD });
  const taskId = seedTask(teamId, { title: 'Arm' });
  expect(taskRepo.requestCompletion(scope, taskId, 1, MEMBER_ACTOR, monday)).toBe(true);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = findSend('Ready for review:');
  expect(found?.message.content).toContain(`<@${U1}>`);
  expect(found?.message.content).toContain(`<@&${LEAD}> please review.`);
  expect(found?.message.allowedMentions).toEqual({ parse: [], users: [], roles: [LEAD] });
  const buttons = found?.message.components?.[0]?.components ?? [];
  expect(buttons.map((b) => [b.label, b.type, b.style])).toEqual([
    ['Approve', 2, 3],
    ['Send back', 2, 2],
  ]);
  expect(parseTaskCustomId(buttons[0]?.custom_id ?? '')).toEqual({
    action: 'approve',
    taskId,
    version: 2,
  });
  expect(parseTaskCustomId(buttons[1]?.custom_id ?? '')).toEqual({
    action: 'reject',
    taskId,
    version: 2,
  });
});
it('pings the president role for a review on an exec team', async () => {
  const teamId = seedTeam({ name: 'Exec', kind: 'exec' });
  taskBindingRepo.setPresidentRole(scope, PRESIDENT, ACTOR, monday);
  const taskId = seedTask(teamId, { title: 'Budget' });
  expect(taskRepo.requestCompletion(scope, taskId, 1, MEMBER_ACTOR, monday)).toBe(true);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = findSend('Ready for review:');
  expect(found?.message.content).toContain(`<@&${PRESIDENT}> please review.`);
  expect(found?.message.allowedMentions).toEqual({ parse: [], users: [], roles: [PRESIDENT] });
});
it('supersedes a review when the task is no longer awaiting approval', async () => {
  const teamId = seedTeam({ leadRoleId: LEAD });
  const taskId = seedTask(teamId, { title: 'Arm' });
  expect(taskRepo.requestCompletion(scope, taskId, 1, MEMBER_ACTOR, monday)).toBe(true);
  expect(taskRepo.approveTask(scope, taskId, 2, ACTOR, monday)).toBe(true);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(findSend('Ready for review:')).toBeUndefined();
  expect(slotState(`review:${taskId}:2`)).toBe('superseded');
});
it('groups one destination into a single Monday check-in listing every task', async () => {
  const teamId = seedTeam({ memberRoleId: MEMBER });
  const ids = [
    seedTask(teamId, { title: 'One', dueAt: monday + 10 * 3_600_000 }),
    seedTask(teamId, { title: 'Two', dueAt: monday + 11 * 3_600_000 }),
    seedTask(teamId, { title: 'Three', dueAt: monday + 12 * 3_600_000 }),
  ];
  planTaskNudges(scope, monday);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const checkins = sentMessages().filter((s) => s.message.content?.startsWith('Weekly check-in'));
  expect(checkins).toHaveLength(1);
  expect(checkins[0]?.message.content).toContain('**One**');
  expect(checkins[0]?.message.content).toContain('**Two**');
  expect(checkins[0]?.message.content).toContain('**Three**');
  expect(checkins[0]?.message.content).toContain(TASK_REPLY_NOTICE);
  const slot = taskNudgeRepo.listSlots(scope).find((s) => s.kind === 'checkin')!;
  expect(taskNudgeRepo.listSlotTasks(scope, slot.slotId).sort()).toEqual([...ids].sort());
});
it('creates no check-in slot on a Tuesday', () => {
  const teamId = seedTeam();
  seedTask(teamId, { dueAt: tuesday + 48 * 3_600_000 });
  planTaskNudges(scope, tuesday);
  expect(taskNudgeRepo.listSlots(scope).filter((s) => s.kind === 'checkin')).toHaveLength(0);
  expect(taskNudgeRepo.listSlots(scope).filter((s) => s.kind === 'digest')).toHaveLength(0);
});
it('sends an exec team with an announcement channel its weekly digest', async () => {
  const teamId = seedTeam({ name: 'Exec', kind: 'exec' });
  seedTask(teamId, { title: 'Budget', dueAt: monday + 10 * 3_600_000 });
  planTaskNudges(scope, monday);
  expect(
    taskNudgeRepo
      .listSlots(scope)
      .filter((s) => s.kind === 'digest')
      .map((s) => s.teamId),
  ).toContain(teamId);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = sentMessages().find((s) => s.message.content?.startsWith('Weekly Exec digest'));
  expect(found?.channelId).toBe(ANNOUNCEMENTS);
  expect(found?.message.content).toContain('**Budget**');
  expect(found?.message.content).toContain('Not started');
});
it('holds a due pre-due through quiet hours while a review still sends', async () => {
  const teamId = seedTeam();
  const taskId = seedTask(teamId, { assignmentKind: 'individual', assigneeIds: [U1] });
  planTaskNudges(scope, monday);
  expect(taskRepo.requestCompletion(scope, taskId, 1, MEMBER_ACTOR, monday)).toBe(true);
  setMorningQuiet();
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(findSend('Ready for review:')).toBeDefined();
  const pre = taskNudgeRepo.listSlots(scope).find((s) => s.kind === 'pre_due')!;
  expect(pre.state).toBe('pending');
  expect(taskNudgeRepo.listDeliveries(scope).filter((d) => d.slotId === pre.slotId)).toHaveLength(
    0,
  );
});
it('pauses a locked thread destination without sending', async () => {
  const teamId = seedTeam();
  seedTask(teamId, { title: 'Threaded', destinationId: LOCKED_THREAD });
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(send).not.toHaveBeenCalled();
  const announceSlot = taskNudgeRepo.listSlots(scope).find((s) => s.kind === 'announce')!;
  expect(announceSlot.state).toBe('paused');
});
it('sends to an archived-but-unlocked thread: Discord unarchives on send', async () => {
  const teamId = seedTeam();
  seedTask(teamId, { title: 'Threaded', destinationId: THREAD });
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(findSend('New task:')).toBeDefined();
  const announceSlot = taskNudgeRepo.listSlots(scope).find((s) => s.kind === 'announce')!;
  expect(announceSlot.state).toBe('sent');
});
it('reacts with a check mark on a follow-up instead of sending', async () => {
  taskNudgeRepo.schedule(
    scope,
    {
      slotId: `followup:${FOLLOWUP_MSG}`,
      kind: 'followup',
      dueAt: monday,
      payload: JSON.stringify({ channelId: CHANNEL, messageId: FOLLOWUP_MSG }),
    },
    monday,
  );
  const processed = await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(processed).toBe(1);
  expect(send).not.toHaveBeenCalled();
  expect(react).toHaveBeenCalledTimes(1);
  expect(react.mock.calls[0]).toEqual([
    G,
    { channelId: CHANNEL, messageId: FOLLOWUP_MSG },
    'u:2705',
  ]);
  const slot = taskNudgeRepo.listSlots(scope).find((s) => s.kind === 'followup')!;
  expect(slot.state).toBe('sent');
  expect(slot.destinationId).toBe(CHANNEL);
});
it('supersedes a follow-up with no payload', async () => {
  taskNudgeRepo.schedule(
    scope,
    { slotId: 'followup:stale', kind: 'followup', dueAt: monday },
    monday,
  );
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(send).not.toHaveBeenCalled();
  expect(react).not.toHaveBeenCalled();
  expect(slotState('followup:stale')).toBe('superseded');
});
it('replies to the member message with pick buttons for a clarification', async () => {
  const teamId = seedTeam();
  const t1 = seedTask(teamId, { title: 'Alpha' });
  const t2 = seedTask(teamId, { title: 'Beta' });
  taskNudgeRepo.schedule(
    scope,
    {
      slotId: `clarify:${REPLY_MSG}`,
      kind: 'clarify',
      dueAt: monday,
      payload: JSON.stringify({
        replyMessageId: REPLY_MSG,
        channelId: CHANNEL,
        candidates: [t1, t2],
      }),
    },
    monday,
  );
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const clarifyCall = send.mock.calls.find((c) =>
    (c[2] as SentMessage).content?.startsWith('Which task is this update for?'),
  );
  expect(clarifyCall).toBeDefined();
  const [guildId, channelId, message] = clarifyCall as [string, string, SentMessage];
  expect(guildId).toBe(G);
  expect(channelId).toBe(CHANNEL);
  expect(message.content).toBe('Which task is this update for?');
  expect(message.replyTo).toBe(REPLY_MSG);
  expect(message.components).toHaveLength(1);
  const buttons = message.components?.[0]?.components ?? [];
  expect(buttons).toHaveLength(2);
  expect(buttons.map((b) => b.style)).toEqual([1, 1]);
  expect(parseTaskCustomId(buttons[0]?.custom_id ?? '')).toEqual({
    action: 'pick',
    choiceMessageId: REPLY_MSG,
    taskId: t1,
  });
  expect(parseTaskCustomId(buttons[1]?.custom_id ?? '')).toEqual({
    action: 'pick',
    choiceMessageId: REPLY_MSG,
    taskId: t2,
  });
});
it('supersedes a clarification when fewer than two candidates stay open', async () => {
  const teamId = seedTeam();
  const t1 = seedTask(teamId, { title: 'Alpha' });
  taskNudgeRepo.schedule(
    scope,
    {
      slotId: `clarify:${REPLY_MSG}`,
      kind: 'clarify',
      dueAt: monday,
      payload: JSON.stringify({
        replyMessageId: REPLY_MSG,
        channelId: CHANNEL,
        candidates: [t1, '00000000-0000-0000-0000-000000000000'],
      }),
    },
    monday,
  );
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(findSend('Which task is this update for?')).toBeUndefined();
  expect(slotState(`clarify:${REPLY_MSG}`)).toBe('superseded');
});
it('falls back to an ISO due label when the stored timezone is invalid', async () => {
  const teamId = seedTeam();
  seedTask(teamId, { title: 'Odd zone', timezone: 'Nope/Zone' });
  planTaskNudges(scope, monday);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = findSend('Upcoming deadline');
  expect(found?.message.content).toContain('2026-09-30 15:00 UTC');
});
it('creates durable 48h, weekly, and team digest slots; planning records without sending', async () => {
  const teamId = seedTeam();
  expect(teamId).toBeTruthy();
  seedTask(teamId, { title: '@everyone Build' });
  planTaskNudges(scope, monday);
  planTaskNudges(scope, monday);
  expect(
    taskNudgeRepo
      .listSlots(scope)
      .map((s) => s.kind)
      .sort(),
    // createTask inserts one announce slot alongside the planned pre_due/checkin/digest slots.
  ).toEqual(['announce', 'checkin', 'digest', 'pre_due']);
  expect(await deliverTaskNudges(scope, client, discord, monday)).toBe(4);
  expect(send).not.toHaveBeenCalled();
  expect(taskNudgeRepo.listDeliveries(scope).map((d) => d.outcome)).toEqual([
    'planned',
    'planned',
    'planned',
    'planned',
  ]);
  expect(await deliverTaskNudges(scope, client, discord, monday, { enabled: true })).toBe(0);
});
it('pauses a moved destination with an audit row, no send', async () => {
  const teamId = seedTeam();
  expect(teamId).toBeTruthy();
  seedTask(teamId, { title: '@everyone Build' });
  planTaskNudges(scope, monday);
  channelMoved = true;
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(send).not.toHaveBeenCalled();
  expect(taskNudgeRepo.listDeliveries(scope).every((d) => d.outcome === 'paused')).toBe(true);
});

function seedEvaluateWorld(reportId = REPLY_MSG) {
  const teamId = seedTeam();
  const taskId = seedTask(teamId, { title: 'Build' });
  // createTask's own announce slot is not under test: park it as planned.
  for (const slot of taskNudgeRepo.listSlots(scope)) {
    if (slot.kind === 'announce') {
      taskNudgeRepo.claim(scope, slot.slotId, monday);
      taskNudgeRepo.settle(scope, slot.slotId, 'planned', monday, CHANNEL);
    }
  }
  expect(
    taskRepo.recordReport(scope, taskId, reportId, U1, 'wiring is half done', MEMBER_ACTOR, monday),
  ).toBe('recorded');
  taskNudgeRepo.schedule(
    scope,
    {
      slotId: `evaluate:${reportId}`,
      kind: 'evaluate',
      taskId,
      dueAt: monday,
      payload: JSON.stringify({ taskId, channelId: CHANNEL, messageId: reportId }),
    },
    monday,
  );
  return taskId;
}
const clearEval: TaskUpdateEvaluator = async () => ({ ok: true, clear: true });
const unclearEval: TaskUpdateEvaluator = async () => ({
  ok: true,
  clear: false,
  question: 'What did you finish?',
});
const failingEval: TaskUpdateEvaluator = async () => ({ ok: false, reason: 'no-model' });

it('evaluates nothing when sends are off: no model call, slot planned', async () => {
  seedEvaluateWorld();
  const evaluate = vi.fn(async () => ({ ok: true as const, clear: true as const }));
  await deliverTaskNudges(scope, client, discord, monday, { evaluate });
  expect(evaluate).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(slotState(`evaluate:${REPLY_MSG}`)).toBe('planned');
});
it('posts nothing when the update is clear', async () => {
  seedEvaluateWorld();
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true, evaluate: clearEval });
  expect(send).not.toHaveBeenCalled();
  expect(slotState(`evaluate:${REPLY_MSG}`)).toBe('superseded');
});
it('replies once with the question and the notice when the update is unclear', async () => {
  seedEvaluateWorld();
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true, evaluate: unclearEval });
  expect(send).toHaveBeenCalledTimes(1);
  const [, channelId, message] = send.mock.calls[0] as [string, string, SentMessage];
  expect(channelId).toBe(CHANNEL);
  expect(message.content).toBe(`What did you finish?\n\n${TASK_REPLY_NOTICE}`);
  expect(message.replyTo).toBe(REPLY_MSG);
  expect(message.allowedMentions).toEqual({ parse: [] });
  expect(slotState(`evaluate:${REPLY_MSG}`)).toBe('sent');
});
it('posts nothing when the evaluator fails', async () => {
  seedEvaluateWorld();
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true, evaluate: failingEval });
  expect(send).not.toHaveBeenCalled();
  expect(slotState(`evaluate:${REPLY_MSG}`)).toBe('superseded');
});
it('supersedes an evaluation whose report is gone', async () => {
  const teamId = seedTeam();
  const taskId = seedTask(teamId, { title: 'Build' });
  for (const slot of taskNudgeRepo.listSlots(scope)) {
    if (slot.kind === 'announce') {
      taskNudgeRepo.claim(scope, slot.slotId, monday);
      taskNudgeRepo.settle(scope, slot.slotId, 'planned', monday, CHANNEL);
    }
  }
  taskNudgeRepo.schedule(
    scope,
    {
      slotId: 'evaluate:888888888888888888',
      kind: 'evaluate',
      taskId,
      dueAt: monday,
      payload: JSON.stringify({ taskId, channelId: CHANNEL, messageId: '888888888888888888' }),
    },
    monday,
  );
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true, evaluate: unclearEval });
  expect(send).not.toHaveBeenCalled();
  expect(slotState('evaluate:888888888888888888')).toBe('superseded');
});
it('sends the unclear question exactly once when the slot is claimed twice', async () => {
  seedEvaluateWorld();
  const options = { enabled: true, evaluate: unclearEval };
  await deliverTaskNudges(scope, client, discord, monday, options);
  await deliverTaskNudges(scope, client, discord, monday + 1, options);
  expect(send).toHaveBeenCalledTimes(1);
  expect(slotState(`evaluate:${REPLY_MSG}`)).toBe('sent');
});
it('delivers an event kind during quiet hours past a full page of held slots', async () => {
  const teamId = seedTeam({ leadRoleId: LEAD });
  const taskId = seedTask(teamId, { title: 'Arm' });
  expect(taskRepo.requestCompletion(scope, taskId, 1, MEMBER_ACTOR, monday)).toBe(true);
  for (let i = 0; i < 45; i += 1)
    taskNudgeRepo.schedule(
      scope,
      { slotId: `custom:held:${i}`, kind: 'custom', dueAt: monday },
      monday,
    );
  setMorningQuiet();
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(findSend('Ready for review:')).toBeDefined();
  expect(
    taskNudgeRepo.listSlots(scope).filter((s) => s.kind === 'custom' && s.state === 'pending'),
  ).toHaveLength(45);
});
it('skips the pre-due slot for a task created less than 48h before due', () => {
  const teamId = seedTeam();
  taskRepo.createTask(
    scope,
    {
      teamId,
      title: 'Rush',
      assignmentKind: 'team',
      dueAt: monday + 24 * 3_600_000,
      timezone: 'America/Vancouver',
      destinationId: CHANNEL,
      createdBy: 'owner',
    },
    ACTOR,
    monday,
  );
  planTaskNudges(scope, monday);
  expect(taskNudgeRepo.listSlots(scope).filter((s) => s.kind === 'pre_due')).toHaveLength(0);
});
it('names the owner when the review was requested by a non-member actor', async () => {
  const teamId = seedTeam({ leadRoleId: LEAD });
  const taskId = seedTask(teamId, { title: 'Arm' });
  expect(taskRepo.requestCompletion(scope, taskId, 1, ACTOR, monday)).toBe(true);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = findSend('Ready for review:');
  expect(found?.message.content).toContain('marked complete by the owner.');
  expect(found?.message.content).not.toContain('<@owner>');
});
it('isolates a throwing slot and still sends the next one', async () => {
  const teamId = seedTeam();
  for (const [title, reportId, dueAt] of [
    ['One', '777777777777777771', monday],
    ['Two', '777777777777777772', monday + 1],
  ] as const) {
    const taskId = seedTask(teamId, { title });
    expect(
      taskRepo.recordReport(scope, taskId, reportId, U1, 'half done here', MEMBER_ACTOR, monday),
    ).toBe('recorded');
    taskNudgeRepo.schedule(
      scope,
      {
        slotId: `evaluate:${reportId}`,
        kind: 'evaluate',
        taskId,
        dueAt,
        payload: JSON.stringify({ taskId, channelId: CHANNEL, messageId: reportId }),
      },
      monday,
    );
  }
  for (const slot of taskNudgeRepo.listSlots(scope)) {
    if (slot.kind === 'announce') {
      taskNudgeRepo.claim(scope, slot.slotId, monday);
      taskNudgeRepo.settle(scope, slot.slotId, 'planned', monday, CHANNEL);
    }
  }
  send.mockRejectedValueOnce(new Error('discord 500'));
  await deliverTaskNudges(scope, client, discord, monday + 1, {
    enabled: true,
    evaluate: unclearEval,
  });
  expect(send).toHaveBeenCalledTimes(2);
  expect(
    taskNudgeRepo
      .listSlots(scope)
      .filter((s) => s.kind === 'evaluate')
      .map((s) => s.state)
      .sort(),
  ).toEqual(['failed', 'sent']);
});
