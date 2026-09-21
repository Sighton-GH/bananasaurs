import type { RecentMessagesPage, Snowflake } from '../discord/port.js';
import { archiveBackfillPayload, JOB_KINDS, type ArchiveBackfillPayload } from '../jobs/kinds.js';
import type { JobHandler } from '../jobs/worker.js';
import { safeLogFields, type Logger } from '../obs/logger.js';
import type { ArchiveAttachmentInput, UpsertMessageInput } from './ports.js';

/**
 * The resumable archive backfill job (ADR 0046 D4, Slice M1 Task 5).
 *
 * One page of 100 messages per run through the REST port, the cursor
 * persisted in `archive_channels` after every page, a continuation enqueued
 * under the per-channel dedupe key while pages remain — purge's shape. A
 * restart resumes from the persisted cursor rather than from the top.
 *
 * `core` may not import from `@bananasaurs/storage` (ADR 0014), so the
 * channel shape is re-declared here the way `ports.ts` re-declares the
 * message shape: the daemon binds these to `archiveRepo` in
 * `apps/daemon/src/runtime/guild.ts`.
 */

export type BackfillState = 'pending' | 'running' | 'done';

/** The slice of `archive_channels` this job reads and writes. */
export interface ArchiveChannel {
  readonly channelId: Snowflake;
  /**
   * ADR 0047 amendment 2026-09-20: a `derived` row means this channel is
   * covered by a category, not enabled itself — the job must re-check that
   * coverage at run time (scope is dynamic), not assume it.
   */
  readonly scopeKind: 'channel' | 'category' | 'derived';
  readonly derivedFrom: Snowflake | undefined;
  readonly cursorMessageId: string | undefined;
  readonly backfillState: BackfillState;
}

export interface BackfillPorts {
  /** ADR 0046 D1: the guild must be in BANANASAURS_ARCHIVE_GUILDS. Closed over by the daemon. */
  readonly guildArchiveEnabled: boolean;
  /** `log_excluded_channels` — the second veto (ADR 0009, standing under 0046 D1). */
  isChannelExcluded(channelId: Snowflake): boolean;
  /** One page of 100, newest first, through the guild's `DiscordPort`. */
  fetchRecentMessages(
    channelId: Snowflake,
    before: string | undefined,
  ): Promise<RecentMessagesPage>;
  findChannel(channelId: Snowflake): ArchiveChannel | undefined;
  listThreads(channelId: Snowflake): Promise<readonly { id: Snowflake; isPrivate: boolean }[]>;
  isForum(channelId: Snowflake): boolean;
  /** Whether the category row exists — the grant a derived row's coverage resolves from. */
  hasCategoryRow(categoryId: Snowflake): boolean;
  /** The category the channel currently sits in, from the live guild cache. */
  categoryOf(channelId: Snowflake): Snowflake | undefined;
  setThreadProgress(input: { channelId: Snowflake; found: number; done: number }): void;
  upsertMessage(input: UpsertMessageInput): boolean;
  setBackfillCursor(input: {
    channelId: Snowflake;
    cursorMessageId: string | undefined;
    state: BackfillState;
  }): void;
  /**
   * This tick's own successor. The `jobId` is the tick's own
   * `context.jobId`, never anything the tick computed — see
   * `archiveBackfillDedupeKey` (`jobs/kinds.ts`) for why the successor's key
   * must be minted from it rather than from the channel alone.
   */
  enqueueContinuation(input: {
    channelId: Snowflake;
    /** Present on the thread-walk ticks (review M2); absent while the channel itself is paging. */
    threadWalk?: { threadIds: readonly Snowflake[]; index: number; before: Snowflake | undefined };
    jobId: number;
    runAfter: number;
  }): void;
  now(): number;
  readonly logger: Logger;
}

