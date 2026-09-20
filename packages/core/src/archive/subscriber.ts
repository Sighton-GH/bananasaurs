import type { MessageAttachment } from '../discord/events.js';
import type { Snowflake } from '../discord/port.js';
import { safeLogFields } from '../obs/logger.js';
import { isInScope } from '../channels/scope.js';
import type { Subscriber } from '../pipeline/pipeline.js';
import type { ArchiveAttachmentInput, ArchivePorts } from './ports.js';

/**
 * The live archive subscriber (ADR 0046 D5, Slice M1 Task 4).
 *
 * Read-side only with respect to moderation: it never calls the effect
 * gateway and never touches `mod_rules` or `mod_cases` writers. It runs
 * after the automod subscriber so a message the automod deletes is still
 * archived as created-then-deleted.
 *
 * Three vetoes gate every write (ADR 0046 D1): the guild must be in
 * `BANANASAURS_ARCHIVE_GUILDS`, the channel must be enabled in
 * `archive_channels`, and the channel must not be in
 * `log_excluded_channels`. Bot-authored messages are archived too — the
 * archive is a record, not a filter.
 */

/**
 * Maps event attachments to the repo shape, skipping any without a Discord
 * attachment id (PR-71: only fixture-derived attachments lack one). The skip
 * is logged at debug with `messageId` so a row missing a file is diagnosable
 * without ever logging content.
 */
const mapAttachments = (
  ports: ArchivePorts,
  messageId: Snowflake,
  attachments: readonly MessageAttachment[],
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

export const createArchiveSubscriber = (ports: ArchivePorts): Subscriber => ({
  name: 'archive',
  handle(event) {
    if (
      event.kind !== 'messageCreate' &&
      event.kind !== 'messageUpdate' &&
      event.kind !== 'messageDelete' &&
      event.kind !== 'messageDeleteBulk'
    ) {
      return;
    }
    if (!ports.guildArchiveEnabled) return;
    const inScope = isInScope('archive', {
      channelId: event.channelId,
      parentChannelId: event.parentChannelId,
      categoryId: event.categoryId,
      isPrivateThread: event.isPrivateThread,
      hasOwnRow: (id) => ports.isChannelEnabled(id),
      hasCategoryRow: (id) => ports.hasCategoryRow(id),
      isExcluded: (id) => ports.isChannelExcluded(id),
      parentIncludesThreads: (id) => ports.parentIncludesThreads(id),
    });
    if (!inScope) return;
    const archiveChannelId = event.parentChannelId ?? event.channelId;
    const threadId = event.parentChannelId === undefined ? undefined : event.channelId;

    switch (event.kind) {
      case 'messageCreate':
        ports.upsertMessage({
          messageId: event.messageId,
          channelId: archiveChannelId,
          threadId,
          categoryId: event.categoryId,
          authorId: event.authorId,
          content: event.content,
          createdAt: event.receivedAtMs,
          editedAt: event.editedTimestampMs,
          attachments: mapAttachments(ports, event.messageId, event.attachments),
        });
        return;
      case 'messageUpdate': {
        const outcome = ports.recordEdit({
          messageId: event.messageId,
          content: event.content,
          editedAt: event.editedTimestampMs ?? event.receivedAtMs,
        });
        if (outcome === 'no-such-message') {
          // The message predates enablement; Discord sends full content on
          // update, so insert what the event carries.
          ports.upsertMessage({
            messageId: event.messageId,
            channelId: archiveChannelId,
            threadId,
            categoryId: event.categoryId,
            authorId: event.authorId,
            content: event.content,
            createdAt: event.receivedAtMs,
            editedAt: event.editedTimestampMs ?? event.receivedAtMs,
            attachments: mapAttachments(ports, event.messageId, event.attachments),
          });
          ports.logger.debug(
            safeLogFields({
              component: 'archive',
              messageId: event.messageId,
              channelId: event.channelId,
            }),
            'archive: edit to unknown message, inserted',
          );
        }
        return;
      }
      case 'messageDelete':
        // 'no-such-message' is silent: a message we never held leaves no row.
        ports.recordDelete({ messageId: event.messageId, deletedAt: event.receivedAtMs });
        return;
      case 'messageDeleteBulk':
        ports.recordBulkDelete({
          messageIds: [...event.messageIds],
          deletedAt: event.receivedAtMs,
        });
        return;
    }
  },
});
