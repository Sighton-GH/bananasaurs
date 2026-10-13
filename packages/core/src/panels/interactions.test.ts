import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { panelRefusalCode } from '../copy/refusals.js';
import type { InteractionEvent } from '../discord/events.js';
import type { DiscordMember, InteractionRef, OutgoingMessage } from '../discord/port.js';
import { toOutgoingMessage } from '../ui/discord/card.js';
import { errorCard } from '../ui/discord/common-cards.js';
import { cardTexts } from '../ui/discord/inspect.js';
import { TONE_ACCENT } from '../ui/discord/tokens.js';
import { parseGuildId, parseSnowflakeId } from '../ids.js';
import type { EffectOutcome } from '../effects/gateway.js';
import type { ConvergencePlan } from './convergence.js';
import { buildCustomId } from './components.js';
import type { PanelConfig } from './model.js';
import type { AppliedChange, ConvergeMemberResult } from './reactions.js';
import {
  createInteractionSubscriber,
  panelResultCard,
  type InteractionSubscriberDeps,
} from './interactions.js';

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = parseSnowflakeId('222222222222222222');
const MESSAGE = parseSnowflakeId('333333333333333333');
const MEMBER = parseSnowflakeId('444444444444444444');
const ROLE_A = parseSnowflakeId('666666666666666666');
const ROLE_R = parseSnowflakeId('777777777777777777');

const planWith = (over: Partial<ConvergencePlan> = {}): ConvergencePlan => ({
  desiredRoleIds: new Set<string>(),
  grants: [],
  revokes: [],
  refusedBecause: undefined,
  declined: [],
  ...over,
});

const resultWith = (
  plan: ConvergencePlan,
  over: Partial<Omit<ConvergeMemberResult, 'plan'>> = {},
): ConvergeMemberResult => ({
  plan,
  applied: 0,
  skipped: 0,
  refused: 0,
  appliedChanges: [],
  ...over,
});

const accentOf = (components: readonly unknown[]): number =>
  (components[0] as { accent_color: number }).accent_color;

describe('panelResultCard', () => {
  it.each([
    'panel-disabled',
    'missing-required-role',
    'blocked-role',
    'max-roles',
    'add-only',
    'remove-only',
  ] as const)('a refusal reads from the catalogue with no Ref: %s', (refusal) => {
    const card = panelResultCard(resultWith(planWith({ refusedBecause: refusal })));
    expect(card).toEqual(errorCard(panelRefusalCode(refusal)));
    expect(cardTexts(card.components)).not.toContain('Ref');
  });

  it('names the switched-off title', () => {
    const card = panelResultCard(resultWith(planWith({ refusedBecause: 'panel-disabled' })));
    expect(cardTexts(card.components)).toContain('This panel is switched off');
  });

  it('names the roles granted and revoked', () => {
    const appliedChanges: readonly AppliedChange[] = [
      { roleId: ROLE_A, action: 'grant' },
      { roleId: ROLE_R, action: 'revoke' },
    ];
    const card = panelResultCard(resultWith(planWith({}), { applied: 2, appliedChanges }));
    expect(accentOf(card.components)).toBe(TONE_ACCENT.ok);
    const t = cardTexts(card.components);
    expect(t).toContain('Roles updated');
    expect(t).toContain(`You now have <@&${ROLE_A}>.`);
    expect(t).toContain(`Removed <@&${ROLE_R}>.`);
  });

  it('says when the panel limit clamped a choice', () => {
    const card = panelResultCard(
      resultWith(planWith({ declined: [{ optionId: 'beta', reason: 'max-roles' }] }), {
        applied: 1,
        appliedChanges: [{ roleId: ROLE_A, action: 'grant' }],
      }),
    );
    const t = cardTexts(card.components);
    expect(t).toContain(`You now have <@&${ROLE_A}>.`);
    expect(t).toContain("You've reached this panel's limit, so not every choice was added.");
  });

  it('a declined choice with nothing applied reads from the catalogue', () => {
    const card = panelResultCard(
      resultWith(planWith({ declined: [{ optionId: 'beta', reason: 'add-only' }] })),
    );
    expect(card).toEqual(errorCard('panel.add-only'));
  });

  it('gateway refusals with nothing applied become the not-applied card', () => {
    const card = panelResultCard(resultWith(planWith({}), { refused: 2 }));
    expect(card).toEqual(errorCard('panel.not-applied'));
  });

  it('says so when the roles already match', () => {
    const card = panelResultCard(resultWith(planWith({})));
    expect(accentOf(card.components)).toBe(TONE_ACCENT.neutral);
    const t = cardTexts(card.components);
    expect(t).toContain('No change');
    expect(t).toContain('Your roles already match.');
  });
});

