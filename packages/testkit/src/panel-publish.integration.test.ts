import { beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  cardCustomIds,
  cardTexts,
  editManagedPanel,
  parseGuildId,
  parseSnowflakeId,
  postManagedPanel,
  renderPanelCard,
  toOutgoingMessage,
  type CardMessage,
  type OutgoingMessage,
  type PanelConfig,
  type PublishDeps,
} from '@bananasaurs/core';
import { BOT_USER_ID, FakeDiscord } from './fake-discord.js';

/**
 * Posting and editing a managed panel against the fake.
 *
 * The asymmetry being proved is the reason there are two kinds of panel at all:
 * a bot may edit its own message and no one else's. An adopted panel is
 * somebody else's message, so `editMessage` returns 50013 — which is what makes
 * adopted panels reaction-driven rather than a design preference.
 */

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = parseSnowflakeId('222222222222222222');
const ROLE = parseSnowflakeId('333333333333333333');
const SOMEONE_ELSE = parseSnowflakeId('444444444444444444');

const logger = pino({ level: 'silent' });

let discord: FakeDiscord;
let recorded: { panelId: string; messageId: string }[];
let deps: PublishDeps;

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

beforeEach(() => {
  discord = new FakeDiscord({ guildId: GUILD });
  recorded = [];
  deps = {
    guildId: GUILD,
    discord,
    logger,
    setPanelMessage: (panelId, messageId) => recorded.push({ panelId, messageId }),
    toMessage: (card: CardMessage): OutgoingMessage =>
      toOutgoingMessage(card, () => ({
        name: 'banner-panel.png',
        contentType: 'image/png',
        data: new Uint8Array([1]),
      })),
  };
});

describe('posting', () => {
  it('sends the panel card with the V2 flag and the panel banner', async () => {
    const panel = managed();
    const ref = await postManagedPanel(panel, deps);

    const sent = discord.restCalls('sendMessage');
    expect(sent).toHaveLength(1);
    const message = sent[0]?.args[2] as OutgoingMessage;
    expect(message.flags).toBe(32768);
    expect(message.files?.map((f) => f.name)).toEqual(['banner-panel.png']);
    const container = message.components?.[0] as { components: readonly unknown[] };
    expect(container.components[0]).toMatchObject({
      type: 12,
      items: [{ media: { url: 'attachment://banner-panel.png' } }],
    });
    expect(cardCustomIds(message.components ?? [])).toEqual(['bs.panel:roles:alpha']);
    expect(ref.channelId).toBe(CHANNEL);
  });

  it('records the message id, without which the buttons do nothing', async () => {
    // An interaction is resolved back to a panel by its message id. Until this
    // is stored, every click on the panel just posted is unattributable.
    const ref = await postManagedPanel(managed(), deps);
    expect(recorded).toEqual([{ panelId: 'roles', messageId: ref.messageId }]);
  });

  it("uses the caller's content when given one", async () => {
    await postManagedPanel(managed({ content: 'Pick a team' }), deps);
    const message = discord.restCalls('sendMessage')[0]?.args[2] as OutgoingMessage;
    expect(cardTexts(message.components ?? [])).toContain('Pick a team');
  });

  it('refuses to post an adopted panel', async () => {
    await expect(
      postManagedPanel(managed({ kind: 'adopted', component: 'reaction' }), deps),
    ).rejects.toThrow(/attaches to an existing message/);
    expect(discord.restCalls('sendMessage')).toEqual([]);
  });

  it('refuses to post a panel twice', async () => {
    const ref = await postManagedPanel(managed(), deps);
    await expect(
      postManagedPanel(managed({ messageId: parseSnowflakeId(ref.messageId) }), deps),
    ).rejects.toThrow(/already posted/);
  });
});

describe('editing', () => {
  it('rewrites its own message when the configuration changes', async () => {
    const ref = await postManagedPanel(managed(), deps);
    const posted = managed({
      messageId: parseSnowflakeId(ref.messageId),
      options: [
        { optionId: 'alpha', roleId: ROLE, emojiKey: undefined, label: 'Alpha', position: 0 },
        {
          optionId: 'beta',
          roleId: parseSnowflakeId('555555555555555555'),
          emojiKey: undefined,
          label: 'Beta',
          position: 1,
        },
      ],
    });

    const editedPanel = { ...posted, content: 'Now with more roles' };
    await editManagedPanel(editedPanel, deps);

    const edited = discord.restCalls('editMessage');
    expect(edited).toHaveLength(1);
    const message = edited[0]?.args[2] as OutgoingMessage;
    expect(message.flags).toBe(32768);
    expect(cardTexts(message.components ?? [])).toContain('Now with more roles');
    expect(cardCustomIds(message.components ?? [])).toEqual([
      'bs.panel:roles:alpha',
      'bs.panel:roles:beta',
    ]);
    expect(message).toEqual(deps.toMessage(renderPanelCard(editedPanel)));
  });

  it('refuses to edit an adopted panel, rather than letting Discord say 50013', async () => {
    await expect(
      editManagedPanel(
        managed({
          kind: 'adopted',
          component: 'reaction',
          messageId: parseSnowflakeId('666666666666666666'),
        }),
        deps,
      ),
    ).rejects.toThrow(/cannot edit that message/);
    expect(discord.restCalls('editMessage')).toEqual([]);
  });

  it('refuses to edit a panel that was never posted', async () => {
    await expect(editManagedPanel(managed(), deps)).rejects.toThrow(/not been posted/);
  });
});

describe('why adopted panels are reaction-driven', () => {
  it("Discord refuses an edit to somebody else's message", async () => {
    // The constraint itself, at the port. `editManagedPanel` refuses earlier and
    // with a better message, but this is what it is protecting against.
    const messageId = parseSnowflakeId('777777777777777777');
    discord.defineMessage({ channelId: CHANNEL, messageId, authorId: SOMEONE_ELSE });

    await expect(
      discord.editMessage(GUILD, { channelId: CHANNEL, messageId }, { content: 'mine now' }),
    ).rejects.toMatchObject({ code: 50013 });
  });

  it('but permits an edit to its own', async () => {
    const ref = await discord.sendMessage(GUILD, CHANNEL, { content: 'ours' });
    await expect(discord.editMessage(GUILD, ref, { content: 'edited' })).resolves.toBeUndefined();
    expect(BOT_USER_ID).toBeDefined();
  });
});
