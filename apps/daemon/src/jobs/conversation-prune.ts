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
  effectRepo,
  runRepo,
  traceRepo,
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
    runRepo.pruneOrphanRuns(scope, now - 30 * 86_400_000);
    const days = assistantRepo.getConversationRetention(scope);
    if (days === null) return;
    const { conversations, ids } = conversationRepo.pruneOlderThan(scope, now - days * 86_400_000);
    traceRepo.deleteTracesForConversations(scope, ids);
    runRepo.deleteRunsForConversations(scope, ids);
    if (conversations === 0) return;
    effectRepo.recordAudit(scope, {
      at: now,
      actorType: 'system',
      actorId: undefined,
      action: 'assistant_conversation.pruned',
      subjectType: 'assistant_conversation',
      subjectId: undefined,
      after: { count: conversations },
      dryRun: false,
    });
    deps.logger.info(
      safeLogFields({
        component: 'conversations',
        jobKind: JOB_KINDS.conversationPrune,
        count: conversations,
      }),
      'conversations: prune run deleted expired conversations',
    );
  },
});
