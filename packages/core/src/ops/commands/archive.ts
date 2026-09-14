import { z } from 'zod';
import { snowflakeIdSchema } from '../../ids.js';
import {
  defineCommand,
  type OpsCommandResult,
  type OpsContext,
  type OpsWriteResult,
} from '../dispatch.js';

/**
 * The `archive …` operator surface (ADR 0046, Slice M1 Task 6; search and
 * reindex from Slice M2 Task 4).
 *
 * Seven commands over the nine `OpsPorts` archive members: enabling a
 * channel (which queues its backfill), disabling one, listing the enabled
 * set, preserving a message, linking a message to a moderation case,
 * searching archived content, and rebuilding the search index.
 * Attachment bytes are refused at this layer (PR-67) — `bytes` never reaches
 * the port, so no later slice can mistake a stored `bytes` policy for one
 * this slice actually fetched.
 */

const channelIdArg = snowflakeIdSchema;
const messageIdArg = snowflakeIdSchema;

// --- archive enable-channel --------------------------------------------------

const archiveEnableChannelArgs = z.object({
  channelId: channelIdArg,
  attachments: z.enum(['none', 'bytes']).optional(),
});

export const archiveEnableChannelCommand = defineCommand<z.infer<typeof archiveEnableChannelArgs>>({
  name: 'archive enable-channel',
  write: true,
  summary: 'archive a channel going forward and backfill its history',
  positional: [{ name: 'channelId', required: true, describe: 'the channel to archive' }],
  flags: [
    {
      name: 'attachments',
      kind: 'string',
      describe: 'none (default) | bytes — bytes is not built yet and is refused',
    },
  ],
  args: archiveEnableChannelArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const attachmentPolicy = args.attachments ?? 'none';
    if (attachmentPolicy === 'bytes') {
      // PR-67: storing a `bytes` policy without a fetcher would promise file
      // contents the archive never downloaded. Refused here, before the port
      // is even called, so no test can observe a `bytes` row from this slice.
      return {
        text:
          'attachment bytes are not built yet: re-run with --attachments none ' +
          '(file name, type and size are still archived)',
        data: { ok: false, reason: 'attachments-bytes-not-built' },
        audit: {
          action: 'archive.channel_enabled',
          subjectType: 'archive_channel',
          subjectId: args.channelId,
          after: { outcome: 'attachments-bytes-not-built', channelId: args.channelId },
        },
      };
    }

    const outcome = ctx.ports.archiveEnableChannel({
      channelId: args.channelId,
      attachmentPolicy,
    });

    if (outcome === 'guild-not-archive-enabled') {
      return {
        text:
          `guild ${ctx.guildId} is not in BANANASAURS_ARCHIVE_GUILDS, ` +
          'so no channel here can be archived',
        data: {
          ok: false,
          reason: outcome,
          guildId: ctx.guildId,
          variable: 'BANANASAURS_ARCHIVE_GUILDS',
        },
        audit: {
          action: 'archive.channel_enabled',
          subjectType: 'archive_channel',
          subjectId: args.channelId,
          after: { outcome, channelId: args.channelId },
        },
      };
    }

    if (outcome === 'already-enabled') {
      // A usage answer, not a fault — but an audit row is still owed, the
      // way `automod verdict` audits a mistyped event id: an operator tried
      // to change archive scope and the trail should show it.
      return {
        text: `channel ${args.channelId} is already archived; nothing changed`,
        data: { ok: false, reason: outcome, channelId: args.channelId },
        audit: {
          action: 'archive.channel_enabled',
          subjectType: 'archive_channel',
          subjectId: args.channelId,
          after: { outcome, channelId: args.channelId },
        },
      };
    }

    ctx.ports.enqueueArchiveBackfill(args.channelId);
    return {
      text:
        `channel ${args.channelId} will be archived ` +
        `(attachments: ${attachmentPolicy}); backfill queued`,
      data: { ok: true, channelId: args.channelId, attachmentPolicy },
      audit: {
        action: 'archive.channel_enabled',
        subjectType: 'archive_channel',
        subjectId: args.channelId,
        after: { channelId: args.channelId, attachmentPolicy },
      },
    };
  },
});

// --- archive disable-channel -------------------------------------------------

