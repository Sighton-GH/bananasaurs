import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  createLoggingSubscriber,
  JOB_KINDS,
  parseGuildId,
  type AuditLogEntryEvent,
  type ConnectionEvent,
  type LoggingPorts,
  type MemberEvent,
  type MessageEvent,
  type RoleEvent,
} from '@bananasaurs/core';
import {
  guildRepo,
  jobRepo,
  loggingRepo,
  pipelineRepo,
  write,
  schema,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { FakeDiscord } from '@bananasaurs/testkit';

/**
 * The logging module's plain event kinds (ADR 0023): message edits, member
 * joins/leaves, and role create/update/delete, plus enqueueing the deletion-
 * attribution job for `messageDelete` (the job's own body — the audit-log
 * correlation — is `logging-deletion.integration.test.ts`).
 *
 * Wired against the real repositories, like `pipeline.integration.test.ts`:
 * a fake agreeing with itself proves nothing about the SQL a claim/release
 * pair actually relies on.
 */

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = '222222222222222222';
const LOG = '777777777777777777';
const EXCLUDED_CHANNEL = '999999999999999999';
const OTHER_CHANNEL = '888888888888888888';
const USER = '333333333333333333';
const MESSAGE = '444444444444444444';
const ROLE = '555555555555555555';
const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;
let ports: LoggingPorts;

const seedRoute = (
  eventKind: string,
  over: {
    name?: string;
    channelId?: string;
    includeContent?: boolean;
    enabled?: boolean;
    excludedChannelIds?: string[];
  } = {},
) =>
  loggingRepo.createRoute(scope, {
    name: over.name ?? `route-${eventKind}`,
    channelId: over.channelId ?? LOG,
    includeContent: over.includeContent ?? true,
    enabled: over.enabled ?? true,
    eventKinds: [eventKind],
    excludedChannelIds: over.excludedChannelIds ?? [],
    nowMs: 0,
  });

const excludeChannel = (channelId: string) =>
  write(scope, ({ db }) => {
    db.insert(schema.logExcludedChannels).values({ guildId: scope.guildId, channelId }).run();
  });

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });
  discord = new FakeDiscord({ guildId: GUILD });

  ports = {
    guildId: GUILD,
    listEnabledRoutesFor: (eventKind) => loggingRepo.listEnabledRoutesFor(scope, eventKind),
    isChannelExcluded: (channelId) => loggingRepo.isChannelExcluded(scope, channelId),
    listEnabledLogChannels: () => loggingRepo.listEnabledLogChannels(scope),
    claim: (input) => pipelineRepo.recordFirstSight(scope, { ...input, atMs: 0 }),
    release: (input) => pipelineRepo.forgetFirstSight(scope, input),
    sendMessage: (channelId, message) => discord.sendMessage(GUILD, channelId, message),
    enqueueDeletionAttribution: ({ dedupeKey, payload, runAfter }) =>
      jobRepo.enqueue(scope, {
        kind: JOB_KINDS.logMessageDelete,
        payload,
        dedupeKey,
        runAfter,
        now: 0,
      }),
    getMemberSnapshot: (id) => loggingRepo.getMemberSnapshot(scope, id),
    saveMemberSnapshot: (s) =>
      loggingRepo.upsertMemberSnapshot(scope, { ...s, roleIds: [...s.roleIds] }),
    deleteMemberSnapshot: (id) => {
      loggingRepo.deleteMemberSnapshot(scope, id);
    },
    now: () => 0,
    logger,
  };
});

afterEach(() => {
  t.close();
});

const messageEdit = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  kind: 'messageUpdate',
  guildId: GUILD,
  receivedAtMs: 1,
  channelId: CHANNEL,
  parentChannelId: undefined,
  categoryId: undefined,
  isPrivateThread: false,
  messageId: MESSAGE,
  authorId: USER,
  authorDisplayName: undefined,
  authorIsBot: false,
  content: 'edited text',
  editedTimestampMs: 5,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  ...over,
});

const memberJoin = (): MemberEvent => ({
  kind: 'memberAdd',
  guildId: GUILD,
  receivedAtMs: 1,
  userId: USER,
  roleIds: [],
  previousRoleIds: undefined,
  joinedAtMs: 100,
});

