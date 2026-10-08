import { z } from 'zod';
import { snowflakeIdSchema } from '../../ids.js';
import {
  defineCommand,
  type OpsCommandResult,
  type OpsContext,
  type OpsWriteResult,
} from '../dispatch.js';
import { OPS_AUDIT_ACTIONS } from '../audit-actions.js';

/**
 * The `archive …` operator surface (ADR 0046, Slice M1 Task 6; search and
 * reindex from Slice M2 Task 4).
 *
 * Seven commands over the nine `OpsPorts` archive members: enabling a
 * channel (which queues its backfill), deleting one, listing the enabled
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
          action: OPS_AUDIT_ACTIONS.archiveChannelEnabled,
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
          action: OPS_AUDIT_ACTIONS.archiveChannelEnabled,
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
          action: OPS_AUDIT_ACTIONS.archiveChannelEnabled,
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
        action: OPS_AUDIT_ACTIONS.archiveChannelEnabled,
        subjectType: 'archive_channel',
        subjectId: args.channelId,
        after: { channelId: args.channelId, attachmentPolicy },
      },
    };
  },
});

// --- archive delete-channel --------------------------------------------------
// ADR 0126: `delete-channel` permanently deletes archived messages — turning
// Archive off pauses recording (the `pause-channel` verb below) and deletes
// nothing.
// This verb permanently deletes archived messages. The ops PORT names
// (`archiveDisableChannel`, `archiveDisableCategory`) are unchanged.

const archiveDeleteChannelArgs = z.object({
  channelId: channelIdArg,
});

export const archiveDeleteChannelCommand = defineCommand<z.infer<typeof archiveDeleteChannelArgs>>({
  name: 'archive delete-channel',
  write: true,
  summary: 'permanently delete a channel\u2019s archived messages',
  positional: [{ name: 'channelId', required: true, describe: 'the channel to delete' }],
  args: archiveDeleteChannelArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const result = ctx.ports.archiveDisableChannel(args.channelId);
    if (result.outcome === 'wrong-kind') {
      return {
        text: `channel ${args.channelId} is archived as a category; use archive delete-category`,
        data: { ok: false, reason: result.outcome, channelId: args.channelId },
        audit: {
          action: OPS_AUDIT_ACTIONS.archiveChannelDisabled,
          subjectType: 'archive_channel',
          subjectId: args.channelId,
          after: { outcome: result.outcome, channelId: args.channelId },
        },
      };
    }
    if (result.outcome === 'covered-by-category') {
      // Review 2 N1: naming the category is the whole point. Saying
      // "archived as a category" here was false of a derived row, and
      // `delete-category` refused it back, so the operator had no verb.
      return {
        text:
          `channel ${args.channelId} is not archived in its own right: it is covered by ` +
          `category ${result.categoryId}. Use \`archive delete-category ${result.categoryId}\` ` +
          'to drop the whole category, or exclude this channel from logging to stop it alone.',
        data: {
          ok: false,
          reason: result.outcome,
          channelId: args.channelId,
          categoryId: result.categoryId,
        },
        audit: {
          action: OPS_AUDIT_ACTIONS.archiveChannelDisabled,
          subjectType: 'archive_channel',
          subjectId: args.channelId,
          after: {
            outcome: result.outcome,
            channelId: args.channelId,
            categoryId: result.categoryId,
          },
        },
      };
    }
    if (result.outcome === 'not-enabled') {
      return {
        text: `channel ${args.channelId} is not archived; nothing changed`,
        data: { ok: false, reason: result.outcome, channelId: args.channelId },
        audit: {
          action: OPS_AUDIT_ACTIONS.archiveChannelDisabled,
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
        action: OPS_AUDIT_ACTIONS.archiveChannelDisabled,
        subjectType: 'archive_channel',
        subjectId: args.channelId,
        after: { channelId: args.channelId, messageCount: result.messageCount },
      },
    };
  },
});

// --- archive pause-channel / resume-channel (ADR 0126) -----------------------

const archivePauseArgs = z.object({
  channelId: channelIdArg,
});

export const archivePauseChannelCommand = defineCommand<z.infer<typeof archivePauseArgs>>({
  name: 'archive pause-channel',
  write: true,
  summary: 'stop recording a channel; its archived messages are kept',
  positional: [{ name: 'channelId', required: true, describe: 'the channel to pause' }],
  args: archivePauseArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.archivePauseChannel(args.channelId);
    if (outcome === 'paused') {
      return {
        text:
          `Recording stopped for ${args.channelId}. ` +
          'Nothing was deleted (its archived messages are kept).',
        data: { ok: true, channelId: args.channelId, outcome },
        audit: {
          action: OPS_AUDIT_ACTIONS.archiveChannelPaused,
          subjectType: 'archive_channel',
          subjectId: args.channelId,
          after: { outcome, channelId: args.channelId },
        },
      };
    }
    const text =
      outcome === 'already-paused'
        ? `channel ${args.channelId} is already paused; nothing changed`
        : outcome === 'not-enabled'
          ? `channel ${args.channelId} is not archived; nothing changed`
          : outcome === 'wrong-kind'
            ? `channel ${args.channelId} is archived as a category; use archive pause-category`
            : `channel ${args.channelId} is covered by a category; use archive pause-category for its category`;
    return {
      text,
      data: { ok: false, reason: outcome, channelId: args.channelId },
      audit: {
        action: OPS_AUDIT_ACTIONS.archiveChannelPaused,
        subjectType: 'archive_channel',
        subjectId: args.channelId,
        after: { outcome, channelId: args.channelId },
      },
    };
  },
});

export const archiveResumeChannelCommand = defineCommand<z.infer<typeof archivePauseArgs>>({
  name: 'archive resume-channel',
  write: true,
  summary: 'resume recording a paused channel; the gap stays a gap',
  positional: [{ name: 'channelId', required: true, describe: 'the channel to resume' }],
  args: archivePauseArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.archiveResumeChannel(args.channelId);
    if (outcome === 'resumed') {
      // No backfill is enqueued: the gap during the pause stays a gap, and
      // the operator runs the existing backfill path explicitly.
      return {
        text:
          `Recording resumed for ${args.channelId}. ` +
          'Messages sent while archiving was off were not recorded.',
        data: { ok: true, channelId: args.channelId, outcome },
        audit: {
          action: OPS_AUDIT_ACTIONS.archiveChannelResumed,
          subjectType: 'archive_channel',
          subjectId: args.channelId,
          after: { outcome, channelId: args.channelId },
        },
      };
    }
    const text =
      outcome === 'already-collecting'
        ? `channel ${args.channelId} is already recording; nothing changed`
        : outcome === 'not-enabled'
          ? `channel ${args.channelId} is not archived; nothing changed`
          : outcome === 'wrong-kind'
            ? `channel ${args.channelId} is archived as a category; use archive resume-category`
            : `channel ${args.channelId} is covered by a category; use archive resume-category for its category`;
    return {
      text,
      data: { ok: false, reason: outcome, channelId: args.channelId },
      audit: {
        action: OPS_AUDIT_ACTIONS.archiveChannelResumed,
        subjectType: 'archive_channel',
        subjectId: args.channelId,
        after: { outcome, channelId: args.channelId },
      },
    };
  },
});

export const archivePauseCategoryCommand = defineCommand<z.infer<typeof archivePauseArgs>>({
  name: 'archive pause-category',
  write: true,
  summary: 'stop recording a category; its archived messages are kept',
  positional: [{ name: 'channelId', required: true, describe: 'the category to pause' }],
  args: archivePauseArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.archivePauseCategory(args.channelId);
    if (outcome === 'paused') {
      return {
        text:
          `Recording stopped for category ${args.channelId}. ` +
          'Nothing was deleted (its archived messages are kept).',
        data: { ok: true, channelId: args.channelId, outcome },
        audit: {
          action: OPS_AUDIT_ACTIONS.archiveCategoryPaused,
          subjectType: 'archive_category',
          subjectId: args.channelId,
          after: { outcome, channelId: args.channelId },
        },
      };
    }
    const text =
      outcome === 'no-such-channel'
        ? `${args.channelId} is not a category of this guild`
        : outcome === 'already-paused'
          ? `category ${args.channelId} is already paused; nothing changed`
          : outcome === 'not-enabled'
            ? `category ${args.channelId} is not archived; nothing changed`
            : `category ${args.channelId} is covered by a category; pause its category instead`;
    return {
      text,
      data: { ok: false, reason: outcome, channelId: args.channelId },
      audit: {
        action: OPS_AUDIT_ACTIONS.archiveCategoryPaused,
        subjectType: 'archive_category',
        subjectId: args.channelId,
        after: { outcome, channelId: args.channelId },
      },
    };
  },
});

export const archiveResumeCategoryCommand = defineCommand<z.infer<typeof archivePauseArgs>>({
  name: 'archive resume-category',
  write: true,
  summary: 'resume recording a paused category; the gap stays a gap',
  positional: [{ name: 'channelId', required: true, describe: 'the category to resume' }],
  args: archivePauseArgs,
  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.archiveResumeCategory(args.channelId);
    if (outcome === 'resumed') {
      return {
        text:
          `Recording resumed for ${args.channelId}. ` +
          'Messages sent while archiving was off were not recorded.',
        data: { ok: true, channelId: args.channelId, outcome },
        audit: {
          action: OPS_AUDIT_ACTIONS.archiveCategoryResumed,
          subjectType: 'archive_category',
          subjectId: args.channelId,
          after: { outcome, channelId: args.channelId },
        },
      };
    }
    const text =
      outcome === 'no-such-channel'
        ? `${args.channelId} is not a category of this guild`
        : outcome === 'already-collecting'
          ? `category ${args.channelId} is already recording; nothing changed`
          : outcome === 'not-enabled'
            ? `category ${args.channelId} is not archived; nothing changed`
            : `category ${args.channelId} is covered by a category; resume its category instead`;
    return {
      text,
      data: { ok: false, reason: outcome, channelId: args.channelId },
      audit: {
        action: OPS_AUDIT_ACTIONS.archiveCategoryResumed,
        subjectType: 'archive_category',
        subjectId: args.channelId,
        after: { outcome, channelId: args.channelId },
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
        // Review 2 N2: a derived row is coverage under a category, not a
        // channel the operator enabled. Naming it — and the category it
        // came from — is the difference between a status line an operator
        // can act on and one that invites them to chase a backfill that
        // will never be queued.
        (channel.scopeKind === undefined || channel.scopeKind === 'channel'
          ? ''
          : channel.scopeKind === 'derived'
            ? `derived from ${channel.derivedFrom ?? '?'}  `
            : `${channel.scopeKind}  `) +
        `backfill:${channel.backfillState}  ` +
        `cursor:${channel.cursorMessageId ?? '-'}  ` +
        `messages:${String(channel.messageCount)}` +
        (channel.threadsFound === undefined
          ? ''
          : `  threads:${String(channel.threadsDone ?? 0)}/${String(channel.threadsFound)}`),
    );
    return {
      text: lines.join('\n'),
      data: {
        channels: channels.map((channel) => ({
          channelId: channel.channelId,
          scopeKind: channel.scopeKind ?? 'channel',
          derivedFrom: channel.derivedFrom ?? null,
          attachmentPolicy: channel.attachmentPolicy,
          enabledAt: channel.enabledAt,
          cursorMessageId: channel.cursorMessageId ?? null,
          backfillState: channel.backfillState,
          threadsFound: channel.threadsFound ?? null,
          threadsDone: channel.threadsDone ?? 0,
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
          action: OPS_AUDIT_ACTIONS.archiveMessagePreserved,
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
        action: OPS_AUDIT_ACTIONS.archiveMessagePreserved,
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
          action: OPS_AUDIT_ACTIONS.archiveMessageLinkedToCase,
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
        action: OPS_AUDIT_ACTIONS.archiveMessageLinkedToCase,
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
        action: OPS_AUDIT_ACTIONS.archiveIndexRebuilt,
        subjectType: 'archive',
        subjectId: ctx.guildId,
        after: { indexedRows, scope: 'database-wide' },
      },
    };
  },
});

const archiveCategoryArgs = z.object({ channelId: channelIdArg });
export const archiveEnableCategoryCommand = defineCommand<z.infer<typeof archiveCategoryArgs>>({
  name: 'archive enable-category',
  write: true,
  summary: 'archive channels dynamically covered by a category',
  positional: [{ name: 'channelId', required: true, describe: 'the category to archive' }],
  args: archiveCategoryArgs,
  run(ctx, args): OpsWriteResult {
    const coverage = ctx.ports.archiveCategoryCoverage(args.channelId);
    const outcome = ctx.ports.archiveEnableCategory({
      channelId: args.channelId,
      attachmentPolicy: 'none',
    });
    return {
      text:
        outcome === 'enabled'
          ? `category ${args.channelId} is enabled for archive scope; ${String(coverage.channels)} channels and ${String(coverage.messages)} archived messages currently covered; backfill queued`
          : outcome === 'no-such-channel'
            ? `${args.channelId} is not a category of this guild`
            : `category ${args.channelId}: ${outcome}`,
      data: { channelId: args.channelId, outcome, coverage },
      audit: {
        action: OPS_AUDIT_ACTIONS.archiveCategoryEnabled,
        subjectType: 'archive_category',
        subjectId: args.channelId,
        after: { outcome },
      },
    };
  },
});
export const archiveDeleteCategoryCommand = defineCommand<z.infer<typeof archiveCategoryArgs>>({
  name: 'archive delete-category',
  write: true,
  summary: 'permanently delete a category\u2019s archived messages',
  positional: [{ name: 'channelId', required: true, describe: 'the category to remove' }],
  args: archiveCategoryArgs,
  run(ctx, args): OpsWriteResult {
    const result = ctx.ports.archiveDisableCategory(args.channelId);
    return {
      text:
        result.outcome === 'disabled'
          ? `category ${args.channelId} is no longer archived (${String(result.messageCount)} archived message(s) removed)`
          : result.outcome === 'wrong-kind'
            ? `category ${args.channelId} is archived as a channel; use archive delete-channel`
            : `category ${args.channelId} was not archived`,
      data: { channelId: args.channelId, ...result },
      audit: {
        action: OPS_AUDIT_ACTIONS.archiveCategoryDisabled,
        subjectType: 'archive_category',
        subjectId: args.channelId,
        after: result,
      },
    };
  },
});
const setThreadsArgs = z.object({ channelId: channelIdArg, value: z.enum(['all', 'none']) });
export const archiveSetThreadsCommand = defineCommand<z.infer<typeof setThreadsArgs>>({
  name: 'archive set-threads',
  write: true,
  summary: 'include all public threads under an archived channel, or none',
  positional: [
    { name: 'channelId', required: true, describe: 'the archived channel' },
    { name: 'value', required: true, describe: 'all | none' },
  ],
  args: setThreadsArgs,
  run(ctx, args): OpsWriteResult {
    const outcome = ctx.ports.archiveSetThreads(args.channelId, args.value === 'all');
    return {
      text:
        outcome === 'updated'
          ? `thread inheritance for ${args.channelId} set to ${args.value}`
          : outcome === 'forum-requires-all'
            ? 'forums always include their posts; none is refused'
            : `channel ${args.channelId} is not archived`,
      data: { channelId: args.channelId, value: args.value, outcome },
      audit: {
        action: OPS_AUDIT_ACTIONS.archiveThreadsSet,
        subjectType: 'archive_channel',
        subjectId: args.channelId,
        after: { value: args.value, outcome },
      },
    };
  },
});
export const archiveThreadsCommand = defineCommand<z.infer<typeof archiveCategoryArgs>>({
  name: 'archive threads',
  write: false,
  summary: 'show public-thread backfill progress for an archived channel',
  positional: [{ name: 'channelId', required: true, describe: 'the archived channel' }],
  args: archiveCategoryArgs,
  run(ctx, args): OpsCommandResult {
    const row = ctx.ports.archiveThreads(args.channelId);
    return row === undefined
      ? { text: `channel ${args.channelId} is not archived`, data: null }
      : {
          text: `threads: ${String(row.done)}/${row.found === undefined ? '?' : String(row.found)}`,
          data: { found: row.found ?? null, done: row.done },
        };
  },
});
