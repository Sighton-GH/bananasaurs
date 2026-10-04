import {
  conversationPruneDedupeKey,
  JOB_KINDS,
  safeLogFields,
  type Logger,
} from '@bananasaurs/core';
import { conversationRepo, type GuildScope, type jobRepo } from '@bananasaurs/storage';

/**
 * The daily conversation-prune timer (Task 19).
 *
 * The job table has no scheduler, so this is the producer: at startup and
 * every 24 hours it enqueues one `conversation_prune` job per guild that
 * actually has a conversation for the current UTC day. The dedupe key is
 * the day, so a second `runOnce` on the same day enqueues nothing: the
 * `(guild_id, dedupe_key)` partial unique index refuses it per guild while
 * the job is still pending (ADR 0016), and `oncePerBucket` (ADR 0127)
 * keeps it refused after the job has finished. The handler itself reads
 * the guild's retention and prunes nothing for keep-forever, so every
 * guild *with conversations* gets a job.
 *
 * Mirrors `archive-expiry-timer.ts` in its start/stop contract (run once at
 * start, then `setInterval(...).unref()`; `stop` clears) and nothing else.
 */

export const CONVERSATION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ConversationPruneTimer {
  /** Enqueues one prune job per guild for the current UTC day, now. */
  runOnce(): void;
  /** Runs once now, then schedules the recurring interval. */
  start(): void;
  stop(): void;
}

export interface ConversationPruneTimerDeps {
  readonly guilds: () => readonly { scope: GuildScope }[];
  readonly enqueue: (scope: GuildScope, input: jobRepo.EnqueueInput) => unknown;
  /**
   * Cheap peek before enqueueing: without it every guild gets one empty
   * `conversation_prune` job a day forever, which only noises up `/status`'s
   * queued count (the same reasoning `resource-refresh-timer.ts`'s
   * `hasResources` documents). Optional, defaulting to the real
   * `conversationRepo.hasConversations(scope)` — production gets this for
   * free; tests can inject a stub.
   */
  readonly hasConversations?: (scope: GuildScope) => boolean;
  readonly now: () => number;
  readonly logger: Logger;
}

const utcDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export function createConversationPruneTimer(
  deps: ConversationPruneTimerDeps,
): ConversationPruneTimer {
  let timer: NodeJS.Timeout | undefined;
  const hasConversations =
    deps.hasConversations ?? ((scope) => conversationRepo.hasConversations(scope));

  const runOnce = (): void => {
    const now = deps.now();
    const day = utcDay(now);
    let enqueued = 0;
    for (const { scope } of deps.guilds()) {
      if (!hasConversations(scope)) continue;
      deps.enqueue(scope, {
        kind: JOB_KINDS.conversationPrune,
        payload: JSON.stringify({ day }),
        dedupeKey: conversationPruneDedupeKey(day),
        oncePerBucket: true,
        now,
      });
      enqueued += 1;
    }
    if (enqueued > 0) {
      deps.logger.info(
        safeLogFields({ component: 'conversations', jobKind: JOB_KINDS.conversationPrune }),
        'conversations: prune enqueued for the day',
      );
    }
  };

  return {
    runOnce,
    start() {
      // Run once immediately rather than waiting out the first interval — a
      // fresh install's first expired conversation would otherwise wait up to
      // a full day for its first prune pass.
      runOnce();
      timer = setInterval(runOnce, CONVERSATION_PRUNE_INTERVAL_MS);
      // Same reasoning as the job-poll timer: a pending prune tick must not
      // be what keeps the process alive after the gateway connection dies.
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
