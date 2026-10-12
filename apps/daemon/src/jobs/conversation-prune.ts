import {
  conversationPrunePayload,
  JOB_KINDS,
  safeLogFields,
  type ConversationPrunePayload,
  type JobHandler,
  type Logger,
} from '@bananasaurs/core';
import {
  assistantRepo,
  conversationRepo,
  digestRepo,
  effectRepo,
  runRepo,
  traceRepo,
  write,
  type GuildScope,
} from '@bananasaurs/storage';

/**
 * The daily conversation prune (Task 19).
 *
 * One run deletes one guild's conversations past its retention window —
 * measured from `last_activity_at` — with their turns, message links and
 * traces, then records a single count-only audit row. `null` retention
 * (keep forever) deletes nothing and audits nothing. The `day` in the
 * payload names the UTC day the timer enqueued for and exists so the dedupe
 * key collapses repeats, not so this handler reads it: the cutoff is always
 * the current time, so a job that sat through a backlog prunes what is due
 * when it runs rather than what was due when queued.
 */
export const conversationPruneHandler = (
  scope: GuildScope,
  deps: { now: () => number; logger: Logger },
): JobHandler<ConversationPrunePayload> => ({
  kind: JOB_KINDS.conversationPrune,
  payload: conversationPrunePayload,
  run() {
    const now = deps.now();
    // ADR 0129 §6: runs with no conversation prune at 30 days regardless of
    // the conversation retention below — including keep-forever.
    runRepo.failStaleRuns(scope, now - 60 * 60_000, now);
    runRepo.pruneOrphanRuns(scope, now - 30 * 86_400_000);
    traceRepo.pruneOrphanTraces(scope, now - 30 * 86_400_000);

    const days = assistantRepo.getConversationRetention(scope);
    if (days === null) return;
    // Keep retention deletes and their count audit atomic: a retry after any
    // storage failure must still see every row and produce the full counts.
    const counts = write(scope, () => {
      const { conversations, ids } = conversationRepo.pruneOlderThan(
        scope,
        now - days * 86_400_000,
      );
      traceRepo.deleteTracesForConversations(scope, ids);
      runRepo.deleteRunsForConversations(scope, ids);
      // ADR 0150 decision 4: digest rows follow the same window, keyed by day.
      // The cutoff is a UTC day, not the club's local day. The exact retention
      // edge differs from conversations by the local zone and time of day.
      // Digest days are local days while the cutoff is computed in UTC days,
      // so a digest can be removed up to one day early or late.
      // Keep-forever (`null`) returns above and keeps digests too.
      const digests = digestRepo.deleteDigestsOlderThan(
        scope,
        new Date(now - days * 86_400_000).toISOString().slice(0, 10),
      );
      if (conversations === 0 && digests === 0) return undefined;
      effectRepo.recordAudit(scope, {
        at: now,
        actorType: 'system',
        actorId: undefined,
        action: 'assistant_conversation.pruned',
        subjectType: 'assistant_conversation',
        subjectId: undefined,
        after: { count: conversations, digests },
        dryRun: false,
      });
      return { conversations, digests };
    });
    if (counts === undefined) return;
    deps.logger.info(
      safeLogFields({
        guildId: scope.guildId,
        component: 'conversations',
        jobKind: JOB_KINDS.conversationPrune,
        count: counts.conversations,
      }),
      `conversations: prune run deleted ${counts.conversations} expired conversations and ${counts.digests} digests`,
    );
  },
});
