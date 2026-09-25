import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseConfig,
  parseGuildId,
  ProviderError,
  type GenerateTextResponse,
  type TextProvider,
} from '@bananasaurs/core';
import {
  assistantProvidersRepo,
  assistantRepo,
  computeDocId,
  eligibilityRepo,
  guildRepo,
  resourceCacheRepo,
} from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { resolveModelChain, type ChainEntry } from './model-chain.js';
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

/**
 * Task 12: the service runs the whole chain through the tool loop and maps
 * a failed loop back to today's member-facing texts.
 */
describe('Task 12: service maps a failed tool loop to today\u2019s texts', () => {
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

  const ask = {
    guildId: GUILD,
    channelId: CHANNEL,
    userId: MEMBER,
    callerRoleIds: [CLUB_ROLE],
    behaviour: direct,
    command: 'ask' as const,
    input: { question: 'when is the meeting?' },
    source: 'slash-command' as const,
    invocationId: 'int-loop-map',
  };

  const fakeProvider = (
    responses: (GenerateTextResponse | Error)[],
    capabilities: readonly ('text' | 'tools')[] = ['text', 'tools'],
  ): { provider: TextProvider; calls: () => number } => {
    const queue = [...responses];
    let n = 0;
    return {
      provider: {
        id: 'fake',
        capabilities: new Set(capabilities),
        generateText: async () => {
          n += 1;
          const next = queue.shift();
          if (next === undefined) throw new Error('no scripted response');
          if (next instanceof Error) throw next;
          return next;
        },
      },
      calls: () => n,
    };
  };

  const usable = (provider: TextProvider, over: Partial<ChainEntry> = {}): ChainEntry => ({
    providerId: 'gemini',
    model: 'model-a',
    keyId: 'key_a',
    keyLabel: 'Key A',
    provider,
    skip: undefined,
    mayTrain: false,
    ...over,
  });

  const skipped = (skip: ChainEntry['skip'], model = 'model-a'): ChainEntry => ({
    providerId: 'gemini',
    model,
    keyId: 'key_a',
    keyLabel: 'Key A',
    provider: undefined,
    skip,
    mayTrain: false,
  });

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

  const serviceWith = (
    chain: () => readonly ChainEntry[],
  ): ReturnType<typeof createAssistantService> =>
    createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      undefined,
      chain,
    );

  it('every entry busy throws retryable so the job retries into BUSY_REPLY', async () => {
    const { provider, calls } = fakeProvider([new ProviderError('rate-limit', 'HTTP 429', true)]);
    const service = serviceWith(() => [usable(provider)]);
    await expect(service.invoke(ask)).rejects.toMatchObject({
      kind: 'rate-limit',
      retryable: true,
    });
    expect(calls()).toBe(1);
  });

  it('a non-daily quota error keeps its kind instead of becoming invalid-request', async () => {
    const { provider, calls } = fakeProvider([
      new ProviderError('quota', 'credit exhausted', false),
    ]);
    const service = serviceWith(() => [usable(provider)]);
    await expect(service.invoke(ask)).rejects.toMatchObject({
      kind: 'quota',
      retryable: false,
    });
    expect(calls()).toBe(1);
  });

  it('every entry skipped for terms is the terms refusal with a denied row', async () => {
    const service = serviceWith(() => [skipped('ineligible'), skipped('unverified')]);
    const result = await service.invoke(ask);
    expect(result).toMatchObject({
      ok: false,
      content:
        "The AI provider's terms are not recorded or don't allow this use, so no content was sent outside the server.",
    });
    expect(assistantRepo.listSkillActivity(t.scopes.forGuild(GUILD), 10)[0]).toMatchObject({
      outcome: 'denied',
    });
  });

  it('every entry skipped for keys is the not-configured refusal', async () => {
    const service = serviceWith(() => [skipped('no-key'), skipped('disabled')]);
    const result = await service.invoke(ask);
    expect(result).toMatchObject({
      ok: false,
      content: 'The free AI provider is not configured, so no content was sent outside the server.',
    });
  });

  it('a guard failure answers the fixed text', async () => {
    const toolShaped = '{"name":"search_sources","args":{"query":"x"}}';
    const shaped = fakeProvider([
      { text: toolShaped, model: 'm' },
      { text: toolShaped, model: 'm' },
    ]);
    const service = serviceWith(() => [usable(shaped.provider)]);
    const result = await service.invoke(ask);
    expect(result).toMatchObject({
      ok: false,
      content: "I couldn't finish that answer — please try again.",
    });
    expect(shaped.calls()).toBe(2);
  });

  it('a daily cap throws daily-free with the reset so the job answers the reset reply', async () => {
    const resetAt = NOW + 3_600_000;
    const { provider } = fakeProvider([
      new ProviderError('quota', 'free-models-per-day limit reached', false, {
        quotaScope: 'daily-free',
        resetAt,
      }),
    ]);
    const service = serviceWith(() => [usable(provider, { model: 'm:free' })]);
    await expect(service.invoke(ask)).rejects.toMatchObject({
      kind: 'quota',
      quotaScope: 'daily-free',
      resetAt,
      retryable: false,
    });
  });

  it('a spent allowance is skipped without a provider call on the next request', async () => {
    const resetAt = NOW + 3_600_000;
    const capped = fakeProvider([
      new ProviderError('quota', 'free-models-per-day limit reached', false, {
        quotaScope: 'daily-free',
        resetAt,
      }),
    ]);
    const later = fakeProvider([{ text: 'must not run', model: 'm:free' }]);
    let secondRequest = false;
    const service = serviceWith(() => [
      usable((secondRequest ? later : capped).provider, { model: 'm:free' }),
    ]);
    await expect(service.invoke({ ...ask, invocationId: 'int-cap-1' })).rejects.toMatchObject({
      quotaScope: 'daily-free',
    });
    secondRequest = true;
    await expect(service.invoke({ ...ask, invocationId: 'int-cap-2' })).rejects.toMatchObject({
      quotaScope: 'daily-free',
    });
    expect(later.calls()).toBe(0);
  });

  it('appends the Brave attribution when web results reached the model', async () => {
    eligibilityRepo.recordEligibilityClaim(t.scopes.instance(), {
      provider: 'fake',
      trainsOnInput: 'no',
      evidenceUrl: 'https://example.com/terms',
      evidenceClause: 'For production.',
      productionUseAllowed: true,
      now: NOW,
    });
    const web = fakeProvider([
      { text: '', model: 'm', toolCalls: [{ name: 'web_search', args: { query: 'lipo' } }] },
      { text: 'Store them half charged.', model: 'm' },
    ]);
    const service = createAssistantService(
      t.scopes.forGuild(GUILD),
      t.scopes.instance(),
      config,
      () => NOW,
      {
        provider: web.provider,
        webSearch: async () => [
          { title: 'Guide', url: 'https://a.example/', description: 'LiPo care.' },
        ],
      },
    );
    const result = await service.invoke(ask);
    expect(result).toMatchObject({
      ok: true,
      content: 'Store them half charged.\n\n-# Powered by Brave Search',
    });
  });
});

