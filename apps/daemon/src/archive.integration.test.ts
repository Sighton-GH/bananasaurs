import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  createArchiveSubscriber,
  parseGuildId,
  parseSnowflakeId,
  Pipeline,
  type ArchivePorts,
} from '@bananasaurs/core';
import {
  archiveRepo,
  guildRepo,
  loggingRepo,
  pipelineRepo,
  read,
  schema,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { FakeDiscord } from '@bananasaurs/testkit';

/**
 * Archive ingestion, end to end on the fake gateway (Slice M1 Task 4).
 *
 * The pipeline dispatches real `messageCreate` / `messageUpdate` /
 * `messageDelete` / `messageDeleteBulk` events through the same gates
 * production uses (allowlist, event dedupe) into `createArchiveSubscriber`
 * wired to the real `archiveRepo` — every layer except the discord.js
 * adapter itself. Mirrors `automod.integration.test.ts`'s exact setup style:
 * fixed snowflakes, `openMigratedTestDatabase`, a real `Pipeline`, and a
 * `buildPipeline` helper; `seedRule` has no analogue here.
 *
 * What this proves that the unit tests
 * (`packages/core/src/archive/subscriber.test.ts`) cannot: that the three
 * vetoes and the four events agree with the real repository, the real
 * pipeline dedupe (a replayed create stays one row), and the guild
 * allowlist closing over `BANANASAURS_ARCHIVE_GUILDS`.
 */

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = parseSnowflakeId('222222222222222222');
const MEMBER = parseSnowflakeId('444444444444444444');

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;
let pipeline: Pipeline;
let nextMessageId: bigint;

/**
 * Wires the archive subscriber onto the pipeline the way `guild.ts` does:
 * ports closed over the real repos, the guild veto as a plain boolean the
 * caller sets (production reads
 * `config.BANANASAURS_ARCHIVE_GUILDS.includes(guildId)`).
 */
const buildPipeline = (guildArchiveEnabled: boolean): Pipeline => {
  const ports: ArchivePorts = {
    guildArchiveEnabled,
    isChannelEnabled: (channelId) => archiveRepo.isChannelEnabled(scope, channelId),
    hasCategoryRow: (channelId) => archiveRepo.hasCategoryRow(scope, channelId),
    hasPausedOwnRow: (channelId) => archiveRepo.hasPausedOwnRow(scope, channelId),
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

/** Registers a fake message and dispatches it as a real `messageCreate`. */
const sendMessage = async (messageId: string, content: string): Promise<void> => {
  discord.defineMessage({ channelId: CHANNEL, messageId, authorId: MEMBER });
  await discord.emitMessageCreate({ channelId: CHANNEL, messageId, authorId: MEMBER, content });
};

const nextId = (): string => {
  nextMessageId += 1n;
  return nextMessageId.toString();
};

const findMessage = (messageId: string) =>
  read(scope, (db) =>
    db
      .select()
      .from(schema.archiveMessages)
      .where(scope.only(schema.archiveMessages))
      .all()
      .find((row) => row.messageId === messageId),
  );

const editRowsFor = (messageId: string) =>
  read(scope, (db) =>
    db
      .select()
      .from(schema.archiveMessageEdits)
      .where(scope.only(schema.archiveMessageEdits))
      .all()
      .filter((row) => row.messageId === messageId),
  );

beforeEach(() => {
  nextMessageId = 100_000_000_000_000_000n;
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);

  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });

  discord = new FakeDiscord({ guildId: GUILD, botHighestRolePosition: 100 });

  pipeline = buildPipeline(true);
  // Exactly what the discord.js adapter will do in production: every gateway
  // event goes through the pipeline, allowlist gate and dedupe gate included.
  discord.onEvent(async (event) => {
    await pipeline.dispatch(event);
  });
});

afterEach(() => {
  t.close();
});

describe('archive ingestion, end to end on the fake gateway', () => {
  it('archives a create, records its edit, then its deletion', async () => {
    archiveRepo.enableChannel(scope, {
      channelId: CHANNEL,
      attachmentPolicy: 'none',
      now: discord.now(),
    });
    const messageId = nextId();

    await sendMessage(messageId, 'first words');
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(1);
    expect(findMessage(messageId)?.content).toBe('first words');

    await discord.emitMessageUpdate({
      channelId: CHANNEL,
      messageId,
      authorId: MEMBER,
      content: 'second thoughts',
      editedTimestampMs: discord.now(),
    });
    expect(findMessage(messageId)?.content).toBe('second thoughts');
    const edits = editRowsFor(messageId);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.content).toBe('first words');

    await discord.emitMessageDelete({ channelId: CHANNEL, messageId, authorId: MEMBER });
    expect(findMessage(messageId)?.deletedAt).not.toBeNull();
  });

  it('marks both messages on a bulk delete', async () => {
    archiveRepo.enableChannel(scope, {
      channelId: CHANNEL,
      attachmentPolicy: 'none',
      now: discord.now(),
    });
    const first = nextId();
    const second = nextId();
    await sendMessage(first, 'one');
    await sendMessage(second, 'two');

    await discord.emitMessageDeleteBulk({ channelId: CHANNEL, messageIds: [first, second] });

    expect(findMessage(first)?.deletedAt).not.toBeNull();
    expect(findMessage(second)?.deletedAt).not.toBeNull();
  });

  it('keeps one row when the same create is replayed', async () => {
    archiveRepo.enableChannel(scope, {
      channelId: CHANNEL,
      attachmentPolicy: 'none',
      now: discord.now(),
    });
    const messageId = nextId();
    await sendMessage(messageId, 'original');

    // A gateway replay of the identical dispatch: the pipeline dedupe drops
    // it, and the upsert would no-op even if it arrived — still one row.
    discord.defineMessage({ channelId: CHANNEL, messageId, authorId: MEMBER });
    await discord.emitMessageCreate({
      channelId: CHANNEL,
      messageId,
      authorId: MEMBER,
      content: 'original',
    });

    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(1);
    expect(findMessage(messageId)?.content).toBe('original');
  });

  it('writes nothing when the guild is not in BANANASAURS_ARCHIVE_GUILDS', async () => {
    archiveRepo.enableChannel(scope, {
      channelId: CHANNEL,
      attachmentPolicy: 'none',
      now: discord.now(),
    });
    // The same wiring with the guild veto closed over `false`, as production
    // holds when the guild is absent from the config list.
    pipeline = buildPipeline(false);
    discord.onEvent(async (event) => {
      await pipeline.dispatch(event);
    });
    const messageId = nextId();
    const second = nextId();

    await sendMessage(messageId, 'should not land');
    await discord.emitMessageUpdate({
      channelId: CHANNEL,
      messageId,
      authorId: MEMBER,
      content: 'still should not land',
      editedTimestampMs: discord.now(),
    });
    await discord.emitMessageDelete({ channelId: CHANNEL, messageId, authorId: MEMBER });
    await sendMessage(second, 'also not');
    await discord.emitMessageDeleteBulk({ channelId: CHANNEL, messageIds: [second] });

    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(0);
  });

  it('writes nothing for a channel that was never enabled', async () => {
    const messageId = nextId();

    await sendMessage(messageId, 'unscoped chatter');

    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(0);
  });
});
