import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  createArchiveSubscriber,
  parseGuildId,
  Pipeline,
  type ArchivePorts,
} from '@bananasaurs/core';
import {
  archiveRepo,
  guildRepo,
  loggingRepo,
  pipelineRepo,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { FakeDiscord } from '@bananasaurs/testkit';

/**
 * Category-scoped archiving, end to end on the fake gateway (ADR 0047 and
 * its 2026-09-20 amendment).
 *
 * The subscriber's scope decision is dynamic — a channel covered only by a
 * category row is archived while it sits in the category, and stops the
 * moment it leaves — while `archive_messages`' composite foreign key is
 * satisfied by a derived `archive_channels` row that authorization never
 * reads. Every layer here is production code on real migrations with
 * foreign_keys = ON; only the gateway is faked. The unit tests
 * (`packages/core/src/archive/subscriber.test.ts`) wire `hasOwnRow` and
 * `hasCategoryRow` to Maps, which is how the FK violation shipped green.
 */

const GUILD = parseGuildId('111111111111111111');
const CATEGORY = '555555555555555551';
const CHANNEL = '222222222222222222';
const THREAD = '333333333333333333';
const MEMBER = '444444444444444444';

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;
let pipeline: Pipeline;
let nextMessageId: bigint;

const buildPipeline = (): Pipeline => {
  const ports: ArchivePorts = {
    guildArchiveEnabled: true,
    isChannelEnabled: (channelId) => archiveRepo.isChannelEnabled(scope, channelId),
    hasCategoryRow: (channelId) => archiveRepo.hasCategoryRow(scope, channelId),
    parentIncludesThreads: (channelId) => archiveRepo.parentIncludesThreads(scope, channelId),
    isChannelExcluded: (channelId) => loggingRepo.isChannelExcluded(scope, channelId),
    upsertMessage: (input) => archiveRepo.upsertMessage(scope, input),
    recordEdit: (input) => archiveRepo.recordEdit(scope, input),
    recordDelete: (input) => archiveRepo.recordDelete(scope, input),
    recordBulkDelete: (input) => archiveRepo.recordBulkDelete(scope, input),
    logger,
  };
  return new Pipeline({
    allowlist: new Set([GUILD]),
    dedupe: {
      firstSight: (input) => pipelineRepo.recordFirstSight(scope, input),
    },
    subscribers: [createArchiveSubscriber(ports)],
    leaveGuild: async () => undefined,
    logger,
  });
};

const nextId = (): string => {
  nextMessageId += 1n;
  return nextMessageId.toString();
};

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(scope, { name: 'guild', now: 0 });
  discord = new FakeDiscord({ guildId: GUILD, botHighestRolePosition: 100 });
  pipeline = buildPipeline();
  // Exactly what the discord.js adapter does in production: every gateway
  // event goes through the pipeline, allowlist gate and dedupe gate included.
  discord.onEvent(async (event) => {
    await pipeline.dispatch(event);
  });
  nextMessageId = 900_000_000_000_000_000n;
  archiveRepo.enableChannel(scope, {
    channelId: CATEGORY,
    attachmentPolicy: 'none',
    now: 0,
    scopeKind: 'category',
  });
});

afterEach(() => {
  t.close();
});

describe('category-scoped archiving through the real pipeline', () => {
  it('archives a message in a plain channel covered only by a category row', async () => {
    const messageId = nextId();
    await discord.emitMessageCreate({
      channelId: CHANNEL,
      messageId,
      authorId: MEMBER,
      content: 'hello category',
      categoryId: CATEGORY,
    });

    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(1);
    const derived = archiveRepo.findChannel(scope, CHANNEL);
    expect(derived?.scopeKind).toBe('derived');
    expect(derived?.derivedFrom).toBe(CATEGORY);
  });

  it('archives a message in a thread whose parent is covered only by a category row', async () => {
    const messageId = nextId();
    await discord.emitMessageCreate({
      channelId: THREAD,
      parentChannelId: CHANNEL,
      messageId,
      authorId: MEMBER,
      content: 'hello thread',
      categoryId: CATEGORY,
    });

    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(1);
    expect(archiveRepo.findChannel(scope, CHANNEL)?.scopeKind).toBe('derived');
  });

  it('stops archiving the moment the channel leaves the category, derived row or no', async () => {
    await discord.emitMessageCreate({
      channelId: CHANNEL,
      messageId: nextId(),
      authorId: MEMBER,
      content: 'while covered',
      categoryId: CATEGORY,
    });
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(1);

    // The channel moved out of the category: the event carries no categoryId.
    await discord.emitMessageCreate({
      channelId: CHANNEL,
      messageId: nextId(),
      authorId: MEMBER,
      content: 'after moving out',
    });
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(1);

    // The history that accrued while covered is retained.
    expect(archiveRepo.findChannel(scope, CHANNEL)?.scopeKind).toBe('derived');
  });

  it('never archives a private thread, even under an enabled category', async () => {
    await discord.emitMessageCreate({
      channelId: THREAD,
      parentChannelId: CHANNEL,
      messageId: nextId(),
      authorId: MEMBER,
      content: 'secret',
      categoryId: CATEGORY,
      isPrivateThread: true,
    });
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(0);
    expect(archiveRepo.findChannel(scope, CHANNEL)).toBeUndefined();
  });

  it('disable-category removes the derived rows and their archived messages', async () => {
    await discord.emitMessageCreate({
      channelId: CHANNEL,
      messageId: nextId(),
      authorId: MEMBER,
      content: 'while covered',
      categoryId: CATEGORY,
    });
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(1);

    const result = archiveRepo.disableCategory(scope, CATEGORY);
    expect(result).toEqual({ outcome: 'disabled', messageCount: 1 });
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(0);

    // And with the category gone, the channel is out of scope again.
    await discord.emitMessageCreate({
      channelId: CHANNEL,
      messageId: nextId(),
      authorId: MEMBER,
      content: 'after disable',
      categoryId: CATEGORY,
    });
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(0);
  });
});