describe('Task 16: cache catalogue, pre-retrieved evidence, no live fetch', () => {
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
    resourceIds: ['handbook'],
    enabled: true,
  };

  const usable = (provider: TextProvider): ChainEntry => ({
    providerId: 'gemini',
    model: 'model-a',
    keyId: 'key_a',
    keyLabel: 'Key A',
    provider,
    skip: undefined,
    mayTrain: false,
  });

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

  const seedCache = (url: string, resourceId: string, texts: readonly string[]) => {
    const scope = t.scopes.forGuild(GUILD);
    const docId = computeDocId(url);
    resourceCacheRepo.upsertDocument(scope, {
      resourceId,
      docId,
      url,
      path: '/guide',
      title: resourceId,
      contentHash: `hash-${resourceId}`,
      fetchedAt: NOW - 3_600_000,
      bytes: 100,
      status: 'ok',
    });
    resourceCacheRepo.replaceChunks(
      scope,
      docId,
      resourceId,
      texts.map((text, i) => ({
        ordinal: i,
        headingPath: `Guide › Part ${String(i)}`,
        lineStart: i + 1,
        lineEnd: i + 1,
        text,
      })),
    );
    return docId;
  };

  it('never calls the live fetcher and prompts with a catalogue, preferred first, within 60 lines', async () => {
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.putResource(scope, {
      id: 'handbook',
      guildId: GUILD,
      title: 'Handbook',
      url: 'https://example.com/handbook',
      kind: 'website',
      enabled: true,
      reviewedAt: new Date(NOW).toISOString(),
    });
    assistantRepo.putResource(scope, {
      id: 'rules',
      guildId: GUILD,
      title: 'Rules',
      url: 'https://example.com/rules',
      kind: 'website',
      enabled: true,
      reviewedAt: new Date(NOW).toISOString(),
    });
    seedCache('https://example.com/handbook', 'handbook', ['battery care guide for the club']);
    const fetchResource = vi.fn(async () => {
      throw new Error('live fetch must not happen');
    });
    let systemInstruction = '';
    let userText = '';
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async (req) => {
        systemInstruction = req.systemInstruction;
        userText = req.messages.map((m) => m.text ?? '').join('\n');
        return { text: 'ok', model: 'model-a' };
      },
    };
    const service = createAssistantService(
      scope,
      t.scopes.instance(),
      config,
      () => NOW,
      { fetchResource },
      undefined,
      undefined,
      undefined,
      () => [usable(provider)],
    );
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'battery care' },
      source: 'slash-command',
      invocationId: 'int-cache-1',
    });
    expect(result.ok).toBe(true);
    expect(fetchResource).not.toHaveBeenCalled();
    expect(systemInstruction).toContain('CLUB SOURCES');
    const handbookAt = systemInstruction.indexOf('handbook · Handbook');
    const rulesAt = systemInstruction.indexOf('rules · Rules');
    expect(handbookAt).toBeGreaterThanOrEqual(0);
    expect(rulesAt).toBeGreaterThan(handbookAt);
    const catalogueLines = systemInstruction
      .split('\n')
      .filter((l) => l.includes(' · ') && l.includes('updated'));
    expect(catalogueLines.length).toBeLessThanOrEqual(60);
    expect(userText).toContain('chunk=');
  });

  it('pre-retrieves at most four snippets and opens them in round 2 from initial handles', async () => {
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.putResource(scope, {
      id: 'handbook',
      guildId: GUILD,
      title: 'Handbook',
      url: 'https://example.com/handbook',
      kind: 'website',
      enabled: true,
      reviewedAt: new Date(NOW).toISOString(),
    });
    const docId = seedCache('https://example.com/handbook', 'handbook', [
      'battery care guide part zero',
      'battery care guide part one',
      'battery care guide part two',
      'battery care guide part three',
      'battery care guide part four',
      'battery care guide part five',
    ]);
    const chunk0 = `c_${docId}_0`;
    const requests: { systemInstruction: string; messagesText: string }[] = [];
    let round = 0;
    const provider: TextProvider = {
      id: 'fake',
      capabilities: new Set(['text', 'tools']),
      generateText: async (req) => {
        round += 1;
        requests.push({
          systemInstruction: req.systemInstruction,
          messagesText: req.messages.map((m) => m.text ?? '').join('\n'),
        });
        if (round === 1)
          return {
            text: '',
            model: 'model-a',
            toolCalls: [{ name: 'list_sources', args: {} }],
          };
        if (round === 2)
          return {
            text: '',
            model: 'model-a',
            toolCalls: [{ name: 'read_chunk', args: { chunkId: chunk0 } }],
          };
        return { text: 'done', model: 'model-a' };
      },
    };
    const service = createAssistantService(
      scope,
      t.scopes.instance(),
      config,
      () => NOW,
      {},
      undefined,
      undefined,
      undefined,
      () => [usable(provider)],
    );
    const result = await service.invoke({
      guildId: GUILD,
      channelId: CHANNEL,
      userId: MEMBER,
      callerRoleIds: [CLUB_ROLE],
      behaviour: direct,
      command: 'ask',
      input: { question: 'battery care' },
      source: 'slash-command',
      invocationId: 'int-cache-2',
    });
    expect(result.ok).toBe(true);
    const evidenceChunks = (requests[0]?.messagesText.match(/chunk=/g) ?? []).length;
    expect(evidenceChunks).toBeLessThanOrEqual(4);
    expect(evidenceChunks).toBeGreaterThan(0);
    expect(result.trace?.tools).toMatchObject([
      { name: 'list_sources', ok: true },
      { name: 'read_chunk', ok: true },
    ]);
  });
});