const panel: PanelConfig = {
  panelId: 'roles',
  kind: 'managed',
  channelId: CHANNEL,
  messageId: MESSAGE,
  behaviour: 'toggle',
  component: 'button',
  maxRoles: undefined,
  requiredRoleId: undefined,
  blockedRoleIds: [],
  status: 'enabled',
  adoptionPassState: 'done',
  adoptionBlockedCount: 0,
  options: [
    { optionId: 'alpha', roleId: ROLE_A, emojiKey: undefined, label: 'Alpha', position: 0 },
    { optionId: 'beta', roleId: ROLE_R, emojiKey: undefined, label: 'Beta', position: 1 },
  ],
};

const logger = pino({ level: 'silent' });

const makeDeps = (over: { failFetch?: boolean } = {}) => {
  const deferred: { ref: InteractionRef }[] = [];
  const responded: { ref: InteractionRef; message: OutgoingMessage }[] = [];
  const fetchMember = async (): Promise<DiscordMember> => {
    if (over.failFetch === true) throw new Error('the member fetch blew up');
    return { userId: MEMBER, roleIds: [], isGuildOwner: false };
  };
  const apply = async (): Promise<EffectOutcome> => ({
    status: 'applied',
    effectId: 'e1',
    hadRoleBefore: false,
  });
  const deps: InteractionSubscriberDeps = {
    guildId: GUILD,
    botUserId: parseSnowflakeId('999999999999999991'),
    store: {
      findPanelByMessage: (channelId, messageId) =>
        channelId === CHANNEL && messageId === MESSAGE ? panel : undefined,
      findPanel: () => panel,
      listAdoptedPanels: () => [],
    },
    discord: {
      fetchMember,
      fetchMessage: () => Promise.reject(new Error('not used in this test')),
      createReaction: () => Promise.reject(new Error('not used in this test')),
      fetchReactionUsers: () => Promise.reject(new Error('not used in this test')),
    },
    effects: {
      openBatch: () => 'batch-1',
      closeBatch: () => undefined,
      apply,
      recordGranted: () => undefined,
      forgetGranted: () => undefined,
    },
    logger,
    now: () => 0,
    newPassId: () => 'pass-1',
    responder: {
      defer: (ref) => {
        deferred.push({ ref });
        return Promise.resolve();
      },
      respond: (ref, message) => {
        responded.push({ ref, message });
        return Promise.resolve();
      },
    },
  };
  return { deps, deferred, responded };
};

const click = (customId: string): InteractionEvent => ({
  kind: 'interaction',
  guildId: GUILD,
  receivedAtMs: 0,
  interactionId: '999999999999999999',
  token: 'tok',
  channelId: CHANNEL,
  messageId: MESSAGE,
  userId: MEMBER,
  customId,
});

describe('the interaction subscriber', () => {
  it('answers a grant with the roles-updated card', async () => {
    const { deps, deferred, responded } = makeDeps();
    await createInteractionSubscriber(deps).handle(click(buildCustomId('roles', 'alpha')));

    expect(deferred).toHaveLength(1);
    expect(responded).toHaveLength(1);
    const message = responded[0]?.message;
    expect(message?.flags).toBe(32768);
    expect(cardTexts(message?.components ?? [])).toContain(`You now have <@&${ROLE_A}>.`);
  });

  it('answers panel.unavailable when the work throws', async () => {
    const { deps, responded } = makeDeps({ failFetch: true });
    await createInteractionSubscriber(deps).handle(click(buildCustomId('roles', 'alpha')));

    expect(responded).toHaveLength(1);
    const message = responded[0]?.message;
    expect(message?.flags).toBe(32768);
    expect(message).toEqual(toOutgoingMessage(errorCard('panel.unavailable')));
  });
});