const archiveDisableChannelArgs = z.object({
  channelId: channelIdArg,
});

export const archiveDisableChannelCommand = defineCommand<
  z.infer<typeof archiveDisableChannelArgs>
>({
  name: 'archive disable-channel',
  write: true,
  summary: 'stop archiving a channel (its archived rows are removed)',
  positional: [{ name: 'channelId', required: true, describe: 'the channel to stop archiving' }],
  args: archiveDisableChannelArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const result = ctx.ports.archiveDisableChannel(args.channelId);
    if (result.outcome === 'not-enabled') {
      return {
        text: `channel ${args.channelId} is not archived; nothing changed`,
        data: { ok: false, reason: result.outcome, channelId: args.channelId },
        audit: {
          action: 'archive.channel_disabled',
          subjectType: 'archive_channel',
          subjectId: args.channelId,
          after: { outcome: result.outcome, channelId: args.channelId },
        },
      };
    }
    return {
      text:
        `channel ${args.channelId} is no longer archived ` +
        `(${String(result.messageCount)} archived message(s) removed)`,
      data: { ok: true, channelId: args.channelId, messageCount: result.messageCount },
      audit: {
        action: 'archive.channel_disabled',
        subjectType: 'archive_channel',
        subjectId: args.channelId,
        after: { channelId: args.channelId, messageCount: result.messageCount },
      },
    };
  },
});

// --- archive status ----------------------------------------------------------

export const archiveStatusCommand = defineCommand<Record<string, never>>({
  name: 'archive status',
  write: false,
  summary: 'every archived channel with its backfill state and message count',
  args: z.object({}),
  run(ctx: OpsContext): OpsCommandResult {
    const channels = ctx.ports.archiveStatus();
    if (channels.length === 0) {
      return {
        text: 'no archive channels are enabled',
        data: { channels: [] },
      };
    }
    const lines = channels.map(
      (channel) =>
        `${channel.channelId}  ${channel.attachmentPolicy}  ` +
        `backfill:${channel.backfillState}  ` +
        `cursor:${channel.cursorMessageId ?? '-'}  ` +
        `messages:${String(channel.messageCount)}`,
    );
    return {
      text: lines.join('\n'),
      data: {
        channels: channels.map((channel) => ({
          channelId: channel.channelId,
          attachmentPolicy: channel.attachmentPolicy,
          enabledAt: channel.enabledAt,
          cursorMessageId: channel.cursorMessageId ?? null,
          backfillState: channel.backfillState,
          messageCount: channel.messageCount,
        })),
      },
    };
  },
});

// --- archive preserve --------------------------------------------------------

const archivePreserveArgs = z.object({
  messageId: messageIdArg,
});

export const archivePreserveCommand = defineCommand<z.infer<typeof archivePreserveArgs>>({
  name: 'archive preserve',
  write: true,
  summary: 'keep one archived message indefinitely',
  positional: [{ name: 'messageId', required: true, describe: 'the archived message to preserve' }],
  args: archivePreserveArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.archivePreserve(args.messageId);
    if (outcome !== 'preserved') {
      return {
        text:
          outcome === 'no-such-message'
            ? `no archived message ${args.messageId} in this guild`
            : `message ${args.messageId} is already preserved`,
        data: { ok: false, reason: outcome, messageId: args.messageId },
        audit: {
          action: 'archive.message_preserved',
          subjectType: 'archive_message',
          subjectId: args.messageId,
          after: { outcome, messageId: args.messageId },
        },
      };
    }
    return {
      text: `message ${args.messageId} is preserved indefinitely`,
      data: { ok: true, messageId: args.messageId },
      audit: {
        action: 'archive.message_preserved',
        subjectType: 'archive_message',
        subjectId: args.messageId,
        after: { messageId: args.messageId },
      },
    };
  },
});

// --- archive link-case -------------------------------------------------------

const archiveLinkCaseArgs = z.object({
  messageId: messageIdArg,
  caseId: z.string().min(1).max(64),
});

