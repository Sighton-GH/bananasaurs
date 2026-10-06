import { ChannelType, type Client } from 'discord.js';
import {
  buildPickComponents,
  buildReviewComponents,
  parseSnowflakeId,
  safeLogFields,
  TASK_REPLY_NOTICE,
  type AccessDecision,
  type DiscordPort,
  type Logger,
} from '@bananasaurs/core';
import {
  taskNudgeRepo as repo,
  taskRepo,
  taskBindingRepo,
  type GuildScope,
} from '@bananasaurs/storage';
import { channelAccessFor } from '../channels/access.js';
import type { TaskUpdateEvaluator } from './task-evaluate.js';

export const QUIET_ZONE = 'America/Los_Angeles';
/** These may be changed before starting the daemon; no Discord send occurs by default. */
export interface TaskNudgeOptions {
  enabled?: boolean;
  quietStart?: number;
  quietEnd?: number;
  /** ADR 0112: the one-shot model check for recorded progress updates. */
  evaluate?: TaskUpdateEvaluator;
  /** When present, the worker logs evaluation outcomes; never member text. */
  logger?: Logger;
}
/** Kinds held for quiet hours; every other kind delivers immediately. */
export const SCHEDULED_KINDS: ReadonlySet<repo.NudgeKind> = new Set([
  'pre_due',
  'custom',
  'checkin',
  'digest',
]);
const hourInPacific = (now: number): number =>
  Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: QUIET_ZONE,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(now),
  );
