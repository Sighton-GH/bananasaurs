import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { DomainEvent, MessageEvent } from '../discord/events.js';
import { createArchiveSubscriber } from './subscriber.js';
import type { ArchivePorts, UpsertMessageInput } from './ports.js';

/**
 * Unit tests for the archive subscriber's three vetoes and four events
 * (ADR 0046 D1 + D5, Slice M1 Task 4).
 *
 * Every port is hand-rolled: a Map-backed store with a call list, asserted
 * on directly — no mocks. Nothing touches a real database or Discord.
 */

const GUILD = '111111111111111111';
const CHANNEL = '333333333333333333';
const OTHER_CHANNEL = '444444444444444444';
const MESSAGE = '555555555555555555';
const AUTHOR = '222222222222222222';
const NOW_MS = 1_700_000_000_000;

/** A real pino instance over a captured stream, at debug — the subscriber's logs are debug. */
const capturingLogger = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return {
    logger: pino({ level: 'debug' }, stream),
    lines,
    messages(): readonly { level: number; msg?: string; messageId?: string; channelId?: string }[] {
      return lines.map((l) => JSON.parse(l) as { level: number; msg?: string });
    },
  };
};

interface FakeOptions {
  guildArchiveEnabled?: boolean;
  enabledChannels?: readonly string[];
  excludedChannels?: readonly string[];
  categoryRows?: readonly string[];
  includeThreads?: Readonly<Record<string, boolean>>;
}

/** Hand-rolled fake `ArchivePorts`: a Map-backed store plus a call list. */
const fakePorts = (over: FakeOptions = {}) => {
  const messages = new Map<string, UpsertMessageInput & { deletedAt: number | undefined }>();
  const calls: Array<{ method: string; input: unknown }> = [];
  const enabled = new Set(over.enabledChannels ?? [CHANNEL]);
  const excluded = new Set(over.excludedChannels ?? []);
  const categories = new Set(over.categoryRows ?? []);
  const capture = capturingLogger();
  const ports: ArchivePorts = {
    guildArchiveEnabled: over.guildArchiveEnabled ?? true,
    isChannelEnabled: (channelId) => enabled.has(channelId),
    hasCategoryRow: (channelId) => categories.has(channelId),
    parentIncludesThreads: (channelId) => over.includeThreads?.[channelId] ?? true,
    isChannelExcluded: (channelId) => excluded.has(channelId),
    upsertMessage: (input) => {
      calls.push({ method: 'upsertMessage', input });
      if (messages.has(input.messageId)) return false;
      messages.set(input.messageId, { ...input, deletedAt: undefined });
      return true;
    },
    recordEdit: (input) => {
      calls.push({ method: 'recordEdit', input });
      const current = messages.get(input.messageId);
      if (current === undefined) return 'no-such-message';
      messages.set(input.messageId, {
        ...current,
        content: input.content,
        editedAt: input.editedAt,
      });
      return 'recorded';
    },
    recordDelete: (input) => {
      calls.push({ method: 'recordDelete', input });
      const current = messages.get(input.messageId);
      if (current === undefined) return 'no-such-message';
      if (current.deletedAt !== undefined) return 'already-deleted';
      messages.set(input.messageId, { ...current, deletedAt: input.deletedAt });
      return 'recorded';
    },
    recordBulkDelete: (input) => {
      calls.push({ method: 'recordBulkDelete', input });
      let marked = 0;
      for (const messageId of input.messageIds) {
        const current = messages.get(messageId);
        if (current === undefined || current.deletedAt !== undefined) continue;
        messages.set(messageId, { ...current, deletedAt: input.deletedAt });
        marked += 1;
      }
      return marked;
    },
    logger: capture.logger,
  };
  return { ports, messages, calls, lines: capture.lines, logged: () => capture.messages() };
};

const messageCreate = (over: Partial<MessageEvent> = {}): DomainEvent => ({
  kind: 'messageCreate',
  guildId: GUILD,
  receivedAtMs: NOW_MS,
  channelId: CHANNEL,
  parentChannelId: undefined,
  categoryId: undefined,
  isPrivateThread: false,
  messageId: MESSAGE,
  authorId: AUTHOR,
  authorDisplayName: undefined,
  authorIsBot: false,
  content: 'hello',
  editedTimestampMs: undefined,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  ...over,
});