export const archiveLinkCaseCommand = defineCommand<z.infer<typeof archiveLinkCaseArgs>>({
  name: 'archive link-case',
  write: true,
  summary: 'link one archived message to an open moderation case',
  positional: [
    { name: 'messageId', required: true, describe: 'the archived message to link' },
    { name: 'caseId', required: true, describe: 'the open case to link it to' },
  ],
  args: archiveLinkCaseArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.archiveLinkCase({ messageId: args.messageId, caseId: args.caseId });
    if (outcome !== 'linked') {
      const text =
        outcome === 'no-such-message'
          ? `no archived message ${args.messageId} in this guild`
          : outcome === 'no-such-case'
            ? `no case ${args.caseId} in this guild`
            : outcome === 'case-closed'
              ? `case ${args.caseId} is closed; only open cases hold archive rows`
              : outcome === 'preserved'
                ? `message ${args.messageId} is preserved; its retention is already indefinite`
                : `message ${args.messageId} is already linked to case ${args.caseId}`;
      return {
        text,
        data: { ok: false, reason: outcome, messageId: args.messageId, caseId: args.caseId },
        audit: {
          action: 'archive.message_linked_to_case',
          subjectType: 'archive_message',
          subjectId: args.messageId,
          after: { outcome, messageId: args.messageId, caseId: args.caseId },
        },
      };
    }
    return {
      text: `message ${args.messageId} is linked to case ${args.caseId}`,
      data: { ok: true, messageId: args.messageId, caseId: args.caseId },
      audit: {
        action: 'archive.message_linked_to_case',
        subjectType: 'archive_message',
        subjectId: args.messageId,
        after: { caseId: args.caseId },
      },
    };
  },
});

// --- archive search ----------------------------------------------------------

// Flag names are the arg keys: the CLI maps `--channel` to `args.channel`
// (the way `--attachments` maps to `args.attachments` above), and the port
// input's `channelId`/`authorId` are built from them here.
const archiveSearchArgs = z.object({
  query: z.string().min(1).max(200),
  channel: channelIdArg.optional(),
  author: snowflakeIdSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const archiveSearchCommand = defineCommand<z.infer<typeof archiveSearchArgs>>({
  name: 'archive search',
  write: false,
  summary: 'search archived message content within this guild’s archive',
  positional: [{ name: 'query', required: true, describe: 'the full-text query' }],
  flags: [
    { name: 'channel', kind: 'string', describe: 'only this archived channel' },
    { name: 'author', kind: 'string', describe: 'only messages by this author' },
    { name: 'limit', kind: 'number', describe: 'how many hits (default 20, max 100)' },
  ],
  args: archiveSearchArgs,
  run(ctx: OpsContext, args): OpsCommandResult {
    const result = ctx.ports.archiveSearch({
      query: args.query,
      ...(args.channel !== undefined && { channelId: args.channel }),
      ...(args.author !== undefined && { authorId: args.author }),
      ...(args.limit !== undefined && { limit: args.limit }),
    });
    if (result.hits.length === 0) {
      return {
        text: 'no archived message matches that search',
        data: { total: 0, hits: [] },
      };
    }
    const lines = result.hits.map(
      (hit) =>
        `${hit.messageId}  #${hit.channelId}  ${new Date(hit.createdAt).toISOString()}  ${hit.excerpt}`,
    );
    if (result.total > result.hits.length) {
      lines.push(`${String(result.hits.length)} of ${String(result.total)} shown`);
    }
    return {
      text: lines.join('\n'),
      data: {
        total: result.total,
        hits: result.hits.map((hit) => ({
          messageId: hit.messageId,
          channelId: hit.channelId,
          authorId: hit.authorId ?? null,
          createdAt: hit.createdAt,
          excerpt: hit.excerpt,
        })),
      },
    };
  },
});

// --- archive reindex ---------------------------------------------------------

export const archiveReindexCommand = defineCommand<Record<string, never>>({
  name: 'archive reindex',
  write: true,
  summary: 'rebuild the archive full-text index (database-wide) from archived messages',
  args: z.object({}),
  run(ctx: OpsContext): OpsWriteResult {
    const indexedRows = ctx.ports.archiveReindex();
    return {
      text:
        `reindexed the full-text index (database-wide); this guild now has ` +
        `${String(indexedRows)} indexed messages`,
      data: { ok: true, indexedRows },
      audit: {
        action: 'archive.index_rebuilt',
        subjectType: 'archive',
        subjectId: ctx.guildId,
        after: { indexedRows, scope: 'database-wide' },
      },
    };
  },
});
