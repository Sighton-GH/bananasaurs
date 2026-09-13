import type { RecentMessagesPage, Snowflake } from '../discord/port.js';
import { archiveBackfillPayload, JOB_KINDS } from '../jobs/kinds.js';
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
  readonly cursorMessageId: string | undefined;
  readonly backfillState: BackfillState;
}

export interface BackfillPorts {
  /** One page of 100, newest first, through the guild's `DiscordPort`. */
  fetchRecentMessages(
    channelId: Snowflake,
    before: string | undefined,
  ): Promise<RecentMessagesPage>;
  findChannel(channelId: Snowflake): ArchiveChannel | undefined;
  upsertMessage(input: UpsertMessageInput): boolean;
  setBackfillCursor(input: {
    channelId: Snowflake;
    cursorMessageId: string | undefined;
    state: BackfillState;
  }): void;
  enqueueContinuation(input: { channelId: Snowflake; runAfter: number }): void;
  now(): number;
  readonly logger: Logger;
}

export const archiveBackfillHandler = (ports: BackfillPorts): JobHandler<{ channelId: string }> => ({
  kind: JOB_KINDS.archiveBackfill,
  payload: archiveBackfillPayload,
  async run(payload) {
    const { channelId } = payload;
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

    // Marked running before the fetch: there is no failed state, so a thrown
    // page retried by the worker must read running, not pending.
    ports.setBackfillCursor({
      channelId,
      cursorMessageId: channel.cursorMessageId,
      state: 'running',
    });

    // A rate limit propagates untouched — the worker's backoff is the retry
    // (ADR 0018). Catching it here would turn a visible refusal into a slowdown.
    const page = await ports.fetchRecentMessages(channelId, channel.cursorMessageId);

    for (const message of page.messages) {
      ports.upsertMessage({
        messageId: message.messageId,
        channelId,
        authorId: message.authorId,
        content: message.content,
        createdAt: message.createdAtMs,
        editedAt: message.editedTimestampMs ?? undefined,
        attachments: mapAttachments(ports, message.messageId, message.attachments ?? []),
      });
    }

    // The cursor lands before anything else: a crash between here and the
    // continuation still resumes from this page, never re-fetches it.
    const done = page.nextBefore === undefined;
    ports.setBackfillCursor({
      channelId,
      cursorMessageId: page.nextBefore,
      state: done ? 'done' : 'running',
    });
    if (!done) {
      ports.enqueueContinuation({ channelId, runAfter: ports.now() });
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
