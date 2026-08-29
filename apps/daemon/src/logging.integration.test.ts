import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  createLoggingSubscriber,
  parseGuildId,
  type LoggingPorts,
  type MemberEvent,
  type MessageEvent,
  type RoleEvent,
} from '@bananasaurs/core';
import {
  guildRepo,
  loggingRepo,
  pipelineRepo,
  write,
  schema,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { FakeDiscord } from '@bananasaurs/testkit';

/**
 * The logging module's plain event kinds (ADR 0022): message edits, member
 * joins/leaves, and role create/update/delete. Message deletion is slice 12c
 * — it needs the audit-log correlation job and is not handled here.
 *
 * Wired against the real repositories, like `pipeline.integration.test.ts`:
 * a fake agreeing with itself proves nothing about the SQL a claim/release
 * pair actually relies on.
 */

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = '222222222222222222';
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
  over: { channelId?: string; includeContent?: boolean; enabled?: boolean } = {},
) =>
  write(scope, ({ db }) => {
    db.insert(schema.logRoutes)
      .values({
        guildId: scope.guildId,
        eventKind,
        channelId: over.channelId ?? CHANNEL,
        includeContent: (over.includeContent ?? true) ? 1 : 0,
        enabled: (over.enabled ?? true) ? 1 : 0,
      })
      .run();
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
    findRoute: (eventKind) => loggingRepo.findRoute(scope, eventKind),
    isChannelExcluded: (channelId) => loggingRepo.isChannelExcluded(scope, channelId),
    claim: (input) => pipelineRepo.recordFirstSight(scope, { ...input, atMs: 0 }),
    release: (input) => pipelineRepo.forgetFirstSight(scope, input),
    sendMessage: (channelId, message) => discord.sendMessage(GUILD, channelId, message),
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
  messageId: MESSAGE,
  authorId: USER,
  content: 'edited text',
  editedTimestampMs: 5,
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
    seedRoute('message_edit', { channelId: CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageEdit());

    const calls = discord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).toBe(CHANNEL);
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
    seedRoute('message_edit', { channelId: CHANNEL });
    excludeChannel(EXCLUDED_CHANNEL);
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageEdit({ channelId: EXCLUDED_CHANNEL }));

    expect(discord.restCalls('sendMessage')).toHaveLength(0);
  });

  it('still logs an edit from a channel that is not excluded', async () => {
    seedRoute('message_edit', { channelId: CHANNEL });
    excludeChannel(EXCLUDED_CHANNEL);
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(messageEdit({ channelId: OTHER_CHANNEL }));

    expect(discord.restCalls('sendMessage')).toHaveLength(1);
  });

  it('does not double-post the same edit delivered twice', async () => {
    seedRoute('message_edit', { channelId: CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    const event = messageEdit();
    await subscriber.handle(event);
    await subscriber.handle(event);

    expect(discord.restCalls('sendMessage')).toHaveLength(1);
  });

  it('releases its claim on a failed send, so a later delivery can retry', async () => {
    seedRoute('message_edit', { channelId: CHANNEL });
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
    // roleUpdate has no pipeline-level fingerprint (ADR 0022 decision 4), so
    // this module computes its own from the resulting name.
    seedRoute('role_update', { channelId: CHANNEL });
    const subscriber = createLoggingSubscriber(ports);
    await subscriber.handle(roleEvent('roleUpdate', 'mods'));
    await subscriber.handle(roleEvent('roleUpdate', 'mods-renamed'));

    expect(discord.restCalls('sendMessage')).toHaveLength(2);
  });
});
