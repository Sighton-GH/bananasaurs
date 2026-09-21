import { describe, expect, it } from 'vitest';
import type { AssistantBehaviour, MessageEvent } from '@bananasaurs/core';
import { routeAssistantMention } from './assistant-routing.js';

const guildId = '234567890123456789';
const bananaRole = '345678901234567890';
const itRole = '456789012345678901';
const behaviours: AssistantBehaviour[] = [
  {
    id: 'club',
    guildId,
    surface: 'bananasaurs',
    mentionRoleId: bananaRole,
    name: 'Club assistant',
    systemPrompt: 'club',
    allowedSkillIds: ['club-search'],
    reviewerRoleIds: [],
    callerRoleIds: ['333333333333333333'],
    resourceIds: [],
    enabled: true,
  },
  {
    id: 'it',
    guildId,
    surface: 'it-services',
    mentionRoleId: itRole,
    name: 'IT services',
    systemPrompt: 'it',
    allowedSkillIds: ['reviewed-links'],
    reviewerRoleIds: [],
    callerRoleIds: ['333333333333333333'],
    resourceIds: [],
    enabled: true,
  },
];
const event = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  kind: 'messageCreate',
  guildId,
  receivedAtMs: 1,
  channelId: '567890123456789012',
  messageId: '678901234567890123',
  authorId: '789012345678901234',
  authorIsBot: false,
  content: `<@&${bananaRole}> where is the handbook?`,
  editedTimestampMs: undefined,
  mentionedUserIds: [],
  authorRoleIds: ['333333333333333333'],
  mentionedRoleIds: [bananaRole],
  mentionsEveryone: false,
  attachments: [],
  ...over,
});

describe('routeAssistantMention', () => {
  it('selects the behaviour attached to the one mentioned role and strips the tag', () => {
    expect(routeAssistantMention(event(), behaviours)).toMatchObject({
      kind: 'routed',
      behaviour: { id: 'club' },
      prompt: 'where is the handbook?',
    });
  });

  it('fails closed when both assistant tags are present', () => {
    expect(
      routeAssistantMention(
        event({
          content: `<@&${bananaRole}> <@&${itRole}> reset my access`,
          authorRoleIds: ['333333333333333333'],
          mentionedRoleIds: [bananaRole, itRole],
        }),
        behaviours,
      ),
    ).toEqual({
      kind: 'ambiguous',
      message: 'Please tag either @bananasaurs or @it-services, not both.',
    });
  });

  it('ignores bot messages and unrelated role mentions', () => {
    expect(routeAssistantMention(event({ authorIsBot: true }), behaviours)).toEqual({
      kind: 'not-addressed',
    });
    expect(
      routeAssistantMention(
        event({ authorRoleIds: [], mentionedRoleIds: ['890123456789012345'] }),
        behaviours,
      ),
    ).toEqual({ kind: 'not-addressed' });
  });
});