const memberLeave = (): MemberEvent => ({
  kind: 'memberRemove',
  guildId: GUILD,
  receivedAtMs: 1,
  userId: USER,
  roleIds: [],
  previousRoleIds: undefined,
  joinedAtMs: 100,
});

const roleEvent = (kind: 'roleCreate' | 'roleUpdate' | 'roleDelete', name = 'mods'): RoleEvent => ({
  kind,
  guildId: GUILD,
  receivedAtMs: 1,
  roleId: ROLE,
  name,
});

describe('message edits', () => {
  it('does nothing when no route is configured', async () => {
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageEdit());
    expect(discord.restCalls('sendMessage')).toHaveLength(0);
  });

  it('does nothing when the route is disabled', async () => {
    seedRoute('message_edit', { enabled: false });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageEdit());
    expect(discord.restCalls('sendMessage')).toHaveLength(0);
  });

  it('posts to the configured channel when enabled', async () => {
    seedRoute('message_edit', { channelId: OTHER_CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageEdit());

    const calls = discord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).toBe(OTHER_CHANNEL);
    expect((calls[0]?.args[2] as { content: string }).content).toContain('edited text');
  });

  it('omits content when the route has content turned off', async () => {
    seedRoute('message_edit', { includeContent: false });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageEdit({ content: 'should not appear' }));

    const call = discord.restCalls('sendMessage')[0];
    expect((call?.args[2] as { content: string }).content).not.toContain('should not appear');
  });

  it('does not log an edit from an excluded source channel', async () => {
    seedRoute('message_edit');
    excludeChannel(EXCLUDED_CHANNEL);
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageEdit({ channelId: EXCLUDED_CHANNEL }));

    expect(discord.restCalls('sendMessage')).toHaveLength(0);
  });

  it('still logs an edit from a channel that is not excluded', async () => {
    seedRoute('message_edit');
    excludeChannel(EXCLUDED_CHANNEL);
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageEdit({ channelId: OTHER_CHANNEL }));

    expect(discord.restCalls('sendMessage')).toHaveLength(1);
  });

  it('does not double-post the same edit delivered twice', async () => {
    seedRoute('message_edit');
    const subscriber = createLoggingSubscriber(ports);
    const event = messageEdit();
    await subscriber.handle(event);
    await subscriber.handle(event);

    expect(discord.restCalls('sendMessage')).toHaveLength(1);
  });

  it('releases its claim on a failed send, so a later delivery can retry', async () => {
    seedRoute('message_edit');
    discord.failNext('sendMessage', FakeDiscord.missingPermissions());
    const subscriber = createLoggingSubscriber(ports);
    const event = messageEdit();

    await expect(subscriber.handle(event)).rejects.toThrow();
    expect(discord.restCalls('sendMessage')).toHaveLength(1);

    // No further failure queued: a retry should succeed and actually post.
    await subscriber.handle(event);
    expect(discord.restCalls('sendMessage')).toHaveLength(2);
  });
});

describe('route fan-out', () => {
  it('posts an edit to two routes with the same kind, exactly once each, and a redelivery posts nothing', async () => {
    seedRoute('message_edit', { name: 'route-a', channelId: LOG });
    seedRoute('message_edit', { name: 'route-b', channelId: OTHER_CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    const event = messageEdit();

    await subscriber.handle(event);
    const channels = discord.restCalls('sendMessage').map((c) => c.args[1]);
    expect(channels.sort()).toEqual([LOG, OTHER_CHANNEL].sort());

    await subscriber.handle(event);
    expect(discord.restCalls('sendMessage')).toHaveLength(2);
  });

  it('a route with an excluded channel skips it while another route without that exclusion logs it', async () => {
    seedRoute('message_edit', {
      name: 'route-a',
      channelId: LOG,
      excludedChannelIds: [EXCLUDED_CHANNEL],
    });
    seedRoute('message_edit', { name: 'route-b', channelId: OTHER_CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageEdit({ channelId: EXCLUDED_CHANNEL }));

    const calls = discord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).toBe(OTHER_CHANNEL);
  });

  it('deleting a route stops its posts', async () => {
    const route = seedRoute('message_edit', { name: 'route-a', channelId: LOG });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageEdit());
    expect(discord.restCalls('sendMessage')).toHaveLength(1);

    expect(loggingRepo.deleteRoute(scope, route.routeId)).toBe(true);
    await subscriber.handle(messageEdit({ messageId: '555555555555555555' }));
    expect(discord.restCalls('sendMessage')).toHaveLength(1);
  });
});

const messageDelete = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  kind: 'messageDelete',
  guildId: GUILD,
  receivedAtMs: 1_000,
  channelId: CHANNEL,
  parentChannelId: undefined,
  categoryId: undefined,
  isPrivateThread: false,
  messageId: MESSAGE,
  authorId: USER,
  authorDisplayName: undefined,
  authorIsBot: false,
  content: undefined,
  editedTimestampMs: undefined,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  ...over,
});

