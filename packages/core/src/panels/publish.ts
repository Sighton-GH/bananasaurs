import type { DiscordMessageRef, OutgoingMessage, Snowflake } from '../discord/port.js';
import type { GuildId } from '../ids.js';
import { safeLogFields, type Logger } from '../obs/logger.js';
import { renderPanelMessage } from './components.js';
import type { PanelConfig } from './model.js';

/**
 * Posting a managed panel, and keeping it current.
 *
 * The asymmetry with adopted panels is the whole reason there are two kinds: a
 * bot may only edit **its own** messages. A managed panel is the bot's message,
 * so its text and its components can be rewritten whenever the configuration
 * changes. An adopted panel is somebody else's, and `editMessage` on it returns
 * 50013 — which is exactly why adopted panels are reaction-driven.
 */

/** Just enough of the Discord port to publish; no role mutation reachable. */
export interface PanelPublisher {
  sendMessage(
    guildId: Snowflake,
    channelId: Snowflake,
    message: OutgoingMessage,
  ): Promise<DiscordMessageRef>;
  editMessage(guildId: Snowflake, ref: DiscordMessageRef, message: OutgoingMessage): Promise<void>;
}

export interface PublishDeps {
  readonly guildId: GuildId;
  readonly discord: PanelPublisher;
  readonly logger: Logger;
  /** Records the message id so reactions and interactions can find the panel. */
  setPanelMessage(panelId: string, messageId: Snowflake): void;
}

export async function postManagedPanel(
  panel: PanelConfig,
  deps: PublishDeps,
): Promise<DiscordMessageRef> {
  if (panel.kind !== 'managed') {
    throw new Error(
      `panel ${panel.panelId} is adopted: it attaches to an existing message rather than being posted`,
    );
  }
  if (panel.messageId !== undefined) {
    throw new Error(
      `panel ${panel.panelId} is already posted as message ${panel.messageId}; edit it instead`,
    );
  }

  const ref = await deps.discord.sendMessage(
    deps.guildId,
    panel.channelId,
    renderPanelMessage(panel, panel.content),
  );

  // Recorded immediately. Until this lands, an interaction on the message
  // cannot be resolved back to a panel and the buttons do nothing.
  deps.setPanelMessage(panel.panelId, ref.messageId);

  deps.logger.info(
    safeLogFields({
      component: 'panels',
      guildId: deps.guildId,
      panelId: panel.panelId,
      channelId: panel.channelId,
      messageId: ref.messageId,
      count: panel.options.length,
      outcome: 'posted',
    }),
    'posted a managed panel',
  );

  return ref;
}

export async function editManagedPanel(panel: PanelConfig, deps: PublishDeps): Promise<void> {
  if (panel.kind !== 'managed') {
    // A bot cannot edit a message it did not write. Refusing here turns a
    // confusing 50013 into a stated reason.
    throw new Error(`panel ${panel.panelId} is adopted; Bananasaurs cannot edit that message`);
  }
  if (panel.messageId === undefined) {
    throw new Error(`panel ${panel.panelId} has not been posted yet`);
  }

  await deps.discord.editMessage(
    deps.guildId,
    { channelId: panel.channelId, messageId: panel.messageId },
    renderPanelMessage(panel, panel.content),
  );

  deps.logger.info(
    safeLogFields({
      component: 'panels',
      guildId: deps.guildId,
      panelId: panel.panelId,
      messageId: panel.messageId,
      count: panel.options.length,
      outcome: 'edited',
    }),
    'updated a managed panel',
  );
}
