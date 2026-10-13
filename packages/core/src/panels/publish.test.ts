import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { toOutgoingMessage, type CardMessage } from '../ui/discord/card.js';
import type { DiscordMessageRef, OutgoingMessage, Snowflake } from '../discord/port.js';
import { parseGuildId, parseSnowflakeId } from '../ids.js';
import { renderPanelCard } from './components.js';
import type { PanelConfig } from './model.js';
import { editManagedPanel, postManagedPanel, type PublishDeps } from './publish.js';

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = parseSnowflakeId('222222222222222222');
const ROLE = parseSnowflakeId('333333333333333333');

const logger = pino({ level: 'silent' });

const managed = (over: Partial<PanelConfig> = {}): PanelConfig => ({
  panelId: 'roles',
  kind: 'managed',
  channelId: CHANNEL,
  messageId: undefined,
  behaviour: 'toggle',
  component: 'button',
  maxRoles: undefined,
  requiredRoleId: undefined,
  blockedRoleIds: [],
  status: 'enabled',
  adoptionPassState: 'done',
  adoptionBlockedCount: 0,
  options: [{ optionId: 'alpha', roleId: ROLE, emojiKey: undefined, label: 'Alpha', position: 0 }],
  ...over,
});

const artFile = { name: 'banner-panel.png', contentType: 'image/png', data: new Uint8Array([1]) };

const setup = () => {
  const cards: CardMessage[] = [];
  const sent: OutgoingMessage[] = [];
  const recorded: { panelId: string; messageId: Snowflake }[] = [];
  const deps: PublishDeps = {
    guildId: GUILD,
    discord: {
      sendMessage: (_guildId, _channelId, message): Promise<DiscordMessageRef> => {
        sent.push(message);
        return Promise.resolve({
          channelId: CHANNEL,
          messageId: parseSnowflakeId('555555555555555555'),
        });
      },
      editMessage: (_guildId, _ref, message): Promise<void> => {
        sent.push(message);
        return Promise.resolve();
      },
    },
    logger,
    setPanelMessage: (panelId, messageId) => {
      recorded.push({ panelId, messageId });
    },
    toMessage: (card: CardMessage): OutgoingMessage => {
      cards.push(card);
      return toOutgoingMessage(card, () => artFile);
    },
  };
  return { deps, cards, sent, recorded };
};

describe('publishing a panel posts its card', () => {
  it('posts the rendered card through toMessage', async () => {
    const { deps, cards, sent, recorded } = setup();
    const panel = managed();

    const ref = await postManagedPanel(panel, deps);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual(renderPanelCard(panel));
    expect(sent[0]?.flags).toBe(32768);
    expect(sent[0]?.files?.map((f) => f.name)).toEqual(['banner-panel.png']);
    expect(recorded).toEqual([{ panelId: 'roles', messageId: ref.messageId }]);
  });

  it('edits a posted panel into its card', async () => {
    const { deps, cards, sent } = setup();
    const panel = managed({
      messageId: parseSnowflakeId('555555555555555555'),
      content: 'Pick one',
    });

    await editManagedPanel(panel, deps);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual(renderPanelCard(panel));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.flags).toBe(32768);
  });
});
