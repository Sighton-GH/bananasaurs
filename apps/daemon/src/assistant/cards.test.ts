import { describe, expect, it } from 'vitest';
import {
  cardTexts,
  countComponents,
  countText,
  TONE_ACCENT,
  toOutgoingMessage,
  type Reminder,
} from '@bananasaurs/core';
import { renderAssistantReminderCard, renderEscalationCard } from './cards.js';

const CREATOR = '333333333333333333';
const CHANNEL = '444444444444444444';
const USER = '555555555555555555';
const ROLE = '666666666666666666';
const ROLE_TWO = '777777777777777777';
const GUILD = '111111111111111111';
const AT = 1_760_000_000_000;

const reminder = (over: Partial<Reminder> = {}): Reminder & { origin: 'assistant' } => ({
  id: 'r1',
  guildId: GUILD,
  creatorId: CREATOR,
  destinationId: CHANNEL,
  text: 'standup in five',
  dueAt: AT - 1_000,
  createdAt: AT - 60_000,
  status: 'scheduled',
  dedupeKey: `reminder:${GUILD}:r1`,
  mentions: { userIds: [], roleIds: [], everyone: false, here: false },
  deliveredCount: 0,
  origin: 'assistant',
  ...over,
});

describe('renderAssistantReminderCard', () => {
  it('lists exactly the stored roles and users, and parses nothing otherwise', () => {
    const card = renderAssistantReminderCard(
      reminder({ mentions: { userIds: [USER], roleIds: [ROLE], everyone: false, here: false } }),
    );
    expect(card.allowedMentions).toEqual({ parse: [], roles: [ROLE], users: [USER] });
  });

  it('parses everyone only when the row stores everyone or here', () => {
    expect(renderAssistantReminderCard(reminder()).allowedMentions).toEqual({ parse: [] });
    expect(
      renderAssistantReminderCard(
        reminder({ mentions: { userIds: [], roleIds: [], everyone: true, here: false } }),
      ).allowedMentions.parse,
    ).toEqual(['everyone']);
    expect(
      renderAssistantReminderCard(
        reminder({ mentions: { userIds: [], roleIds: [], everyone: false, here: true } }),
      ).allowedMentions.parse,
    ).toEqual(['everyone']);
  });

  it('sends as a Components V2 card once converted', () => {
    const out = toOutgoingMessage(renderAssistantReminderCard(reminder()));
    expect(out.flags).toBe(32768);
  });

  it('puts the pings first in @everyone, @here, roles, users order, and omits the line without pings', () => {
    const texts = cardTexts(
      renderAssistantReminderCard(
        reminder({
          mentions: { userIds: [USER], roleIds: [ROLE], everyone: true, here: true },
        }),
      ).components,
    );
    expect(texts.split('\n')[1]).toBe(`@everyone @here <@&${ROLE}> <@${USER}>`);
    const bare = cardTexts(renderAssistantReminderCard(reminder()).components);
    expect(bare).toBe(`-# ⏰ REMINDER\nstandup in five\n-# Set by <@${CREATOR}>`);
  });

  it('neutralises @everyone typed into the text or context, even when the row pings @everyone', () => {
    const texts = cardTexts(
      renderAssistantReminderCard(
        reminder({
          text: '@everyone free pizza',
          context: '@everyone downstairs',
          mentions: { userIds: [], roleIds: [], everyone: true, here: false },
        }),
      ).components,
    );
    expect(texts).toContain('@\u200beveryone free pizza');
    expect(texts).toContain('@\u200beveryone downstairs');
    expect(texts.split('\n')[1]).toBe('@everyone');
  });

  it('collapses the context to one -# line and leaves out whitespace-only context', () => {
    const texts = cardTexts(
      renderAssistantReminderCard(reminder({ context: 'line one\nline two' })).components,
    );
    expect(texts.split('\n')).toContain('-# line one line two');
    const blank = cardTexts(
      renderAssistantReminderCard(reminder({ context: '   \n  ' })).components,
    );
    expect(blank.split('\n')).toHaveLength(3);
  });

  it('names the creator without pinging them unless the row already does', () => {
    const texts = cardTexts(renderAssistantReminderCard(reminder()).components);
    expect(texts).toContain(`-# Set by <@${CREATOR}>`);
    expect(renderAssistantReminderCard(reminder()).allowedMentions).toEqual({ parse: [] });
    expect(
      renderAssistantReminderCard(
        reminder({ mentions: { userIds: [CREATOR], roleIds: [], everyone: false, here: false } }),
      ).allowedMentions,
    ).toEqual({ parse: [], users: [CREATOR] });
  });

  it('refuses an mcp row carrying everyone or here', () => {
    expect(() =>
      renderAssistantReminderCard({
        ...reminder(),
        origin: 'mcp',
        mentions: { userIds: [], roleIds: [], everyone: true, here: false },
      }),
    ).toThrow('mcp reminders cannot ping everyone or here');
    expect(() =>
      renderAssistantReminderCard({
        ...reminder(),
        origin: 'mcp',
        mentions: { userIds: [], roleIds: [], everyone: false, here: true },
      }),
    ).toThrow('mcp reminders cannot ping everyone or here');
  });

  it('truncates a 5,000-character text with …, keeping the pings line and the budget', () => {
    const card = renderAssistantReminderCard(
      reminder({
        text: 'x'.repeat(5_000),
        mentions: { userIds: [USER], roleIds: [ROLE], everyone: true, here: false },
      }),
    );
    const texts = cardTexts(card.components);
    expect(texts).toContain('…');
    expect(texts.split('\n')[1]).toBe(`@everyone <@&${ROLE}> <@${USER}>`);
    expect(countText(card.components)).toBeLessThanOrEqual(4000);
    expect(countComponents(card.components)).toBeLessThanOrEqual(40);
  });
});

