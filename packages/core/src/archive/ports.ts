import type { Snowflake } from '../discord/port.js';
import type { Logger } from '../obs/logger.js';

/**
 * The archive subscriber's ports (ADR 0046, Slice M1 Task 4).
 *
 * `core` may not import from `@bananasaurs/storage` (ADR 0014), so the
 * message and attachment shapes are re-declared here rather than imported
 * from `packages/storage/src/repos/archive.ts` — the same boundary rule the
 * automod subscriber follows. The daemon wires these to `archiveRepo` and
 * `loggingRepo.isChannelExcluded` in `apps/daemon/src/runtime/guild.ts`.
 */

export interface ArchiveAttachmentInput {
  readonly attachmentId: string;
  readonly filename: string;
  readonly contentType: string | undefined;
  readonly size: number;
}

export interface UpsertMessageInput {
  readonly messageId: string;
  readonly channelId: string;
  readonly threadId?: string | undefined;
  /**
   * The category covering the channel at write time, forwarded from the
   * event. The repository reads it only when the channel has no
   * `archive_channels` row yet: the first write for a category-covered
   * channel materialises its derived row (ADR 0047 amendment 2026-09-20).
   */
  readonly categoryId?: string | undefined;
  readonly authorId: string | undefined;
  readonly content: string | undefined;
  readonly createdAt: number;
  readonly editedAt: number | undefined;
  readonly attachments: readonly ArchiveAttachmentInput[];
}

export interface ArchivePorts {
  /** ADR 0046 D1: the guild must be in BANANASAURS_ARCHIVE_GUILDS. Closed over by the daemon. */
  readonly guildArchiveEnabled: boolean;
  isChannelEnabled(channelId: Snowflake): boolean;
  hasCategoryRow(channelId: Snowflake): boolean;
  parentIncludesThreads(channelId: Snowflake): boolean;
  /** `log_excluded_channels` — the second veto (ADR 0009, standing under 0046 D1). */
  isChannelExcluded(channelId: Snowflake): boolean;
  upsertMessage(input: UpsertMessageInput): boolean;
  recordEdit(input: {
    messageId: Snowflake;
    content: string | undefined;
    editedAt: number;
  }): 'recorded' | 'no-such-message';
  recordDelete(input: {
    messageId: Snowflake;
    deletedAt: number;
  }): 'recorded' | 'no-such-message' | 'already-deleted';
  recordBulkDelete(input: { messageIds: readonly Snowflake[]; deletedAt: number }): number;
  readonly logger: Logger;
}