export const isGuildQuiet = (scope: GuildScope, now: number, start = 0, end = 8): boolean => {
  const override = taskRepo.getQuietHours(scope);
  if (!override) return isQuiet(now, start, end);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: override.timezone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (part: string) => Number(parts.find((p) => p.type === part)?.value);
  const minute = value('hour') * 60 + value('minute');
  const { startMinute: from, endMinute: to } = override;
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
};
export const isQuiet = (now: number, start = 0, end = 8): boolean => {
  if (![start, end].every((n) => Number.isInteger(n) && n >= 0 && n <= 23))
    throw new Error('invalid-quiet-hours');
  const hour = hourInPacific(now);
  return start === end
    ? false
    : start < end
      ? hour >= start && hour < end
      : hour >= start || hour < end;
};
const pacificWeekday = (now: number): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: QUIET_ZONE, weekday: 'long' }).format(now);
const pacificDate = (now: number): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: QUIET_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
/** Stable Pacific Monday date for each seven-day reminder cycle. */
export const weekKey = (now: number): string => {
  const [year = 0, month = 0, day = 0] = pacificDate(now).split('-').map(Number);
  const utc = Date.UTC(year, month - 1, day);
  const weekday = new Date(utc).getUTCDay();
  return new Date(utc - ((weekday + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
};
const safe = (s: string): string => s.replace(/@/g, '@\u200b').replace(/\s+/g, ' ').slice(0, 200);

/** A bounded, restart-safe producer. Scheduled reminders are stored before any delivery. */
export function planTaskNudges(scope: GuildScope, now: number, options?: TaskNudgeOptions): void {
  for (const task of repo.openTasks(scope)) {
    if (task.status === 'done' || task.status === 'awaiting_approval') continue;
    const preDue = task.dueAt - 48 * 3_600_000;
    // A task created less than 48 hours before its due date gets no instant
    // pre-due reminder: the announcement already said when it is due.
    if (preDue > 0 && now < task.dueAt && preDue > task.createdAt)
      repo.schedule(
        scope,
        {
          slotId: `pre:${task.taskId}:${task.dueAt}`,
          taskId: task.taskId,
          kind: 'pre_due',
          dueAt: preDue,
        },
        now,
      );
  }
  // Check-ins and digests are a Monday habit, never a quiet-hours one.
  // Pre-due and custom reminders keep their exact times regardless of weekday.
  if (pacificWeekday(now) !== 'Monday') return;
  if (isGuildQuiet(scope, now, options?.quietStart, options?.quietEnd)) return;
  const seen = new Set<string>();
  for (const task of repo.openTasks(scope)) {
    if (task.status !== 'not_started' && task.status !== 'in_progress') continue;
    if (seen.has(task.destinationId)) continue;
    seen.add(task.destinationId);
    repo.schedule(
      scope,
      {
        slotId: `checkin:${task.destinationId}:${weekKey(now)}`,
        kind: 'checkin',
        destinationId: task.destinationId,
        dueAt: now,
      },
      now,
    );
  }
  for (const team of repo.teams(scope))
    if (team.announcementChannelId) {
      repo.schedule(
        scope,
        {
          slotId: `digest:${team.teamId}:${weekKey(now)}`,
          teamId: team.teamId,
          kind: 'digest',
          dueAt: now,
        },
        now,
      );
    }
}

/** Fetch live metadata before every send, including the category and a thread's parent. */
type DestinationVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'write-denied'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unavailable' };
const unavailable = (): DestinationVerdict => ({ ok: false, reason: 'unavailable' });
/**
 * N9: a Write decision as a verdict. `unknown-channel` means the channel is
 * gone, which is the ordinary unavailable pause, not a permission denial.
 */
const fromWrite = (write: AccessDecision): DestinationVerdict =>
  write.allowed
    ? { ok: true }
    : write.reason === 'unknown-channel'
      ? unavailable()
      : { ok: false, reason: 'write-denied', detail: write.reason };
/** The owner-facing pause text for a Write denial: No access names itself. */
const writeDeniedText = (detail: string): string =>
  detail === 'no-access'
    ? 'this channel is marked No access'
    : 'writing is turned off for that channel';
async function destination(
  client: Client,
  scope: GuildScope,
  channelId: string,
  categoryId: string,
): Promise<DestinationVerdict> {
  const guild = client.guilds.cache.get(scope.guildId);
  if (!guild) return unavailable();
  try {
    const category = await guild.channels.fetch(categoryId, { force: true });
    if (category?.type !== ChannelType.GuildCategory) return unavailable();
    const channel = await guild.channels.fetch(channelId, { force: true });
    if (!channel || !('send' in channel) || typeof channel.send !== 'function')
      return unavailable();
    if (
      channel.type === ChannelType.PublicThread ||
      channel.type === ChannelType.PrivateThread ||
      channel.type === ChannelType.AnnouncementThread
    ) {
      // An archived-but-unlocked thread reopens on send (Discord unarchives
      // it); only a locked thread, or one with no parent, pauses.
      if (channel.locked || !channel.parentId) return unavailable();
      const parent = await guild.channels.fetch(channel.parentId, { force: true });
      if (!parent || !('parentId' in parent) || parent.parentId !== categoryId)
        return unavailable();
      return fromWrite(await channelAccessFor(client, scope).check('write', channelId));
    }
    if (!('parentId' in channel) || channel.parentId !== categoryId) return unavailable();
    return fromWrite(await channelAccessFor(client, scope).check('write', channelId));
  } catch {
    return unavailable();
  }
}

const dueLabel = (task: { dueAt: number; timezone: string }): string => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: task.timezone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(task.dueAt);
  } catch (err) {
    if (err instanceof RangeError)
      return `${new Date(task.dueAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    throw err;
  }
};

interface TaskMentions {
  readonly text: string;
  readonly users: readonly string[];
  readonly roles: readonly string[];
}
/**
 * Who a task post pings. Individual tasks ping their assignees; whole-team
 * tasks ping the team's member role (no role set means no ping at all).
 */
const mentionsFor = (
  scope: GuildScope,
  task: { taskId: string; assignmentKind: string },
  team: { memberRoleId: string | null } | undefined,
): TaskMentions => {
  if (task.assignmentKind === 'individual') {
    const users = taskRepo.listTaskAssignees(scope, task.taskId);
    return { text: users.map((u) => `<@${u}>`).join(' '), users, roles: [] };
  }
  const role = team?.memberRoleId ?? null;
  return role
    ? { text: `<@&${role}>`, users: [], roles: [role] }
    : { text: '', users: [], roles: [] };
};

const parseJsonPayload = (raw: string | null): unknown => {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};
interface ReviewPayload {
  readonly version: number;
  readonly requestedBy: string;
}
const parseReviewPayload = (raw: string | null): ReviewPayload | undefined => {
  const parsed = parseJsonPayload(raw) as Partial<ReviewPayload> | undefined;
  if (
    !parsed ||
    !Number.isInteger(parsed.version) ||
    (parsed.version as number) < 1 ||
    typeof parsed.requestedBy !== 'string' ||
    parsed.requestedBy === ''
  )
    return undefined;
  return { version: parsed.version as number, requestedBy: parsed.requestedBy };
};
interface ClarifyPayload {
  readonly replyMessageId: string;
  readonly channelId: string;
  readonly candidates: readonly string[];
}
const parseClarifyPayload = (raw: string | null): ClarifyPayload | undefined => {
  const parsed = parseJsonPayload(raw) as Partial<ClarifyPayload> | undefined;
  if (
    !parsed ||
    typeof parsed.replyMessageId !== 'string' ||
    parsed.replyMessageId === '' ||
    typeof parsed.channelId !== 'string' ||
    parsed.channelId === '' ||
    !Array.isArray(parsed.candidates) ||
    !parsed.candidates.every((c): c is string => typeof c === 'string')
  )
    return undefined;
  return {
    replyMessageId: parsed.replyMessageId,
    channelId: parsed.channelId,
    candidates: parsed.candidates,
  };
};
interface FollowupPayload {
  readonly channelId: string;
  readonly messageId: string;
}
const parseFollowupPayload = (raw: string | null): FollowupPayload | undefined => {
  const parsed = parseJsonPayload(raw) as Partial<FollowupPayload> | undefined;
  if (
    !parsed ||
    typeof parsed.channelId !== 'string' ||
    parsed.channelId === '' ||
    typeof parsed.messageId !== 'string' ||
    parsed.messageId === ''
  )
    return undefined;
  return { channelId: parsed.channelId, messageId: parsed.messageId };
};
interface EvaluatePayload {
  readonly taskId: string;
  readonly channelId: string;
  readonly messageId: string;
}
const parseEvaluatePayload = (raw: string | null): EvaluatePayload | undefined => {
  const parsed = parseJsonPayload(raw) as Partial<EvaluatePayload> | undefined;
  if (
    !parsed ||
    typeof parsed.taskId !== 'string' ||
    parsed.taskId === '' ||
    typeof parsed.channelId !== 'string' ||
    parsed.channelId === '' ||
    typeof parsed.messageId !== 'string' ||
    parsed.messageId === ''
  )
    return undefined;
  return { taskId: parsed.taskId, channelId: parsed.channelId, messageId: parsed.messageId };
};

const DIGEST_STATUS_LABEL: Record<string, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  awaiting_approval: 'Awaiting approval',
};

export async function deliverTaskNudges(
  scope: GuildScope,
  client: Client,
  discord: DiscordPort,
  now: number,
  options: TaskNudgeOptions = {},
): Promise<number> {
  const quiet = isGuildQuiet(scope, now, options.quietStart, options.quietEnd);
  let processed = 0;
  // N1: a guild not yet cached or available is transient — return before
  // claiming any slot, so no kind (followup ✅ included) settles `paused`
  // for a guild the cache has not seen yet.
  if (client.guilds.cache.get(scope.guildId)?.available !== true) return processed;
  // Quiet hours hold the scheduled kinds in the query itself, so a full page
  // of held slots can never starve an event kind behind the limit. Event
  // kinds (announce, review, clarify, followup, evaluate) always deliver now.
  const held = quiet ? [...SCHEDULED_KINDS] : undefined;
  for (const slot of repo.listDue(scope, now, 40, held)) {
    if (!repo.claim(scope, slot.slotId, now)) continue;
    processed++;
    try {
      await deliverOneSlot(scope, client, discord, now, options, slot);
    } catch (err) {
      // One slot's failure never stops the next slot; the failure is
      // durable (failed) and carries the guild for diagnosis.
      repo.settle(scope, slot.slotId, 'failed', now);
      options.logger?.error(
        safeLogFields({
          component: 'task-nudges',
          guildId: scope.guildId,
          slotId: slot.slotId,
          kind: slot.kind,
          err,
        }),
        'task nudge slot failed; continuing with the next slot',
      );
    }
  }
  return processed;
}

/**
 * One claimed slot, from validation to settle. Never throws: a send failure
 * is a durable `failed` settle (Discord may have committed the send and lost
 * the response, so it is never replayed blindly). Anything unexpected escapes
 * to `deliverTaskNudges`, which settles `failed` and continues.
 */
const deliverOneSlot = async (
  scope: GuildScope,
  client: Client,
  discord: DiscordPort,
  now: number,
  options: TaskNudgeOptions,
  slot: repo.NudgeSlot,
): Promise<void> => {
  const teamById = new Map(repo.teams(scope).map((t) => [t.teamId, t]));
  const pause = (target: string | null | undefined, verdict?: DestinationVerdict) => {
    // ADR 0126 M5: a Write denial pauses as write-denied — writing is turned
    // off for that channel — with the ids-only denial line carrying guild,
    // channel, purpose and reason. Anything else pauses as unavailable.
    if (
      target != null &&
      verdict !== undefined &&
      !verdict.ok &&
      verdict.reason === 'write-denied'
    ) {
      repo.settle(
        scope,
        slot.slotId,
        'paused',
        now,
        target,
        undefined,
        writeDeniedText(verdict.detail),
      );
      options.logger?.info(
        safeLogFields({
          component: 'task-nudges',
          guildId: scope.guildId,
          slotId: slot.slotId,
          kind: slot.kind,
          channelId: target,
          purpose: 'write',
          reason: verdict.detail,
        }),
        'task nudge paused: write denied',
      );
      return;
    }
    repo.settle(
      scope,
      slot.slotId,
      'paused',
      now,
      target ?? undefined,
      undefined,
      'destination missing, moved, or unavailable',
    );
    options.logger?.info(
      safeLogFields({
        component: 'task-nudges',
        guildId: scope.guildId,
        slotId: slot.slotId,
        kind: slot.kind,
        outcome: 'paused',
      }),
      'task nudge paused',
    );
  };
  /**
   * The destination, or `undefined` after pausing: a missing id, an unpostable
   * channel and a Write denial all settle here, so arms stay one line.
   */
  const resolveTarget = async (
    channelId: string | null | undefined,
    categoryId: string,
  ): Promise<string | undefined> => {
    if (channelId == null) {
      pause(channelId);
      return undefined;
    }
    const verdict = await destination(client, scope, channelId, categoryId);
    if (!verdict.ok) {
      pause(channelId, verdict);
      return undefined;
    }
    return channelId;
  };
  const fail = (target: string) => {
    // Discord can commit a send and lose the response. Do not replay blindly.
    repo.settle(
      scope,
      slot.slotId,
      'failed',
      now,
      target,
      undefined,
      'send failed or outcome uncertain; manual review required',
    );
    options.logger?.info(
      safeLogFields({
        component: 'task-nudges',
        guildId: scope.guildId,
        slotId: slot.slotId,
        kind: slot.kind,
        outcome: 'failed',
      }),
      'task nudge failed',
    );
  };
  const task = slot.taskId ? repo.taskFor(scope, slot.taskId) : undefined;

  if (slot.kind === 'announce') {
    if (!task || task.archivedAt !== null || task.status === 'done') {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    const team = teamById.get(task.teamId);
    if (!team) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    const target = await resolveTarget(task.destinationId, team.categoryId);
    if (target === undefined) return;
    // Planning-mode records a delivery attempt but never calls Discord send.
    if (!options.enabled) {
      repo.settle(scope, slot.slotId, 'planned', now, target);
      return;
    }
    const mentions = mentionsFor(scope, task, team);
    const content = mentions.text
      ? `New task: **${safe(task.title)}**\nDue ${dueLabel(task)}\nFor: ${mentions.text}\n${TASK_REPLY_NOTICE}`
      : `New task: **${safe(task.title)}**\nDue ${dueLabel(task)}\n${TASK_REPLY_NOTICE}`;
    try {
      const ref = await discord.sendMessage(scope.guildId, parseSnowflakeId(target), {
        content: content.slice(0, 2000),
        allowedMentions: { parse: [], users: [...mentions.users], roles: [...mentions.roles] },
      });
      repo.settle(scope, slot.slotId, 'sent', now, target, ref.messageId);
      taskRepo.recordTaskAnchor(scope, task.taskId, target, ref.messageId, now);
    } catch {
      fail(target);
    }
    return;
  }

  if (slot.kind === 'review') {
    const payload = parseReviewPayload(slot.payload);
    if (
      !payload ||
      !task ||
      task.archivedAt !== null ||
      task.status !== 'awaiting_approval' ||
      task.version !== payload.version
    ) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    const team = teamById.get(task.teamId);
    if (!team) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    // Subteams ask their lead (or the president when no lead is set); exec asks the president.
    const president = taskBindingRepo.presidentRoleId(scope);
    const role = team.kind === 'exec' ? president : (team.leadRoleId ?? president);
    const target = await resolveTarget(task.destinationId, team.categoryId);
    if (target === undefined) return;
    if (!options.enabled) {
      repo.settle(scope, slot.slotId, 'planned', now, target);
      return;
    }
    // The requester is a member mention only when it is a Discord user id;
    // a dashboard or owner actor reads as "the owner", never as a broken
    // mention of a non-member id.
    const requester = /^\d{17,20}$/.test(payload.requestedBy)
      ? `<@${payload.requestedBy}>`
      : 'the owner';
    const content =
      `Ready for review: **${safe(task.title)}** — marked complete by ${requester}.` +
      (role ? ` <@&${role}> please review.` : '');
    try {
      const ref = await discord.sendMessage(scope.guildId, parseSnowflakeId(target), {
        content: content.slice(0, 2000),
        allowedMentions: { parse: [], users: [], roles: role ? [role] : [] },
        components: buildReviewComponents(task.taskId, payload.version),
      });
      repo.settle(scope, slot.slotId, 'sent', now, target, ref.messageId);
    } catch {
      fail(target);
    }
    return;
  }

  if (slot.kind === 'pre_due' || slot.kind === 'custom') {
    if (
      !task ||
      task.archivedAt !== null ||
      task.status === 'done' ||
      task.status === 'awaiting_approval' ||
      (slot.kind === 'pre_due' &&
        (task.dueAt !== Number(slot.slotId.split(':').at(-1)) || now >= task.dueAt)) ||
      (slot.kind === 'custom' && (slot.dueAt >= task.dueAt || now >= task.dueAt))
    ) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    const team = teamById.get(task.teamId);
    if (!team) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    const target = await resolveTarget(task.destinationId, team.categoryId);
    if (target === undefined) return;
    if (!options.enabled) {
      repo.settle(scope, slot.slotId, 'planned', now, target);
      return;
    }
    const mentions = mentionsFor(scope, task, team);
    const label = slot.kind === 'pre_due' ? 'Upcoming deadline' : 'Task reminder';
    const content = `${label}: **${safe(task.title)}** — due ${dueLabel(task)}\n${mentions.text}\n${TASK_REPLY_NOTICE}`;
    try {
      const ref = await discord.sendMessage(scope.guildId, parseSnowflakeId(target), {
        content: content.slice(0, 2000),
        allowedMentions: { parse: [], users: [...mentions.users], roles: [...mentions.roles] },
      });
      repo.settle(scope, slot.slotId, 'sent', now, target, ref.messageId);
    } catch {
      fail(target);
    }
    return;
  }

  if (slot.kind === 'checkin') {
    const target = slot.destinationId;
    const candidates = target
      ? repo
          .openTasks(scope)
          .filter(
            (t) =>
              (t.status === 'not_started' || t.status === 'in_progress') &&
              t.destinationId === target,
          )
          .sort((a, b) => a.dueAt - b.dueAt)
          .slice(0, 15)
      : [];
    if (candidates.length === 0) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    const firstTeam = teamById.get(candidates[0]!.teamId);
    if (!firstTeam) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    // One message per channel or thread: drop tasks whose team lives elsewhere.
    const listed = candidates.filter(
      (t) => teamById.get(t.teamId)?.categoryId === firstTeam.categoryId,
    );
    if (listed.length === 0) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    const resolved = await resolveTarget(target, firstTeam.categoryId);
    if (resolved === undefined) return;
    if (!options.enabled) {
      repo.settle(scope, slot.slotId, 'planned', now, resolved);
      return;
    }
    const users: string[] = [];
    const roles: string[] = [];
    const lines = listed.map((t) => {
      const mentions = mentionsFor(scope, t, teamById.get(t.teamId));
      for (const u of mentions.users) if (!users.includes(u)) users.push(u);
      for (const r of mentions.roles) if (!roles.includes(r)) roles.push(r);
      return `• **${safe(t.title)}** — due ${dueLabel(t)} — ${mentions.text || 'whole team'}`;
    });
    const content = `Weekly check-in\n${lines.join('\n')}\n${TASK_REPLY_NOTICE}`;
    try {
      const ref = await discord.sendMessage(scope.guildId, parseSnowflakeId(resolved), {
        content: content.slice(0, 2000),
        allowedMentions: { parse: [], users: users.slice(0, 50), roles },
      });
      repo.settleWithTasks(
        scope,
        slot.slotId,
        now,
        resolved,
        ref.messageId,
        listed.map((t) => t.taskId),
      );
    } catch {
      fail(resolved);
    }
    return;
  }

  if (slot.kind === 'digest') {
    const team = slot.teamId ? teamById.get(slot.teamId) : undefined;
    if (!team) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    const target = await resolveTarget(team.announcementChannelId, team.categoryId);
    if (target === undefined) return;
    if (!options.enabled) {
      repo.settle(scope, slot.slotId, 'planned', now, target);
      return;
    }
    const listed = repo
      .openTasks(scope)
      .filter((t) => t.teamId === team.teamId && t.status !== 'done')
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, 20);
    const body =
      listed
        .map(
          (t) =>
            `• **${safe(t.title)}** — ${DIGEST_STATUS_LABEL[t.status] ?? t.status} — due ${dueLabel(t)}`,
        )
        .join('\n') || 'No open tasks.';
    try {
      const ref = await discord.sendMessage(scope.guildId, parseSnowflakeId(target), {
        content: `Weekly ${safe(team.name)} digest\n${body}`.slice(0, 2000),
        allowedMentions: { parse: [] },
      });
      repo.settle(scope, slot.slotId, 'sent', now, target, ref.messageId);
    } catch {
      fail(target);
    }
    return;
  }

  if (slot.kind === 'clarify') {
    const payload = parseClarifyPayload(slot.payload);
    const open = payload
      ? payload.candidates.flatMap((id) => {
          const candidate = repo.taskFor(scope, id);
          return candidate &&
            candidate.archivedAt === null &&
            candidate.status !== 'done' &&
            candidate.status !== 'awaiting_approval'
            ? [candidate]
            : [];
        })
      : [];
    if (!payload || open.length < 2) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    const shown = open.slice(0, 5);
    const firstTeam = teamById.get(shown[0]!.teamId);
    if (!firstTeam) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    const target = await resolveTarget(payload.channelId, firstTeam.categoryId);
    if (target === undefined) return;
    if (!options.enabled) {
      repo.settle(scope, slot.slotId, 'planned', now, target);
      return;
    }
    try {
      const ref = await discord.sendMessage(scope.guildId, parseSnowflakeId(target), {
        content: 'Which task is this update for?',
        allowedMentions: { parse: [] },
        components: buildPickComponents(
          payload.replyMessageId,
          shown.map((t) => ({ taskId: t.taskId, title: t.title })),
        ),
        replyTo: payload.replyMessageId,
      });
      repo.settle(scope, slot.slotId, 'sent', now, target, ref.messageId);
    } catch {
      fail(target);
    }
    return;
  }

  if (slot.kind === 'followup') {
    const payload = parseFollowupPayload(slot.payload);
    if (!payload) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    // ADR 0126 I2: the ✅ reaction is a visible write in the reply's
    // channel, so it needs Write like every other post. Denied settles
    // paused with the write-denied reason (M5), never a reaction.
    const verdict = fromWrite(
      await channelAccessFor(client, scope).check('write', payload.channelId),
    );
    if (!verdict.ok) {
      pause(payload.channelId, verdict);
      return;
    }
    if (!options.enabled) {
      repo.settle(scope, slot.slotId, 'planned', now, payload.channelId);
      return;
    }
    try {
      await discord.createReaction(
        scope.guildId,
        { channelId: payload.channelId, messageId: payload.messageId },
        'u:2705',
      );
      repo.settle(scope, slot.slotId, 'sent', now, payload.channelId, payload.messageId);
    } catch {
      fail(payload.channelId);
    }
    return;
  }

  if (slot.kind === 'evaluate') {
    const payload = parseEvaluatePayload(slot.payload);
    const task = payload ? repo.taskFor(scope, payload.taskId) : undefined;
    const report =
      payload && task ? repo.getReport(scope, payload.taskId, payload.messageId) : undefined;
    if (!payload || !task || task.archivedAt !== null || !report) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    // Planning mode records without sending — and without a model call.
    if (!options.enabled) {
      repo.settle(scope, slot.slotId, 'planned', now, payload.channelId);
      return;
    }
    if (options.evaluate === undefined) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    const team = teamById.get(task.teamId);
    if (!team) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    const target = await resolveTarget(payload.channelId, team.categoryId);
    if (target === undefined) return;
    const verdict = await options.evaluate({
      guildId: scope.guildId,
      title: task.title,
      description: task.description,
      update: report.body,
    });
    if (!verdict.ok || verdict.clear) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      options.logger?.info(
        safeLogFields({
          component: 'task-evaluate',
          guildId: scope.guildId,
          slotId: slot.slotId,
          reason: verdict.ok ? 'clear' : verdict.reason,
        }),
        'task update evaluation settled without a post',
      );
      return;
    }
    try {
      const ref = await discord.sendMessage(scope.guildId, parseSnowflakeId(target), {
        content: `${verdict.question}\n\n${TASK_REPLY_NOTICE}`.slice(0, 2000),
        replyTo: payload.messageId,
        allowedMentions: { parse: [] },
      });
      repo.settle(scope, slot.slotId, 'sent', now, target, ref.messageId);
    } catch {
      fail(target);
    }
    return;
  }

  repo.settle(scope, slot.slotId, 'superseded', now);
};