describe('renderEscalationCard', () => {
  const input = {
    guildId: GUILD,
    ticketId: 'ticket-1',
    reviewerRoleIds: [ROLE, ROLE_TWO],
    userId: USER,
    channelId: CHANNEL,
    messageId: '888888888888888888' as string | undefined,
    question: 'how do I join **x**?',
    answer: 'You join **like this**.',
    at: AT,
  };

  it('pings exactly the reviewer roles', () => {
    const card = renderEscalationCard(input);
    expect(card.allowedMentions).toEqual({ parse: [], roles: [ROLE, ROLE_TWO] });
    expect(toOutgoingMessage(card).allowedMentions).toEqual({
      parse: [],
      roles: [ROLE, ROLE_TWO],
    });
  });

  it('escapes the question', () => {
    const texts = cardTexts(renderEscalationCard(input).components);
    expect(texts).toContain('> how do I join \\*\\*x\\*\\*?');
  });

  it('shows the answer as Markdown in a quote, capped at 1,500 characters', () => {
    const texts = cardTexts(
      renderEscalationCard({ ...input, answer: `line one\n${'y'.repeat(5_000)}` }).components,
    );
    expect(texts).toContain('**The assistant replied**');
    expect(texts).toContain('> line one');
    expect(texts).toContain('…');
    const answerPart = texts.split('**The assistant replied**\n')[1] ?? '';
    const quoted = answerPart
      .split('\n')
      .filter((line) => line.startsWith('> '))
      .join('\n');
    expect(quoted.replaceAll('> ', '').length).toBeLessThanOrEqual(1_500);
  });

  it('shows the jump link only when messageId is defined', () => {
    const withLink = cardTexts(renderEscalationCard(input).components);
    expect(withLink).toContain(
      `[Jump to the question](https://discord.com/channels/${GUILD}/${CHANNEL}/888888888888888888)`,
    );
    const withoutLink = cardTexts(
      renderEscalationCard({ ...input, messageId: undefined }).components,
    );
    expect(withoutLink).not.toContain('Jump to the question');
  });

  it('uses the hold tone and carries no art', () => {
    const card = renderEscalationCard(input);
    expect(card.art).toEqual([]);
    expect(card.components[0]).toMatchObject({ accent_color: TONE_ACCENT.hold });
    expect(TONE_ACCENT.hold).toBe(0xe0a526);
  });
});
