import type { DiscordMessageRef } from '../discord/port.js';
import type { GuildId } from '../ids.js';
import { safeLogFields, type Logger } from '../obs/logger.js';
import { orderedOptions, type PanelConfig } from './model.js';
import type { PanelDiscordReader } from './ports.js';

/**
 * Puts the panel's emoji on the message, so members have something to click.
 *
 * Seeded in display order, because Discord shows reactions in the order they
 * were first added and a panel whose emoji appear shuffled looks broken.
 *
 * Idempotent by construction: adding a reaction the bot has already added is a
 * no-op at Discord, so re-seeding after a restart is safe and needs no record
 * of what was seeded. That matters because the alternative — tracking seeded
 * emoji in a table — would go stale the moment someone removed one by hand,
 * and re-seeding is the repair.
 *
 * The bot's own reactions are ignored by the subscriber (`createReactionSubscriber`
 * drops events whose user is the bot), so seeding cannot grant the bot a role.
 */

export interface SeedResult {
  readonly seeded: number;
  /** Emoji Discord refused, usually a custom emoji from a guild we are not in. */
  readonly failed: readonly { emojiKey: string; error: string }[];
}

export async function seedPanelReactions(
  panel: PanelConfig,
  deps: {
    guildId: GuildId;
    discord: PanelDiscordReader;
    logger: Logger;
  },
): Promise<SeedResult> {
  if (panel.messageId === undefined) {
    throw new Error(`panel ${panel.panelId} has no message to seed reactions on`);
  }
  const ref: DiscordMessageRef = { channelId: panel.channelId, messageId: panel.messageId };

  let seeded = 0;
  const failed: { emojiKey: string; error: string }[] = [];

  for (const option of orderedOptions(panel)) {
    if (option.emojiKey === undefined) continue;
    try {
      await deps.discord.createReaction(deps.guildId, ref, option.emojiKey);
      seeded += 1;
    } catch (err) {
      // One unusable emoji must not stop the rest of the panel from working.
      // A custom emoji from a guild the bot has left is the common cause, and
      // it is worth a log line rather than an exception that aborts seeding.
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      failed.push({ emojiKey: option.emojiKey, error });
      deps.logger.warn(
        safeLogFields({
          component: 'panels',
          guildId: deps.guildId,
          panelId: panel.panelId,
          optionId: option.optionId,
          messageId: panel.messageId,
          outcome: 'seed-failed',
          err: err instanceof Error ? err : undefined,
        }),
        'could not seed a panel emoji',
      );
    }
  }

  deps.logger.info(
    safeLogFields({
      component: 'panels',
      guildId: deps.guildId,
      panelId: panel.panelId,
      messageId: panel.messageId,
      count: seeded,
      failed: failed.length,
    }),
    'seeded panel reactions',
  );

  return { seeded, failed };
}
