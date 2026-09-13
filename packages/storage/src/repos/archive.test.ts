import { beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import {
  archiveAttachments,
  archiveMessageEdits,
  archiveMessages,
  modCaseEvents,
  modCases,
} from '../schema.js';
import { upsertGuild } from './guilds.js';
import {
  ARCHIVE_CASE_RETENTION_MS,
  ARCHIVE_DEFAULT_RETENTION_MS,
  caseClosedAt,
  countMessages,
  disableChannel,
  enableChannel,
  expireContent,
  findChannel,
  isChannelEnabled,
  linkToCase,
  listChannels,
  markPreserve,
  recordBulkDelete,
  recordDelete,
  recordEdit,
  setBackfillCursor,
  upsertMessage,
} from './archive.js';

/**
 * The archive repository against the real migrations.
 *
 * Veto tests (a) "a channel not in `archive_channels` produces no row" and
 * (b) "a channel in `log_excluded_channels` produces no row even if
 * archive-enabled" belong to Task 4's subscriber (`packages/core/src/archive/
 * subscriber.test.ts`): the vetoes live in the subscriber, not in this
 * repository, which enforces nothing beyond guild scope.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL_A = '444444444444444444';
const CHANNEL_B = '444444444444444445';
const MEMBER = '555555555555555555';

const DAY_MS = 24 * 60 * 60 * 1000;

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  upsertGuild(a, { name: 'guild-a', now: 0 });
  upsertGuild(b, { name: 'guild-b', now: 0 });
});

const enable = (scope: GuildScope, channelId: string) =>
  enableChannel(scope, { channelId, attachmentPolicy: 'none', now: 1000 });

const seedMessage = (
  scope: GuildScope,
  over: { messageId?: string; channelId?: string; content?: string; createdAt?: number } = {},
) => {
  const messageId = over.messageId ?? '666666666666666666';
  const channelId = over.channelId ?? CHANNEL_A;
  enable(scope, channelId);
  upsertMessage(scope, {
    messageId,
    channelId,
    authorId: MEMBER,
    content: over.content ?? 'hello',
    createdAt: over.createdAt ?? 2000,
    editedAt: undefined,
    attachments: [],
  });
  return messageId;
};

/** Seed a `mod_cases` row (and optionally one event) through raw inserts, never a mod writer. */
const seedCase = (
  scope: GuildScope,
  input: { caseId: string; status: 'open' | 'closed'; eventAt?: number; memberId?: string },
) => {
  t.db
    .insert(modCases)
    .values({
      guildId: scope.guildId,
      caseId: input.caseId,
      memberId: input.memberId ?? MEMBER,
      openedAt: 1000,
      status: input.status,
    })
    .run();
  if (input.eventAt !== undefined) {
    t.db
      .insert(modCaseEvents)
      .values({
        guildId: scope.guildId,
        eventId: `event-${input.caseId}`,
        caseId: input.caseId,
        ruleId: 'rule-1',
        memberId: MEMBER,
        at: input.eventAt,
        matchedCategory: 'test',
        matchedSnippet: 'snippet',
        actionTaken: 'note',
      })
      .run();
  }
};

const readMessage = (scope: GuildScope, messageId: string) =>
  t.db
    .select()
    .from(archiveMessages)
    .where(
      and(eq(archiveMessages.guildId, scope.guildId), eq(archiveMessages.messageId, messageId)),
    )
    .get();

const readEdits = (scope: GuildScope, messageId: string) =>
  t.db
    .select()
    .from(archiveMessageEdits)
    .where(
      and(
        eq(archiveMessageEdits.guildId, scope.guildId),
        eq(archiveMessageEdits.messageId, messageId),
      ),
    )
    .orderBy(asc(archiveMessageEdits.editSeq))
    .all();

const readAttachments = (scope: GuildScope, messageId: string) =>
  t.db
    .select()
    .from(archiveAttachments)
    .where(
      and(
        eq(archiveAttachments.guildId, scope.guildId),
        eq(archiveAttachments.messageId, messageId),
      ),
    )
    .all();

describe('channel lifecycle', () => {
  it('enableChannel twice yields enabled then already-enabled; disable removes it and cascades', () => {
    expect(enable(a, CHANNEL_A)).toBe('enabled');
    expect(enable(a, CHANNEL_A)).toBe('already-enabled');
    expect(isChannelEnabled(a, CHANNEL_A)).toBe(true);

    seedMessage(a, { messageId: '666666666666666666' });
    expect(countMessages(a, CHANNEL_A)).toBe(1);

    expect(disableChannel(a, CHANNEL_A)).toBe('disabled');
    expect(isChannelEnabled(a, CHANNEL_A)).toBe(false);
    expect(countMessages(a, CHANNEL_A)).toBe(0);
    expect(disableChannel(a, CHANNEL_A)).toBe('not-enabled');
  });

  it('listChannels is ordered by channelId; findChannel reflects the backfill cursor', () => {
    enable(a, CHANNEL_B);
    enable(a, CHANNEL_A);
    expect(listChannels(a).map((c) => c.channelId)).toEqual([CHANNEL_A, CHANNEL_B]);

    const before = findChannel(a, CHANNEL_A);
    expect(before).toMatchObject({
      channelId: CHANNEL_A,
      attachmentPolicy: 'none',
      backfillState: 'pending',
    });
    expect(before?.cursorMessageId).toBeUndefined();

    setBackfillCursor(a, {
      channelId: CHANNEL_A,
      cursorMessageId: '777777777777777777',
      state: 'running',
    });
    expect(findChannel(a, CHANNEL_A)).toMatchObject({
      cursorMessageId: '777777777777777777',
      backfillState: 'running',
    });

    setBackfillCursor(a, { channelId: CHANNEL_A, cursorMessageId: undefined, state: 'done' });
    const done = findChannel(a, CHANNEL_A);
    expect(done?.cursorMessageId).toBeUndefined();
    expect(done?.backfillState).toBe('done');

    expect(findChannel(a, '888888888888888888')).toBeUndefined();
  });

  it('countMessages counts one channel only', () => {
    enable(a, CHANNEL_A);
    enable(a, CHANNEL_B);
    upsertMessage(a, {
      messageId: '666666666666666666',
      channelId: CHANNEL_A,
      authorId: MEMBER,
      content: 'one',
      createdAt: 2000,
      editedAt: undefined,
      attachments: [],
    });
    upsertMessage(a, {
      messageId: '777777777777777777',
      channelId: CHANNEL_B,
      authorId: MEMBER,
      content: 'two',
      createdAt: 2000,
      editedAt: undefined,
      attachments: [],
    });
    expect(countMessages(a, CHANNEL_A)).toBe(1);
    expect(countMessages(a, CHANNEL_B)).toBe(1);
  });
});

describe('messages, edits, deletes', () => {
  it('upsertMessage twice returns true then false and keeps the first content', () => {
    enable(a, CHANNEL_A);
    const input = {
      messageId: '666666666666666666',
      channelId: CHANNEL_A,
      authorId: MEMBER,
      createdAt: 2000,
      editedAt: undefined as number | undefined,
      attachments: [],
    };
    expect(upsertMessage(a, { ...input, content: 'first' })).toBe(true);
    expect(upsertMessage(a, { ...input, content: 'second' })).toBe(false);
    expect(readMessage(a, input.messageId)?.content).toBe('first');
  });

  it('recordEdit appends edit_seq 1 then 2 holding the previous contents', () => {
    const messageId = seedMessage(a, { content: 'v0' });
    expect(recordEdit(a, { messageId, content: 'v1', editedAt: 3000 })).toBe('recorded');
    expect(recordEdit(a, { messageId, content: 'v2', editedAt: 4000 })).toBe('recorded');
    expect(readMessage(a, messageId)?.content).toBe('v2');
    expect(readMessage(a, messageId)?.editedAt).toBe(4000);
    const edits = readEdits(a, messageId);
    expect(edits.map((e) => [e.editSeq, e.content])).toEqual([
      [1, 'v0'],
      [2, 'v1'],
    ]);
    expect(recordEdit(a, { messageId: '999999999999999999', content: 'x', editedAt: 1 })).toBe(
      'no-such-message',
    );
  });

  it('recordDelete marks once; recordBulkDelete marks only the live rows', () => {
    enable(a, CHANNEL_A);
    const live = '666666666666666666';
    const deleted = '777777777777777777';
    for (const messageId of [live, deleted]) {
      upsertMessage(a, {
        messageId,
        channelId: CHANNEL_A,
        authorId: MEMBER,
        content: 'c',
        createdAt: 2000,
        editedAt: undefined,
        attachments: [],
      });
    }
    expect(recordDelete(a, { messageId: '999999999999999999', deletedAt: 3000 })).toBe(
      'no-such-message',
    );
    expect(recordDelete(a, { messageId: deleted, deletedAt: 3000 })).toBe('recorded');
    expect(recordDelete(a, { messageId: deleted, deletedAt: 4000 })).toBe('already-deleted');
    expect(readMessage(a, deleted)?.deletedAt).toBe(3000);

    expect(
      recordBulkDelete(a, { messageIds: [live, deleted, '999999999999999999'], deletedAt: 5000 }),
    ).toBe(1);
    expect(readMessage(a, live)?.deletedAt).toBe(5000);
  });
});

describe('preserve and case link', () => {
  it('markPreserve wins over every class and reports repeats', () => {
    const messageId = seedMessage(a);
    expect(markPreserve(a, messageId)).toBe('preserved');
    expect(markPreserve(a, messageId)).toBe('already-preserved');
    expect(readMessage(a, messageId)?.retentionClass).toBe('preserve');
    expect(markPreserve(a, '999999999999999999')).toBe('no-such-message');
  });

  it('markPreserve promotes a case row to preserve', () => {
    const messageId = seedMessage(a);
    seedCase(a, { caseId: 'case-1', status: 'open' });
    expect(linkToCase(a, { messageId, caseId: 'case-1' })).toBe('linked');
    expect(markPreserve(a, messageId)).toBe('preserved');
    expect(readMessage(a, messageId)?.retentionClass).toBe('preserve');
  });

  it('linkToCase validates the message, the case and the current class', () => {
    const messageId = seedMessage(a);
    seedCase(a, { caseId: 'case-open', status: 'open', memberId: '600000000000000001' });
    seedCase(a, { caseId: 'case-closed', status: 'closed', eventAt: 1000 });

    expect(linkToCase(a, { messageId: '999999999999999999', caseId: 'case-open' })).toBe(
      'no-such-message',
    );
    expect(linkToCase(a, { messageId, caseId: 'case-missing' })).toBe('no-such-case');
    expect(linkToCase(a, { messageId, caseId: 'case-closed' })).toBe('case-closed');
    expect(linkToCase(a, { messageId, caseId: 'case-open' })).toBe('linked');
    expect(readMessage(a, messageId)?.retentionClass).toBe('case');
    expect(linkToCase(a, { messageId, caseId: 'case-open' })).toBe('already-linked');

    const preserved = seedMessage(a, { messageId: '777777777777777777' });
    seedCase(a, { caseId: 'case-other', status: 'open', memberId: '600000000000000002' });
    expect(markPreserve(a, preserved)).toBe('preserved');
    expect(linkToCase(a, { messageId: preserved, caseId: 'case-other' })).toBe('preserved');
    expect(readMessage(a, preserved)?.retentionClass).toBe('preserve');
  });

  it('caseClosedAt is the latest event at for a closed case, else undefined', () => {
    seedCase(a, { caseId: 'case-open', status: 'open', eventAt: 1000 });
    expect(caseClosedAt(a, 'case-open')).toBeUndefined();
    expect(caseClosedAt(a, 'case-missing')).toBeUndefined();

    seedCase(a, { caseId: 'case-closed', status: 'closed', eventAt: 5000 });
    t.db
      .insert(modCaseEvents)
      .values({
        guildId: a.guildId,
        eventId: 'event-case-closed-2',
        caseId: 'case-closed',
        ruleId: 'rule-1',
        memberId: MEMBER,
        at: 7000,
        matchedCategory: 'test',
        matchedSnippet: 'snippet',
        actionTaken: 'note',
      })
      .run();
    expect(caseClosedAt(a, 'case-closed')).toBe(7000);

    seedCase(a, { caseId: 'case-closed-quiet', status: 'closed' });
    expect(caseClosedAt(a, 'case-closed-quiet')).toBe(1000);
  });
});

describe('expiry — the three tiers', () => {
  it('a default deleted message purges at deletedAt + 30d, not 1ms before', () => {
    expect(ARCHIVE_DEFAULT_RETENTION_MS).toBe(30 * DAY_MS);
    const messageId = seedMessage(a, { content: 'doomed' });
    recordEdit(a, { messageId, content: 'doomed v2', editedAt: 2500 });
    upsertMessage(a, {
      messageId: '777777777777777777',
      channelId: CHANNEL_A,
      authorId: MEMBER,
      content: 'with files',
      createdAt: 2000,
      editedAt: undefined,
      attachments: [
        {
          attachmentId: '888888888888888888',
          filename: 'notes.txt',
          contentType: 'text/plain',
          size: 12,
        },
      ],
    });
    const deletedAt = 10_000;
    expect(recordDelete(a, { messageId, deletedAt })).toBe('recorded');
    expect(recordDelete(a, { messageId: '777777777777777777', deletedAt })).toBe('recorded');

    expect(expireContent(a, deletedAt + ARCHIVE_DEFAULT_RETENTION_MS - 1)).toBe(0);
    expect(readMessage(a, messageId)?.content).toBe('doomed v2');

    expect(expireContent(a, deletedAt + ARCHIVE_DEFAULT_RETENTION_MS)).toBe(2);
    const purged = readMessage(a, messageId);
    expect(purged?.content).toBeNull();
    expect(purged?.contentPurgedAt).toBe(deletedAt + ARCHIVE_DEFAULT_RETENTION_MS);
    // The tombstone stays; the history and the file metadata go with the content.
    expect(readMessage(a, messageId)).toBeDefined();
    expect(readEdits(a, messageId)).toEqual([]);
    expect(readAttachments(a, '777777777777777777')).toEqual([]);

    // Already purged rows are not counted again.
    expect(expireContent(a, deletedAt + ARCHIVE_DEFAULT_RETENTION_MS + 1)).toBe(0);
  });

  it('a deleted attachment-only row (content NULL) still purges its files and stamps the purge', () => {
    enable(a, CHANNEL_A);
    upsertMessage(a, {
      messageId: '666666666666666666',
      channelId: CHANNEL_A,
      authorId: MEMBER,
      content: undefined,
      createdAt: 2000,
      editedAt: undefined,
      attachments: [
        {
          attachmentId: '888888888888888888',
          filename: 'pic.png',
          contentType: 'image/png',
          size: 1234,
        },
      ],
    });
    const deletedAt = 10_000;
    expect(recordDelete(a, { messageId: '666666666666666666', deletedAt })).toBe('recorded');

    expect(expireContent(a, deletedAt + ARCHIVE_DEFAULT_RETENTION_MS - 1)).toBe(0);
    expect(readAttachments(a, '666666666666666666')).toHaveLength(1);

    expect(expireContent(a, deletedAt + ARCHIVE_DEFAULT_RETENTION_MS)).toBe(1);
    expect(readAttachments(a, '666666666666666666')).toEqual([]);
    const purged = readMessage(a, '666666666666666666');
    expect(purged?.content).toBeNull();
    expect(purged?.contentPurgedAt).toBe(deletedAt + ARCHIVE_DEFAULT_RETENTION_MS);

    // Already purged rows are not re-processed.
    expect(expireContent(a, deletedAt + ARCHIVE_DEFAULT_RETENTION_MS + 1)).toBe(0);
  });

  it('live messages never purge, however old', () => {
    seedMessage(a, { content: 'alive' });
    expect(expireContent(a, 2000 + 400 * DAY_MS)).toBe(0);
    expect(readMessage(a, '666666666666666666')?.content).toBe('alive');
  });

  it('a case-class message survives while the case is open and purges 90d after it closes', () => {
    expect(ARCHIVE_CASE_RETENTION_MS).toBe(90 * DAY_MS);
    const messageId = seedMessage(a, { content: 'evidence' });
    seedCase(a, { caseId: 'case-1', status: 'open' });
    expect(linkToCase(a, { messageId, caseId: 'case-1' })).toBe('linked');
    const deletedAt = 10_000;
    expect(recordDelete(a, { messageId, deletedAt })).toBe('recorded');

    expect(expireContent(a, deletedAt + 400 * DAY_MS)).toBe(0);
    expect(readMessage(a, messageId)?.content).toBe('evidence');

    // The case closes; its latest event at T starts the 90-day clock.
    const closedAt = deletedAt + 500 * DAY_MS;
    t.db
      .update(modCases)
      .set({ status: 'closed' })
      .where(and(eq(modCases.guildId, a.guildId), eq(modCases.caseId, 'case-1')))
      .run();
    t.db
      .insert(modCaseEvents)
      .values({
        guildId: a.guildId,
        eventId: 'event-case-1-close',
        caseId: 'case-1',
        ruleId: 'rule-1',
        memberId: MEMBER,
        at: closedAt,
        matchedCategory: 'test',
        matchedSnippet: 'snippet',
        actionTaken: 'note',
      })
      .run();

    expect(expireContent(a, closedAt + ARCHIVE_CASE_RETENTION_MS - 1)).toBe(0);
    expect(expireContent(a, closedAt + ARCHIVE_CASE_RETENTION_MS)).toBe(1);
    expect(readMessage(a, messageId)?.content).toBeNull();
  });

  it('a case-class message on a closed case with no events purges 90d after the case opened', () => {
    const messageId = seedMessage(a, { content: 'quiet evidence' });
    // `seedCase` opens the row at `openedAt: 1000`; no events are seeded.
    seedCase(a, { caseId: 'case-quiet', status: 'open' });
    expect(linkToCase(a, { messageId, caseId: 'case-quiet' })).toBe('linked');
    const deletedAt = 10_000;
    expect(recordDelete(a, { messageId, deletedAt })).toBe('recorded');

    // While the case is open, nothing purges.
    expect(expireContent(a, 1000 + ARCHIVE_CASE_RETENTION_MS)).toBe(0);
    expect(readMessage(a, messageId)?.content).toBe('quiet evidence');

    // The case closes with no events: the 90-day clock starts at `openedAt`.
    t.db
      .update(modCases)
      .set({ status: 'closed' })
      .where(and(eq(modCases.guildId, a.guildId), eq(modCases.caseId, 'case-quiet')))
      .run();
    expect(expireContent(a, 1000 + ARCHIVE_CASE_RETENTION_MS - 1)).toBe(0);
    expect(readMessage(a, messageId)?.content).toBe('quiet evidence');
    expect(expireContent(a, 1000 + ARCHIVE_CASE_RETENTION_MS)).toBe(1);
    expect(readMessage(a, messageId)?.content).toBeNull();
  });

  it('preserve never purges, not even after ten years', () => {
    const messageId = seedMessage(a, { content: 'keep forever' });
    expect(markPreserve(a, messageId)).toBe('preserved');
    expect(recordDelete(a, { messageId, deletedAt: 10_000 })).toBe('recorded');
    expect(expireContent(a, 10_000 + 10 * 365 * DAY_MS)).toBe(0);
    expect(readMessage(a, messageId)?.content).toBe('keep forever');
  });
});

describe('two guilds with colliding ids', () => {
  it('every read and write under A leaves B untouched and invisible', () => {
    enable(a, CHANNEL_A);
    enable(b, CHANNEL_A);
    enable(b, CHANNEL_B);
    const messageId = '666666666666666666';
    const input = {
      messageId,
      channelId: CHANNEL_A,
      authorId: MEMBER,
      content: 'guild b row',
      createdAt: 2000,
      editedAt: undefined as number | undefined,
      attachments: [],
    };
    expect(upsertMessage(b, input)).toBe(true);

    // The same id is new in the other guild.
    expect(upsertMessage(a, { ...input, content: 'guild a row' })).toBe(true);
    expect(readMessage(a, messageId)?.content).toBe('guild a row');
    expect(readMessage(b, messageId)?.content).toBe('guild b row');

    // A-scoped reads see only A.
    expect(listChannels(a).map((c) => c.channelId)).toEqual([CHANNEL_A]);
    expect(listChannels(b).map((c) => c.channelId)).toEqual([CHANNEL_A, CHANNEL_B]);
    expect(countMessages(a, CHANNEL_A)).toBe(1);
    expect(countMessages(b, CHANNEL_A)).toBe(1);
    expect(findChannel(a, CHANNEL_B)).toBeUndefined();
    expect(findChannel(b, CHANNEL_B)).toBeDefined();

    // Deleting under A does not mark B's row.
    expect(recordDelete(a, { messageId, deletedAt: 3000 })).toBe('recorded');
    expect(readMessage(b, messageId)?.deletedAt).toBeNull();
    expect(recordDelete(b, { messageId, deletedAt: 4000 })).toBe('recorded');

    // Expiry under A purges only A's row.
    expect(expireContent(a, 3000 + ARCHIVE_DEFAULT_RETENTION_MS)).toBe(1);
    expect(readMessage(b, messageId)?.content).toBe('guild b row');
  });
});
