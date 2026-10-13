import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChannelType, type Client } from 'discord.js';
import { parseGuildId, parseTaskCustomId, type DiscordPort, type Logger } from '@bananasaurs/core';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import {
  guildRepo,
  loggingRepo,
  mcpSendRepo,
  taskRepo,
  taskNudgeRepo,
  taskBindingRepo,
  type GuildScope,
} from '@bananasaurs/storage';
import { deliverTaskNudges, isQuiet, isGuildQuiet, planTaskNudges } from './task-nudges.js';
import { scheduleUpdatePost } from './task-update-slot.js';
import type { TaskUpdateEvaluator } from './task-evaluate.js';
import { refreshTaskCards } from './task-cards.js';

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
/**
 * Channel-permissions Write checks resolve through the client-level channel
 * cache (`resolveChannel`), not the guild fetch stub below — so the fixture
 * mirrors the same channels at client level with the shapes the resolver
 * reads (`guildId`, `isThread()`, `parent`, `isTextBased()`, `isDMBased()`).
 */
const clientChannelShape = (id: string): Record<string, unknown> | null => {
  if (id === CATEGORY || id === CATEGORY2)
    return {
      id,
      guildId: G,
      type: ChannelType.GuildCategory,
      parentId: null,
      parent: null,
      isThread: () => false,
      isTextBased: () => false,
      isDMBased: () => false,
    };
  if (id === ANNOUNCEMENTS || id === CHANNEL)
    return {
      id,
      guildId: G,
      type: ChannelType.GuildText,
      parentId: channelMoved ? '999999999999999999' : CATEGORY,
      parent: null,
      isThread: () => false,
      isTextBased: () => true,
      isDMBased: () => false,
    };
  if (id === THREAD || id === LOCKED_THREAD)
    return {
      id,
      guildId: G,
      type: ChannelType.PublicThread,
      parentId: CHANNEL,
      parent: clientChannelShape(CHANNEL),
      isThread: () => true,
      isTextBased: () => true,
      isDMBased: () => false,
    };
  return null;
};
const client = {
  channels: {
    cache: new Map(),
    fetch: async (id: string) => clientChannelShape(id),
  },
  guilds: {
    cache: new Map([
      [
        G,
        {
          // N1: the cached guild reads available, so the pass runs; a pass
          // with no cached guild returns before claiming any slot.
          available: true,
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
  // Channel permissions: every destination in this file lives under CATEGORY,
  // so the shared fixture grants Write there — the nudge gate keeps its
  // meaning and only the denial tests below remove it.
  mcpSendRepo.allowChannel(scope, {
    channelId: CATEGORY,
    scopeKind: 'category',
    addedByAccountId: 'acct_test',
    now: 1,
  });
  channelMoved = false;
  msgSeq = 0;
  send.mockClear();
  react.mockClear();
});
afterEach(() => db.close());

interface SentMessage {
  content?: string;
  flags?: number;
  files?: { name: string }[];
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
  sentMessages().find(
    (s) =>
      cardText(s.message).includes(prefix) &&
      (prefix !== 'WAITING FOR REVIEW' || cardText(s.message).includes('Marked done by')),
  );
const cardText = (m: SentMessage): string => JSON.stringify(m.components ?? []);
const cardButtons = (
  m: SentMessage,
): { type: number; style: number; custom_id: string; label: string }[] => {
  const walk = (
    value: unknown,
  ): { type: number; style: number; custom_id: string; label: string }[] => {
    if (Array.isArray(value)) return value.flatMap(walk);
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (obj['type'] === 2)
        return [obj as { type: number; style: number; custom_id: string; label: string }];
      return Object.values(obj).flatMap(walk);
    }
    return [];
  };
  return walk(m.components);
};
const findAnnounce = () =>
  sentMessages().find((s) => s.message.flags === 32768 && cardText(s.message).includes('NEW TASK'));
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
  const found = findSend('DUE SOON');
  expect(cardText(found?.message ?? {})).toContain(`<@${U1}> <@${U2}>`);
  expect(found?.message.flags).toBe(32768);
  expect(found?.message.files?.map((f) => f.name)).toContain('saur-thumb.png');
  expect(found?.message.allowedMentions).toEqual({ parse: [], users: [U1, U2] });
});
it('pings the team member role on a team task with a member role', async () => {
  const teamId = seedTeam({ memberRoleId: MEMBER });
  seedTask(teamId, { title: 'Wire' });
  planTaskNudges(scope, monday);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = findSend('DUE SOON');
  expect(cardText(found?.message ?? {})).toContain(`<@&${MEMBER}>`);
  expect(found?.message.allowedMentions).toEqual({ parse: [], roles: [MEMBER] });
});
it('sends no mentions for a team task without a member role', async () => {
  const teamId = seedTeam();
  seedTask(teamId, { title: 'Wire' });
  planTaskNudges(scope, monday);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = findSend('DUE SOON');
  expect(cardText(found?.message ?? {})).not.toContain('<@');
  expect(found?.message.allowedMentions).toEqual({ parse: [] });
});
it('announces a new task, records its anchor, and never re-sends it', async () => {
  const teamId = seedTeam();
  const taskId = seedTask(teamId, { title: 'Build' });
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = findAnnounce();
  expect(found?.channelId).toBe(CHANNEL);
  expect(found?.message.flags).toBe(32768);
  expect(found?.message.files?.map((f) => f.name)).toContain('saur-thumb.png');
  expect(cardText(found!.message)).toContain('NEW TASK');
  expect(cardText(found!.message)).toContain('Build');
  const announceSlot = taskNudgeRepo.listSlots(scope).find((s) => s.kind === 'announce')!;
  expect(announceSlot.messageId).toBeTruthy();
  expect(taskRepo.taskForAnchor(scope, CHANNEL, announceSlot.messageId!)).toBe(taskId);
  const calls = send.mock.calls.length;
  await deliverTaskNudges(scope, client, discord, monday + 1, { enabled: true });
  expect(send.mock.calls.length).toBe(calls);
  expect(slotState(announceSlot.slotId)).toBe('sent');
});
it('marks a newly announced card as rendered at the current version, so the next refresh pass edits nothing', async () => {
  const teamId = seedTeam();
  const taskId = seedTask(teamId, { title: 'Build' });
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(findAnnounce()).toBeDefined();
  const version = taskRepo.getTask(scope, taskId)!.version;
  const row = db.raw
    .prepare('SELECT rendered_version AS v FROM task_message_anchors WHERE task_id = ?')
    .get(taskId) as { v: number };
  expect(row.v).toBe(version);
  expect(taskRepo.staleTaskCards(scope, 10)).toEqual([]);
  const edit = vi.fn(async () => undefined);
  const refreshDiscord = { editMessage: edit } as unknown as DiscordPort;
  expect(await refreshTaskCards(scope, refreshDiscord, monday + 1000, { enabled: true })).toBe(0);
  expect(edit).not.toHaveBeenCalled();
});
it('announces to the member role of a team task', async () => {
  const teamId = seedTeam({ memberRoleId: MEMBER });
  seedTask(teamId, { title: 'Wire' });
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(findAnnounce()?.message.allowedMentions).toEqual({ parse: [], roles: [MEMBER] });
});
it('announces to the assignees of an individual task', async () => {
  const teamId = seedTeam();
  seedTask(teamId, { title: 'Edit', assignmentKind: 'individual', assigneeIds: [U1, U2] });
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(findAnnounce()?.message.allowedMentions).toEqual({ parse: [], users: [U1, U2] });
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
  const found = findSend('WAITING FOR REVIEW');
  expect(cardText(found?.message ?? {})).toContain(`<@${U1}>`);
  expect(cardText(found?.message ?? {})).toContain(`<@&${LEAD}> review this task`);
  expect(found?.message.allowedMentions).toEqual({ parse: [], roles: [LEAD] });
  const buttons = cardButtons(found?.message ?? {});
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
  const found = findSend('WAITING FOR REVIEW');
  expect(cardText(found?.message ?? {})).toContain(`<@&${PRESIDENT}> review this task`);
  expect(found?.message.allowedMentions).toEqual({ parse: [], roles: [PRESIDENT] });
});
it('supersedes a review when the task is no longer awaiting approval', async () => {
  const teamId = seedTeam({ leadRoleId: LEAD });
  const taskId = seedTask(teamId, { title: 'Arm' });
  expect(taskRepo.requestCompletion(scope, taskId, 1, MEMBER_ACTOR, monday)).toBe(true);
  expect(taskRepo.approveTask(scope, taskId, 2, ACTOR, monday)).toBe(true);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(findSend('WAITING FOR REVIEW')).toBeUndefined();
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
  const checkins = sentMessages().filter((s) => cardText(s.message).includes('WEEKLY CHECK-IN'));
  expect(checkins).toHaveLength(1);
  expect(cardText(checkins[0]?.message ?? {})).toContain('**One**');
  expect(cardText(checkins[0]?.message ?? {})).toContain('**Two**');
  expect(cardText(checkins[0]?.message ?? {})).toContain('**Three**');
  expect(checkins[0]?.message.flags).toBe(32768);
  expect(checkins[0]?.message.files?.map((f) => f.name)).toContain('saur-thumb.png');
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
  const found = sentMessages().find((s) => cardText(s.message).includes('WEEKLY DIGEST'));
  expect(found?.channelId).toBe(ANNOUNCEMENTS);
  expect(cardText(found?.message ?? {})).toContain('Budget');
  expect(cardText(found?.message ?? {})).toContain('Due this week');
  expect(found?.message.flags).toBe(32768);
  expect(found?.message.files?.map((f) => f.name)).toContain('banner-digest.png');
  expect(found?.message.allowedMentions).toEqual({ parse: [] });
});
it('holds a due pre-due through quiet hours while a review still sends', async () => {
  const teamId = seedTeam();
  const taskId = seedTask(teamId, { assignmentKind: 'individual', assigneeIds: [U1] });
  planTaskNudges(scope, monday);
  expect(taskRepo.requestCompletion(scope, taskId, 1, MEMBER_ACTOR, monday)).toBe(true);
  setMorningQuiet();
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(findSend('WAITING FOR REVIEW')).toBeDefined();
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
  expect(findAnnounce()).toBeDefined();
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
it('pauses a follow-up whose channel lost Write instead of reacting', async () => {
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
  mcpSendRepo.disallowChannel(scope, CATEGORY, 'category');
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(react).not.toHaveBeenCalled();
  const slot = taskNudgeRepo.listSlots(scope).find((s) => s.kind === 'followup')!;
  expect(slot.state).toBe('paused');
  expect(slot.lastError).toBe('writing is turned off for that channel');
});
it('pauses a follow-up whose channel is gone as unavailable, not as Write off (N9)', async () => {
  const GONE = '299999999999999999';
  taskNudgeRepo.schedule(
    scope,
    {
      slotId: `followup:${FOLLOWUP_MSG}`,
      kind: 'followup',
      dueAt: monday,
      payload: JSON.stringify({ channelId: GONE, messageId: FOLLOWUP_MSG }),
    },
    monday,
  );
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(react).not.toHaveBeenCalled();
  const slot = taskNudgeRepo.listSlots(scope).find((s) => s.kind === 'followup')!;
  expect(slot.state).toBe('paused');
  expect(slot.lastError).toBe('destination missing, moved, or unavailable');
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
    cardText(c[2] as SentMessage).includes('Which task is this update for?'),
  );
  expect(clarifyCall).toBeDefined();
  const [guildId, channelId, message] = clarifyCall as [string, string, SentMessage];
  expect(guildId).toBe(G);
  expect(channelId).toBe(CHANNEL);
  expect(message.flags).toBe(32768);
  expect(cardText(message)).toContain('Which task is this update for?');
  expect(message.files).toBeUndefined();
  expect(message.allowedMentions).toEqual({ parse: [] });
  expect(message.replyTo).toBe(REPLY_MSG);
  expect(message.components).toHaveLength(1);
  const buttons = cardButtons(message);
  expect(buttons).toHaveLength(2);
  expect(buttons.map((b) => b.style)).toEqual([2, 2]);
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
it('uses Discord timestamps regardless of the stored timezone', async () => {
  const teamId = seedTeam();
  seedTask(teamId, { title: 'Odd zone', timezone: 'Nope/Zone' });
  planTaskNudges(scope, monday);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = findSend('DUE SOON');
  expect(cardText(found?.message ?? {})).toContain(
    `<t:${Math.floor((monday + 48 * 3_600_000) / 1000)}:f>`,
  );
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
it('pauses a nudge whose destination channel has no Write grant', async () => {
  mcpSendRepo.disallowChannel(scope, CATEGORY, 'category');
  const teamId = seedTeam();
  seedTask(teamId, { title: 'Build' });
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(send).not.toHaveBeenCalled();
  const announceSlot = taskNudgeRepo.listSlots(scope).find((s) => s.kind === 'announce')!;
  expect(announceSlot.state).toBe('paused');
});
it('a Write denial pauses as write-denied with the channel log line, not as unavailable', async () => {
  const infos: Array<{ fields: unknown; msg: string }> = [];
  const logger = {
    info: (fields: unknown, msg: string): void => {
      infos.push({ fields, msg });
    },
  } as unknown as Logger;
  mcpSendRepo.disallowChannel(scope, CATEGORY, 'category');
  const teamId = seedTeam();
  seedTask(teamId, { title: 'Build' });
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true, logger });
  expect(send).not.toHaveBeenCalled();
  const announceSlot = taskNudgeRepo.listSlots(scope).find((s) => s.kind === 'announce')!;
  expect(announceSlot.state).toBe('paused');
  expect(announceSlot.lastError).toBe('writing is turned off for that channel');
  expect(infos).toHaveLength(1);
  expect(infos[0]?.fields).toMatchObject({
    guildId: G,
    channelId: CHANNEL,
    purpose: 'write',
    reason: 'not-granted',
  });
});
it('posts nothing for a nudge under a No access category', async () => {
  loggingRepo.excludeChannel(scope, CATEGORY);
  const teamId = seedTeam();
  seedTask(teamId, { title: 'Build' });
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(send).not.toHaveBeenCalled();
  const announceSlot = taskNudgeRepo.listSlots(scope).find((s) => s.kind === 'announce')!;
  expect(announceSlot.state).toBe('paused');
  // N9: No access names itself, not "writing is turned off".
  expect(announceSlot.lastError).toBe('this channel is marked No access');
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
  for (const slot of taskNudgeRepo.listSlots(scope))
    if (slot.state === 'paused')
      expect(slot.lastError).toBe('destination missing, moved, or unavailable');
});
it('a nudge pass with no cached guild claims nothing (N1)', async () => {
  const teamId = seedTeam();
  seedTask(teamId, { title: 'Build' });
  planTaskNudges(scope, monday);
  const uncached = { ...client, guilds: { cache: new Map() } } as unknown as Client;

  expect(await deliverTaskNudges(scope, uncached, discord, monday, { enabled: true })).toBe(0);

  expect(send).not.toHaveBeenCalled();
  expect(react).not.toHaveBeenCalled();
  for (const slot of taskNudgeRepo.listSlots(scope)) expect(slot.state).toBe('pending');
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
it('replies once with the question card when the update is unclear', async () => {
  seedEvaluateWorld();
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true, evaluate: unclearEval });
  expect(send).toHaveBeenCalledTimes(1);
  const [, channelId, message] = send.mock.calls[0] as [string, string, SentMessage];
  expect(channelId).toBe(CHANNEL);
  expect(message.flags).toBe(32768);
  expect(cardText(message)).toContain('QUICK QUESTION');
  expect(cardText(message)).toContain('What did you finish?');
  expect(message.files).toBeUndefined();
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
  expect(findSend('WAITING FOR REVIEW')).toBeDefined();
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
it('names a non-member review requester as an organiser', async () => {
  const teamId = seedTeam({ leadRoleId: LEAD });
  const taskId = seedTask(teamId, { title: 'Arm' });
  expect(taskRepo.requestCompletion(scope, taskId, 1, ACTOR, monday)).toBe(true);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = findSend('WAITING FOR REVIEW');
  expect(cardText(found?.message ?? {})).toContain('Marked done by an organiser');
  expect(cardText(found?.message ?? {})).not.toContain('<@owner>');
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

const seedUpdate = (reportId = 'modal:900000000000000001') => {
  const id = seedTask(seedTeam());
  taskRepo.recordTaskAnchor(scope, id, CHANNEL, REPLY_MSG, monday);
  taskRepo.recordReport(scope, id, reportId, U1, 'Left side done', MEMBER_ACTOR, monday);
  scheduleUpdatePost(scope, id, reportId, monday);
  return id;
};
it('posts an update card replying to the task anchor and evaluates the report against the new card', async () => {
  const reportId = 'modal:900000000000000001';
  const taskId = seedUpdate(reportId);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const updates = sentMessages().filter((s) => cardText(s.message).includes('UPDATE'));
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({
    channelId: CHANNEL,
    message: {
      flags: 32768,
      replyTo: REPLY_MSG,
      allowedMentions: { parse: [] },
    },
  });
  expect(cardText(updates[0]!.message)).toContain('Left side done');
  const slot = taskNudgeRepo.listSlots(scope).find((s) => s.slotId === `update:${reportId}`)!;
  expect(slot.state).toBe('sent');
  const evaluate = taskNudgeRepo
    .listSlots(scope)
    .find((s) => s.slotId === `evaluate:${slot.messageId}`)!;
  expect(JSON.parse(evaluate.payload!)).toEqual({
    taskId,
    channelId: CHANNEL,
    messageId: slot.messageId,
    reportId,
  });
});
it('posts MCP updates without scheduling evaluation', async () => {
  seedUpdate('mcp:00000000-0000-4000-8000-000000000001');
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(sentMessages().filter((s) => cardText(s.message).includes('UPDATE'))).toHaveLength(1);
  expect(taskNudgeRepo.listSlots(scope).filter((s) => s.kind === 'evaluate')).toEqual([]);
});
it('settles update posts as planned without sending in planning mode', async () => {
  seedUpdate();
  await deliverTaskNudges(scope, client, discord, monday, { enabled: false });
  expect(send).not.toHaveBeenCalled();
  expect(slotState('update:modal:900000000000000001')).toBe('planned');
});
it('supersedes update slots whose report is gone', async () => {
  const id = seedTask(seedTeam());
  expect(
    taskRepo.recordReport(scope, id, 'modal:gone', U1, 'Deleted update', MEMBER_ACTOR, monday),
  ).toBe('recorded');
  scheduleUpdatePost(scope, id, 'modal:gone', monday);
  expect(taskRepo.deleteReport(scope, id, 'modal:gone', ACTOR, monday)).toBe('ok');
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(slotState('update:modal:gone')).toBe('superseded');
  expect(sentMessages().filter((s) => cardText(s.message).includes('UPDATE'))).toEqual([]);
});
it('evaluate finds the modal report by reportId rather than the update card message id', async () => {
  const id = seedTask(seedTeam());
  taskRepo.recordReport(
    scope,
    id,
    'modal:900000000000000001',
    U1,
    'Left side done',
    MEMBER_ACTOR,
    monday,
  );
  taskNudgeRepo.schedule(
    scope,
    {
      slotId: `evaluate:${REPLY_MSG}`,
      kind: 'evaluate',
      taskId: id,
      dueAt: monday,
      payload: JSON.stringify({
        taskId: id,
        channelId: CHANNEL,
        messageId: REPLY_MSG,
        reportId: 'modal:900000000000000001',
      }),
    },
    monday,
  );
  const evaluate = vi.fn<TaskUpdateEvaluator>(async () => ({ ok: true, clear: true }));
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true, evaluate });
  expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ update: 'Left side done' }));
});

it('includes the newest report in a review card with no art', async () => {
  const teamId = seedTeam({ leadRoleId: LEAD });
  const taskId = seedTask(teamId);
  expect(taskRepo.setStatus(scope, taskId, 1, 'in_progress', ACTOR, monday - 3)).toBe(true);
  expect(taskRepo.recordReport(scope, taskId, 'old', U1, 'Older update', ACTOR, monday - 2)).toBe(
    'recorded',
  );
  expect(taskRepo.recordReport(scope, taskId, 'new', U1, 'Newest update', ACTOR, monday - 1)).toBe(
    'recorded',
  );
  expect(taskRepo.requestCompletion(scope, taskId, 2, MEMBER_ACTOR, monday)).toBe(true);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = sentMessages().find((s) => cardText(s.message).includes('Marked done by'));
  expect(found?.message.flags).toBe(32768);
  expect(found?.message.files).toBeUndefined();
  expect(cardText(found?.message ?? {})).toContain('Newest update');
  expect(cardText(found?.message ?? {})).not.toContain('Older update');
});
it('sends custom reminders with art and the original audience', async () => {
  const teamId = seedTeam({ memberRoleId: MEMBER });
  const taskId = seedTask(teamId);
  taskNudgeRepo.schedule(
    scope,
    { slotId: 'custom:card', taskId, kind: 'custom', dueAt: monday },
    monday,
  );
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = findSend('REMINDER');
  expect(found?.message.flags).toBe(32768);
  expect(found?.message.files?.map((f) => f.name)).toContain('saur-thumb.png');
  expect(found?.message.allowedMentions).toEqual({ parse: [], roles: [MEMBER] });
});
it('groups digest tasks by due date and includes only tasks done in the last week', async () => {
  const teamId = seedTeam({ memberRoleId: MEMBER });
  seedTask(teamId, { title: 'Late task', dueAt: monday - 1 });
  seedTask(teamId, { title: 'Due now', dueAt: monday });
  seedTask(teamId, { title: 'Later task', dueAt: monday + 7 * 86_400_000 });
  const recent = seedTask(teamId, { title: 'Recent done' });
  const old = seedTask(teamId, { title: 'Old done' });
  for (const [id, at] of [
    [recent, monday - 7 * 86_400_000],
    [old, monday - 7 * 86_400_000 - 1],
  ] as const) {
    expect(taskRepo.requestCompletion(scope, id, 1, MEMBER_ACTOR, at)).toBe(true);
    expect(taskRepo.approveTask(scope, id, 2, ACTOR, at)).toBe(true);
  }
  planTaskNudges(scope, monday);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  const found = findSend('WEEKLY DIGEST');
  const text = cardText(found?.message ?? {});
  expect(text).toContain('Overdue');
  expect(text).toContain('Late task');
  expect(text).toContain('Due this week');
  expect(text).toContain('Due now');
  expect(text).toContain('Later');
  expect(text).toContain('Later task');
  expect(text).toContain('Done this week');
  expect(text).toContain('Recent done');
  expect(text).not.toContain('Old done');
  expect(found?.message.allowedMentions).toEqual({ parse: [] });
});
it('keeps an oversized escaped digest within budget with complete rows and accurate omitted counts', async () => {
  const teamId = seedTeam({ name: '@everyone **Exec**', memberRoleId: MEMBER });
  const total = 24;
  const title = (group: string, i: number) =>
    `${group}${String(i).padStart(2, '0')} @everyone <@&${MEMBER}> ${'*'.repeat(160)}`;
  for (let i = 0; i < total; i++) {
    for (const [group, dueAt] of [
      ['Overdue', monday - 1 - i],
      ['Due', monday + i],
      ['Later', monday + 7 * 86_400_000 + i],
    ] as const) {
      seedTask(teamId, {
        title: title(group, i),
        dueAt,
        assignmentKind: 'individual',
        assigneeIds: [U1, U2],
      });
    }
    const done = seedTask(teamId, { title: title('Done', i) });
    expect(taskRepo.requestCompletion(scope, done, 1, MEMBER_ACTOR, monday - 1)).toBe(true);
    expect(taskRepo.approveTask(scope, done, 2, ACTOR, monday - 1)).toBe(true);
  }
  planTaskNudges(scope, monday);
  // Delivery processes at most forty slots per pass; drain preceding task announcements first.
  for (let pass = 0; pass < 10 && !findSend('WEEKLY DIGEST'); pass++) {
    await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  }
  const found = findSend('WEEKLY DIGEST');
  expect(found).toBeDefined();
  const textDisplays = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(textDisplays);
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (obj['type'] === 10 && typeof obj['content'] === 'string') return [obj['content']];
      return Object.values(obj).flatMap(textDisplays);
    }
    return [];
  };
  // Count the actual escaped Text Display strings, not JSON serialization or raw titles.
  const displays = textDisplays(found!.message.components);
  expect(displays.reduce((sum, content) => sum + content.length, 0)).toBeLessThanOrEqual(4000);
  const text = displays.join('\n');
  expect(text).toContain(`${total} done, ${total} due this week, ${total} overdue`);
  expect(text).toContain('@\u200beveryone');
  expect(text).toContain('<\u200b@\u200b&');
  expect(text).toContain('\\*');
  expect(text).not.toContain('@everyone');
  expect(text).not.toContain(`<@&${MEMBER}>`);
  expect(displays.at(-1)).toBe('-# Posted every Monday · Use /task list to see yours');
  for (const heading of ['Overdue', 'Due this week', '**Later**']) {
    const section = displays.find((content) => content.split('\n')[0]!.includes(heading));
    expect(section).toBeDefined();
    const rows = section!.split('\n').slice(1);
    const omittedLine = rows.pop();
    expect(omittedLine).toMatch(/^- and \d+ more$/);
    const omitted = Number(/^- and (\d+) more$/.exec(omittedLine!)?.[1]);
    expect(omitted).toBeGreaterThan(0);
    expect(rows.length + omitted).toBe(total);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatch(new RegExp(`^- .+ · <@${U1}> <@${U2}> · <t:\\d+:R>$`));
    }
  }
  const doneSection = displays.find((content) => content.startsWith('**✅ Done this week**'));
  expect(doneSection).toBeDefined();
  const doneLine = doneSection!.split('\n')[1]!;
  expect(doneLine).toMatch(/, and \d+ more$/);
  const doneOmitted = Number(/, and (\d+) more$/.exec(doneLine)?.[1]);
  const shownDone = doneLine.replace(/, and \d+ more$/, '').split(', ');
  expect(shownDone.length).toBeGreaterThan(0);
  expect(doneOmitted).toBeGreaterThan(0);
  expect(shownDone.length + doneOmitted).toBe(total);
  for (const item of shownDone) expect(item).toMatch(/^Done\d{2} /);
  expect(found!.message.allowedMentions).toEqual({ parse: [] });
});
it('caps check-in user pings at fifty', async () => {
  const teamId = seedTeam();
  const users = Array.from({ length: 60 }, (_, i) => String(100000000000000100n + BigInt(i)));
  for (let i = 0; i < 6; i++)
    seedTask(teamId, {
      assignmentKind: 'individual',
      assigneeIds: users.slice(i * 10, i * 10 + 10),
      dueAt: monday + 48 * 3_600_000 + i,
    });
  planTaskNudges(scope, monday);
  await deliverTaskNudges(scope, client, discord, monday, { enabled: true });
  expect(findSend('WEEKLY CHECK-IN')?.message.allowedMentions?.users).toEqual(users.slice(0, 50));
});