describe('message deletes — enqueueing the attribution job', () => {
  it('enqueues nothing when no route is configured', async () => {
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageDelete());
    expect(jobRepo.countByState(scope)).toEqual({});
  });

  it('enqueues nothing when the route is disabled', async () => {
    seedRoute('message_delete', { enabled: false });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageDelete());
    expect(jobRepo.countByState(scope)).toEqual({});
  });

  it('enqueues a job scheduled for after the attribution delay', async () => {
    seedRoute('message_delete');
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageDelete({ receivedAtMs: 1_000 }));

    expect(jobRepo.countByState(scope)).toEqual({ queued: 1 });
    // Not yet due: the audit log has not had time to catch up (ADR 0019).
    expect(jobRepo.claimNext(scope, 1_000)).toBeUndefined();
    expect(jobRepo.claimNext(scope, 4_001)?.kind).toBe(JOB_KINDS.logMessageDelete);
  });

  it('does not log a delete from an excluded source channel', async () => {
    seedRoute('message_delete');
    excludeChannel(EXCLUDED_CHANNEL);
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageDelete({ channelId: EXCLUDED_CHANNEL }));

    expect(jobRepo.countByState(scope)).toEqual({});
  });

  it('does not persist content in the job payload when the route has content off', async () => {
    seedRoute('message_delete', { includeContent: false });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageDelete({ content: 'secret' }));

    const job = jobRepo.claimNext(scope, 10_000);
    expect(job?.payload).not.toContain('secret');
  });

  it('does persist content in the job payload when the route has content on', async () => {
    seedRoute('message_delete', { includeContent: true });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageDelete({ content: 'visible' }));

    const job = jobRepo.claimNext(scope, 10_000);
    expect(job?.payload).toContain('visible');
  });

  it('enqueues one job per deletion, not one per redelivery of the same event', async () => {
    seedRoute('message_delete');
    const subscriber = createLoggingSubscriber(ports);
    const event = messageDelete();
    await subscriber.handle(event);
    await subscriber.handle(event);

    expect(jobRepo.countByState(scope)).toEqual({ queued: 1 });
  });
});