describe('archive subscriber vetoes', () => {
  it('ignores a create in a channel that is not enabled', async () => {
    const f = fakePorts({ enabledChannels: [] });
    const subscriber = createArchiveSubscriber(f.ports);

    await subscriber.handle(messageCreate());

    expect(f.calls).toEqual([]);
    expect(subscriber.name).toBe('archive');
  });

  it('ignores a create in a channel that is enabled but excluded', async () => {
    const f = fakePorts({ excludedChannels: [CHANNEL] });
    const subscriber = createArchiveSubscriber(f.ports);

    await subscriber.handle(messageCreate());

    expect(f.calls).toEqual([]);
  });

  it('writes nothing when the guild is not in BANANASAURS_ARCHIVE_GUILDS', async () => {
    const f = fakePorts({ guildArchiveEnabled: false });
    const subscriber = createArchiveSubscriber(f.ports);

    await subscriber.handle(messageCreate());

    expect(f.calls).toEqual([]);
  });

  it('ignores a bulk delete in a channel that is not enabled', async () => {
    const f = fakePorts({ enabledChannels: [] });
    const subscriber = createArchiveSubscriber(f.ports);

    await subscriber.handle({
      kind: 'messageDeleteBulk',
      guildId: GUILD,
      receivedAtMs: NOW_MS,
      channelId: CHANNEL,
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      messageIds: [MESSAGE],
    });

    expect(f.calls).toEqual([]);
  });

  it('ignores an event kind the archive does not handle', async () => {
    const f = fakePorts();
    const subscriber = createArchiveSubscriber(f.ports);

    await subscriber.handle({
      kind: 'reactionAdd',
      guildId: GUILD,
      receivedAtMs: NOW_MS,
      channelId: CHANNEL,
      messageId: MESSAGE,
      userId: AUTHOR,
      emoji: '👍',
      wasPartial: false,
    });

    expect(f.calls).toEqual([]);
  });
});

