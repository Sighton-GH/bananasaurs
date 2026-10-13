import {
  DiscordApiError,
  renderTaskCard,
  safeLogFields,
  type DiscordPort,
  type Logger,
} from '@bananasaurs/core';
import { taskRepo, type GuildScope } from '@bananasaurs/storage';
import { cardOut } from '../cards/art.js';
import { taskCardView } from '../cards/task-view.js';

const PER_PASS = 10;

type Outcome = 'edited' | 'given-up' | 'retry';

/** Edit one anchored card to match its task. */
const refresh = async (
  scope: GuildScope,
  discord: DiscordPort,
  stale: {
    taskId: string;
    channelId: string;
    messageId: string;
    version: number;
    updatedAt: number;
  },
  now: number,
  logger: Logger | undefined,
): Promise<Outcome> => {
  const view = taskCardView(scope, stale.taskId, now, 'refresh');
  if (view === undefined) {
    taskRepo.markCardRendered(scope, stale.taskId, stale.version, now, stale.updatedAt);
    return 'given-up';
  }
  try {
    await discord.editMessage(
      scope.guildId,
      { channelId: stale.channelId, messageId: stale.messageId },
      cardOut(renderTaskCard(view)),
    );
    taskRepo.markCardRendered(scope, stale.taskId, view.version, now, stale.updatedAt);
    return 'edited';
  } catch (err) {
    if (err instanceof DiscordApiError && (err.isGone || err.isPermissionDenied)) {
      // The card is gone or out of reach; retrying every minute would never succeed.
      taskRepo.markCardRendered(scope, stale.taskId, view.version, now, stale.updatedAt);
      logger?.info(
        safeLogFields({ component: 'task-cards', guildId: scope.guildId, outcome: 'given-up' }),
        'task card could not be edited; not retrying this version',
      );
      return 'given-up';
    }
    logger?.warn(
      safeLogFields({ component: 'task-cards', guildId: scope.guildId, err }),
      'task card refresh failed; retrying next pass',
    );
    return 'retry';
  }
};

/**
 * ADR 0140 decision 5: bring anchored task cards up to date, at most `limit`
 * per pass. Planning mode (task posts off) edits nothing.
 */
export async function refreshTaskCards(
  scope: GuildScope,
  discord: DiscordPort,
  now: number,
  options: { enabled: boolean; logger?: Logger; limit?: number },
): Promise<number> {
  if (!options.enabled) return 0;
  let edited = 0;
  for (const stale of taskRepo.staleTaskCards(scope, options.limit ?? PER_PASS))
    if ((await refresh(scope, discord, stale, now, options.logger)) === 'edited') edited += 1;
  return edited;
}

/** Refresh one task's card now (after a button click) instead of on the next pass. */
export async function refreshOneTaskCard(
  scope: GuildScope,
  discord: DiscordPort,
  taskId: string,
  now: number,
  options: { enabled: boolean; logger?: Logger },
): Promise<void> {
  if (!options.enabled) return;
  const anchor = taskRepo.anchorFor(scope, taskId);
  const task = taskRepo.getTask(scope, taskId);
  if (anchor === undefined || !task) return;
  await refresh(
    scope,
    discord,
    { taskId, ...anchor, version: task.version, updatedAt: task.updatedAt },
    now,
    options.logger,
  );
}