export const archiveBackfillHandler = (
  ports: BackfillPorts,
): JobHandler<ArchiveBackfillPayload> => ({
  kind: JOB_KINDS.archiveBackfill,
  payload: archiveBackfillPayload,
  async run(payload, context) {
    const { channelId } = payload;
    const jobId = context.jobId;
    if (!ports.guildArchiveEnabled) {
      // The operator removed the guild from BANANASAURS_ARCHIVE_GUILDS
      // while this job was queued: the next page must not land (ADR 0046
      // D1 holds for the job path exactly as for the subscriber).
      ports.logger.info(
        safeLogFields({
          component: 'archive',
          jobKind: JOB_KINDS.archiveBackfill,
          channelId,
        }),
        'archive: backfill guild no longer archive-enabled, stopping',
      );
      return;
    }
    const channel = ports.findChannel(channelId);
    if (channel === undefined) {
      // Disabled mid-backfill: the channel row is gone, so there is nothing
      // to page and no cursor to persist. Done, not failed.
      ports.logger.info(
        safeLogFields({
          component: 'archive',
          jobKind: JOB_KINDS.archiveBackfill,
          channelId,
        }),
        'archive: backfill channel no longer enabled, stopping',
      );
      return;
    }
    if (channel.scopeKind === 'derived') {
      // ADR 0047 amendment 2026-09-20: a derived row is coverage, not a
      // grant, and coverage is dynamic. Re-resolve it at run time: a channel
      // moved out of its enabled category since the job was queued stops
      // being backfilled, exactly as the subscriber stops archiving it.
      const categoryId = ports.categoryOf(channelId);
      if (categoryId === undefined || !ports.hasCategoryRow(categoryId)) {
        ports.logger.info(
          safeLogFields({
            component: 'archive',
            jobKind: JOB_KINDS.archiveBackfill,
            channelId,
          }),
          'archive: backfill channel no longer covered by an enabled category, stopping',
        );
        return;
      }
    }
    if (ports.isChannelExcluded(channelId)) {
      // Archive-enabled and excluded at once: the subscriber refuses these,
      // so the job must too — otherwise the backfill writes rows the live
      // path would never have written.
      ports.logger.info(
        safeLogFields({
          component: 'archive',
          jobKind: JOB_KINDS.archiveBackfill,
          channelId,
        }),
        'archive: backfill channel excluded, stopping',
      );
      return;
    }

    if (payload.threadWalk !== undefined) {
      // Review M2: one page of one thread per tick, with the position in the
      // job payload — a thread walk of any size no longer happens inside a
      // single tick, and a restart resumes from the last persisted page.
      const { threadIds, index, before } = payload.threadWalk;
      const threadId = threadIds[index];
      if (threadId === undefined) {
        // A payload whose index ran off the list (a hand-edited row, say):
        // finish rather than throw — every thread the payload named is done.
        ports.setBackfillCursor({
          channelId,
          cursorMessageId: channel.cursorMessageId,
          state: 'done',
        });
        return;
      }
      const threadPage = await ports.fetchRecentMessages(threadId, before);
      for (const message of threadPage.messages) {
        ports.upsertMessage({
          messageId: message.messageId,
          channelId,
          threadId,
          authorId: message.authorId,
          content: message.content,
          createdAt: message.createdAtMs,
          editedAt: message.editedTimestampMs ?? undefined,
          attachments: mapAttachments(ports, message.messageId, message.attachments ?? []),
        });
      }
      const threadDone = threadPage.nextBefore === undefined;
      if (threadDone) {
        // Persisted before the continuation is enqueued: a crash between the
        // two restarts from the last COMPLETE thread, never mid-list.
        ports.setThreadProgress({ channelId, found: threadIds.length, done: index + 1 });
      }
      const nextIndex = threadDone ? index + 1 : index;
      if (nextIndex >= threadIds.length) {
        ports.setBackfillCursor({
          channelId,
          cursorMessageId: channel.cursorMessageId,
          state: 'done',
        });
        ports.logger.info(
          safeLogFields({
            component: 'archive',
            jobKind: JOB_KINDS.archiveBackfill,
            channelId,
            count: threadIds.length,
          }),
          'archive: backfill thread walk complete',
        );
        return;
      }
      ports.enqueueContinuation({
        channelId,
        threadWalk: {
          threadIds,
          index: nextIndex,
          before: threadDone ? undefined : threadPage.nextBefore,
        },
        jobId,
        runAfter: ports.now(),
      });
      return;
    }

    // Marked running before the fetch: there is no failed state, so a thrown
    // page retried by the worker must read running, not pending.
    ports.setBackfillCursor({
      channelId,
      cursorMessageId: channel.cursorMessageId,
      state: 'running',
    });

    // A forum has no messages of its own; its posts are threads.
    const page = ports.isForum(channelId)
      ? { messages: [], nextBefore: undefined }
      : await ports.fetchRecentMessages(channelId, channel.cursorMessageId);

    for (const message of page.messages) {
      ports.upsertMessage({
        messageId: message.messageId,
        channelId,
        threadId: undefined,
        authorId: message.authorId,
        content: message.content,
        createdAt: message.createdAtMs,
        editedAt: message.editedTimestampMs ?? undefined,
        attachments: mapAttachments(ports, message.messageId, message.attachments ?? []),
      });
    }

    const done = page.nextBefore === undefined;
    if (done) {
      const threads = (await ports.listThreads(channelId)).filter((thread) => !thread.isPrivate);
      ports.setThreadProgress({ channelId, found: threads.length, done: 0 });
      ports.setBackfillCursor({
        channelId,
        cursorMessageId: undefined,
        state: threads.length === 0 ? 'done' : 'running',
      });
      if (threads.length > 0) {
        // Review M2: the walk itself is the continuation chain — one page of
        // one thread per tick — not a loop inside this tick.
        ports.enqueueContinuation({
          channelId,
          threadWalk: {
            threadIds: threads.map((thread) => thread.id),
            index: 0,
            before: undefined,
          },
          jobId,
          runAfter: ports.now(),
        });
      }
    } else {
      ports.setBackfillCursor({
        channelId,
        cursorMessageId: page.nextBefore,
        state: 'running',
      });
      // Immediate `runAfter`: the job-poll interval is the throttle (ADR 0046 D4).
      ports.enqueueContinuation({ channelId, jobId, runAfter: ports.now() });
    }

    ports.logger.info(
      safeLogFields({
        component: 'archive',
        jobKind: JOB_KINDS.archiveBackfill,
        channelId,
        count: page.messages.length,
      }),
      'archive: backfill page stored',
    );
  },
});

/**
 * Maps fetched attachments to the repo shape, skipping any without a Discord
 * attachment id — the same skip the live subscriber makes (`subscriber.ts`'s
 * `mapAttachments`), logged at debug with `messageId` so a row missing a file
 * is diagnosable without ever logging content.
 */
const mapAttachments = (
  ports: BackfillPorts,
  messageId: Snowflake,
  attachments: readonly {
    readonly attachmentId?: Snowflake;
    readonly fileName: string;
    readonly contentType: string | undefined;
    readonly sizeBytes: number;
  }[],
): ArchiveAttachmentInput[] => {
  const mapped: ArchiveAttachmentInput[] = [];
  for (const attachment of attachments) {
    if (attachment.attachmentId === undefined) {
      ports.logger.debug(
        safeLogFields({ component: 'archive', messageId }),
        'archive: attachment without id, skipped',
      );
      continue;
    }
    mapped.push({
      attachmentId: attachment.attachmentId,
      filename: attachment.fileName,
      contentType: attachment.contentType,
      size: attachment.sizeBytes,
    });
  }
  return mapped;
};