describe('archive subscriber ingestion', () => {
  it('archives public threads and forum posts under the authorized parent', async () => {
    const f = fakePorts({ enabledChannels: ['P'] });
    await createArchiveSubscriber(f.ports).handle(
      messageCreate({ channelId: 'T', parentChannelId: 'P', messageId: 'm1' }),
    );
    expect(f.calls[0]?.input).toMatchObject({ channelId: 'P', threadId: 'T', messageId: 'm1' });
  });

  it('never archives a private thread inherited from its parent', async () => {
    const f = fakePorts({ enabledChannels: ['P'] });
    await createArchiveSubscriber(f.ports).handle(
      messageCreate({ channelId: 'T', parentChannelId: 'P', isPrivateThread: true }),
    );
    expect(f.calls).toHaveLength(0);
  });

  it('does not inherit archive scope when include_threads is off', async () => {
    const f = fakePorts({ enabledChannels: ['P'], includeThreads: { P: false } });
    await createArchiveSubscriber(f.ports).handle(
      messageCreate({ channelId: 'T', parentChannelId: 'P' }),
    );
    expect(f.calls).toHaveLength(0);
  });

  it('inherits an enabled category dynamically', async () => {
    const f = fakePorts({ enabledChannels: [], categoryRows: ['CAT'] });
    await createArchiveSubscriber(f.ports).handle(
      messageCreate({ channelId: 'C', categoryId: 'CAT' }),
    );
    expect(f.calls).toHaveLength(1);
  });
  it('upserts a create with content, author, timestamps and mapped attachments', async () => {
    const f = fakePorts();
    const subscriber = createArchiveSubscriber(f.ports);

    await subscriber.handle(
      messageCreate({
        content: 'hello',
        editedTimestampMs: NOW_MS + 5_000,
        attachments: [
          {
            attachmentId: '666666666666666666',
            fileName: 'pic.png',
            contentType: 'image/png',
            sizeBytes: 1234,
          },
        ],
      }),
    );

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.method).toBe('upsertMessage');
    expect(f.calls[0]?.input).toEqual({
      messageId: MESSAGE,
      channelId: CHANNEL,
      authorId: AUTHOR,
      content: 'hello',
      createdAt: NOW_MS,
      editedAt: NOW_MS + 5_000,
      attachments: [
        {
          attachmentId: '666666666666666666',
          filename: 'pic.png',
          contentType: 'image/png',
          size: 1234,
        },
      ],
    });
  });

  it('skips an attachment with no attachmentId and says so at debug', async () => {
    const f = fakePorts();
    const subscriber = createArchiveSubscriber(f.ports);

    // PR-71: only fixture-derived attachments lack an id; the live adapter
    // and FakeDiscord always populate it. Absence means "none" — skip it.
    await subscriber.handle(
      messageCreate({
        attachments: [{ fileName: 'ghost.png', contentType: undefined, sizeBytes: 10 }],
      }),
    );

    expect(f.calls).toHaveLength(1);
    const input = f.calls[0]?.input as UpsertMessageInput;
    expect(input.attachments).toEqual([]);
    const skipped = f.logged().find((l) => l.msg === 'archive: attachment without id, skipped');
    expect(skipped?.messageId).toBe(MESSAGE);
  });

  it('archives bot-authored messages too — the archive is a record, not a filter', async () => {
    const f = fakePorts();
    const subscriber = createArchiveSubscriber(f.ports);

    await subscriber.handle(messageCreate({ authorIsBot: true, content: 'beep' }));

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.method).toBe('upsertMessage');
  });

  it('records an edit, falling back to receivedAtMs without an edit timestamp', async () => {
    const f = fakePorts();
    const subscriber = createArchiveSubscriber(f.ports);
    await subscriber.handle(messageCreate({ content: 'before' }));

    await subscriber.handle(
      messageCreate({ kind: 'messageUpdate', content: 'after', editedTimestampMs: undefined }),
    );

    const edit = f.calls.find((c) => c.method === 'recordEdit');
    expect(edit?.input).toEqual({ messageId: MESSAGE, content: 'after', editedAt: NOW_MS });
  });

  it('inserts on an edit to an unknown message — it predates enablement', async () => {
    const f = fakePorts();
    const subscriber = createArchiveSubscriber(f.ports);

    await subscriber.handle(
      messageCreate({ kind: 'messageUpdate', content: 'full content on update' }),
    );

    expect(f.calls.map((c) => c.method)).toEqual(['recordEdit', 'upsertMessage']);
    expect(f.messages.get(MESSAGE)?.content).toBe('full content on update');
    const inserted = f.logged().find((l) => l.msg === 'archive: edit to unknown message, inserted');
    expect(inserted?.messageId).toBe(MESSAGE);
    expect(inserted?.channelId).toBe(CHANNEL);
  });

  it('records a delete; an unknown message is silent', async () => {
    const f = fakePorts();
    const subscriber = createArchiveSubscriber(f.ports);
    await subscriber.handle(messageCreate({ content: 'doomed' }));

    await subscriber.handle({
      kind: 'messageDelete',
      guildId: GUILD,
      receivedAtMs: NOW_MS + 1_000,
      channelId: CHANNEL,
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      messageId: MESSAGE,
      authorId: AUTHOR,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: undefined,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      mentionedRoleIds: [],
      mentionsEveryone: false,
      attachments: [],
    });

    const deletion = f.calls.find((c) => c.method === 'recordDelete');
    expect(deletion?.input).toEqual({ messageId: MESSAGE, deletedAt: NOW_MS + 1_000 });

    // A message we never held: silent, no insert, no throw.
    const before = f.calls.length;
    await subscriber.handle({
      kind: 'messageDelete',
      guildId: GUILD,
      receivedAtMs: NOW_MS + 2_000,
      channelId: CHANNEL,
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      messageId: OTHER_CHANNEL,
      authorId: undefined,
      authorDisplayName: undefined,
      authorIsBot: false,
      content: undefined,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      mentionedRoleIds: [],
      mentionsEveryone: false,
      attachments: [],
    });
    expect(f.calls).toHaveLength(before + 1);
    expect(f.calls[before]?.method).toBe('recordDelete');
    expect(f.messages.has(OTHER_CHANNEL)).toBe(false);
  });

  it('records a bulk delete against the event channel', async () => {
    const f = fakePorts();
    const subscriber = createArchiveSubscriber(f.ports);
    const second = '777777777777777777';
    await subscriber.handle(messageCreate({ messageId: MESSAGE }));
    await subscriber.handle(messageCreate({ messageId: second }));

    await subscriber.handle({
      kind: 'messageDeleteBulk',
      guildId: GUILD,
      receivedAtMs: NOW_MS + 3_000,
      channelId: CHANNEL,
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      messageIds: [MESSAGE, second],
    });

    const bulk = f.calls.find((c) => c.method === 'recordBulkDelete');
    expect(bulk?.input).toEqual({
      messageIds: [MESSAGE, second],
      deletedAt: NOW_MS + 3_000,
    });
  });
});
