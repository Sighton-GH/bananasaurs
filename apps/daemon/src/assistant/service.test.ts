import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig, parseGuildId, type TextProvider } from '@bananasaurs/core';
import {
  assistantProvidersRepo,
  assistantRepo,
  eligibilityRepo,
  guildRepo,
} from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { resolveModelChain } from './model-chain.js';
import { createAssistantService, sanitizeMentionsForProvider } from './service.js';

describe('sanitizeMentionsForProvider', () => {
  it('flattens role, user and channel mentions to readable tokens', () => {
    expect(
      sanitizeMentionsForProvider(
        'what did <@456789012345678901> say in <#345678901234567890> about <@&567890123456789012>?',
      ),
    ).toBe('what did @user say in #channel about @role?');
  });

  it('leaves ordinary prose and short numbers untouched', () => {
    expect(sanitizeMentionsForProvider('meet at 7, bring 12345 cones')).toBe(
      'meet at 7, bring 12345 cones',
    );
  });
});

/**
 * Task 6b fix round 2 (carried from Task 6's review): entries from
 * `resolveModelChain` use `ChainEntry.mayTrain` for the training warning; the
 * independent eligibility check stays only for the `testPorts.provider` path.
 */
describe('Task 6b fix round 2: ChainEntry.mayTrain training warning', () => {
  const GUILD = parseGuildId('234567890123456789');
  const MEMBER = '456789012345678901';
  const CHANNEL = '567890123456789012';
  const CLUB_ROLE = '678901234567890123';
  const OWNER = '345678901234567890';
  const NOW = 1_800_000_000_000;

  const config = parseConfig({
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: OWNER,
    AI_PROVIDER: 'off',
    AI_MODEL: 'fixture-model',
    AI_PROFILE_COST_CLASS: 'free',
  });

  const direct = {
    id: 'direct',
    guildId: GUILD,
    surface: 'direct-command' as const,
    name: 'Club',
    systemPrompt: 'Canadian English.',
    promptVersion: 1,
    callerRoleIds: [CLUB_ROLE],
    reviewerRoleIds: [],
    allowedSkillIds: ['search-club'],
    resourceIds: [],
    enabled: true,
  };

  let t: MigratedTestDatabase;
  beforeEach(() => {
    t = openMigratedTestDatabase();
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'fixture', now: NOW });
    assistantRepo.putBehaviour(t.scopes.forGuild(GUILD), direct, NOW);
    assistantRepo.putSkillGrant(
      t.scopes.forGuild(GUILD),
      { skillId: 'search-club', roleIds: [CLUB_ROLE], userIds: [] },
      NOW,
    );
  });
  afterEach(() => t.close());

  it('a chain entry with mayTrain: true warns without a second eligibility read', async () => {
    const instance = t.scopes.instance();
    eligibilityRepo.recordEligibilityClaim(instance, {
      provider: 'gemini',
      trainsOnInput: 'yes',
      evidenceUrl: 'https://example.com/terms',
      evidenceClause: 'May train on input.',
      productionUseAllowed: true,
      now: NOW,
    });
    const keyId = assistantProvidersRepo.addKey(instance, {
      provider: 'gemini',
      label: 'Gemini',
      apiKeyEnc: 'sealed',
      now: NOW,
    });
    assistantProvidersRepo.setModelChain(instance, [{ keyId, model: 'm' }], NOW);

    const generateText = vi.fn(async () => ({ text: 'ok', model: 'm' }));
    const fakeProvider: TextProvider = {
      id: 'gemini',
      capabilities: new Set(['text']),
      generateText,
    };
    const eligibility = vi.fn((_provider: 'gemini' | 'openrouter' | 'nvidia-nim') => ({
      provider: 'gemini',
      trainsOnInput: 'yes' as const,
      evidenceUrl: 'https://example.com/terms',
      productionUseAllowed: true,
      reviewedAt: NOW,
    }));
    const entries = resolveModelChain({
      instance,
      config,
      openKey: () => 'raw-test-key',
      eligibility,
      makeProvider: () => fakeProvider,
    });
    expect(entries).toMatchObject([{ mayTrain: true, skip: undefined }]);
    const eligibilityCallsAfterChain = eligibility.mock.calls.length;
    expect(eligibilityCallsAfterChain).toBeGreaterThan(0);

    const warn = vi.fn();
    const findEligibilitySpy = vi.spyOn(eligibilityRepo, 'findEligibility');
    try {
      const service = createAssistantService(
        t.scopes.forGuild(GUILD),
        instance,
        config,
        () => NOW,
        {},
        undefined,
        { warn },
        undefined,
        () => entries,
      );
      const result = await service.invoke({
        guildId: GUILD,
        channelId: CHANNEL,
        userId: MEMBER,
        callerRoleIds: [CLUB_ROLE],
        behaviour: direct,
        command: 'ask',
        input: { question: 'when is the meeting?' },
        source: 'slash-command',
        invocationId: 'int-maytrain-chain',
      });
      expect(result.ok).toBe(true);
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ guildId: GUILD, reason: 'provider-may-train' }),
        'assistant provider may train on server content',
      );
      // The chain entry already carried the warning flag: no second
      // eligibility read, neither through the injected function nor the repo.
      expect(eligibility.mock.calls.length).toBe(eligibilityCallsAfterChain);
      expect(findEligibilitySpy).not.toHaveBeenCalled();
    } finally {
      findEligibilitySpy.mockRestore();
    }
  });

  it('the testPorts.provider path still checks eligibility itself and refuses an ineligible provider', async () => {
    const instance = t.scopes.instance();
    eligibilityRepo.recordEligibilityClaim(instance, {
      provider: 'fixture',
      trainsOnInput: 'no',
      evidenceUrl: 'https://example.com/terms',
      evidenceClause: 'Not for production.',
      productionUseAllowed: false,
      now: NOW,
    });
    const network = vi.fn(async () => ({ text: 'must not run', model: 'fixture-model' }));
    const warn = vi.fn();
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      instance,
      config,
      () => NOW,
      {
        provider: { id: 'fixture', capabilities: new Set(['text']), generateText: network },
      },
      undefined,
      { warn },
    );
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'ordinary question' },
      source: 'slash-command',
      invocationId: 'int-ineligible-test-provider',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.content).toContain('terms');
    expect(network).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