describe('members', () => {
  it('logs a join to the configured channel', async () => {
    seedRoute('member_join', { channelId: CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(memberJoin());

    const call = discord.restCalls('sendMessage')[0];
    expect(call?.args[1]).toBe(CHANNEL);
    expect((call?.args[2] as { content: string }).content).toContain(USER);
  });

  it('logs a leave to the configured channel', async () => {
    seedRoute('member_leave', { channelId: CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(memberLeave());

    expect(discord.restCalls('sendMessage')).toHaveLength(1);
  });

  it('does not log a join when no member_join route is configured', async () => {
    seedRoute('member_leave', { channelId: CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(memberJoin());

    expect(discord.restCalls('sendMessage')).toHaveLength(0);
  });
});

describe('member changes end to end', () => {
  it('join, then a nickname update, then a leave posts one change line and clears the snapshot', async () => {
    seedRoute('member_nickname_changed');
    const subscriber = createLoggingSubscriber(ports);

    await subscriber.handle({
      ...memberJoin(),
      profile: {
        username: 'member',
        globalName: undefined,
        nickname: undefined,
        avatarHash: undefined,
        guildAvatarHash: undefined,
      },
    });
    // No member_join route, so nothing posts — but the baseline is kept.
    expect(discord.restCalls('sendMessage')).toHaveLength(0);
    expect(loggingRepo.getMemberSnapshot(scope, USER)?.nickname).toBeUndefined();

    await subscriber.handle({
      kind: 'memberUpdate',
      guildId: GUILD,
      receivedAtMs: 2_000,
      userId: USER,
      roleIds: [],
      previousRoleIds: [],
      joinedAtMs: 100,
      profile: {
        username: 'member',
        globalName: undefined,
        nickname: 'new',
        avatarHash: undefined,
        guildAvatarHash: undefined,
      },
      previousMember: { nickname: undefined, guildAvatarHash: undefined },
    });

    const calls = discord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect((calls[0]?.args[2] as { content: string }).content).toBe(
      `Nickname changed: <@${USER}>  (none) → "new"`,
    );
    expect(calls[0]?.args[2]).toMatchObject({ allowedMentions: { parse: [] } });

    await subscriber.handle(memberLeave());
    expect(loggingRepo.getMemberSnapshot(scope, USER)).toBeUndefined();
  });
});

describe('roles', () => {
  it('logs a create, an update and a delete, each to its own route', async () => {
    seedRoute('role_create', { channelId: CHANNEL });
    seedRoute('role_update', { channelId: OTHER_CHANNEL });
    seedRoute('role_delete', { channelId: CHANNEL });
    const subscriber = createLoggingSubscriber(ports);

    await subscriber.handle(roleEvent('roleCreate'));
    await subscriber.handle(roleEvent('roleUpdate', 'renamed'));
    await subscriber.handle(roleEvent('roleDelete', 'renamed'));

    expect(discord.restCalls('sendMessage')).toHaveLength(3);
  });

  it('names the deleted role by its last-known name', async () => {
    seedRoute('role_delete', { channelId: CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(roleEvent('roleDelete', 'old-name'));

    const call = discord.restCalls('sendMessage')[0];
    expect((call?.args[2] as { content: string }).content).toContain('old-name');
  });

  it('does not double-post an identical role-update redelivery', async () => {
    seedRoute('role_update', { channelId: CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    const event = roleEvent('roleUpdate', 'mods');
    await subscriber.handle(event);
    await subscriber.handle(event);

    expect(discord.restCalls('sendMessage')).toHaveLength(1);
  });

  it('logs a second, real role update with a different resulting name', async () => {
    // roleUpdate has no pipeline-level fingerprint (ADR 0023 decision 4), so
    // this module computes its own from the resulting name.
    seedRoute('role_update', { channelId: CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(roleEvent('roleUpdate', 'mods'));
    await subscriber.handle(roleEvent('roleUpdate', 'mods-renamed'));

    expect(discord.restCalls('sendMessage')).toHaveLength(2);
  });
});

const connectionEvent = (over: Partial<ConnectionEvent> = {}): ConnectionEvent => ({
  kind: 'connection',
  guildId: GUILD,
  receivedAtMs: 2_000,
  resumed: false,
  disconnectedAtMs: 1_000,
  ...over,
});

describe('gap markers (ADR 0023 decision 5)', () => {
  it('posts nothing when no routes are configured', async () => {
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(connectionEvent());
    expect(discord.restCalls('sendMessage')).toHaveLength(0);
  });

  it('posts nothing when the session resumed — nothing was lost', async () => {
    seedRoute('message_delete', { channelId: CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(connectionEvent({ resumed: true }));
    expect(discord.restCalls('sendMessage')).toHaveLength(0);
  });

  it('posts a marker to a configured, enabled channel', async () => {
    seedRoute('message_delete', { channelId: CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(connectionEvent());

    const calls = discord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).toBe(CHANNEL);
    const content = (calls[0]?.args[2] as { content: string }).content;
    expect(content).toContain('<t:1:t>'); // disconnectedAtMs 1_000 -> 1s
    expect(content).toContain('<t:2:t>'); // receivedAtMs 2_000 -> 2s
  });

  it('every log post disables mention parsing, so logged text never pings', async () => {
    seedRoute('message_edit', { channelId: CHANNEL });
    seedRoute('message_delete', { channelId: OTHER_CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageEdit({ content: 'hello @everyone' }));
    await subscriber.handle(connectionEvent());

    const calls = discord.restCalls('sendMessage');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args[2]).toMatchObject({ allowedMentions: { parse: [] } });
    }
  });

  it('posts once per distinct channel, not once per route sharing a channel', async () => {
    seedRoute('message_delete', { channelId: CHANNEL });
    seedRoute('message_edit', { channelId: CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(connectionEvent());

    expect(discord.restCalls('sendMessage')).toHaveLength(1);
  });

  it('posts to every distinct channel configured', async () => {
    seedRoute('message_delete', { channelId: CHANNEL });
    seedRoute('member_join', { channelId: OTHER_CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(connectionEvent());

    const channels = discord.restCalls('sendMessage').map((c) => c.args[1]);
    expect(channels.sort()).toEqual([CHANNEL, OTHER_CHANNEL].sort());
  });

  it('does not double-post the same gap to the same channel on redelivery', async () => {
    seedRoute('message_delete', { channelId: CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    const event = connectionEvent();
    await subscriber.handle(event);
    await subscriber.handle(event);

    expect(discord.restCalls('sendMessage')).toHaveLength(1);
  });

  it('posts a marker for a later, distinct gap even to the same channel', async () => {
    seedRoute('message_delete', { channelId: CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(connectionEvent({ disconnectedAtMs: 1_000, receivedAtMs: 2_000 }));
    await subscriber.handle(connectionEvent({ disconnectedAtMs: 5_000, receivedAtMs: 6_000 }));

    expect(discord.restCalls('sendMessage')).toHaveLength(2);
  });

  it('still posts to the other channel when one channel fails', async () => {
    seedRoute('message_delete', { channelId: CHANNEL });
    seedRoute('member_join', { channelId: OTHER_CHANNEL });
    discord.failNext('sendMessage', FakeDiscord.missingPermissions());
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(connectionEvent());

    // One failed, one succeeded — both attempted, not stopped by the first.
    expect(discord.restCalls('sendMessage')).toHaveLength(2);
  });
});

describe('message creates', () => {
  const create = (over: Partial<MessageEvent> = {}): MessageEvent => ({
    ...messageEdit(),
    kind: 'messageCreate',
    editedTimestampMs: undefined,
    ...over,
  });
  it('does not self-log the bot logging its own line', async () => {
    seedRoute('message_create');
    await createLoggingSubscriber(ports).handle(create({ authorIsBot: true }));
    expect(discord.restCalls('sendMessage')).toHaveLength(0);
  });
  it('does not log messages from a No access channel', async () => {
    seedRoute('message_create');
    excludeChannel(EXCLUDED_CHANNEL);
    await createLoggingSubscriber(ports).handle(create({ channelId: EXCLUDED_CHANNEL }));
    expect(discord.restCalls('sendMessage')).toHaveLength(0);
  });
  it('logs a member message from an allowed channel once', async () => {
    seedRoute('message_create');
    await createLoggingSubscriber(ports).handle(create());
    expect(discord.restCalls('sendMessage')).toHaveLength(1);
  });
});

const MOD = '666666666666666666';

const auditEntry = (over: Partial<AuditLogEntryEvent> = {}): AuditLogEntryEvent => ({
  kind: 'auditLogEntry',
  guildId: GUILD,
  receivedAtMs: 1,
  entryId: '999999999999999999',
  action: 22,
  actorId: MOD,
  targetId: USER,
  reason: undefined,
  changes: [],
  count: undefined,
  channelId: undefined,
  ...over,
});

describe('audit-log entries', () => {
  it('posts a ban line to a member_ban route exactly once across a replay', async () => {
    seedRoute('member_ban');
    const subscriber = createLoggingSubscriber(ports);
    const event = auditEntry();
    await subscriber.handle(event);
    await subscriber.handle(event);

    const calls = discord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).toBe(LOG);
    expect((calls[0]?.args[2] as { content: string }).content).toContain(`Banned: <@${USER}>`);
  });
});
